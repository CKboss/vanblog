import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import { parseNavStructure } from "../components/MarkdownTocBar/tools";
import { tocLabelNeedsMath } from "../components/MarkdownTocBar/tocMath";

/**
 * 回归钉子：TOC 标签**不许**把标题原文当 HTML 交出去（公开站源的存储型 XSS / mXSS）。
 *
 * ## 缺陷形状（修之前）
 *
 * `renderTocLabelHtml()` 有两个"原文回退"分支（不含 `$`、以及公式插件还没加载），
 * 都 `return source` —— 未转义的标题原文。而唯一的消费点 `MarkdownTocBar/core.tsx`
 * 把非 null 的返回值直接塞进 `dangerouslySetInnerHTML`：
 *
 *     {mathHtml != null ? <span dangerouslySetInnerHTML={{ __html: mathHtml }} /> : each.text}
 *
 * 标题文本来自 `utils/headingText.ts` 的 `collectHeadingText()`，返回的是**已解码**的
 * text 节点值。所以只要让 `<img src=1 onerror=…>` 落进 text 节点（反斜杠转义 / HTML 实体 /
 * 行内代码三种写法都行），markdown 阶段它是纯文本、sanitize 也放行（不是 html 节点），
 * 到了 TOC 这里却被当 HTML 二次注入 —— **sanitize 之后再注入**，即 mXSS。
 * 裸写 `<img …>` 不行（会被 sanitize 拆掉 onerror），必须借转义绕过。
 *
 * 两点让它比"自伤"严重：
 *  1. 首次渲染**必然**走"插件未加载"那条分支（SSR 阶段动态 import 还没 resolve），
 *     所以 payload 直接进**服务端渲染出的 HTML**，不需要等客户端水合；
 *  2. 触发者不限于管理员 —— 有 `article:create` / `article:update` 的协作者就行
 *     （`packages/server/src/types/access/access.ts`），而后台 token 在**同源** localStorage，
 *     管理员用同一浏览器打开那篇文章即被接管。
 *
 * ## 修法
 *
 * 两个回退分支都改成 `return null`，让消费点走"把 `each.text` 当 React 子节点渲染"的安全分支
 * （那条分支本来就在，`:193`）。用户看到的是纯文本标题（`$E=mc^2$` 也可读），插件加载完
 * `onTocMathReady` 会通知重渲染成 KaTeX —— **功能一点没丢**，所以没有理由用转义去换。
 */

const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");

/**
 * 剥掉注释再扫源码：`tocMath.ts` 里解释"为什么不能 return source"的注释**本身就写着
 * `return source`**，不剥注释的话断言会被自己的说明文字绊倒（本仓库已踩 6 次）。
 * 与 `searchHighlight.spec.ts` 的 `codeOnly` 同一手法。
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/**
 * 三种把 `<img onerror>` 送进 text 节点的写法。
 * ⚠️ 标题里必须有 `$`，否则 `core.tsx:154` 的 `tocLabelNeedsMath()` 判据不成立、
 * 根本不会调 `renderTocLabelHtml` —— 这也正是旧代码里"不含 `$`"那条分支虽然同样
 * `return source`、却在生产上打不到的原因（仍然修掉了，纵深防御）。
 */
const PAYLOADS: { name: string; md: string }[] = [
  {
    name: "反斜杠转义",
    md: "## $x$ \\<img src=1 onerror=alert(document.domain)\\>\n\nbody\n",
  },
  {
    name: "HTML 实体",
    md: "## $x$ &lt;img src=1 onerror=alert(document.domain)&gt;\n\nbody\n",
  },
  {
    name: "行内代码",
    md: "## $x$ `<img src=1 onerror=alert(document.domain)>`\n\nbody\n",
  },
];

/** 复刻 `core.tsx:154` 与 `:190-193` 的判定，得到"真正会被注入的那个字符串"。 */
function injectedHtml(
  render: (text: string) => string | null,
  headingText: string
): string | null {
  const mathHtml = tocLabelNeedsMath(headingText) ? render(headingText) : null;
  return mathHtml != null ? mathHtml : null;
}

function headingTexts(md: string): string[] {
  return parseNavStructure(md).map((item) => item.text);
}

