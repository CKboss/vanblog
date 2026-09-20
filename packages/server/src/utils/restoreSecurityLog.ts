import { Logger } from '@nestjs/common';
import { envPositiveInt } from './envNumber';

/**
 * 恢复/备份路径上「**安全相关的拒绝**」的统一日志口径。
 *
 * ## 为什么需要这个模块（实测出来的缺陷，不是理论洁癖）
 *
 * 活体验证（见 `AGENTS.md` §7.82 第 2 条）证明：验签不匹配、换公钥、压缩炸弹超体积、
 * 缺 `confirm=true` 这些**全部只存在于 HTTP 响应体里，应用日志一条都没有** ——
 * 日志尺子本身是有效的（同一份日志 298 行、`Nest` 269 命中），而 `拒绝恢复` / `不匹配` /
 * `另一把密钥` / `超过允许的` / `恢复会覆盖当前全部数据` 五个关键词**命中 0**。
 *
 * 后果有两条，都不是"少一行日志"这么轻：
 *  1. `./vanblog.sh doctor` 的"近 24h ERROR/FATAL 计数"**看不到**这些拒绝 ⇒
 *     有人拿篡改归档或压缩炸弹**反复试探**，事后在应用日志里**没有任何可追溯记录**
 *     （只有 caddy 访问日志里一串匿名的 400，看不出拒的是什么、为什么拒）。
 *  2. **成功路径是写日志的**（`签名校验通过`、`missing-sig` 的 WARN 都有）⇒
 *     成功/失败**不对称**。这种不对称最阴险的地方是：运维看到"日志里有签名相关的行"
 *     就会以为验签在正常工作，而**失败**恰恰是唯一需要被看见的那一半。
 *
 * ## 三条设计约束（每条都对应一个真实的失败模式）
 *
 * **① 分级，而不是一律 ERROR。**
 * `doctor` 统计的是 ERROR/FATAL，所以"想被体检看见"就得是 ERROR；但把**站长自己配错公钥**
 * （`key-mismatch`）也报成 ERROR，等于给体检制造常态噪音 —— 而常红的体检没人看。
 * 判据是「**诚实的站长会不会自己撞上它**」：
 *  - `error`：只有来路不正的归档才可能触发的形状（路径穿越成员、超体积、超成员数、
 *    签名不匹配、`.sig` 形状不对）。这些正常情况下**一次都不该出现**。
 *  - `warn`：诚实操作也会撞上的形状（下载被截断、传错文件、公钥配错、磁盘不够、
 *    忘带 confirm）。要可见，但不该污染 ERROR 计数。
 *
 * **② 节流，但绝不"按值永久去重"。**
 * 这些端点里 `POST /api/admin/init/restore` 是**匿名可达**的，攻击者可以高频触发 ⇒
 * 每次都打一条就是自己给自己造日志炸弹（日志有轮转上限，真信息会被冲走）。
 * 本仓库已有的两处去重先例（`caddy.provider.ts` 的 `pagesDirWarnedFor`、
 * `isr.provider.ts` 的 `reaperPagesDirWarned`）都是**按值永久去重** ——
 * 那对"配错的静态配置"是对的（值不变 ⇒ 说一次就够），但对**攻击探测是错的**：
 * 第二次、第一万次尝试就再也看不见了。
 * 所以这里的口径是「**按类 + 时间窗**」：同一类拒绝在窗口内（默认 60s）最多一条，
 * 窗口过后的下一次会带上"这期间还被拒了多少次、进程启动以来累计多少次"。
 * ⇒ 洪水打不爆日志，但**持续探测仍然周期性可见**。
 *
 * **③ 反复试探要能升级成 ERROR。**
 * 光有节流还不够：`warn` 级别的类（例如缺 confirm）被刷一万次，`doctor` 依然什么都看不见。
 * 所以每累计到 `escalateAfter`（默认 10）次，就**额外**打一条 ERROR 汇总，
 * 把所有类的计数一次列出来。这条汇总自己也要节流（同一窗口最多一条），
 * 否则"每 10 次一条 ERROR"在高频攻击下仍然是日志炸弹。
 *
 * ## 🔴 日志里绝不出现秘密
 * 恢复路径上手边就摆着三样东西：备份口令、`.sig` 里的 base64 签名、PEM 密钥。
 * 所有经过这里的文本都会先过 `redactSecretsForLog()`：PEM 块整段抹掉、
 * ≥32 位十六进制串与 ≥64 位 base64 串打码、`passphrase=`/`token=`/`setupKey=` 的值打码。
 * ⚠️ 允许留下的是**公钥指纹**（16 位十六进制，与既有的验签文案口径一致）与**归档名** ——
 * 那是排障必需、且本身不构成秘密的东西。
 */

const logger = new Logger('RestoreSecurity');

/**
 * 拒绝类别。**新增一类时必须同时决定它的级别**（`RESTORE_REJECT_LEVELS`），
 * 并且守卫会断言"每个类别都有级别、且级别只可能是 error/warn"。
 */
