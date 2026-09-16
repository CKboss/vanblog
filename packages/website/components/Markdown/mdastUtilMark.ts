/**
 * `mdast-util-mark@1.0.0` 的类型化运行时中转（唯一消费者：./extraSyntax.ts）。
 *
 * 为什么需要这个文件：该包把**源码** `index.ts` 误发进了 npm 包（包里同时有
 * index.js / index.d.ts / index.ts，main 指 index.js，且没有 types 字段）。
 * TypeScript 解析 main 时会先剥掉 `.js` 后缀做 `.ts` 替代，于是永远命中那份
 * index.ts —— 而它对着自己声明的依赖范围实际装出来的小版本根本编译不过
 * （mdast-util-to-markdown 1.5.0 的 `Info` 要求 TrackFields；micromark-util-types
 * 1.1.0 的 `ConstructName` 联合里没有 `'mark'`）。`skipLibCheck` 只跳过 .d.ts、
 * 跳不过 .ts，website 的 tsc 因此会在 node_modules 内部报错。
 *
 * 不能改别人的包，也不能打 pnpm patch（要动 lockfile）；`paths` 指到包内任何文件
 * 都会被同一条 `.js→.ts` 替代规则带回 index.ts，指到 .d.ts 更危险 —— Next 会把
 * tsconfig paths 原样映射进 webpack 别名，运行时就会把纯声明文件当成模块打包
 * （导出全空，`==高亮==` 直接坏掉）。ambient `declare module` 也不行：文件解析
 * 命中了真实的 index.ts，ambient 声明只在解析**失败**时才兜底。
 *
 * 所以走这个中转：**运行时**用 `require("mdast-util-mark/index.js")` 拿 —— TS 不对
 * require 的字符串实参做模块解析（index.ts 从此不再进程序），而 webpack / vitest /
 * vite 都照常把它解析成 main 指向的同一个 index.js，运行时字节不变；**类型**对照
 * 包内编译成品 `index.d.ts` 在下方镜像（见接口注释）。
 * `__tests__/mdastUtilMarkTypes.spec.ts` 钉住：中转导出与包运行时**引用相等**、
 * 导出形状、包版本 1.0.0、以及本文件与官方 index.d.ts 的值导出面一致。
 *
 * 与官方 index.d.ts 的差别（都是有意为之）：
 * - 不再导出纯类型 `Mark` 接口、也不做对 `mdast` 的 StaticPhrasingContentMap 增强
 *   —— 两者都没有运行时实体，且本站代码只经由 `"mark" as any` 接触 mark 节点
 *   （extraSyntax.ts 的 markToHtml），无人消费该类型；
 * - 两个导出的类型不再按包名引用 mdast-util-from-markdown 的 `Extension` /
 *   mdast-util-to-markdown 的 `Options` —— 那两个包不是 website 的直接依赖
 *   （pnpm 不会提升进 packages/website/node_modules），这里解析不到它们的包名，
 *   只能逐字段镜像（见下）。
 */

/**
 * 镜像 mdast-util-from-markdown@1 的 `Extension = Partial<Config>` 中会被
 * mdast-util-mark 填上的三个字段（Config = {canContainEols, enter, exit, transforms}）。
 * 句柄签名按 v1 的 `Handle = (this: CompileContext, token: Token) => void` 放宽成
 * unknown —— 本站从不直接调用这些句柄，它们是 remark/unified 在生态内部调的。
 */
export interface PandocMarkFromMarkdownExtension {
  canContainEols?: string[];
  enter?: Record<string, (this: unknown, token: unknown) => void>;
  exit?: Record<string, (this: unknown, token: unknown) => void>;
}

/**
 * 镜像 mdast-util-to-markdown@1 `Options` 中 mdast-util-mark 实际填的两个字段
 * （`unsafe?: Array<Unsafe> | null`、`handlers?: Partial<Handlers> | null`；
 * Unsafe = {character, inConstruct?, notInConstruct?}，Handle 返回 string）。
 * Options 的其余几十个可选字段（bullet、emphasis、join…）该包从不填，不镜像。
 */
export interface PandocMarkToMarkdownExtension {
  unsafe?: Array<{
    character: string;
    inConstruct?: string | string[] | null;
    notInConstruct?: string | string[] | null;
  }> | null;
  handlers?: Record<
    string,
    (this: unknown, ...args: unknown[]) => string
  > | null;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("mdast-util-mark/index.js") as {
  pandocMarkFromMarkdown: PandocMarkFromMarkdownExtension;
  pandocMarkToMarkdown: PandocMarkToMarkdownExtension;
};

export const pandocMarkFromMarkdown: PandocMarkFromMarkdownExtension =
  mod.pandocMarkFromMarkdown;
export const pandocMarkToMarkdown: PandocMarkToMarkdownExtension =
  mod.pandocMarkToMarkdown;
