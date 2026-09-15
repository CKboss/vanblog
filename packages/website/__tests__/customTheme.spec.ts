import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// 主题（前台皮肤）在前台这一侧的接线。
// 约定：主题 id 写到 <html data-ui> 与 .vb-root 上；内置的 default/apple 样式打包在产物里，
// 上传的主题走 /api/public/theme.css（稳定地址 + 服务端 ETag/no-cache，换主题刷新即生效）。
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("自定义主题的接线", () => {
  it("siteInfo.uiStyle 是宽松的 string（要放得下自定义主题 id）", () => {
    expect(read("api/getAllData.ts")).toMatch(/uiStyle\?: string;/);
  });

  it("getLayoutProps 原样透传主题 id，缺省仍是 apple", () => {
    const src = strip(read("utils/getLayoutProps.ts"));
    expect(src).toContain('String(siteInfo.uiStyle || "").trim() || "apple"');
    // 以前是把非 default 的值一律压成 apple，自定义主题会被吃掉
    expect(src).not.toContain(
      'siteInfo.uiStyle === "default" ? "default" : "apple"'
    );
    expect(src).toContain("uiStyle: string;");
  });

  it("Layout 把主题 id 写到 data-ui，并同步到 <html>", () => {
    const src = strip(read("components/Layout/index.tsx"));
    expect(src).toContain("data-ui={uiStyle}");
    expect(src).toContain("document.documentElement.dataset.ui = uiStyle");
  });

  it("只有非内置主题才挂 /api/public/theme.css", () => {
    const src = strip(read("components/Layout/index.tsx"));
    expect(src).toContain(
      'const isBuiltinTheme = uiStyle === "default" || uiStyle === "apple"'
    );
    expect(src).toContain("{!isBuiltinTheme ? (");
    expect(src).toContain("/api/public/theme.css?v=");
  });

  it("自定义主题不会顺带引入 Apple 皮肤的远程字体", () => {
    const src = strip(read("components/Layout/index.tsx"));
    // 字体只在 apple 皮肤下加载；自定义主题要用什么字体由它自己的 CSS 决定
    expect(src).toContain('uiStyle !== "apple"');
    expect(src).toContain('uiStyle === "apple" && appleFontCss');
  });

  it("内置的 apple 主题仍然是打包进产物的（globals.css 里 @import）", () => {
    expect(read("styles/globals.css")).toContain('@import "./apple.css"');
    // 主题的作用域写法：所有规则挂在 [data-ui="apple"] 下
    expect(read("styles/apple.css")).toContain('[data-ui="apple"]');
  });
});
