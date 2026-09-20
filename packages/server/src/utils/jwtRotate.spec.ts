import { JwtService } from '@nestjs/jwt';

import {
  DEFAULT_JWT_ROTATE_GRACE_DAYS,
  JWT_ROTATE_GRACE_DAYS_ENV,
  __setJwtKeyStateForTest,
  invalidateJwtSecretCache,
  jwtRotateGraceMs,
  kidOf,
  normalizeKeyState,
  rotateJwtSecret,
  selectJwtVerifyKey,
  switchJwtSigningKey,
} from './initJwt';

/**
 * JWT 密钥轮换的行为级测试。
 *
 * ⚠️ 这里的重点是**真签真验**：用真的 `@nestjs/jwt` 签出 token，再用
 * `selectJwtVerifyKey()` 挑出来的密钥去验。只断言"函数返回了某个字符串"是抓不到
 * "轮换把所有人踢下线"或"宽限期形同虚设"这两类真实事故的。
 */

// `rotateJwtSecret` 要连库；这里把 MongoClient 换成内存假件（CAS 语义要真的模拟出来）
jest.mock('mongodb', () => {
  class FakeMongoClient {
    static docs: any[] = [];
    static calls: string[] = [];
    constructor(_url: string, _opts?: any) {}
    async connect() {
      FakeMongoClient.calls.push('connect');
    }
    async close() {
      FakeMongoClient.calls.push('close');
    }
    db() {
      return {
        collection: (name: string) => ({
          async findOne(filter: any) {
            FakeMongoClient.calls.push(`findOne:${name}`);
            const found = FakeMongoClient.docs.find((d) => d.type === filter.type) || null;
            // 测试钩子：模拟"读到了、但在写之前被另一个请求改掉了"
            const hook = (FakeMongoClient as any).onAfterFindOne;
            if (hook) {
              (FakeMongoClient as any).onAfterFindOne = null;
              hook();
            }
            return found;
          },
          async findOneAndUpdate(filter: any, update: any, opts: any) {
            FakeMongoClient.calls.push(`findOneAndUpdate:${name}`);
            const idx = FakeMongoClient.docs.findIndex((d) => d.type === filter.type);
            if (idx < 0) return null;
            const doc = FakeMongoClient.docs[idx];
            // ⚠️ CAS：过滤条件里带了 'value.secret'，不匹配就必须**不写**并返回 null
            if ('value.secret' in filter && doc?.value?.secret !== filter['value.secret']) {
              return null;
            }
            const set = update.$set || {};
            for (const [k, v] of Object.entries(set)) {
              // 支持 'value.secret' 这种点路径
              const parts = k.split('.');
              let cur: any = doc;
              for (let i = 0; i < parts.length - 1; i += 1) {
                cur[parts[i]] = cur[parts[i]] || {};
                cur = cur[parts[i]];
              }
              cur[parts[parts.length - 1]] = v;
            }
            return opts?.returnDocument === 'after' ? doc : doc;
          },
          async countDocuments(filter: any) {
            FakeMongoClient.calls.push(`countDocuments:${name}`);
            return name === 'tokens' ? (FakeMongoClient as any).tokenCount ?? 0 : 0;
          },
        }),
      };
    }
  }
  return { MongoClient: FakeMongoClient, __isMockFunction: true };
});

jest.mock('src/config', () => ({
  ...jest.requireActual('src/config'),
  loadMongoUrl: async () => 'mongodb://fake/does-not-matter',
}));

const mongodb = require('mongodb');

const SECRET_A = 'secret-AAAA-0123456789abcdef-0123456789abcdef';
const SECRET_B = 'secret-BBBB-fedcba9876543210-fedcba9876543210';
const DAY = 24 * 3600 * 1000;

/** 用真 JwtService 签一个带 kid 的 token（与生产签发路径同款） */
function sign(secret: string, payload: any = { sub: 0, role: 'admin' }, withKid = true): string {
  const svc = new JwtService({ secret, signOptions: { expiresIn: 3600 } });
  return withKid ? svc.sign(payload, { keyid: kidOf(secret) }) : svc.sign(payload);
}

