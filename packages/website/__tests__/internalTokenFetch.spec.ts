import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  INTERNAL_HEADER,
  INTERNAL_TOKEN_ENV,
  serverFetch,
  shouldSendInternalToken,
} from "../api/internalFetch";

/**
 * 前台 SSR 请求带内部令牌头（`x-vanblog-internal`）。
 *
 * ## 修的是什么
 *
 * server 只允许 `isInternalRequest(req)`（回环直连 **或** 带 `x-vanblog-internal` 头）使用
 * `pageSize=-1`。一体式镜像里前台与 server 同容器、SSR 走 127.0.0.1 ⇒ 天然算内部。
 * 但**前后端分离部署**时前台打的是另一台机器，不再是回环，而以前前台是裸 `fetch`、
 * 一个头都不带（`VAN_BLOG_INTERNAL_TOKEN` 在整个 website 包里零命中）⇒ `pageSize=-1`
 * 被夹到 `MAX_PAGE_SIZE=100`，标签页/时间线**静默少数据**，不报错不留日志。
 * 而文档一直写着"分离部署时给两边配同一个 VAN_BLOG_INTERNAL_TOKEN 即可"——配了也没用。
 *
 * ## 这个 spec 要钉住的三件事
 *
 * 1. **功能**：设了令牌就带上头，且调用方原有的头（如 Content-Type）不丢；没设就与裸 fetch 等价。
 * 2. **不外泄**：浏览器上下文里绝不带这个头；变量名不是 `NEXT_PUBLIC_*`（否则 Next 会把值
 *    内联进客户端产物）；令牌在**调用时**读取而不是模块加载时（否则值会被固化）。
 * 3. **边界**：三个浏览器侧模块（文章解锁、阅读数、搜索）**不许**用这个封装 ——
 *    它们的请求从访客的浏览器发出，带上内部令牌等于把令牌交给访客。
 */

const TOKEN = "internal-token-value-123";

function stubFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ statusCode: 200, data: {} }) } as any;
  };
  return {
    calls,
    restore() {
      (globalThis as any).fetch = original;
    },
  };
}

let stub: ReturnType<typeof stubFetch>;
const OLD_TOKEN = process.env[INTERNAL_TOKEN_ENV];
const OLD_WINDOW = (globalThis as any).window;

beforeEach(() => {
  stub = stubFetch();
});
afterEach(() => {
  stub.restore();
  if (OLD_TOKEN === undefined) delete process.env[INTERNAL_TOKEN_ENV];
  else process.env[INTERNAL_TOKEN_ENV] = OLD_TOKEN;
  if (OLD_WINDOW === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = OLD_WINDOW;
});

describe("shouldSendInternalToken：只有服务端 + 真的配了令牌才带", () => {
  it("浏览器上下文一律 false（即使配了令牌）", () => {
    expect(shouldSendInternalToken({ [INTERNAL_TOKEN_ENV]: TOKEN }, true)).toBe(false);
  });
  it("服务端但未设 / 空串 / 只有空白 ⇒ false", () => {
    expect(shouldSendInternalToken({}, false)).toBe(false);
    expect(shouldSendInternalToken({ [INTERNAL_TOKEN_ENV]: "" }, false)).toBe(false);
    expect(shouldSendInternalToken({ [INTERNAL_TOKEN_ENV]: "   " }, false)).toBe(false);
    // 非字符串（例如误配成对象）也不带，免得把 "[object Object]" 当令牌发出去
    expect(
      shouldSendInternalToken({ [INTERNAL_TOKEN_ENV]: {} as any }, false),
    ).toBe(false);
  });
  it("服务端且配了非空令牌 ⇒ true", () => {
    expect(shouldSendInternalToken({ [INTERNAL_TOKEN_ENV]: TOKEN }, false)).toBe(true);
  });
  it("默认参数下（本 spec 跑在 node 环境）按服务端处理", () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    expect(shouldSendInternalToken()).toBe(true);
  });
});

