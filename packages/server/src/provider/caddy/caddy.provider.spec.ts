import axios from 'axios';
import {
  CADDY_ADMIN_TIMEOUT_MS,
  CADDY_LISTENER_WRAPPERS_URL,
  CaddyProvider,
  HTTP_REDIRECT_WRAPPERS,
  SERVE_HTML_DB_FAILURE_WARN_EVERY,
  describeCaddyAdminFailure,
} from './caddy.provider';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function notFoundError() {
  const err = new Error('Request failed with status code 404') as Error & {
    response: { status: number };
  };
  err.response = { status: 404 };
  return err;
}

function createProvider() {
  const settingProvider = {
    getHttpsSetting: jest.fn().mockReturnValue(new Promise(() => undefined)),
  };
  const provider = new CaddyProvider(settingProvider as any);
  jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
  return { provider, settingProvider };
}

describe('CaddyProvider.setRedirect', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockedAxios.patch.mockReset();
    mockedAxios.post.mockReset();
    mockedAxios.delete.mockReset();
  });

  it('enables redirect by replacing wrappers (PUT when missing) and logs open success', async () => {
    const { provider } = createProvider();
    mockedAxios.patch.mockRejectedValue(notFoundError());
    mockedAxios.put.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [{ wrapper: 'http_redirect' }] });

    await expect(provider.setRedirect(true)).resolves.toBe('开启成功！');

    expect(mockedAxios.patch).toHaveBeenCalledWith(
      CADDY_LISTENER_WRAPPERS_URL,
      HTTP_REDIRECT_WRAPPERS,
      // ⚠️ 这个 timeout 不是可有可无的第三个参数：caddy admin 卡住时没有它就会**无限等待**
      { timeout: CADDY_ADMIN_TIMEOUT_MS },
    );
    expect(mockedAxios.put).toHaveBeenCalledWith(
      CADDY_LISTENER_WRAPPERS_URL,
      HTTP_REDIRECT_WRAPPERS,
      { timeout: CADDY_ADMIN_TIMEOUT_MS },
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.get).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL, {
      timeout: CADDY_ADMIN_TIMEOUT_MS,
    });
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已开启');
    expect(provider.logger.error).not.toHaveBeenCalled();
  });

  it('enables redirect by PATCHing existing wrappers instead of appending', async () => {
    const { provider } = createProvider();
    mockedAxios.patch.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [{ wrapper: 'http_redirect' }] });

    await expect(provider.setRedirect(true)).resolves.toBe('开启成功！');

    expect(mockedAxios.patch).toHaveBeenCalledWith(
      CADDY_LISTENER_WRAPPERS_URL,
      HTTP_REDIRECT_WRAPPERS,
      // ⚠️ 这个 timeout 不是可有可无的第三个参数：caddy admin 卡住时没有它就会**无限等待**
      { timeout: CADDY_ADMIN_TIMEOUT_MS },
    );
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已开启');
  });

  it('returns false when enable write fails', async () => {
    const { provider } = createProvider();
    mockedAxios.patch.mockRejectedValue(new Error('connection refused'));

    await expect(provider.setRedirect(true)).resolves.toBe(false);
    expect(mockedAxios.put).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
    // 失败原因现在会一起打出来（以前只有这句话，超时/拒连/caddy 500 在日志里长得一样）
    expect(provider.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('开启 https 自动重定向失败'),
    );
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('returns false when enable write succeeds but read-back has no http_redirect', async () => {
    const { provider } = createProvider();
    mockedAxios.patch.mockRejectedValue(notFoundError());
    mockedAxios.put.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [] });

    await expect(provider.setRedirect(true)).resolves.toBe(false);
    // 失败原因现在会一起打出来（以前只有这句话，超时/拒连/caddy 500 在日志里长得一样）
    expect(provider.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('开启 https 自动重定向失败'),
    );
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('disables redirect by deleting wrappers and treats 404 as already off', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockRejectedValue(notFoundError());

    await expect(provider.setRedirect(false)).resolves.toBe('关闭成功！');
    expect(mockedAxios.delete).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL, {
      timeout: CADDY_ADMIN_TIMEOUT_MS,
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL, {
      timeout: CADDY_ADMIN_TIMEOUT_MS,
    });
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已关闭');
    expect(provider.logger.error).not.toHaveBeenCalled();
  });

  it('disables redirect when DELETE is already 404', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockRejectedValue(notFoundError());
    mockedAxios.get.mockRejectedValue(notFoundError());

    await expect(provider.setRedirect(false)).resolves.toBe('关闭成功！');
    expect(mockedAxios.delete).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL, {
      timeout: CADDY_ADMIN_TIMEOUT_MS,
    });
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已关闭');
  });

  it('returns false when disable DELETE fails', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockRejectedValue(new Error('connection refused'));

    await expect(provider.setRedirect(false)).resolves.toBe(false);
    expect(provider.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('关闭 https 自动重定向失败'),
    );
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('returns false when disable DELETE succeeds but read-back still has http_redirect', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [{ wrapper: 'http_redirect' }] });

    await expect(provider.setRedirect(false)).resolves.toBe(false);
    expect(provider.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('关闭 https 自动重定向失败'),
    );
    expect(provider.logger.log).not.toHaveBeenCalled();
  });
});

