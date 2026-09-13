import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  absoluteUrl,
  articleJsonLd,
  breadcrumbJsonLd,
  canonicalPath,
  canonicalUrl,
  jsonLdString,
  normalizeSiteUrl,
  toPlainText,
  websiteJsonLd,
} from "../utils/seo";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const SITE = "https://blog.example.com";

describe("canonical", () => {
  it("站点 URL 带不带尾斜杠都一样", () => {
    expect(normalizeSiteUrl("https://x.com/")).toBe("https://x.com");
    expect(normalizeSiteUrl("https://x.com///")).toBe("https://x.com");
    expect(normalizeSiteUrl("")).toBe("");
    expect(normalizeSiteUrl(null)).toBe("");
  });

  it("query 与 hash 不产生新的规范地址", () => {
    expect(canonicalPath("/tag/C%2B%2B?page=2#comments")).toBe("/tag/C++");
    expect(canonicalPath("/post/abc?from=rss")).toBe("/post/abc");
  });

  it("/page/1 与首页是同一份内容，规范到 /", () => {
    expect(canonicalPath("/page/1")).toBe("/");
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("/page/2")).toBe("/page/2");
  });

  it("多余斜杠收敛，结尾斜杠去掉", () => {
    expect(canonicalPath("//post//abc//")).toBe("/post/abc");
    expect(canonicalPath("post/abc")).toBe("/post/abc");
    expect(canonicalPath("")).toBe("/");
  });

  it("拼成绝对地址；没有站点 URL 时不硬编一个域名", () => {
    expect(canonicalUrl(SITE, "/post/abc?x=1")).toBe("https://blog.example.com/post/abc");
    expect(canonicalUrl("", "/post/abc")).toBe("/post/abc");
    expect(absoluteUrl(SITE, "https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });
});

describe("meta 摘要用的纯文本", () => {
  it("剥掉 markdown 记号，保留可读文字", () => {
    expect(toPlainText("# 标题\n\n**加粗** 与 `code` 与 [链接](https://x.com)")).toBe(
      "标题 加粗 与 code 与 链接",
    );
  });

  it("代码块整块丢掉，图片换成 alt（摘要里出现 base64 就废了）", () => {
    expect(toPlainText("前\n\n```\nconst a = 1;\n```\n\n后 ![图](data:image/png;base64,AAA)")).toBe(
      "前 后 图",
    );
  });

  it("超长时截断并优先落在句读上，末尾补省略号", () => {
    const long = "第一句话。".repeat(60);
    const out = toPlainText(long, 40);
    expect(out.length).toBeLessThanOrEqual(42);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("。");
  });

  it("`<!-- more -->` 不会出现在摘要里", () => {
    expect(toPlainText("摘要部分\n\n<!-- more -->\n\n后面")).toBe("摘要部分 后面");
  });
});

describe("JSON-LD", () => {
  it("BlogPosting 带上搜索引擎要的关键字段", () => {
    const data: any = articleJsonLd({
      title: "标题",
      description: "描述",
      url: "https://blog.example.com/post/a",
      imageUrl: "https://blog.example.com/static/img/a.webp",
      datePublished: "2026-01-02T03:04:05.000Z",
      dateModified: "2026-02-03T04:05:06.000Z",
      authorName: "作者",
      category: "博客",
      tags: ["编程", "生活"],
      siteName: "站点名",
      siteUrl: SITE,
    });
    expect(data["@type"]).toBe("BlogPosting");
    expect(data.headline).toBe("标题");
    expect(data.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": "https://blog.example.com/post/a" });
    expect(data.datePublished).toBe("2026-01-02T03:04:05.000Z");
    expect(data.dateModified).toBe("2026-02-03T04:05:06.000Z");
    expect(data.author).toEqual({ "@type": "Person", name: "作者" });
    expect(data.publisher.name).toBe("站点名");
    expect(data.keywords).toBe("编程, 生活");
    expect(data.image).toEqual(["https://blog.example.com/static/img/a.webp"]);
  });

  it("非法日期宁可缺字段，也不写 Invalid Date（结构化数据校验会直接失败）", () => {
    const data: any = articleJsonLd({
      title: "t",
      url: "u",
      datePublished: "乱七八糟",
      dateModified: undefined,
    });
    expect(data.datePublished).toBeUndefined();
    expect(data.dateModified).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("Invalid Date");
  });

  it("标题超长会被截到 schema 允许的长度", () => {
    const data: any = articleJsonLd({ title: "x".repeat(300), url: "u" });
    expect(data.headline.length).toBeLessThanOrEqual(110);
  });

  it("面包屑按顺序编号，首页/分类/文章三级", () => {
    const data: any = breadcrumbJsonLd(SITE, [
      { name: "首页", path: "/" },
      { name: "博客", path: "/category/博客" },
      { name: "文章" },
    ]);
    expect(data["@type"]).toBe("BreadcrumbList");
    expect(data.itemListElement.map((i: any) => i.position)).toEqual([1, 2, 3]);
    expect(data.itemListElement[1].item).toBe("https://blog.example.com/category/博客");
    expect(data.itemListElement[2].item).toBeUndefined();
    expect(breadcrumbJsonLd(SITE, [])).toBeNull();
  });

  it("首页是 WebSite + Blog", () => {
    const data: any = websiteJsonLd({
      siteName: "站点名",
      siteUrl: "https://blog.example.com/",
      description: "描述",
      authorName: "作者",
    });
    expect(data["@type"]).toEqual(["WebSite", "Blog"]);
    expect(data.url).toBe("https://blog.example.com");
    expect(data.author.name).toBe("作者");
  });

  it("序列化会转义 <，不可能从 JSON-LD 里逃出 </script>", () => {
    const out = jsonLdString({ headline: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
  });
});

describe("接线", () => {
  it("Layout 输出 canonical 与 og:url（全站每个页面都有）", () => {
    const layout = read("components/Layout/index.tsx");
    expect(layout).toContain('rel="canonical"');
    expect(layout).toContain('property="og:url"');
    expect(layout).toContain('property="og:site_name"');
    expect(layout).toContain("canonicalUrl(props.option.siteUrl, asPath)");
    // 站点 URL 没配就不要输出（错误的绝对地址比没有更糟）
    expect(layout).toContain("props.option.siteUrl ?");
  });

  it("文章页把 /post/<数字id> 301 到别名，避免重复内容", () => {
    const page = read("pages/post/[id].tsx");
    expect(page).toContain("permanent: true");
    expect(page).toContain("getArticlePath(props.article)");
    expect(page).toContain('property="og:type" content="article"');
    expect(page).toContain("article:published_time");
    expect(page).toContain("application/ld+json");
    expect(page).toContain("toPlainText(props?.article?.content, 160)");
  });

  it("首页输出 WebSite/Blog 结构化数据", () => {
    const index = read("pages/index.tsx");
    expect(index).toContain("websiteJsonLd(");
    expect(index).toContain("application/ld+json");
  });

  it("站点 URL 与站点名进了 LayoutProps（canonical 的数据来源）", () => {
    const src = read("utils/getLayoutProps.ts");
    expect(src).toContain("siteUrl: string;");
    expect(src).toContain("siteUrl: String(siteInfo.baseUrl || \"\").trim()");
  });
});
