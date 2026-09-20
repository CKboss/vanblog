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
import { MIN_ACCOUNT_PASSWORD_LENGTH } from 'src/provider/user/user.provider';

/**
 * 环境变量自动初始化（VANBLOG_ADMIN_USER + VANBLOG_ADMIN_PASSWORD/_FILE）：
 * 部署期把"未初始化窗口"整个关掉的机制。这里钉住纯逻辑部分：
 *  - 三个变量的"意图"判定与凭据解析（_FILE 优先、secret-file 尾部换行契约、
 *    读不到文件时大声失败且**绝不静默回落**到内联变量）；
 *  - 浏览器派生口令公式与前端 encryptPwd / 服务端 washPassword **逐字节一致**
 *    （不一致的后果是"账号建好了但永远登不进来，且没有任何报错指向原因"）；
 *  - 校验策略：**复用**服务端的账号口令下限（`MIN_ACCOUNT_PASSWORD_LENGTH`），不发明第二套；
 *    这里拿到的是**原始口令**（不像后台表单那样已被浏览器 sha256 派生），所以判得了、也必须判。
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

/**
 * 账号口令最小长度：零接触初始化是**自动化路径**（compose / k8s / CI 里写死一个 env），
 * 恰恰最容易留下 `admin123` 这种弱口令，而建出来的是**管理员**账号。
 *
 * ⚠️ 为什么这里判得了、后台表单那边判不了：这里拿到的是 `VANBLOG_ADMIN_PASSWORD(_FILE)` 的
 * **原始口令**；后台表单发来的永远是 `encryptPwd` 派生后的 64 位十六进制摘要（长度与原始口令无关，
 * sha256 不可逆）。所以服务端只能在"直接收原始口令"的入口强制长度 —— 这就是其中一处。
 *
 * ⚠️ 拒绝走的是既有的 `ok:false` 通道，`init.provider.bootstrapFromEnv()` 对它已经大声 ERROR +
 * `done:false` + **不建号** + 不抛（见 init.install.spec.ts「凭据被拒」那条用例）。
 * 所以弱口令**不会**把容器打进崩溃循环：站点保持未初始化，站长仍可用向导手动完成安装。
 * 这条性质由那个用例负责，这里不重复（也不去改 init.provider —— 它不归本轮）。
 */
describe('resolveEnvCredentials：账号口令最小长度（原始口令判得了强度，就必须判）', () => {
  const MIN = MIN_ACCOUNT_PASSWORD_LENGTH;
  const repeated = (n: number) => 'a'.repeat(n);

  it('下限常量真的是 10（防止有人把它改成 1 之后，这一组用例全部"通过"却什么都没验）', () => {
    expect(MIN).toBe(10);
  });

  it('内联口令少 1 个字符 → 拒绝，文案点名变量、给出当前长度与下限、说明为什么', () => {
    const weak = repeated(MIN - 1);
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: weak });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_ADMIN_PASSWORD);
    expect(r.error).toContain(`当前 ${MIN - 1} 个字符`);
    expect(r.error).toContain(`${MIN} 个`);
    expect(r.error).toContain('弱口令');
    expect(r.error).not.toContain(weak); // ⚠️ 绝不回显口令本身（这段文案会进容器日志）
  });

  it('刚好等于下限 → 通过（边界不偏移）', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: repeated(MIN) });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(true);
    expect(r.creds?.password).toBe(repeated(MIN));
  });

  it('远长于下限 → 通过（这里不设上限：入库前会 sha256 派生成 64 位，长度不构成成本）', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: repeated(MIN + 90) });
    expect(resolveEnvCredentials().ok).toBe(true);
  });

  it('_FILE 同样受约束（不能靠"改用 secret 文件"绕过下限）', () => {
    const weak = repeated(MIN - 3);
    const file = writeSecret(weak);
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD_FILE]: file });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(ENV_ADMIN_PASSWORD_FILE);
    expect(r.error).toContain(file); // 点名文件路径，运维才知道去哪儿改
    expect(r.error).not.toContain(weak);
  });

  it('先按 secret-file 契约 trimEnd、**再**数长度（尾部换行不能拿来凑字数）', () => {
    // 9 个字符 + 一堆尾部空白：如果先数长度再 trim，就会误判成"够长"
    const file = writeSecret(`${repeated(MIN - 1)} \t\r\n`);
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD_FILE]: file });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`当前 ${MIN - 1} 个字符`);
  });

  it('trimEnd 之后刚好够长 → 通过，且存进去的是 trim 过的值', () => {
    const file = writeSecret(`${repeated(MIN)}\n`);
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD_FILE]: file });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(true);
    expect(r.creds?.password).toBe(repeated(MIN));
    expect(r.creds?.passwordSource).toBe('file');
  });

  /**
   * 计数口径必须与后台表单**一致**：async-validator 对字符串按码点计数
   * （先把代理对 `[\uD800-\uDBFF][\uDC00-\uDFFF]` 折叠成一个字符再取 length），
   * 所以这里用 `Array.from(...).length`。两边不一致的后果是"表单放行了、容器却起不来"
   * 或反过来，而且报错完全指不向原因。
   */
  it('按**码点**计数：5 个 emoji（UTF-16 长度正好 10）仍然被拒，报的是 5', () => {
    const emoji = '😀'.repeat(MIN / 2); // 5 个 emoji
    expect(emoji.length).toBe(MIN); // UTF-16 长度确实是 10 —— 用 .length 就会误放行
    expect(Array.from(emoji).length).toBe(MIN / 2);
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: emoji });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`当前 ${MIN / 2} 个字符`);
    expect(r.error).not.toContain(emoji);
  });

  it('按码点计数：10 个 emoji（UTF-16 长度 20）通过', () => {
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD]: '😀'.repeat(MIN) });
    expect(resolveEnvCredentials().ok).toBe(true);
  });

  it('口令太短时，仍然先报"没有密码来源"这类更根本的问题（判定顺序不被打乱）', () => {
    // 只有 USER、没有任何密码来源：应当报"没有密码来源"，而不是"口令太短"
    setEnv({ [ENV_ADMIN_USER]: 'owner' });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('密码来源');
    expect(r.error).not.toContain('太短');
  });

  it('空口令仍然走原来的"空的"文案（新的长度判定没有把既有分支吃掉）', () => {
    const file = writeSecret('\n');
    setEnv({ [ENV_ADMIN_USER]: 'owner', [ENV_ADMIN_PASSWORD_FILE]: file });
    const r = resolveEnvCredentials();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('空的');
    expect(r.error).not.toContain('太短');
  });
});
