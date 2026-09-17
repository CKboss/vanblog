import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * 第四轮安全审计修复钉子（主题那一组）：B4 —— `/api/public/theme.css` 的
 * 读侧路径收敛（resolveThemeCssPath）+ 两处 unlink 的同款收敛。
 *
 * 威胁模型（审计原文）：`theme.url` 来自数据库，写侧校验管不住
 * `POST /api/admin/init/restore`（原生驱动写库、schema 不跑）种进来的值 ⇒
 * 恢复过一份来路不明归档的站点上，匿名 `GET /api/public/theme.css` 就是
 * 任意文本文件读，`remove()`/上传清理就是任意文件删除。
 *
 * 这里全部进程内：真临时目录 + 假 settingModel/metaProvider，不打 :3000。
 */

// ⚠️ jest.mock 会被提升到 import 之前，工厂里不能引用文件内变量 —— 两处写死同一个字面量。
const TMP_STATIC = '/tmp/vanblog-theme-b4-spec';
const SECRET_FILE = '/tmp/vanblog-theme-b4-secret.txt';
jest.mock('src/config', () => ({
  config: {
    staticPath: '/tmp/vanblog-theme-b4-spec',
    demo: false,
  },
}));

import { ThemeProvider, resolveThemeCssPath } from './provider/theme/theme.provider';
import { PublicThemeController } from './controller/public/theme.controller';

const SECRET = 'root:x:0:0:DO-NOT-SEND-TO-ANONYMOUS';

beforeAll(() => {
  rmSync(TMP_STATIC, { recursive: true, force: true });
  mkdirSync(join(TMP_STATIC, 'themes'), { recursive: true });
  writeFileSync(SECRET_FILE, SECRET);
});

afterAll(() => {
  rmSync(TMP_STATIC, { recursive: true, force: true });
  rmSync(SECRET_FILE, { force: true });
});

function makeProvider(initialThemes: any[] = [], uiStyle = 'apple') {
  const store: any = { themes: initialThemes };
  const settingModel: any = {
    findOne: () => ({
      exec: async () => ({ type: 'theme', value: store }),
    }),
    updateOne: (_q: any, update: any) => {
      store.themes = update.value.themes;
      return { exec: async () => ({ acknowledged: true }) };
    },
    create: async () => ({ type: 'theme', value: store }),
  };
  let activeUi = uiStyle;
  const metaProvider: any = {
    getAll: async () => ({ siteInfo: { uiStyle: activeUi } }),
    updateSiteInfo: async (dto: any) => {
      activeUi = dto.uiStyle;
      return { acknowledged: true };
    },
  };
  const isrProvider: any = { activeAll: async () => undefined };
  const provider = new ThemeProvider(settingModel, metaProvider, isrProvider);
  return { provider, store, setUi: (v: string) => { activeUi = v; } };
}

