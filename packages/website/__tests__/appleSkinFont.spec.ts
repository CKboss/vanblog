import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("Apple 皮肤的字体集成（Maple Mono）", () => {
  const css = read("styles/apple.css");
  const layout = read("components/Layout/index.tsx");

  it("拉丁子集用本地 @font-face 声明，并带 font-display: swap", () => {
    expect(css).toContain('@font-face');
    expect(css).toContain('font-family: "Maple Mono"');
    expect(css).toContain("font-display: swap");
    expect(css).toContain("latin-400-normal.woff2");
  });

  it("字体写在令牌里，并保留原来的 SF Pro / 苹方 / 雅黑兜底", () => {
    const font = (css.match(/--ap-font:([\s\S]*?);/) || ["", ""])[1];
    const mono = (css.match(/--ap-font-mono:([\s\S]*?);/) || ["", ""])[1];
    expect(font).toContain('"Maple Mono NF CN"');
    expect(font).toContain('"Maple Mono"');
    expect(font).toContain("-apple-system");
    expect(font).toContain('"PingFang SC"');
    expect(font).toContain('"Microsoft YaHei"');
    // 代码块仍然走 mono 令牌，不能被正文字体覆盖掉
    expect(mono).toContain('"Maple Mono"');
    expect(mono).toContain('"SF Mono"');
    expect(css).toContain("font-family: var(--ap-font-mono)");
  });

  it("字体挂在皮肤根节点上继承，而不是用 p/span/div 这种宽选择器", () => {
    expect(css).toMatch(/\[data-ui="apple"\],\s*\n\[data-ui="apple"\] body,/);
    // 宽选择器会把代码块的 --ap-font-mono 和第三方组件一起覆盖掉
    expect(css).not.toMatch(/^p, span, div \{/m);
  });

  it("中文字体样式表用 <link> 加载（@import 会被内联顺序坑掉），且只在皮肤开启时加载", () => {
    expect(layout).toContain("APPLE_FONT_CSS_URL");
    expect(read("utils/appleFont.ts")).toContain("static.zeoseven.com/zsft/442/main/result.css");
    expect(layout).toContain('uiStyle === "apple" && appleFontCss ? (');
    expect(layout).toContain("APPLE_FONT_PRECONNECT_HOSTS");
  });

  it("远程字体样式表是**非阻塞**加载的（域名解析不了时不能把首屏拖成白屏）", () => {
    // media="print" 让浏览器低优先级取、不阻塞渲染；水合后由 useEffect 翻成 all
    expect(layout).toContain('media="print"');
    expect(layout).toContain('link[rel="stylesheet"][href="${appleFontCss}"]');
    expect(layout).toContain('link.media = "all"');
    // 关 JS 的客户端没有水合，得有 noscript 兜底
    expect(layout).toContain("<noscript>");
    // 翻 media 的 effect 必须依赖 uiStyle，切皮肤时才会重跑
    expect(layout).toMatch(/\}, \[uiStyle, appleFontCss\]\);/);
  });

  it("样式表里不许出现远程 @import（内联后不在首位就会被浏览器静默丢弃）", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...walk(full));
        } else if (entry.name.endsWith(".css")) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, "..", "styles"))) {
      const src = readFileSync(file, "utf8");
      if (/@import\s+url\(\s*["']?https?:/i.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
