import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { getProcessor } from "bytemd";
import gfm from "@bytemd/plugin-gfm";
import math from "@bytemd/plugin-math-ssr";
import rawHTML from "../components/Markdown/rawHTML";
import { sanitizeMarkdownSchema } from "../utils/markdownSanitize";

/**
 * MathML 的处置 + bytemd 基底 schema 的逐键比对。
 *
 * ## 为什么有这个文件
 * 服务端给 RSS 接消毒时活体测到：feed 里的 `<math>` 与 `<annotation encoding="application/x-tex">`
 * 从 4 处变成 0（MathML 元素不在白名单里 ⇒ 被 drop、子节点保留）。因为**前台文章页用的是同一份
 * canonical 白名单**（`utils/markdownSanitize.ts`），当时的推论是"前台很可能也一直在丢 MathML
 * ⇒ 读屏器支持丢失"。
 *
 * 🔴 **本文件实测推翻了这个推论：前台并没有丢 katex 的 MathML。** 原因是**两条管线的顺序不同**：
 *
 * | | 前台文章页 | RSS（服务端） |
 * |---|---|---|
 * | 管线 | remark → remark-rehype → **rehype-katex（math 插件）** → rehype-raw → **rehype-sanitize** → stringify | markdown-it + `@mdit/plugin-katex` 先渲染出 **HTML 字符串** → 再 `parse → sanitize → stringify` |
 * | katex 产出的 `<math>` | **在消毒之后产生 ⇒ 活下来** | **在消毒之前就已存在 ⇒ 被 drop** |
 * | 作者**手写**的 `<math>` | **被 drop**（白名单里没有 MathML 标签） | 同样被 drop |
 *
 * 所以两边测到的现象都对，只是**不是同一件事**：前台的读屏器支持**没有**丢失；丢的是 RSS 里的。
 *
 * 🔴 **但这个顺序同时意味着一件必须钉住的事：katex 产出的整棵子树绕过了我们的白名单。**
 * 它的安全性不由 `sanitizeMarkdownSchema` 兜底，而是由 **katex 自己的转义**兜底。实测（下面有断言）：
 *   - `$\text{<script>alert(3)</script>}$` ⇒ `<` 被转义成 `&#x3C;`，**没有 script 元素**；
 *   - `$\href{javascript:alert(1)}{click}$` ⇒ katex 渲染成**红色错误框**（`mathcolor:#cc0000`），
 *     **不产出 `<a>` 元素**；`javascript:` 只出现在 `<annotation encoding="application/x-tex">`
 *     里的**惰性 LaTeX 源文本**中，不是可点的 href。
 *   - ⚠️ 并且实测：**给 `math({ trust: true })` 也不产出 `<a>`**（katex 0.16.47 在本管线里
 *     `\href` 依旧是错误框）⇒ 所以"打开 trust 就会产出 javascript: 锚"这个说法**在实测里不成立**，
 *     本文件**不断言**它。钉的是"我们没有传这个选项"这个事实本身。
 *
 * ⚠️ **断言形状的一个坑（本文件第一版踩过）**：判断"有没有锚元素"必须用 `/<a\s/`，
 *    **不能**用 `includes("<a")` —— 后者会被 `<annotation` 命中，从而得出"产出了锚"的**假阳性**。
 *
 * ## 为什么 bytemd 基底的逐键比对只能在这里做
 * 服务端那份 RSS 消毒镜像依赖一个事实：**bytemd 传给消毒器的基底 ≡ `hast-util-sanitize` 的
 * `defaultSchema` + `attributes["*"]` 里的 `className`**（其余逐键相同）。少了 `className`，
 * 所有 class 会被摘掉 ⇒ katex 排版与代码高亮全毁。
 * ⚠️ 而 **server 侧无法复核这条**：bytemd 不在 `packages/server` 的依赖里（pnpm 严格隔离）。
 * ⇒ 将来 bytemd 升级若基底又多了别的差异，**只有这个文件能发现**，否则 RSS 那份镜像会静默偏离。
 */

const require_ = createRequire(import.meta.url);

