import * as net from 'net';
import * as os from 'os';
import axios from 'axios';

// import publicIp from 'public-ip';

export const getLocalIps = () => {
  const res = [];
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4') {
        res.push(alias.address);
      }
    }
  }
  return res;
};
export const getPublicIp = async () => {
  try {
    // return await publicIpv4();
    const res = await axios.get('http://ip.cip.cc');
    if (res.data && res.data.trim() != '') {
      return res.data.replace('\n', '');
    } else {
      return null;
    }
  } catch (err) {
    console.log('获取公网 IP 超时');
    return null;
  }
};
export const getDefaultSubjects = async () => {
  const localIps = await getLocalIps();
  const publicIP = await getPublicIp();
  const result = localIps;
  if (!localIps.includes(publicIP) && Boolean(publicIP)) {
    result.push(publicIP);
  }
  if (!result.includes('127.0.0.1')) {
    result.push('127.0.0.1');
  }
  result.push('localhost');
  return result;
};
export const isIpv4 = (ip: string) => {
  const v4 =
    '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}';
  const reg = new RegExp(`^${v4}$`);
  return reg.test(ip);
};

// ---------------------------------------------------------------------------
// 后台登录的**网段白名单**（`VANBLOG_ADMIN_LOGIN_ALLOW_CIDR`）
//
// ## 为什么用 `net.BlockList` 而不是自己写 CIDR 比较
//
// 自己实现要处理：IPv6 的 `::` 压缩、末尾内嵌 IPv4（`::ffff:1.2.3.4`）、zone id（`fe80::1%eth0`）、
// 128 位掩码（JS 的位运算是 32 位的，得上 BigInt）。`markdownExport.ts` 里已经为 SSRF 判定写过一份
// `expandIpv6`/`ipv4ToNumber`，但那是**私有**函数，再抄一份就是第二处会漂移的实现。
// `net.BlockList` 是 Node 内置的（≥15.13），实测在本项目的 Node 24 上：
//   - `check(addr, family)` **必须显式传 family**（默认是 `'ipv4'`，传 IPv6 地址会恒为 false）；
//   - IPv4-mapped 形式能命中 IPv4 规则：加了 `203.0.113.0/24` 后
//     `check('::ffff:203.0.113.9', 'ipv6') === true`、`check('::ffff:203.0.114.9', 'ipv6') === false`；
//   - 非法网段/越界前缀会抛 `ERR_INVALID_ADDRESS` / `ERR_OUT_OF_RANGE`（下面兜住了）。
// 这三条都有测试钉住 —— 它们都是"猜错就会静默放行/静默全拒"的形状。
// ---------------------------------------------------------------------------

/**
 * 「只允许这些网段登录后台」。**默认空 = 不限制**（与本轮之前的行为完全一致）。
 *
 * 值形如 `203.0.113.0/24,198.51.100.7/32,2001:db8::/32`：逗号分隔，裸 IP 等价 `/32`（或 `/128`）。
 */
export const ADMIN_LOGIN_ALLOW_CIDR_ENV = 'VANBLOG_ADMIN_LOGIN_ALLOW_CIDR';

/** 最多接受多少条网段：防止有人把一整篇文本塞进来变成每次解析的 CPU 成本。 */
const MAX_CIDR_ENTRIES = 64;

export type CidrPolicy =
  /** 没配（空/全空白）⇒ 不限制，行为与本轮之前一致 */
  | { kind: 'disabled' }
  /** 配了且全部合法 ⇒ 只有落在这些网段里的 IP 能登录 */
  | { kind: 'allow'; list: net.BlockList; ranges: string[] }
  /**
   * 配了但有非法项 ⇒ **失败关闭**（谁都进不去）。
   *
   * 为什么选失败关闭而不是"忽略非法项、按剩下的放行"：忽略会让站长以为白名单生效了，
   * 而实际可能一条都没生效（例如把 `203.0.113.0/24` 写成 `203.0.113.0/255.255.255.0`
   * ⇒ 整条被丢弃 ⇒ 网段里的人被拒、而"忽略非法项"这个语义又可能让别的项放行）。
   * 失败关闭的后果是**站长立刻发现自己进不去**，这是可以当场修好的故障；
   * 静默放宽的后果是"以为锁好了其实没锁"，那是发现不了的故障。
   */
  | { kind: 'invalid'; ranges: string[]; invalid: string[] };

/** 判定一个地址属于哪个 family；不是合法 IP 字面量就返回 null（不猜）。 */
function familyOf(ip: string): 'ipv4' | 'ipv6' | null {
  if (net.isIPv4(ip)) {
    return 'ipv4';
  }
  return net.isIPv6(ip) ? 'ipv6' : null;
}

