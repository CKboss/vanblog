import { describe, expect, it } from "vitest";
import React, { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import {
  formatReadingTime,
  normalizeReadingMinutes,
} from "../utils/readingTime";
import { SubTitle } from "../components/PostCard/title";
import ListThumb from "../components/PostCard/ListThumb";
import { articleThumbAvif, listCardImage } from "../utils/firstImage";

(globalThis as { React?: typeof React }).React = React;

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("readingMinutes 的收敛与文案（缺失 = 什么都不渲染，绝不 NaN）", () => {
  it("合法输入产出可展示分钟数（正向对照：分支真的被走到）", () => {
    expect(normalizeReadingMinutes(1)).toBe(1);
    expect(normalizeReadingMinutes(7)).toBe(7);
    expect(normalizeReadingMinutes(120)).toBe(120);
    expect(formatReadingTime(7)).toBe("约 7 分钟");
    // 契约是整数；真收到小数向下取整也比渲染 "2.7 分钟" 好
    expect(normalizeReadingMinutes(2.7)).toBe(2);
    // 数字字符串也接受（跨 JSON 边界的口径漂移防御）
    expect(normalizeReadingMinutes("12")).toBe(12);
  });

  it("缺失/非法输入一律 null（每个向量都落在 null 分支）", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      0,
      -1,
      -100,
      NaN,
      Infinity,
      -Infinity,
      {},
      [],
      "abc",
      "12abc",
      true,
    ]) {
      expect(normalizeReadingMinutes(bad), `input=${JSON.stringify(bad)}`).toBeNull();
      expect(formatReadingTime(bad)).toBeNull();
    }
  });

  it("输出里永远不会出现 NaN/undefined 字样", () => {
    for (const bad of [undefined, null, NaN, "x", 0, -3]) {
      const out = formatReadingTime(bad);
      expect(out).toBeNull();
      expect(String(out)).not.toContain("NaN");
    }
  });
});

describe("SubTitle 的阅读时间段（约 N 分钟）", () => {
  const baseProps = {
    type: "overview" as const,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    catelog: "博客",
    enableComment: "false" as const,
    id: 42,
    openArticleLinksInNewWindow: false,
  };

  it("给了合法 readingMinutes 才渲染 data-reading-time 段", () => {
    const withTime = renderToStaticMarkup(
      createElement(SubTitle, { ...baseProps, readingMinutes: 7 }),
    );
    expect(withTime).toContain("约 7 分钟");
    expect(withTime).toContain('data-reading-time="7"');
    // 反向对照：不给字段时整段消失（而不是渲染空壳/NaN）
    const without = renderToStaticMarkup(createElement(SubTitle, baseProps));
    expect(without).not.toContain("data-reading-time");
    expect(without).not.toContain("约");
    expect(without).not.toContain("NaN");
    // 非法值同样整段消失
    const invalid = renderToStaticMarkup(
      createElement(SubTitle, { ...baseProps, readingMinutes: 0 }),
    );
    expect(invalid).not.toContain("data-reading-time");
  });

  it("文章页（type=article）与列表卡走同一段渲染", () => {
    const article = renderToStaticMarkup(
      createElement(SubTitle, { ...baseProps, type: "article", readingMinutes: 12 }),
    );
    expect(article).toContain("约 12 分钟");
  });

  it("加密/锁定文章按契约**没有** readingMinutes：什么都不渲染，也不许出现 0 分钟", () => {
    // server 最终契约：private/locked/空正文的文章不下发 readingMinutes（是缺失，不是 0）。
    // 这条钉子防止以后有人把"缺失"好心修成 0/短横杠之类的标签。
    const html = renderToStaticMarkup(
      createElement(SubTitle, { ...baseProps, type: "article" }),
    );
    expect(html).not.toContain("data-reading-time");
    expect(html).not.toContain("0 分钟");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("约");
  });
});

