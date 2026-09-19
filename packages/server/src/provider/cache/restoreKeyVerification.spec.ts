/**
 * 「忘记密码」恢复密钥校验的回归钉子。
 *
 * ## 这里曾经是一个**未认证的管理员接管**漏洞
 *
 * 旧代码（`controller/admin/auth/auth.controller.ts` 的 `POST /api/admin/auth/restore`）：
 *
 *     const keyInCache = await this.cacheProvider.get('restoreKey');
 *     if (!token || token != keyInCache) throw new UnauthorizedException(…);
 *
 * 两个各自无害的细节凑在一起：
 *  1. `CacheProvider.get()` 在键**缺失**时返回 `{}`（不是 undefined）；
 *  2. 用的是松散不等 `!=`。
 *
 * JS 里 `"[object Object]" != {}` 的结果是 **false** —— 对象先被转成原始值 `"[object Object]"`
 * 再与字符串比 —— 于是"缓存里没有恢复密钥"这个状态**等于校验通过**。
 * 攻击者只要 POST `{"key":"[object Object]","name":"attacker","password":"…"}`
 * 就能改写 `id:0` 管理员的用户名与口令（旧 token 随后被 `disableAll()` 吊销，
 * 攻击者用新口令登录 ⇒ 签超管 API Token / 下载整站备份 / 跑流水线执行代码）。
 *
 * 而"键缺失"不是假设：`initRestoreKey()` 只在主实例跑（`main.ts` 的 `isPrimaryInstance`），
 * `CacheProvider.data` 是每进程一份 ⇒ `VANBLOG_CLUSTER_WORKERS>1` 时**每个 worker 上都可绕**。
 * 那是文档化的旋钮（auto/cpus/max/N），不是奇特配置。
 */
import { CacheProvider } from './cache.provider';
import { safeEqual } from 'src/utils/crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('CacheProvider.getString（凭据类取值必须失败关闭）', () => {
  const make = (value: unknown) => {
    const c = new CacheProvider();
    if (value !== undefined) c.set('k', value);
    return c;
  };

  it('键缺失时返回 null，而不是 {}（这正是旧漏洞的源头）', () => {
    expect(make(undefined).getString('k')).toBeNull();
    // 对照：旧的 get() 仍然返回 {}（login.guard 的窗口逻辑依赖它，所以没改语义）
    expect(make(undefined).get('k')).toEqual({});
  });

  it('非字符串一律 null', () => {
    for (const v of [{}, [], 0, 1, true, null, NaN, () => 'x', Symbol('s') as unknown]) {
      expect(make(v).getString('k')).toBeNull();
    }
  });

  it('太短的字符串也 null（默认下限 32；恢复密钥是 32 字节 base64 = 44 字符）', () => {
    expect(make('a'.repeat(31)).getString('k')).toBeNull();
    expect(make('a'.repeat(32)).getString('k')).toBe('a'.repeat(32));
    expect(make('abc').getString('k', 3)).toBe('abc');
  });

  it('去掉首尾空白后返回（文件读出来的密钥常带换行）', () => {
    expect(make('  ' + 'k'.repeat(40) + '\n').getString('k')).toBe('k'.repeat(40));
  });
});

describe('那个 JS 语义陷阱本身（防止有人"顺手改回去"）', () => {
  it('"[object Object]" != {} 是 false —— 松散比较会把空对象当成匹配', () => {
    // ⚠️ 这条断言记录的是**语言行为**，不是我们的产品行为：
    //    只要它还是 false，任何 `token != someCacheValue` 的写法都是可绕过的。
    // eslint-disable-next-line eqeqeq
    expect('[object Object]' != ({} as unknown)).toBe(false); // ← 旧代码就是这样被绕过的
    // ⚠️ 注意：`safeEqual` **也**会把两边 String() 化，所以它同样认为
    //    "[object Object]" 与 {} 相等 —— 换成常量时间比较**并不足以**修好这个洞。
    //    真正的修复是"先确认拿到的是字符串密钥，否则失败关闭"，见下面 getRestoreKeyForVerification。
    expect(safeEqual('[object Object]', {})).toBe(true);
    expect(safeEqual('[object Object]', '')).toBe(false);
    expect(typeof ({} as unknown) === 'string').toBe(false); // ← 所以类型检查是不可省的那一环
  });

  it('safeEqual 对真密钥仍然正常工作（长度不同直接 false，相同则常量时间比较）', () => {
    const key = 'A'.repeat(44);
    expect(safeEqual(key, key)).toBe(true);
    expect(safeEqual(key, 'A'.repeat(43) + 'B')).toBe(false);
    expect(safeEqual('', '')).toBe(true); // 空对空相等 ⇒ 所以调用方必须先挡掉"没有密钥"
  });
});

describe('InitProvider.getRestoreKeyForVerification（内存没有就回落文件，都没有就 null）', () => {
  // 只构造这个方法需要的最小依赖，避免拉起整个 Nest 容器
  const buildProvider = (logDir: string) => {
    const cache = new CacheProvider();
    const logger = { log() {}, warn() {}, error() {}, debug() {}, verbose() {} };
    // ⚠️ 不要 `new InitProvider()`：它的构造器有一串 @InjectModel 与 provider 依赖，
    //    在单元测试里拉不起来。这里只测一个方法，所以用原型造一个壳、把需要的两个依赖塞进去。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { InitProvider } = require('../init/init.provider');
    const p = Object.create(InitProvider.prototype);
    p.cacheProvider = cache;
    p.logger = logger;
    return { p, cache };
  };

  let dir: string;
  let oldLog: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restorekey-'));
    oldLog = process.env.VAN_BLOG_LOG;
    process.env.VAN_BLOG_LOG = dir;
    jest.resetModules();
  });
  afterEach(() => {
    if (oldLog === undefined) delete process.env.VAN_BLOG_LOG;
    else process.env.VAN_BLOG_LOG = oldLog;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('内存里有 ⇒ 直接返回，不读盘', async () => {
    const { p, cache } = buildProvider(dir);
    cache.set('restoreKey', 'M'.repeat(44));
    fs.writeFileSync(path.join(dir, 'restore.key'), 'F'.repeat(44));
    await expect(p.getRestoreKeyForVerification()).resolves.toBe('M'.repeat(44));
  });

  it('内存里没有、文件里有 ⇒ 读文件并回填缓存（cluster 的 worker 走这条）', async () => {
    const { p, cache } = buildProvider(dir);
    fs.writeFileSync(path.join(dir, 'restore.key'), 'F'.repeat(44) + '\n');
    await expect(p.getRestoreKeyForVerification()).resolves.toBe('F'.repeat(44));
    expect(cache.getString('restoreKey')).toBe('F'.repeat(44));
  });

  it('内存与文件都没有 ⇒ null（调用方必须失败关闭，绝不"当作空密钥继续比"）', async () => {
    const { p } = buildProvider(dir);
    await expect(p.getRestoreKeyForVerification()).resolves.toBeNull();
  });

  it('文件里是个太短/畸形的值 ⇒ 仍然 null（不会被当成密钥用）', async () => {
    const { p } = buildProvider(dir);
    fs.writeFileSync(path.join(dir, 'restore.key'), 'short');
    await expect(p.getRestoreKeyForVerification()).resolves.toBeNull();
  });

  it('⚠️ 回归钉子：缓存里被塞进 {} 时（旧 get() 的返回值形状）绝不返回可用密钥', async () => {
    const { p, cache } = buildProvider(dir);
    cache.set('restoreKey', {} as unknown);
    await expect(p.getRestoreKeyForVerification()).resolves.toBeNull();
  });
});
