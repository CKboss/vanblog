import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { PipelineProvider } from '../pipeline/pipeline.provider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import cluster from 'node:cluster';
import { config } from 'src/config';
import {
  BackupListEntry,
  FullBackupResult,
  RestoreResult,
  backupIncludeCaddyEnabled,
  cleanupStaleExportTemps,
  cleanupStaleWorkDirs,
  createFullBackup,
  resolveStaleWorkHours,
  inspectFullBackup,
  listFullBackups,
  restoreFullBackup,
} from 'src/utils/fullBackup';
import { BackupSourceInfo, FullBackupManifest } from 'src/utils/backupCodec';
import { BackupVerifyResult, verifyFullBackup } from 'src/utils/backupVerify';
import {
  BackupStatusFile,
  SweepArchiveResult,
  readBackupStatus,
  recordBackupFailure,
  recordBackupSuccess,
  recordSweep,
  resolveStaleWarnHours,
  resolveSweepIntervalHours,
  resolveSweepMax,
  staleBackupWarning,
  touchBackupStatus,
} from 'src/utils/backupStatus';
import {
  RESTORE_JOURNAL_FILE,
  describeRestoreJournal,
  readRestoreJournal,
} from 'src/utils/restoreJournal';
import { envBool } from 'src/utils/envBool';
import { version as codeVersion } from 'src/utils/loadConfig';
import { isPrimaryInstance } from 'src/utils/clusterRole';

/** 导出后是否做**成员级**哈希校验（P1）。默认开：这就是 owner 要的"备份文件本身防损坏"。 */
export const BACKUP_VERIFY_DEEP_ENV = 'VANBLOG_BACKUP_VERIFY_DEEP';
/** 定期巡检是否也做成员级校验（P4）。默认关：巡检要的是"便宜到能天天跑"。 */
export const BACKUP_SWEEP_DEEP_ENV = 'VANBLOG_BACKUP_SWEEP_DEEP';

/**
 * 整轮备份（导出 + 打包）的超时分钟数；**0 = 不限时**。
 *
 * 为什么需要它：备份链路上任何一处"等一个永远不会来的回调"都会让整个请求永久挂住
 * （NDJSON 写流曾经没有 error 监听，磁盘满时就是这个形状），而 `backup-status.json`
 * 会停在"进行中"、cron 看起来"还在跑"、优雅退出被拖到超时 —— 没有一处说"失败了"。
 * 超时是这类挂死的最后一道网：**宁可大声失败，不可静默挂着**。
 *
 * 默认 60 分钟：实测一次整站导出 28s（69MB 归档），几 GB 的站点也在分钟级；
 * 60 分钟还没完基本就是卡住了。库特别大或盘特别慢的部署可以调大，或设 0 关掉。
 */
export const BACKUP_TIMEOUT_MINUTES_ENV = 'VANBLOG_BACKUP_TIMEOUT_MINUTES';
export const DEFAULT_BACKUP_TIMEOUT_MINUTES = 60;

/** 与其它 `resolve*` 同一套语义：缺失/空串/非数字/负数 ⇒ 回落默认；0 = 不限时。 */
export function resolveBackupTimeoutMinutes(
  raw: string | undefined = process.env[BACKUP_TIMEOUT_MINUTES_ENV],
  fallback: number = DEFAULT_BACKUP_TIMEOUT_MINUTES,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  // 上限一年：写错成"分钟当秒"也不至于变成永不开口的定时器
  return Math.min(Math.floor(n), 60 * 24 * 365);
}

/** `export()` 的返回：在 `FullBackupResult` 之外带写后校验的结果（P2）。 */
export interface ExportOutcome extends FullBackupResult {
  /** 写后校验（只有校验通过才会返回；不通过时 export() 直接抛 400） */
  verification: BackupVerifyResult;
}

