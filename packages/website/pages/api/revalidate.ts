/**
 * 服务端触发增量渲染（ISR）的回调。
 *
 * 一体式镜像里 /api/* 会被 caddy 全部转给 Nest，这个路由不会暴露到公网；
 * 但**单独部署 website 镜像**时它是可达的，任何人都能打它把每个页面重渲染一遍
 * （CPU + 磁盘放大）。所以：
 * 1. 路径必须形如站内路径（不允许 `..`、`//`、协议、控制字符，长度受限）；
 * 2. 设了 `VAN_BLOG_REVALIDATE_SECRET` 就必须带上 `?secret=`（server 侧用同一个变量）。
 */
const MAX_PATH_LEN = 500;

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

export default async function handler(req: any, res: any) {
  const secret = process.env.VAN_BLOG_REVALIDATE_SECRET || "";
  if (secret && String(req.query?.secret ?? "") !== secret) {
    return res.status(401).json({ revalidated: false, reason: "secret 不正确" });
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
