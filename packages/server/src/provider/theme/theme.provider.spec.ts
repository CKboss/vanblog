import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  BUILTIN_THEMES,
  THEME_MAX_BYTES,
  slugifyThemeId,
  validateThemeCss,
} from 'src/types/theme.dto';

// 静态目录要指到临时目录，否则测试会往真实的图床目录里写文件。
// ⚠️ jest.mock 会被提升到 import 之前，所以工厂里**不能**引用文件内的变量或后面才赋值的
//    process.env（import 也在语句之前执行）—— 两边都写死同一个字面量最稳。
const TMP_STATIC = '/tmp/vanblog-theme-spec-test';
jest.mock('src/config', () => ({
  config: {
    staticPath: '/tmp/vanblog-theme-spec-test',
    demo: false,
  },
}));

import { ThemeProvider } from './theme.provider';

function makeProvider(initialThemes: any[] = [], uiStyle = 'apple') {
  const store: any = { themes: initialThemes };
  const settingModel: any = {
    findOne: jest.fn().mockImplementation(() => ({
      exec: jest.fn().mockResolvedValue({ type: 'theme', value: store }),
    })),
    updateOne: jest.fn().mockImplementation((_q: any, update: any) => {
      store.themes = update.value.themes;
      return { exec: jest.fn().mockResolvedValue({ acknowledged: true }) };
    }),
    create: jest.fn().mockResolvedValue({ type: 'theme', value: store }),
  };
  const metaProvider: any = {
    // ⚠️ 不能用 mockResolvedValue：它在创建时就把对象固定住了，
    //    后面 activate 改了 uiStyle 也读不到新值（必须用 mockImplementation 现算）。
    getAll: jest.fn().mockImplementation(() => Promise.resolve({ siteInfo: { uiStyle } })),
    updateSiteInfo: jest.fn().mockImplementation((dto: any) => {
      uiStyle = dto.uiStyle;
      return Promise.resolve({ acknowledged: true });
    }),
  };
  const isrProvider: any = { activeAll: jest.fn().mockResolvedValue(undefined) };
  const provider = new ThemeProvider(settingModel, metaProvider, isrProvider);
  return { provider, settingModel, metaProvider, isrProvider, store };
}

const cssFile = (body: string, name = 'my-theme.css') => ({
  buffer: Buffer.from(body, 'utf8'),
  originalname: name,
  size: Buffer.byteLength(body, 'utf8'),
});

describe('validateThemeCss（主题 CSS 校验）', () => {
  it('正常的主题 CSS 通过', () => {
    const res = validateThemeCss('[data-ui="demo"] .vb-root { background: #111; }');
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('去掉 BOM（留着会让第一条规则失效）', () => {
    const res = validateThemeCss('\uFEFF[data-ui="demo"] a { color: red; }');
    expect(res.ok).toBe(true);
    expect(res.css?.startsWith('\uFEFF')).toBe(false);
  });

  it('空内容与超大文件被拒', () => {
    expect(validateThemeCss('   ').ok).toBe(false);
    expect(validateThemeCss('a{color:red}'.repeat(1)).ok).toBe(true);
    const big = 'x'.repeat(THEME_MAX_BYTES + 10);
    const res = validateThemeCss(big);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('太大');
  });

  it('注释里提到敏感词不误杀（示例主题就会写"javascript: 会被拒绝"）', () => {
    const res = validateThemeCss(
      '/* 规则：javascript: / expression() / <script> 都会被拒 */\n[data-ui="demo"] a { color: red; }',
    );
    expect(res.ok).toBe(true);
  });

  it('用注释拆词的 javascript: 仍然拦得住（CSS 分词会先吃掉注释）', () => {
    const res = validateThemeCss('[data-ui="x"] a { background: url(java/*x*/script:alert(1)); }');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('javascript:');
  });

  it('含 NUL 字节（传错了二进制）被拒', () => {
    const res = validateThemeCss('[data-ui="x"] a{} \u0000 binary');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('NUL');
  });

  // 主题 CSS 会注入到每一个前台页面，所以注入面必须堵住
  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['width: expression(alert(1))', 'expression()'],
    ['behavior: url(x.htc)', 'behavior'],
    ['-moz-binding: url("x.xml#y")', '-moz-binding'],
    ['a{} </style><script>alert(1)</script>', '</style>'],
    ['a{} <script>alert(1)</script>', '<script>'],
  ])('拒绝危险内容：%s', (css, label) => {
    const res = validateThemeCss(css);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(label.replace('javascript:', 'javascript:'));
  });

  it('远程 @import 允许，但会警告（会把访客 IP 交给第三方）', () => {
    const res = validateThemeCss(
      '@import url("https://fonts.example.com/x.css");\n[data-ui="demo"] a { color: red; }',
    );
    expect(res.ok).toBe(true);
    expect(res.warnings?.join('|')).toContain('远程 @import');
  });

  it('@import 不在开头时警告（浏览器会忽略）', () => {
    const res = validateThemeCss('[data-ui="demo"] a{color:red}\n@import url("x.css");');
    expect(res.ok).toBe(true);
    expect(res.warnings?.join('|')).toContain('不在文件开头');
  });

  it('没有 [data-ui=] 作用域时警告（切主题会有残留）', () => {
    const res = validateThemeCss('.vb-root { background: #000; }');
    expect(res.ok).toBe(true);
    expect(res.warnings?.join('|')).toContain('data-ui');
  });
});

