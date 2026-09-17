import axios from 'axios';
import {
  CADDY_LISTENER_WRAPPERS_URL,
  CaddyProvider,
  HTTP_REDIRECT_WRAPPERS,
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
    );
    expect(mockedAxios.put).toHaveBeenCalledWith(
      CADDY_LISTENER_WRAPPERS_URL,
      HTTP_REDIRECT_WRAPPERS,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.get).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL);
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
    expect(provider.logger.error).toHaveBeenCalledWith('开启 https 自动重定向失败');
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('returns false when enable write succeeds but read-back has no http_redirect', async () => {
    const { provider } = createProvider();
    mockedAxios.patch.mockRejectedValue(notFoundError());
    mockedAxios.put.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [] });

    await expect(provider.setRedirect(true)).resolves.toBe(false);
    expect(provider.logger.error).toHaveBeenCalledWith('开启 https 自动重定向失败');
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('disables redirect by deleting wrappers and treats 404 as already off', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockRejectedValue(notFoundError());

    await expect(provider.setRedirect(false)).resolves.toBe('关闭成功！');
    expect(mockedAxios.delete).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL);
    expect(mockedAxios.get).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL);
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已关闭');
    expect(provider.logger.error).not.toHaveBeenCalled();
  });

  it('disables redirect when DELETE is already 404', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockRejectedValue(notFoundError());
    mockedAxios.get.mockRejectedValue(notFoundError());

    await expect(provider.setRedirect(false)).resolves.toBe('关闭成功！');
    expect(mockedAxios.delete).toHaveBeenCalledWith(CADDY_LISTENER_WRAPPERS_URL);
    expect(provider.logger.log).toHaveBeenCalledWith('https 自动重定向已关闭');
  });

  it('returns false when disable DELETE fails', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockRejectedValue(new Error('connection refused'));

    await expect(provider.setRedirect(false)).resolves.toBe(false);
    expect(provider.logger.error).toHaveBeenCalledWith('关闭 https 自动重定向失败');
    expect(provider.logger.log).not.toHaveBeenCalled();
  });

  it('returns false when disable DELETE succeeds but read-back still has http_redirect', async () => {
    const { provider } = createProvider();
    mockedAxios.delete.mockResolvedValue({ status: 200 });
    mockedAxios.get.mockResolvedValue({ data: [{ wrapper: 'http_redirect' }] });

    await expect(provider.setRedirect(false)).resolves.toBe(false);
    expect(provider.logger.error).toHaveBeenCalledWith('关闭 https 自动重定向失败');
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

  it('getISRSetting 抛错（Mongo 抖动）按关处理且不 crash', async () => {
    process.env[SERVE_HTML_ENV_FLAG] = 'true';
    const { provider } = createServeHtmlProvider(() => Promise.reject(new Error('mongo down')));
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
