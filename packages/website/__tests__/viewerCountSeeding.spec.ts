import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PostViewer from "../components/PostViewer";
import {
  VIEWER_BATCH_WINDOW_MS,
  clearViewerCache,
  getCachedViewerRecord,
  pendingViewerIds,
  requestArticleViewer,
  seedArticleViewer,
} from "../utils/viewerApi";

/**
 * 每张卡一个阅读量请求的瀑布 + `...` 占位闪烁。
 *
 * 改动前（headless Chrome 实测，:3001，第三方请求已屏蔽）：首页 5 张卡在
 * 2237–2240 ms 一起发出 5 个 `GET /api/public/article/viewer/<slug>`，各 70–79 ms、
 * 每个回 ~260 B 的**整份 visit 文档**，只为显示一个整数；而首屏 HTML 里那 5 个位置
 * 是 `<span data-article-viewer aria-busy="true">...</span>`。
 * 改动后：pageProps 里的 `article.viewer` 直接播种，首屏就是数字，列表页 0 个请求。
 */
const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

(globalThis as { React?: typeof React }).React = React;

const originalFetch = global.fetch;
let calls: Array<{ url: string; at: number }>;
let mode: "ok" | "fail";

/** 每个 id 回一份"整份 visit 文档"，和真实接口一样（我们只用其中的 viewer） */
function stubFetch() {
  const t0 = Date.now();
  global.fetch = (async (url: any) => {
    calls.push({ url: String(url), at: Date.now() - t0 });
    if (mode === "fail") {
      throw new Error("boom");
    }
    const id = String(url).split("/").pop();
    return {
      ok: true,
      json: async () => ({
        statusCode: 200,
        data: {
          _id: "x",
          pathname: `/post/${id}`,
          date: "2026-09-16",
          viewer: Number(id) * 10,
          visited: Number(id) * 10,
        },
      }),
    } as any;
  }) as any;
}

beforeEach(() => {
  calls = [];
  mode = "ok";
  stubFetch();
  clearViewerCache();
});
afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
  clearViewerCache();
});