describe("articleThumbAvif：契约字段嵌在 meta.thumbAvif（server 最终形状）", () => {
  it("meta.thumbAvif 能被读到 —— 「字段存在却没被读」是可选契约最坏的静默失败，这条必须红得起来", () => {
    expect(articleThumbAvif({ meta: { thumbAvif: "/static/img/thumb/a.avif" } })).toBe(
      "/static/img/thumb/a.avif",
    );
    expect(
      articleThumbAvif({ meta: { thumbAvif: "/static/img/thumb/a.avif", thumbAvifBytes: 12345 } }),
    ).toBe("/static/img/thumb/a.avif");
  });

  it("兼容顶层 thumbAvif（早期形状）；两处都有时 meta 优先", () => {
    expect(articleThumbAvif({ thumbAvif: "/static/img/thumb/t.avif" })).toBe(
      "/static/img/thumb/t.avif",
    );
    expect(
      articleThumbAvif({
        thumbAvif: "/static/img/thumb/top.avif",
        meta: { thumbAvif: "/static/img/thumb/nested.avif" },
      }),
    ).toBe("/static/img/thumb/nested.avif");
  });

  it("缺失/非法一律 null（null 时 ListThumb 输出与旧版逐字节一致，见上面的金标对照）", () => {
    for (const bad of [
      undefined,
      null,
      {},
      42,
      "x",
      { meta: null },
      { meta: {} },
      { meta: { thumbAvif: "" } },
      { meta: { thumbAvif: "   " } },
      { meta: { thumbAvif: "data:image/avif;base64,AAA" } },
      { meta: { thumbAvif: "relative/a.avif" } },
      { thumbAvif: 7 },
    ]) {
      expect(articleThumbAvif(bad), `input=${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("ListThumb 的 AVIF <picture>（可选契约：缺失时输出与旧版一致）", () => {
  const base = {
    src: "/static/img/thumb/photo.webp",
    fallback: "/static/img/photo.webp",
    alt: "标题",
  };

  /**
   * 金标对照：把**改造前的 ListThumb 实现**原样复刻在这里（DOM 结构与属性逐一对应
   * 旧版 components/PostCard/ListThumb.tsx），用同一份 props 渲染两者并要求输出字符串
   * 完全相等 —— 这就是"thumbAvif 缺失时 HTML 逐字节不变"的**测试结果**，不是口头保证。
   * 以后谁动了无 avif 分支的输出，这条会红。
   */
  function LegacyListThumb(props: {
    src: string;
    fallback: string | null;
    alt: string;
  }) {
    const [current, setCurrent] = useState(props.src);
    const [failed, setFailed] = useState(false);
    if (failed || !current) {
      return null;
    }
    return createElement(
      "div",
      { className: "post-card-thumb-wrap" },
      createElement("img", {
        className: "post-card-thumb",
        src: current,
        alt: props.alt,
        loading: "lazy",
        decoding: "async",
        onError: () => {
          if (props.fallback && current !== props.fallback) {
            setCurrent(props.fallback);
          } else {
            setFailed(true);
          }
        },
      }),
    );
  }

  it("无 avif 时与旧版实现渲染输出逐字节相等（金标对照）", () => {
    const now = renderToStaticMarkup(createElement(ListThumb, base));
    const legacy = renderToStaticMarkup(createElement(LegacyListThumb, base));
    expect(now).toBe(legacy);
    // 金标自检：两边都必须渲染出"有内容的 img"，防止一起输出空串造成 vacuous 相等
    expect(legacy).toContain('<img class="post-card-thumb"');
    expect(legacy).toContain('src="/static/img/thumb/photo.webp"');
  });

  it("无 avif、无 fallback（外链原图）时同样逐字节相等", () => {
    const props = { src: "https://cdn.example/x.png", fallback: null, alt: "a" };
    const now = renderToStaticMarkup(createElement(ListThumb, props));
    expect(now).toBe(renderToStaticMarkup(createElement(LegacyListThumb, props)));
    expect(now).toContain('src="https://cdn.example/x.png"');
  });

  it("给了 avif：picture + source(image/avif) + img 保留 lazy/async/data-zoom-src", () => {
    const html = renderToStaticMarkup(
      createElement(ListThumb, {
        ...base,
        avif: "/static/img/thumb/photo.avif",
        zoomSrc: "/static/img/photo.webp",
      }),
    );
    expect(html).toContain("<picture>");
    expect(html).toContain('type="image/avif"');
    // react-dom/server 按 srcSet 原样输出属性名（浏览器 HTML 解析大小写不敏感）
    expect(html).toMatch(/src[sS]et="\/static\/img\/thumb\/photo\.avif"/);
    expect(html).toContain('data-zoom-src="/static/img/photo.webp"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    // <img> 的 src 仍然是 webp 缩略图（不支持 avif 的浏览器用它）
    expect(html).toContain('src="/static/img/thumb/photo.webp"');
  });

  it("没给 avif：没有 picture/source/data-zoom-src（server 不发字段时零变化）", () => {
    const html = renderToStaticMarkup(createElement(ListThumb, base));
    expect(html).not.toContain("<picture");
    expect(html).not.toContain("image/avif");
    expect(html).not.toContain("data-zoom-src");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('src="/static/img/thumb/photo.webp"');
  });
});

describe("listCardImage 的 avif 键（只有 server 首图 + 合法 URL 才带）", () => {
  it("选中 server 首图且 thumbAvif 合法 → 带 avif 键", () => {
    const r = listCardImage(
      null,
      "",
      "/static/img/photo.webp",
      "/static/img/thumb/photo.avif",
    );
    expect(r).toEqual({
      src: "/static/img/thumb/photo.webp",
      fallback: "/static/img/photo.webp",
      avif: "/static/img/thumb/photo.avif",
    });
  });

  it("cover 胜出时不带 avif（thumbAvif 不是 cover 那张图的 AVIF，混用会两张图打架）", () => {
    const r = listCardImage(
      "/static/img/cover.webp",
      "",
      "/static/img/photo.webp",
      "/static/img/thumb/photo.avif",
    );
    expect(r).toEqual({
      src: "/static/img/thumb/cover.webp",
      fallback: "/static/img/cover.webp",
    });
    expect(r && "avif" in r).toBe(false);
  });

  it("thumbAvif 缺失/非法（data:、空串）时返回对象不含 avif 键 —— 旧断言 toEqual({src,fallback}) 原样通过", () => {
    for (const bad of [undefined, null, "", "  ", "data:image/avif;base64,AAA", "photo.avif"]) {
      const r = listCardImage(null, "", "/static/img/photo.webp", bad as any);
      expect(r, `thumbAvif=${JSON.stringify(bad)}`).toEqual({
        src: "/static/img/thumb/photo.webp",
        fallback: "/static/img/photo.webp",
      });
      expect(r && "avif" in r).toBe(false);
    }
  });

  it("全链路正向：article.meta.thumbAvif 存在时卡片缩略图出现 <source type=image/avif>（字段存在却没被读到就会红）", () => {
    // server 契约的最终形状：AVIF 地址嵌在 meta.thumbAvif（VANBLOG_THUMB_AVIF 打开后下发）
    const article = {
      cover: null as string | null,
      firstImage: "/static/img/photo.webp",
      meta: { thumbAvif: "/static/img/thumb/photo.avif", thumbAvifBytes: 9999 },
    };
    const avif = articleThumbAvif(article); // ← 只读顶层 thumbAvif 的实现这里就是 null，下面全红
    expect(avif).toBe("/static/img/thumb/photo.avif");
    const img = listCardImage(article.cover, "", article.firstImage, avif);
    expect(img?.avif).toBe("/static/img/thumb/photo.avif");
    const html = renderToStaticMarkup(
      createElement(ListThumb, {
        src: img!.src,
        fallback: img!.fallback,
        avif: img!.avif,
        zoomSrc: img!.fallback ?? img!.src,
        alt: "t",
      }),
    );
    expect(html).toContain("<picture>");
    expect(html).toContain('type="image/avif"');
    expect(html).toMatch(/src[sS]et="\/static\/img\/thumb\/photo\.avif"/);
    expect(html).toContain('data-zoom-src="/static/img/photo.webp"'); // 放大仍指原图
  });
});

describe("接线（源码级钉子）", () => {
  it("列表页与文章页都把 readingMinutes/thumbAvif 传给 PostCard", () => {
    for (const page of ["pages/index.tsx", "pages/page/[p].tsx"]) {
      const src = read(page);
      expect(src, page).toContain("readingMinutes={article.readingMinutes}");
      // thumbAvif 必须走 articleThumbAvif()（它同时认 meta.thumbAvif 这个**最终契约位置**
      // 与顶层兼容位）—— 直接写 article.thumbAvif 会在字段上线那天静默失效
      expect(src, page).toContain("thumbAvif={articleThumbAvif(article)}");
      expect(src, page).not.toContain("thumbAvif={article.thumbAvif}");
    }
    const post = read("pages/post/[id].tsx");
    expect(post).toContain("readingMinutes={props.article?.readingMinutes}");
    expect(post).toContain("thumbAvif={articleThumbAvif(props.article)}");
    expect(post).toContain("relatedArticles={props.relatedArticles}");
  });

  it("阅读时间不做客户端兜底计算（列表响应没有 content，也不该有第二份实现）", () => {
    // 剥掉注释再断言（本仓库的老规矩：注释里引用 content 是文档，代码里才是不允许）
    const rt = read("utils/readingTime.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(rt).not.toMatch(/\bcontent\b/);
    expect(rt).not.toContain("import"); // 纯函数，不依赖任何正文/接口数据
    const subtitle = read("components/PostCard/title.tsx");
    expect(subtitle).toContain("formatReadingTime(props.readingMinutes)");
    expect(subtitle).not.toMatch(/wordCount\s*\//); // 没有"字数/速度"式的本地估算
  });
});