/** 走前台真实的渲染链（与 `MarkdownRich` 同源的插件子集 + 同一个 canonical 消毒器）。 */
function render(markdown: string, mathOptions?: unknown) {
  let captured: any = null;
  const plugins: any[] = [rawHTML(), gfm({ singleTilde: false })];
  // ⚠️ 刻意不引入 mermaidForViewer / customContainer 等：它们要 React context（theme），
  //    而本文件只关心"消毒与 katex 的相对顺序"，与那些插件无关。
  plugins.push(mathOptions === undefined ? math() : math(mathOptions as any));
  const html = getProcessor({
    plugins,
    remarkRehype: { allowDangerousHtml: true },
    sanitize: (schema: any) => {
      captured = sanitizeMarkdownSchema(schema);
      return captured;
    },
  })
    .processSync(markdown)
    .toString();
  return { html, schema: captured };
}

/**
 * 取 `hast-util-sanitize` 的 `defaultSchema`。
 * ⚠️ 它**不是** website 的直接依赖（是 bytemd 的），pnpm 严格隔离下从本包直接解析不到
 * ⇒ 必须**经由 bytemd 自己的位置**解析。
 * ⚠️ 也**不要手搓一份 defaultSchema 当 fixture**：那只会证明"我的手抄本与我的假设自洽"，
 *    而这里要钉的恰恰是"库的真实基底长什么样"。
 */
function loadDefaultSchema(): any {
  const bytemdEntry = require_.resolve("bytemd");
  const hastPath = require_.resolve("hast-util-sanitize", { paths: [bytemdEntry] });
  const mod = require_(hastPath);
  return mod.defaultSchema ?? mod.default?.defaultSchema;
}

const MATHML_TAG_NAMES = [
  "math",
  "semantics",
  "mrow",
  "mi",
  "mn",
  "mo",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "annotation",
  "mtext",
  "mstyle",
  "mtable",
  "mtr",
  "mtd",
] as const;

describe("MathML：白名单不含它，但 katex 的产出仍然活下来（顺序决定的）", () => {
  it("canonical 白名单里没有任何 MathML 标签（这是既有事实，不是本轮改的）", () => {
    const { schema } = render("$$x^2$$");
    // 替身自检：schema 真的被抓到了，否则下面全是空断言
    expect(schema).toBeTruthy();
    expect(Array.isArray(schema.tagNames)).toBe(true);
    expect(schema.tagNames.length).toBeGreaterThan(50);
    const present = MATHML_TAG_NAMES.filter((t) => schema.tagNames.includes(t));
    expect(present).toEqual([]);
  });

  it("🔴 作者**手写**的 MathML 会被 drop（元素消失、子节点文字保留）", () => {
    const { html } = render("<math><mi>x</mi></math>");
    expect(html).not.toMatch(/<math[\s>]/);
    expect(html).not.toMatch(/<mi[\s>]/);
    expect(html).toContain("x"); // 子节点保留 ⇒ 不是整段消失
  });

  it("🔴 但 **katex 生成的** MathML 活了下来 ⇒ 前台读屏器支持没有丢失", () => {
    const { html } = render("$$\\int_0^\\infty e^{-x^2}dx$$");
    // 这一条是整个文件的核心事实：与 RSS 侧（4→0）**方向相反**，因为 math 插件在消毒之后才产出。
    expect(html).toMatch(/<math[\s>]/);
    expect(html).toContain("katex-mathml");
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).toMatch(/<semantics[\s>]/);
    expect(html).toMatch(/<mrow[\s>]/);
    // 视觉那一半也在（katex 的 HTML 渲染）
    expect(html).toContain('class="katex"');
  });

  it("消毒本身确实在跑（否则上面『katex 活下来』可能只是『什么都没被消毒』）", () => {
    const { html } = render("<script>alert(1)</script>");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toMatch(/<script[\s>]/);
    // strip 语义：连内容一起删 ⇒ 输出应当是空的
    expect(html.trim()).toBe("");
  });
});