function makeRes(headers: Record<string, string> = {}) {
  const res: any = {
    headersSent: [],
    statusCode: undefined as number | undefined,
    body: undefined as string | undefined,
    req: { headers },
    setHeader: jest.fn(),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    end: jest.fn(),
    type: jest.fn(() => res),
    send: jest.fn((body: string) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe('FIX B4：resolveThemeCssPath 的收敛规则', () => {
  it('合法形状（服务端自己拼的 /static/themes/<id>-<hash8>.css）原样解析到 themes/ 里', () => {
    expect(resolveThemeCssPath('/static/themes/warm-paper-28381fac.css')).toBe(
      join(TMP_STATIC, 'themes', 'warm-paper-28381fac.css'),
    );
    // 不带 /static/ 前缀的相对形状也收敛到同一处
    expect(resolveThemeCssPath('themes/warm-paper-28381fac.css')).toBe(
      join(TMP_STATIC, 'themes', 'warm-paper-28381fac.css'),
    );
    // themes/ 的子目录也在收敛范围之内（仍然出不了 themes/）
    expect(resolveThemeCssPath('/static/themes/sub/a.css')).toBe(
      join(TMP_STATIC, 'themes', 'sub', 'a.css'),
    );
  });

  it('审计里证明过的每一种逃逸都返回 null', () => {
    // path.join('/app/static','themes/../../../etc/passwd') === '/etc/passwd'（审计实测）
    expect(resolveThemeCssPath('themes/../../../etc/passwd')).toBeNull();
    expect(resolveThemeCssPath('/static/themes/../../../etc/passwd')).toBeNull();
    expect(resolveThemeCssPath('../vanblog-theme-b4-secret.txt')).toBeNull();
    expect(resolveThemeCssPath('../../tmp/vanblog-theme-b4-secret.txt')).toBeNull();
    // 绝对路径：path.resolve(staticPath, '/etc/passwd') === '/etc/passwd' ⇒ 同样必须挡住
    expect(resolveThemeCssPath('/etc/passwd')).toBeNull();
    expect(resolveThemeCssPath('/static/../etc/passwd')).toBeNull();
    // 恰好等于根目录 / themes 目录本身（rel === ''）
    expect(resolveThemeCssPath('themes')).toBeNull();
    expect(resolveThemeCssPath('/static/themes')).toBeNull();
    expect(resolveThemeCssPath('/static/themes/')).toBeNull();
    // staticPath 里的其它合法目录也不行：收敛范围是 themes/，不是整个静态目录
    expect(resolveThemeCssPath('/static/img/a.webp')).toBeNull();
    expect(resolveThemeCssPath('/static/export/full.tar.zst')).toBeNull();
    // 空值家族
    expect(resolveThemeCssPath('')).toBeNull();
    expect(resolveThemeCssPath(null)).toBeNull();
    expect(resolveThemeCssPath(undefined)).toBeNull();
    expect(resolveThemeCssPath({ $ne: null })).toBeNull(); // 对象注入形状 → String() 后也不在 themes/ 里
  });

  it('百分号编码的穿越不解码、按字面路径处理（仍在 themes/ 内，读不到就 204）', () => {
    const abs = resolveThemeCssPath('/static/themes/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    expect(abs).toBe(join(TMP_STATIC, 'themes', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'));
    expect(abs?.startsWith(join(TMP_STATIC, 'themes'))).toBe(true);
  });
});

describe('FIX B4：控制器 GET /api/public/theme.css', () => {
  it('合法上传主题往返：upload() 产出的 url 能读出真实 CSS（blast radius 为零的证明）', async () => {
    const { provider } = makeProvider([], 'rt');
    const css = '[data-ui="rt"] .vb-root { color: rebeccapurple; }';
    const uploaded = await provider.upload(
      { buffer: Buffer.from(css, 'utf8'), originalname: 'rt.css' } as any,
      { id: 'rt' },
    );
    expect(uploaded.theme.url).toMatch(/^\/static\/themes\/rt-[0-9a-f]{8}\.css$/);
    // url 通过收敛器解析出来就是磁盘上那个真实文件
    const abs = resolveThemeCssPath(uploaded.theme.url);
    expect(abs).not.toBeNull();
    expect(existsSync(abs!)).toBe(true);

    const controller = new PublicThemeController(provider);
    const res = makeRes();
    await controller.themeCss(res);
    expect(res.statusCode).toBeUndefined(); // 200：send() 不走 status()
    expect(res.type).toHaveBeenCalledWith('text/css; charset=utf-8');
    expect(res.body).toBe(css);
    expect(res.setHeader).toHaveBeenCalledWith('ETag', `W/"${uploaded.theme.hash}"`);
  });

  it('恶意 url（../ 逃逸）⇒ 204，且与「内置主题」完全同形：没有 ETag、没有读盘、密文一个字节都不出去', async () => {
    const { provider } = makeProvider(
      [{ id: 'evil', name: 'evil', source: 'upload', url: '../../tmp/vanblog-theme-b4-secret.txt', hash: 'deadbeef' }],
      'evil',
    );
    const readFileSpy = jest.spyOn(require('fs').promises, 'readFile');
    const controller = new PublicThemeController(provider);
    const res = makeRes();
    await controller.themeCss(res);
    expect(res.statusCode).toBe(204);
    expect(res.end).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled(); // 根本不碰文件系统
    // 与内置主题同形：只设了 Cache-Control，连 ETag 都没有
    expect(res.setHeader).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(String(res.body ?? '')).not.toContain('DO-NOT-SEND');
    readFileSpy.mockRestore();
  });

  it('内置主题（无 url）与文件丢失仍然是既有的 204 形状（行为没被改变）', async () => {
    // 内置主题：getActive 返回 BUILTIN（无 url）
    const builtin = makeProvider([], 'apple');
    const res1 = makeRes();
    await new PublicThemeController(builtin.provider).themeCss(res1);
    expect(res1.statusCode).toBe(204);
    expect(res1.setHeader).toHaveBeenCalledTimes(1); // 只有 Cache-Control

    // 元数据在、文件没了：204（这条路径保留 ETag —— 既有形状，逐字节不变）
    const { provider } = makeProvider(
      [{ id: 'ghost', name: 'g', source: 'upload', url: '/static/themes/ghost-00000000.css', hash: '00000000' }],
      'ghost',
    );
    const res2 = makeRes();
    await new PublicThemeController(provider).themeCss(res2);
    expect(res2.statusCode).toBe(204);
    expect(res2.setHeader).toHaveBeenCalledWith('ETag', 'W/"00000000"');
  });

  it('304 协商对合法主题照常工作', async () => {
    const { provider } = makeProvider([], 'etag');
    const uploaded = await provider.upload(
      { buffer: Buffer.from('[data-ui="etag"] a{color:red}', 'utf8'), originalname: 'etag.css' } as any,
      { id: 'etag' },
    );
    const res = makeRes({ 'if-none-match': `W/"${uploaded.theme.hash}"` });
    await new PublicThemeController(provider).themeCss(res);
    expect(res.statusCode).toBe(304);
    expect(res.send).not.toHaveBeenCalled();
  });
});

describe('FIX B4：两处 unlink 也走同一个收敛器（任意文件删除原语被收掉）', () => {
  it('remove()：库里的 url 是 ../ 逃逸时，元数据被删、但收敛器之外的文件一个字节都不动', async () => {
    const { provider, store } = makeProvider([
      { id: 'evil2', name: 'evil2', source: 'upload', url: '../../../tmp/vanblog-theme-b4-secret.txt' },
    ]);
    const res = await provider.remove('evil2');
    expect(res).toEqual({ deleted: 'evil2' });
    expect(existsSync(SECRET_FILE)).toBe(true); // canary 活着
    expect(readFileSync(SECRET_FILE, 'utf8')).toBe(SECRET);
    expect(store.themes.find((t: any) => t.id === 'evil2')).toBeUndefined();
  });

  it('remove()：合法主题照常连文件一起删（既有行为不变，theme.provider.spec 也钉着）', async () => {
    // 当前生效主题是 apple（内置），上传的 gone2 不是激活态 ⇒ 可以删
    const { provider } = makeProvider([], 'apple');
    const uploaded = await provider.upload(
      { buffer: Buffer.from('[data-ui="gone2"] a{color:red}', 'utf8'), originalname: 'gone2.css' } as any,
      { id: 'gone2' },
    );
    const abs = resolveThemeCssPath(uploaded.theme.url)!;
    expect(existsSync(abs)).toBe(true);
    await provider.remove('gone2');
    expect(existsSync(abs)).toBe(false);
  });

  it('upload() 的旧文件清理：旧 url 是 ../ 逃逸时不删收敛器之外的文件，合法旧文件照常清掉', async () => {
    // 先放一个合法的旧版本
    const { provider, store } = makeProvider([], 'up');
    const first = await provider.upload(
      { buffer: Buffer.from('[data-ui="up"] a{color:blue}', 'utf8'), originalname: 'up.css' } as any,
      { id: 'up' },
    );
    const firstAbs = resolveThemeCssPath(first.theme.url)!;
    expect(existsSync(firstAbs)).toBe(true);
    // 把库里的旧记录换成恶意 url（模拟恢复归档种进来的值），再传同 id 的新版本
    const evilUrl = '../../../tmp/vanblog-theme-b4-secret.txt';
    store.themes = [{ ...first.theme, url: evilUrl }];
    const second = await provider.upload(
      { buffer: Buffer.from('[data-ui="up"] a{color:green}', 'utf8'), originalname: 'up.css' } as any,
      { id: 'up' },
    );
    expect(second.theme.url).not.toBe(evilUrl);
    expect(second.theme.url).toMatch(/^\/static\/themes\/up-[0-9a-f]{8}\.css$/);
    expect(existsSync(SECRET_FILE)).toBe(true); // canary 活着
  });

  it('源码钉子：控制器与两处 unlink 都只用 resolveThemeCssPath，不再有裸 path.join(staticPath, url)', () => {
    const controller = readFileSync(join(__dirname, 'controller/public/theme.controller.ts'), 'utf8');
    expect(controller).toMatch(/const abs = resolveThemeCssPath\(theme\.url\);/);
    expect(controller).toMatch(/if \(!abs\) \{\s*\n\s*res\.status\(204\)\.end\(\);/);
    expect(controller).not.toMatch(/path\.join\(config\.staticPath/);
    const theme = readFileSync(join(__dirname, 'provider/theme/theme.provider.ts'), 'utf8');
    expect(theme).not.toMatch(/path\.join\(config\.staticPath, prev\.url/);
    expect(theme).not.toMatch(/path\.join\(config\.staticPath, target\.url/);
    expect(theme).toMatch(/const oldAbs = resolveThemeCssPath\(prev\.url\);/);
    expect(theme).toMatch(/const abs = resolveThemeCssPath\(target\.url\);/);
    // 两处 unlink 都在收敛器判空之后
    expect((theme.match(/fs\.unlink/g) || []).length).toBe(2);
    // 收敛器本体与 xit 里给出的最小补丁逐字一致（关键三行）
    expect(theme).toContain('const root = path.resolve(config.staticPath, THEME_SUBDIR);');
    expect(theme).toContain("const abs = path.resolve(config.staticPath, raw.replace(/^\\/static\\//, ''));");
    expect(theme).toContain("return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;");
  });
});