/** `status()` 的返回：状态文件 + 陈旧判定 + 巡检配置 + 恢复断点。 */
export interface BackupStatusView extends BackupStatusFile {
  staleWarnHours: number;
  stale: boolean;
  staleMessage: string | null;
  /** 生效的巡检节奏（0 = 关闭） */
  sweepIntervalHours: number;
  sweepMaxArchives: number;
  /** 上一次恢复没跑完时的人话说明；正常为 null */
  restoreJournalMessage: string | null;
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
    const timeoutMinutes = resolveBackupTimeoutMinutes();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();
    try {
      const backupPromise = createFullBackup({
        client: this.client,
        staticPath: config.staticPath,
        dbName: this.dbName,
        walineDbName: config.walineDB,
        format: format || 'auto',
        outDir: this.backupDir(),
        // P1/P3：把"这份归档是谁导出的"写进清单，恢复时才能发现 waline 库名之类的静默错配
        source: this.buildSourceInfo(),
        // P6（默认关）：只有显式打开 VANBLOG_BACKUP_INCLUDE_CADDY 才把 TLS 材料打进归档
        caddyDataPath: backupIncludeCaddyEnabled() ? config.caddyDataPath : undefined,
        // 超时时真的把活停下来（游标逐条检查 + tar 管道 fail() 会删半成品并 SIGKILL 子进程），
        // 而不是只让调用方解脱、底下继续写盘
        abortSignal: controller.signal,
        logger: {
          log: (message) => this.logger.log(message),
          warn: (message) => this.logger.warn(message),
        },
      });
      // ⚠️ 必须先挂一个 catch：超时后我们会 abort，底下那个 promise 随后才 reject，
      //    而那时已经没人在 await 它了 ⇒ 不挂就是 unhandledRejection（Node 20+ 默认退出进程）。
      backupPromise.catch(() => undefined);
      if (timeoutMinutes > 0) {
        result = await Promise.race([
          backupPromise,
          new Promise<FullBackupResult>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new BadRequestException(
                  `整站备份超时：超过 ${timeoutMinutes} 分钟仍未完成，已中止（用时 ` +
                    `${Math.round((Date.now() - startedAt) / 1000)}s）。` +
                    `半成品归档已删除，本次按失败计。` +
                    `常见原因是磁盘写满或数据卷不可用 —— 先看剩余空间与磁盘健康；` +
                    `库确实很大/盘确实很慢就调大 ${BACKUP_TIMEOUT_MINUTES_ENV}（0 = 不限时）`,
                ),
              );
            }, timeoutMinutes * 60 * 1000);
            // 定时器绝不能把进程吊着不让退出
            timer.unref?.();
          }),
        ]);
      } else {
        result = await backupPromise;
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      // 超时单独记一个 stage：它说的是"卡住了"，与"这一步报错了"排障方向完全不同
      const timedOut = controller.signal.aborted;
      this.recordFailureSafely(timedOut ? 'timeout' : 'export', message, null);
      this.logger.error(`整站备份${timedOut ? '超时中止' : '失败'}：${message}`);
      this.warnIfStale();
      throw err;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    // 写后校验：解压器全量读通 + 归档内 manifest 过闸门 + 计数一致且非零
    // + P1 的防损坏那一组（merkleRoot / memberCount / 清单副本 / 整归档 sha256 / 压缩器校验位）
    // + 成员级哈希（deep，默认开：实测 69MB 归档只多 0.4s，见报告）
    // （检查项与理由见 utils/backupVerify.ts 文件头）
    const deep = envBool(BACKUP_VERIFY_DEEP_ENV, true);
    let verification: BackupVerifyResult;
    try {
      verification = await verifyFullBackup(result.path, { deep });
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
      sha256: result.archiveSha256,
      members: result.memberCount,
    });
    this.logger.log(
      `整站备份完成并通过校验：${result.name}（${result.sizeText}，${result.format}，` +
        `打包+导出 ${(result.ms / 1000).toFixed(1)}s（其中成员哈希 ${(result.hashMs / 1000).toFixed(2)}s），` +
        `校验 ${(verification.ms / 1000).toFixed(1)}s${deep ? '（含成员级哈希）' : ''}，` +
        `${verification.members} 个归档成员，sha256 ${String(result.archiveSha256).slice(0, 12)}…）`,
    );
    return { ...result, verification };
  }

  /**
   * 清单里的 `source` 块（P1/P3）。
   * `walineDB` 是最值钱的一项：它来自机器本地的 `config.yaml`，**不在**数据库里，
   * 所以恢复时如果两边不一致，waline 的表会被写进一个本实例不读的库 —— 零报错的数据"消失"。
   */
  private buildSourceInfo(): BackupSourceInfo {
    return {
      codeVersion: String(codeVersion || 'dev'),
      walineDB: String(config.walineDB || ''),
      demo: config.demo === true || String(config.demo) === 'true',
      hostname: safeHostname(),
      staticPath: path.resolve(config.staticPath || ''),
      codeRunnerPath: path.resolve(config.codeRunnerPath || ''),
    };
  }

  /** 状态文件写失败绝不能把备份流程带崩（backupStatus 内部已经吞了一层，这里再兜一层）。 */
  private recordFailureSafely(
    stage: 'export' | 'verify' | 'sweep' | 'timeout',
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
   * 启动时（只由主实例做，免得 N 个 worker 各干一遍）：
   *  1. 检查备份新鲜度（`VANBLOG_BACKUP_STALE_WARN_HOURS`，默认 48，0=关）；
   *  2. **P5**：看有没有上次没跑完的恢复（`restore-journal.json`），有就点名归档与进度打 WARN，
   *     并把状态文件重写一遍，让后台/`vanblog.sh backup-status` 不翻日志也能看见；
   *  3. **P2**：清掉上次崩溃留下的导出临时文件（`.vanblog-export-*`，且必须够旧）；
   *  4. **P4**：排上定期复验（`VANBLOG_BACKUP_SWEEP_HOURS`，默认 24，0=关）。
   * ⚠️ 1/2/3 都只写日志与状态文件，不改任何数据；全部 setTimeout 出去，不阻塞 listen。
   */
  onApplicationBootstrap(): void {
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    // 不阻塞启动：状态文件在慢盘上也要能读失败不惊动 listen
    setTimeout(() => {
      this.warnIfStale();
      this.warnIfInterruptedRestore();
      this.cleanupExportTemps();
      this.cleanupStaleWorkDirs();
    }, 5000).unref?.();
    this.scheduleSweep();
  }

  /** P5：上一次恢复没正常结束就吵出来（点名归档 + 换了几张表），并把快照落进状态文件。 */
  private warnIfInterruptedRestore(): void {
    try {
      const journal = readRestoreJournal(this.backupDir());
      if (!journal) {
        return;
      }
      this.logger.warn(`恢复断点告警：${describeRestoreJournal(journal)}`);
      // readBackupStatus 会现取 journal，但**文件里**那份快照要重写一次才更新
      touchBackupStatus(this.backupDir());
    } catch (err) {
      this.logger.warn(`恢复断点检查失败：${(err as Error)?.message || err}`);
    }
  }

  /** P2：清掉上次崩溃留下的导出临时文件（只碰 `.vanblog-export-*`，且只删够旧的）。 */
  private cleanupExportTemps(): void {
    try {
      const removed = cleanupStaleExportTemps(this.backupDir());
      if (removed.length) {
        this.logger.warn(
          `清理了 ${removed.length} 个上次崩溃留下的导出临时文件：${removed.slice(0, 5).join(', ')}` +
            `（目录 ${this.backupDir()}）`,
        );
      }
    } catch (err) {
      this.logger.warn(`清理导出临时文件失败：${(err as Error)?.message || err}`);
    }
  }

  /**
   * 清掉**上次崩溃留下的工作目录**：`<static>/tmp/full-backup-*`、`<static>/tmp/full-restore-*`
   * 与 `<backupPath>/upload-tmp/restore-upload-*`。
   *
   * 为什么要有：正常路径在 `finally` 里就删了，但进程被杀（OOM / 容器重启 / 恢复途中崩溃）时
   * `finally` 不执行 ⇒ 解包后的**整站明文**（口令哈希、jwt 密钥、全部正文与图床）留在静态目录树里，
   * 而且每崩一次吃掉一份"整站大小"的磁盘。导出侧一直有清道夫，恢复侧没有 —— 那是遗漏。
   *
   * ⚠️ 只删**够旧**的（`VANBLOG_BACKUP_STALE_WORK_HOURS`，默认 6，0=关）：共享卷上可能正有
   * 另一个实例在跑，删掉别人正在写的目录会让那一次的归档或恢复莫名其妙坏掉。
   */
  private cleanupStaleWorkDirs(): void {
    try {
      const hours = resolveStaleWorkHours();
      const result = cleanupStaleWorkDirs({
        staticPath: config.staticPath,
        backupDir: this.backupDir(),
        maxAgeMs: hours * 60 * 60 * 1000,
      });
      if (result.disabled) {
        return;
      }
      if (result.removed.length) {
        const freed = result.bytes / 1024 / 1024;
        this.logger.warn(
          `清理了 ${result.removed.length} 个上次崩溃留下的备份/恢复工作目录` +
            `（释放 ${freed.toFixed(1)} MB）：${result.removed
              .slice(0, 5)
              .map((item) => item.name)
              .join(', ')}` +
            `${result.removed.length > 5 ? ' …' : ''}` +
            `—— 里面是解包后的整站明文，所以必须清；只删超过 ${hours} 小时的，` +
            `正在跑的那一次不受影响`,
        );
      }
    } catch (err) {
      this.logger.warn(`清理崩溃遗留工作目录失败：${(err as Error)?.message || err}`);
    }
  }

  /**
   * P4：定期复验（bit-rot 必须在"需要备份的那天"之前被发现）。
   *
   * 节奏 `VANBLOG_BACKUP_SWEEP_HOURS`（默认 **24**，0=关）；每次最多查
   * `VANBLOG_BACKUP_SWEEP_MAX` 份（默认 **3**，最新的优先）⇒ 成本可预测：
   * 实测 69MB 真归档 cheap 路径 ≈ 0.9s，3 份 ≈ 3s，一天一次完全无感。
   * `VANBLOG_BACKUP_SWEEP_DEEP=on` 才做成员级哈希（≈ 1.4s/份）。
   *
   * ⚠️ **只检测、不修复、不删任何东西**：判定"哪份归档该扔"是人的决定，
   * 程序自动删掉一份"看起来坏了"的归档，等于把最后的恢复点也弄没了。
   * ⚠️ 定时器一律 `unref()`：巡检绝不能把进程吊着不让退出。
   */
  private scheduleSweep(): void {
    const hours = resolveSweepIntervalHours();
    const max = resolveSweepMax();
    if (hours <= 0 || max <= 0) {
      return;
    }
    const intervalMs = hours * 3600 * 1000;
    // 从没巡检过（或上次已经超期）就在启动 30s 后先跑一次：
    // 容器可能几天才重启一次，"等满一个间隔"等于永远不跑
    let dueIn = intervalMs;
    try {
      const last = readBackupStatus(this.backupDir()).lastSweepAt;
      const lastMs = last ? new Date(last).getTime() : 0;
      dueIn = Number.isFinite(lastMs) && lastMs > 0 ? lastMs + intervalMs - Date.now() : 30_000;
    } catch {
      dueIn = 30_000;
    }
    dueIn = Math.min(Math.max(dueIn, 30_000), intervalMs);
    const first = setTimeout(() => {
      void this.runSweep('startup');
    }, dueIn);
    first.unref?.();
    const timer = setInterval(() => {
      void this.runSweep('interval');
    }, intervalMs);
    timer.unref?.();
    this.logger.log(
      `备份定期复验已排上：每 ${hours}h 一次，每次最多 ${max} 份（最新优先），首次约 ${Math.round(
        dueIn / 1000,
      )}s 后（VANBLOG_BACKUP_SWEEP_HOURS=0 可关闭）`,
    );
  }

  /**
   * 跑一次巡检。**串在 serialize() 队列里**：与导出/恢复互斥，
   * 免得恢复正把归档解包到一半时巡检去读同一个目录。
   */
  async runSweep(reason: string): Promise<SweepArchiveResult[]> {
    return this.serialize(() => this.doSweep(reason));
  }

  private async doSweep(reason: string): Promise<SweepArchiveResult[]> {
    const hours = resolveSweepIntervalHours();
    const max = resolveSweepMax();
    if (hours <= 0 || max <= 0) {
      return [];
    }
    const deep = envBool(BACKUP_SWEEP_DEEP_ENV, false);
    const started = Date.now();
    let list: BackupListEntry[] = [];
    try {
      list = listFullBackups(this.backupDir()).slice(0, max); // list() 已按 createdAt 倒序
    } catch (err) {
      this.logger.warn(`巡检读不出备份列表：${(err as Error)?.message || err}`);
      return [];
    }
    const results: SweepArchiveResult[] = [];
    for (const item of list) {
      const one = await this.verifyOne(item, deep);
      results.push(one);
      if (!one.ok) {
        // WARN 必须点名归档：不点名的话"有一份坏了"这句话没法行动
        this.logger.warn(
          `备份定期复验发现问题（${reason}）：${item.name}（${item.sizeText}）—— ${one.issues.join('；')}` +
            `。不会自动删除或修复任何归档；请核对后决定是重做一次备份还是换恢复点`,
        );
      }
    }
    const ms = Date.now() - started;
    const failures = results.filter((item) => !item.ok).length;
    const message = results.length
      ? `${results.length} 份归档复验完成，${failures} 份有问题`
      : '备份目录里没有可复验的归档';
    recordSweep(this.backupDir(), { ms, results, message });
    if (failures) {
      this.recordFailureSafely(
        'sweep',
        results
          .filter((item) => !item.ok)
          .map((item) => `${item.name}: ${item.issues.join('；')}`)
          .join(' | '),
        results.find((item) => !item.ok)?.name || null,
      );
    }
    this.logger.log(
      `备份定期复验完成（${reason}）：${results.length} 份，${failures} 份有问题，耗时 ${(ms / 1000).toFixed(1)}s` +
        `${deep ? '（含成员级哈希）' : ''}`,
    );
    return results;
  }

  private async verifyOne(item: BackupListEntry, deep: boolean): Promise<SweepArchiveResult> {
    try {
      const result = await verifyFullBackup(item.path, { deep });
      return {
        name: item.name,
        ok: result.ok,
        ms: result.ms,
        bytes: item.bytes,
        membersChecked: result.integrity?.membersChecked ?? null,
        issues: result.issues.slice(0, 3).map((issue) => `[${issue.check}] ${issue.message}`.slice(0, 300)),
      };
    } catch (err) {
      return {
        name: item.name,
        ok: false,
        ms: 0,
        bytes: item.bytes,
        membersChecked: null,
        issues: [`校验器异常：${(err as Error)?.message || err}`.slice(0, 300)],
      };
    }
  }

  /**
   * 后台按需复验一份归档（`POST /api/admin/backup/full/verify`）。
   * 与巡检同一个校验器，只是这里默认做**成员级**深度校验（用户主动点的一次，值得查到底）。
   */
  async verifyArchive(name: string, deep = true): Promise<BackupVerifyResult> {
    const archivePath = this.resolveArchive(name);
    return verifyFullBackup(archivePath, { deep });
  }

  /** 后台专用：备份健康状态（成功/失败时间、连续失败数、陈旧判定、巡检与恢复断点）。 */
  status(): BackupStatusView {
    const file = readBackupStatus(this.backupDir());
    const staleWarnHours = resolveStaleWarnHours();
    const staleMessage = staleBackupWarning(file, new Date(), staleWarnHours);
    const journal = file.restoreJournal;
    return {
      ...file,
      staleWarnHours,
      stale: Boolean(staleMessage),
      staleMessage,
      sweepIntervalHours: resolveSweepIntervalHours(),
      sweepMaxArchives: resolveSweepMax(),
      // 恢复断点：给后台/脚本一句现成的人话，不必自己拼 journal 字段
      restoreJournalMessage: journal ? describeRestoreJournal(journal) : null,
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
      // P3：把"本实例是谁"交给恢复流程，它才能发现 waline 库名 / demo 的静默错配
      target: {
        walineDB: String(config.walineDB || ''),
        demo: config.demo === true || String(config.demo) === 'true',
        codeVersion: String(codeVersion || 'dev'),
      },
      // P5：恢复断点日志（崩溃后启动时会点名归档与进度打 WARN）
      journalPath: path.join(this.backupDir(), RESTORE_JOURNAL_FILE),
      // P6：只有归档里真的带 ./caddy 段时才会用到；开关关闭时导出端根本不会写那一段
      caddyDataPath: backupIncludeCaddyEnabled() ? config.caddyDataPath : undefined,
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
    // P3：修剪与"归档里没有的表"都必须**在日志里也留一行** —— notes 是给发起恢复那个人的，
    // 而 cron/脚本发起的恢复没人看响应体。
    // ⚠️ 全部按"可能没有"处理：单测里 restoreFullBackup 常被桩成只返回老字段的对象
    const pruned = result.pruned || [];
    const absent = result.absentCollections || [];
    const notes = result.notes || [];
    const prunedFiles = pruned.reduce((sum, item) => sum + (item.removedFiles || 0), 0);
    if (prunedFiles) {
      this.logger.log(
        `静态目录已按归档修剪：删掉 ${prunedFiles} 个归档里没有的文件（${pruned
          .map((item) => `${item.folder}/ ${item.removedFiles} 个`)
          .join('，')}）`,
      );
    }
    if (absent.length) {
      this.logger.warn(
        `恢复后仍有 ${absent.length} 张归档里没有的表：${absent
          .map((item) => `${item.db}.${item.collection}(${item.documents < 0 ? '?' : item.documents}${item.dropped ? ',已删' : ''})`)
          .join(', ')}`,
      );
    }
    for (const note of notes) {
      if (String(note).startsWith('WARN')) {
        this.logger.warn(String(note));
      }
    }
    await this.refreshPipelineScripts();
    return { ...result, needsRestartForPipelineDeps: await this.hasAnyPipeline() };
  }
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}
