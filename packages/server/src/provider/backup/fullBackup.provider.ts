import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { PipelineProvider } from '../pipeline/pipeline.provider';
import * as fs from 'fs';
import * as path from 'path';
import cluster from 'node:cluster';
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
import { BackupVerifyResult, verifyFullBackup } from 'src/utils/backupVerify';
import {
  BackupStatusFile,
  readBackupStatus,
  recordBackupFailure,
  recordBackupSuccess,
  resolveStaleWarnHours,
  staleBackupWarning,
} from 'src/utils/backupStatus';
import { isPrimaryInstance } from 'src/utils/clusterRole';

/** `export()` 的返回：在 `FullBackupResult` 之外带写后校验的结果（P2）。 */
export interface ExportOutcome extends FullBackupResult {
  /** 写后校验（只有校验通过才会返回；不通过时 export() 直接抛 400） */
  verification: BackupVerifyResult;
}

/** `status()` 的返回：状态文件 + 陈旧判定。 */
export interface BackupStatusView extends BackupStatusFile {
  staleWarnHours: number;
  stale: boolean;
  staleMessage: string | null;
}

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
export class FullBackupProvider implements OnApplicationBootstrap {
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

  async export(format?: string): Promise<ExportOutcome> {
    return this.serialize(() => this.doExport(format));
  }

  /**
   * 导出 + **写后校验**（P2）。
   *
   * 手动导出与 cron 备份（vanblog.sh backup → POST full/export）走的都是这里，
   * 所以两条路都被校验覆盖。校验不通过 = 这次备份失败：
   *  - 状态文件记 failure（stage='verify'，consecutiveFailures+1）；
   *  - ERROR 日志带全部原因；
   *  - 抛 BadRequestException（用户/脚本能看到原因；归档保留在磁盘上供排障，
   *    后台列表里它没有 sidecar 一致性问题，inspect 仍可用）。
   */
  private async doExport(format?: string): Promise<ExportOutcome> {
    let result: FullBackupResult;
    try {
      result = await createFullBackup({
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
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      this.recordFailureSafely('export', message, null);
      this.logger.error(`整站备份失败：${message}`);
      this.warnIfStale();
      throw err;
    }
    // 写后校验：解压器全量读通 + 归档内 manifest 过闸门 + 计数一致且非零
    // （检查项与理由见 utils/backupVerify.ts 文件头）
    let verification: BackupVerifyResult;
    try {
      verification = await verifyFullBackup(result.path);
    } catch (err) {
      verification = null as any;
      const message = `校验器异常：${(err as Error)?.message || err}`;
      this.recordFailureSafely('verify', message, result.name);
      this.logger.error(`整站备份校验异常（${result.name}）：${message}`);
      this.warnIfStale();
      throw new BadRequestException(`整站备份校验失败：${message}（归档已保留：${result.name}）`);
    }
    if (!verification.ok) {
      const message = verification.issues.map((i) => `[${i.check}] ${i.message}`).join('；');
      this.recordFailureSafely('verify', message, result.name);
      // ERROR 必须带原因：cron 失败要能不翻归档就定位
      this.logger.error(
        `整站备份校验失败（${result.name}，${result.sizeText}）：${message}` +
          `——归档已保留在 ${result.path} 供排障，但这次备份按失败计`,
      );
      this.warnIfStale();
      throw new BadRequestException(
        `整站备份校验失败：${message}（归档已保留：${result.name}）`,
      );
    }
    recordBackupSuccess(this.backupDir(), {
      name: result.name,
      bytes: result.bytes,
      verifyMs: verification.ms,
    });
    this.logger.log(
      `整站备份完成并通过校验：${result.name}（${result.sizeText}，${result.format}，` +
        `打包+导出 ${(result.ms / 1000).toFixed(1)}s，校验 ${(verification.ms / 1000).toFixed(1)}s，` +
        `${verification.members} 个归档成员）`,
    );
    return { ...result, verification };
  }

  /** 状态文件写失败绝不能把备份流程带崩（backupStatus 内部已经吞了一层，这里再兜一层）。 */
  private recordFailureSafely(
    stage: 'export' | 'verify',
    message: string,
    name: string | null,
  ): void {
    try {
      recordBackupFailure(this.backupDir(), { stage, message, name });
    } catch (err) {
      this.logger.warn(`写备份状态文件失败：${(err as Error)?.message || err}`);
    }
  }

  /** 上次成功备份太旧（或从未成功）时 WARN。启动时与每次备份失败后各查一次。 */
  private warnIfStale(): void {
    try {
      const message = staleBackupWarning(readBackupStatus(this.backupDir()));
      if (message) {
        this.logger.warn(`备份陈旧告警：${message}`);
      }
    } catch (err) {
      this.logger.warn(`备份陈旧检查失败：${(err as Error)?.message || err}`);
    }
  }

  /**
   * 启动时检查一次备份新鲜度（只由主实例做，免得 N 个 worker 各 WARN 一遍）。
   * 阈值 `VANBLOG_BACKUP_STALE_WARN_HOURS`（默认 **48**，0 = 关闭 = 旧行为）。
   * ⚠️ 这是一个**默认开启的新 WARN**（只写日志，不改任何行为）：没有按时备份的实例
   * 每次启动都会看到一行「备份陈旧告警」，这正是本功能的目的（备份坏了要吵出来）。
   */
  onApplicationBootstrap(): void {
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    // 不阻塞启动：状态文件在慢盘上也要能读失败不惊动 listen
    setTimeout(() => this.warnIfStale(), 5000);
  }

  /** 后台专用：备份健康状态（成功/失败时间、连续失败数、陈旧判定）。 */
  status(): BackupStatusView {
    const file = readBackupStatus(this.backupDir());
    const staleWarnHours = resolveStaleWarnHours();
    const staleMessage = staleBackupWarning(file, new Date(), staleWarnHours);
    return {
      ...file,
      staleWarnHours,
      stale: Boolean(staleMessage),
      staleMessage,
    };
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