describe('slugifyThemeId', () => {
  it('把文件名/中文名规整成合法 id', () => {
    expect(slugifyThemeId('My Theme.CSS')).toBe('my-theme');
    // 中文名规整不出任何 [a-z0-9]，结果是空串 —— 调用方要因此拒绝，而不是默默用一个空 id
    expect(slugifyThemeId('暗色主题.css')).toBe('');
    // 连续的非法字符会折叠成一个 -，下划线也算非法（id 只留 a-z0-9-）
    expect(slugifyThemeId('  --Demo__2-- ')).toBe('demo-2');
    expect(slugifyThemeId('')).toBe('');
  });
});

describe('ThemeProvider', () => {
  beforeAll(async () => {
    await fs.mkdir(TMP_STATIC, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(TMP_STATIC, { recursive: true, force: true });
  });

  it('list 把内置主题排在前面', async () => {
    const { provider } = makeProvider([
      { id: 'dark', name: '暗色', source: 'upload', updatedAt: new Date().toISOString() },
    ]);
    const all = await provider.list();
    expect(all.slice(0, BUILTIN_THEMES.length).map((t) => t.id)).toEqual(
      BUILTIN_THEMES.map((t) => t.id),
    );
    expect(all.map((t) => t.id)).toContain('dark');
  });

  it('getActive 返回 uiStyle 与对应主题（内置主题没有 url）', async () => {
    const { provider } = makeProvider([], 'apple');
    const active = await provider.getActive();
    expect(active.uiStyle).toBe('apple');
    expect(active.theme?.source).toBe('builtin');
    expect(active.theme?.url).toBeFalsy();
  });

  it('upload：写入 <static>/themes/<id>-<hash8>.css 并记录元数据', async () => {
    const { provider, store } = makeProvider([], 'apple');
    const body = '[data-ui="demo"] .vb-root { background: #101010; }';
    // 没给 id 时用**文件名**推（cssFile 的默认名是 my-theme.css）
    const res = await provider.upload(cssFile(body), { name: '演示主题', author: 'me' });
    expect(res.theme.id).toBe('my-theme');
    expect(res.theme.name).toBe('演示主题');
    expect(res.theme.author).toBe('me');
    expect(res.theme.url).toMatch(/^\/static\/themes\/my-theme-[0-9a-f]{8}\.css$/);
    expect(res.theme.size).toBe(Buffer.byteLength(body));
    expect(store.themes).toHaveLength(1);
    const abs = path.join(TMP_STATIC, res.theme.url!.replace(/^\/static\//, ''));
    expect(await fs.readFile(abs, 'utf8')).toBe(body);
  });

  it('upload：拒绝非 .css、拒绝占用内置 id、拒绝非法 id', async () => {
    const { provider } = makeProvider();
    await expect(provider.upload(cssFile('a{}', 'evil.txt'), {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(provider.upload(cssFile('a{}', 'apple.css'), {})).rejects.toThrow(/内置主题/);
    // 首尾的 - 会被规整掉，所以 '-bad-.css' 其实是合法 id；真正非法的是规整后为空的（纯中文名）
    await expect(provider.upload(cssFile('a{}', '暗色.css'), {})).rejects.toThrow(/不合法/);
    await expect(provider.upload(undefined, {})).rejects.toThrow(/没有收到文件/);
  });

  it('upload：同 id 覆盖时删掉旧文件（URL 里的 hash 会变，缓存自然失效）', async () => {
    const { provider } = makeProvider([], 'apple');
    // ⚠️ id 至少要 2 位（THEME_ID_RE），别用单字符
    const first = await provider.upload(cssFile('[data-ui="tt"] a{color:red}'), { id: 'tt' });
    const second = await provider.upload(cssFile('[data-ui="tt"] a{color:blue}'), { id: 'tt' });
    expect(second.theme.url).not.toBe(first.theme.url);
    const oldAbs = path.join(TMP_STATIC, first.theme.url!.replace(/^\/static\//, ''));
    await expect(fs.access(oldAbs)).rejects.toBeTruthy();
    const newAbs = path.join(TMP_STATIC, second.theme.url!.replace(/^\/static\//, ''));
    expect(await fs.readFile(newAbs, 'utf8')).toContain('color:blue');
    const all = await provider.list();
    expect(all.filter((t) => t.id === 'tt')).toHaveLength(1);
  });

  it('upload：改的正是当前生效主题时，触发一次全量渲染', async () => {
    const { provider, isrProvider } = makeProvider([], 'demo');
    await provider.upload(cssFile('[data-ui="demo"] a{color:red}'), { id: 'demo' });
    expect(isrProvider.activeAll).toHaveBeenCalled();
  });

  it('upload：改的不是当前主题时不打扰渲染', async () => {
    const { provider, isrProvider } = makeProvider([], 'apple');
    await provider.upload(cssFile('[data-ui="other"] a{color:red}'), { id: 'other' });
    expect(isrProvider.activeAll).not.toHaveBeenCalled();
  });

  it('activate：写 siteInfo.uiStyle 并触发渲染；未知 id 报错', async () => {
    const { provider, metaProvider, isrProvider } = makeProvider(
      [{ id: 'dark', name: '暗色', source: 'upload', url: '/static/themes/dark-abcd1234.css' }],
      'apple',
    );
    const res = await provider.activate('dark');
    expect(res.uiStyle).toBe('dark');
    expect(metaProvider.updateSiteInfo).toHaveBeenCalledWith({ uiStyle: 'dark' });
    expect(isrProvider.activeAll).toHaveBeenCalled();
    await expect(provider.activate('nope')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('remove：内置的、正在用的都不给删；正常的连文件一起删', async () => {
    const { provider } = makeProvider([], 'apple');
    const uploaded = await provider.upload(cssFile('[data-ui="gone"] a{color:red}'), { id: 'gone' });
    await expect(provider.remove('apple')).rejects.toThrow(/内置主题/);
    // 把它设为当前主题后就不许删
    await provider.activate('gone');
    await expect(provider.remove('gone')).rejects.toThrow(/正在使用/);
    // 切走之后可以删，文件也一起没了
    await provider.activate('apple');
    await provider.remove('gone');
    const abs = path.join(TMP_STATIC, uploaded.theme.url!.replace(/^\/static\//, ''));
    await expect(fs.access(abs)).rejects.toBeTruthy();
    const all = await provider.list();
    expect(all.find((t) => t.id === 'gone')).toBeUndefined();
  });
});
