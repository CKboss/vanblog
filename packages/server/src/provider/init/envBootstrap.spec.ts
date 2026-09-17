import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ENV_ADMIN_PASSWORD,
  ENV_ADMIN_PASSWORD_FILE,
  ENV_ADMIN_USER,
  deriveBrowserPassword,
  envBootstrapRequested,
  minimalSiteInfo,
  resolveEnvCredentials,
} from './envBootstrap';
import { encryptPassword, hashSecret, verifyUserPassword, washPassword } from 'src/utils/crypto';
import { makeSalt } from 'src/utils/crypto';

/**
 * 环境变量自动初始化（VANBLOG_ADMIN_USER + VANBLOG_ADMIN_PASSWORD/_FILE）：
 * 部署期把"未初始化窗口"整个关掉的机制。这里钉住纯逻辑部分：
 *  - 三个变量的"意图"判定与凭据解析（_FILE 优先、secret-file 尾部换行契约、
 *    读不到文件时大声失败且**绝不静默回落**到内联变量）；
 *  - 浏览器派生口令公式与前端 encryptPwd / 服务端 washPassword **逐字节一致**
 *    （不一致的后果是"账号建好了但永远登不进来，且没有任何报错指向原因"）；
 *  - 校验策略 = 向导已经允许的下限（缺失/空白拒绝），**不发明第二套密码策略**。
 *
 * ⚠️ 密码值一律用测试夹具（'fixture-secret-…'），不是任何真实凭据。
 */

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const name of [ENV_ADMIN_USER, ENV_ADMIN_PASSWORD, ENV_ADMIN_PASSWORD_FILE]) {
    savedEnv[name] = process.env[name];
    if (vars[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = vars[name] as string;
    }
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-envboot-'));
});

afterEach(() => {
  for (const name of [ENV_ADMIN_USER, ENV_ADMIN_PASSWORD, ENV_ADMIN_PASSWORD_FILE]) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSecret(content: string, name = 'admin-password'): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

describe('envBootstrapRequested：操作者有没有表达"要自动初始化"的意图', () => {
  it('三个变量都没设（或只有空白）→ false（特性完全不存在，启动路径零改动）', () => {
    setEnv({});
    expect(envBootstrapRequested()).toBe(false);
    setEnv({ [ENV_ADMIN_USER]: '   ' });
    expect(envBootstrapRequested()).toBe(false);
  });

  it('任何一个非空白 → true（哪怕只有密码没有用户名：也要走"大声拒绝"而不是静默忽略）', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner' });
    expect(envBootstrapRequested()).toBe(true);
    setEnv({ [ENV_ADMIN_PASSWORD]: 'x' });
    expect(envBootstrapRequested()).toBe(true);
    setEnv({ [ENV_ADMIN_PASSWORD_FILE]: '/run/secrets/x' });
    expect(envBootstrapRequested()).toBe(true);
  });
});

describe('resolveEnvCredentials：解析与校验', () => {
  it('USER + 内联 PASSWORD → ok，密码按字面字节使用（内联值不做 trim）', () => {
    setEnv({ [ENV_ADMIN_USER]: ' owner ', [ENV_ADMIN_PASSWORD]: 'fixture-secret-1 ' });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(true);
    expect(r.creds?.username).toBe('owner'); // 用户名 trim
    expect(r.creds?.password).toBe('fixture-secret-1 '); // 密码不 trim（env 是字面值）
    expect(r.creds?.passwordSource).toBe('inline');
  });

  it('PASSWORD_FILE 优先于内联 PASSWORD，内容按 secret-file 契约去掉尾部换行/空白', () => {
    const file = writeSecret('fixture-secret-file\r\n');
    setEnv({
      [ENV_ADMIN_USER]: 'owner',
      [ENV_ADMIN_PASSWORD]: 'fixture-secret-inline',
      [ENV_ADMIN_PASSWORD_FILE]: file,
    });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(true);
    expect(r.creds?.password).toBe('fixture-secret-file'); // 不是内联值，也没有 \r\n
    expect(r.creds?.passwordSource).toBe('file');
  });

  it('PASSWORD_FILE 读不到 → 大声失败，错误信息点名文件路径，且**不会**静默回落到内联变量', () => {
    setEnv({
      [ENV_ADMIN_USER]: 'owner',
      [ENV_ADMIN_PASSWORD]: 'fixture-secret-inline',
      [ENV_ADMIN_PASSWORD_FILE]: path.join(tmp, 'missing-secret'),
    });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_ADMIN_PASSWORD_FILE);
    expect(r.error).toContain('missing-secret');
    expect(r.error).toContain('不会'); // 明说不回落
    expect(r.error).not.toContain('fixture-secret-inline'); // 错误信息里也不许出现任何密码值
  });

  it('文件内容 trim 完是空的（只有换行）→ 拒绝：空密码初始化 = 谁都登不进来或谁都登得进来', () => {
    const file = writeSecret('\n');
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD_FILE]: file });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('空的');
  });

  it('只有 USER 没有任何密码来源 → 拒绝并指路（_FILE 推荐）', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner' });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_ADMIN_PASSWORD_FILE);
    expect(r.error).toContain(ENV_ADMIN_PASSWORD);
  });

  it('只有密码没有 USER → 拒绝（用户名是登录身份，不能猜）', () => {
    setEnv({ [ENV_ADMIN_PASSWORD]: 'fixture-secret-2' });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_ADMIN_USER);
  });

  it('内联 PASSWORD 是空串且没有 _FILE → 拒绝', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: '' });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('密码来源');
  });
});