function verifies(token: string, secret: string): boolean {
  try {
    new JwtService({ secret: 'unused' }).verify(token, { secret });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  mongodb.MongoClient.docs = [{ type: 'jwt', value: { secret: SECRET_A } }];
  mongodb.MongoClient.calls = [];
  mongodb.MongoClient.tokenCount = 3;
  delete process.env[JWT_ROTATE_GRACE_DAYS_ENV];
  (global as any).jwtSecret = SECRET_A;
  __setJwtKeyStateForTest({ secret: SECRET_A, previous: null });
});

afterAll(() => {
  delete process.env[JWT_ROTATE_GRACE_DAYS_ENV];
  __setJwtKeyStateForTest(null);
  invalidateJwtSecretCache();
});

describe('kid：密钥的纯函数，不泄露密钥', () => {
  it('同一密钥恒定、不同密钥不同、16 位十六进制', () => {
    expect(kidOf(SECRET_A)).toBe(kidOf(SECRET_A));
    expect(kidOf(SECRET_A)).not.toBe(kidOf(SECRET_B));
    expect(kidOf(SECRET_A)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('kid 里不含密钥本体（它是公开的，会出现在每个 token 头里）', () => {
    expect(kidOf(SECRET_A)).not.toContain(SECRET_A.slice(0, 12));
    expect(SECRET_A.includes(kidOf(SECRET_A))).toBe(false);
  });
});

describe('宽限期解析：非法值回落到默认，不是 0', () => {
  it('默认 7 天', () => {
    expect(DEFAULT_JWT_ROTATE_GRACE_DAYS).toBe(7);
    expect(jwtRotateGraceMs({})).toBe(7 * DAY);
  });

  it('0 = 不留宽限（这是合法且有意的取值）', () => {
    expect(jwtRotateGraceMs({ [JWT_ROTATE_GRACE_DAYS_ENV]: '0' })).toBe(0);
  });

  it('⚠️ 负数/垃圾/空 ⇒ 回落默认，而不是 0（把"写错了"解释成"立刻踢掉所有人"是更坏的失败方向）', () => {
    for (const bad of ['-1', 'abc', '', '  ', 'NaN']) {
      expect(jwtRotateGraceMs({ [JWT_ROTATE_GRACE_DAYS_ENV]: bad })).toBe(7 * DAY);
    }
  });

  it('超过 365 天被夹住（旧密钥不该无限期可用）', () => {
    expect(jwtRotateGraceMs({ [JWT_ROTATE_GRACE_DAYS_ENV]: '99999' })).toBe(365 * DAY);
  });
});

describe('selectJwtVerifyKey：按 kid 选密钥，且绝不抛异常', () => {
  it('kid 指向当前密钥 ⇒ 当前密钥', () => {
    expect(selectJwtVerifyKey(sign(SECRET_A))).toBe(SECRET_A);
  });

  it('宽限期内：kid 指向上一个密钥 ⇒ 上一个密钥（旧令牌不掉线）', () => {
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: new Date(Date.now() - 1 * DAY).toISOString() },
    });
    const legacy = sign(SECRET_A);
    expect(selectJwtVerifyKey(legacy)).toBe(SECRET_A);
    expect(verifies(legacy, selectJwtVerifyKey(legacy))).toBe(true);
  });

  it('⚠️ 宽限期外：上一个密钥被丢弃 ⇒ 返回当前密钥（旧令牌验签失败，这是有意的）', () => {
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: new Date(Date.now() - 30 * DAY).toISOString() },
    });
    const legacy = sign(SECRET_A);
    expect(selectJwtVerifyKey(legacy)).toBe(SECRET_B);
    expect(verifies(legacy, selectJwtVerifyKey(legacy))).toBe(false);
    // 对照：新密钥签的照样能验
    const fresh = sign(SECRET_B);
    expect(verifies(fresh, selectJwtVerifyKey(fresh))).toBe(true);
  });

  it('⚠️ 没有 kid 的旧 token（本功能上线前签的）：宽限期内用 previous，否则用当前', () => {
    const legacyNoKid = sign(SECRET_A, { sub: 0 }, false);
    // 还没轮换过 ⇒ 用当前密钥（就是签它的那把）
    expect(selectJwtVerifyKey(legacyNoKid)).toBe(SECRET_A);
    expect(verifies(legacyNoKid, selectJwtVerifyKey(legacyNoKid))).toBe(true);

    // 轮换之后：它其实是"上一个密钥"签的，宽限期内必须仍然能验
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: new Date().toISOString() },
    });
    expect(selectJwtVerifyKey(legacyNoKid)).toBe(SECRET_A);
    expect(verifies(legacyNoKid, selectJwtVerifyKey(legacyNoKid))).toBe(true);

    // 宽限期外 ⇒ 失效
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: new Date(Date.now() - 30 * DAY).toISOString() },
    });
    expect(verifies(legacyNoKid, selectJwtVerifyKey(legacyNoKid))).toBe(false);
  });

  it('kid 指向一个已丢弃的密钥（连续轮换两次）⇒ 当前密钥，验签自然失败', () => {
    const oldToken = sign(SECRET_A);
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: 'secret-CCCC-ffffffffffffffff-ffffffffffffffff', rotatedAt: new Date().toISOString() },
    });
    const picked = selectJwtVerifyKey(oldToken);
    expect(picked).toBe(SECRET_B);
    expect(verifies(oldToken, picked)).toBe(false);
  });

  it('⚠️ 垃圾输入一律不抛（畸形 token 不能变成 500，也不能变成刷日志的路子）', () => {
    for (const junk of [undefined, null, '', 'not-a-jwt', '....', Buffer.alloc(8), 12345, {}]) {
      expect(() => selectJwtVerifyKey(junk)).not.toThrow();
      expect(selectJwtVerifyKey(junk)).toBe(SECRET_A);
    }
    // base64url 能解但 JSON 不合法
    const badHead = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(() => selectJwtVerifyKey(`${badHead}.payload.sig`)).not.toThrow();
  });

  it('内存态还没装载 ⇒ 回落 global.jwtSecret（启动早期不至于全员 401）', () => {
    __setJwtKeyStateForTest(null);
    (global as any).jwtSecret = SECRET_B;
    expect(selectJwtVerifyKey(sign(SECRET_B))).toBe(SECRET_B);
  });

  it('rotatedAt 读不出时间戳时**当作仍在宽限期内**（失败方向是"多留一会儿"，不是"踢掉所有人"）', () => {
    __setJwtKeyStateForTest({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: 'not-a-date' },
    });
    expect(selectJwtVerifyKey(sign(SECRET_A))).toBe(SECRET_A);
  });
});

