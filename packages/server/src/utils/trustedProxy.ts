import { pickClientIp, pickSocketIp } from 'src/provider/log/utils';

/**
 * 限流该用哪个 IP：**转发头的信任规则**。
 *
 * 背景（这是一个真实可利用的绕过，不是理论问题）：`utils/rateLimit.ts` 以前用
 * `pickClientIp(req) || pickSocketIp(req)` 当四档限流桶的 key，而 `pickClientIp` 优先读
 * `cf-connecting-ip` / `true-client-ip` / `x-real-ip` / `x-forwarded-for` —— **全是客户端可控的**，
 * 而 caddy 只会往 `X-Forwarded-For` 里**追加**真实对端，**不会剥掉**客户端自带的
 * `cf-connecting-ip`。于是"每个请求换一个头"就能让全局限流形同虚设。
 * 实测（`VANBLOG_RATE_LIMIT_PER_MIN=5`，进程内伪造 req）：
 *   同一个套接字 IP、不带转发头            → 放行 5 / 拦下 15（限流生效）
 *   同一个套接字 IP、每次换 cf-connecting-ip → **放行 20 / 拦下 0**（完全绕过）
 *   同一个套接字 IP、每次换 x-forwarded-for  → **放行 20 / 拦下 0**
 *   回环对端（一体式部署里 caddy 就在 127.0.0.1）、每次换 XFF → **放行 20 / 拦下 0**
 *   `/static/**` 那个 10 倍桶同样 20 / 0
 * 顺带它还给了无限的 key churn（每个伪造 IP 一个桶），把 `utils/attemptLimit.ts` 顶爆 ——
 * 那张表以前满了就 `clear()`，等于攻击者能把**所有人**的限流计数清零（已单独修掉）。
 *
 * 但**不能**简单地改成"只认套接字地址"：反代后面所有访客会共用一个桶
 * （600/分钟 ÷ 全站访客），正是 §7.44 压测到、并专门给静态资源开 10 倍桶才缓解的那场 429 风暴。
 * 所以按"可信代理"来做：
 *
 * | `VANBLOG_TRUST_FORWARDED_HEADERS` | 行为 |
 * | --- | --- |
 * | **`auto`（默认）** | 只有当**套接字对端是回环/私网**时才采信转发头，而且只信**一跳**：取 `X-Forwarded-For` 的**最右**一项（可信代理追加的那个，也就是它亲眼看到的对端）。对端是公网地址 ⇒ 头一律忽略，用套接字地址。 |
 * | `always` | 旧行为：`pickClientIp()`（CDN 头优先）。给"CDN/隧道直连源站、对端就是公网代理 IP"的部署用。 |
 * | `never` | 只认套接字地址。⚠️ 反代后面等于全站共用一个桶，会 429 风暴。 |
 *
 * ⚠️ `auto` 为什么取**最右**而不是最左/第一个公网：caddy（以及 nginx 的默认配置）是把真实对端
 * **追加**到客户端自带的 XFF 后面，所以最右一项才是"可信代理看到的对端"，左边的都可能是伪造的。
 * 代价是"多层可信代理"（例如 CF → 自己的 caddy → server）时最右是上一层代理的地址，
 * 那种部署要么用 `always`，要么将来再加一个"可信跳数"的设置。
 *
 * ⚠️ `auto` **不看** `x-real-ip`：它没有"由代理追加"的语义，无法区分"代理写的"与"客户端写的"。
 * 只设 X-Real-IP 不设 XFF 的反代请用 `always`。同理也不看 `cf-connecting-ip`/`true-client-ip`
 * （CDN 专用头，只有 CDN 会覆写它，而 `auto` 的前提是"对端就是我的代理"）。
 *
 * ⚠️ **哪些调用点该用哪个**（这条最容易被下一个人改错）：
 *  - **体量类**限流（全局 / 静态 / 公开写 / 初始化，`utils/rateLimit.ts`）用 `pickTrustedClientIp()`：
 *    反代后面必须按真实客户端分桶，而轮换头的收益只是"攻击者自己拿到新的体量预算"（与旧行为相同）。
 *  - **防爆破/防刷类**计数（`LoginGuard.keyOf`、`comment.provider` 的三档、`public.controller`
 *    的文章解锁）**继续用 `pickSocketIp()`**，不要换：那几处攻击者的收益正是"换一个 key 重新开始"，
 *    而 `auto` 模式下对端是回环（一体式部署就是）⇒ 头会被采信 ⇒ 换过去就等于把
 *    "每次换一个 X-Real-IP 就能无限试密码，反过来还能用受害者的真实 IP 把对方锁在门外"
 *    这个洞重新打开（`login.guard.ts` 的注释原本就是这么写的）。
 *    套接字地址是唯一不可伪造的身份。
 *
 * ⚠️ 不要复用 `provider/log/utils.ts` 的 `isSkippedPrivateIp()` 做信任判断：它把 `10.x` 里
 * **只有 `10.7.*`** 当私网（上游遗留写法），还把 `172.32` 算进 `172.16/12`。
 * 用于"日志里的 IP 归属"无伤大雅，用于信任判定是错的。这里用真正的 CIDR 计算。
 */

