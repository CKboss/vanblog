import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import MarkdownViewer from "../components/Markdown/MarkdownViewer";
import { Viewer as BytemdReactViewer } from "@bytemd/react";
import { sanitizeMarkdownSchema } from "../utils/markdownSanitize";

/**
 * 前台不再从 `@bytemd/react` 取 Viewer（那个入口第一行是 `import * as bytemd from "bytemd"`
 * 并且把 Editor 一起 re-export，等于告诉 webpack"bytemd 的每个导出都被用了"），
 * 改成内联一份只用 `getProcessor` 的 Viewer。
 *
 * 这组测试盯两件事：
 *  1. **渲染结果与官方 Viewer 逐字节一致**（同一份 markdown、同一套 sanitize / remarkRehype）；
 *  2. 前台源码里再没有任何地方 import `@bytemd/react`（结构上保证 Editor 进不了依赖图）。
 */
const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");
/** 负面断言前先剥掉注释：仓库里已经十次踩过"断言命中的是记录这个坑的注释" */
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

(globalThis as { React?: typeof React }).React = React;

const SAMPLES: Array<[string, string]> = [
  ["纯文本", "hello world"],
  ["标题与列表", "# 标题\n\n- a\n- b\n\n## 二级\n"],
  ["GFM 表格与删除线", "| a | b |\n| - | - |\n| 1 | 2 |\n\n~~删掉~~\n"],
  ["围栏代码块", "```js\nconst a = 1;\n```\n"],
  ["行内代码与链接", "看 `code` 和 [链接](https://example.com)\n"],
  [
    "原始 HTML（走 sanitize 白名单）",
    '<u>下划线</u> <mark>高亮</mark> <script>alert(1)</script>\n',
  ],
  ["定义列表", "术语\n: 解释\n"],
  ["blockquote 与脚注", "> 引用\n\n正文[^1]\n\n[^1]: 脚注\n"],
  ["空串", ""],
];

describe("内联 Viewer 与 @bytemd/react 的 Viewer 输出一致", () => {
  for (const [name, value] of SAMPLES) {
    it(name, () => {
      const opts = {
        value,
        plugins: [],
        sanitize: sanitizeMarkdownSchema,
        remarkRehype: { allowDangerousHtml: true },
      };
      const mine = renderToStaticMarkup(createElement(MarkdownViewer, opts));
      const theirs = renderToStaticMarkup(
        createElement(BytemdReactViewer as any, opts)
      );
      expect(mine).toBe(theirs);
    });
  }

  it("script 仍然被 sanitize 掉（内联不能顺手放松白名单）", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, {
        value: '<script>alert(1)</script><u>ok</u>',
        plugins: [],
        sanitize: sanitizeMarkdownSchema,
      })
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("<u>ok</u>");
  });

  it("渲染抛错时不炸页面（和官方 Viewer 一样吞掉异常、输出空串）", () => {
    const boom = {
      remark: () => {
        throw new Error("boom");
      },
    };
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, { value: "x", plugins: [boom] as any })
    );
    expect(html).toContain('class="markdown-body"');
    expect(html).not.toContain("boom");
  });

  it("容器结构不变：class=markdown-body + dangerouslySetInnerHTML", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, { value: "# hi", plugins: [] })
    );
    expect(html.startsWith('<div class="markdown-body">')).toBe(true);
    expect(html).toContain("<h1");
  });
});

describe("前台不再依赖 @bytemd/react（Editor 进不了依赖图）", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };

  it("源码里没有任何 @bytemd/react 的 import（测试文件除外）", () => {
    const offenders: string[] = [];
    for (const file of walk(websiteRoot)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const src = strip(readFileSync(file, "utf8"));
      if (/from\s+["']@bytemd\/react["']/.test(src)) {
        offenders.push(path.relative(websiteRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("渲染外壳用的是内联 Viewer，并且只从 bytemd 取 getProcessor", () => {
    const view = strip(readSrc("components/Markdown/MarkdownView.tsx"));
    expect(view).toContain('import MarkdownViewer from "./MarkdownViewer"');
    expect(view).toContain("<MarkdownViewer");
    expect(view).not.toContain("@bytemd/react");

    const viewer = strip(readSrc("components/Markdown/MarkdownViewer.tsx"));
    expect(viewer).toContain('import { getProcessor } from "bytemd"');
    // 只用 Viewer 需要的那几个 hook；不能出现 Editor 相关的东西
    expect(viewer).not.toContain("new Editor");
    expect(viewer).not.toContain("codemirror");
    expect(viewer).toContain("dangerouslySetInnerHTML");
  });

  it("viewerEffect 契约保留：插件的 viewerEffect 与清理函数都要接上", () => {
    const viewer = strip(readSrc("components/Markdown/MarkdownViewer.tsx"));
    expect(viewer).toContain("viewerEffect");
    expect(viewer).toMatch(/markdownBody,\s*file/);
    // mermaid / 代码复制按钮 / 图片放大都靠 viewerEffect 返回的清理函数
    expect(viewer).toMatch(/cbs\?\.forEach\(\(cb\) => cb && cb\(\)\)/);
    // 主题切换时靠 key 强制重挂，才会重新跑 viewerEffect（mermaid 深浅色）
    expect(readSrc("components/Markdown/MarkdownView.tsx")).toMatch(
      /key=\{paintKey\}/
    );
  });
});
