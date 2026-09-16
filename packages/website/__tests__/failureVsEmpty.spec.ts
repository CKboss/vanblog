import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizePageviewPayload } from "../api/pageview";
import { searchArticles } from "../api/search";

/**
 * 「请求失败」和「没有数据」不许渲染成同一个样子，也不许让调用方解构 undefined。
 * - pageview：以前 `statusCode === 233 ? DEFAULT : data` 会把接口错误时的
 *   undefined 原样返回，_app 的解构直接抛 TypeError（没人处理的 rejection）。
 * - search：以前 `data.data` 在错误体上抛 TypeError，而 SearchCard 没有 catch，
 *   loading 永远停在 true —— 用户看到一行卡死的「搜索中...」。
 */
describe("normalizePageviewPayload", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("233（未初始化）与合法 payload", () => {
    expect(normalizePageviewPayload(233, undefined)).toEqual({ viewer: 0, visited: 0 });
    expect(normalizePageviewPayload(200, { viewer: 3, visited: 9 })).toEqual({
      viewer: 3,
      visited: 9,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("畸形 payload 回默认值并留下 console 痕迹（不是静默）", () => {
    expect(normalizePageviewPayload(500, undefined)).toEqual({ viewer: 0, visited: 0 });
    expect(normalizePageviewPayload(200, null)).toEqual({ viewer: 0, visited: 0 });
    expect(normalizePageviewPayload(200, { viewer: "3", visited: 9 })).toEqual({
      viewer: 0,
      visited: 0,
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("searchArticles", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("正常返回列表", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ statusCode: 200, data: { data: [{ id: 1, title: "a" }] } }),
    })) as any;
    const list = await searchArticles("a");
    expect(list).toEqual([{ id: 1, title: "a" }]);
  });

  it("HTTP 错误如实抛（调用方显示「搜索失败」而不是永远转圈）", async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as any;
    await expect(searchArticles("a")).rejects.toThrow(/HTTP 500/);
  });

  it("返回体缺 data.data 也抛，不再对 undefined 取属性", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ statusCode: 200, data: null }),
    })) as any;
    await expect(searchArticles("a")).rejects.toThrow(/不可用/);
  });

  it("搜索词仍然编码（robustness.spec 里那条的兜底复验）", async () => {
    let asked = "";
    global.fetch = (async (url: any) => {
      asked = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ statusCode: 200, data: { data: [] } }),
      };
    }) as any;
    await searchArticles("C#");
    expect(asked).toContain("value=C%23");
  });
});

describe("接线：SearchCard 有过期响应守卫和失败态", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join("\n");

  it("onSearch 带序号守卫 + try/catch，失败有独立文案", () => {
    const src = strip(read("components/SearchCard/index.tsx"));
    expect(src).toContain("const seq = ++seqRef.current;");
    expect(src).toContain("if (seq !== seqRef.current) {");
    expect(src).toContain("setFailed(true)");
    expect(src).toContain("搜索失败，请稍后再试");
  });

  it("_app 的访客统计：noViewer 判据与 PostViewer 一致（=== \"true\"），且整体有 catch", () => {
    const src = strip(read("pages/_app.tsx"));
    expect(src).toContain('getItem("noViewer") === "true"');
    expect(src).toContain("console.warn(\"[访客统计] 更新失败\"");
    // 不再展开闭包里的旧 globalState
    expect(src).not.toContain("...globalState");
  });
});
