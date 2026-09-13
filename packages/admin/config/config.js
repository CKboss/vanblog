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
  dva: {
    hmr: true,
  },
  layout: {
    // https://umijs.org/zh-CN/plugins/plugin-layout
    locale: false,
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