describe("viewerApi：50ms 合并窗口 + 模块级缓存", () => {
  it("同一帧里的多个 id 合并成一批，批内并行发出", async () => {
    const ids = [53, 52, 51, 50, 49];
    const started = Date.now();
    const results = await Promise.all(ids.map((id) => requestArticleViewer(id)));
    // 一批 = 一次 flush，5 个请求都发生在窗口之后、且几乎同时（并行，不是串行）
    expect(calls).toHaveLength(5);
    const spread = Math.max(...calls.map((c) => c.at)) - Math.min(...calls.map((c) => c.at));
    expect(spread).toBeLessThan(40);
    expect(Math.min(...calls.map((c) => c.at))).toBeGreaterThanOrEqual(
      VIEWER_BATCH_WINDOW_MS - 5
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results.map((r) => r?.viewer)).toEqual([530, 520, 510, 500, 490]);
  });

  it("批窗口是 50ms（和 commentApi 的评论数合并器一致）", () => {
    expect(VIEWER_BATCH_WINDOW_MS).toBe(50);
    const comment = strip(readSrc("utils/commentApi.ts"));
    expect(comment).toMatch(/}, 50\);/);
  });

  it("同一个 id 在一批里只发一次", async () => {
    const [a, b] = await Promise.all([
      requestArticleViewer(7),
      requestArticleViewer(7),
      requestArticleViewer("7"),
    ]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("命中缓存就不再发请求（来回跳转不会反复拉同一篇）", async () => {
    await requestArticleViewer(9);
    expect(calls).toHaveLength(1);
    await requestArticleViewer(9);
    await requestArticleViewer(9);
    expect(calls).toHaveLength(1);
    expect(getCachedViewerRecord(9)?.viewer).toBe(90);
  });

  it("seed 过的 id 直接命中缓存，一个请求都不发", async () => {
    seedArticleViewer(53, 145);
    expect(getCachedViewerRecord(53)).toEqual({ viewer: 145 });
    const res = await requestArticleViewer(53);
    expect(calls).toHaveLength(0);
    expect(res).toEqual({ viewer: 145 });
  });

  it("seed 不会覆盖已经取到的新值（pageProps 可能是几分钟前的快照）", async () => {
    await requestArticleViewer(3);
    expect(getCachedViewerRecord(3)?.viewer).toBe(30);
    seedArticleViewer(3, 999);
    expect(getCachedViewerRecord(3)?.viewer).toBe(30);
  });

  it("seed 忽略非数字（老缓存页没有 viewer 字段时不能播种成 NaN）", () => {
    seedArticleViewer(1, undefined);
    seedArticleViewer(1, null);
    seedArticleViewer(1, NaN);
    seedArticleViewer(1, "12" as any);
    expect(getCachedViewerRecord(1)).toBeUndefined();
    seedArticleViewer(1, 0);
    expect(getCachedViewerRecord(1)).toEqual({ viewer: 0 });
  });

  it("接口挂掉时不抛，解析成 null（组件继续显示占位符而不是整页崩掉）", async () => {
    mode = "fail";
    const res = await requestArticleViewer(11);
    expect(res).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("已经缓存/播种的值不会因为后续请求失败而丢失", async () => {
    await requestArticleViewer(12);
    expect(getCachedViewerRecord(12)?.viewer).toBe(120);
    mode = "fail";
    const res = await requestArticleViewer(12);
    // 命中缓存 → 根本不发请求，数字不会被抹成 "..."
    expect(calls).toHaveLength(1);
    expect(res?.viewer).toBe(120);
  });

  it("请求排队期间 pending 列表里能看到这一批", () => {
    void requestArticleViewer(1);
    void requestArticleViewer(2);
    expect(pendingViewerIds().sort()).toEqual(["1", "2"]);
  });
});

describe("PostViewer：首帧就出数字，不再闪 ...", () => {
  it("有 seed 时 SSR 直接渲染真实数字（没有占位符、aria-busy=false）", () => {
    const html = renderToStaticMarkup(
      createElement(PostViewer, {
        shouldAddViewer: false,
        id: 53,
        initialViewer: 145,
      })
    );
    expect(html).toContain("data-article-viewer");
    expect(html).toContain(">145<");
    expect(html).not.toContain("...");
    expect(html).toContain('aria-busy="false"');
  });

  it("文章页把自己这一次访问算进去（+1），和改动前一致", () => {
    const html = renderToStaticMarkup(
      createElement(PostViewer, {
        shouldAddViewer: true,
        id: 52,
        initialViewer: 123,
      })
    );
    expect(html).toContain(">124<");
  });

  it("没有 seed 时仍然是占位符而不是 0（#230 的不变式）", () => {
    const html = renderToStaticMarkup(
      createElement(PostViewer, { shouldAddViewer: true, id: 0 })
    );
    expect(html).toContain("...");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/data-article-viewer[^>]*>\s*0\s*</);
  });

  it("seed 为 0 是「已加载的 0」，不是缺失", () => {
    const html = renderToStaticMarkup(
      createElement(PostViewer, {
        shouldAddViewer: false,
        id: 1,
        initialViewer: 0,
      })
    );
    expect(html).toContain(">0<");
    expect(html).not.toContain("...");
  });
});

describe("接线：pageProps 里的 viewer 一路传到 PostViewer", () => {
  it("列表页与文章页都把 article.viewer 传下去", () => {
    for (const page of ["pages/index.tsx", "pages/page/[p].tsx"]) {
      expect(strip(readSrc(page))).toContain("viewer={article.viewer}");
    }
    expect(strip(readSrc("pages/post/[id].tsx"))).toContain(
      "viewer={props.article.viewer}"
    );
    expect(readSrc("types/article.ts")).toContain("viewer?: number;");
  });

  it("PostCard → SubTitle → PostViewer 的链路没断", () => {
    expect(strip(readSrc("components/PostCard/index.tsx"))).toContain(
      "viewer={props.viewer}"
    );
    expect(strip(readSrc("components/PostCard/title.tsx"))).toContain(
      "initialViewer={props.viewer ?? null}"
    );
  });

  it("PostViewer 自己不再直接打接口（一律走合并器）", () => {
    const src = strip(readSrc("components/PostViewer/index.tsx"));
    expect(src).not.toContain("getArticleViewer");
    expect(src).toContain("requestArticleViewer");
    expect(src).toContain("seedArticleViewer");
    // 有 seed 就不刷新：默认策略是 never
    expect(src).toMatch(/hasSeed \? "never" : "idle"/);
  });

  it("idle 刷新的 effect 不能带「只跑一次」的门闩（StrictMode 下会让它永远不触发）", () => {
    // React 18 StrictMode 在开发模式会 mount → unmount → remount；带清理函数的 effect
    // 如果配一个 useRef 门闩，第一次调度被 cleanup 取消后就再也不会重排。
    // 实测 /about 的阅读量因此永远停在 "..."（headless Chrome 抓到的）。
    const src = strip(readSrc("components/PostViewer/index.tsx"));
    expect(src).not.toContain("hasInit");
    expect(src).not.toContain("useRef");
    expect(src).toContain("return cancel;");
    expect(src).toMatch(/if \(refresh === "never"\) \{\s*return;\s*\}/);
  });

  it("初始 state 只来自 props（模块级缓存在 SSR 是跨请求共享的，不能在渲染期读）", () => {
    const src = strip(readSrc("components/PostViewer/index.tsx"));
    expect(src).toMatch(/useState<ViewerRecord \| null>\(\s*hasSeed \?/);
    expect(src).not.toMatch(/useState\([^)]*getCachedViewerRecord/);
  });
});