describe("🔴 katex 子树绕过白名单 ⇒ 它的安全性靠 katex 自己，必须钉住", () => {
  it("text 里的 HTML 被 katex 转义（不会变成元素）", () => {
    const { html } = render("$\\text{<script>alert(3)</script>}$");
    expect(html).not.toMatch(/<script[\s>]/);
    // `<` 被转义成实体，文字仍在（说明是"转义"而不是"整段吞掉"）
    expect(html).toContain("&#x3C;");
    expect(html).toContain("alert(3)");
  });

  it("href{javascript:} 不产出锚元素，javascript: 只作为惰性源文本待在 annotation 里", () => {
    const { html } = render("$\\href{javascript:alert(1)}{click}$");
    // katex 把它渲染成红色错误框，`javascript:` 只在 `<annotation>` 的 LaTeX 源文本里。
    // ⚠️ 必须用 /<a\s/ 而不是 includes("<a")：后者会被 `<annotation` 命中（第一版探针就因此假阳性）。
    expect(html).not.toMatch(/<a\s/);
    expect(html).not.toMatch(/<a[^>]+href\s*=\s*["']?\s*javascript:/i);
    expect(html).toContain("application/x-tex");
    expect(html).toContain("#cc0000");
  });

  it("🔴 前台调用 math() 时**没有**给 katex 传 trust 选项（消毒器看不到 katex 子树，这个默认值是唯一防线）", () => {
    // ⚠️ 如实记录：给 `math({ trust: true })` 时，katex 0.16.47 在本管线里**仍然不产出 `<a>`**
    //    ⇒ 所以这里钉的不是"打开 trust 会出事"，而是"**我们没有打开它**"这个事实：
    //    将来谁显式传了 trust，这条会红，逼他重新评估（而不是悄悄改掉一个默认防线）。
    const withTrust = render("$\\href{javascript:alert(1)}{click}$", {
      trust: true,
    }).html;
    expect(withTrust).not.toMatch(/<a\s/);

    // 源码级：MarkdownRich 里必须是**无参**的 math()。
    // ⚠️ 断言"不存在"要先剥注释（本仓库已多次因为注释里出现同样字面量而假绿/假红）。
    const fs = require_("node:fs") as typeof import("node:fs");
    const path = require_("node:path") as typeof import("node:path");
    const richPath = path.join(
      __dirname,
      "..",
      "components",
      "Markdown",
      "MarkdownRich.tsx",
    );
    const src = fs.readFileSync(richPath, "utf8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    // 尺子有效性反证：剥离器没有把整份文件吃空，且代码里那处 math() 仍在
    expect(stripped.length).toBeGreaterThan(100);
    expect(stripped).toContain("math()");
    // 真正的断言：不允许出现 trust 选项
    expect(stripped).not.toMatch(/math\(\s*\{[^}]*trust/);
    expect(stripped).not.toContain("trust: true");
    expect(stripped).not.toContain("trust:true");
  });
});

describe("🔴 bytemd 基底 ≡ hast-util-sanitize 的 defaultSchema + className（只有 website 侧能验）", () => {
  /** 抓 bytemd 传给消毒器的**原始**基底（未经 sanitizeMarkdownSchema 加工）。 */
  function captureBytemdBase(): any {
    let base: any = null;
    getProcessor({
      plugins: [rawHTML(), gfm({ singleTilde: false })],
      remarkRehype: { allowDangerousHtml: true },
      sanitize: (schema: any) => {
        // 深拷贝：sanitizeMarkdownSchema 是**就地修改**的，不拷就会被污染（本文件的比对会假绿）
        base = JSON.parse(JSON.stringify(schema));
        return schema;
      },
    }).processSync("x");
    return base;
  }

  it("逐键比对：顶层键、tagNames、attributes 的差异恰好只有 '*' 里的 className", () => {
    const base = captureBytemdBase();
    // 替身自检
    expect(base).toBeTruthy();
    expect(Array.isArray(base.tagNames)).toBe(true);

    const def = loadDefaultSchema();
    expect(def).toBeTruthy();

    // ① 顶层键集合完全相同
    expect(Object.keys(base).sort()).toEqual(Object.keys(def).sort());
    // ② tagNames 逐项相同（含顺序）
    expect(base.tagNames).toEqual(def.tagNames);
    // ③ 除 attributes 外每个顶层键都深度相等
    for (const key of Object.keys(def)) {
      if (key === "attributes") continue;
      expect(base[key], `top-level key "${key}" drifted`).toEqual(def[key]);
    }
    // ④ attributes：唯一允许的差异是 "*" 里多一个 className
    expect(Object.keys(base.attributes).sort()).toEqual(
      Object.keys(def.attributes).sort(),
    );
    for (const tag of Object.keys(def.attributes)) {
      if (tag === "*") continue;
      expect(base.attributes[tag], `attributes.${tag} drifted`).toEqual(
        def.attributes[tag],
      );
    }
    const baseStar: unknown[] = base.attributes["*"] || [];
    const defStar: unknown[] = def.attributes["*"] || [];
    expect(defStar).not.toContain("className"); // 尺子有效性：默认基底确实没有它
    expect(baseStar).toContain("className"); // bytemd 的基底确实有
    expect(baseStar.filter((x) => x !== "className")).toEqual(defStar);
  });

  it("⚠️ 这条比对的后果：少了 className，消毒会摘掉所有 class（katex 排版与代码高亮全毁）", () => {
    // 行为级地钉住"className 是 load-bearing 的"：同一份输入，
    // 用 bytemd 基底 ⇒ class 活下来；用 defaultSchema ⇒ class 被摘掉。
    const bytemdEntry = require_.resolve("bytemd");
    const hast = require_(
      require_.resolve("hast-util-sanitize", { paths: [bytemdEntry] }),
    );
    const fromHtml = require_(
      require_.resolve("hast-util-from-html", { paths: [bytemdEntry] }),
    );
    // ⚠️ 三个包的导出形状**不一致**，而且 🔴 **同一个包的形状还会随加载方式变化**：
    //    sanitize / from-html 是 `{ sanitize }` / `{ fromHtml }`（具名导出对象）；
    //    hast-util-to-html 在 2026-09-21 之前经 require() 拿到的是**函数本身**
    //    （typeof === "function"、无具名导出），而 W2 升级（next 14→15）重装依赖之后
    //    变成了**命名空间对象 `{ toHtml }`** ⇒ 原来那句 `as (tree) => string` 让 TS 闭了嘴，
    //    运行时却直接 `toHtml is not a function`（类型断言掩盖了形状变化）。
    //    ⚠️ 核实过这**不是安全相关的变化**：从 bytemd 的位置解析，三个包版本一个都没变
    //    （`hast-util-sanitize@4.1.0`、`hast-util-from-html@1.0.2`、`hast-util-to-html@8.0.4`），
    //    变的只是 ESM/CJS 互操作拿到的**导出形状**。
    //    ⇒ 所以这里**同时兼容两种形状**，而不是钉死一种：钉死形状等于把"依赖布局"变成被测对象，
    //    任何一次 install 重排都会让这条**安全**守卫假红，而假红的安全守卫最终会被人放宽。
    //    🔴 但两种形状都不匹配时**必须抛错**，不许静默回退（那会让下游断言恒真）。
    const toHtmlMod = require_(
      require_.resolve("hast-util-to-html", { paths: [bytemdEntry] }),
    ) as unknown;
    const toHtml: (tree: unknown) => string =
      typeof toHtmlMod === "function"
        ? (toHtmlMod as (tree: unknown) => string)
        : (toHtmlMod as { toHtml: (tree: unknown) => string }).toHtml;
    if (typeof toHtml !== "function") {
      throw new Error(
        "hast-util-to-html 的导出形状既不是函数、也没有具名 toHtml，请重新核实（不要放宽这条）",
      );
    }

    const sanitizeWith = (schemaBase: any) => {
      const tree = fromHtml.fromHtml('<span class="katex">x</span>', {
        fragment: true,
      });
      return toHtml(hast.sanitize(tree, schemaBase));
    };

    const withBytemdBase = sanitizeWith(
      sanitizeMarkdownSchema(captureBytemdBase()),
    );
    const withDefault = sanitizeWith(sanitizeMarkdownSchema(loadDefaultSchema()));

    expect(withBytemdBase).toContain('class="katex"');
    expect(withDefault).not.toContain('class="katex"');
  });
});
