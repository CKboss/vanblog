import type { BytemdPlugin } from "bytemd";
import { visit } from "unist-util-visit";
import remarkSupersub from "remark-supersub";
import remarkGemoji from "remark-gemoji";
import remarkDefinitionList from "remark-definition-list";
import { remarkAlert } from "remark-github-blockquote-alert";
import { pandocMark } from "micromark-extension-mark";
// 经 ./mdastUtilMark 中转而不是直接 import "mdast-util-mark"：那个包把编译不过的
// 源码 index.ts 发进了 npm 包，TS 5 会命中它（详见该文件顶部的说明）。中转的
// 运行时就是包的 index.js（main 指向的文件），行为一字不变。
import { pandocMarkFromMarkdown, pandocMarkToMarkdown } from "./mdastUtilMark";
import { normalizeHeadingText } from "../../utils/headingText";
import { headingHashHref } from "../../utils/headingHash";

/**
 * 「两边都缺」的 6 种语法一次性补齐。
 *
 * ⚠️ 前台（本文件）与后台编辑器（packages/admin/src/components/Editor/plugins/extraSyntax.ts）
 * **必须保持同一套插件与同样的顺序**，否则又会出现「预览和发布不一样」。
 * `packages/admin/tests/unit/markdownConsistency.test.js` 与
 * `packages/website/__tests__/extraSyntax.spec.ts` 会钉住这一点。
 *
 * 版本选择理由：bytemd 1.21 锁的是 unified 10 / remark-parse 10 / mdast v3，
 * 所以只能用同一世代的插件（这些包的更高大版本已经是 mdast v4 / unified 11）：
 * - remark-supersub@1        （unist-util-visit 4）
 * - remark-gemoji@7          （package.json 里明确 peer unified ^10、@types/mdast ^3）
 * - remark-definition-list@1 （micromark-extension-definition-list 1 = micromark 3 世代）
 * - remark-github-blockquote-alert@2（只依赖 unist-util-visit，运行时与树版本无关）
 * - micromark-extension-mark@1 + mdast-util-mark@1（`==高亮==` 的官方扩展对）
 */

/** `[[toc]]` 或 `[toc]`（单独成段、大小写不限） */
export const TOC_MARKER_RE = /^\s*\[\[?toc\]?\]\s*$/i;

/** 取一个 mdast 节点的纯文本（不引额外依赖，mdast-util-to-string 只是 transitive） */
export function mdastText(node: any): string {
  if (!node) {
    return "";
  }
  if (node.type === "text" || node.type === "inlineCode" || node.type === "html") {
    return String(node.value ?? "");
  }
  if (Array.isArray(node.children)) {
    return node.children.map(mdastText).join("");
  }
  return "";
}

/**
 * `==高亮==` → `<mark>`。
 *
 * remark 生态里没有一个在维护的 `remark-mark` 封装包（npm 上那个是 0.0.0 占位），
 * 但官方的 **micromark 扩展 + mdast 扩展**是有的，按 remark 插件的标准写法拼起来即可
 * （和 remark-gfm / remark-math 的做法一致）。
 */
export function remarkMark(this: any) {
  const data = this.data();
  const add = (field: string, value: unknown) => {
    const list = data[field] ? data[field] : (data[field] = []);
    list.push(value);
  };
  // 这两个包导出的是**扩展对象**（不是工厂函数），micromark 的语法扩展则两种形态都有，
  // 所以按类型判断一下，别写死 `()`
  const syntax: any =
    typeof pandocMark === "function" ? (pandocMark as any)() : pandocMark;
  add("micromarkExtensions", syntax);
  // 注意字段名：**unified 10 / remark 14 世代**读的是 `fromMarkdownExtensions` /
  // `toMarkdownExtensions`（`mdastUtilFromMarkdownExtensions` 是 remark 15 的写法，
  // 写错了不会报错，只会静默失效 —— `==高亮==` 就变成纯文本）。
  // 同世代的 remark-definition-list 用的也是这两个名字。
  add("fromMarkdownExtensions", pandocMarkFromMarkdown);
  add("toMarkdownExtensions", pandocMarkToMarkdown);
}

/** 给 `mark` 节点标上 hast 标签名，remark-rehype 才会输出 `<mark>` 而不是把内容摊平。 */
export const markToHtml = () => (tree: any) => {
  visit(tree, "mark" as any, (node: any) => {
    node.data = { ...(node.data || {}), hName: "mark" };
  });
};

/**
 * `[[toc]]` → 目录列表。
 *
 * 标准的 `remark-toc` 只认**标题**形式的标记（例如 `## 目录`），不认 `[[toc]]`；
 * 而且它用 github-slugger 生成锚点，和本站标题的 id 规则（`normalizeHeadingText` 原文）
 * 对不上，链接会点不动。所以这里自己生成标准的嵌套列表，锚点复用 Heading 插件那套
 * `headingHashHref()`，保证和悬停 `#` 永久链接指向同一个 id。
 */
export const remarkTocMarker = () => (tree: any) => {
  const children = Array.isArray(tree?.children) ? tree.children : [];
  let markerIndex = -1;
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node?.type !== "paragraph" || node.children?.length !== 1) {
      continue;
    }
    if (node.children[0].type === "text" && TOC_MARKER_RE.test(String(node.children[0].value))) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) {
    return;
  }

  type Item = { text: string; level: number; children: Item[] };
  const roots: Item[] = [];
  const stack: Item[] = [];
  for (const node of children) {
    if (node?.type !== "heading") {
      continue;
    }
    const text = normalizeHeadingText(mdastText(node));
    if (!text) {
      continue;
    }
    const item: Item = { text, level: Number(node.depth) || 1, children: [] };
    while (stack.length && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    if (stack.length) {
      stack[stack.length - 1].children.push(item);
    } else {
      roots.push(item);
    }
    stack.push(item);
  }

  const toListNode = (items: Item[]): any => ({
    type: "list",
    ordered: false,
    spread: false,
    children: items.map((item) => ({
      type: "listItem",
      spread: false,
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: headingHashHref(item.text),
              title: null,
              children: [{ type: "text", value: item.text }],
            },
          ],
        },
        ...(item.children.length ? [toListNode(item.children)] : []),
      ],
    })),
  });

  if (!roots.length) {
    children.splice(markerIndex, 1);
    return;
  }
  children.splice(markerIndex, 1, toListNode(roots));
};

/** 一次性把 6 种语法都挂上（顺序：先语法扩展，再改写，最后 TOC）。 */
export function extraSyntax(): BytemdPlugin {
  return {
    remark: (processor) =>
      // 这两个是「返回 transformer 的函数」，运行时就是标准的 unified 插件，
      // 但 bytemd 带的 unified 类型只认 PluggableList/Plugin 的签名，直接传会报类型错，
      // 所以按插件签名断言一次（行为已由 extraSyntax.spec.ts 的真实渲染测试覆盖）。
      processor
        .use(remarkMark as any)
        .use(markToHtml as any)
        .use(remarkSupersub as any)
        .use(remarkGemoji as any)
        .use(remarkDefinitionList as any)
        .use(remarkAlert as any)
        .use(remarkTocMarker as any),
  };
}
