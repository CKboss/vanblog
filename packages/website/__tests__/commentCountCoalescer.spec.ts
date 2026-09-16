import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  COUNT_BATCH_MAX,
  COUNT_CACHE_MAX,
  cachedCountSize,
  clearCommentCountCache,
  getCachedCount,
  loadCommentSetting,
  pendingCountPaths,
  requestCommentCount,
  resetCommentSettingCache,
} from "../utils/commentApi";

/**
 * 评论数合并器的边界行为（这轮加固的三个回归点）：
 * 1. 一批超过 50 个 path 时，溢出部分以前被**静默丢弃并解析成 0** ——
 *    「没查」被渲染成「没有评论」；现在溢出留在队列里，下一个窗口继续发。
 * 2. 请求失败以前会被缓存成 0 且**整个会话不再重试**；现在失败不写缓存、
 *    解析成 undefined（UI 保持占位符），下次挂载可重试。
 * 3. 模块级缓存以前无上限；现在超过 COUNT_CACHE_MAX 按插入序淘汰。
 * 另外 loadCommentSetting 以前把失败（null）永久缓存 —— 一次网络抖动
 * 就把整个 SPA 会话的评论区静默关掉；现在失败不缓存。
 */
const originalFetch = global.fetch;

function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ statusCode: 200, data }) } as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  clearCommentCountCache();
  resetCommentSettingCache();
});
afterEach(() => {
  global.fetch = originalFetch;
  clearCommentCountCache();
  resetCommentSettingCache();
});

function countsFor(paths: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths) {
    out[p] = p.length; // 随便一个可预期的数
  }
  return out;
}

describe("requestCommentCount：合并、溢出与失败语义", () => {
  it("50ms 窗口内的请求合并成一次 /counts，值来自响应", async () => {
    const asked: string[] = [];
    global.fetch = (async (url: any) => {
      asked.push(String(url));
      const q = new URL(String(url), "http://x").searchParams.get("paths") || "";
      return jsonOk(countsFor(q.split(",")));
    }) as any;
    const paths = ["/post/1", "/post/2", "/post/3"];
    const results = await Promise.all(paths.map((p) => requestCommentCount(p)));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("/api/public/comments/counts?");
    expect(results).toEqual(paths.map((p) => p.length));
    expect(getCachedCount("/post/1")).toBe(7);
  });

  it("同一 path 的并发调用共享一个结果", async () => {
    let n = 0;
    global.fetch = (async (url: any) => {
      n += 1;
      const q = new URL(String(url), "http://x").searchParams.get("paths") || "";
      return jsonOk(countsFor(q.split(",")));
    }) as any;
    const [a, b] = await Promise.all([
      requestCommentCount("/post/9"),
      requestCommentCount("/post/9"),
    ]);
    expect(n).toBe(1);
    expect(a).toBe(b);
  });

  it("一批超过 50 个 path：溢出部分进下一批，全部拿到真值（不再静默变 0）", async () => {
    const batchSizes: number[] = [];
    global.fetch = (async (url: any) => {
      const q = new URL(String(url), "http://x").searchParams.get("paths") || "";
      const paths = q.split(",");
      batchSizes.push(paths.length);
      return jsonOk(countsFor(paths));
    }) as any;
    const total = COUNT_BATCH_MAX * 2 + 20; // 120
    const paths = Array.from({ length: total }, (_, i) => `/post/p${i}`);
    const results = await Promise.all(paths.map((p) => requestCommentCount(p)));
    // 三批：50 + 50 + 20
    expect(batchSizes).toEqual([COUNT_BATCH_MAX, COUNT_BATCH_MAX, total - COUNT_BATCH_MAX * 2]);
    // 每一个都拿到了自己的真值 —— 旧实现里第 51 个之后全部是 0
    results.forEach((count, i) => {
      expect(count).toBe(paths[i].length);
    });
    expect(cachedCountSize()).toBe(total);
  });

  it("排队中的 path 能从 pending 列表里看到", () => {
    global.fetch = (async () => jsonOk({})) as any;
    void requestCommentCount("/post/a");
    void requestCommentCount("/post/b");
    expect(pendingCountPaths().sort()).toEqual(["/post/a", "/post/b"]);
  });

  it("请求失败：解析 undefined、不写缓存、下一次调用会重试", async () => {
    let fail = true;
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      if (fail) {
        throw new Error("network down");
      }
      return jsonOk(countsFor(["/post/x"]));
    }) as any;
    const first = await requestCommentCount("/post/x");
    expect(first).toBeUndefined(); // 组件据此保持 "…" 占位符
    expect(getCachedCount("/post/x")).toBeUndefined(); // 失败没有被缓存成 0
    expect(calls).toBe(1);
    // 接口恢复后，下一次调用能拿到真值（countsFor 给的数是 path 长度）
    fail = false;
    const second = await requestCommentCount("/post/x");
    expect(second).toBe("/post/x".length);
    expect(calls).toBe(2);
    expect(getCachedCount("/post/x")).toBe("/post/x".length);
  });

  it("HTTP 非 2xx 同样按失败处理（不是 0）", async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as any;
    const value = await requestCommentCount("/post/err");
    expect(value).toBeUndefined();
    expect(getCachedCount("/post/err")).toBeUndefined();
  });

  it("缓存有上限：超过 COUNT_CACHE_MAX 时按插入序淘汰最老的", async () => {
    const overflow = COUNT_CACHE_MAX + 50;
    global.fetch = (async (url: any) => {
      const q = new URL(String(url), "http://x").searchParams.get("paths") || "";
      return jsonOk(countsFor(q.split(",")));
    }) as any;
    const paths = Array.from({ length: overflow }, (_, i) => `/post/c${i}`);
    // 一批最多 50 个，串行发（每批等上一批完成）
    for (let i = 0; i < paths.length; i += COUNT_BATCH_MAX) {
      const chunk = paths.slice(i, i + COUNT_BATCH_MAX);
      await Promise.all(chunk.map((p) => requestCommentCount(p)));
    }
    expect(cachedCountSize()).toBeLessThanOrEqual(COUNT_CACHE_MAX);
    // 最老的被淘汰、最新的还在
    expect(getCachedCount(paths[0])).toBeUndefined();
    expect(getCachedCount(paths[overflow - 1])).toBe((paths[overflow - 1]).length);
  });
});