describe("serverFetch：设了令牌就带头，没设就与裸 fetch 等价", () => {
  it("带上 x-vanblog-internal，且值就是环境变量的值（去掉首尾空白）", async () => {
    process.env[INTERNAL_TOKEN_ENV] = `  ${TOKEN}\n`;
    await serverFetch("http://127.0.0.1:3000/api/public/meta");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].init?.headers?.[INTERNAL_HEADER]).toBe(TOKEN);
  });

  it("调用方原有的头不被覆盖（Content-Type 等要保留）", async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    await serverFetch("http://x/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const headers = stub.calls[0].init?.headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[INTERNAL_HEADER]).toBe(TOKEN);
    expect(stub.calls[0].init?.method).toBe("POST");
    expect(stub.calls[0].init?.body).toBe("{}");
  });

  it("Headers 实例与数组形式的头也能保留", async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    await serverFetch("http://x/api", { headers: new Headers({ "X-Keep": "1" }) });
    // ⚠️ Headers 实例会把名字**规范化成小写**（fetch 规范如此），所以合并后是 `x-keep`
    //    而不是 `X-Keep`。这不是缺陷：HTTP 头名大小写不敏感，真正要钉的是"值没丢"。
    //    第一版这里断言的是原始大小写，于是假红 —— 断言要跟着规范走，不是跟着直觉走。
    const h0 = stub.calls[0].init?.headers;
    expect(h0["x-keep"] ?? h0["X-Keep"]).toBe("1");
    expect(h0[INTERNAL_HEADER]).toBe(TOKEN);

    await serverFetch("http://x/api", { headers: [["X-Keep2", "2"]] as any });
    expect(stub.calls[1].init?.headers["X-Keep2"]).toBe("2");
    expect(stub.calls[1].init?.headers[INTERNAL_HEADER]).toBe(TOKEN);
  });

  it("没设令牌时：init 原样透传，不加任何头（一体式部署行为一点不变）", async () => {
    delete process.env[INTERNAL_TOKEN_ENV];
    await serverFetch("http://x/api");
    expect(stub.calls[0].init).toBeUndefined();
    await serverFetch("http://x/api", { method: "POST" });
    expect(stub.calls[1].init).toEqual({ method: "POST" });
    expect(stub.calls[1].init?.headers).toBeUndefined();
  });

  it("浏览器上下文里即使配了令牌也不带（window 存在 ⇒ 不加头）", async () => {
    process.env[INTERNAL_TOKEN_ENV] = TOKEN;
    (globalThis as any).window = {} as any;
    await serverFetch("http://x/api");
    expect(stub.calls[0].init).toBeUndefined();
  });

  it("令牌在**调用时**读取：改了环境变量下一次调用就用新值（没有被固化）", async () => {
    process.env[INTERNAL_TOKEN_ENV] = "first";
    await serverFetch("http://x/api");
    process.env[INTERNAL_TOKEN_ENV] = "second";
    await serverFetch("http://x/api");
    expect(stub.calls[0].init?.headers?.[INTERNAL_HEADER]).toBe("first");
    expect(stub.calls[1].init?.headers?.[INTERNAL_HEADER]).toBe("second");
  });
});

