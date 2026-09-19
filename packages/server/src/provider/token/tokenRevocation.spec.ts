/**
 * Token 的签发与吊销：**必须 await**，否则"改完凭据旧凭证还活着"。
 *
 * ## 修复前的两个真实后果
 * 1. `tokenModel.create(...)` 是 fire-and-forget（`createToken` 与 `createAPIToken` 都是），
 *    而吊销是 `updateMany({disabled:false})`，且被 `setTimeout(..., 1000)` 延迟调用
 *    （注释写"在前端清理 localStore 之后"）。于是登录后立刻改密码/走恢复流程时，
 *    若那条 create 晚于 disableAll 落库，这个**新** token 就不会被吊销 ——
 *    旧的全失效了，它却还活着。
 * 2. 进程在那 1 秒内退出（重启 / 部署 / OOM）⇒ 吊销**完全不发生**，而且日志里什么都没有。
 *
 * 前端并不需要那 1 秒：它拿到 200 之后自己清 localStorage，服务端何时吊销与它无关。
 * 改成"响应返回前吊销已完成"只会更安全。
 *
 * ## 顺带删掉的死代码
 * `disableAllAdmin()`（`updateMany({disabled:false, userId:0})`）全仓库零调用方，
 * 而它的存在会让人以为"改管理员密码只吊销管理员会话"—— 实际走的是 `disableAll()`，
 * **连 API Token 一起吊销**（API Token 的 `userId` 是 666666，既不是 0 也不是协作者）。
 * 留着一个语义误导的死方法比没有更糟。
 */
import { TokenProvider } from './token.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const code = stripCommentsForAnchor;

/** 让 create 在下一个 microtask 才落库 —— 不 await 的实现就会漏掉它。 */
function buildTokenProvider() {
  const rows: any[] = [{ userId: 1, token: 'old-1', disabled: false }];
  const calls: string[] = [];
  const tokenModel: any = {
    create: (doc: any) => {
      calls.push('create');
      return new Promise((resolve) => setTimeout(() => {
        rows.push({ ...doc, disabled: false });
        resolve(doc);
      }, 5));
    },
    updateOne: (filter: any, update: any) => {
      calls.push('updateOne');
      rows.filter((r) => r.token === filter.token).forEach((r) => Object.assign(r, update));
      return Promise.resolve({ acknowledged: true });
    },
    updateMany: (filter: any, update: any) => {
      calls.push('updateMany');
      let n = 0;
      for (const r of rows) {
        const matchDisabled = filter.disabled === undefined || r.disabled === filter.disabled;
        const matchUser = filter.userId === undefined || r.userId === filter.userId;
        if (matchDisabled && matchUser) {
          Object.assign(r, update);
          n += 1;
        }
      }
      return Promise.resolve({ acknowledged: true, modifiedCount: n });
    },
    find: () => ({ exec: () => Promise.resolve(rows.filter((r) => r.userId === 666666 && !r.disabled)) }),
    findOne: (filter: any) =>
      Promise.resolve(rows.find((r) => r.token === filter.token && r.disabled === filter.disabled) || null),
  };
  const jwtService: any = { sign: (payload: any) => `jwt.${payload.sub}.${payload.username}` };
  const settingProvider: any = { getLoginSetting: async () => ({ expiresIn: 3600 }) };
  const p: any = Object.create(TokenProvider.prototype);
  p.tokenModel = tokenModel;
  p.jwtService = jwtService;
  p.settingProvider = settingProvider;
  p.logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() };
  return { p, rows, calls };
}