/**
 * 纯函数：把环境变量的值解析成一条策略。
 *
 * ⚠️ 三种输入要分清（方向都是"别静默关掉防护"）：
 *  - `undefined` / 空串 / 全空白 ⇒ `disabled`（**没配**不等于**配错**）；
 *  - 全部合法 ⇒ `allow`；
 *  - 有任一非法 ⇒ `invalid`（失败关闭），`invalid` 里带上具体是哪几项，供调用方打 ERROR。
 */
export function parseCidrPolicy(raw: unknown): CidrPolicy {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { kind: 'disabled' };
  }
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    // 容忍尾随逗号与 `a,,b` 这种形状：空项不是"非法配置"，只是没写东西
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { kind: 'disabled' };
  }
  const ranges: string[] = [];
  const invalid: string[] = [];
  const list = new net.BlockList();
  for (const entry of entries.slice(0, MAX_CIDR_ENTRIES)) {
    const slash = entry.indexOf('/');
    const base = (slash === -1 ? entry : entry.slice(0, slash)).trim();
    const family = familyOf(base);
    if (!family) {
      invalid.push(entry);
      continue;
    }
    try {
      if (slash === -1) {
        list.addAddress(base, family);
        ranges.push(family === 'ipv4' ? `${base}/32` : `${base}/128`);
        continue;
      }
      const prefixText = entry.slice(slash + 1).trim();
      // ⚠️ 只认纯数字前缀：`/24 ` 已经在上面 trim 过，`/0x18`、`/24/8`、`/-1` 一律非法
      if (!/^\d{1,3}$/.test(prefixText)) {
        invalid.push(entry);
        continue;
      }
      const prefix = Number(prefixText);
      const maxPrefix = family === 'ipv4' ? 32 : 128;
      if (prefix > maxPrefix) {
        invalid.push(entry);
        continue;
      }
      list.addSubnet(base, prefix, family);
      ranges.push(`${base}/${prefix}`);
    } catch {
      // 自己的校验没拦住、但 Node 认为非法（例如 addSubnet 对某些形状抛 ERR_INVALID_ADDRESS）
      invalid.push(entry);
    }
  }
  if (entries.length > MAX_CIDR_ENTRIES) {
    // 超出的部分直接算非法：静默截断会让"我配了 100 条"变成"只有前 64 条生效"
    invalid.push(...entries.slice(MAX_CIDR_ENTRIES));
  }
  if (invalid.length > 0) {
    return { kind: 'invalid', ranges, invalid };
  }
  return { kind: 'allow', list, ranges };
}

/**
 * 这个 IP 允不允许登录。
 *
 * ⚠️ **拿不到/看不懂 IP 一律拒绝**（失败关闭）：`bruteForceClientIp()` 在什么都读不到时返回
 * `'unknown'`，那不是地址，不能因为"比不出来"就放行。白名单的语义是"只有证明来自这些网段
 * 的请求才放行"，证明不了就是不放行。
 */
export function isIpAllowedByPolicy(policy: CidrPolicy, ip: unknown): boolean {
  if (policy.kind === 'disabled') {
    return true;
  }
  if (policy.kind === 'invalid') {
    return false;
  }
  const text = String(ip ?? '').trim();
  if (!text) {
    return false;
  }
  const family = familyOf(text);
  if (!family) {
    return false;
  }
  return policy.list.check(text, family);
}

/**
 * 单槽记忆化：只缓存"上一次的原始值 + 解析结果"，值变了就整槽替换。
 *
 * ⚠️ 为什么不做成 Map：那是**无界**的（虽然环境变量不会变，但"不会变"是假设不是保证），
 * 而单槽天然有界。解析本身很便宜，记忆化只是为了让"每次登录都重建一个 BlockList"
 * 这件事在爆破场景下不产生 GC 压力 —— 网段判定跑在限流**之前**，所以它是匿名可达的。
 */
let cidrPolicyCache: { raw: string; policy: CidrPolicy } | null = null;

/** 读环境变量并解析（带单槽记忆化）。传 `env` 只是为了测试可注入。 */
export function resolveAdminLoginCidrPolicy(env: NodeJS.ProcessEnv = process.env): CidrPolicy {
  const raw = String(env[ADMIN_LOGIN_ALLOW_CIDR_ENV] ?? '');
  if (cidrPolicyCache && cidrPolicyCache.raw === raw) {
    return cidrPolicyCache.policy;
  }
  const policy = parseCidrPolicy(raw);
  cidrPolicyCache = { raw, policy };
  return policy;
}

/** 仅供测试：清掉单槽缓存（生产代码不要调）。 */
export function resetCidrPolicyCacheForTest(): void {
  cidrPolicyCache = null;
}
