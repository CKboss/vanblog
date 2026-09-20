import { Logger } from '@nestjs/common';
import {
  RESTORE_REJECT_CLASSES,
  RESTORE_REJECT_ESCALATE_AFTER_ENV,
  RESTORE_REJECT_LOG_WINDOW_ENV,
  recordRestoreRejection,
  redactSecretsForLog,
  resetRestoreRejectLog,
  restoreRejectCounts,
  restoreRejectLevel,
} from './restoreSecurityLog';

/**
 * 「安全相关的拒绝必须留痕」这条性质的守卫。
 *
 * 背景是**实测**出来的缺陷，不是假想：活体验证里验签不匹配、换公钥、超体积、缺 confirm
 * 这四种拒绝**在应用日志里 0 命中**（同一份日志 298 行、`Nest` 269 命中 ⇒ 尺子是有效的），
 * 而**成功**路径是有日志的 ⇒ 成功/失败不对称。后果是有人拿篡改归档反复试探时，
 * 事后在应用日志里查不到任何痕迹，`./vanblog.sh doctor` 的"近 24h ERROR/FATAL 计数"也看不见。
 *
 * ⚠️ 这个 spec 里的时间**全部注入**（`{ now }`），一条都不真睡 —— 窗口默认 60 秒，
 * 真睡会让这一个文件跑几分钟（本仓库有过单个 spec 拖到 400 秒的先例）。
 */

/** 抓 Nest Logger 的输出。⚠️ 必须 spy **原型**：模块里是 `new Logger('RestoreSecurity')`，
 *  实例方法来自原型，spy 实例是抓不到的。 */
