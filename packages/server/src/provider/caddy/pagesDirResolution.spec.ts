/**
 * `VANBLOG_CADDY_HTML_PAGES_DIR` 三个调用点的**行为**守卫。
 *
 * 取值层面的跨语言一致性在 `pagesDirParity.spec.ts`（真跑 TS 与生成器两侧比对），
 * 这里只管一件事：**三个调用点各自拿到解析结果之后做了什么**，尤其是两个有破坏性/静默失效
 * 后果的方向：
 *   - `artifactReaper` 用这个目录**删文件** ⇒ 合法值必须**原样生效**（回落默认会删错目录，
 *     让"caddy 直服的产物"与"被清理的产物"不是同一批 ⇒ 已删/转私密的文章继续被公开服务）；
 *     非法值必须回落默认（修复前 `/` 会让它去扫**文件系统根**下的 post/ page/ category/ tag/）。
 *   - `CaddyProvider` 每 60 秒对账一次 ⇒ 配错的变量**不能每分钟刷一条 WARN**
 *     （日志有 20MB×3 轮转上限，攻击期间真正有用的信息会被冲走），但**改成另一个非法值**
 *     必须再打一条（那正是需要看见的时刻）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CADDY_SERVE_HTML_SENTINEL,
  CaddyProvider,
  DEFAULT_WEBSITE_PAGES_DIR,
  SERVE_HTML_ENV_FLAG,
  SERVE_HTML_PAGES_DIR_ENV,
  resolveWebsitePagesDir,
} from './caddy.provider';
import {
  resolveServeHtmlSentinelDir,
  snapshotServeHtmlSentinels,
} from 'src/utils/degradedServeHtml';
import { reaperPagesDir } from 'src/provider/isr/artifactReaper';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-pages-dir-'));
}

const ENV_KEYS = [SERVE_HTML_PAGES_DIR_ENV, SERVE_HTML_ENV_FLAG] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeProvider(isr: unknown = { mode: 'onDemand' }) {
  const settingProvider = {
    getHttpsSetting: jest.fn().mockReturnValue(new Promise(() => undefined)),
    getISRSetting: jest.fn().mockResolvedValue(isr),
  };
  const provider = new CaddyProvider(settingProvider as any);
  const warn = jest.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
  jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
  return { provider, warn };
}

/** 只挑出与"产物目录"有关的 WARN（对账还会打别的 warn，不能混在一起数）。 */
function pagesDirWarns(warn: jest.SpyInstance): string[] {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes(SERVE_HTML_PAGES_DIR_ENV));
}

describe('resolveWebsitePagesDir：每条拒绝规则都给出理由，且理由点名后果', () => {
  it.each([
    ['control-chars', '/ok\r\nx'],
    ['braces', '/{env.HOME}/x'],
    ['not-absolute', 'relative/x'],
    ['dot-dot', '/a/../b'],
    ['filesystem-root', '/'],
  ])('%s ⇒ rejected + dir 回落默认 + reason 非空', (rule, raw) => {
    const r = resolveWebsitePagesDir(raw);
    expect({ rule: r.rule, rejected: r.rejected, dir: r.dir }).toEqual({
      rule,
      rejected: true,
      dir: DEFAULT_WEBSITE_PAGES_DIR,
    });
    expect(typeof r.reason).toBe('string');
    expect((r.reason as string).length).toBeGreaterThan(10);
    // WARN 必须点名后果与出路，不能只说"非法"
    const text = r.warns.join('\n');
    expect(text).toContain('已被忽略');
    expect(text).toContain(DEFAULT_WEBSITE_PAGES_DIR);
    expect(text).toContain('取消该环境变量');
  });

  it('🔴 拒绝文案不许再声称"服务端仍会写到你给的路径"（修复后两侧都回落默认，那句话是假的）', () => {
    for (const raw of ['relative/x', '/', '/a/../b', '/{env.X}']) {
      expect(resolveWebsitePagesDir(raw).warns.join('\n')).not.toContain('仍会把哨兵');
    }
  });
});