describe("不外泄：变量名与读取位置", () => {
  const src = () =>
    readFileSync(join(__dirname, "../api/internalFetch.ts"), "utf-8");
  const noComments = () =>
    src()
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

  it("环境变量名不是 NEXT_PUBLIC_*（否则 Next 会把令牌内联进客户端产物）", () => {
    expect(INTERNAL_TOKEN_ENV).toBe("VAN_BLOG_INTERNAL_TOKEN");
    expect(INTERNAL_TOKEN_ENV.startsWith("NEXT_PUBLIC_")).toBe(false);
    // 源码里也不许出现 NEXT_PUBLIC_ 形式的令牌变量
    expect(noComments()).not.toMatch(/NEXT_PUBLIC_[A-Z_]*TOKEN/);
  });

  it("读环境变量必须在 window 判定之后（源码级形状钉子）", () => {
    // ⚠️ 断言**形状**而不是"出现了 typeof window 这个词"：只写 toContain 的话，
    //    一条注释就能让它通过。这里要求判定函数体里先判 isBrowser 再读 env。
    expect(noComments()).toMatch(
      /export function shouldSendInternalToken\([\s\S]{0,220}?if \(isBrowser\) return false;[\s\S]{0,120}?env\[INTERNAL_TOKEN_ENV\]/,
    );
    expect(noComments()).toMatch(/if \(!shouldSendInternalToken\(\)\) \{\s*return fetch\(url, init\);/);
  });

  it("空转反证：上面两条正则换个形状就不命中（证明它们不是恒真）", () => {
    const wrongOrder = `export function shouldSendInternalToken(env, isBrowser) {
      const token = env[INTERNAL_TOKEN_ENV];
      if (isBrowser) return false;
      return true;
    }`;
    expect(wrongOrder).not.toMatch(
      /export function shouldSendInternalToken\([\s\S]{0,220}?if \(isBrowser\) return false;[\s\S]{0,120}?env\[INTERNAL_TOKEN_ENV\]/,
    );
    expect("export const NEXT_PUBLIC_INTERNAL_TOKEN = 1;").toMatch(/NEXT_PUBLIC_[A-Z_]*TOKEN/);
  });
});

describe("边界：浏览器侧的三个模块不许用这个封装", () => {
  const strip = (rel: string) =>
    readFileSync(join(__dirname, rel), "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

  it("文章解锁 / 阅读数 / 搜索 / 页脚统计都不 import internalFetch", () => {
    // 这几个请求是从**访客的浏览器**发出的，带上内部令牌等于把令牌交给访客。
    for (const rel of [
      "../api/getArticleViewer.ts",
      "../api/search.ts",
      "../api/pageview.ts",
    ]) {
      // ⚠️ 用直接断言而不是 expect.not.stringContaining：本包的 vitest 是 0.29，
      //    那个非对称匹配器不一定存在，写错了会变成"断言本身抛异常"而不是"断言失败"。
      expect([rel, strip(rel).includes("internalFetch")]).toEqual([rel, false]);
      expect([rel, strip(rel).includes("serverFetch")]).toEqual([rel, false]);
    }
    // 空转反证：如果这些文件真的 import 了封装，上面的断言会红
    expect('import { serverFetch } from "./internalFetch";'.includes("internalFetch")).toBe(true);
  });

  it("getArticles.ts 里只有 SSR 的那几处走 serverFetch，解锁那条仍是裸 fetch", () => {
    const src = strip("../api/getArticles.ts");
    // 解锁用的是相对路径 + POST + body，必须保持裸 fetch（浏览器侧）
    expect(src).toMatch(/const url = `\/api\/public\/article\/\$\{id\}`;\s*const res = await fetch\(url, \{/);
    // SSR 的 5 处走封装
    expect(src.match(/await serverFetch\(url\)/g)?.length).toBe(5);
    // getAllData 的 3 处也走封装
    expect(strip("../api/getAllData.ts").match(/await serverFetch\(url\)/g)?.length).toBe(3);
  });

  it("空转反证：把解锁那条改成 serverFetch，上面的断言就会红", () => {
    const mutated = 'const url = `/api/public/article/${id}`;\n    const res = await serverFetch(url, {';
    expect(mutated).not.toMatch(
      /const url = `\/api\/public\/article\/\$\{id\}`;\s*const res = await fetch\(url, \{/,
    );
  });
});

describe("跨包一致性：发的头名与 server 认的头名必须一致", () => {
  it("server 的 isInternalRequest 认的就是 x-vanblog-internal", () => {
    const rateLimit = readFileSync(
      join(__dirname, "../../server/src/utils/rateLimit.ts"),
      "utf-8",
    );
    // ⚠️ 任一侧改名都会让"分离部署配了令牌却仍然少数据"这个 bug 悄悄回来，
    //    而且两边各自的测试都还是绿的 —— 所以必须有一条跨包钉子。
    expect(INTERNAL_HEADER).toBe("x-vanblog-internal");
    expect(rateLimit).toContain("x-vanblog-internal");
    const publicController = readFileSync(
      join(__dirname, "../../server/src/controller/public/public.controller.ts"),
      "utf-8",
    );
    expect(publicController).toMatch(/isInternalRequest\(/);
  });

  it("server 侧确实是「回环 或 带内部令牌」才放行 pageSize=-1", () => {
    const rateLimit = readFileSync(
      join(__dirname, "../../server/src/utils/rateLimit.ts"),
      "utf-8",
    );
    expect(rateLimit).toMatch(/VAN_BLOG_INTERNAL_TOKEN/);
    expect(rateLimit).toMatch(/export function isInternalRequest/);
  });
});
