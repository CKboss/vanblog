/**
 * 服务端触发增量渲染（ISR）的回调。
 *
 * 一体式镜像里 /api/* 会被 caddy 全部转给 Nest，这个路由不会暴露到公网；
 * 但**单独部署 website 镜像**时它是可达的，任何人都能打它把每个页面重渲染一遍
 * （CPU + 磁盘放大）。所以：
 * 1. 路径必须形如站内路径（不允许 `..`、`//`、协议、控制字符，长度受限）；
 * 2. 设了 `VAN_BLOG_REVALIDATE_SECRET` 就必须带上 `?secret=`（server 侧用同一个变量）；
 * 3. ⚠️ **没设密钥时不再等于"谁都能打"**：只放行真正的本机回环请求，其余一律 403。
 *
 * 🔴 关于第 3 条的一个**必须知道的事实**（2026-09-20 实测确认，之前写错了）：
 * 在 Next 里那条回环豁免**实际上永远不成立**，因为 Next 自己会给每个请求补转发头：
 *
 *     node_modules/next/dist/server/base-server.js:527-530（无条件执行，没有配置开关）
 *     req.headers["x-forwarded-for"] ??= originalRequest.socket?.remoteAddress;
 *
 * 实测（真 `NextServer` + 真编译产物 + 只发 host/connection 的回环请求）：handler 看到的
 * `req.socket.remoteAddress` 确实是 `127.0.0.1`，但 `req.headers` 里**已经有** Next 补的
 * `x-forwarded-for: 127.0.0.1` ⇒ `isLoopbackRevalidateRequest` 返回 false ⇒ **403**。
 * 所以"没配密钥"在实践中等于"这个接口对 server 也不可用"。
 *
 * ⚠️ 这**不是**要把判据放宽成"XFF 全是回环就放行"：`??=` 只在缺失时补，真实反代加的 XFF
 * 会被保留，但 **nginx 默认并不加 `X-Forwarded-For`**（要 `proxy_set_header` 显式配），
 * 那种同机反代部署下放宽就等于把 `cc1c51eb` 关掉的匿名放大器重新打开。
 * ⇒ 正确做法是**用密钥**：一体式镜像里 server 会自动生成一把并通过 env 下发给前台子进程
 * （`packages/server/src/utils/revalidateSecret.ts`），于是走的是上面第 2 条而不是第 3 条。
 * 第 3 条因此退化成"**分离部署且没配密钥**"时的失败关闭兜底 —— 这正是它该有的样子。
 */
const MAX_PATH_LEN = 500;

/** 回环地址的几种写法（IPv6 与 IPv4-mapped IPv6 都算） */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function isSafeRevalidatePath(raw: unknown): raw is string {
  const text = String(raw ?? "");
  if (!text || text.length > MAX_PATH_LEN) return false;
  if (!text.startsWith("/")) return false;
  if (text.includes("..")) return false;
  if (text.includes("//")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(text)) return false;
  return true;
}

/**
 * 这个请求是不是**真的**从本机回环直连过来的。
 *
 * ⚠️ 判据与 server 侧 `utils/rateLimit.ts` 的 `isLoopbackRequest` 保持一致：
 * 套接字地址是回环，**并且**没有 `x-forwarded-for` / `x-real-ip`。
 * 只看套接字地址是不够的 —— website 单独部署时前面通常挂着一层反代
 * （nginx / caddy / 云 LB），而反代与 website 在同一台机器上 ⇒ 套接字地址也是回环，
 * 但它转发的是**公网访客**的请求。反代一定会加转发头，所以"有转发头"就不算回环直连。
 *
 * 🔴 **本函数的回环豁免在 Next 下无法被满足**（见文件头注释）：Next 的 base-server 会给
 * 每个请求补 `x-forwarded-for`，所以"没有转发头"这个条件恒不成立。保留本函数是有意为之 ——
 * 它是"没配密钥"时的**失败关闭**兜底：宁可拒绝，也不要退回到 `cc1c51eb` 之前那个
 * "没配密钥就等于谁都能打"的匿名放大器。一体式镜像靠 server 自动下发的密钥走上一条分支。
 */
export function isLoopbackRevalidateRequest(req: any): boolean {
  const socketIp = String(
    req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "",
  ).trim();
  if (!LOOPBACK.has(socketIp)) return false;
  const headers = req?.headers || {};
  return !headers["x-forwarded-for"] && !headers["x-real-ip"];
}

// ⚠️ 没配密钥时打一次醒目提示（每进程一次）：这个变量在 compose 模板、entrypoint.sh、
//    scripts/start.js 里都**没有默认值**，所以"没配"是默认状态而不是异常情况 ——
//    静默地按"回环才放行"运行是可以的，但分离部署的人需要知道自己该配什么。
let warnedMissingSecret = false;
function warnMissingSecretOnce() {
  if (warnedMissingSecret) return;
  warnedMissingSecret = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[revalidate] 未设置 VAN_BLOG_REVALIDATE_SECRET：本接口只接受**本机回环直连**的请求，" +
      "而 Next 会给每个请求自动补 x-forwarded-for（base-server.js:530），" +
      "所以这条豁免在实践中**不会成立** —— 也就是说到本条为止的请求都会被拒（403）。" +
      "一体式镜像里 server 会自动生成一把密钥并通过环境变量下发给前台子进程，" +
      "看到本条通常意味着：前台子进程不是由 server 拉起的（分离部署），" +
      "或 server 没能生成密钥（例如 /tmp 不可写）。分离部署请给 server 与 website " +
      "**两边**配同一个 VAN_BLOG_REVALIDATE_SECRET（server 会把它作为 ?secret= 带上）。",
  );
}

export default async function handler(req: any, res: any) {
  const secret = process.env.VAN_BLOG_REVALIDATE_SECRET || "";
  if (secret) {
    // 配了密钥就一律要求它（不管来源）：server 侧在设了这个变量时会自动带上
    if (String(req.query?.secret ?? "") !== secret) {
      return res.status(401).json({ revalidated: false, reason: "secret 不正确" });
    }
  } else {
    // ⚠️ 没配密钥 ⇒ **失败关闭**：只有真回环直连才放行。
    // 以前是 `if (secret && …)`，也就是"没配就完全不校验" —— 分离部署时这是一个
    // 匿名的"任意路径重渲染"放大器（CPU + 磁盘），而且在容器网络里可达，
    // 可以与 SSRF 串联使用。
    warnMissingSecretOnce();
    if (!isLoopbackRevalidateRequest(req)) {
      return res.status(403).json({
        revalidated: false,
        reason:
          "未设置 VAN_BLOG_REVALIDATE_SECRET，且请求不是本机回环直连：" +
          "请给 server 与 website 两边配同一个 VAN_BLOG_REVALIDATE_SECRET，" +
          "或只从本机调用这个接口",
      });
    }
  }

  const path = req.query?.path;
  if (!isSafeRevalidatePath(path)) {
    return res.status(400).json({ revalidated: false, reason: "path 不合法" });
  }
  try {
    await res.revalidate(path);
    return res.json({ revalidated: true });
  } catch (err) {
    // If there was an error, Next.js will continue
    // to show the last successfully generated page
    console.log(err);
    return res.status(500).json({ revalidated: false, reason: "触发增量渲染失败" });
  }
}
