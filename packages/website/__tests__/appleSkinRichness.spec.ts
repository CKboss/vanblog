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

describe("没有图的文章就是纯文字卡（不放假图）", () => {
  const postCard = read("components/PostCard/index.tsx");

  it("占位封面这套东西整个删掉了：按标题哈希的色相不承载任何信息，还假装自己是缩略图", () => {
    expect(() => read("utils/coverPlaceholder.ts")).toThrow();
    expect(postCard).not.toContain("coverPlaceholder");
    expect(read("components/PostCard/ListThumb.tsx")).not.toContain("post-card-cover-fallback");
    expect(read("styles/apple.css")).not.toContain("post-card-cover-fallback");
    expect(read("styles/apple.css")).not.toContain("post-card-cover-glyph");
  });

  it("ListThumb 没有图 / 图挂了都返回 null，绝不留空框或破图标", () => {
    const thumb = read("components/PostCard/ListThumb.tsx");
    expect(thumb).toContain("if (failed || !current) {\n    return null;");
    expect(thumb).toContain("setCurrent(props.fallback)");
    expect(thumb).toContain("setFailed(true)");
    expect(thumb).toContain('loading="lazy"');
  });

  it("PostCard 只在拿到图的时候渲染 ListThumb", () => {
    expect(postCard).toContain("{listImage ? (");
    expect(postCard).not.toContain('src={listImage ? listImage.src : null}');
  });

  it("真正的解法是让文章有真图：后台「从正文首图补封面」接口存在", () => {
    const server = read("../server/src/controller/admin/article/article.controller.ts");
    expect(server).toContain("@Post('covers/from-content')");
    expect(server).toContain("@Post('covers/revert')");
    // 回填后要触发 ISR，否则前台得等下一次重验证才看得到
    expect(server).toContain("回填封面");
    expect(server).toContain("isrProvider.activeAll");
  });
});

describe("接线：只有 Apple 皮肤显示，默认皮肤版面不变", () => {
  const postCard = read("components/PostCard/index.tsx");
  const globals = read("styles/globals.css");
  const apple = read("styles/apple.css");

  it("缩略图只在列表卡渲染，用的是完整正文而不是 200 字摘要", () => {
    expect(postCard).toContain("<ListThumb");
    // 首图优先用 server 从**完整正文**算好的 props.firstImage（列表响应不再带 content），
    // 缺失时回退本地扫 content —— 无论哪条路都不是 calContent（200 字摘要里常常没有首图）
    expect(postCard).toMatch(
      /props\.type == "overview"\s*\?\s*listCardImage\(props\.cover, content, props\.firstImage\)/
    );
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

  it("缩略图失败会回退原图，原图也失败就整块不渲染", () => {
    const thumb = read("components/PostCard/ListThumb.tsx");
    expect(thumb).toContain("onError");
    expect(thumb).toContain("setCurrent(props.fallback)");
    expect(thumb).toContain("setFailed(true)");
    expect(thumb).not.toContain("CoverFallback");
    expect(thumb).toContain('loading="lazy"');
  });
});
