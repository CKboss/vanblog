import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
/** 源码级断言先剔注释（教训见 AGENTS §7.8.1 / §7.15：注释里引用旧 URL 是文档，不该打红测试） */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

const WOFF2_REL = "public/fonts/maple-mono-latin-400-normal.woff2";
const WOFF2_SHA256 =
  "0f900ecac7020d4251bd5b7c963570d998f3dc1cd195e468f7c9d9902e5556a1";

describe("Apple 皮肤的字体集成（Maple Mono）", () => {
  const css = read("styles/apple.css");
  const layout = read("components/Layout/index.tsx");

  it("拉丁子集用本地 @font-face 声明，并带 font-display: swap", () => {
    expect(css).toContain('@font-face');
    expect(css).toContain('font-family: "Maple Mono"');
    expect(css).toContain("font-display: swap");
    expect(css).toContain("latin-400-normal.woff2");
  });

  it("拉丁子集已自托管：src 指向同源 /fonts/，样式表不再从第三方 CDN 取字节", () => {
    // 刻意更新：本用例原来钉的是 CDN 文件名（jsDelivr @latest）——那正是要修掉的
    // 第三方运行时依赖；现在钉同源路径，并加"不许再出现远程 src"的反向断言（更强）。
    expect(css).toContain('url("/fonts/maple-mono-latin-400-normal.woff2")');
    expect(css).toContain('format("woff2")');
    const cssCode = stripComments(css);
    const remoteSrc = /src:[^;]*https?:\/\//i;
    // 自检：正则必须真的能抓到旧写法，防止一条永远为 false 的断言假绿
    expect(
      remoteSrc.test('src: url("https://cdn.jsdelivr.net/x.woff2") format("woff2")'),
    ).toBe(true);
    expect(remoteSrc.test(cssCode)).toBe(false);
    expect(cssCode).not.toContain("cdn.jsdelivr.net");
    // 版本钉死在注释里（@latest 漂移是这次要修的问题之一，别再改回去）
    expect(css).toContain("@fontsource/maple-mono@5.3.0");
    expect(cssCode).not.toContain("maple-mono@latest");
  });

  it("vendored 字体文件本体：存在、wOF2 魔数、SHA-256 钉死、随附 OFL-1.1 许可证", () => {
    const abs = join(__dirname, "..", WOFF2_REL);
    expect(existsSync(abs)).toBe(true);
    const buf = readFileSync(abs);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(createHash("sha256").update(buf).digest("hex")).toBe(WOFF2_SHA256);
    // apple.css 注释里记录的是同一个 SHA-256：换字体文件必须连注释与这条钉子一起换
    expect(css).toContain(WOFF2_SHA256);
    const license = read("public/fonts/LICENSE-MapleMono.txt");
    expect(license).toContain("SIL OPEN FONT LICENSE");
    expect(license).toContain("Reserved Font Name Maple Mono");
  });

  it("preload 只发首屏关键路径上的那一个字体文件，且只在 apple 皮肤时输出", () => {
    expect(layout).toContain("APPLE_FONT_LATIN_WOFF2");
    expect(read("utils/appleFont.ts")).toContain(
      'APPLE_FONT_LATIN_WOFF2 = "/fonts/maple-mono-latin-400-normal.woff2"',
    );
    // 只 preload 一个：CJK 分包与 zeoseven CSS 是刻意异步的，preload 会抢首屏带宽
    expect((layout.match(/rel="preload"/g) || []).length).toBe(1);
    expect(layout).toMatch(
      /\{uiStyle === "apple" \? \(\s*<Head>\s*<link\s*rel="preload"/,
    );
    // 字体即使同源也按 CORS 模式抓取：少 crossOrigin 会让预载不被复用、下载两遍
    expect(layout).toContain('as="font"');
    expect(layout).toContain('type="font/woff2"');
    expect(layout).toContain('crossOrigin="anonymous"');
  });

  it("jsDelivr 的 preconnect 随自托管移除（前台不再连它），zeoseven 的保留", () => {
    const fontCode = stripComments(read("utils/appleFont.ts"));
    expect(fontCode).toContain("static.zeoseven.com");
    expect(fontCode).not.toContain("cdn.jsdelivr.net");
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
