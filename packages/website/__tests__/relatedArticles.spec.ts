import { describe, expect, it } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import RelatedArticles from "../components/RelatedArticles";
import {
  RELATED_ARTICLES_MAX,
  normalizeRelatedArticles,
  relatedArticleHref,
} from "../utils/relatedArticles";

(globalThis as { React?: typeof React }).React = React;

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const item = (over: Record<string, unknown> = {}) => ({
  _id: "668a42b25497d2b9081db6d9",
  title: "示例文章",
  pathname: "shi-li-wen-zhang",
  cover: "/static/img/photo.webp",
  updatedAt: "2026-09-01T00:00:00.000Z",
  readingMinutes: 7,
  ...over,
});

describe("normalizeRelatedArticles：缺失/脏数据 → []（整块不渲染），上限 5 条", () => {
  it("非数组输入一律 []（正向对照：合法数组确实产出条目）", () => {
    for (const bad of [undefined, null, {}, "x", 5, NaN]) {
      expect(normalizeRelatedArticles(bad), `input=${String(bad)}`).toEqual([]);
    }
    expect(normalizeRelatedArticles([item()])).toHaveLength(1); // 分支自检
  });

  it("脏条目被剔除：非对象 / 无标题且无别名 / 空对象", () => {
    const out = normalizeRelatedArticles([
      null,
      42,
      "str",
      [],
      {},
      { title: "   " },
      { cover: "/static/img/x.webp" }, // 只有图，没有任何可展示文本
      item({ title: "有效的" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("有效的");
  });

  it("上限 5 条：8 条有效输入只保留前 5 条（截断分支真的被走到）", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      item({ title: `t${i}`, pathname: `p${i}` }),
    );
    const out = normalizeRelatedArticles(many);
    expect(out).toHaveLength(RELATED_ARTICLES_MAX);
    expect(RELATED_ARTICLES_MAX).toBe(5); // 契约钉子：max 5
    expect(out.map((o) => o.title)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("cover 只留可用 URL：data:/相对路径被丢掉，本站与 http(s) 保留", () => {
    const out = normalizeRelatedArticles([
      item({ pathname: "a", cover: "data:image/webp;base64,AA" }),
      item({ pathname: "b", cover: "relative/x.webp" }),
      item({ pathname: "c", cover: "/static/img/c.webp" }),
      item({ pathname: "d", cover: "https://cdn.example/d.png" }),
    ]);
    expect(out[0].cover).toBeUndefined();
    expect(out[1].cover).toBeUndefined();
    expect(out[2].cover).toBe("/static/img/c.webp");
    expect(out[3].cover).toBe("https://cdn.example/d.png");
  });

  it("输出对象绝不带值为 undefined 的键（Next getStaticProps 序列化器遇到 undefined 整页 500）", () => {
    // ⚠️ 回归夹具 = 本机实测抓到的真实 payload 形状（server 侧已上线的契约）：
    // cover 是**空串**、readingMinutes 可能是 null、updatedAt 可能缺失。
    // 第一版实现给这些字段赋了显式 undefined → dev SSR 直接
    // "Error serializing `.relatedArticles[3].cover`" 500（JSON.stringify 和
    // React 渲染都容忍 undefined，只有 Next 的序列化器不容忍 —— 测试必须自己钉住）。
    const real = [
      {
        _id: "42",
        id: 42,
        title: "如何看财报",
        pathname: "ru-he-kan-cai-bao",
        cover: "",
        updatedAt: "2025-11-19T16:11:47.309Z",
        readingMinutes: 1,
      },
      { _id: "43", id: 43, title: "无封面", pathname: "wu-feng-mian", cover: "", updatedAt: "", readingMinutes: null },
    ];
    const out = normalizeRelatedArticles(real);
    expect(out).toHaveLength(2);
    for (const entry of out) {
      for (const k of Object.keys(entry)) {
        expect((entry as any)[k], `key ${k} 的值不许是 undefined`).not.toBeUndefined();
      }
    }
    expect("cover" in out[0]).toBe(false); // 空串 cover 不落键，更不渲染 <img>
    expect(out[0]._id).toBe("42");
    expect(out[0].readingMinutes).toBe(1);
    expect("updatedAt" in out[1]).toBe(false);
    expect("readingMinutes" in out[1]).toBe(false);
    // 等价于 Next 序列化器的信息无损检查：toStrictEqual 不像 toEqual 那样忽略 undefined 键
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });
});

describe("relatedArticleHref：pathname 优先、数字 id 兜底、ObjectId 不当链接", () => {
  it("pathname → /post/<encoded pathname>（# 与中文必须编码，不然变成 fragment/裸字节）", () => {
    expect(relatedArticleHref(item({ pathname: "hello-world" }))).toBe(
      "/post/hello-world",
    );
    expect(relatedArticleHref(item({ pathname: "a#b" }))).toBe("/post/a%23b");
    expect(relatedArticleHref(item({ pathname: "中文别名" }))).toBe(
      `/post/${encodeURIComponent("中文别名")}`,
    );
  });

  it("没有 pathname 时用数字 id；Mongo ObjectId（hex）不能当路由参数 → null", () => {
    expect(
      relatedArticleHref({ _id: "668a42b25497d2b9081db6d9", id: 12, title: "x" }),
    ).toBe("/post/12");
    expect(
      relatedArticleHref({ _id: "668a42b25497d2b9081db6d9", title: "x" }),
    ).toBeNull(); // 正向对照在下面：数字 _id 是可用的
    expect(relatedArticleHref({ _id: "34", title: "x" })).toBe("/post/34");
  });

  it("既无 pathname 又无数字 id → null（渲染层据此只出标题文本，不给必 404 的链接）", () => {
    expect(relatedArticleHref({ title: "只有标题" })).toBeNull();
  });
});

describe("<RelatedArticles>：空/缺失整块不渲染；有数据时缩略图必须走 thumb", () => {
  it("items 缺失 / [] / 全脏 → 渲染输出为空字符串", () => {
    for (const items of [undefined, null, [], [null, {}, { title: "" }]]) {
      const html = renderToStaticMarkup(
        createElement(RelatedArticles, { items }),
      );
      expect(html, `items=${JSON.stringify(items)}`).toBe("");
      expect(html).not.toContain("相关文章"); // 空壳标题也不许出现
    }
  });

  it("有数据：标题链接 + 阅读时间 + 日期，缩略图用 /static/img/thumb/ 而不是原图", () => {
    const html = renderToStaticMarkup(
      createElement(RelatedArticles, {
        items: [item({ pathname: "shi-li", title: "示例文章", readingMinutes: 7 })],
      }),
    );
    expect(html).toContain("相关文章");
    expect(html).toContain('data-related-articles');
    expect(html).toContain('href="/post/shi-li"');
    expect(html).toContain("示例文章");
    expect(html).toContain("约 7 分钟");
    expect(html).toContain("2026-09-01");
    // ⚠️ AGENTS §7.38.2 的教训（4.57MB 原图 vs 22KB 缩略图）：src 必须是 thumb 路径，
    // 且输出里**不存在**以原图地址为 src 的写法
    expect(html).toContain('src="/static/img/thumb/photo.webp"');
    expect(html).not.toContain('src="/static/img/photo.webp"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("单条缺 readingMinutes/updatedAt/cover：对应小字段消失，其它照常", () => {
    const html = renderToStaticMarkup(
      createElement(RelatedArticles, {
        items: [item({ readingMinutes: null, updatedAt: undefined, cover: undefined })],
      }),
    );
    expect(html).toContain('href="/post/shi-li-wen-zhang"');
    expect(html).not.toContain("约");
    expect(html).not.toContain("2026-");
    expect(html).not.toContain("<img");
  });

  it("Invalid Date 不流出 NaN（§7.54 C-17 的教训）", () => {
    const html = renderToStaticMarkup(
      createElement(RelatedArticles, {
        items: [item({ updatedAt: "不是日期", readingMinutes: undefined })],
      }),
    );
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Invalid Date");
  });

  it("没有可链接目标时只渲染标题文本（不给必 404 的链接）", () => {
    const html = renderToStaticMarkup(
      createElement(RelatedArticles, {
        items: [{ _id: "668a42b25497d2b9081db6d9", title: "只有 ObjectId" }],
      }),
    );
    expect(html).toContain("只有 ObjectId");
    expect(html).not.toContain("<a");
  });
});

describe("ISR 安全与接线（源码级钉子）", () => {
  it("RelatedArticles 纯 pageProps 渲染：没有 fetch/useEffect/axios/新请求瀑布", () => {
    const src = read("components/RelatedArticles/index.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("useEffect");
    expect(src).not.toContain("axios");
    expect(src).not.toContain("XMLHttpRequest");
    expect(src).toContain("normalizeRelatedArticles(props.items)");
  });

  it("PostCard 在文章页末尾（PostBottom 之后、评论区之前）渲染，且锁定态不渲染", () => {
    const src = read("components/PostCard/index.tsx");
    const iBottom = src.indexOf("<PostBottom");
    const iRelated = src.indexOf("<RelatedArticles");
    const iComment = src.indexOf("<CommentArea");
    expect(iBottom).toBeGreaterThan(-1);
    expect(iRelated).toBeGreaterThan(iBottom);
    expect(iComment).toBeGreaterThan(iRelated);
    expect(src).toContain('props.type == "article" && !lock');
  });

  it("API 边界统一 normalize：缺失时 pageProps 里连键都不加（老 server 下逐字节不变）", () => {
    const src = read("api/getArticles.ts");
    expect(src).toContain("normalizeRelatedArticles(");
    expect(src).toContain("if (related.length)");
    // 详情 payload 级与 article 级两个位置都认（server 侧实现细节未定，防御式取值）
    expect(src).toContain("relatedArticles ?? (article as any)?.relatedArticles");
  });

  it("__NEXT_DATA__ 预算：5 条相关文章 + 阅读时间的 JSON 增量有上界（钉住，防止契约膨胀）", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      _id: "668a42b25497d2b9081db6d9",
      title: `这是一篇相关文章的中文标题占位文本第${i}篇`,
      pathname: `xiang-guan-wen-zhang-biao-ti-zhan-wei-${i}`,
      cover: "/static/img/d2230c4e12515ddfeecce26c3058a3c5._DSC9498_D.webp",
      updatedAt: "2026-09-01T00:00:00.000Z",
      readingMinutes: 12,
    }));
    const bytes = Buffer.byteLength(JSON.stringify(five), "utf8");
    // 5 条真实形状的条目 ≈ 1KB 量级；上界 1.5KB —— 超过说明有人往契约里塞了大字段
    expect(bytes).toBeLessThan(1536);
    expect(bytes).toBeGreaterThan(400); // 自检：量具没有把一切算成 0
    const perArticle = Buffer.byteLength(
      JSON.stringify({ readingMinutes: 12 }),
      "utf8",
    );
    expect(perArticle).toBeLessThan(30); // 列表页每篇只多一个整数字段
  });
});