describe('normalizeKeyState：老文档（只有 secret）也能用', () => {
  it('没有 previous 字段 ⇒ null，不是 undefined', () => {
    expect(normalizeKeyState({ secret: SECRET_A })).toEqual({ secret: SECRET_A, previous: null });
  });

  it('previous 缺 secret 或为空串 ⇒ 当成没有（半截数据不该被拿来验签）', () => {
    expect(normalizeKeyState({ secret: SECRET_A, previous: { rotatedAt: 'x' } }).previous).toBeNull();
    expect(normalizeKeyState({ secret: SECRET_A, previous: { secret: '' } }).previous).toBeNull();
  });

  it('形状全的照原样保留', () => {
    expect(normalizeKeyState({ secret: SECRET_B, previous: { secret: SECRET_A, rotatedAt: 'r' } })).toEqual({
      secret: SECRET_B,
      previous: { secret: SECRET_A, rotatedAt: 'r' },
    });
  });
});

describe('switchJwtSigningKey：金丝雀（钉住 @nestjs/jwt 的内部形状）', () => {
  it('真的能把签发密钥切过去（实测 @nestjs/jwt 11：options.secret 每次签发时都读）', () => {
    const svc = new JwtService({ secret: SECRET_A, signOptions: { expiresIn: 3600 } });
    const before = svc.sign({ sub: 0 });
    expect(verifies(before, SECRET_A)).toBe(true);

    expect(switchJwtSigningKey(svc, SECRET_B)).toBe(true);
    const after = svc.sign({ sub: 0 }, { keyid: kidOf(SECRET_B) });
    // ⚠️ 这两条是本函数存在的全部理由：切换后新 token 用新密钥、且不再用旧密钥
    expect(verifies(after, SECRET_B)).toBe(true);
    expect(verifies(after, SECRET_A)).toBe(false);
  });

  it('⚠️ 内部形状变了（升级 @nestjs/jwt）⇒ 返回 false，让调用方说"需要重启"，而不是静默签旧密钥', () => {
    expect(switchJwtSigningKey({}, SECRET_B)).toBe(false);
    expect(switchJwtSigningKey({ options: {} }, SECRET_B)).toBe(false);
    expect(switchJwtSigningKey({ options: { secret: 123 } }, SECRET_B)).toBe(false);
    expect(switchJwtSigningKey(undefined, SECRET_B)).toBe(false);
    expect(switchJwtSigningKey(null, SECRET_B)).toBe(false);
    // 对照：形状对的时候必须返回 true（否则上面几条恒真）
    expect(switchJwtSigningKey(new JwtService({ secret: SECRET_A }), SECRET_B)).toBe(true);
  });
});

