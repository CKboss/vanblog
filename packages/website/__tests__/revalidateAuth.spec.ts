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

/**
 * ⚠️ 这是**理想形状**的替身：恒定带 `socket.remoteAddress`、恒定不带转发头。
 * 真实的 Next 运行时不是这样 —— `base-server.js:527-530` 会给每个请求补
 * `x-forwarded-for`/`-host`/`-port`/`-proto`。用本函数写的用例**量不到**那个形状，
 * 所以下面另有一组用例直接手写真实形状的 req，并有"替身忠实度"守卫防止它们被删掉。
 */
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

  /**
   * 🔴 这条是 **P0 回归的真实形状**，以前整个文件都没有它（见下面"替身忠实度"那组）。
   *
   * Next 的 base-server 会给**每个**请求补转发头（`base-server.js:527-530`，无条件、没有开关）：
   *     req.headers["x-forwarded-for"] ??= originalRequest.socket?.remoteAddress;
   * 所以一体式镜像里 server 直连 127.0.0.1:3001 时，handler 看到的 req 是
   * "套接字确实是回环，但 x-forwarded-for 也在（值就是 127.0.0.1）"。
   *
   * ⚠️ 结论是 **403 保持不变**（失败关闭），而不是把它改成放行。理由：
   * `??=` 只在缺失时补，所以"XFF 的值是回环"并不能证明"没有反代"—— 同机反代
   * （nginx 默认**不加** X-Forwarded-For）转发公网访客时，XFF 会被 Next 补成反代自己的
   * 回环地址，放宽就等于把 cc1c51eb 关掉的匿名重渲染放大器重新打开。
   * ⇒ 一体式镜像的正解是**密钥**（server 自动生成并下发给前台子进程），不是放宽 IP 判定。
   */
  it("🔴 Next 真实形状：套接字是回环、但 Next 自己补了 x-forwarded-for ⇒ 仍 403（失败关闭）", async () => {
    const res = fakeRes();
    await handler(
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "127.0.0.1:3001",
          connection: "keep-alive",
          // 这四个都是 Next 的 base-server 无条件补上的，客户端并没有发
          "x-forwarded-host": "127.0.0.1:3001",
          "x-forwarded-port": "80",
          "x-forwarded-proto": "http",
          "x-forwarded-for": "127.0.0.1",
        },
        query: { path: "/" },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.revalidated).toEqual([]);
  });

  it("🔴 同一个 Next 真实形状下，**带对密钥就放行** —— 这才是一体式镜像修复后走的路", async () => {
    process.env.VAN_BLOG_REVALIDATE_SECRET = "s3cr3t-value";
    const res = fakeRes();
    await handler(
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" },
        query: { path: "/post/hello", secret: "s3cr3t-value" },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.revalidated).toEqual(["/post/hello"]);
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

/**
 * 🔴 替身忠实度守卫（**行为级**，不是源码扫描）。
 *
 * 这个文件曾经有过一个静默盲区：`fakeReq()` 恒定注入 `socket.remoteAddress`、恒定不带转发头，
 * 于是"Next 运行时的真实形状"一条用例都量不到。结果是一体式镜像里 server 触发的
 * **每一次** revalidate 都 403、冷启动全量渲染全败、`post/*.html` 产物 0 个，而用例全绿。
 * 与本仓库那个"内存 model 对 `{}` 返回 null，于是有缺陷的代码也是绿的"同族 ——
 * **替身钉住的是假设，不是现实**。
 *
 * ⚠️ 这里的守卫**第一版是源码扫描**（断言 spec 文件里出现某个字符串），
 * 变异对照证明它**恒真**：把"现实形状"那条用例的 XFF 改成非回环值后它仍然绿，
 * 因为文件里**另一条**用例也含同一个字符串 ⇒ 文件级标记证明不了"某条用例存在"。
 * 现在改成行为级：钉住"理想形状与现实形状**结论必须不同**"。这样
 * ①有人删掉现实形状那条用例 ⇒ 这条还在，性质不丢；
 * ②有人把判据放宽成"XFF 是回环就放行"（那会把 cc1c51eb 关掉的匿名放大器重新打开）⇒ 这条立刻红。
 */
describe("替身忠实度：理想形状与 Next 真实形状的结论必须不同", () => {
  beforeEach(() => {
    delete process.env.VAN_BLOG_REVALIDATE_SECRET;
  });

  /** Next 的 base-server 会给每个请求补上这四个头（客户端并没有发）。 */
  const nextRealShape = (query: Record<string, string>) =>
    ({
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "127.0.0.1:3001",
        connection: "keep-alive",
        "x-forwarded-host": "127.0.0.1:3001",
        "x-forwarded-port": "80",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "127.0.0.1",
      },
      query,
    }) as any;

  it("🔴 fakeReq 的理想形状**放行**、Next 真实形状**拒绝** ⇒ 只用 fakeReq 必然漏掉这个回归", async () => {
    const ideal = fakeRes();
    await handler(fakeReq({ path: "/" }), ideal);
    const real = fakeRes();
    await handler(nextRealShape({ path: "/" }), real);
    expect(ideal.statusCode).toBe(200);
    expect(real.statusCode).toBe(403);
    // 这一条是本体：两种形状**结论不同**。若哪天有人放宽判据让真实形状也放行，
    // 这里会红 —— 而那正是"把匿名重渲染放大器重新打开"的形状。
    expect(ideal.statusCode).not.toBe(real.statusCode);
    expect(real.revalidated).toEqual([]);
  });

  it("完全取不到套接字（连 socket 都没有）也拒绝 ⇒ 不猜", async () => {
    const res = fakeRes();
    await handler({ headers: {}, query: { path: "/" } } as any, res);
    expect(res.statusCode).toBe(403);
    expect(res.revalidated).toEqual([]);
  });

  it("真实形状 + **带对密钥** ⇒ 放行（一体式镜像修复后走的就是这条）", async () => {
    process.env.VAN_BLOG_REVALIDATE_SECRET = "s3cr3t-value";
    const res = fakeRes();
    await handler(nextRealShape({ path: "/post/hello", secret: "s3cr3t-value" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.revalidated).toEqual(["/post/hello"]);
  });

  it("真实形状 + 密钥错 ⇒ 401，且**没有**触发重渲染", async () => {
    process.env.VAN_BLOG_REVALIDATE_SECRET = "s3cr3t-value";
    const res = fakeRes();
    await handler(nextRealShape({ path: "/", secret: "wrong" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.revalidated).toEqual([]);
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
    // 🔴 Next 真实形状：套接字是回环，但 Next 补了 x-forwarded-for ⇒ **不算**回环直连。
    //    这条就是"一体式镜像默认配置下每次 revalidate 都 403"的直接原因，必须钉住。
    expect(
      isLoopbackRevalidateRequest(
        fakeReq({ headers: { "x-forwarded-for": "127.0.0.1" } }),
      ),
    ).toBe(false);
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

  it("🔴 跨包前提：server 用**写死的回环地址**，且密钥来自与前台子进程共用的那一个来源", () => {
    // 这条钉的是"一体式镜像能跑通"的**依据**：本文件的失败关闭语义 + Next 自己补
    // x-forwarded-for ⇒ 回环豁免永远不成立，所以 server **必须**带上密钥。
    // ⚠️ 以前这里钉的是 `const secret = process.env.VAN_BLOG_REVALIDATE_SECRET;`，
    //    而那正是 P0 回归的形状：默认没人配这个变量 ⇒ 不带 secret ⇒ 每次 revalidate 都 403。
    //    现在升级成钉"共用来源"，并且**同时**钉住子进程确实收到了同一把密钥，
    //    这样"两侧不一致"这个失败模式在任一侧被改坏时都会红。
    const isr = fs.readFileSync(
      path.join(__dirname, "../../server/src/provider/isr/isr.provider.ts"),
      "utf-8",
    );
    expect(isr).toContain("http://127.0.0.1:3001/api/revalidate");
    expect(isr).toMatch(/const secret = ensureRevalidateSecret\(\);/);
    expect(isr).toMatch(/params\.set\('secret', secret\)/);
    // 不许退回"直接读 env"：那是回归的原形状
    expect(isr).not.toMatch(/const secret = process\.env\.VAN_BLOG_REVALIDATE_SECRET;/);

    const websiteProvider = fs.readFileSync(
      path.join(__dirname, "../../server/src/provider/website/website.provider.ts"),
      "utf-8",
    );
    // 子进程必须拿到同一个来源的密钥，否则前台按"没配密钥"失败关闭 ⇒ 全量渲染全败
    expect(websiteProvider).toMatch(/ensureRevalidateSecret\(/);
    expect(websiteProvider).toMatch(/\[REVALIDATE_SECRET_ENV\]: revalidateSecret/);

    const secretUtil = fs.readFileSync(
      path.join(__dirname, "../../server/src/utils/revalidateSecret.ts"),
      "utf-8",
    );
    // 两侧必须用**同一个环境变量名**，否则一边写一边读、永远对不上
    expect(secretUtil).toMatch(/REVALIDATE_SECRET_ENV = 'VAN_BLOG_REVALIDATE_SECRET'/);
    // 运维显式配置的必须优先，且不能被自动生成的值覆盖
    expect(secretUtil).toMatch(/process\.env\[REVALIDATE_SECRET_ENV\]/);
  });
});
