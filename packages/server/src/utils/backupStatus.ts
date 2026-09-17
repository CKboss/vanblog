import * as fs from 'fs';
import * as path from 'path';
import { RestoreJournal, readRestoreJournal } from './restoreJournal';

/**
 * 备份健康状态的**持久化**（P2）。
 *
 * 存成 `<backupPath>/backup-status.json` 而**不是**存进数据库，理由：
 *  - 恢复会把整库换成归档里的内容 —— 状态若入库，一次恢复之后"最近备份成功时间"
 *    会跟着回退到归档时刻，恰好抹掉最需要看的现场；
 *  - 它描述的是"这台机器还能不能产出可用备份"，属于实例运行态，跟归档放一起最诚实；
 *  - 读写都是一个几百字节的小文件（tmp + rename 原子替换），备份本来就是分钟级操作，
 *    这点 IO 可以忽略。
 *
 * ⚠️ 只给**后台**看（GET /api/admin/backup/full/status，AdminGuard 后面）：
 * 它暴露运维状态（备份节奏、失败原因），绝不能出现在任何公开接口上。
 */

export const BACKUP_STATUS_FILE = 'backup-status.json';
export const BACKUP_STATUS_VERSION = 1;

/** 上一次成功备份超过这个小时数就在启动/失败时 WARN；0 = 关闭。 */
export const BACKUP_STALE_WARN_HOURS_ENV = 'VANBLOG_BACKUP_STALE_WARN_HOURS';
export const DEFAULT_BACKUP_STALE_WARN_HOURS = 48;

/** P4：定期复验的间隔（小时）；0 = 关闭。 */
export const BACKUP_SWEEP_INTERVAL_ENV = 'VANBLOG_BACKUP_SWEEP_HOURS';
export const DEFAULT_BACKUP_SWEEP_HOURS = 24;
/** P4：一次复验最多查几份归档（最新的优先），让成本可预测。 */
export const BACKUP_SWEEP_MAX_ENV = 'VANBLOG_BACKUP_SWEEP_MAX';
export const DEFAULT_BACKUP_SWEEP_MAX = 3;

/** 一次定期复验里，单份归档的结果（进 backup-status.json，所以字段要短） */
export interface SweepArchiveResult {
  name: string;
  ok: boolean;
  ms: number;
  bytes: number;
  /** 深度（成员级）校验时查了多少成员；cheap 路径为 null */
  membersChecked: number | null;
  /** 失败原因（最多 3 条，每条截断）；成功为空数组 */
  issues: string[];
}

export interface BackupStatusFile {
  version: number;
  updatedAt: string;
  /** 最近一次「导出+校验都成功」的时间（ISO）；从未成功过为 null */
  lastSuccessAt: string | null;
  lastSuccessName: string | null;
  lastSuccessBytes: number | null;
  /** 最近一次成功备份的写后校验耗时（ms） */
  lastVerifyMs: number | null;
  /**
   * 最近一次成功备份的**整归档 sha256**（P1）。
   * 为什么值得再存一份：归档旁边有 `.sha256` 与 `.manifest.json` 两个 sidecar，
   * 但它们和归档在同一个目录、同一次 `rm -rf` / 同一次磁盘故障里会一起没；
   * 状态文件是"外部凭据"的最后一个落脚点，也让 `backup-status.json` 单独就能回答
   * "我手上这份拷走的归档还是不是当初那一份"。
   */
  lastSuccessSha256: string | null;
  /** 最近一次成功备份的成员数（含目录项） */
  lastSuccessMembers: number | null;
  /** 最近一次失败（导出或校验）的时间；成功后不清零，保留现场 */
  lastFailureAt: string | null;
  lastFailureStage: 'export' | 'verify' | 'sweep' | null;
  lastFailureName: string | null;
  lastFailureMessage: string | null;
  /** 连续失败次数：任何一次成功归零。cron 备份坏了多久，看这个数字 */
  consecutiveFailures: number;
  /** P4：最近一次定期复验（bit-rot 巡检） */
  lastSweepAt: string | null;
  lastSweepMs: number | null;
  lastSweepArchives: number | null;
  lastSweepFailures: number | null;
  lastSweepResults: SweepArchiveResult[];
  lastSweepMessage: string | null;
  /** 生效的巡检配置（写进状态文件，运维不必去翻 env 就知道当前是什么节奏） */
  sweepIntervalHours: number;
  sweepMaxArchives: number;
  /**
   * P5：恢复断点日志的快照。**读状态时总是从 `restore-journal.json` 现取**，
   * 写状态时顺手落进文件 ⇒ 后台与 `vanblog.sh backup-status` 不必再读第二个文件。
   * 非 null 就意味着"上一次恢复没有正常结束，库可能是混合状态"。
   */
  restoreJournal: RestoreJournal | null;
}