export type RestoreRejectClass =
  /** 归档成员会写到解包目录之外（绝对路径 / `..` / 符号链接） */
  | 'unsafe-entry'
  /** 成员 size 之和超过 `VANBLOG_RESTORE_MAX_TOTAL_BYTES`（压缩炸弹） */
  | 'size-cap'
  /** 成员**条数**超过 `VANBLOG_RESTORE_MAX_MEMBERS`（成员表放大） */
  | 'member-cap'
  /** 签名验不过：内容或签名在签名之后被改动过 */
  | 'signature-mismatch'
  /** `.sig` 读不出来或形状不对 */
  | 'signature-malformed'
  /** `.sig` 是另一把密钥签的（**多半是站长配错公钥**，不是攻击） */
  | 'signature-key-mismatch'
  /** 为验签回读归档算 sha256 失败 */
  | 'signature-hash-failed'
  /** 归档里没有 manifest.json / manifest 校验失败（不是本功能导出的） */
  | 'not-our-archive'
  /** 解不开（截断、位翻转、口令不对） */
  | 'unpack-failed'
  /** 成员表都读不出来 */
  | 'member-table-unreadable'
  /** 目标卷剩余空间不够 */
  | 'space-shortfall'
  /** 破坏性恢复缺 `confirm=true`（或给的不是字面 true） */
  | 'confirm-missing'
  /** 覆盖已有签名密钥但没带显式确认 */
  | 'signing-overwrite-refused';

/** 级别判据见文件头注释①：「诚实的站长会不会自己撞上它」。 */
const RESTORE_REJECT_LEVELS: Record<RestoreRejectClass, 'error' | 'warn'> = {
  'unsafe-entry': 'error',
  'size-cap': 'error',
  'member-cap': 'error',
  'signature-mismatch': 'error',
  'signature-malformed': 'error',
  'signature-key-mismatch': 'warn',
  'signature-hash-failed': 'warn',
  'not-our-archive': 'warn',
  'unpack-failed': 'warn',
  'member-table-unreadable': 'warn',
  'space-shortfall': 'warn',
  'confirm-missing': 'warn',
  'signing-overwrite-refused': 'warn',
};

/** 所有类别（守卫用它断言"每个类别都有级别"，避免新增类别时漏配）。 */
export const RESTORE_REJECT_CLASSES = Object.keys(RESTORE_REJECT_LEVELS) as RestoreRejectClass[];

export function restoreRejectLevel(cls: RestoreRejectClass): 'error' | 'warn' {
  return RESTORE_REJECT_LEVELS[cls] ?? 'warn';
}

/** 同一类拒绝的日志时间窗（毫秒）。默认 60s：足够压下洪水，又不至于让持续探测整天看不见。 */
export const RESTORE_REJECT_LOG_WINDOW_ENV = 'VANBLOG_RESTORE_REJECT_LOG_WINDOW_MS';
const RESTORE_REJECT_LOG_WINDOW_DEFAULT = 60_000;

/** 每累计这么多次就额外打一条 ERROR 汇总（让 `doctor` 的 ERROR 计数能看见 WARN 级别的反复试探）。 */
export const RESTORE_REJECT_ESCALATE_AFTER_ENV = 'VANBLOG_RESTORE_REJECT_ESCALATE_AFTER';
const RESTORE_REJECT_ESCALATE_AFTER_DEFAULT = 10;

export function restoreRejectLogWindowMs(): number {
  return envPositiveInt(
    RESTORE_REJECT_LOG_WINDOW_ENV,
    RESTORE_REJECT_LOG_WINDOW_DEFAULT,
    1_000,
    3_600_000,
  );
}

export function restoreRejectEscalateAfter(): number {
  return envPositiveInt(
    RESTORE_REJECT_ESCALATE_AFTER_ENV,
    RESTORE_REJECT_ESCALATE_AFTER_DEFAULT,
    2,
    1_000_000,
  );
}

interface ClassState {
  count: number;
  /** 本窗口内已经被压掉多少条（下一条日志会把这个数字说出来） */
  suppressed: number;
  lastLoggedAt: number;
}

const states = new Map<RestoreRejectClass, ClassState>();
let totalRecorded = 0;
let lastSummaryAt = 0;

/** 只给测试用：清空计数与时间窗（生产代码不要调）。 */
export function resetRestoreRejectLog(): void {
  states.clear();
  totalRecorded = 0;
  lastSummaryAt = 0;
}

/** 进程启动以来的累计计数（含被节流压掉的）。⚠️ 返回副本，调用方改不动内部状态。 */
export function restoreRejectCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cls of RESTORE_REJECT_CLASSES) {
    out[cls] = states.get(cls)?.count ?? 0;
  }
  out.__total = totalRecorded;
  return out;
}