function captureLogs() {
  const errors: string[] = [];
  const warns: string[] = [];
  const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
    errors.push(String(m));
  });
  const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
    warns.push(String(m));
  });
  return {
    errors,
    warns,
    all: () => [...warns, ...errors],
    restore: () => {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

describe('restoreSecurityLog：级别判据', () => {
  it('每个类别都有级别，且只可能是 error 或 warn（新增类别漏配就会红）', () => {
    // ⚠️ 替身自检：先证明这个清单不是空的，否则下面的循环断言恒真
    expect(RESTORE_REJECT_CLASSES.length).toBeGreaterThan(8);
    for (const cls of RESTORE_REJECT_CLASSES) {
      const level = restoreRejectLevel(cls);
      expect(['error', 'warn']).toContain(level);
    }
  });

  it('只有"来路不正的归档"才可能是 error：穿越成员/超体积/超成员数/签名不匹配/.sig 形状不对', () => {
    for (const cls of [
      'unsafe-entry',
      'size-cap',
      'member-cap',
      'signature-mismatch',
      'signature-malformed',
    ] as const) {
      expect(restoreRejectLevel(cls)).toBe('error');
    }
  });

  it('诚实站长自己会撞上的形状是 warn（否则 doctor 的 ERROR 计数会变成常态噪音）', () => {
    for (const cls of [
      'signature-key-mismatch',
      'signature-hash-failed',
      'not-our-archive',
      'unpack-failed',
      'member-table-unreadable',
      'space-shortfall',
      'confirm-missing',
      'signing-overwrite-refused',
    ] as const) {
      expect(restoreRejectLevel(cls)).toBe('warn');
    }
    // 负向对照：这两组不能重合，否则上面两条断言会同时通过而其实什么都没区分
    expect(restoreRejectLevel('unsafe-entry')).not.toBe(restoreRejectLevel('confirm-missing'));
  });
});

describe('restoreSecurityLog：节流（按类 + 时间窗，绝不按值永久去重）', () => {
  const T0 = 1_700_000_000_000;
  beforeEach(() => {
    resetRestoreRejectLog();
    delete process.env[RESTORE_REJECT_LOG_WINDOW_ENV];
    delete process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV];
  });

  it('第一次一定打日志（诚实站长的一次误操作必须立刻可见）', () => {
    const cap = captureLogs();
    try {
      const r = recordRestoreRejection('confirm-missing', '没带 confirm=true', { now: T0 });
      expect(r.logged).toBe(true);
      expect(r.count).toBe(1);
      expect(r.level).toBe('warn');
      expect(cap.warns).toHaveLength(1);
      expect(cap.warns[0]).toContain('confirm-missing');
      expect(cap.warns[0]).toContain('没带 confirm=true');
    } finally {
      cap.restore();
    }
  });

  it('窗口内的第二、第三次被压掉，但**计数照涨**（洪水打不爆日志，探测仍然可见）', () => {
    const cap = captureLogs();
    try {
      recordRestoreRejection('size-cap', '第 1 次', { now: T0 });
      const r2 = recordRestoreRejection('size-cap', '第 2 次', { now: T0 + 1_000 });
      const r3 = recordRestoreRejection('size-cap', '第 3 次', { now: T0 + 2_000 });
      expect(r2.logged).toBe(false);
      expect(r3.logged).toBe(false);
      expect(r3.count).toBe(3);
      expect(cap.errors).toHaveLength(1); // size-cap 是 error 级
      // 🔴 计数必须包含被压掉的那两次，否则"反复试探"这件事就丢了
      expect(restoreRejectCounts()['size-cap']).toBe(3);
      expect(restoreRejectCounts().__total).toBe(3);
    } finally {
      cap.restore();
    }
  });

  it('窗口过后再打一条，并且**说出这期间被压掉了多少次**', () => {
    const cap = captureLogs();
    try {
      recordRestoreRejection('member-cap', '第 1 次', { now: T0 });
      recordRestoreRejection('member-cap', '第 2 次', { now: T0 + 1_000 });
      recordRestoreRejection('member-cap', '第 3 次', { now: T0 + 2_000 });
      const r = recordRestoreRejection('member-cap', '第 4 次', { now: T0 + 60_000 });
      expect(r.logged).toBe(true);
      expect(cap.errors).toHaveLength(2);
      expect(cap.errors[1]).toContain('还被拒了 2 次');
      expect(cap.errors[1]).toContain('本类累计 4 次');
    } finally {
      cap.restore();
    }
  });

  it('🔴 与"按值永久去重"的关键差别：窗口过后**同一个值**也要能再打（攻击探测不能被永久静音）', () => {
    const cap = captureLogs();
    try {
      const detail = '完全相同的一条细节';
      recordRestoreRejection('unsafe-entry', detail, { now: T0 });
      recordRestoreRejection('unsafe-entry', detail, { now: T0 + 60_000 });
      const r3 = recordRestoreRejection('unsafe-entry', detail, { now: T0 + 120_000 });
      expect(r3.logged).toBe(true);
      expect(cap.errors).toHaveLength(3);
    } finally {
      cap.restore();
    }
  });

  it('窗口大小可用环境变量调（写 0 / 垃圾值回落默认，符合 envPositiveInt 语义）', () => {
    const cap = captureLogs();
    try {
      process.env[RESTORE_REJECT_LOG_WINDOW_ENV] = '2000';
      recordRestoreRejection('size-cap', 'a', { now: T0 });
      expect(recordRestoreRejection('size-cap', 'b', { now: T0 + 1_999 }).logged).toBe(false);
      expect(recordRestoreRejection('size-cap', 'c', { now: T0 + 2_000 }).logged).toBe(true);

      resetRestoreRejectLog();
      process.env[RESTORE_REJECT_LOG_WINDOW_ENV] = '0'; // ⚠️ 0 不是"关节流"，是回落默认 60s
      recordRestoreRejection('size-cap', 'a', { now: T0 });
      expect(recordRestoreRejection('size-cap', 'b', { now: T0 + 30_000 }).logged).toBe(false);
      expect(recordRestoreRejection('size-cap', 'c', { now: T0 + 60_000 }).logged).toBe(true);

      resetRestoreRejectLog();
      process.env[RESTORE_REJECT_LOG_WINDOW_ENV] = 'abc';
      recordRestoreRejection('size-cap', 'a', { now: T0 });
      expect(recordRestoreRejection('size-cap', 'b', { now: T0 + 30_000 }).logged).toBe(false);
    } finally {
      cap.restore();
      delete process.env[RESTORE_REJECT_LOG_WINDOW_ENV];
    }
  });
});

describe('restoreSecurityLog：反复试探要升级成 ERROR（让 doctor 看得见 WARN 级别的洪水）', () => {
  const T0 = 1_700_000_000_000;
  beforeEach(() => {
    resetRestoreRejectLog();
    delete process.env[RESTORE_REJECT_LOG_WINDOW_ENV];
    delete process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV];
  });

  it('warn 级别的类被刷到阈值时，额外打一条 ERROR 汇总（含各类计数）', () => {
    const cap = captureLogs();
    try {
      // 默认 escalateAfter=10、window=60s：每次间隔 60s 以免被节流压掉汇总
      for (let i = 0; i < 10; i += 1) {
        recordRestoreRejection('confirm-missing', `第 ${i + 1} 次`, { now: T0 + i * 60_000 });
      }
      const summaries = cap.errors.filter((m) => m.includes('恢复相关的拒绝已累计'));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('confirm-missing=10');
      expect(summaries[0]).toContain('10 次');
      // ⚠️ 汇总里要点名"这个量级更像是在被反复试探"，否则运维不知道该怎么反应
      expect(summaries[0]).toMatch(/反复试探|来源 IP/);
    } finally {
      cap.restore();
    }
  });

  it('汇总自己也节流：同一窗口内不会每 10 次就打一条（否则高频攻击下汇总就是新的日志炸弹）', () => {
    const cap = captureLogs();
    try {
      for (let i = 0; i < 30; i += 1) {
        // 全部落在同一个 60s 窗口内
        recordRestoreRejection('confirm-missing', `第 ${i + 1} 次`, { now: T0 + i });
      }
      const summaries = cap.errors.filter((m) => m.includes('恢复相关的拒绝已累计'));
      expect(summaries.length).toBeLessThanOrEqual(1);
      // 但计数必须准确（30 次都在）
      expect(restoreRejectCounts()['confirm-missing']).toBe(30);
    } finally {
      cap.restore();
    }
  });

  it('阈值可用环境变量调；写 1 / 0 / 垃圾值都回落到安全侧（不会变成"每次都汇总"或"永不汇总"）', () => {
    const cap = captureLogs();
    try {
      process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV] = '2';
      recordRestoreRejection('confirm-missing', 'a', { now: T0 });
      recordRestoreRejection('confirm-missing', 'b', { now: T0 + 60_000 });
      expect(cap.errors.filter((m) => m.includes('恢复相关的拒绝已累计'))).toHaveLength(1);

      resetRestoreRejectLog();
      cap.errors.length = 0;
      process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV] = '0'; // ⇒ 回落默认 10
      for (let i = 0; i < 5; i += 1) {
        recordRestoreRejection('confirm-missing', `x${i}`, { now: T0 + i * 60_000 });
      }
      expect(cap.errors.filter((m) => m.includes('恢复相关的拒绝已累计'))).toHaveLength(0);
    } finally {
      cap.restore();
      delete process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV];
    }
  });
});