export function emptyBackupStatus(): BackupStatusFile {
  return {
    version: BACKUP_STATUS_VERSION,
    updatedAt: new Date(0).toISOString(),
    lastSuccessAt: null,
    lastSuccessName: null,
    lastSuccessBytes: null,
    lastVerifyMs: null,
    lastSuccessSha256: null,
    lastSuccessMembers: null,
    lastFailureAt: null,
    lastFailureStage: null,
    lastFailureName: null,
    lastFailureMessage: null,
    consecutiveFailures: 0,
    lastSweepAt: null,
    lastSweepMs: null,
    lastSweepArchives: null,
    lastSweepFailures: null,
    lastSweepResults: [],
    lastSweepMessage: null,
    sweepIntervalHours: resolveSweepIntervalHours(),
    sweepMaxArchives: resolveSweepMax(),
    restoreJournal: null,
  };
}

/**
 * 读状态；文件缺失/损坏/版本不认识都回落到空状态（绝不让状态文件把备份流程带崩）。
 *
 * ⚠️ `restoreJournal` 一律**从 `restore-journal.json` 现取**，不用文件里那份快照：
 * 崩溃之后快照可能停在"正在恢复"，而 journal 文件才是现场本身（反过来，
 * 恢复成功删掉 journal 之后，快照也必须立刻变成 null）。
 */
export function readBackupStatus(backupDir: string): BackupStatusFile {
  const base = emptyBackupStatus();
  const journal = readRestoreJournal(backupDir);
  try {
    const file = path.join(backupDir, BACKUP_STATUS_FILE);
    if (!fs.existsSync(file)) {
      return { ...base, restoreJournal: journal };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== BACKUP_STATUS_VERSION) {
      return { ...base, restoreJournal: journal };
    }
    return { ...base, ...parsed, restoreJournal: journal };
  } catch {
    return { ...base, restoreJournal: journal };
  }
}

/**
 * 只把当前状态（含现取的 restoreJournal 快照）重新落一次盘。
 * 启动时发现恢复断点要用它：否则"journal 存在"这件事只出现在日志里，
 * 而 `backup-status.json` 要等到下一次备份才会带上它。
 */
export function touchBackupStatus(backupDir: string): BackupStatusFile {
  const current = readBackupStatus(backupDir);
  try {
    writeBackupStatus(backupDir, current);
  } catch {
    // 写不进去就算了：调用方只关心"尝试过"
  }
  return current;
}