describe('CaddyProvider：配错的变量不能每分钟刷屏，但换一个非法值必须再说一次', () => {
  it('同一个非法值连续对账 3 次 ⇒ 只打 1 条 WARN', async () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/pages';
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider, warn } = makeProvider();
    for (let i = 0; i < 3; i += 1) await provider.reconcileServeHtml();
    expect(pagesDirWarns(warn).length).toBe(1);
  });

  it('改成**另一个**非法值 ⇒ 再打一条（去重按值，不是按"打过没有"）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider, warn } = makeProvider();
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/a';
    await provider.reconcileServeHtml();
    process.env[SERVE_HTML_PAGES_DIR_ENV] = '/a/../b';
    await provider.reconcileServeHtml();
    const msgs = pagesDirWarns(warn);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toContain('relative/a');
    expect(msgs[1]).toContain('/a/../b');
  });

  it('⚠️ WARN 不是"静默回落"：它必须说清回落到了哪个目录（与 caddy 侧一致）', async () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/pages';
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider, warn } = makeProvider();
    await provider.reconcileServeHtml();
    expect(pagesDirWarns(warn).join('\n')).toContain(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('合法值 ⇒ 一条 WARN 都不打（正常配置不该被噪音淹没）', async () => {
    const d = tmpDir();
    try {
      process.env[SERVE_HTML_PAGES_DIR_ENV] = d;
      process.env[SERVE_HTML_ENV_FLAG] = 'all';
      const { provider, warn } = makeProvider();
      await provider.reconcileServeHtml();
      expect(pagesDirWarns(warn)).toEqual([]);
      // 哨兵确实写进了那个目录（⇒ 合法值原样生效，没被"顺手规范化"到别处）
      expect(fs.existsSync(path.join(d, CADDY_SERVE_HTML_SENTINEL))).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('🔴 非法值 ⇒ 哨兵写到**默认目录**而不是那个非法路径（可观测：失败信息里带的是默认路径）', async () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/pages';
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider, warn } = makeProvider();
    await provider.reconcileServeHtml();
    // 默认目录在本机不存在 ⇒ 写哨兵会失败，而失败信息里带着**它试图写的路径**，
    // 这正是"用的是哪个目录"的可观测证据（比断言内部变量可靠）。
    const all = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).toContain(DEFAULT_WEBSITE_PAGES_DIR);
    expect(all).not.toContain('relative/pages/.vanblog-caddy-serve-html');
  });

  it('需要规范化的合法值 ⇒ 哨兵落在**规范化后**的目录（与 caddy 的 vars.root 同一个字符串）', async () => {
    const d = tmpDir();
    const sub = path.join(d, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    try {
      process.env[SERVE_HTML_PAGES_DIR_ENV] = `${d}//sub///`;
      process.env[SERVE_HTML_ENV_FLAG] = 'all';
      const { provider } = makeProvider();
      await provider.reconcileServeHtml();
      expect(fs.existsSync(path.join(sub, CADDY_SERVE_HTML_SENTINEL))).toBe(true);
      expect(resolveWebsitePagesDir(`${d}//sub///`).dir).toBe(`${d}/sub`);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('artifactReaper：合法值原样生效，非法值回落默认（这一处是删除操作）', () => {
  it('🔴 合法自定义值必须**原样**返回（回落默认会让 reaper 删错目录）', () => {
    const d = tmpDir();
    try {
      process.env[SERVE_HTML_PAGES_DIR_ENV] = d;
      expect(reaperPagesDir()).toBe(d);
      expect(reaperPagesDir()).not.toBe(DEFAULT_WEBSITE_PAGES_DIR);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it.each([
    ['相对路径', 'relative/pages'],
    ['文件系统根', '/'],
    ['.. 段', '/a/../b'],
    ['占位符', '/{env.HOME}/pages'],
  ])('🔴 非法值（%s）⇒ 回落默认目录，绝不把非法值当扫描根', (_label, raw) => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = raw;
    expect(reaperPagesDir()).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    expect(reaperPagesDir()).not.toBe(raw);
  });

  it('未设置 ⇒ 默认目录（与修复前逐字节相同）', () => {
    delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    expect(reaperPagesDir()).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('给了 log 就把 WARN 打出来（不给也不抛）', () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/pages';
    const warn = jest.fn();
    expect(reaperPagesDir({ warn })).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('artifact-reaper');
    expect(() => reaperPagesDir()).not.toThrow();
  });
});

describe('degradedServeHtml：降级驻留时也必须与 caddy 指向同一个目录', () => {
  it('合法值原样生效；未设置回落默认（与修复前一致）', () => {
    const d = tmpDir();
    try {
      process.env[SERVE_HTML_PAGES_DIR_ENV] = d;
      expect(resolveServeHtmlSentinelDir(process.env)).toBe(d);
      expect(resolveServeHtmlSentinelDir({})).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('🔴 非法值 ⇒ 回落默认（否则哨兵写到 caddy 不看的地方，降级发布**静默失效**）', () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = '/a/../b';
    expect(resolveServeHtmlSentinelDir(process.env)).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('给了 log 就把 WARN 打出来，并标明来自降级驻留', () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = 'relative/pages';
    const warn = jest.fn();
    resolveServeHtmlSentinelDir(process.env, { warn, log: jest.fn() });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('degraded-hold');
  });

  it('🔴 快照与写入必须解析到**同一个目录**（否则恢复时会去错地方还原哨兵）', () => {
    // main.ts 的顺序是：snapshotServeHtmlSentinels() → enableDegradedServeHtml({ log })
    // → 恢复时 restoreServeHtmlSentinels(snapshot)。前两个入口各自解析一次目录，
    // 所以对同一个（哪怕是非法的）env 必须得出同一个 dir —— 否则写进 A、还原看 B，
    // 站点会一直停在"caddy 直发旧 HTML"的状态而没人知道。
    for (const raw of [undefined, 'relative/pages', '/a/../b', '/']) {
      if (raw === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
      else process.env[SERVE_HTML_PAGES_DIR_ENV] = raw;
      expect({ raw, dir: snapshotServeHtmlSentinels().dir }).toEqual({
        raw,
        dir: resolveServeHtmlSentinelDir(process.env),
      });
    }
  });

  it('⚠️ 未传 log 时也不能抛（main.ts 里的 snapshot 调用就是不带 log 的）', () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = '/a/../b';
    expect(() => snapshotServeHtmlSentinels()).not.toThrow();
    expect(snapshotServeHtmlSentinels().dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });
});

describe('取值表的元约束（防止"跳过"被用来把守卫测空）', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const table = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../scripts/tests/fixtures/pages-dir-cases.json'),
      'utf8',
    ),
  ) as {
    cases: Array<{ id: string; envLossy?: boolean; envLossyWhy?: string; raw?: unknown }>;
  };

  it('标了 envLossy 的取值必须写明原因（shell 侧会跳过它，理由必须可核查）', () => {
    for (const c of table.cases) {
      if (c.envLossy) {
        expect({ id: c.id, why: typeof c.envLossyWhy }).toEqual({ id: c.id, why: 'string' });
        expect((c.envLossyWhy as string).length).toBeGreaterThan(20);
      }
    }
  });

  it('⚠️ envLossy 只能用于"环境变量表达不了"的取值，不能用来逃避断言', () => {
    for (const c of table.cases) {
      if (!c.envLossy) continue;
      const raw = c.raw;
      const unrepresentable =
        raw === null ||
        typeof raw !== 'string' ||
        // NUL 会被 execve 截断
        raw.includes('\u0000');
      expect({ id: c.id, unrepresentable }).toEqual({ id: c.id, unrepresentable: true });
    }
  });

  it('🔴 被 shell 跳过的取值仍然被 jest 侧覆盖（这里直接调 TS 解析器验证）', () => {
    const skipped = table.cases.filter((c) => c.envLossy);
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) {
      const r = resolveWebsitePagesDir(c.raw);
      // NUL 属于控制字符 ⇒ 必须被拒；非字符串 ⇒ 必须当未设置
      if (typeof c.raw === 'string') {
        expect({ id: c.id, rejected: r.rejected }).toEqual({ id: c.id, rejected: true });
      } else {
        expect({ id: c.id, provided: r.provided, dir: r.dir }).toEqual({
          id: c.id,
          provided: false,
          dir: DEFAULT_WEBSITE_PAGES_DIR,
        });
      }
    }
  });
});
