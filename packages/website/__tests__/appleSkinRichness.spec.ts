import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  firstImageOfMarkdown,
  isUsableImageUrl,
  listCardImage,
  toThumbnailUrl,
} from "../utils/firstImage";
import { tagChipStyle, tagHue } from "../utils/tagColor";
import { coverGlyph, coverHue, coverStyle } from "../utils/coverPlaceholder";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("列表卡缩略图：从正文取首图", () => {
  it("markdown 与 html 两种图片语法都认，取最靠前的那张", () => {
    expect(firstImageOfMarkdown("文\n\n![a](/static/img/x.webp)\n\n后")).toBe("/static/img/x.webp");
    expect(firstImageOfMarkdown('前 <img src="/static/img/y.webp" width="10"> 后')).toBe(
      "/static/img/y.webp",
    );
    expect(
      firstImageOfMarkdown('<img src="/static/img/first.webp">\n\n![a](/static/img/second.webp)'),
    ).toBe("/static/img/first.webp");
    expect(
      firstImageOfMarkdown('![a](/static/img/first.webp)\n\n<img src="/static/img/second.webp">'),
    ).toBe("/static/img/first.webp");
  });

  it("带 title、尖括号包裹、外链都支持", () => {
    expect(firstImageOfMarkdown('![a](/static/img/x.webp "标题")')).toBe("/static/img/x.webp");
    expect(firstImageOfMarkdown("![a](</static/img/x.webp>)")).toBe("/static/img/x.webp");
    expect(firstImageOfMarkdown("![a](https://cdn.example/x.png)")).toBe(
      "https://cdn.example/x.png",
    );
  });

  it("代码块与行内代码里的示例不算（教程类文章会写图片语法当例子）", () => {
    const md = [
      "```md",
      "![示例](/static/img/in-fence.webp)",
      "```",
      "",
      "真图 ![a](/static/img/real.webp)",
    ].join("\n");
    expect(firstImageOfMarkdown(md)).toBe("/static/img/real.webp");
    expect(firstImageOfMarkdown("用 `![x](/static/img/inline.webp)` 写图片")).toBeNull();
  });

  it("data: URI 与相对路径不要（前者几十 KB 内联、后者定位不到文件）", () => {
    expect(isUsableImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isUsableImageUrl("./img/x.png")).toBe(false);
    expect(isUsableImageUrl("/static/img/x.webp")).toBe(true);
    expect(isUsableImageUrl("//cdn.example/x.png")).toBe(true);
    expect(firstImageOfMarkdown("![a](data:image/png;base64,AAAA)")).toBeNull();
  });

  it("没有图片时返回 null（卡片就不渲染图，绝不留空框）", () => {
    expect(firstImageOfMarkdown("纯文字正文")).toBeNull();
    expect(firstImageOfMarkdown("")).toBeNull();
    expect(firstImageOfMarkdown(null)).toBeNull();
  });

  it("本站图床的图换成 300px 缩略图，其它原样", () => {
    expect(toThumbnailUrl("/static/img/abc.name.webp")).toBe("/static/img/thumb/abc.name.webp");
    expect(toThumbnailUrl("/static/img/thumb/abc.webp")).toBe("/static/img/thumb/abc.webp");
    expect(toThumbnailUrl("/static/file/x.pdf")).toBe("/static/file/x.pdf");
    expect(toThumbnailUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
  });

  it("cover 优先于正文首图，并给出缩略图失败时的回退地址", () => {
    expect(listCardImage("/static/img/cover.webp", "![a](/static/img/body.webp)")).toEqual({
      src: "/static/img/thumb/cover.webp",
      fallback: "/static/img/cover.webp",
    });
    expect(listCardImage("", "![a](/static/img/body.webp)")).toEqual({
      src: "/static/img/thumb/body.webp",
      fallback: "/static/img/body.webp",
    });
    // 外链没有缩略图，也就没有回退
    expect(listCardImage(null, "![a](https://cdn.example/x.png)")).toEqual({
      src: "https://cdn.example/x.png",
      fallback: null,
    });
    expect(listCardImage(null, "没有图")).toBeNull();
  });
});

describe("标签彩色胶囊", () => {
  it("色相稳定：同名标签永远同色，且落在 0-359", () => {
    expect(tagHue("生活")).toBe(tagHue("生活"));
    expect(tagHue("生活")).not.toBe(tagHue("编程"));
    for (const t of ["生活", "编程", "投资", "摄影", "C++", "a".repeat(50)]) {
      const h = tagHue(t);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("色相通过 CSS 变量给出（深浅两套配色写在 CSS 里，内联样式做不了暗色）", () => {
    const style = tagChipStyle("生活") as Record<string, string>;
    expect(style["--chip-h"]).toBe(String(tagHue("生活")));
  });
});

describe("渐变占位封面（没图的文章也有色块）", () => {
  it("色相由标题哈希得出，同一篇永远同色", () => {
    expect(coverHue("手动档汽车的几种起步方式")).toBe(coverHue("手动档汽车的几种起步方式"));
    expect(coverHue("A")).not.toBe(coverHue("B"));
    expect(coverHue("")).toBeGreaterThanOrEqual(0);
  });

  it("取首字时会剥掉 [分类] 前缀与 markdown 记号；拉丁标题取第一个单词", () => {
    expect(coverGlyph("[摄影]2025冬日下的天马山")).toBe("2025");
    expect(coverGlyph("# **快速**掌握手动挡")).toBe("快");
    expect(coverGlyph("How to ride a bike")).toBe("How");
    expect(coverGlyph("VanBlog: a blog system")).toBe("VanBlog");
    expect(coverGlyph("   ")).toBe("·");
    expect(coverGlyph("超长标题超长标题超长标题")).toBe("超");
    // `+` 属于标识符字符集，所以 C++ 会整个留下（比只取 "C" 更有辨识度）
    expect(coverGlyph("C++ 入门")).toBe("C++");
    expect(coverGlyph("#1 号文章")).toBe("1");
  });

  it("色相仍然走 CSS 变量（暗色版本写在 CSS 里）", () => {
    expect(coverStyle("生活")["--chip-h"]).toBe(String(tagHue("生活")));
    const apple = read("styles/apple.css");
    expect(apple).toContain(".post-card-cover-fallback");
    expect(apple).toContain("hsl(var(--chip-h)");
    expect(apple).toContain('html.dark [data-ui="apple"] .post-card-cover-fallback');
    // 纯 CSS 斜纹，不引任何图片资源
    expect(apple).toContain("repeating-linear-gradient");
    expect(apple).not.toMatch(/post-card-cover-fallback[^}]*url\(/);
  });

  it("列表卡永远渲染封面块：有图用图，没图用占位", () => {
    const postCard = read("components/PostCard/index.tsx");
    expect(postCard).toContain('src={listImage ? listImage.src : null}');
    expect(postCard).toMatch(/props\.type == "overview" && \(\s*\/\//);
  });
});

describe("接线：只有 Apple 皮肤显示，默认皮肤版面不变", () => {
  const postCard = read("components/PostCard/index.tsx");
  const globals = read("styles/globals.css");
  const apple = read("styles/apple.css");

  it("缩略图只在列表卡渲染，用的是完整正文而不是 200 字摘要", () => {
    expect(postCard).toContain("<ListThumb");
    expect(postCard).toMatch(/props\.type == "overview" \? listCardImage\(props\.cover, content\)/);
    expect(postCard).not.toContain("listCardImage(props.cover, calContent)");
  });

  it("默认皮肤把这两块隐藏（DOM 有、视觉无），Apple 皮肤才显示", () => {
    expect(globals).toMatch(/\.post-card-thumb-wrap,\s*\n\.post-card-chips \{\s*\n\s*display: none;/);
    expect(apple).toMatch(/\[data-ui="apple"\] \.post-card-thumb-wrap \{\s*\n\s*display: block;/);
    expect(apple).toMatch(/\[data-ui="apple"\] \.post-card-chips \{\s*\n\s*display: flex;/);
  });

  it("缩略图有暗色/窄屏适配，胶囊有暗色配色", () => {
    expect(apple).toContain("@media (max-width: 640px)");
    expect(apple).toContain('html.dark [data-ui="apple"] .post-card-chip');
    expect(apple).toContain("aspect-ratio: 16 / 10");
  });

  it("列表页要把 tags 传给 PostCard（否则一个胶囊都渲染不出来）", () => {
    for (const page of ["pages/index.tsx", "pages/page/[p].tsx"]) {
      expect(read(page)).toContain("tags={article.tags}");
    }
  });

  it("缩略图失败会回退原图，原图也失败就用渐变占位封面（绝不留空白）", () => {
    const thumb = read("components/PostCard/ListThumb.tsx");
    expect(thumb).toContain("onError");
    expect(thumb).toContain("setCurrent(props.fallback)");
    expect(thumb).toContain("setFailed(true)");
    expect(thumb).toContain("<CoverFallback title={props.title} />");
    expect(thumb).toContain("if (!current || failed)");
    expect(thumb).toContain('loading="lazy"');
  });
});
