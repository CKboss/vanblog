import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { PipelineProvider } from '../pipeline/pipeline.provider';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'src/config';
import {
  BackupListEntry,
  FullBackupResult,
  RestoreResult,
  createFullBackup,
  inspectFullBackup,
  listFullBackups,
  restoreFullBackup,
} from 'src/utils/fullBackup';
import { FullBackupManifest } from 'src/utils/backupCodec';

/** `restore()` 的返回：在 `RestoreResult` 之外多一个给前台用的布尔值（见 doRestore）。 */
export interface RestoreOutcome extends RestoreResult {
  /**
   * 恢复出来的库里**有流水线**时为 true：脚本文件已经按库重写了，但第三方依赖
   * （`<codeRunnerPath>/node_modules`）只在**启动时**安装（`PipelineProvider` 构造函数里的
   * `init()` → `checkAllDeps()`），不在请求路径上跑 `pnpm add`（那是十几秒到几分钟、还要外网）。
   * 所以全新机器上"只用内置能力的流水线"立刻可用，`require()` 第三方包的仍要等一次重启。
   * 判据是 `pipelines` 集合里至少 1 条（一次 `countDocuments({})`，不按 deleted 过滤 ——
   * 软删除的流水线同样有磁盘脚本）；读不到就按 false 处理，绝不让它影响恢复结果。
   *
   * ⚠️ 故意**不做**"恢复后顺带装依赖"：那会把一次恢复从秒级变成分钟级、并且依赖外网，
   * 而"重启一次"本来就是 notes 里已经建议的动作。要加也应该是显式开关（默认关）+ 异步执行。
   */
  needsRestartForPipelineDeps: boolean;
}

/**
 * 整站备份 / 恢复。
 *
 * 复用 mongoose 已经建好的连接（`connection.getClient()`），不再单独连一次 Mongo；
 * 备份范围 = 主库（默认 `vanBlog`）+ 评论库（`waline`）+ `<static>/{img,file,customPage}`。
 */