describe('restoreSecurityLog：🔴 日志里绝不出现秘密', () => {
  const PEM =
    '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJx\nabcDEF123\n-----END PRIVATE KEY-----';
  const SIG64 =
    'MEUCIQDx8Yz6kFf0mZ1pQ2wE3rT4yU5iO6pA7sD8fG9hI0jKlMnO1pQ2rS3tU4vW5xY6zA7bC8dE9fG0hI1jQ==';
  const SHA = 'a'.repeat(64);
  const FINGERPRINT = '7a6d6e15322a374e'; // 16 位十六进制：公钥指纹，**允许**留下

  it('PEM 块整段抹掉（私钥/公钥都不该进日志）', () => {
    const out = redactSecretsForLog(`密钥内容：${PEM} 结束`);
    expect(out).not.toContain('BEGIN PRIVATE KEY');
    expect(out).not.toContain('MC4CAQAwBQYDK2VwBCIEIJx');
    expect(out).toContain('<redacted-pem>');
  });

  it('≥32 位十六进制被打码，而 **16 位公钥指纹原样保留**（排障必需且不构成秘密）', () => {
    const out = redactSecretsForLog(`归档 sha256=${SHA}，密钥指纹 ${FINGERPRINT}`);
    expect(out).not.toContain(SHA);
    expect(out).toContain('<redacted-hex>');
    expect(out).toContain(FINGERPRINT);
  });

  it('≥64 位 base64（ed25519 签名是 88 字符）被打码', () => {
    const out = redactSecretsForLog(`签名 ${SIG64}`);
    expect(out).not.toContain(SIG64);
    expect(out).toContain('<redacted-b64>');
  });

  it('passphrase / token / setupKey 这类键值形状的值被打码，键名保留', () => {
    const out = redactSecretsForLog(
      'passphrase=hunter2-very-secret token="abc.def.ghi" setupKey: 0123456789abcdef',
    );
    expect(out).not.toContain('hunter2-very-secret');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('0123456789abcdef');
    expect(out).toContain('passphrase=');
    expect(out).toContain('<redacted>');
  });

  it('归档名与普通中文说明**不受影响**（不能把有用信息一起抹掉）', () => {
    const text = '拒绝恢复：vanblog-full-20260913-172338.tar.zst 的成员数超过上限（5 万）';
    expect(redactSecretsForLog(text)).toBe(text);
  });

  it('🔴 端到端：即使调用方手滑把口令拼进 detail，落到日志里也已经被打码', () => {
    resetRestoreRejectLog();
    const cap = captureLogs();
    try {
      recordRestoreRejection('unpack-failed', `解密失败：口令是 ${PEM} 而且 sha=${SHA}`, {
        now: 1_700_000_000_000,
      });
      const line = cap.warns[0];
      expect(line).toBeDefined();
      expect(line).not.toContain('BEGIN PRIVATE KEY');
      expect(line).not.toContain(SHA);
      expect(line).toContain('<redacted');
    } finally {
      cap.restore();
    }
  });

  it('⚠️ 尺子有效性反证：打码函数不是"把一切都抹掉"—— 无害文本必须原样通过', () => {
    // 如果 redactSecretsForLog 恒返回 '<redacted>'，上面所有 not.toContain 都会假绿
    expect(redactSecretsForLog('成员数超过上限 50000，已中止读取')).toBe('成员数超过上限 50000，已中止读取');
    expect(redactSecretsForLog('')).toBe('');
  });
});

