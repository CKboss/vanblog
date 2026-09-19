/**
 * 服务端触发增量渲染（ISR）的回调。
 *
 * 一体式镜像里 /api/* 会被 caddy 全部转给 Nest，这个路由不会暴露到公网；
 * 但**单独部署 website 镜像**时它是可达的，任何人都能打它把每个页面重渲染一遍
 * （CPU + 磁盘放大）。所以：
 * 1. 路径必须形如站内路径（不允许 `..`、`//`、协议、控制字符，长度受限）；
 * 2. 设了 `VAN_BLOG_REVALIDATE_SECRET` 就必须带上 `?secret=`（server 侧用同一个变量）；
 * 3. ⚠️ **没设密钥时不再等于"谁都能打"**：只放行真正的本机回环请求，其余一律 403。
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
 * 为什么这条对一体式镜像是安全的：server 调这个接口用的是
 * `http://127.0.0.1:3001/api/revalidate`（`provider/isr/isr.provider.ts` 的 buildRevalidateUrl
 * 里地址是**写死的**），axios 直连、不加任何转发头 ⇒ 判定为回环直连，照常放行。
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
    "[revalidate] 未设置 VAN_BLOG_REVALIDATE_SECRET：本接口现在只接受**本机回环直连**的请求" +
      "（一体式镜像里 server 就是这么调的，不受影响）。如果 website 是单独部署的、" +
      "需要让别的机器触发增量渲染，请给 server 与 website **两边**配同一个 " +
      "VAN_BLOG_REVALIDATE_SECRET（server 会把它作为 ?secret= 带上）。",
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