/** 原子写（tmp + rename）；写失败抛给调用方决定（备份主流程会 catch 成 WARN）。 */
export function writeBackupStatus(backupDir: string, status: BackupStatusFile): void {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, BACKUP_STATUS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

export function recordBackupSuccess(
  backupDir: string,
  info: {
    name: string;
    bytes: number;
    verifyMs: number | null;
    /** P1：整归档 sha256（外部凭据，见 BackupStatusFile.lastSuccessSha256） */
    sha256?: string | null;
    /** P1：归档成员数（含目录项） */
    members?: number | null;
  },
): BackupStatusFile {
  const prev = readBackupStatus(backupDir);
  const next: BackupStatusFile = {
    ...prev,
    lastSuccessAt: new Date().toISOString(),
    lastSuccessName: info.name,
    lastSuccessBytes: info.bytes,
    lastVerifyMs: info.verifyMs,
    lastSuccessSha256: info.sha256 ?? null,
    lastSuccessMembers: info.members ?? null,
    consecutiveFailures: 0,
  };
  try {
    writeBackupStatus(backupDir, next);
  } catch {
    // 状态写不进去（磁盘满/只读）不该把一次**成功的**备份变成失败
  }
  return next;
}

export function recordBackupFailure(
  backupDir: string,
  info: { stage: 'export' | 'verify' | 'sweep'; message: string; name?: string | null },
): BackupStatusFile {
  const prev = readBackupStatus(backupDir);
  const next: BackupStatusFile = {
    ...prev,
    lastFailureAt: new Date().toISOString(),
    lastFailureStage: info.stage,
    lastFailureName: info.name ?? null,
    lastFailureMessage: String(info.message || '').slice(0, 2000),
    // ⚠️ 巡检（sweep）发现某份归档坏了**不计入** consecutiveFailures：
    // 那个计数器的语义是"导出/校验连续失败了几次"（cron 备份还产不产得出可用归档），
    // 而巡检失败说的是"已经躺在盘上的某份归档坏了"，两件事混在一个数字里
    // 会让"备份一直在失败"与"三个月前那份归档烂了"分不开。巡检结果看 lastSweep* 那几项。
    consecutiveFailures:
      info.stage === 'sweep' ? Number(prev.consecutiveFailures || 0) : Number(prev.consecutiveFailures || 0) + 1,
  };
  try {
    writeBackupStatus(backupDir, next);
  } catch {
    // 同上
  }
  return next;
}

/** P4：把一次巡检的结果落进状态文件（不碰 consecutiveFailures，理由见 recordBackupFailure）。 */
export function recordSweep(
  backupDir: string,
  info: {
    ms: number;
    results: SweepArchiveResult[];
    message?: string | null;
  },
): BackupStatusFile {
  const prev = readBackupStatus(backupDir);
  const failures = info.results.filter((item) => !item.ok).length;
  const next: BackupStatusFile = {
    ...prev,
    lastSweepAt: new Date().toISOString(),
    lastSweepMs: Math.max(0, Math.round(info.ms) || 0),
    lastSweepArchives: info.results.length,
    lastSweepFailures: failures,
    lastSweepResults: info.results.slice(0, 20),
    lastSweepMessage: String(info.message ?? '').slice(0, 2000) || null,
  };
  try {
    writeBackupStatus(backupDir, next);
  } catch {
    // 同上
  }
  return next;
}

/** env 解析：非法/缺失回落默认 48；0 = 关闭 WARN（恢复旧行为）。 */
export function resolveStaleWarnHours(
  raw: string | undefined = process.env[BACKUP_STALE_WARN_HOURS_ENV],
  fallback: number = DEFAULT_BACKUP_STALE_WARN_HOURS,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

/**
 * 上一次成功备份太旧（或从未成功）时返回一句人话 WARN 文案；不旧/关闭时返回 null。
 * 供启动检查与每次备份失败后的日志复用。
 */
export function staleBackupWarning(
  status: BackupStatusFile,
  now: Date = new Date(),
  staleHours: number = resolveStaleWarnHours(),
): string | null {
  if (!(staleHours > 0)) {
    return null;
  }
  const maxAgeMs = staleHours * 3600 * 1000;
  if (!status.lastSuccessAt) {
    return `没有任何已校验成功的整站备份记录（${BACKUP_STATUS_FILE} 里没有 lastSuccessAt）——请在后台「备份与恢复」做一次导出，或用 vanblog.sh install-cron 装定时备份`;
  }
  const ageMs = now.getTime() - new Date(status.lastSuccessAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
    const ageHours = Math.round(ageMs / 3600000);
    return `上一次成功的整站备份已经是 ${ageHours} 小时前（${status.lastSuccessAt}，归档 ${
      status.lastSuccessName || '?'
    }），超过阈值 ${staleHours}h（${BACKUP_STALE_WARN_HOURS_ENV} 可调，0=关闭）`;
  }
  return null;
}

/**
 * P4：巡检间隔（小时）。非法/缺失回落 **24**；`0` = 关闭巡检（= 今天的行为）。
 *
 * 为什么默认 24 小时：`vanblog.sh install-cron` 装的就是**每天一次**的整站备份，
 * 于是"昨天的备份今天被巡检一遍"正好接上；而位翻转/静默损坏是以周到月为尺度的过程，
 * 再密也没有额外收益（成本却线性上涨）。实测单份 69MB 归档的 cheap 巡检 ≈ 0.9s、
 * 深度 ≈ 1.4s，3 份也就是几秒 —— 一天一次完全无感。
 * 上限夹到 24*365：写成 999999 的意图是"几乎不跑"，那就让它等于关掉，别让定时器溢出。
 */
export function resolveSweepIntervalHours(
  raw: string | undefined = process.env[BACKUP_SWEEP_INTERVAL_ENV],
  fallback: number = DEFAULT_BACKUP_SWEEP_HOURS,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(Math.floor(n), 24 * 365);
}

/** P4：一次巡检最多查几份（最新的优先）。非法/缺失回落 3；0 = 关闭巡检。 */
export function resolveSweepMax(
  raw: string | undefined = process.env[BACKUP_SWEEP_MAX_ENV],
  fallback: number = DEFAULT_BACKUP_SWEEP_MAX,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(Math.floor(n), 100);
}
