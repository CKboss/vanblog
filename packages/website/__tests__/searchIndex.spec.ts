import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEARCH_INDEX_MAX_BYTES,
  SEARCH_INDEX_STALE_MS,
  SEARCH_INDEX_URL,
  SEARCH_INDEX_VERSION,
  decideSearchBackend,
  explainIndexFailure,
  loadResultFromResponse,
  parseSearchIndexText,
  readSearchQueryParams,
  searchPageUrl,
  serverSearchUrl,
  staleIndexNotice,
  truncatedIndexNotice,
  validateSearchIndexPayload,
} from "../utils/searchIndex";
import {
  SEARCH_INDEX_RETRY_MS,
  loadSearchIndex,
  resetSearchIndexCache,
  runSearch,
  searchPathLog,
} from "../api/searchIndex";

/** 一份合法的索引（键名与 server 的 searchIndexBuild.ts 逐字对应） */
function indexFile(over: Record<string, unknown> = {}) {
  return {
    version: SEARCH_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    codeVersion: "v-test",
    truncated: false,
    maxDocs: 2000,
    snippetChars: 200,
    count: 1,
    total: 1,
    docs: [
      {
        id: 7,
        u: "/post/hello",
        t: "Docker 部署指南",
        s: "这是一段摘要，里面提到 docker 与备份。",
        c: "随笔",
        g: ["docker"],
        d: "2026-01-02",
        w: 2617,
      },
    ],
    ...over,
  };
}

function fakeFetch(impl: (url: string) => Promise<any> | any) {
  const fn = vi.fn(async (url: string) => impl(url));
  return fn as unknown as (url: string, init?: any) => Promise<any>;
}

/**
 * 一个假的 Response。
 * ⚠️ 必须同时给 `text()` 与 `json()`：索引那条路（api/searchIndex.ts）读 `text()`，
 * 而降级到的 `api/search.ts` 里既有的 `searchArticles` 读的是 `json()`。
 */
function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

beforeEach(() => {
  resetSearchIndexCache();
});

afterEach(() => {
  resetSearchIndexCache();
  vi.useRealTimers();
  delete (globalThis as any).fetch;
});