describe('restoreSecurityLog：计数与重置', () => {
  beforeEach(() => {
    resetRestoreRejectLog();
    delete process.env[RESTORE_REJECT_LOG_WINDOW_ENV];
    delete process.env[RESTORE_REJECT_ESCALATE_AFTER_ENV];
  });

  it('counts 是副本（调用方改不动内部状态），且包含所有类别 + __total', () => {
    const cap = captureLogs();
    try {
      recordRestoreRejection('size-cap', 'a', { now: 1_700_000_000_000 });
      const snapshot = restoreRejectCounts();
      snapshot['size-cap'] = 999;
      snapshot.__total = 999;
      expect(restoreRejectCounts()['size-cap']).toBe(1);
      expect(restoreRejectCounts().__total).toBe(1);
      for (const cls of RESTORE_REJECT_CLASSES) {
        expect(typeof restoreRejectCounts()[cls]).toBe('number');
      }
    } finally {
      cap.restore();
    }
  });

  it('reset 之后计数与节流窗口都归零（测试之间不会串味）', () => {
    const cap = captureLogs();
    try {
      recordRestoreRejection('size-cap', 'a', { now: 1_700_000_000_000 });
      resetRestoreRejectLog();
      expect(restoreRejectCounts()['size-cap']).toBe(0);
      const r = recordRestoreRejection('size-cap', 'b', { now: 1_700_000_000_000 });
      // 同一个时间戳也当成"第一次"⇒ 证明窗口状态也清了
      expect(r.logged).toBe(true);
      expect(r.count).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('detail 缺失时也要打日志（不能因为没细节就静默）', () => {
    const cap = captureLogs();
    try {
      const r = recordRestoreRejection('unsafe-entry', undefined, { now: 1_700_000_000_000 });
      expect(r.logged).toBe(true);
      expect(cap.errors[0]).toContain('（无细节）');
    } finally {
      cap.restore();
    }
  });

  it('超长 detail 被截断（一条日志不该把轮转配额吃光）', () => {
    const cap = captureLogs();
    try {
      recordRestoreRejection('not-our-archive', 'x'.repeat(5_000), { now: 1_700_000_000_000 });
      expect(cap.warns[0].length).toBeLessThan(1_200);
    } finally {
      cap.restore();
    }
  });
});
