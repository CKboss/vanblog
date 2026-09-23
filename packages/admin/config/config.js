// https://umijs.org/config/
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin';
import { defineConfig } from 'umi';
import defaultSettings from './defaultSettings';
import proxy from './proxy';
import routes from './routes';
const { REACT_APP_ENV } = process.env;
export default defineConfig({
  hash: true,
  base: '/admin/',
  devServer: {
    https: false,
    port: 3002,
    headers: {
      'Cache-Control': 'private, no-store, no-cache, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
    },
  },
  publicPath: process.env.EEE === 'production' ? '/admin/' : '/',
  antd: {},
  /**
   * 🔴 多语言（第一期：安装页 + 后台骨架 + 一键切换）。
   *
   * `@umijs/plugin-locale@0.16.0` 随 `@umijs/preset-react` 早已装好，但它是
   * `enableBy: api.EnableBy.config`（plugin-locale `lib/index.js`）⇒ **必须有这个顶层
   * `locale` 键才会注册**。注册之后自动拿到三件事：
   *   1. `antd: true` ⇒ 插件自动用 `ConfigProvider` 接管 antd 的 locale。
   *      🔴 这顺带修掉一个既有缺陷：此前 admin 源码没有任何 `ConfigProvider` 配置，
   *      而 antd 4 的 `lib/locale/default.js` 是用 **`en_US`** 组装的 ⇒ 后台一直是
   *      「自己的文案全中文、antd 组件文案全英文」的混用状态（分页器 `1-10 of 100`、
   *      Modal 的 OK/Cancel、Table 空状态 `No Data`、DatePicker 的月份与 Today）。
   *   2. `plugin-layout` 的头部自动渲染 `<SelectLang />`：它的
   *      `genRenderRightContent({ locale: api.hasPlugins(['@umijs/plugin-locale']) })`
   *      **只看插件有没有注册**，与下面的 `layout.locale` 无关 ⇒ 一键切换自动出现在后台头部。
   *      ⚠️ 但 `/init` 路由是 `layout: false`（不带 ProLayout）⇒ 安装页需要自己放一个
   *      `<SelectLang />`，见 `pages/InitPage/index.tsx`。
   *   3. 语言包是**静态 ES import 编译进 bundle**（`templates/locale.tpl`），不是运行时拉取 ⇒
   *      🔴 安装页在「站点尚未初始化、服务端接口还不能依赖」的阶段也能正常切换语言。
   *
   * 各选项的理由：
   * - `default: 'zh-CN'` ⇒ **对现有用户视觉零变化**（除了 antd 组件文案从英文变中文，那是修缺陷）。
   *   🔴 这个值同时充当站长裁定的「站点级默认语言」：首次访问的初值。
   *   ⚠️ 第一期**刻意不把它做成 `siteInfo` 字段**（那会牵动 `siteInfoFieldParity` 守卫：
   *   它钉「表单 ↔ DTO ↔ 文档三方字段集合相等」⇒ 加字段要同一次改三处）。
   *   🔴 「可在后台配置的站点默认语言」留作独立一期，届时需要连带处理那条守卫。
   * - `useLocalStorage: true` ⇒ 个人选择**跟人走**（存 localStorage），符合站长裁定。
   * - `baseNavigator: false` ⇒ 🔴 **不按浏览器语言自动切换**。否则一个英文浏览器的站长
   *   升级后会突然发现后台变成英文（而第一期的翻译覆盖面还不全，那会看起来像坏了）。
   *   语言应当由用户**显式**点切换器选择。
   * - ⚠️ `ignoreMomentLocale: true` **保持不变**：它用的是 webpack
   *   `IgnorePlugin({ resourceRegExp: /^\.\/locale$/, contextRegExp: /moment$/ })`，
   *   只拦 moment **自己内部**那个动态 `require('./locale')`（= 全部 135 个语言包、约 740KB）。
   *   而 plugin-locale 的模板是 `import 'moment/locale/{{.}}'` 这种**显式静态导入**
   *   （resource 是 `./zh-cn`、context 是 `moment/locale`，**不匹配上面那对正则**）⇒
   *   🔴 **需要的语言包照样会被打进来，且插件的 `_onCreate()` 会自动 `moment.locale(...)`**。
   *   所以「启用 i18n 就必须关掉 ignoreMomentLocale」这个担忧**不成立**：
   *   保持 true 只多约 11KB（zh-cn 4.5K + zh-tw 3.7K + en-gb 2.6K），关掉则要 +740KB。
   */
  locale: {
    default: 'zh-CN',
    antd: true,
    baseNavigator: false,
    useLocalStorage: true,
  },
  dva: {
    hmr: true,
  },
  layout: {
    // https://umijs.org/zh-CN/plugins/plugin-layout
    // 🔴 由 false 改成 true：这是 plugin-layout 自己的 `layoutOpts.locale`（会被 JSON 序列化进
    // 生成的 `Layout.tsx`、当作 ProLayout 的 userConfig），语义是「这个布局是 locale-aware 的」。
    // ⚠️ 它**不控制**头部 `<SelectLang />` 的渲染 —— 那个只看 locale 插件有没有注册（见上面的注释）；
    // 但保持 false 会让布局层拿不到 locale 语义，所以一并打开。
    locale: true,
    siderWidth: 208,
    ...defaultSettings,
  },
  dynamicImport: {
    loading: '@ant-design/pro-layout/es/PageLoading',
  },
  // 后台不再兼容 IE11：`targets: { ie: 11 }` 会把大量 core-js polyfill 打进
  // 每个页面都要下载的 umi.js（实测 1.1MB）。antd 4 与 ProComponents 本身在 IE11 下
  // 也有大量问题，实际上早就没人用 IE 管理博客了。
  targets: {
    chrome: 80,
  },
  // umi routes: https://umijs.org/docs/routing
  routes,
  access: {},
  // Theme for antd: https://ant.design/docs/react/customize-theme-cn
  theme: {
    // 如果不想要 configProvide 动态设置主题需要把这个设置为 default
    // 只有设置为 variable， 才能使用 configProvide 动态设置主色调
    // https://ant.design/docs/react/customize-theme-variable-cn
    'root-entry-name': 'variable',
  },
  // esbuild is father build tools
  // https://umijs.org/plugins/plugin-esbuild
  esbuild: {},
  title: false,
  ignoreMomentLocale: true,
  proxy: proxy[REACT_APP_ENV || 'dev'],
  manifest: {
    basePath: '/',
  },
  // Fast Refresh 热更新
  fastRefresh: {},
  nodeModulesTransform: {
    type: 'none',
  },
  // MFSU（开发时把 node_modules 预打包成 Module Federation 远程包）。
  //
  // ⚠️ 它能开着的前提是根目录 `patches/` 里那两个 pnpm patch：
  // umi3 的 MFSU 用老版 resolve 解析裸包名，只读 `main`/`module`，**不认 `exports` 映射**。
  // `remark-supersub`、`remark-github-blockquote-alert` 是 ESM-only、只有 exports 没有 main，
  // 于是 MFSU 预打包直接 `AssertionError: filePath not found of xxx`，
  // mf-va_remoteEntry.js 生不出来，后台整页 `ScriptExternalLoadError` 白屏。
  // 两个 patch 只是给它们补上 `main`/`module`（exports 优先级更高，正常解析行为不变）。
  //
  // 如果升级这两个包导致 patch 失效（pnpm 会明确报错），要么重新 `pnpm patch` 一次，
  // 要么把这里改成 `mfsu: false`（代价：dev 冷启动 ~25s 变 ~2min；生产构建不用 MFSU，不受影响）。
  // 改成子路径导入（pkg/lib/index.js）是**行不通**的：webpack 5 会按 exports 校验，
  // 而 ./lib/index.js 没被 export，会报 Module not found。
  mfsu: {},
  webpack5: {},
  exportStatic: {},
  chainWebpack(memo, { env, webpack, createCSSRule }) {
    memo
      .plugin('monaco-editor-webpack-plugin')
      .use(MonacoWebpackPlugin, [
        { languages: ['css', 'json', 'html', 'javascript', 'typescript'] },
      ]);
  },
});
