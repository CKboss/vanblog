/**
 * `utils/revalidateSecret.ts` 的行为级守卫。
 *
 * 这个模块存在的唯一理由是修一个 **P0 回归**：一体式镜像默认没配
 * `VAN_BLOG_REVALIDATE_SECRET`，而前台 `/api/revalidate` 在没配密钥时只放行"回环直连"，
 * 那条判据在 Next 下**永远不成立**（`base-server.js:527-530` 会给每个请求补
 * `x-forwarded-for`）⇒ server 触发的每一次重渲染都 403、冷启动全量渲染全败、
 * `post/*.html` 产物 0 个。修法是让 server 自动生成一把密钥并下发给前台子进程。
 *
 * ⚠️ 因此本文件最重要的三条性质是：
 *   1. **两侧一致**：所有进程（cluster 主进程与各 worker）拿到的是**同一把**；
 *   2. **运维显式配置优先**，且绝不被自动生成的值覆盖；
 *   3. **拿不到密钥时失败关闭**（返回空串），绝不假装成功 ——
 *      假装成功的症状是"两侧密钥不一致 ⇒ 部分请求 401"，比 outright 失败难查得多。
 *
 * 🔴 还有一条纪律：**密钥绝不能出现在日志里**。有用例专门断言 WARN 文本不含密钥值。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureRevalidateSecret,
  ephemeralSecretPath,
  EPHEMERAL_SECRET_FILENAME,
  REVALIDATE_SECRET_ENV,
  resetRevalidateSecretCacheForTest,
} from './revalidateSecret';

const HEX64 = /^[0-9a-f]{64}$/;

let tmpDir: string;
let file: string;
const originalEnv = process.env[REVALIDATE_SECRET_ENV];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-revalidate-secret-'));
  file = path.join(tmpDir, EPHEMERAL_SECRET_FILENAME);
  delete process.env[REVALIDATE_SECRET_ENV];
  resetRevalidateSecretCacheForTest();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[REVALIDATE_SECRET_ENV];
  else process.env[REVALIDATE_SECRET_ENV] = originalEnv;
  resetRevalidateSecretCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('没配密钥：生成一把，并让所有进程读到同一把', () => {
  it('生成 64 位十六进制（32 字节随机），并落盘成 0600', () => {
    const secret = ensureRevalidateSecret({ file });
    expect(secret).toMatch(HEX64);
    expect(fs.readFileSync(file, 'utf8')).toBe(secret);
    // 0600：这份文件就是一把凭据，同机其它用户不该能读
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('🔴 值来自**文件**这个跨进程通道，而不是进程内存（cluster 一致性的依据）', () => {
    const first = ensureRevalidateSecret({ file });
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    // 清掉进程内缓存后重读，必须拿到同一把 ⇒ 证明第二次是**从文件**读的。
    // ⚠️ 这一步就是"另一个 worker 读到同一把"的等价证明：worker 与主进程之间
    //    唯一的共享通道就是这个文件，只要"无缓存时读文件"成立，任何进程读到的都相同。
    //    （没有去 spawn 真子进程：那需要一份编译产物，会把这条守卫绑到构建步骤上，
    //     而它要证明的性质只是"值来自文件"。真·多进程一致性属于活体验证的范围。）
    resetRevalidateSecretCacheForTest();
    expect(ensureRevalidateSecret({ file })).toBe(first);
    // 文件内容没被第二次调用改写（不是"又生成了一把"）
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('文件已存在时**采用**它，不覆盖（并发下谁先创建谁定值）', () => {
    const pre = 'a'.repeat(64);
    fs.writeFileSync(file, pre, { mode: 0o600 });
    expect(ensureRevalidateSecret({ file })).toBe(pre);
    expect(fs.readFileSync(file, 'utf8')).toBe(pre);
  });

  it('同进程内多次调用返回同一把（不会每次都生成新的）', () => {
    const a = ensureRevalidateSecret({ file });
    const b = ensureRevalidateSecret({ file });
    expect(a).toBe(b);
  });

  it('默认路径落在 os.tmpdir() 下、文件名固定（前台子进程与 server 靠它对齐）', () => {
    expect(ephemeralSecretPath()).toBe(path.join(os.tmpdir(), EPHEMERAL_SECRET_FILENAME));
    expect(EPHEMERAL_SECRET_FILENAME).toBe('vanblog-revalidate-secret');
  });
});

describe('运维显式配置：一律优先，且绝不被覆盖', () => {
  it('配了就用配的，**不生成文件**', () => {
    process.env[REVALIDATE_SECRET_ENV] = 'operator-configured-secret';
    expect(ensureRevalidateSecret({ file })).toBe('operator-configured-secret');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件里已有一把自动生成的值时，显式配置仍然胜出', () => {
    fs.writeFileSync(file, 'b'.repeat(64), { mode: 0o600 });
    process.env[REVALIDATE_SECRET_ENV] = 'operator-wins';
    expect(ensureRevalidateSecret({ file })).toBe('operator-wins');
    // 且不去动那个文件（避免把别的进程正在用的值改掉）
    expect(fs.readFileSync(file, 'utf8')).toBe('b'.repeat(64));
  });

  it('只含空白的值视为未配置（沿用本仓库对 env 的既有口径）', () => {
    process.env[REVALIDATE_SECRET_ENV] = '   ';
    const secret = ensureRevalidateSecret({ file });
    expect(secret).toMatch(HEX64);
  });
});

describe('🔴 拿不到密钥时失败关闭（返回空串，绝不假装成功）', () => {
  it('目标目录不可写 ⇒ 返回空串 + WARN，且不抛', () => {
    const readOnlyDir = path.join(tmpDir, 'nope', 'deeper');
    const bad = path.join(readOnlyDir, EPHEMERAL_SECRET_FILENAME);
    const warns: string[] = [];
    const secret = ensureRevalidateSecret({ file: bad, log: { warn: (m) => warns.push(m) } });
    expect(secret).toBe('');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(REVALIDATE_SECRET_ENV);
  });

  it('文件存在但内容不是合法密钥形状 ⇒ 空串 + WARN，且**不删掉重来**', () => {
    fs.writeFileSync(file, 'not-a-secret', { mode: 0o600 });
    const warns: string[] = [];
    const secret = ensureRevalidateSecret({ file, log: { warn: (m) => warns.push(m) } });
    expect(secret).toBe('');
    expect(warns).toHaveLength(1);
    // ⚠️ 不删：删掉会让其它已经采用旧值的进程与本进程分叉，症状是"部分 worker 401"
    expect(fs.readFileSync(file, 'utf8')).toBe('not-a-secret');
  });

  it('返回空串时**不缓存**，所以下一次调用还会再试（瞬时的只读挂载不该永久毒化进程）', () => {
    const bad = path.join(tmpDir, 'missing-dir', EPHEMERAL_SECRET_FILENAME);
    expect(ensureRevalidateSecret({ file: bad })).toBe('');
    // 换成可写的路径后应当能拿到值 ⇒ 证明空串没被缓存
    expect(ensureRevalidateSecret({ file })).toMatch(HEX64);
  });

  it('🔴 WARN 文本里**绝不包含密钥值**', () => {
    const secret = ensureRevalidateSecret({ file });
    expect(secret).toMatch(HEX64);
    // 制造一次告警：内容非法 ⇒ 走 WARN 分支
    resetRevalidateSecretCacheForTest();
    fs.writeFileSync(file, 'c'.repeat(64) + 'TRAILING-GARBAGE', { mode: 0o600 });
    const warns: string[] = [];
    ensureRevalidateSecret({ file, log: { warn: (m) => warns.push(m) } });
    expect(warns.length).toBeGreaterThan(0);
    for (const w of warns) {
      expect(w).not.toContain(secret);
      expect(w).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

describe('接线：server 与前台子进程必须用同一把', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');

  it('isr.provider 的 revalidate URL 用的是共用来源，而不是直接读 env', () => {
    const isr = read('src/provider/isr/isr.provider.ts');
    expect(isr).toMatch(/const secret = ensureRevalidateSecret\(\);/);
    expect(isr).toMatch(/params\.set\('secret', secret\)/);
    // ⚠️ 回归的原形状：直接读 env（默认没人配 ⇒ 不带 secret ⇒ 每次 403）
    expect(isr).not.toMatch(/const secret = process\.env\.VAN_BLOG_REVALIDATE_SECRET;/);
  });

  it('website.provider 把这把密钥交给前台子进程的 env', () => {
    const wp = read('src/provider/website/website.provider.ts');
    expect(wp).toMatch(/ensureRevalidateSecret\(/);
    expect(wp).toMatch(/\[REVALIDATE_SECRET_ENV\]: revalidateSecret/);
  });

  it('🔴 空串时**不注入**这个键（塞空值会把前台的判定搅乱）', () => {
    const wp = read('src/provider/website/website.provider.ts');
    expect(wp).toMatch(/revalidateSecret \? \{ \[REVALIDATE_SECRET_ENV\]: revalidateSecret \} : \{\}/);
  });

  it('🔴 密钥只会被发到**写死的回环地址**（它走 query string，绝不能流向别处）', () => {
    // 密钥是作为 ?secret= 传的，所以"发到哪"就是它的泄露面。地址在 buildRevalidateUrl 里
    // 是写死的 127.0.0.1:3001（不经 caddy，因此也不进 caddy 的访问日志）。
    // 这条钉住"写死"这件事本身：哪天有人把它改成可配置（例如按站点域名拼），
    // 密钥就会跟着走到公网/反代日志里去，而测试不会有任何其它地方变红。
    const isr = read('src/provider/isr/isr.provider.ts');
    expect(isr).toContain('http://127.0.0.1:3001/api/revalidate');
    // 且这个字面量不是从 env/配置拼出来的
    expect(isr).not.toMatch(/\$\{[^}]*\}\/api\/revalidate/);
  });

  it('401/403 的探活文案说的是**鉴权**问题，不再一律归因成数据库没就绪', () => {
    const isr = read('src/provider/isr/isr.provider.ts');
    expect(isr).toMatch(/probe\.status === 401 \|\| probe\.status === 403/);
    expect(isr).toContain('这是**鉴权**失败，不是数据库问题');
  });
});