describe("索引校验：每一种坏法都要被认出来，而不是被当成空索引", () => {
  it("一份正常的索引通过校验，字段被逐条收敛", () => {
    const result = validateSearchIndexPayload(indexFile());
    expect(result.ok).toBe(true);
    expect(result.index!.docs).toHaveLength(1);
    expect(result.index!.docs[0]).toEqual({
      id: 7,
      u: "/post/hello",
      t: "Docker 部署指南",
      s: "这是一段摘要，里面提到 docker 与备份。",
      c: "随笔",
      g: ["docker"],
      d: "2026-01-02",
      w: 2617,
    });
    expect(result.index!.truncated).toBe(false);
  });

  it("version 不是 1 → reason=version（server 升级了而前台还是旧的 ISR 缓存）", () => {
    const result = validateSearchIndexPayload(indexFile({ version: 2 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version");
    expect(result.detail).toContain("2");
    expect(validateSearchIndexPayload(indexFile({ version: undefined })).reason).toBe("version");
    expect(validateSearchIndexPayload(indexFile({ version: "1" })).reason).toBe("version");
  });

  it("docs 不是数组 / 顶层不是对象 / 文档缺 u → reason=shape", () => {
    expect(validateSearchIndexPayload(indexFile({ docs: "nope" })).reason).toBe("shape");
    expect(validateSearchIndexPayload(indexFile({ docs: null })).reason).toBe("shape");
    expect(validateSearchIndexPayload([]).reason).toBe("shape");
    expect(validateSearchIndexPayload(null).reason).toBe("shape");
    expect(validateSearchIndexPayload("text").reason).toBe("shape");
    expect(
      validateSearchIndexPayload(indexFile({ docs: [{ id: 1, t: "没有 u" }] })).reason,
    ).toBe("shape");
    expect(
      validateSearchIndexPayload(indexFile({ docs: [{ id: 1, u: "" }] })).reason,
    ).toBe("shape");
    expect(validateSearchIndexPayload(indexFile({ docs: [null] })).reason).toBe("shape");
  });

  it("可选字段缺失或类型不对时给安全默认值（不把整份索引判死）", () => {
    const result = validateSearchIndexPayload(
      indexFile({
        generatedAt: 12345,
        codeVersion: null,
        truncated: "yes",
        maxDocs: "x",
        snippetChars: undefined,
        count: undefined,
        total: "53",
        docs: [{ id: "9", u: "/post/9", t: 42, s: null, c: 7, g: "nope", d: 2026, w: "100" }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.index).toMatchObject({
      generatedAt: "",
      codeVersion: "",
      truncated: false,
      maxDocs: 0,
      snippetChars: 0,
      count: 1,
    });
    expect(result.index!.total).toBeUndefined();
    expect(result.index!.docs[0]).toEqual({
      id: 9, // "9" → 9（server 给的一定是数字，这里是防御）
      u: "/post/9",
      t: "",
      s: "",
      c: "",
      g: [],
      d: "",
      w: 100, // "100" → 100（同上，宽松数字）
    });
    // id 完全缺失时用数组下标兜底（key 不能是 NaN）
    const noId = validateSearchIndexPayload(indexFile({ docs: [{ u: "/post/a" }, { u: "/post/b" }] }));
    expect(noId.index!.docs.map((d) => d.id)).toEqual([0, 1]);
  });

  it("不是 JSON → reason=not-json；空响应体也是", () => {
    expect(parseSearchIndexText("<html>502 Bad Gateway</html>").reason).toBe("not-json");
    expect(parseSearchIndexText("").reason).toBe("not-json");
    expect(parseSearchIndexText('{"version":1,').reason).toBe("not-json");
    expect(parseSearchIndexText(JSON.stringify(indexFile())).ok).toBe(true);
  });

  it("体积异常 → reason=too-large（比如某个错误页返回了 40MB）", () => {
    const huge = JSON.stringify(indexFile({ docs: [] }));
    const result = parseSearchIndexText(huge, SEARCH_INDEX_MAX_BYTES + 1);
    expect(result.reason).toBe("too-large");
    expect(parseSearchIndexText(huge, SEARCH_INDEX_MAX_BYTES).ok).toBe(true);
  });

  it("HTTP 状态码：404 → missing，其它非 2xx → http，2xx 交给解析", () => {
    expect(loadResultFromResponse(404, "").reason).toBe("missing");
    expect(loadResultFromResponse(429, "").reason).toBe("http");
    expect(loadResultFromResponse(502, "<html>").reason).toBe("http");
    expect(loadResultFromResponse(500, "").detail).toContain("500");
    expect(loadResultFromResponse(200, JSON.stringify(indexFile())).ok).toBe(true);
    expect(loadResultFromResponse(200, "<html>").reason).toBe("not-json");
  });
});

describe("降级判定矩阵：索引只要不是「整个可信」，就退回服务端搜索", () => {
  const CASES: Array<[string, ReturnType<typeof loadResultFromResponse>]> = [
    ["missing", loadResultFromResponse(404, "")],
    ["http", loadResultFromResponse(500, "")],
    ["not-json", loadResultFromResponse(200, "<html>")],
    ["version", loadResultFromResponse(200, JSON.stringify(indexFile({ version: 99 })))],
    ["shape", loadResultFromResponse(200, JSON.stringify(indexFile({ docs: "x" })))],
    ["too-large", parseSearchIndexText("{}", SEARCH_INDEX_MAX_BYTES + 1)],
    ["network", { ok: false, reason: "network", detail: "offline" }],
  ];

  it("七种失败一律 backend=server，且都带一句能给用户看的原因", () => {
    expect(CASES.map(([reason]) => reason)).toEqual([
      "missing",
      "http",
      "not-json",
      "version",
      "shape",
      "too-large",
      "network",
    ]);
    for (const [reason, load] of CASES) {
      const decision = decideSearchBackend(load);
      expect(decision.backend, reason).toBe("server");
      expect(decision.reason, reason).toContain("服务端搜索");
      expect(decision.reason.length, reason).toBeGreaterThan(10);
      expect(explainIndexFailure(reason as any), reason).toBeTruthy();
    }
  });

  it("索引正常时 backend=index、reason 为空（正常路径不该有任何提示噪音）", () => {
    const decision = decideSearchBackend(loadResultFromResponse(200, JSON.stringify(indexFile())));
    expect(decision).toEqual({ backend: "index", reason: "" });
  });

  it("负控：ok=true 但 index 缺失也必须降级（否则下游在 undefined 上炸）", () => {
    expect(decideSearchBackend({ ok: true } as any).backend).toBe("server");
    expect(decideSearchBackend(undefined as any).backend).toBe("server");
  });

  it("每种失败原因的文案互不相同（否则「报告用了哪条路」就没有信息量）", () => {
    const reasons = CASES.map(([reason]) => explainIndexFailure(reason as any));
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(explainIndexFailure("unknown" as any)).toContain("unknown");
  });
});

describe("索引的时效与截断提示", () => {
  it("truncated=true 时如实说明「只含最近 N 篇」，并带上全站总数", () => {
    expect(truncatedIndexNotice(indexFile({ truncated: false }) as any)).toBe("");
    const notice = truncatedIndexNotice(
      indexFile({ truncated: true, count: 2000, total: 5123 }) as any,
    );
    expect(notice).toContain("2000");
    expect(notice).toContain("5123");
    expect(notice).toContain("服务端搜索");
    // 没有 total（老索引）时也要能说清楚
    const withoutTotal = truncatedIndexNotice(indexFile({ truncated: true, count: 2000 }) as any);
    expect(withoutTotal).toContain("2000");
    expect(withoutTotal).not.toContain("undefined");
  });

  it("超过新鲜度窗口时提示可能不是最新的；窗口内不提示", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(
      staleIndexNotice(indexFile({ generatedAt: new Date(now - 60000).toISOString() }) as any, now),
    ).toBe("");
    const stale = staleIndexNotice(
      indexFile({ generatedAt: new Date(now - SEARCH_INDEX_STALE_MS - 3600000).toISOString() }) as any,
      now,
    );
    expect(stale).toContain("小时");
    expect(stale).toContain("ISR");
    // generatedAt 缺失或非法：不猜，也就不提示（提示一个错误的"陈旧"比不提示更糟）
    expect(staleIndexNotice(indexFile({ generatedAt: "" }) as any, now)).toBe("");
    expect(staleIndexNotice(indexFile({ generatedAt: "不是日期" }) as any, now)).toBe("");
  });
});

describe("URL 约定：查询与页码都在 URL 里（可分享、可后退）", () => {
  it("searchPageUrl：第 1 页不写 p，空查询不写 q", () => {
    expect(searchPageUrl("docker", 1)).toBe("/search?q=docker");
    expect(searchPageUrl("docker", 2)).toBe("/search?q=docker&p=2");
    expect(searchPageUrl("", 1)).toBe("/search");
    expect(searchPageUrl("  ", 3)).toBe("/search?p=3");
    expect(searchPageUrl("docker", 0)).toBe("/search?q=docker");
    expect(searchPageUrl("docker", Number.NaN)).toBe("/search?q=docker");
  });

  it("查询必须被百分号编码（C# / a&b / 中文 / 攻击串）", () => {
    expect(searchPageUrl("C#", 1)).toBe("/search?q=C%23");
    expect(searchPageUrl("a&b=c", 1)).toBe("/search?q=a%26b%3Dc");
    expect(searchPageUrl("备份", 1)).toBe(`/search?q=${encodeURIComponent("备份")}`);
    expect(searchPageUrl("<img src=x>", 1)).toBe(`/search?q=${encodeURIComponent("<img src=x>")}`);
  });

  it("readSearchQueryParams：数组形式的 query、垃圾页码都收敛成安全值", () => {
    expect(readSearchQueryParams({ q: "docker", p: "3" })).toEqual({ q: "docker", page: 3 });
    expect(readSearchQueryParams({ q: ["a", "b"], p: ["2", "9"] })).toEqual({ q: "a", page: 2 });
    expect(readSearchQueryParams({})).toEqual({ q: "", page: 1 });
    expect(readSearchQueryParams({ q: undefined, p: undefined })).toEqual({ q: "", page: 1 });
    expect(readSearchQueryParams({ p: "abc" })).toEqual({ q: "", page: 1 });
    expect(readSearchQueryParams({ p: "-2" })).toEqual({ q: "", page: 1 });
    expect(readSearchQueryParams({ p: "0" })).toEqual({ q: "", page: 1 });
    expect(readSearchQueryParams(undefined as any)).toEqual({ q: "", page: 1 });
  });

  it("服务端搜索地址用的是接口自己的参数名 value（不是 q）", () => {
    expect(serverSearchUrl("docker")).toBe("/api/public/search?value=docker");
    expect(serverSearchUrl("C#")).toBe("/api/public/search?value=C%23");
    expect(serverSearchUrl("")).toBe("/api/public/search?value=");
    expect(SEARCH_INDEX_URL).toBe("/static/search/index.json");
  });
});

describe("懒加载与会话缓存", () => {
  it("第一次真的搜的时候才 fetch，之后整个会话复用（翻页/改词都不重取）", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, indexFile()));
    const first = await loadSearchIndex(fetchImpl as any);
    const second = await loadSearchIndex(fetchImpl as any);
    const third = await loadSearchIndex(fetchImpl as any);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    expect((fetchImpl as any).mock.calls).toHaveLength(1);
  });

  it("并发调用只发一次请求（in-flight 去重）", async () => {
    const fetchImpl = fakeFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse(200, indexFile());
    });
    const results = await Promise.all([
      loadSearchIndex(fetchImpl as any),
      loadSearchIndex(fetchImpl as any),
      loadSearchIndex(fetchImpl as any),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((fetchImpl as any).mock.calls).toHaveLength(1);
  });

  it("失败只缓存 60 秒：全新安装的站点索引生成好之后能自己被发现", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return calls === 1 ? jsonResponse(404, "") : jsonResponse(200, indexFile());
    });
    const first = await loadSearchIndex(fetchImpl as any);
    expect(first.ok).toBe(false);
    expect(first.reason).toBe("missing");
    // 窗口内：仍然用缓存的失败结果，不重复打 404
    const again = await loadSearchIndex(fetchImpl as any);
    expect(again.ok).toBe(false);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(SEARCH_INDEX_RETRY_MS + 1);
    const later = await loadSearchIndex(fetchImpl as any);
    expect(later.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("fetch 抛错（离线 / 超时 abort）→ reason=network，不往上抛", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("Failed to fetch");
    });
    const result = await loadSearchIndex(fetchImpl as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("network");
    expect(result.detail).toContain("Failed to fetch");
  });

  it("环境里没有 fetch 时也不抛（SSR / 老环境）", async () => {
    const saved = (globalThis as any).fetch;
    delete (globalThis as any).fetch;
    try {
      const result = await loadSearchIndex(undefined);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("network");
    } finally {
      (globalThis as any).fetch = saved;
    }
  });

  it("请求的是 /static/search/index.json，并且带 no-cache（索引会被 ISR 重新生成）", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetchImpl = ((url: string, init: any) => {
      seen.push({ url, init });
      return Promise.resolve(jsonResponse(200, indexFile()));
    }) as any;
    await loadSearchIndex(fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/static/search/index.json");
    expect(seen[0].init.cache).toBe("no-cache");
  });
});

