import * as fs from 'fs';
import * as path from 'path';

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

export interface BackupStatusFile {
  version: number;
  updatedAt: string;
  /** 最近一次「导出+校验都成功」的时间（ISO）；从未成功过为 null */
  lastSuccessAt: string | null;
  lastSuccessName: string | null;
  lastSuccessBytes: number | null;
  /** 最近一次成功备份的写后校验耗时（ms） */
  lastVerifyMs: number | null;
  /** 最近一次失败（导出或校验）的时间；成功后不清零，保留现场 */
  lastFailureAt: string | null;
  lastFailureStage: 'export' | 'verify' | null;
  lastFailureName: string | null;
  lastFailureMessage: string | null;
  /** 连续失败次数：任何一次成功归零。cron 备份坏了多久，看这个数字 */
  consecutiveFailures: number;
}

export function emptyBackupStatus(): BackupStatusFile {
  return {
    version: BACKUP_STATUS_VERSION,
    updatedAt: new Date(0).toISOString(),
    lastSuccessAt: null,
    lastSuccessName: null,
    lastSuccessBytes: null,
    lastVerifyMs: null,
    lastFailureAt: null,
    lastFailureStage: null,
    lastFailureName: null,
    lastFailureMessage: null,
    consecutiveFailures: 0,
  };
}

/** 读状态；文件缺失/损坏/版本不认识都回落到空状态（绝不让状态文件把备份流程带崩）。 */
export function readBackupStatus(backupDir: string): BackupStatusFile {
  try {
    const file = path.join(backupDir, BACKUP_STATUS_FILE);
    if (!fs.existsSync(file)) {
      return emptyBackupStatus();
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== BACKUP_STATUS_VERSION) {
      return emptyBackupStatus();
    }
    return { ...emptyBackupStatus(), ...parsed };
  } catch {
    return emptyBackupStatus();
  }
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
  info: { name: string; bytes: number; verifyMs: number | null },
): BackupStatusFile {
  const prev = readBackupStatus(backupDir);
  const next: BackupStatusFile = {
    ...prev,
    lastSuccessAt: new Date().toISOString(),
    lastSuccessName: info.name,
    lastSuccessBytes: info.bytes,
    lastVerifyMs: info.verifyMs,
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
  info: { stage: 'export' | 'verify'; message: string; name?: string | null },
): BackupStatusFile {
  const prev = readBackupStatus(backupDir);
  const next: BackupStatusFile = {
    ...prev,
    lastFailureAt: new Date().toISOString(),
    lastFailureStage: info.stage,
    lastFailureName: info.name ?? null,
    lastFailureMessage: String(info.message || '').slice(0, 2000),
    consecutiveFailures: Number(prev.consecutiveFailures || 0) + 1,
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