describe('rotateJwtSecret：CAS 写入、宽限期、影响面', () => {
  it('轮换后库里是新密钥，旧密钥降级为 previous 并带 rotatedAt', async () => {
    const logs: string[] = [];
    const result = await rotateJwtSecret({
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    });
    const doc = mongodb.MongoClient.docs.find((d: any) => d.type === 'jwt');
    expect(doc.value.secret).not.toBe(SECRET_A);
    expect(doc.value.previous).toEqual({
      secret: SECRET_A,
      rotatedAt: result.rotatedAt,
      graceDays: DEFAULT_JWT_ROTATE_GRACE_DAYS,
    });
    expect(doc.value.rotatedAt).toBe(result.rotatedAt);
    expect(result.previousKid).toBe(kidOf(SECRET_A));
    expect(result.kid).toBe(kidOf(doc.value.secret));
    expect(result.graceDays).toBe(DEFAULT_JWT_ROTATE_GRACE_DAYS);
    // 影响面：API Token 条数（给站长在按下按钮前看影响）
    expect(result.apiTokensAffected).toBe(3);
    // 连接必须关掉（这个仓库为泄漏 MongoClient 栽过：每个都带连接池与 SDMA 定时器）
    expect(mongodb.MongoClient.calls).toContain('close');
    // ⚠️ 日志里只有 kid，绝不允许出现密钥本体
    expect(logs.join('\n')).not.toContain(doc.value.secret);
    expect(logs.join('\n')).not.toContain(SECRET_A);
    expect(logs.join('\n')).toContain(result.kid);
  });

  it('⚠️ 返回值里不含密钥本体（它会进 HTTP 响应，可能被后台日志/浏览器历史记录）', async () => {
    const result: any = await rotateJwtSecret({});
    const serialized = JSON.stringify(result);
    const doc = mongodb.MongoClient.docs.find((d: any) => d.type === 'jwt');
    expect(serialized).not.toContain(doc.value.secret);
    expect(serialized).not.toContain(SECRET_A);
    expect(Object.keys(result).sort()).toEqual(
      ['apiTokensAffected', 'graceDays', 'kid', 'previousKid', 'rotatedAt'].sort(),
    );
  });

  it('轮换后本进程立即用新密钥签发（onSigningKeySwitched 被调用）', async () => {
    const svc = new JwtService({ secret: SECRET_A, signOptions: { expiresIn: 3600 } });
    let switched: string | null = null;
    await rotateJwtSecret({ onSigningKeySwitched: (s) => { switched = s; switchJwtSigningKey(svc, s); } });
    expect(typeof switched).toBe('string');
    const token = svc.sign({ sub: 0 }, { keyid: kidOf(switched!) });
    expect(verifies(token, switched!)).toBe(true);
    expect(verifies(token, SECRET_A)).toBe(false);
  });

  it('⚠️ 轮换不会把在线用户踢下线：旧 token 在宽限期内仍然验得过', async () => {
    const oldToken = sign(SECRET_A);
    await rotateJwtSecret({});
    expect(verifies(oldToken, selectJwtVerifyKey(oldToken))).toBe(true);
    // 新签的也能验
    const doc = mongodb.MongoClient.docs.find((d: any) => d.type === 'jwt');
    const fresh = sign(doc.value.secret);
    expect(verifies(fresh, selectJwtVerifyKey(fresh))).toBe(true);
  });

  it('graceDays=0 ⇒ 旧密钥立即失效（站长明确要求"踢掉所有人"时的口子）', async () => {
    const oldToken = sign(SECRET_A);
    const result = await rotateJwtSecret({ graceDays: 0 });
    expect(result.graceDays).toBe(0);
    expect(verifies(oldToken, selectJwtVerifyKey(oldToken))).toBe(false);
  });

  it('graceDays 越界 ⇒ 夹到 0..365', async () => {
    expect((await rotateJwtSecret({ graceDays: -5 })).graceDays).toBe(0);
    // 重新装一次库（上一次轮换已经改过它）
    mongodb.MongoClient.docs = [{ type: 'jwt', value: { secret: SECRET_A } }];
    __setJwtKeyStateForTest({ secret: SECRET_A, previous: null });
    expect((await rotateJwtSecret({ graceDays: 99999 })).graceDays).toBe(365);
  });

  it('⚠️ CAS：密钥在**读取与写入之间**被另一个请求改掉 ⇒ 明确报错，且不覆盖对方的结果', async () => {
    // ⚠️ CAS 保护的是"读到写"这个窗口，不是"内存态与库不一致"（后者会重新读库，本来就该成功）。
    // 第一版把这个用例写成了后者，于是它恒过 —— 用钩子在 findOne 之后偷偷换掉库里的值，
    // 才能真正走到 CAS 未命中那条路。
    const interloper = 'someone-else-just-rotated-it-xxxxxx';
    mongodb.MongoClient.onAfterFindOne = () => {
      mongodb.MongoClient.docs = [{ type: 'jwt', value: { secret: interloper } }];
    };
    await expect(rotateJwtSecret({})).rejects.toThrow(/被另一个请求改动|CAS 未命中/);
    // 对方的密钥没有被我们覆盖掉（这是 CAS 的全部意义）
    expect(mongodb.MongoClient.docs[0].value.secret).toBe(interloper);
    expect(mongodb.MongoClient.docs[0].value.previous).toBeUndefined();
  });

  it('⚠️ 宽限期取自**当次轮换的记录**，不是现在的 env（改 env 不追溯影响已生效的宽限期）', async () => {
    // 轮换时定 0 天 ⇒ 旧密钥立即失效，即使 env 说 7 天
    process.env[JWT_ROTATE_GRACE_DAYS_ENV] = '7';
    const oldToken = sign(SECRET_A);
    await rotateJwtSecret({ graceDays: 0 });
    expect(verifies(oldToken, selectJwtVerifyKey(oldToken))).toBe(false);

    // 反过来：轮换时定 7 天，事后把 env 改成 0 也**不该**把人立刻踢下线
    mongodb.MongoClient.docs = [{ type: 'jwt', value: { secret: SECRET_A } }];
    __setJwtKeyStateForTest({ secret: SECRET_A, previous: null });
    const legacy = sign(SECRET_A);
    await rotateJwtSecret({ graceDays: 7 });
    process.env[JWT_ROTATE_GRACE_DAYS_ENV] = '0';
    expect(verifies(legacy, selectJwtVerifyKey(legacy))).toBe(true);
  });

  it('库里还没有 jwt 密钥（站点未初始化）⇒ 拒绝，且不插任何文档', async () => {
    mongodb.MongoClient.docs = [];
    await expect(rotateJwtSecret({})).rejects.toThrow(/还没有 JWT 密钥/);
    expect(mongodb.MongoClient.docs).toEqual([]);
  });

  it('数 API Token 失败不影响轮换结果（best-effort）', async () => {
    const real = mongodb.MongoClient.prototype.db;
    mongodb.MongoClient.prototype.db = function () {
      const db = real.call(this);
      const origCollection = db.collection;
      db.collection = (name: string) => {
        if (name === 'tokens') {
          return { countDocuments: async () => { throw new Error('mongo 抖了一下'); } } as any;
        }
        return origCollection(name);
      };
      return db;
    };
    try {
      const warns: string[] = [];
      const result = await rotateJwtSecret({ logger: { log: () => undefined, warn: (m) => warns.push(m) } });
      expect(result.apiTokensAffected).toBeNull();
      expect(result.kid).toMatch(/^[0-9a-f]{16}$/); // 轮换本身成功了
      expect(warns.join('\n')).toContain('数不出 API Token 条数');
    } finally {
      mongodb.MongoClient.prototype.db = real;
    }
  });
});
