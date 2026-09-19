// ⚠️ 本包的 vitest **没有开 globals**，describe/it/expect/beforeEach/afterEach 必须显式 import
// （漏了的话不是"断言失败"而是 `ReferenceError: afterEach is not defined`，整个文件收集不起来）
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import handler, { isLoopbackRevalidateRequest } from "../pages/api/revalidate";

/**
 * `/api/revalidate` 的鉴权语义。
 *
 * ## 以前的行为（缺陷）
 *
 *     const secret = process.env.VAN_BLOG_REVALIDATE_SECRET || "";
 *     if (secret && String(req.query?.secret ?? "") !== secret) return 401;
 *
 * `if (secret && …)` 意味着**没配密钥就完全不校验**。而这个变量在 compose 模板、
 * `entrypoint.sh`、`scripts/start.js` 里都没有默认值 ⇒ "没配"是默认状态。
 * 一体式镜像里 caddy 把 `/api/*` 全转给 Nest，所以外网打不到；但**单独部署 website**
 * 时它就是一个匿名的"任意路径重渲染"放大器（CPU + 磁盘），而且在容器网络内可达
 * （可以与 SSRF 串联：让服务端替你打自己）。
 *
 * ## 现在的语义
 *
 * - 配了密钥 ⇒ 一律要求 `?secret=`（不看来源）。server 侧在设了这个变量时会自动带上
 *   （`provider/isr/isr.provider.ts` 的 `buildRevalidateUrl`）。
 * - 没配密钥 ⇒ **失败关闭**，只放行"真回环直连"：套接字地址是回环 **且** 没有
 *   `x-forwarded-for` / `x-real-ip`。判据与 server 的 `utils/rateLimit.ts`
 *   `isLoopbackRequest` 一致 —— 只看套接字地址不够，因为分离部署时反代常与 website 同机，
 *   套接字地址也是回环，但它转发的是公网访客。
 *
 * 一体式镜像不受影响：server 调的是**写死的** `http://127.0.0.1:3001/api/revalidate`，
 * axios 直连、不加转发头 ⇒ 判定为回环直连。这一点由下面最后那条跨包钉子保证。
 */

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    revalidated: [] as string[],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    async revalidate(p: string) {
      res.revalidated.push(p);
    },
  };
  return res;
}

function fakeReq(opts: {
  remoteAddress?: string;
  headers?: Record<string, string>;
  path?: string;
  secret?: string;
}) {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    headers: opts.headers ?? {},
    query: {
      ...(opts.path === undefined ? {} : { path: opts.path }),
      ...(opts.secret === undefined ? {} : { secret: opts.secret }),
    },
  };
}

const OLD_SECRET = process.env.VAN_BLOG_REVALIDATE_SECRET;
afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.VAN_BLOG_REVALIDATE_SECRET;
  else process.env.VAN_BLOG_REVALIDATE_SECRET = OLD_SECRET;
  // ⚠️ 这里是 **vitest**，没有 `jest` 这个全局（写了会 ReferenceError，而且表现为
  //    "12 条全红"而不是"某条断言失败"，很容易误判成实现坏了）。本文件也没用任何 mock，
  //    所以不需要 restoreAllMocks；要用请 `import { vi } from "vitest"` 再 `vi.restoreAllMocks()`。
});