@Injectable()
export class FullBackupProvider {
  /**
   * 备份 / 恢复 / 删除必须**串行**：
   * - 恢复用的临时集合名是固定的 `<coll>__vanblog_restore`，两个并发恢复会互相 deleteMany，
   *   结果是集合被静默截断；
   * - 归档名只精确到秒，两个并发导出会写同一个文件名（后一个 truncate 前一个），
   *   却都返回"成功"；
   * - 恢复过程中导出会拿到一个正在被替换的库。
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  logger = new Logger(FullBackupProvider.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    /**
     * 恢复成功后要按库里的流水线重写 `<codeRunnerPath>/<id>.js`（见 doRestore）。
     * `@Optional()`：单测/量具里直接 `new FullBackupProvider(conn)` 时，
     * 不必把整条流水线依赖图（Pipeline 模型 + LogProvider）一起构造出来。
     */
    @Optional() private readonly pipelineProvider?: PipelineProvider,
  ) {}

  private get client(): any {
    return this.connection.getClient();
  }

  private get dbName(): string {
    return this.connection.name || 'vanBlog';
  }

  backupDir(): string {
    return config.backupPath;
  }

  /** 只认备份目录里的 `vanblog-full-*` 文件，挡住 `../` 之类的路径穿越。 */
  resolveArchive(name: string): string {
    const base = path.basename(String(name || ''));
    if (!base || !base.startsWith('vanblog-full-')) {
      throw new BadRequestException('备份文件名不合法！');
    }
    const full = path.resolve(this.backupDir(), base);
    const root = path.resolve(this.backupDir());
    if (!full.startsWith(root + path.sep)) {
      throw new BadRequestException('备份文件名不合法！');
    }
    if (!fs.existsSync(full)) {
      throw new BadRequestException('找不到这个备份文件！');
    }
    return full;
  }

  async export(format?: string): Promise<FullBackupResult> {
    return this.serialize(() => this.doExport(format));
  }

  private async doExport(format?: string): Promise<FullBackupResult> {
    const result = await createFullBackup({
      client: this.client,
      staticPath: config.staticPath,
      dbName: this.dbName,
      walineDbName: config.walineDB,
      format: format || 'auto',
      outDir: this.backupDir(),
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    this.logger.log(
      `整站备份完成：${result.name}（${result.sizeText}，${result.format}，耗时 ${(
        result.ms / 1000
      ).toFixed(1)}s）`,
    );
    return result;
  }

  list(): BackupListEntry[] {
    return listFullBackups(this.backupDir());
  }

  async inspect(name: string): Promise<FullBackupManifest | null> {
    const archivePath = this.resolveArchive(name);
    return inspectFullBackup(archivePath, this.backupDir());
  }

  async restore(archivePath: string, withStatic = true): Promise<RestoreOutcome> {
    return this.serialize(() => this.doRestore(archivePath, withStatic));
  }

  /** 恢复出来的库里有没有流水线（见 RestoreOutcome.needsRestartForPipelineDeps） */
  private async hasAnyPipeline(): Promise<boolean> {
    try {
      const n = await this.connection.useDb(this.dbName).collection('pipelines').countDocuments({});
      return Number(n) > 0;
    } catch (err) {
      this.logger.warn(
        `读取 pipelines 条数失败，needsRestartForPipelineDeps 按 false 处理：${
          (err as Error)?.message || err
        }`,
      );
      return false;
    }
  }

  /**
   * 恢复之后按库里的流水线重写脚本文件。
   *
   * 为什么必须做：流水线的**脚本正文在磁盘上**（`<codeRunnerPath>/<id>.js`），
   * 而 `runCodeByPipelineId` fork 的就是那个文件；它只在两处被写：
   * 启动时（`PipelineProvider` 构造函数里的 `init()` → `saveAllScripts()`）
   * 和后台编辑流水线时。恢复把 `pipelines` 集合整份换成了归档里的内容，磁盘却停留在恢复前：
   *  - **全新机器**（初始化页上传备份恢复）：启动时库是空的 ⇒ 一个脚本都没写过，
   *    恢复进来的流水线 fork 的是一个不存在的文件；而 `dispatchEvent` 是被 await 的，
   *    于是"保存文章"这类挂了 beforeUpdateArticle 事件的操作要一直等到 PIPELINE_TIMEOUT_MS；
   *  - **老机器**：归档里的流水线与磁盘上的对不上（同 id 不同内容 / 新增 / 已删除）。
   *
   * ⚠️ 只调 `saveAllScripts()`，**不调** `init()`/`checkAllDeps()`：后者会在请求路径上
   * 对每个依赖跑一次 `pnpm add`（十几秒到几分钟，还要外网）。所以**带第三方依赖的流水线
   * 仍然要等下一次重启**（那时构造函数的 init() 会装依赖）—— 这条限制写在恢复返回的 notes 里。
   *
   * ⚠️ 故意不加 `isPrimaryInstance()` 守卫：这不是"启动期的活"，而是"谁做了恢复谁负责收尾"。
   * 加了守卫的话，非主实例接到恢复请求时会把这件事跳过，而主实例根本不知道发生过恢复。
   * 多进程下两个 worker 同时恢复本来就由 `serialize()` 之外的因素限制（见文件头），
   * 而写同样内容的同名文件不会互相损坏。
   */
  private async refreshPipelineScripts(): Promise<void> {
    if (!this.pipelineProvider) {
      return;
    }
    try {
      await this.pipelineProvider.saveAllScripts();
      this.logger.log(
        '已按恢复后的流水线数据重写 codeRunner 脚本' +
          '（若某条流水线依赖第三方包，还需要重启一次 server：依赖安装只在启动期做，不在请求路径上跑 pnpm add）',
      );
    } catch (err) {
      // 脚本没写成功不影响恢复本身的结果，但必须能被人看见（否则表现为"流水线不触发"）
      this.logger.warn(
        `恢复后重写流水线脚本失败（流水线可能跑不起来，重启 server 可自愈）：${
          (err as Error)?.message || err
        }`,
      );
    }
  }

  private async doRestore(archivePath: string, withStatic = true): Promise<RestoreOutcome> {
    const result = await restoreFullBackup({
      client: this.client,
      staticPath: config.staticPath,
      archivePath,
      withStatic,
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    this.logger.log(
      `整站恢复完成：${Object.entries(result.databases)
        .map(([db, item]) => `${db} ${item.collections} 表/${item.documents} 条`)
        .join('，')}，耗时 ${(result.ms / 1000).toFixed(1)}s`,
    );
    await this.refreshPipelineScripts();
    return { ...result, needsRestartForPipelineDeps: await this.hasAnyPipeline() };
  }
}