describe("loadCommentSetting：失败不再被永久缓存", () => {
  it("成功后全站只取一次", async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return jsonOk({ provider: "builtin", moderation: "post", requireEmail: false, maxContentLength: 2000 });
    }) as any;
    const [a, b] = await Promise.all([loadCommentSetting(), loadCommentSetting()]);
    expect(a?.provider).toBe("builtin");
    expect(b).toBe(a);
    const c = await loadCommentSetting();
    expect(calls).toBe(1);
    expect(c?.provider).toBe("builtin");
  });

  it("失败返回 null 且**不缓存失败**：接口恢复后下一次调用拿到真设置", async () => {
    let fail = true;
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      if (fail) {
        throw new Error("boom");
      }
      return jsonOk({ provider: "waline", moderation: "none", requireEmail: true, maxContentLength: 1000 });
    }) as any;
    const first = await loadCommentSetting();
    expect(first).toBeNull();
    expect(calls).toBe(1);
    fail = false;
    // 旧实现这里会直接返回被缓存的 null（评论区在整个会话里静默失效）
    const second = await loadCommentSetting();
    expect(second?.provider).toBe("waline");
    expect(calls).toBe(2);
    // 成功之后才开始缓存
    await loadCommentSetting();
    expect(calls).toBe(2);
  });

  it("HTTP 非 2xx / 空 data 也按失败处理（可重试）", async () => {
    global.fetch = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as any;
    expect(await loadCommentSetting()).toBeNull();
    global.fetch = (async () => jsonOk(null)) as any;
    expect(await loadCommentSetting()).toBeNull();
    global.fetch = (async () => jsonOk({ provider: "off" })) as any;
    expect((await loadCommentSetting())?.provider).toBe("off");
  });
});

describe("Count.tsx：失败渲染成占位符，不再是 0", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join("\n");

  it("undefined（没取到）保持 …，catch 分支也不再 setCount(0)", () => {
    const src = strip(read("components/Comment/Count.tsx"));
    expect(src).toContain("setCount(n === undefined ? null : n)");
    expect(src).toContain("setCount(null)");
    expect(src).not.toContain("setCount(0)");
  });
});