describe("未设密钥：失败关闭，只放行真回环直连", () => {
  beforeEach(() => {
    delete process.env.VAN_BLOG_REVALIDATE_SECRET;
  });

  it("回环直连（127.0.0.1、无转发头）照常放行 —— 一体式镜像走的就是这条", async () => {
    const res = fakeRes();
    await handler(fakeReq({ path: "/post/hello" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.revalidated).toEqual(["/post/hello"]);
  });

  it("::1 与 ::ffff:127.0.0.1 也算回环", async () => {
    for (const addr of ["::1", "::ffff:127.0.0.1"]) {
      const res = fakeRes();
      await handler(fakeReq({ remoteAddress: addr, path: "/" }), res);
      expect(res.revalidated).toEqual(["/"]);
      expect(res.statusCode).toBe(200);
    }
  });

  it("非回环来源 ⇒ 403，且**没有**触发任何重渲染", async () => {
    const res = fakeRes();
    await handler(fakeReq({ remoteAddress: "203.0.113.7", path: "/" }), res);
    expect(res.statusCode).toBe(403);
    expect(res.revalidated).toEqual([]);
    expect(String(res.body?.reason)).toContain("VAN_BLOG_REVALIDATE_SECRET");
  });

  it("回环但带转发头（反代同机部署的真实形状）⇒ 403", async () => {
    for (const headers of [
      { "x-forwarded-for": "203.0.113.9" },
      { "x-real-ip": "203.0.113.9" },
    ]) {
      const res = fakeRes();
      await handler(fakeReq({ headers, path: "/" }), res);
      expect(res.statusCode).toBe(403);
      expect(res.revalidated).toEqual([]);
    }
  });

  it("取不到套接字地址时按「证明不了是回环」处理 ⇒ 403（不猜）", async () => {
    const res = fakeRes();
    await handler({ socket: {}, headers: {}, query: { path: "/" } } as any, res);
    expect(res.statusCode).toBe(403);
  });
});

describe("设了密钥：一律要求它，不看来源", () => {
  beforeEach(() => {
    process.env.VAN_BLOG_REVALIDATE_SECRET = "s3cr3t-value";
  });

  it("带对密钥的**外网**请求放行", async () => {
    const res = fakeRes();
    await handler(
      fakeReq({ remoteAddress: "203.0.113.7", path: "/", secret: "s3cr3t-value" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.revalidated).toEqual(["/"]);
  });

  it("密钥不对 ⇒ 401（即使来自回环）", async () => {
    for (const secret of ["wrong", ""]) {
      const res = fakeRes();
      await handler(fakeReq({ path: "/", secret }), res);
      expect(res.statusCode).toBe(401);
      expect(res.revalidated).toEqual([]);
    }
  });

  it("回环但没带密钥 ⇒ 401（配了密钥就不再靠来源放行）", async () => {
    const res = fakeRes();
    await handler(fakeReq({ path: "/" }), res);
    expect(res.statusCode).toBe(401);
  });
});

describe("路径校验没有被这次改动碰到", () => {
  // ⚠️ 必须用花括号：`delete` 是表达式、返回 boolean，而 vitest 钩子的签名是
  //    Awaitable<HookCleanupCallback>（返回值会被当成清理函数）⇒ 表达式体编译不过。
  //    运行时是好的（30/30 绿），只有 tsc 会红 —— 典型的"测试跑过不等于类型过"。
  beforeEach(() => {
    delete process.env.VAN_BLOG_REVALIDATE_SECRET;
  });

  it("非法路径仍然 400（.. // 协议 控制字符 超长 不以 / 开头）", async () => {
    const bad = [
      "/../etc/passwd",
      "//evil",
      "https://evil.example/",
      "/a\u0000b",
      "post/no-leading-slash",
      "/" + "a".repeat(501),
    ];
    for (const p of bad) {
      const res = fakeRes();
      await handler(fakeReq({ path: p }), res);
      expect([p, res.statusCode]).toEqual([p, 400]);
      expect(res.revalidated).toEqual([]);
    }
  });
});

describe("isLoopbackRevalidateRequest 的判据", () => {
  it("回环 + 无转发头才算；缺任一条件都不算", () => {
    expect(isLoopbackRevalidateRequest(fakeReq({}))).toBe(true);
    expect(isLoopbackRevalidateRequest(fakeReq({ remoteAddress: "10.0.0.5" }))).toBe(false);
    expect(
      isLoopbackRevalidateRequest(fakeReq({ headers: { "x-forwarded-for": "1.2.3.4" } })),
    ).toBe(false);
    // 私网地址**不等于**回环：容器网络里的其它服务也是私网，不能因此放行
    expect(isLoopbackRevalidateRequest(fakeReq({ remoteAddress: "172.17.0.1" }))).toBe(false);
  });
});

describe("源码级钉子", () => {
  const src = () =>
    fs.readFileSync(path.join(__dirname, "../pages/api/revalidate.ts"), "utf-8");

  it("旧的「没配密钥就完全不校验」形状不许回来", () => {
    // ⚠️ 这里不能用 stripCommentsForAnchor：那是 **server 包**的工具（TS 剥注释器），
    //    本包的 vitest 解析不到 `src/test-utils/...` 这个别名。改成手工去掉整行注释后再断言，
    //    理由与 server 侧相同：文件顶部的注释里就写着旧代码形状，不剥注释这条断言永远红。
    const noComments = src()
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(noComments).not.toMatch(/if \(secret &&/);
    expect(noComments).toMatch(/if \(secret\) \{/);
    expect(noComments).toMatch(/if \(!isLoopbackRevalidateRequest\(req\)\) \{/);
    expect(noComments).toMatch(/return res\.status\(403\)/);
    // 反证：旧形状确实能被上面那条"不存在"的正则命中（否则断言是空的）
    expect('if (secret && String(req.query?.secret ?? "") !== secret) {').toMatch(/if \(secret &&/);
  });

  it("跨包前提：server 调这个接口用的是写死的回环地址，且设了密钥就会带上", () => {
    // 这条钉的是"一体式镜像不受影响"的**依据**：如果哪天 server 改成走公网域名或
    // 不再带 secret，本文件的失败关闭语义就会把 ISR 打断 —— 那时必须一起改。
    const isr = fs.readFileSync(
      path.join(__dirname, "../../server/src/provider/isr/isr.provider.ts"),
      "utf-8",
    );
    expect(isr).toContain("http://127.0.0.1:3001/api/revalidate");
    expect(isr).toMatch(/const secret = process\.env\.VAN_BLOG_REVALIDATE_SECRET;/);
    expect(isr).toMatch(/params\.set\('secret', secret\)/);
  });
});