describe('deriveBrowserPassword：与前端 encryptPwd / 服务端 washPassword 逐字节一致', () => {
  // 前端 packages/admin/src/services/van-blog/encryptPwd.js 的公式（固定向量）：
  //   sha256(lower(u) + sha256(sha256(sha256(sha256(p))) + sha256(lower(u))))
  it('固定向量与前端公式一致（大小写用户名归一）', () => {
    const { sha256 } = require('js-sha256');
    const u = 'Owner@Example';
    const p = 'fixture-secret-3';
    const lower = u.toLowerCase();
    const expectValue = sha256(
      lower + sha256(sha256(sha256(sha256(p))) + sha256(lower)),
    );
    expect(deriveBrowserPassword(u, p)).toBe(expectValue);
    expect(deriveBrowserPassword(u.toLowerCase(), p)).toBe(expectValue);
  });

  it('与 crypto.ts 的 washPassword 内部派生对拍（washPassword = encryptPassword(u, 派生值, salt)）', () => {
    const u = 'jiangoil-fixture';
    const p = 'fixture-secret-4';
    const salt = makeSalt();
    // washPassword 是仓库里既有的"原始密码 → 旧存储格式"完整链路；
    // 用同一个 salt 走 encryptPassword(u, deriveBrowserPassword(u,p), salt) 必须逐字节相同 ——
    // 公式一旦漂移这条立刻红（crypto.ts 本轮禁改，这是唯一的安全网）
    expect(encryptPassword(u, deriveBrowserPassword(u, p), salt)).toBe(washPassword(u, p, salt));
  });

  it('端到端语义：按 init() 的存储方式（scrypt over 派生值）建号后，登录校验必须通过', () => {
    const u = 'FixtureOwner';
    const p = 'fixture-secret-5';
    const stored = hashSecret(deriveBrowserPassword(u, p)); // init.provider.init() 就是这么存的
    // 登录时浏览器发来的就是 deriveBrowserPassword 的值（verifyUserPassword 的 browserPassword 参数）
    expect(verifyUserPassword(stored, u, deriveBrowserPassword(u, p), 'unused-salt')).toBe(true);
    // 直接拿 env 原始密码登录必须失败 —— 这就是"不派生 = 永远登不进来"的证明
    expect(verifyUserPassword(stored, u, p, 'unused-salt')).toBe(false);
  });
});

describe('minimalSiteInfo：env 引导的最小站点记录', () => {
  it('带站名/作者，不带 since（init() 会补 new Date()），baseUrl 留空（上线后到后台补）', () => {
    const info: any = minimalSiteInfo('owner');
    expect(info.siteName).toBe('VanBlog');
    expect(info.author).toBe('owner');
    expect(info.baseUrl).toBe('');
    expect(info.since).toBeUndefined();
  });
});
