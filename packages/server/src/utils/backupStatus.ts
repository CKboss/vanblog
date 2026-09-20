import * as fs from 'fs';
import * as path from 'path';
import { RestoreJournal, readRestoreJournal } from './restoreJournal';
import { SECRET_DIR_MODE, ensureSecretDir, writeSecretFileSync } from './secretFileMode';

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

import type { BackupEncryptionSummary } from './backupCrypto';

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
  /**
   * 最近一次成功备份**是否加密**。
   *
   * ⚠️ 为什么要单独存一个布尔，而不是让运维去看文件名有没有 `.enc`：
   * 状态文件是"备份还健不健康"的唯一外部凭据（`vanblog.sh backup-status --strict` 读它），
   * 而"我以为开了加密、其实没开"是这个功能最危险的失败模式 —— 归档安安稳稳躺在
   * 对象存储里，站长以为它安全，实际里面是明文的 JWT 密钥。所以这个字段必须**显眼**，
   * 而且 `false` 与 `null`（老状态文件，那次备份早于本功能）要区分开。
   */
  lastSuccessEncrypted: boolean | null;
  /**
   * 加密参数摘要（KDF 的 N/r/p、salt、块大小、内层压缩格式）。
   *
   * ⚠️ 全是**非机密**参数，可以放心写进这个明文文件：解密端按头部/这里的参数派生密钥，
   * 所以将来把默认参数调强了，老归档仍然解得开。口令与派生密钥**绝不**出现在这里。
   */
  lastSuccessEncryption: BackupEncryptionSummary | null;
  /**
   * 最近一次成功备份**有没有签名**（写出了 `.sig`）。
   *
   * ⚠️ 与 `lastSuccessEncrypted` 同一个理由、同一个形状：`null` ≠ `false`。
   * `null` 表示"这次备份早于签名功能，不知道"，`false` 表示"确定没签"。
   * 把"不知道"写成 false 会让人以为已经确认过这份归档是不可证明的；
   * 而把"没签"藏起来更糟 —— 站长会照着"我有签名保护"去规划异地副本。
   * `vanblog.sh backup-status --strict` 读这个文件，所以它是"备份健不健康"的外部凭据。
   */
  lastSuccessSigned: boolean | null;
  /**
   * 签名参数摘要：算法、摘要、**公钥指纹**。
   *
   * ⚠️ 全是非机密（指纹是公钥的哈希，公钥本来就可公开），所以可以放心写进这个明文文件。
   * 它的用途是让站长在**没有 `.sig` 在手**时也能回答"这份归档该用哪把公钥验"，
   * 以及发现"指纹变了"（说明密钥被换过，旧归档要用旧公钥验）。
   * 私钥与口令**绝不**出现在这里。
   */
  lastSuccessSigning: BackupSigningSummary | null;
  /** 最近一次失败（导出或校验）的时间；成功后不清零，保留现场 */
  lastFailureAt: string | null;
  /**
   * `'timeout'` = 整轮备份超过 `VANBLOG_BACKUP_TIMEOUT_MINUTES` 被中止。
   * 单独一个 stage 而不是并入 `'export'`：超时说的是"卡住了"（磁盘/卷/网络挂了），
   * 而 export 失败说的是"这一步报错了"，排障方向完全不同。
   */
  lastFailureStage: 'export' | 'verify' | 'sweep' | 'timeout' | null;
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

/** 签名摘要（写进 `backup-status.json` 的那一份；全部非机密）。 */
export interface BackupSigningSummary {
  alg: string;
  digest: string;
  /** 公钥 sha256 前 16 位；用来在多把密钥之间认人 */
  keyFingerprint: string;
  /** `.sig` 的文件名（只是提示，校验以内容 sha256 为准） */
  sigName: string | null;
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
    lastSuccessEncrypted: null,
    lastSuccessEncryption: null,
    lastSuccessSigned: null,
    lastSuccessSigning: null,
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
  // 0700 / 0600：这个文件躺在**挂载到宿主机**的备份目录里，内容是"这台机器的备份还产不产得出
  // 可用归档"+ 失败原因 + 整归档 sha256。它不像归档那样含凭据，但它与归档同目录，
  // 目录收紧到 0700 之后就没理由让它自己还是 0644（理由与 POSIX 细节见 utils/secretFileMode.ts）。
  ensureSecretDir(backupDir, SECRET_DIR_MODE);
  const file = path.join(backupDir, BACKUP_STATUS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeSecretFileSync(tmp, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
  // ⚠️ rename 会保留 tmp 的权限，所以最终文件也是 0600；但对**升级前就存在**的
  // backup-status.json（0644），rename 覆盖后权限来自 tmp ⇒ 同样收紧了。
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
    /** 这份归档是否加密（调用方从 `createFullBackup` 的结果里拿） */
    encrypted?: boolean | null;
    /** 加密参数摘要（非机密）；未加密时传 null */
    encryption?: BackupEncryptionSummary | null;
    /** 这份归档有没有签名（调用方从 `createFullBackup` 的结果里拿） */
    signed?: boolean | null;
    /** 签名摘要（非机密）；未签名时传 null */
    signing?: BackupSigningSummary | null;
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
    // ⚠️ 用 `?? null` 而不是 `?? false`：调用方没传（老代码路径）时留 null =
    //    "不知道"，与"确定没加密"（false）区分开。把"不知道"写成 false 会让人
    //    以为已经确认过这份是明文的。
    lastSuccessEncrypted: info.encrypted ?? null,
    lastSuccessEncryption: info.encryption ?? null,
    // ⚠️ 同样用 `?? null`：调用方没传（老代码路径）时留 null = "不知道"，
    //    与"确定没签名"（false）区分开。理由见 BackupStatusFile.lastSuccessSigned。
    lastSuccessSigned: info.signed ?? null,
    lastSuccessSigning: info.signing ?? null,
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
  info: {
    stage: 'export' | 'verify' | 'sweep' | 'timeout';
    message: string;
    name?: string | null;
  },
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