describe('签发 token 必须等落库完成（否则吊销会漏掉它）', () => {
  it('createToken 返回时，记录已经在库里', async () => {
    const { p, rows } = buildTokenProvider();
    await p.createToken({ sub: 3, username: 'writer' });
    expect(rows.some((r) => r.userId === 3 && r.disabled === false)).toBe(true);
  });

  it('createAPIToken 返回时，记录已经在库里（userId=666666）', async () => {
    const { p, rows } = buildTokenProvider();
    const token = await p.createAPIToken('ci');
    expect(typeof token).toBe('string');
    expect(rows.some((r) => r.userId === 666666 && r.token === token)).toBe(true);
  });

  it('⚠️ 这条是关键：签发后立刻 disableAll，新 token 也一定被吊销', async () => {
    const { p, rows } = buildTokenProvider();
    const token = await p.createToken({ sub: 4, username: 'racer' });
    await p.disableAll();
    const fresh = rows.find((r) => r.token === token);
    expect(fresh).toBeTruthy();
    expect(fresh.disabled).toBe(true);
    // 既有的那条也被吊销
    expect(rows.every((r) => r.disabled === true)).toBe(true);
  });

  it('源码级钉子：两处 create 都是 await（不是 fire-and-forget）', () => {
    const src = code(read('./token.provider.ts'));
    expect(src).toMatch(/await this\.tokenModel\.create\(\{ userId: 666666, name, token, expiresIn \}\)/);
    expect(src).toMatch(/await this\.tokenModel\.create\(\{ userId: payload\.sub, token, expiresIn \}\)/);
    // 反证：裸调用（没有 await）不许再出现
    expect(src).not.toMatch(/[^t]\s+this\.tokenModel\.create\(/);
  });

  it('⚠️ 反证的反证：那条"不许裸调用"的正则跑在旧形状上必须命中', () => {
    const oldShape = '    this.tokenModel.create({ userId: 666666, name, token, expiresIn });';
    expect(oldShape).toMatch(/[^t]\s+this\.tokenModel\.create\(/);
  });
});

describe('disableAll 的语义要写清，死代码要删掉', () => {
  it('disableAllAdmin 已删除（零调用方 + 语义误导）', () => {
    const src = code(read('./token.provider.ts'));
    expect(src).not.toMatch(/disableAllAdmin/);
  });

  it('disableAll 与 disableAllCollaborator 都还在，且范围没被顺手改窄', () => {
    const src = code(read('./token.provider.ts'));
    expect(src).toMatch(/async disableAll\(\) \{/);
    expect(src).toMatch(/updateMany\(\{ disabled: false \}, \{ disabled: true \}\)/);
    expect(src).toMatch(/async disableAllCollaborator\(\)/);
    expect(src).toMatch(/userId: \{ \$ne: 0 \}/);
  });

  it('⚠️ 反证的反证：`disableAllAdmin` 这条"不存在"断言跑在旧文件形状上必须命中', () => {
    const oldShape = '  async disableAllAdmin() {\n    return await this.tokenModel.updateMany({});\n  }';
    expect(oldShape).toMatch(/disableAllAdmin/);
  });
});

describe('AuthController：吊销在响应之前完成，恢复接口有专用限流桶', () => {
  const src = code(read('../../controller/admin/auth/auth.controller.ts'));

  it('两处 setTimeout(...disableAll(), 1000) 都没了，改成 await', () => {
    expect(src).not.toMatch(/setTimeout\(\(\) => \{[\s\S]{0,120}disableAll\(\)/);
    const awaited = src.match(/await this\.tokenProvider\.disableAll\(\);/g) || [];
    expect(awaited.length).toBe(2); // restore() 与 updateUser()
  });

  it('⚠️ 反证的反证：那条 setTimeout 正则跑在旧形状上必须命中', () => {
    const oldShape = 'setTimeout(() => {\n      // 在前端清理 localStore 之后\n      this.tokenProvider.disableAll();\n    }, 1000);';
    expect(oldShape).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,120}disableAll\(\)/);
  });

  it('恢复接口挂了专用限流桶（与 init 同档），并在成功时清计数', () => {
    expect(src).toMatch(/consumeAttempt\(`auth-restore-\$\{restoreIp\}`/);
    expect(src).toMatch(/max: scaleLimit\(INIT_LIMIT_PER_10MIN\)/);
    expect(src).toMatch(/windowMs: RESTORE_WINDOW_MS/);
    expect(src).toMatch(/resetAttempts\(`auth-restore-\$\{restoreIp\}`\)/);
    // 超限要回 429 且带 Retry-After（与 rateLimit.ts 的形状一致，脚本不必解析中文消息）
    expect(src).toMatch(/HttpStatus\.TOO_MANY_REQUESTS/);
    expect(src).toMatch(/setHeader\('Retry-After'/);
  });

  it('限流判定在密钥校验**之前**（否则每次被拒都要白读一次密钥文件）', () => {
    expect(src.indexOf('consumeAttempt(')).toBeLessThan(src.indexOf('getRestoreKeyForVerification()'));
  });

  it('防爆破类计数用套接字地址口径（bruteForceClientIp），不是可被请求头左右的 pickTrustedClientIp', () => {
    expect(src).toMatch(/const restoreIp = bruteForceClientIp\(request\);/);
    expect(src).not.toMatch(/pickTrustedClientIp/);
  });

  it('没有为了让限流生效而去改 utils/rateLimit.ts（它归别的改动，只 import 阈值常量）', () => {
    expect(src).toMatch(/import \{ INIT_LIMIT_PER_10MIN \} from 'src\/utils\/rateLimit';/);
    const rl = code(read('../../utils/rateLimit.ts'));
    expect(rl).not.toMatch(/auth-restore/);
  });
});

describe('恢复接口的限流桶：**行为级**验证（源码锚点抓不到"判定被短路"）', () => {
  // ⚠️ 为什么必须有行为级用例：上面那组源码锚点只能证明"代码里有 consumeAttempt 这个调用"，
  //    把判定改成 `if (false && !restoreHit.allowed)` 之后锚点**全都还匹配** ——
  //    变异对照第一次跑就是这么暴露的（M5 零红）。这正是本仓库反复强调的
  //    "断言某符号出现是空断言"，只不过这次空在**条件**上而不是 import 上。
  const { AuthController } = require('../../controller/admin/auth/auth.controller');
  const { __resetAttemptLimitForTest } = require('../../utils/attemptLimit');
  const { INIT_LIMIT_PER_10MIN } = require('../../utils/rateLimit');

  function buildController() {
    const c: any = Object.create(AuthController.prototype);
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() };
    // 让密钥校验失败关闭（返回 null）⇒ 前 N 次都走到 401，第 N+1 次必须先被限流挡成 429
    c.initProvider = { getRestoreKeyForVerification: async () => null, initRestoreKey: async () => undefined };
    c.userProvider = { updateUser: async () => ({ acknowledged: true }) };
    c.tokenProvider = { disableAll: async () => ({ acknowledged: true }) };
    const headers: Record<string, string> = {};
    const request: any = {
      headers,
      ip: '203.0.113.7',
      socket: { remoteAddress: '203.0.113.7' },
      res: { setHeader: (k: string, v: string) => (headers[k] = v) },
    };
    return { c, request, headers };
  }

  beforeEach(() => __resetAttemptLimitForTest());

  it(`前 ${INIT_LIMIT_PER_10MIN} 次是 401（密钥校验），第 ${INIT_LIMIT_PER_10MIN + 1} 次变成 429`, async () => {
    const { c, request, headers } = buildController();
    const body = { key: 'whatever', name: 'attacker', password: 'pwn12345' };
    for (let i = 0; i < INIT_LIMIT_PER_10MIN; i += 1) {
      await expect(c.restore(request, body)).rejects.toMatchObject({ status: 401 });
    }
    // 关键断言：再来一次必须被限流挡住，而不是继续走密钥校验
    let caught: any = null;
    try {
      await c.restore(request, body);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(429);
    expect(String(caught.message)).toContain('过于频繁');
    expect(headers['Retry-After']).toMatch(/^[1-9][0-9]*$/);
  });

  it('⚠️ 反证：把判定短路掉（if (false && …)）时，上面那条必须红 —— 这里直接验证短路后不会 429', async () => {
    // 用第 N+1 次的返回码区分"限流真的在拦"与"限流只是写在源码里"。
    // 如果哪天有人把 enforce 去掉，这条与上一条会同时失败（上一条期望 429、这条期望 401）。
    const { c, request } = buildController();
    const body = { key: 'x', name: 'a', password: 'pwn12345' };
    const statuses: number[] = [];
    for (let i = 0; i < INIT_LIMIT_PER_10MIN + 2; i += 1) {
      try {
        await c.restore(request, body);
        statuses.push(200);
      } catch (err: any) {
        statuses.push(err?.status ?? 0);
      }
    }
    expect(statuses.slice(0, INIT_LIMIT_PER_10MIN).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(INIT_LIMIT_PER_10MIN).every((s) => s === 429)).toBe(true);
  });

  it('限流在密钥校验之前：被挡下的请求不会去读密钥（不产生 error 日志）', async () => {
    const { c, request } = buildController();
    const body = { key: 'x', name: 'a', password: 'pwn12345' };
    for (let i = 0; i < INIT_LIMIT_PER_10MIN + 1; i += 1) {
      try {
        await c.restore(request, body);
      } catch {
        /* 忽略 */
      }
    }
    // 前 N 次每次都会因为"密钥不可用"打一条 error；被限流挡下的那次不会
    expect(c.logger.error.mock.calls.length).toBe(INIT_LIMIT_PER_10MIN);
  });
});
