const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '..', '..');
// adminRoot = packages/admin，所以仓库根还要再上两级（这个 off-by-one 以前踩过）
const repoRoot = path.join(adminRoot, '..', '..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');
/** 断言前剥注释：新写的注释里常引用"以前是怎样的"，不剥会自己匹配自己 */
const code = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('主题（前台皮肤）：后台管理页', () => {
  it('存在 Theme 标签页，并且注册进了系统设置', () => {
    assert.ok(existsSync(path.join(adminRoot, 'src/pages/SystemConfig/tabs/Theme.jsx')));
    const index = read('src/pages/SystemConfig/index.jsx');
    assert.match(index, /import Theme from '\.\/tabs\/Theme';/);
    assert.match(index, /theme: <Theme \/>,/);
    assert.match(index, /tab: '主题',/);
    assert.match(index, /key: 'theme',/);
  });

  it('列表 / 上传 / 启用 / 删除 / 查看 CSS 五件事都接上了', () => {
    const tab = code(read('src/pages/SystemConfig/tabs/Theme.jsx'));
    assert.match(tab, /listThemes\(\)/);
    assert.match(tab, /activateTheme\(/);
    assert.match(tab, /deleteTheme\(/);
    assert.match(tab, /getThemeCss\(/);
    assert.match(tab, /THEME_UPLOAD_ACTION/);
    // 上传只收 .css，并且带 token 头（走的是 antd Upload 的 action 直传）
    assert.match(tab, /accept="\.css,text\/css"/);
    assert.match(tab, /themeTokenHeader\(\)/);
  });

  it('上传弹窗把规则说清楚了（作用域、上限、会被拒的内容）', () => {
    const tab = read('src/pages/SystemConfig/tabs/Theme.jsx');
    assert.match(tab, /data-ui/);
    assert.match(tab, /512KB/);
    assert.match(tab, /javascript:/);
    assert.match(tab, /docs\/features\/theme\.md/);
  });

  it('内置主题不给删除按钮，正在使用的也不给', () => {
    const tab = code(read('src/pages/SystemConfig/tabs/Theme.jsx'));
    assert.match(tab, /r\.source === 'upload' \? \(/);
    assert.match(tab, /disabled=\{active === r\.id\}/);
  });

  it('服务层用的是 admin 接口，token 从 localStorage 取', () => {
    // ⚠️ 是 skinTheme.js：同目录的 theme.js 是后台**明暗模式**的工具，别覆盖它
    const svc = code(read('src/services/van-blog/skinTheme.js'));
    assert.match(svc, /\/api\/admin\/theme\/all/);
    assert.match(svc, /\/api\/admin\/theme\/active/);
    assert.match(svc, /THEME_UPLOAD_ACTION = '\/api\/admin\/theme\/upload'/);
    assert.match(svc, /localStorage\.getItem\('token'\)/);
    // ⚠️ 取 CSS 原文必须走**普通 JSON 接口**：umi 的 errorConfig.adaptor 会对每个响应
    //    跑 adaptAdminResponse，拿到裸 text/css 就抛 BizError（parseResponse 在 adaptor
    //    之后才生效，救不回来）。所以这里断言的是"没有"那两个开关。
    assert.doesNotMatch(svc, /parseResponse/);
    assert.doesNotMatch(svc, /responseType: 'text'/);
  });

  it('站点配置里的「界面风格」会列出上传的主题，但初始化向导阶段不去调鉴权接口', () => {
    const form = code(read('src/components/SiteInfoForm/index.tsx'));
    assert.match(form, /listThemes\(\)/);
    // 初始化时还没登录，调 /api/admin/** 必定 401，所以那时只给内置项
    assert.match(form, /props\.isInit/);
    assert.match(form, /Apple 风格（推荐）/);
    assert.match(form, /自定义/);
  });
});

describe('主题（前台皮肤）：服务端接线', () => {
  it('ThemeProvider / 两个控制器都注册进了 app.module', () => {
    const mod = code(readRepo('packages/server/src/app.module.ts'));
    assert.match(mod, /ThemeProvider,/);
    assert.match(mod, /ThemeController,/);
    assert.match(mod, /PublicThemeController,/);
  });

  it('主题 CSS 存在图床目录的 themes/ 下（跟着静态文件一起备份）', () => {
    const provider = code(readRepo('packages/server/src/provider/theme/theme.provider.ts'));
    assert.match(provider, /THEME_SUBDIR = 'themes'/);
    assert.match(provider, /config\.staticPath/);
    // 文件名带内容 hash，重新上传后 URL 变化，中间层缓存自然失效
    assert.match(provider, /\$\{id\}-\$\{hash\}\.css/);
  });

  it('启用主题会触发一次全量渲染（前台是静态生成的）', () => {
    const provider = code(readRepo('packages/server/src/provider/theme/theme.provider.ts'));
    assert.match(provider, /activeAll\(/);
    assert.match(provider, /updateSiteInfo\(\{ uiStyle: id \}/);
  });

  it('后台看 CSS 走 JSON 信封，公开的 theme.css 才是 text/css', () => {
    const adminCtl = code(readRepo('packages/server/src/controller/admin/theme/theme.controller.ts'));
    // 后台接口必须回 {statusCode, data:{css}}，否则 umi 的 adaptor 会抛 BizError
    assert.match(adminCtl, /statusCode: 200,\s*data: \{[\s\S]*?css: text,/);
    assert.doesNotMatch(adminCtl, /res\.type\('text\/css/);
    const pub = code(readRepo('packages/server/src/controller/public/theme.controller.ts'));
    // 给浏览器当样式表的那份必须是裸 CSS
    assert.match(pub, /text\/css/);
  });

  it('公开接口用稳定地址 + ETag/no-cache（换主题不依赖页面重新渲染）', () => {
    const ctl = code(readRepo('packages/server/src/controller/public/theme.controller.ts'));
    assert.match(ctl, /@Get\('\/theme\.css'\)/);
    assert.match(ctl, /Cache-Control', 'no-cache'/);
    assert.match(ctl, /ETag/);
    assert.match(ctl, /304/);
    // 内置主题没有独立文件，返回 204 而不是 404（前台挂了 link 也不该报错）
    assert.match(ctl, /status\(204\)/);
  });

  it('校验规则挡住了注入面，也允许正常的主题', () => {
    const dto = code(readRepo('packages/server/src/types/theme.dto.ts'));
    assert.match(dto, /THEME_MAX_BYTES = 512 \* 1024/);
    assert.match(dto, /THEME_ID_RE = \/\^\[a-z0-9\]/);
    for (const bad of ['javascript', 'expression', 'behavior', '-moz-binding', '</style', '<script']) {
      assert.ok(dto.includes(bad), `校验里应该拦 ${bad}`);
    }
    // 扫描的是去掉注释之后的文本（示例主题的注释里就会提到这些词）
    assert.match(dto, /withoutComments/);
  });

  it('内置主题是 default 与 apple，且不入库', () => {
    const dto = readRepo('packages/server/src/types/theme.dto.ts');
    assert.match(dto, /id: 'default'/);
    assert.match(dto, /id: 'apple'/);
    assert.match(dto, /source: 'builtin'/);
  });
});

describe('主题：不要和后台的明暗模式搞混', () => {
  it('services/van-blog/theme.js 仍然是明暗模式工具（皮肤接口在 skinTheme.js）', () => {
    // ⚠️ 用 code() 剥掉注释再断言：skinTheme.js 的注释里正好写了
    //    "别和 theme.js 搞混，那个是 getInitTheme / decodeAutoTheme …"，
    //    不剥的话 doesNotMatch 会被自己的注释满足（这个坑本仓库已经踩过八次）。
    const dark = code(read('src/services/van-blog/theme.js'));
    assert.match(dark, /getInitTheme/);
    assert.match(dark, /decodeAutoTheme/);
    assert.match(dark, /beforeSwitchTheme/);
    assert.doesNotMatch(dark, /api\/admin\/theme/);
    const skin = code(read('src/services/van-blog/skinTheme.js'));
    assert.match(skin, /api\/admin\/theme\/all/);
    assert.doesNotMatch(skin, /getInitTheme/);
  });
});

describe('主题：文档', () => {
  it('有主题开发文档，且包含教程、钩子表、限制与接口', () => {
    const doc = readRepo('docs/features/theme.md');
    assert.match(doc, /# 主题（前台皮肤）/);
    assert.match(doc, /从零写一个主题/);
    assert.match(doc, /data-ui/);
    assert.match(doc, /\.vanblog-article-page/);
    assert.match(doc, /html\.dark/);
    assert.match(doc, /512KB/);
    assert.match(doc, /\/api\/public\/theme\.css/);
    assert.match(doc, /theme-demo\.css/);
  });

  it('示例主题文件存在，是一份可直接上传的完整 CSS', () => {
    const demo = readRepo('docs/.vuepress/public/theme-demo.css');
    assert.ok(demo.length > 1000, '示例主题太短，不像一份能用的主题');
    assert.match(demo, /\[data-ui='warm-paper'\]/);
    assert.match(demo, /html\.dark \[data-ui='warm-paper'\]/);
    assert.match(demo, /\.vb-root/);
    assert.match(demo, /\.vanblog-article-page/);
    // 示例里不该出现会被服务端拒掉的东西
    assert.doesNotMatch(
      demo.replace(/\/\*[\s\S]*?\*\//g, ''),
      /javascript:|expression\(|<\/style|<script/i,
    );
  });

  it('站点设置文档指向主题文档', () => {
    const cfg = readRepo('docs/features/config.md');
    assert.match(cfg, /theme\.md/);
  });
});
