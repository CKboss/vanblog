import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { articleOverviewMarkdown, findMoreMarker } from "../utils/articleExcerpt";
import { isSafeArticleParam } from "../api/getArticles";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("摘要：代码块里的 <!-- more --> 不是截断标记", () => {
  it("教程里写示例不会被截断成半个代码块", () => {
    const md = [
      "开头说明",
      "",
      "```md",
      "<!-- more -->",
      "```",
      "",
      "代码块之后的正文",
    ].join("\n");
    expect(findMoreMarker(md)).toBe(-1);
    const overview = articleOverviewMarkdown(md);
    expect(overview).toContain("代码块之后的正文");
    // 围栏必须是成对的，否则列表卡会把后面的内容全吞掉
    expect((overview.match(/```/g) || []).length % 2).toBe(0);
  });

  it("真正写在正文里的标记仍然生效", () => {
    const md = "摘要部分\n\n<!-- more -->\n\n后面的";
    expect(findMoreMarker(md)).toBeGreaterThan(0);
    expect(articleOverviewMarkdown(md)).toBe("摘要部分\n\n");
  });

  it("行内代码里的标记也不算", () => {
    expect(findMoreMarker("用 `<!-- more -->` 来截断")).toBe(-1);
  });
});

describe("后端请求的参数处理", () => {
  it("文章标识只允许一段路径（挡住 %2F 解码出来的 ../api/admin）", () => {
    expect(isSafeArticleParam("1")).toBe(true);
    expect(isSafeArticleParam("my-slug")).toBe(true);
    expect(isSafeArticleParam("如何用-matlab-求导")).toBe(true);
    expect(isSafeArticleParam("../../../api/admin/meta")).toBe(false);
    expect(isSafeArticleParam("a/b")).toBe(false);
    expect(isSafeArticleParam("a?b=1")).toBe(false);
    expect(isSafeArticleParam("a#b")).toBe(false);
    expect(isSafeArticleParam("")).toBe(false);
    expect(isSafeArticleParam("x".repeat(300))).toBe(false);
  });

  it("列表查询用 URLSearchParams 拼，值里的 & 和 + 不会再截断参数", () => {
    const src = read("api/getArticles.ts");
    expect(src).toContain("new URLSearchParams()");
    expect(src).not.toMatch(/queryString \+= `\$\{k\}=\$\{v\}&`/);
  });

  it("搜索词会编码（搜 C# 以前会变成 value=C）", () => {
    expect(read("api/search.ts")).toContain("encodeURIComponent(str");
  });

  it("文章页/分页页缺内容时返回真 404，不做 200 的软 404", () => {
    expect(read("pages/post/[id].tsx")).toContain("notFound: true");
    const page = read("pages/page/[p].tsx");
    expect(page).toContain("notFound: true");
    expect(page).toMatch(/\^\\d\+\$/);
  });

  it("后端故障时不再被当成「文章不存在」（否则会污染 ISR 缓存）", () => {
    const src = read("api/getArticles.ts");
    expect(src).toContain("res.status === 404");
    expect(src).toMatch(/throw new Error\(`后端返回 \$\{res\.status\}`\)/);
    expect(src).not.toMatch(/\} else \{\n\s*\/\/ console\.log\(err\);\n\s*return \{\};/);
  });
});

describe("运行时资源与监听器", () => {
  it("TOC 滚动监听读的是最新的 items（客户端跳转后不会残留上一篇）", () => {
    const core = read("components/MarkdownTocBar/core.tsx");
    expect(core).toContain("itemsRef.current = items");
    expect(core).toContain("const currentItems = itemsRef.current");
    expect(core).toContain("handleScroll.cancel?.()");
  });

  it("作者卡的 headroom 只建一次，并且用安全的方式停掉", () => {
    // 断言前剔除注释：新注释里正好引用了「不能直接 headroom.destroy()」这句旧写法
    const code = (file: string) =>
      read(file)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
    const card = code("components/AuthorCard/index.tsx");
    expect(card).toContain("stopHeadroom(headroom)");
    expect(card).not.toContain("headroom.destroy()");
    expect(card).toContain("}, [props.option.showSubMenu]);");
    // 导航栏是同一类用法，同样不能直接 destroy
    const nav = code("components/NavBar/index.tsx");
    expect(nav).toContain("stopHeadroom(headroom)");
    expect(nav).not.toContain("headroom.destroy()");
  });

  it("stopHeadroom 容忍 scrollTracker 还没建好（headroom 的 init 有 100ms 竞态）", async () => {
    const { stopHeadroom } = await import("../utils/headroom");
    // 没有 scrollTracker：不能抛
    expect(() => stopHeadroom({})).not.toThrow();
    expect(() => stopHeadroom(undefined)).not.toThrow();
    // destroy 自己抛：也不能冒出来
    expect(() =>
      stopHeadroom({ scrollTracker: { destroy: () => { throw new Error("boom"); } } }),
    ).not.toThrow();
    let immediate = 0;
    stopHeadroom({ scrollTracker: { destroy: () => { immediate += 1; } } });
    expect(immediate).toBe(1);
    // 100ms 竞态：init 的 setTimeout 之后才建好 tracker，补的那次要能摘掉监听
    let late2Calls = 0;
    const late: any = {};
    stopHeadroom(late);
    late.scrollTracker = { destroy: () => { late2Calls += 1; } };
    expect(late2Calls).toBe(0);
    await new Promise((r) => setTimeout(r, 320));
    expect(late2Calls).toBe(1);
  });

  it("第三方统计延后到 load 之后", () => {
    expect(read("components/BaiduAnalysis/index.tsx")).toContain('strategy="lazyOnload"');
  });

  it("文章封面（LCP）会被 preload", () => {
    expect(read("pages/post/[id].tsx")).toContain('rel="preload" as="image"');
  });
});