/**
 * 抹掉文本里可能是秘密的东西。
 *
 * ⚠️ 这是**兜底**而不是主要防线：主要防线是"调用方根本不要把秘密拼进消息"。
 * 但恢复路径上手边就有口令、base64 签名与 PEM，一次手滑就会把它们写进日志、
 * 而日志是会被打包进备份、被 `doctor` 读、被站长贴到 issue 里的。
 *
 * 保留的东西（有意）：**公钥指纹**（16 位十六进制）与归档名 —— 排障必需且不构成秘密。
 * 所以十六进制的门槛是 **32** 位（sha256 全文是 64 位，指纹是 16 位，正好分开）。
 */
export function redactSecretsForLog(text: string): string {
  const raw = String(text ?? '');
  return (
    raw
      // PEM 块整段抹掉（私钥/公钥都不该进日志；公钥用指纹表达就够了）
      .replace(/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*-----/g, '<redacted-pem>')
      // 显式的键值形状：口令 / token / setupKey / 签名
      .replace(
        /\b(passphrase|password|token|setupKey|signature|secret)(["']?\s*[:=]\s*)(["']?)[^\s"',;)]+/gi,
        (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}<redacted>`,
      )
      // ≥32 位十六进制（sha256 全文之类）；16 位指纹不受影响
      .replace(/\b[0-9a-fA-F]{32,}\b/g, '<redacted-hex>')
      // ≥64 位 base64（ed25519 签名是 88 字符）
      .replace(/\b[A-Za-z0-9+/]{64,}={0,2}\b/g, '<redacted-b64>')
  );
}

export interface RecordRestoreRejectionResult {
  /** 这一次有没有真的写日志（被节流压掉时是 false） */
  logged: boolean;
  /** 这一类进程启动以来的累计次数（含被压掉的） */
  count: number;
  /** 这一次有没有触发 ERROR 汇总 */
  escalated: boolean;
  level: 'error' | 'warn';
}

/**
 * 记一次「安全相关的拒绝」。
 *
 * ⚠️ **调用点要在 `throw` 之前**：这些路径全都以抛 `BadRequestException` 收尾，
 * 抛出去之后本函数就没机会跑了（而那正是要被看见的时刻）。
 *
 * @param cls     拒绝类别（决定日志级别）
 * @param detail  人话细节（会过 `redactSecretsForLog`）。⚠️ 不要拼口令/token/签名原文。
 * @param now     可注入的时钟（毫秒）。⚠️ 测试必须用它，**绝不能真睡** 60 秒。
 */
export function recordRestoreRejection(
  cls: RestoreRejectClass,
  detail?: string | null,
  opts: { now?: number } = {},
): RecordRestoreRejectionResult {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const windowMs = restoreRejectLogWindowMs();
  const escalateAfter = restoreRejectEscalateAfter();
  const level = restoreRejectLevel(cls);

  const prev = states.get(cls);
  const state: ClassState = prev ?? { count: 0, suppressed: 0, lastLoggedAt: 0 };
  state.count += 1;
  totalRecorded += 1;

  // 第一次（lastLoggedAt=0）一定要打：诚实站长的一次误操作必须立刻可见。
  const due = state.lastLoggedAt === 0 || now - state.lastLoggedAt >= windowMs;
  const safeDetail = redactSecretsForLog(String(detail ?? '')).slice(0, 600);
  let logged = false;
  if (due) {
    const suppressedNote =
      state.suppressed > 0
        ? `（距上一条同类日志之间还被拒了 ${state.suppressed} 次）`
        : '';
    const line =
      `拒绝恢复请求 [${cls}]${suppressedNote}：${safeDetail || '（无细节）'}` +
      ` ｜ 本类累计 ${state.count} 次、全部拒绝累计 ${totalRecorded} 次（自本进程启动）。` +
      `⚠️ 这一类在正常情况下不该反复出现；如果在被反复试探，请检查来源 IP 与 caddy 访问日志。`;
    if (level === 'error') {
      logger.error(line);
    } else {
      logger.warn(line);
    }
    logged = true;
    state.lastLoggedAt = now;
    state.suppressed = 0;
  } else {
    state.suppressed += 1;
  }
  states.set(cls, state);

  // ── 升级：让 WARN 级别的反复试探也能被 doctor 的 ERROR 计数看见 ──────────────
  let escalated = false;
  if (state.count % escalateAfter === 0 && (lastSummaryAt === 0 || now - lastSummaryAt >= windowMs)) {
    const counts = restoreRejectCounts();
    const parts = RESTORE_REJECT_CLASSES.filter((c) => counts[c] > 0).map(
      (c) => `${c}=${counts[c]}${restoreRejectLevel(c) === 'error' ? '' : '(warn)'}`,
    );
    logger.error(
      `🔴 恢复相关的拒绝已累计 ${counts.__total} 次（${parts.join('、')}）。` +
        `单看每条可能都是站长自己的误操作，但**这个量级**更像是在被反复试探：` +
        `请核对 caddy 访问日志里的来源 IP，必要时把后台限制在可信网段` +
        `（VANBLOG_ADMIN_LOGIN_ALLOW_CIDR，⚠️ 它只限登录、不影响已签发的 token）。`,
    );
    escalated = true;
    lastSummaryAt = now;
  }

  return { logged, count: state.count, escalated, level };
}