describe("TOC 标签：标题原文绝不被当 HTML 注入", () => {
  it("攻击链的前提成立：至少一种写法能把 <img onerror> 送进标题的 text 节点", () => {
    const landed = PAYLOADS.filter((p) =>
      headingTexts(p.md).some((t) => t.includes("onerror") && /[<&]|`/.test(t))
    );
    // 不是"三种都必须落地"（实体写法可能被解码成 &lt;、行内代码可能保留反引号），
    // 而是**至少一种**能带着 onerror 走到 renderTocLabelHtml —— 否则这条守卫就是空的。
    expect(landed.length).toBeGreaterThanOrEqual(1);
    // 并且它们确实会被判为"需要公式"（否则根本进不到危险分支）
    for (const p of PAYLOADS) {
      for (const t of headingTexts(p.md)) {
        expect(tocLabelNeedsMath(t)).toBe(true);
      }
    }
  });

  it("插件未加载时（首次渲染 / SSR 必然走这条）：注入的 HTML 里没有裸 < 也没有 onerror", async () => {
    vi.resetModules();
    const fresh = await import("../components/MarkdownTocBar/tocMath");
    expect(fresh.isTocMathLoaded()).toBe(false);

    for (const p of PAYLOADS) {
      for (const text of headingTexts(p.md)) {
        const out = fresh.renderTocLabelHtml(text);
        // 主判据（与修法无关）：交出去的东西不含裸 `<`，也不含事件属性
        expect(out === null || !out.includes("<"), `${p.name}: 含裸 <`).toBe(true);
        expect(out === null || !/onerror/i.test(out), `${p.name}: 含 onerror`).toBe(true);
        // 本修法选的是 null（让消费点渲染纯文本）
        expect(out, `${p.name}: 应返回 null`).toBeNull();
        // 端到端：真正会被 dangerouslySetInnerHTML 注入的值
        expect(injectedHtml(fresh.renderTocLabelHtml, text)).toBeNull();
      }
    }
    // 直接传字面量也一样（不经过 markdown 解析）
    expect(fresh.renderTocLabelHtml("$x$ <img src=1 onerror=alert(1)>")).toBeNull();
  });

  it("插件加载后：payload 也进不去（sanitize 会拆掉事件属性），而合法公式照常渲染成 KaTeX", async () => {
    vi.resetModules();
    const loaded = await import("../components/MarkdownTocBar/tocMath");
    await loaded.ensureTocMathLoaded();
    expect(loaded.isTocMathLoaded()).toBe(true);

    // 反证之一：加载后走的不是回退分支，而是真的过了 sanitize 的渲染管线。
    // ⚠️ 判据不是"不许出现 `<img`" —— 实测 sanitize **允许** img/a 这类标签本身
    //    （`$x$ <img src=1 onerror=alert(1)>` → `<img src="1">`，`<a href="javascript:…">k</a>` → `<a>k</a>`，
    //    `<svg onload=alert(1)>` → 整块删除）。安全性质是**事件属性与 javascript: URL 活不下来**，
    //    把断言写成"不许有 img"既不准确也会掩盖真正要盯的东西。
    for (const p of PAYLOADS) {
      for (const text of headingTexts(p.md)) {
        const out = String(loaded.renderTocLabelHtml(text));
        expect(/onerror/i.test(out), `${p.name}: onerror 活下来了`).toBe(false);
        expect(/\son[a-z]+\s*=/i.test(out), `${p.name}: 有事件属性活下来了`).toBe(false);
        expect(/javascript:/i.test(out), `${p.name}: javascript: URL 活下来了`).toBe(false);
        expect(out).toMatch(/class="katex"/); // 证明确实走了渲染管线，不是回退
      }
    }
    // 另外两种载荷形状（加载后）
    for (const raw of [
      '$x$ <a href="javascript:alert(document.domain)">k</a>',
      "$x$ <svg onload=alert(document.domain)>",
      "$x$ <img src=1 onerror=alert(document.domain)>",
    ]) {
      const out = String(loaded.renderTocLabelHtml(raw));
      expect(/javascript:/i.test(out)).toBe(false);
      expect(/\son[a-z]+\s*=/i.test(out)).toBe(false);
    }

    // 正例：别把功能修坏 —— 合法数学标题仍渲染成 KaTeX
    const math = loaded.renderTocLabelHtml("比较 $A$<$B$");
    expect(math).not.toBeNull();
    expect(math).toMatch(/class="katex"/);
    expect(math).not.toContain("$A$");
    const frac = loaded.renderTocLabelHtml("偏导数 $\\frac{\\partial z}{\\partial x}$");
    expect(frac).toMatch(/class="katex"/);
  });

  it("源码级：tocMath.ts 里不许再出现「直接 return 未转义 source」的形状", () => {
    const code = codeOnly(readSrc("components/MarkdownTocBar/tocMath.ts"));
    expect(code).not.toMatch(/return\s+source\s*;/);
    // 返回类型必须允许 null（否则下一个人只能继续返回字符串）
    expect(code).toMatch(/renderTocLabelHtml\(text: string\): string \| null/);

    // ⚠️ 逐条检查 `renderTocLabelHtml` **函数体内**的每个 return：
    //    只允许 `return null;` 与 `return unwrapSingleParagraph(html);`。
    //    不用宽松的 `/return\s+String\(\s*text/` 之类整文件正则 —— 那会误伤
    //    `tocLabelNeedsMath()` 里合法的 `return String(text || "").includes("$")`
    //    （第一版就是这么写错的：断言红了，但红的原因是误报而不是漏洞）。
    const start = code.indexOf("export function renderTocLabelHtml");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, code.indexOf("\n}", start) + 2);
    // ⚠️ 用 `match(/…/g)` 而不是 `[...body.matchAll(…)]`：本包的 tsconfig target 低于 es2015，
    //    展开迭代器会报 TS2802（要 --downlevelIteration）。仓库里其它 spec 也是这个写法。
    const returns = (body.match(/return\s+[^;\n]+;/g) || []).map((s) =>
      s.replace(/^return\s+/, "").replace(/;$/, "").trim()
    );
    expect(returns.length).toBeGreaterThanOrEqual(3);
    for (const r of returns) {
      expect(["null", "unwrapSingleParagraph(html)"], `意外的 return：${r}`).toContain(r);
    }

    // 消费点必须保留"null 就把文本当 React 子节点"的安全分支
    const core = codeOnly(readSrc("components/MarkdownTocBar/core.tsx"));
    expect(core).toMatch(/mathHtml != null \?/);
    expect(core).toMatch(/dangerouslySetInnerHTML=\{\{ __html: mathHtml \}\}/);
  });

  it("反证的反证：上面那条正则确实能匹配旧形状（否则它是空转的）", () => {
    const oldShape = "  if (!mathPluginFactory) {\n    void ensureTocMathLoaded();\n    return source;\n  }";
    expect(codeOnly(oldShape)).toMatch(/return\s+source\s*;/);
    // 注释里写着 return source 不该触发（这正是剥注释的意义）
    const commented = "  // 以前这里是 return source; 现在不行了\n  return null;";
    expect(codeOnly(commented)).not.toMatch(/return\s+source\s*;/);
  });
});