/* ===================== caddy 直服 ISR HTML（哨兵机制） ===================== */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CADDY_SERVE_HTML_DYNAMIC_SENTINEL,
  CADDY_SERVE_HTML_SENTINEL,
  DEFAULT_WEBSITE_PAGES_DIR,
  SERVE_HTML_ENV_FLAG,
  SERVE_HTML_PAGES_DIR_ENV,
  effectiveServeHtmlLevel,
  resolveServeHtmlLevel,
  shouldServeHtmlFromCaddy,
} from './caddy.provider';

describe('caddy 直服 ISR HTML：哨兵的写/删决策', () => {
  let tmpDir: string;
  let savedFlag: string | undefined;
  let savedDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-serve-html-'));
    savedFlag = process.env[SERVE_HTML_ENV_FLAG];
    savedDir = process.env[SERVE_HTML_PAGES_DIR_ENV];
    process.env[SERVE_HTML_PAGES_DIR_ENV] = tmpDir;
    delete process.env[SERVE_HTML_ENV_FLAG];
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[SERVE_HTML_ENV_FLAG];
    else process.env[SERVE_HTML_ENV_FLAG] = savedFlag;
    if (savedDir === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    else process.env[SERVE_HTML_PAGES_DIR_ENV] = savedDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createServeHtmlProvider(isr: unknown) {
    const settingProvider = {
      getHttpsSetting: jest.fn().mockReturnValue(new Promise(() => undefined)),
      getISRSetting:
        typeof isr === 'function'
          ? (isr as () => Promise<unknown>)
          : jest.fn().mockResolvedValue(isr),
    };
    const provider = new CaddyProvider(settingProvider as any);
    jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    return { provider, settingProvider };
  }
  const sentinelPath = () => path.join(tmpDir, CADDY_SERVE_HTML_SENTINEL);
  const dynamicSentinelPath = () => path.join(tmpDir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL);

  it('档位解析：只认 true/all 两个字面量，垃圾值一律落到更安全的 off（绝不落到更宽的 all）', () => {
    // 正向对照：两个合法值都必须真的解析出来
    expect(resolveServeHtmlLevel('all')).toBe('all');
    expect(resolveServeHtmlLevel('true')).toBe('fixed');
    const bad: unknown[] = [undefined, null, '', 'false', 'ALL', 'All', '1', 'yes', 'true ', true, 1, {}];
    // 数组对数组：失败时 diff 直接指出是第几个向量出的问题
    expect(bad.map((b) => resolveServeHtmlLevel(b))).toEqual(bad.map(() => 'off'));
    // 组合决策：all 也算开，但同样被 delay 模式一票否决
    expect(shouldServeHtmlFromCaddy('all', 'onDemand')).toBe(true);
    expect(shouldServeHtmlFromCaddy('all', 'delay')).toBe(false);
    expect(effectiveServeHtmlLevel('all', 'onDemand')).toBe('all');
    expect(effectiveServeHtmlLevel('all', 'delay')).toBe('off');
    expect(effectiveServeHtmlLevel('all', undefined)).toBe('off');
    expect(effectiveServeHtmlLevel('garbage', 'onDemand')).toBe('off');
  });

  it('决策函数：只有显式 true + 显式 onDemand 才开（每个分支都有正反向量）', () => {
    // "开"分支必须真的被走到 —— 防止一个永远返回 false 的实现假绿
    expect(shouldServeHtmlFromCaddy('true', 'onDemand')).toBe(true);
    expect(shouldServeHtmlFromCaddy('true', 'delay')).toBe(false);
    expect(shouldServeHtmlFromCaddy('false', 'onDemand')).toBe(false);
    expect(shouldServeHtmlFromCaddy('', 'onDemand')).toBe(false);
    expect(shouldServeHtmlFromCaddy(undefined, 'onDemand')).toBe(false);
    expect(shouldServeHtmlFromCaddy('true', undefined)).toBe(false);
    expect(shouldServeHtmlFromCaddy('true', null)).toBe(false);
    expect(shouldServeHtmlFromCaddy('true', 'ondemand')).toBe(false); // 大小写敏感，不做宽松解析
    expect(shouldServeHtmlFromCaddy(true, 'onDemand')).toBe(false); // 必须是字符串 'true'
  });

  it('flag=true + onDemand 只写主哨兵（fixed 档）；撤掉 flag 后再对账即移除（回滚 = 一个环境变量）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'true';
    const { provider } = createServeHtmlProvider({ mode: 'onDemand' });
    await expect(provider.reconcileServeHtml()).resolves.toBe('fixed');
    expect(fs.existsSync(sentinelPath())).toBe(true);
    // fixed 档**绝不**写动态哨兵：语义与第一轮发布时完全一致
    expect(fs.existsSync(dynamicSentinelPath())).toBe(false);

    delete process.env[SERVE_HTML_ENV_FLAG];
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('flag=all 写两个哨兵；降级 true 只留主哨兵；降级 off 全删（都无需重启/reload）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider } = createServeHtmlProvider({ mode: 'onDemand' });
    await expect(provider.reconcileServeHtml()).resolves.toBe('all');
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(true);

    process.env[SERVE_HTML_ENV_FLAG] = 'true';
    await expect(provider.reconcileServeHtml()).resolves.toBe('fixed');
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(false);

    process.env[SERVE_HTML_ENV_FLAG] = 'nonsense'; // 垃圾值 = off，不是 all
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('delay 模式即使 flag=all 也不写任何哨兵（delay 的新鲜度靠流量触发重渲染，直服会把站点冻结）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const { provider } = createServeHtmlProvider({ mode: 'delay' });
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('运行时从 onDemand 切到 delay（不重启进程）：下一次对账自动摘除全部哨兵', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const isr = { mode: 'onDemand' as string };
    const { provider } = createServeHtmlProvider(isr);
    await provider.reconcileServeHtml();
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(true);
    isr.mode = 'delay';
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('getISRSetting 抛错且**从没成功对过账**：保持 off（不臆造档位）且不 crash', async () => {
    /* ⚠️ 这条用例的旧版本名叫「按关处理」，断言的是"抛错 ⇒ 返回 off ⇒ 哨兵被删"。
     * 那个契约**只对"从来没有已知档位"这一种情况成立**，而旧实现把它用在了所有情况上，
     * 于是变成："数据库挂掉 ⇒ 主动删掉哨兵 ⇒ caddy 直服 HTML 整条路由失效 ⇒
     * 请求落到反代 → Next → server → 查已死的 mongo ⇒ 全站 5xx"，
     * 而磁盘上明明躺着渲染好的 HTML。也就是**在最需要静态兜底的时候亲手关掉它**。
     * 现在：从没成功对过账（serveHtmlState === null）时确实仍按 off（不知道 ISR 模式就直服，
     * 可能把 delay 模式的站点冻结，那正是这个门槛存在的理由）；
     * 一旦有过已知档位，读库失败必须**保持**它 —— 那条语义由下面新增的用例钉住。 */
    process.env[SERVE_HTML_ENV_FLAG] = 'true';
    const { provider } = createServeHtmlProvider(() => Promise.reject(new Error('mongo down')));
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('🔴 mongo 挂了也**不许删哨兵**：保持上一次已知档位（降级发布，而不是全站 5xx）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    let fail = false;
    const { provider } = createServeHtmlProvider(() =>
      fail ? Promise.reject(new Error('mongo down')) : Promise.resolve({ mode: 'onDemand' }),
    );
    // 先建立"已知档位 = all"（两个哨兵都在）
    await expect(provider.reconcileServeHtml()).resolves.toBe('all');
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(true);

    fail = true;
    // 旧实现在这里返回 'off' 并 unlinkSync 掉两个哨兵
    await expect(provider.reconcileServeHtml()).resolves.toBe('all');
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(true);

    // 连续多轮失败也必须一直保持着（对账是 60s 一轮，mongo 挂一小时就是 60 轮）
    for (let i = 0; i < 3; i += 1) {
      await expect(provider.reconcileServeHtml()).resolves.toBe('all');
    }
    expect(fs.existsSync(sentinelPath())).toBe(true);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(true);
    provider.onModuleDestroy();
  });

  it('🔴 但**运维回滚**不受数据库影响：撤掉 env 开关就能立刻摘除哨兵', async () => {
    /* 回滚手段绝不能跟着数据库一起失效 —— 它是本地环境变量，不依赖 mongo。
     * 所以"保持上一次档位"只适用于**读设置失败**，不适用于 flag 本身变成 off。 */
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    let fail = false;
    const { provider } = createServeHtmlProvider(() =>
      fail ? Promise.reject(new Error('mongo down')) : Promise.resolve({ mode: 'onDemand' }),
    );
    await provider.reconcileServeHtml();
    expect(fs.existsSync(sentinelPath())).toBe(true);

    fail = true; // 数据库仍然挂着
    delete process.env[SERVE_HTML_ENV_FLAG]; // 运维撤掉开关（等价于回滚）
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    expect(fs.existsSync(dynamicSentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('成功读到"确实是 off/delay"时**才**允许摘除哨兵（区分"读不到"与"读到关"）', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    const isr = { mode: 'onDemand' as string };
    const { provider } = createServeHtmlProvider(isr);
    await provider.reconcileServeHtml();
    expect(fs.existsSync(sentinelPath())).toBe(true);
    isr.mode = 'delay'; // 成功读到，且读到的就是"不该直服"
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    expect(fs.existsSync(sentinelPath())).toBe(false);
    provider.onModuleDestroy();
  });

  it('pages 目录不存在（dev 机 / website 单独部署）时静默跳过，返回 off', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
    process.env[SERVE_HTML_PAGES_DIR_ENV] = path.join(tmpDir, 'no-such-dir');
    const { provider } = createServeHtmlProvider({ mode: 'onDemand' });
    await expect(provider.reconcileServeHtml()).resolves.toBe('off');
    provider.onModuleDestroy();
  });

  it('对账 timer 幂等，且 onModuleDestroy 会清掉', () => {
    const { provider } = createServeHtmlProvider({ mode: 'onDemand' });
    provider.startServeHtmlReconcile();
    provider.startServeHtmlReconcile();
    expect((provider as any).serveHtmlTimer).not.toBeNull();
    provider.onModuleDestroy();
    expect((provider as any).serveHtmlTimer).toBeNull();
  });
});

describe('caddy 模板里的 vanblog-serve-html 路由形状（两份模板 × 两个 server 都钉住）', () => {
  // repoRoot off-by-one 是本仓库的老坑（AGENTS §7.56）：
  // __dirname = packages/server/src/provider/caddy → 上 5 级才是仓库根。
  // 这条 canary 红了先数层级，别怀疑模板被删。
  const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');
  const FIXED_PATHS = ['/', '/about', '/link', '/timeline', '/category', '/tag'];
  const DYNAMIC_PATHS = ['/post/*', '/page/*', '/category/*', '/tag/*'];
  const ALLOWED_PATHS = [...FIXED_PATHS, ...DYNAMIC_PATHS];

  it('repoRoot 数对了（canary：两份模板文件都在）', () => {
    expect(fs.existsSync(path.join(repoRoot, 'caddyTemplate.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'caddyFallbackTemplate.json'))).toBe(true);
  });

  for (const tpl of ['caddyTemplate.json', 'caddyFallbackTemplate.json']) {
    it(`${tpl}：路由在 index 2，只放行 6 固定页 + 4 动态前缀的 GET/HEAD，组内没有 reverse_proxy`, () => {
      const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, tpl), 'utf8'));
      for (const srv of ['srv0', 'srv1']) {
        const routes = cfg.apps.http.servers[srv].routes;
        const idx = routes.findIndex((r: any) => r.group === 'vanblog-serve-html');
        // 位置钉死：全局头/压缩(0) 与静态图直服(1) 之后、任何业务路由之前
        expect(idx).toBe(2);
        const route = routes[idx];
        // 想把允许集之外的路径（/api/*、/admin/*、/c/*、更深的通配……）塞进这条路由的人
        // 必须先读懂下面这段历史与前提，所以不用 toEqual 的 diff，而是把原因写进失败信息：
        const extra = (route.match[0].path as string[]).filter((p) => !ALLOWED_PATHS.includes(p));
        if (extra.length > 0) {
          throw new Error(
            `vanblog-serve-html 路由出现了允许集之外的路径 ${JSON.stringify(extra)}。` +
              '允许集 = 6 个固定页 + /post/* /page/* /category/* /tag/*，别的一个都不许进。' +
              '历史（2026-09 第一轮实测，Next 14.2.35 + 真数据容器）：动态路由曾被整体否决，因为 ' +
              '(1) 删除文章后 revalidate 只写内存 404，旧 .html 永远留在盘上（file-system-cache 没有任何 unlink）；' +
              '(2) 308（/post/<数字id>→别名）与 404/notFound 不落盘，文件直服无法复刻；' +
              '(3) 加密文章的旧明文 HTML 要等风暴重写。' +
              '现在 (1)(3) 由 provider/isr/artifactReaper 兜底（风暴收尾 + 周期对账删除 ' +
              'deleted/hidden/private/加密分类/publishAt 未到的三件套产物），(2) 由 try_files ' +
              '落空回退反代天然保持 —— 这些前提只对四个动态前缀成立。/api/*、/admin/* 有鉴权与 ' +
              'no-store 语义，/c/*（自定义页）与更深的路径没有任何产物/资格模型，塞进来就是事故。',
          );
        }
        expect(route.match[0].path).toEqual(ALLOWED_PATHS);
        expect(route.match[0].method).toEqual(['GET', 'HEAD']);
        // Next 预览模式的两个 cookie 必须绕过直服
        expect(route.match[0].not[0].header.Cookie).toEqual([
          '*__next_preview_data*',
          '*__prerender_bypass*',
        ]);
        const json = JSON.stringify(route);
        expect(json).not.toContain('reverse_proxy'); // 组内只有直服；找不到文件时落回外层 catch-all 反代
        expect(json).toContain(CADDY_SERVE_HTML_SENTINEL); // 哨兵闸门在路由里（provider 只碰这两个文件）
        expect(json).toContain(CADDY_SERVE_HTML_DYNAMIC_SENTINEL);
        expect(json).toContain(DEFAULT_WEBSITE_PAGES_DIR); // 与 provider 的默认目录是同一个常量
        expect(json).toContain('file_server');
        // HTML 必须 revalidate（ETag/304）：浏览器长缓存会让哨兵开关与内容更新迟到
        expect(json).toContain('no-cache');

        // 子路由结构：[vars root, 固定页闸门(主哨兵), 动态闸门(动态哨兵)]
        const sub = route.handle[0];
        expect(sub.handler).toBe('subroute');
        expect(sub.routes).toHaveLength(3);
        expect(sub.routes[0].handle[0].handler).toBe('vars');
        expect(sub.routes[0].handle[0].root).toBe(DEFAULT_WEBSITE_PAGES_DIR);
        // 固定页分支：主哨兵 + 恰好 6 个固定路径
        const fixedGate = sub.routes[1];
        expect(fixedGate.match[0].file.try_files).toEqual([`/${CADDY_SERVE_HTML_SENTINEL}`]);
        expect(fixedGate.match[0].path).toEqual(FIXED_PATHS);
        // 动态分支：**动态哨兵** + 恰好 4 个通配前缀（true 档只写主哨兵，动态分支自然失效）
        const dynGate = sub.routes[2];
        expect(dynGate.match[0].file.try_files).toEqual([
          `/${CADDY_SERVE_HTML_DYNAMIC_SENTINEL}`,
        ]);
        expect(dynGate.match[0].path).toEqual(DYNAMIC_PATHS);
        // 两个分支内部各自还有一层「目标 .html 存在才直服」的 file 闸门（落空 → 反代）
        for (const gate of [fixedGate, dynGate]) {
          const inner = JSON.stringify(gate.handle);
          expect(inner).toContain('try_files');
          expect(inner).toContain('.html');
          expect(inner).toContain('file_server');
        }
      }
    });
  }
});

/* =============== 读库失败时的降级发布语义（哨兵保持） =============== */

describe('caddy 直服 HTML：读不到设置时的日志节流与恢复', () => {
  let tmpDir: string;
  let savedFlag: string | undefined;
  let savedDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-serve-html-degrade-'));
    savedFlag = process.env[SERVE_HTML_ENV_FLAG];
    savedDir = process.env[SERVE_HTML_PAGES_DIR_ENV];
    process.env[SERVE_HTML_PAGES_DIR_ENV] = tmpDir;
    process.env[SERVE_HTML_ENV_FLAG] = 'all';
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[SERVE_HTML_ENV_FLAG];
    else process.env[SERVE_HTML_ENV_FLAG] = savedFlag;
    if (savedDir === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    else process.env[SERVE_HTML_PAGES_DIR_ENV] = savedDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProvider() {
    let fail = false;
    const settingProvider = {
      getHttpsSetting: jest.fn().mockReturnValue(new Promise(() => undefined)),
      getISRSetting: jest.fn(() =>
        fail ? Promise.reject(new Error('mongo down')) : Promise.resolve({ mode: 'onDemand' }),
      ),
    };
    const provider = new CaddyProvider(settingProvider as any);
    const log = jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    const debug = jest.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    return { provider, log, warn, debug, setFail: (v: boolean) => (fail = v) };
  }

  it('第一次读库失败就 WARN（这是"进入降级发布模式"的时刻，必须看得见）', async () => {
    const { provider, warn, setFail } = makeProvider();
    await provider.reconcileServeHtml(); // 建立已知档位 all
    setFail(true);
    await provider.reconcileServeHtml();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    // 消息必须说清"哨兵没被删、直服仍在"，否则运维会以为已经切回反代
    expect(msg).toContain('保持');
    expect(msg).toContain('降级发布模式');
    expect(msg).toContain('mongo down');
    provider.onModuleDestroy();
  });

  it('之后不每分钟刷屏：第 2..N-1 次降为 debug，到阈值再 WARN 一次', async () => {
    const { provider, warn, debug, setFail } = makeProvider();
    await provider.reconcileServeHtml();
    setFail(true);
    for (let i = 0; i < SERVE_HTML_DB_FAILURE_WARN_EVERY; i += 1) {
      await provider.reconcileServeHtml();
    }
    // 第 1 次 + 第 SERVE_HTML_DB_FAILURE_WARN_EVERY 次 = 2 条 WARN，其余走 debug
    expect(warn).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls.length).toBe(SERVE_HTML_DB_FAILURE_WARN_EVERY - 2);
    provider.onModuleDestroy();
  });

  it('数据库恢复后打一条"已恢复"并把计数清零（否则下一次失败要等阈值才告警）', async () => {
    const { provider, log, warn, setFail } = makeProvider();
    await provider.reconcileServeHtml();
    setFail(true);
    await provider.reconcileServeHtml();
    await provider.reconcileServeHtml();
    setFail(false);
    await provider.reconcileServeHtml();
    const recovered = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('已恢复'));
    expect(recovered.length).toBe(1);
    expect(recovered[0]).toContain('连续 2 次');
    // 清零的证据：恢复后再失败一次，立刻又是 WARN（而不是要等阈值）
    warn.mockClear();
    setFail(true);
    await provider.reconcileServeHtml();
    expect(warn).toHaveBeenCalledTimes(1);
    provider.onModuleDestroy();
  });

  it('哨兵内容在降级期间保持有效（caddy 每个请求现查这个文件）', async () => {
    const { provider, setFail } = makeProvider();
    await provider.reconcileServeHtml();
    const before = fs.readFileSync(path.join(tmpDir, CADDY_SERVE_HTML_SENTINEL), 'utf-8');
    setFail(true);
    await provider.reconcileServeHtml();
    const after = fs.readFileSync(path.join(tmpDir, CADDY_SERVE_HTML_SENTINEL), 'utf-8');
    expect(after).toContain('level=all');
    // 时间戳会被重写（每轮都 writeFileSync），但档位这一行必须在
    expect(after.split(';')[0]).toBe(before.split(';')[0]);
    provider.onModuleDestroy();
  });
});

/* =============== caddy admin API：超时与诊断 =============== */

describe('caddy admin API 调用：全部带超时，且失败原因可读', () => {
  function makeProvider() {
    const settingProvider = {
      getHttpsSetting: jest.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const provider = new CaddyProvider(settingProvider as any);
    jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
    return provider;
  }

  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockedAxios.patch.mockReset();
    mockedAxios.post.mockReset();
    mockedAxios.delete.mockReset();
    mockedAxios.get.mockResolvedValue({ status: 200, data: [] } as any);
    mockedAxios.put.mockResolvedValue({ status: 200 } as any);
    mockedAxios.patch.mockResolvedValue({ status: 200 } as any);
    mockedAxios.delete.mockResolvedValue({ status: 200 } as any);
  });

  it('🔴 每一个 axios 调用都带 timeout（漏一个就意味着那条路径能无限挂住）', async () => {
    const provider = makeProvider();
    await provider.setRedirect(true);
    await provider.setRedirect(false);
    await provider.getSubjects();
    await provider.getAutomaticDomains();
    await provider.updateSubjects(['a.com']);
    await provider.updateHttpsDomains(['a.com']);
    await provider.getConfig();

    const calls: unknown[][] = [
      ...mockedAxios.get.mock.calls,
      ...mockedAxios.put.mock.calls,
      ...mockedAxios.patch.mock.calls,
      ...mockedAxios.delete.mock.calls,
      ...mockedAxios.post.mock.calls,
    ];
    // ⚠️ 防空转：真的打到了所有调用点（少于 7 说明上面的方法没跑起来，断言就没意义了）
    expect(calls.length).toBeGreaterThanOrEqual(7);
    const missing = calls.filter((args) => {
      const last = args[args.length - 1] as { timeout?: number } | undefined;
      return !last || last.timeout !== CADDY_ADMIN_TIMEOUT_MS;
    });
    expect({ 缺超时的调用数: missing.length, 总调用数: calls.length }).toEqual({
      缺超时的调用数: 0,
      总调用数: calls.length,
    });
  });

  it('超时值本身是合理的（不是 0/无限，也不是长到失去意义）', () => {
    expect(CADDY_ADMIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CADDY_ADMIN_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('describeCaddyAdminFailure：四类失败各有可区分的说法，且都带自查命令', () => {
    const timeout = describeCaddyAdminFailure({
      code: 'ECONNABORTED',
      message: `timeout of ${CADDY_ADMIN_TIMEOUT_MS}ms exceeded`,
    });
    expect(timeout).toContain('超时');
    const refused = describeCaddyAdminFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    expect(refused).toContain('连接被拒');
    const http = describeCaddyAdminFailure({
      message: 'Request failed with status code 500',
      response: { status: 500 },
    });
    expect(http).toContain('返回 500');
    const unknown = describeCaddyAdminFailure(new Error('weird'));
    expect(unknown).toContain('调用失败');
    for (const msg of [timeout, refused, http, unknown]) {
      // 每条都要给出"照着敲一条命令就能自查"的下一步
      expect(msg).toContain('curl -s http://127.0.0.1:2019/config/');
    }
  });

  it('describeCaddyAdminFailure 不会自己抛（诊断函数抛错比没诊断更糟）', () => {
    const weird: unknown[] = [null, undefined, 0, '', 'str', {}, [], { code: 1 }, new Error()];
    expect(weird.map((w) => typeof describeCaddyAdminFailure(w))).toEqual(weird.map(() => 'string'));
  });
});

/* =============== 启动时重放 HTTPS 重定向设置 =============== */

describe('CaddyProvider.init：读不到设置时大声失败，读得到时两个方向都重放', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function makeProvider(https: Promise<unknown>) {
    const settingProvider = { getHttpsSetting: jest.fn().mockReturnValue(https) };
    const provider = new CaddyProvider(settingProvider as any);
    jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    // 用可控的替身挡住真实的 caddy admin 调用
    const setRedirect = jest
      .spyOn(provider, 'setRedirect')
      .mockResolvedValue('ok' as unknown as Promise<any> as any);
    return { provider, error, setRedirect };
  }

  it('读设置失败：打 ERROR 说清"本次启动没有重放"，并且**不动 caddy**', async () => {
    const d = deferred<unknown>();
    const { provider, error, setRedirect } = makeProvider(d.promise);
    d.reject(new Error('mongo down'));
    await provider.init().catch(() => undefined);
    expect(setRedirect).not.toHaveBeenCalled();
    const msg = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('读取 HTTPS 重定向设置失败');
    expect(msg).toContain('没有');
    expect(msg).toContain('mongo down');
    provider.onModuleDestroy();
  });

  it('⚠️ 性质钉子：设置读得到时，**两个方向都会显式重放**（历史 bug 是"开了关不掉"）', async () => {
    const on = deferred<unknown>();
    const p1 = makeProvider(on.promise);
    on.resolve({ redirect: true });
    await p1.provider.init();
    expect(p1.setRedirect).toHaveBeenCalledWith(true);
    p1.provider.onModuleDestroy();

    const off = deferred<unknown>();
    const p2 = makeProvider(off.promise);
    off.resolve({ redirect: false });
    await p2.provider.init();
    expect(p2.setRedirect).toHaveBeenCalledWith(false);
    p2.provider.onModuleDestroy();
  });

  it('构造函数里那个 fire-and-forget 的 init() 不会变成 unhandledRejection', async () => {
    /* 以前是裸的 `this.init()`：一旦 reject 就是 unhandledRejection，而本仓库的
     * unhandledRejection **只记日志不退进程**，所以后果不是崩溃，而是
     * "启动时重放 HTTPS 重定向这件事静默没做"，日志里连一条错误都没有。
     *
     * ⚠️ 这里要让 **setRedirect 抛错**、而不是让 getHttpsSetting 抛错：
     * 读设置失败已经被 init() 内部那个 try/catch 接住了（并且有专门的用例），
     * 所以只有"读到了设置、但写 caddy 时炸了"这条路才能真正验证构造函数那层 .catch。
     * 两层 catch 各有职责，不能只测其中一层就宣称"不会漏 rejection"。 */
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const provider = new CaddyProvider({
        getHttpsSetting: jest.fn().mockResolvedValue({ redirect: true }),
      } as any);
      const error = jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(provider, 'setRedirect').mockRejectedValue(new Error('caddy admin 炸了') as any);
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
      // 并且要留下能排查的日志，而不是安静地什么都不说
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('重放');
      provider.onModuleDestroy();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