describe("runSearch：走哪条路，以及为什么", () => {
  it("索引可用时走索引，并且不带任何降级提示", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, indexFile()));
    const execution = await runSearch("docker", { fetchImpl: fetchImpl as any });
    expect(execution.backend).toBe("index");
    expect(execution.notice).toBe("");
    expect(execution.results.map((r) => r.doc.u)).toEqual(["/post/hello"]);
    expect(execution.matched).toBe(1);
    expect(execution.capped).toBe(false);
    expect(execution.indexNotices).toEqual([]);
    expect(searchPathLog().slice(-1)[0]).toMatchObject({ query: "docker", backend: "index" });
  });

  it("索引 404 时退回服务端搜索，并把原因写进 notice 与账本", async () => {
    const indexFetch = fakeFetch(() => jsonResponse(404, ""));
    (globalThis as any).fetch = fakeFetch(() =>
      jsonResponse(200, {
        statusCode: 200,
        data: {
          data: [
            { id: 3, title: "服务端找到的 docker 文章", category: "随笔", tags: ["docker"], createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      }),
    );
    const execution = await runSearch("docker", { fetchImpl: indexFetch as any });
    expect(execution.backend).toBe("server");
    expect(execution.notice).toContain("静态索引");
    expect(execution.notice).toContain("404");
    expect(execution.results.map((r) => r.doc.id)).toEqual([3]);
    // 服务端结果没有 pathname，链接回落数字 id
    expect(execution.results[0].doc.u).toBe("/post/3");
    const entry = searchPathLog().slice(-1)[0];
    expect(entry.backend).toBe("server");
    expect(entry.reason).toContain("404");
  });

  it("索引坏了（版本不符）也退回服务端，notice 里说清是版本问题", async () => {
    const indexFetch = fakeFetch(() => jsonResponse(200, indexFile({ version: 99 })));
    (globalThis as any).fetch = fakeFetch(() =>
      jsonResponse(200, { statusCode: 200, data: { data: [] } }),
    );
    const execution = await runSearch("docker", { fetchImpl: indexFetch as any });
    expect(execution.backend).toBe("server");
    expect(execution.notice).toContain("版本");
  });

  it("两条路都失败时**抛错**（调用方显示「搜索失败」，与「暂无结果」区分开）", async () => {
    const indexFetch = fakeFetch(() => jsonResponse(500, ""));
    (globalThis as any).fetch = fakeFetch(() => jsonResponse(503, ""));
    await expect(runSearch("docker", { fetchImpl: indexFetch as any })).rejects.toThrow();
    const entry = searchPathLog().slice(-1)[0];
    expect(entry.backend).toBe("server");
    expect(entry.reason).toContain("也失败");
  });

  it("truncated 与陈旧的索引：仍然用，但把提示带出来", async () => {
    const old = new Date(Date.now() - SEARCH_INDEX_STALE_MS - 7200000).toISOString();
    const fetchImpl = fakeFetch(() =>
      jsonResponse(200, indexFile({ truncated: true, count: 2000, total: 5123, generatedAt: old })),
    );
    const execution = await runSearch("docker", { fetchImpl: fetchImpl as any });
    expect(execution.backend).toBe("index");
    expect(execution.notice).toBe("");
    expect(execution.indexNotices).toHaveLength(2);
    expect(execution.indexNotices.join(" ")).toContain("5123");
    expect(execution.indexNotices.join(" ")).toContain("小时");
  });

  it("空查询不发任何请求（避免「打开页面就打一次搜索」）", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, indexFile()));
    const execution = await runSearch("   ", { fetchImpl: fetchImpl as any });
    expect(execution.results).toEqual([]);
    expect(execution.matched).toBe(0);
    expect((fetchImpl as any).mock.calls).toHaveLength(0);
  });

  it("forceBackend=server 可以跳过索引（页面上的「服务端全文搜索」出口用得到）", async () => {
    const indexFetch = fakeFetch(() => jsonResponse(200, indexFile()));
    (globalThis as any).fetch = fakeFetch(() =>
      jsonResponse(200, { statusCode: 200, data: { data: [{ id: 1, title: "全文命中" }] } }),
    );
    const execution = await runSearch("全文", {
      fetchImpl: indexFetch as any,
      forceBackend: "server",
    });
    expect(execution.backend).toBe("server");
    expect((indexFetch as any).mock.calls).toHaveLength(0);
  });

  it("账本有上限（不会在长时间运行的页面里无限增长）", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, indexFile()));
    for (let i = 0; i < 40; i++) {
      await runSearch("docker", { fetchImpl: fetchImpl as any });
    }
    expect(searchPathLog().length).toBeLessThanOrEqual(20);
    expect(searchPathLog().length).toBeGreaterThan(0);
  });
});
