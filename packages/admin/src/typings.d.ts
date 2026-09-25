/**
 * 🔴 类型检查用的环境声明（`tsconfig.typecheck.json` 会把它纳入编译）。
 *
 * 为什么需要这个文件：umi 3 在**运行时**由 webpack 的 loader 处理样式导入，
 * 但 `tsc --noEmit` 不经过 webpack，所以它看不到这些模块的类型 ⇒ 报 TS2307
 * `Cannot find module ...`。实测这类报错有 2 处：`components/ThemeButton/index.tsx`
 * 导入的同目录 less，以及 `components/Editor/index.tsx` 导入的 `katex/dist/katex.css`。
 *
 * ⚠️ 已核实 umi 3.5.41 与 @umijs/* **都没有**自带样式模块的 ambient 声明
 * （对 node_modules/umi 与 node_modules/@umijs 搜「星号点 less」的模块声明 = 0 命中），
 * 所以这不是重复声明、也不会与上游冲突。
 *
 * 🔴 CSS Modules 的形状：`import styles from './index.less'` 拿到的是「类名 → 类名」的映射，
 * 所以声明成只读的字符串索引签名。这样 `styles.foo` 是 `string`（可传给 `className`），
 * 而拼错类名不会被类型检查抓到 —— ⚠️ 这是 CSS Modules 在 TypeScript 里的固有取舍，
 * 要更强的保证需要生成 `.less.d.ts`（例如 typed-css-modules），本仓库没有那个工具链，不做。
 *
 * ⚠️ 副作用式导入（`import 'katex/dist/katex.css'`，没有绑定名）由同样的模块声明覆盖 ——
 * TypeScript 对无绑定的导入也会去查模块声明 ⇒ **不要再为它单独写一份，避免出现第二份口径。**
 */

declare module '*.less' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

/**
 * 静态资源：目前 `src` 下的 `.ts`/`.tsx` 里没有直接导入图片（实测 0 处），
 * 但 admin 的 `.jsx` 里有，而将来把 `.jsx` 迁成 `.tsx` 时就会需要 ⇒ 一并声明，
 * 免得那时又加一份重复的 typings。
 */
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.gif' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
