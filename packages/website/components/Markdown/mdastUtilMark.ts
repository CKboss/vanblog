/**
 * `mdast-util-mark@1.0.0` 的类型化运行时中转（唯一消费者：./extraSyntax.ts）。
 *
 * 为什么需要这个文件：该包把**源码** `index.ts` 误发进了 npm 包（包里同时有
 * index.js / index.d.ts / index.ts，main 指 index.js，且没有 types 字段）。
 * TypeScript 解析 main 时会先剥掉 `.js` 后缀做 `.ts` 替代，于是永远命中那份
 * index.ts —— 而它对着自己声明的依赖范围实际装出来的小版本根本编译不过
 * （mdast-util-to-markdown 1.5.0 的 `Info` 要求 TrackFields；micromark-util-types
 * 1.1.0 的 `ConstructName` 联合里没有 `'mark'`）。`skipLibCheck` 只跳过 .d.ts、
 * 跳不过 .ts，website 的 tsc 因此会在 node_modules 内部报 2 个错。
 *
 * 修法：tsconfig.json 的 `paths` 把裸包名 "mdast-util-mark" 映射到包内**编译
 * 成品** `index.d.ts`（TS 对 paths 的查找先于 node_modules 解析，`.d.ts` 目标
 * 不会再被 `.js→.ts` 替代规则带回 index.ts）。类型问题就此了断；这个文件则把
 * 导入收拢到一处：运行时仍是包 main 指向的 index.js（ESM 具名再导出，webpack
 * 与 vitest 各自照常解析），`__tests__/mdastUtilMarkTypes.spec.ts` 钉住导出
 * 形状、包版本 1.0.0、以及与官方 index.d.ts 值导出面的一致性。
 */
export {
  pandocMarkFromMarkdown,
  pandocMarkToMarkdown,
} from "mdast-util-mark";