export type ForwardedTrustMode = 'auto' | 'always' | 'never';

export const TRUST_FORWARDED_ENV = 'VANBLOG_TRUST_FORWARDED_HEADERS';

export function resolveForwardedTrustMode(raw: string | undefined = process.env[TRUST_FORWARDED_ENV]): ForwardedTrustMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'always' || value === 'never' || value === 'auto') {
    return value;
  }
  // 写错的值一律回落到默认（安全的那一侧：宁可少采信头，也不要静默放宽）
  return 'auto';
}

/** IPv4 的私网/回环网段（RFC1918 + 回环）。 */
const PRIVATE_V4_CIDRS: Array<[number, number]> = [
  // [网络地址, 前缀长度]
  [0x7f000000, 8], // 127.0.0.0/8   回环
  [0x0a000000, 8], // 10.0.0.0/8    RFC1918
  [0xac100000, 12], // 172.16.0.0/12 RFC1918（docker 默认 172.17/16、compose 网络 172.18–172.31 都在里面）
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918（Docker Desktop 的 192.168.65.x 也在里面）
];

/**
 * 故意**排除**的两段（写在这里，免得以后有人"顺手补上"）：
 *  - `169.254.0.0/16`（IPv4 链路本地）：云元数据地址 `169.254.169.254` 就在这段里，
 *    而且同一个 L2 的邻居并不比公网对端更可信；
 *  - `100.64.0.0/10`（CGNAT）：这是运营商级 NAT 的**公网侧共享**地址段，
 *    信它等于让一整片互不相识的用户互相顶替身份。
 * podman 的 `10.88.0.0/16` 已经在 `10/8` 里，docker/podman 都**不需要**额外网段。
 */

function parseV4(raw: string): number | null {
  const parts = raw.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** 去掉方括号、zone id、端口，以及 IPv4-mapped 前缀，返回可用于比较的小写字符串 */
function normalizeIp(raw: unknown): string {
  let ip = String(raw == null ? '' : raw).trim();
  if (!ip) {
    return '';
  }
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }
  const zone = ip.indexOf('%');
  if (zone !== -1) {
    ip = ip.slice(0, zone);
  }
  const portSuffix = ip.match(/^((?:\d{1,3}\.){3}\d{1,3}):\d+$/);
  if (portSuffix) {
    return portSuffix[1];
  }
  const mapped = ip.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
  if (mapped) {
    return mapped[1];
  }
  return ip.toLowerCase();
}

/** 是不是回环或私网地址（IPv4 走 CIDR 计算，IPv6 只判我们需要的那几类前缀） */
export function isPrivateOrLoopback(rawIp: unknown): boolean {
  const ip = normalizeIp(rawIp);
  if (!ip) {
    return false;
  }
  const v4 = parseV4(ip);
  if (v4 !== null) {
    for (const [network, bits] of PRIVATE_V4_CIDRS) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((v4 & mask) >>> 0) === ((network & mask) >>> 0)) {
        return true;
      }
    }
    return false;
  }
  if (!ip.includes(':')) {
    return false; // 既不是合法 IPv4 也不是 IPv6
  }
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    return true; // 回环
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) {
    return true; // fc00::/7 唯一本地地址（ULA）
  }
  if (/^fe[89ab]/.test(ip)) {
    return true; // fe80::/10 链路本地
  }
  return false;
}

/**
 * 取 `X-Forwarded-For` 的**最右**一个合法 IP：那才是"可信代理亲眼看到的对端"。
 * 左边的那些都可能是客户端自己塞进来的（caddy 是追加，不是覆盖）。
 */
export function rightMostForwardedFor(value: unknown): string | null {
  const joined = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const parts = joined.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const ip = normalizeIp(parts[i].trim());
    if (!ip) {
      continue;
    }
    if (parseV4(ip) !== null || ip.includes(':')) {
      return ip;
    }
  }
  return null;
}

/**
 * 体量类限流用的客户端 IP。
 *
 * 返回值永远是一个非空字符串（拿不到任何可用信息时是 `'unknown'`，与
 * `rateLimit.ts` 原来的兜底一致），所以调用方不需要再判空。
 */
export function pickTrustedClientIp(
  req: any,
  mode: ForwardedTrustMode = resolveForwardedTrustMode(),
): string {
  const socketIp = pickSocketIp(req);
  if (mode === 'never') {
    return socketIp || 'unknown';
  }
  if (mode === 'always') {
    // 旧行为：CDN 头优先（`pickClientIp` 会依次看 cf-connecting-ip / true-client-ip /
    // x-real-ip / x-forwarded-for / req.ip / 套接字地址）
    return pickClientIp(req) || socketIp || 'unknown';
  }
  // auto：只有对端是回环/私网（也就是"我的反代"）时才采信转发头，且只信一跳
  if (!isPrivateOrLoopback(socketIp)) {
    return socketIp || 'unknown';
  }
  const forwarded = rightMostForwardedFor(req?.headers?.['x-forwarded-for']);
  return forwarded || socketIp || 'unknown';
}
