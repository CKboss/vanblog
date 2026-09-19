import { BadRequestException } from '@nestjs/common';
import * as dns from 'dns';
import * as net from 'net';
import { URL } from 'url';

/**
 * 文章导出成 Markdown 的公共逻辑（纯函数，方便单测）：
 * 图片引用识别、链接改写、front matter 生成、文件名安全化、远程目标安全校验。
 *
 * 约定：`.mdz` = 一个 zip 包，里面是 `<标题>.md`（图片链接已改成相对路径）+
 * `<标题>.assets/` 图片目录（Typora 风格）。另附一个**原样**的 `<标题>.md`（链接不改）。
 */

export const ASSETS_SUFFIX = '.assets';
export const MDZ_SUFFIX = '.mdz';

export interface ImageRef {
  /** 原文里的 url 文本 */
  url: string;
  /** url 在全文中的字符偏移（用于精确改写，不会误伤代码块里的同样文本） */
  start: number;
  end: number;
  syntax: 'md' | 'html' | 'reference';
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** 把代码块与行内代码「涂黑」成等长占位符，偏移量保持不变。 */
/** `decodeURIComponent` 遇到 `%zb` 这种坏转义会抛 URIError，一次就让整个导出 500。 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function maskCodeRegions(source: string): string {
  const NUL = '\u0000';
  // 快速路径：正文里既没有反引号也没有波浪线时，围栏（```/~~~）开不起来、
  // 行内代码也不存在，逐行处理的结果必然与原文逐字节相同。
  // 两次原生 indexOf（memchr 级）就能换掉 split + 逐行扫描 + join 的三份全量拷贝 ——
  // 这个函数在**每次公开列表请求的每篇文章**上都会跑一遍（取首图要先涂黑代码区），
  // 实测 493KB 的合成正文 44ms，而纯文字正文走快速路径只要 ~0.1ms。
  if (source.indexOf('`') === -1 && source.indexOf('~') === -1) {
    return source;
  }
  const lines = source.split('\n');
  let fence = '';
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (!fence) {
        fence = marker;
        out.push(NUL.repeat(line.length));
        continue;
      }
      if (marker === fence) {
        fence = '';
        out.push(NUL.repeat(line.length));
        continue;
      }
    }
    if (fence) {
      out.push(NUL.repeat(line.length));
      continue;
    }
    out.push(maskInlineCode(line));
  }
  return out.join('\n');
}

/**
 * 把一行里的行内代码涂黑成等长的 NUL。
 *
 * ⚠️ 实现必须是「跳到下一个反引号 + 整段 slice」，不能是「一个字符一个字符
 * `result += ch`」：后者对每个字符都要做一次字符串拼接（V8 的 cons-string
 * 也要建对象），一篇 500KB 的正文就是 50 万次拼接。改成 indexOf + slice 之后
 * 代价只与**反引号的个数**成正比，输出逐字节相同：
 *  - 反引号串之间的原文原样拷贝；
 *  - 找到等长闭合串 ⇒ 整段替换成同长度的 NUL；
 *  - 找不到 ⇒ 原样保留这串反引号（与改动前一致）。
 */
function maskInlineCode(line: string): string {
  const NUL = '\u0000';
  let result = '';
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf('`', i);
    if (open === -1) {
      break;
    }
    result += line.slice(i, open);
    let run = 1;
    while (line[open + run] === '`') {
      run += 1;
    }
    const closer = run === 1 ? line.indexOf('`', open + 1) : line.indexOf('`'.repeat(run), open + run);
    if (closer >= 0) {
      result += NUL.repeat(closer + run - open);
      i = closer + run;
    } else {
      result += line.slice(open, open + run);
      i = open + run;
    }
  }
  return i === 0 ? line : result + line.slice(i);
}

function isMasked(masked: string, start: number, end: number): boolean {
  return masked.slice(start, end).includes('\u0000');
}

/**
 * 找出正文里所有图片引用（`![]()`、`<img src>`、`![][ref]` + 定义行）。
 * 代码块 / 行内代码里的「长得像图片」的文本会被跳过。
 */
export function extractImageRefs(source: string): ImageRef[] {
  if (!source) {
    return [];
  }
  const masked = maskCodeRegions(source);
  const refs: ImageRef[] = [];

  // 1) 引用式定义 [label]: url —— 改写时改定义行，用到处不用动
  const definitions = new Map<string, { url: string; start: number; end: number }>();
  const defRe = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/gm;
  let defMatch: RegExpExecArray | null;
  while ((defMatch = defRe.exec(masked))) {
    if (isMasked(masked, defMatch.index, defMatch.index + defMatch[0].length)) {
      continue;
    }
    const label = defMatch[1].trim().toLowerCase();
    const raw = defMatch[2].replace(/^<|>$/g, '');
    if (!raw) {
      continue;
    }
    // 定义行里 url 的偏移：整段匹配尾部就是 url
    const end = defMatch.index + defMatch[0].length;
    const start = end - defMatch[2].length + (defMatch[2].startsWith('<') ? 1 : 0);
    if (!definitions.has(label)) {
      definitions.set(label, { url: raw, start, end: start + raw.length });
    }
  }

  // 2) ![](...)
  const mdRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    const inner = m[2];
    const lead = inner.length - inner.trimStart().length;
    const trimmed = inner.trimStart();
    let urlText = '';
    let urlOffsetInInner = lead;
    if (trimmed.startsWith('<')) {
      const close = trimmed.indexOf('>');
      if (close < 0) {
        continue;
      }
      urlText = trimmed.slice(1, close);
      urlOffsetInInner = lead + 1;
    } else {
      const spaceIdx = trimmed.search(/\s/);
      urlText = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    }
    if (!urlText) {
      continue;
    }
    // m[0] = "![alt](" + inner + ")"，所以 inner 的起点是倒数第二段
    const innerStart = m.index + m[0].length - inner.length - 1;
    refs.push({
      url: urlText,
      start: innerStart + urlOffsetInInner,
      end: innerStart + urlOffsetInInner + urlText.length,
      syntax: 'md',
    });
  }

  // 3) <img src="...">
  const htmlRe = /<img\b[^>]*>/gi;
  while ((m = htmlRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    // `\bsrc` 会匹配到 `data-src`（`-` 之后仍是词边界），于是懒加载占位图被当成真图，
    // 真正的 src 反而留在原样（导出的 mdz 离线打开就是坏图）
    const srcRe = /(?<![-\w])src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const sm = srcRe.exec(m[0]);
    if (!sm) {
      continue;
    }
    const value = sm[2] ?? sm[3] ?? sm[4] ?? '';
    if (!value) {
      continue;
    }
    // 值的起点 = 跳过 `src`、空白、`=`、空白和可能的引号。
    // 不能用「匹配长度 - 值长度」倒推：带引号时尾部还有一个引号，会整体偏移一位
    // （实测会把 `src="/static/x.webp"` 改成 `src="/assets/x.webp width=...`，吃掉闭引号）。
    const prefix = /^\s*src\s*=\s*["']?/i.exec(sm[0]);
    const valueOffset = sm.index + (prefix ? prefix[0].length : sm[0].length - value.length);
    refs.push({
      url: value,
      start: m.index + valueOffset,
      end: m.index + valueOffset + value.length,
      syntax: 'html',
    });
  }

  // 4) ![alt][label] —— 指向定义行里的 url
  const refUseRe = /!\[[^\]]*\]\[([^\]]*)\]/g;
  while ((m = refUseRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    const label = (m[1] || '').trim().toLowerCase();
    const def = definitions.get(label);
    if (!def) {
      continue;
    }
    if (!refs.some((r) => r.start === def.start && r.end === def.end)) {
      refs.push({ ...def, syntax: 'reference' });
    }
  }

  return refs.sort((a, b) => a.start - b.start);
}

/** 按偏移精确改写图片链接（同一 url 出现多次会全部改写）。 */
export function rewriteImageUrls(source: string, mapping: Map<string, string>): string {
  const refs = extractImageRefs(source).filter((ref) => mapping.has(ref.url));
  if (!refs.length) {
    return source;
  }
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start < cursor) {
      continue;
    }
    out += source.slice(cursor, ref.start) + mapping.get(ref.url);
    cursor = ref.end;
  }
  return out + source.slice(cursor);
}

export type ImageKind = 'local' | 'remote' | 'skip';

export interface ClassifiedImage {
  kind: ImageKind;
  /** kind=local 时，相对静态目录的路径，例如 `img/abc.webp` */
  staticRel?: string;
  /** kind=remote 时，规范化后的绝对地址 */
  absolute?: string;
  reason?: string;
}

/**
 * 判断一个图片地址是「本站静态目录里的文件」还是「外链」。
 * 只有 `/static/...`（含带自己域名的绝对形式）才算本地，其余一律不外推。
 */
export function classifyImageUrl(rawUrl: string, baseUrl?: string): ClassifiedImage {
  const url = String(rawUrl || '').trim();
  if (!url) {
    return { kind: 'skip', reason: '空链接' };
  }
  if (/^data:/i.test(url)) {
    return { kind: 'skip', reason: 'data URI，已内嵌在正文里' };
  }
  if (url.startsWith('/static/')) {
    return { kind: 'local', staticRel: safeDecodeURIComponent(url.slice('/static/'.length)) };
  }
  if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
    const absolute = url.startsWith('//') ? `https:${url}` : url;
    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      return { kind: 'skip', reason: '链接解析失败' };
    }
    const sameSite = baseUrl ? sameOrigin(parsed, baseUrl) : false;
    if (parsed.pathname.startsWith('/static/') && sameSite) {
      return { kind: 'local', staticRel: safeDecodeURIComponent(parsed.pathname.slice('/static/'.length)) };
    }
    return { kind: 'remote', absolute: parsed.toString() };
  }
  return { kind: 'skip', reason: '相对路径无法定位到具体文件' };
}

function sameOrigin(parsed: URL, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    return parsed.origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * 非 IP 的主机名里，这些后缀一律当内网。
 * ⚠️ 只列这三个（与历史行为一致）：其它内部域名（`.corp` 之类）靠后面的
 * **DNS 解析结果**判定兜住 —— 解析到私网 IP 就拒，所以不需要穷举后缀。
 */
const PRIVATE_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i];

/** 点分十进制 → 32 位无符号数；不是合法 IPv4 就返回 null（不猜、不部分解析）。 */
function ipv4ToNumber(ip: string): number | null {
  const parts = String(ip).split('.');
  if (parts.length !== 4) {
    return null;
  }
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) {
      return null;
    }
    const v = Number(p);
    if (v > 255) {
      return null;
    }
    n = n * 256 + v;
  }
  return n >>> 0;
}

/**
 * 按**数值**判 IPv4 是否属于不可路由/内部范围。
 *
 * 为什么按数值而不是按字符串前缀：旧实现是 `^127\.`、`^10\.` 这种正则，
 * 于是 `http://2130706433/`（十进制）与 `http://0177.0.0.1/`（八进制）能过检 ——
 * 不过那两种现在其实被 WHATWG URL 规范化挡住了（`new URL('http://2130706433/').hostname`
 * 就是 `127.0.0.1`），真正漏掉的是 IPv6 的各种内嵌形式，见 `isPrivateIpv6`。
 */
function isPrivateIpv4Number(n: number): boolean {
  const inRange = (prefix: number, bits: number) => n >>> (32 - bits) === prefix >>> (32 - bits);
  return (
    inRange(0x00000000, 8) || // 0.0.0.0/8     本网络（含 0.0.0.0 这个"未指定"）
    inRange(0x0a000000, 8) || // 10.0.0.0/8    私网
    inRange(0x64400000, 10) || // 100.64.0.0/10 CGNAT —— 云上内网极常见（旧实现漏了）
    inRange(0x7f000000, 8) || // 127.0.0.0/8   回环
    inRange(0xa9fe0000, 16) || // 169.254.0.0/16 链路本地（含云 IMDS 169.254.169.254）
    inRange(0xac100000, 12) || // 172.16.0.0/12 私网
    inRange(0xc0000200, 24) || // 192.0.2.0/24  TEST-NET-1（文档用，不可路由）
    inRange(0xc0a80000, 16) || // 192.168.0.0/16 私网
    inRange(0xc6120000, 15) || // 198.18.0.0/15 基准测试
    inRange(0xc6336400, 24) || // 198.51.100.0/24 TEST-NET-2
    inRange(0xcb007100, 24) || // 203.0.113.0/24 TEST-NET-3
    inRange(0xe0000000, 4) || // 224.0.0.0/4   组播
    n >= 0xf0000000 // 240.0.0.0/4 保留（含 255.255.255.255 广播）
  );
}

/**
 * 把 IPv6 字面量展开成 8 个 16 位组；解析不了返回 null。
 * 处理三件事：`::` 压缩、末尾内嵌的点分十进制（`::ffff:127.0.0.1`）、zone id（`fe80::1%eth0`）。
 *
 * ⚠️ 不能用字符串正则判 IPv6：WHATWG URL 会把它**规范化**，
 * `http://[::ffff:127.0.0.1]/` 的 hostname 实测是 `::ffff:7f00:1`（内嵌 IPv4 变成十六进制），
 * 所以任何 `^::ffff:\d+\.` 形状的规则都永远匹配不上 —— 这正是旧实现漏掉的那一类。
 */
function expandIpv6(addr: string): number[] | null {
  let s = String(addr).trim().replace(/^\[|\]$/g, '');
  if (!s) {
    return null;
  }
  const zone = s.indexOf('%');
  if (zone >= 0) {
    s = s.slice(0, zone);
  }
  // 末尾内嵌 IPv4 ⇒ 换成两个十六进制组，后面按纯 IPv6 处理
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const n = ipv4ToNumber(s.slice(lastColon + 1));
    if (n === null) {
      return null;
    }
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parseGroups = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
        return null;
      }
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const halves = s.split('::');
  if (halves.length > 2) {
    return null;
  }
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (!head || !tail) {
      return null;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    return [...head, ...new Array(missing).fill(0), ...tail];
  }
  const full = parseGroups(s);
  return full && full.length === 8 ? full : null;
}

/**
 * IPv6 是否属于内部/不可路由范围，**含所有内嵌 IPv4 的过渡形式**。
 *
 * 旧实现只有 `^::1$` / `^f[cd][0-9a-f]{2}:` / `^fe80:` 三条正则，实测这四条能过检并真的打通：
 *   `http://[::ffff:127.0.0.1]:2019/`        → 规范化成 `::ffff:7f00:1`（IPv4-mapped，打到回环）
 *   `http://[::ffff:169.254.169.254]/`       → `::ffff:a9fe:a9fe`（云 IMDS）
 *   `http://[64:ff9b::7f00:1]:2019/`         → NAT64 前缀，翻译到内网 IPv4
 *   `http://[::]:2019/`                      → 未指定地址
 * 连通性是实测过的：本机起一个只 bind 127.0.0.1 的 TCP 靶子，
 * `net.connect(port, '::ffff:127.0.0.1')` 能连上并拿到响应。
 */
function isPrivateIpv6(addr: string): boolean {
  const g = expandIpv6(addr);
  // 解析不出来的 IPv6 字面量按"不安全"处理：宁可拒绝，也不要把没看懂的地址当公网放行
  if (!g) {
    return true;
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((x) => x === 0)) {
    return true; // ::            未指定地址
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // ::1           回环
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7    唯一本地地址（ULA）
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10   链路本地
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8    组播
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 文档地址
  if (g0 === 0x2001 && g1 === 0x0000) return true; // 2001::/32 Teredo：能封装任意 IPv4（含私网）
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // 64:ff9b::/96 与 64:ff9b:1::/48 NAT64
  // 内嵌 IPv4 的三种过渡形式：把里面的 IPv4 拆出来，用**同一套** IPv4 规则判
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff; // ::ffff:0:0/96
  const compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0; // ::/96
  if (mapped || compatible) {
    return isPrivateIpv4Number((((g6 << 16) >>> 0) + g7) >>> 0);
  }
  if (g0 === 0x2002) {
    // 6to4 2002::/16：IPv4 藏在第 2、3 组里（2002:7f00:1:: == 127.0.0.1）
    return isPrivateIpv4Number((((g1 << 16) >>> 0) + g2) >>> 0);
  }
  return false;
}

/**
 * 目标地址是不是内网/回环/不可路由。
 *
 * 判据是**解析后的结构**，不是字符串形状：IPv4 按数值比范围，IPv6 展开成 8 组后
 * 逐个前缀比，内嵌 IPv4 的过渡形式（mapped / compatible / 6to4 / NAT64）先把里面的
 * IPv4 拆出来再判。非 IP 的主机名只看 `localhost` / `.local` / `.internal`，
 * 其余交给 `assertSafeRemoteUrl` 的 DNS 解析结果判定。
 */
export function isPrivateAddress(host: string): boolean {
  const raw = String(host ?? '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!raw) {
    return true; // 空主机名按不安全处理
  }
  if (net.isIPv4(raw)) {
    const n = ipv4ToNumber(raw);
    return n === null ? true : isPrivateIpv4Number(n);
  }
  if (net.isIPv6(raw)) {
    return isPrivateIpv6(raw);
  }
  // ⚠️ 含冒号却不是合法 IPv6 ⇒ 一律当内网拒绝。冒号在主机名里不合法，所以这种字符串
  //    只可能是"写坏的 IPv6 字面量"（`gggg::1`、`::ffff:127.0.0.1:80` 之类）。
  //    它随后也会因为 DNS 解析失败被拒，但**不该靠那个兜底**：判定函数自己就必须
  //    对"没看懂的输入"说不安全，否则换个调用方（不走 DNS 的那条）就漏了。
  if (raw.includes(':')) {
    return true;
  }
  return PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(raw));
}

/** 抓取外链时允许的端口。默认只有 80/443，可用环境变量放行其它端口。 */
const DEFAULT_ALLOWED_REMOTE_PORTS = [80, 443];

/**
 * 读 `VANBLOG_REMOTE_FETCH_ALLOWED_PORTS`（逗号分隔）。
 *
 * ⚠️ 语义按本仓库对"环境变量里的数字"的一贯要求（见 `utils/envNumber.ts`）：
 * 没设 / 空串 / **一个合法项都没有** ⇒ 回落默认的 80,443，绝不因为写错而变成"全部放行"。
 * 单个非法项（`80x`、`0`、`99999`、空项）被忽略，其余合法项照常生效。
 */
export function allowedRemoteFetchPorts(): number[] {
  const raw = String(process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS ?? '').trim();
  if (!raw) {
    return [...DEFAULT_ALLOWED_REMOTE_PORTS];
  }
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!/^\d{1,5}$/.test(t)) {
      continue;
    }
    const n = Number(t);
    if (n >= 1 && n <= 65535) {
      out.push(n);
    }
  }
  return out.length ? Array.from(new Set(out)).sort((a, b) => a - b) : [...DEFAULT_ALLOWED_REMOTE_PORTS];
}

export interface SafeRemoteUrl {
  url: URL;
  /** DNS 校验时解析出来的地址（调用方要用**同一个** IP 去连，见 utils/safeFetch.ts 的 IP pinning） */
  addresses: string[];
}

/**
 * 外链抓取前的安全检查：只允许 http/https、只允许白名单端口、目标不能是内网/回环地址
 * （否则协作者可以借导出/外链转存功能探测内网 —— 典型 SSRF）。
 *
 * 返回**校验时解析出来的地址**，让调用方拿同一个 IP 去连（否则校验与连接是两次独立解析，
 * 中间有 DNS rebinding 的 TOCTOU 窗口）。
 */
export async function assertSafeRemoteUrlDetailed(rawUrl: string): Promise<SafeRemoteUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`图片地址无法解析：${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException(`只支持 http/https 图片：${rawUrl}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  // ⚠️ 顺序是**故意的**：先判地址、再判端口。两者都会拒，但"这是内网地址"比"这个端口不允许"
  //    更贴近真实原因（`http://127.0.0.1:3000/` 的问题是回环，不是 3000），
  //    而且既有的 SSRF 用例与用户看到的报错都按"内网"这个措辞写的。
  if (isPrivateAddress(host)) {
    throw new BadRequestException(`拒绝抓取内网地址：${host}`);
  }
  // 端口白名单：没有它，即使 IP 判定全对，也能打到内网服务的管理端口
  // （容器里 caddy admin 是 127.0.0.1:2019，mongo 是 27017，都不是 80/443）。
  const allowedPorts = allowedRemoteFetchPorts();
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!allowedPorts.includes(port)) {
    throw new BadRequestException(
      `拒绝抓取端口 ${port}：只允许 ${allowedPorts.join('/')}（确有需要就给 server 设 ` +
        `VANBLOG_REMOTE_FETCH_ALLOWED_PORTS=80,443,${port} 再试）`,
    );
  }
  // 域名可能解析到内网 IP（DNS rebinding），也要挡
  let addresses: string[];
  try {
    addresses = await new Promise<string[]>((resolve, reject) => {
      dns.lookup(host, { all: true }, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((result || []).map((item) => item.address));
      });
    });
  } catch (err) {
    throw new BadRequestException(`图片域名解析失败：${host}`);
  }
  if (!addresses.length) {
    throw new BadRequestException(`图片域名没有解析到任何地址：${host}`);
  }
  if (addresses.some((addr) => isPrivateAddress(addr))) {
    throw new BadRequestException(`拒绝抓取解析到内网的地址：${host}`);
  }
  return { url: parsed, addresses };
}

/**
 * 同 `assertSafeRemoteUrlDetailed`，只要 URL（历史签名，导出侧仍在用）。
 * ⚠️ 走这条的调用方拿不到已校验的 IP，所以**连接时的 DNS 解析是第二次**，
 * 存在 rebinding 窗口；新代码请用 detailed 版本并把地址钉住（见 utils/safeFetch.ts）。
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  return (await assertSafeRemoteUrlDetailed(rawUrl)).url;
}

/** 用文章对象拼 front matter（与后台导入用的 front-matter 格式对齐）。 */
export function buildFrontMatter(obj: Record<string, any>): string {
  const keys = [
    'title',
    'pathname',
    'category',
    'tags',
    'top',
    'createdAt',
    'updatedAt',
    'hidden',
    'private',
    'password',
    'cover',
  ];
  const lines: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj || {}, key)) {
      continue;
    }
    const value = obj[key];
    // 空值与 false 都不写：top/hidden/private 默认就是 false，写进去只是噪音
    if (value === undefined || value === null || value === '' || value === false) {
      continue;
    }
    if (key === 'tags') {
      if (Array.isArray(value) && value.length) {
        lines.push(`tags: [${value.map((tag) => yamlScalar(tag)).join(', ')}]`);
      }
      continue;
    }
    if (['createdAt', 'updatedAt'].includes(key)) {
      const iso = toIsoString(value);
      if (iso) {
        lines.push(`${key}: ${iso}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function toIsoString(value: any): string | null {
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

/** 最小子集的 YAML 标量输出：需要时加引号，避免标题里有冒号就把 front matter 弄坏。 */
export function yamlScalar(value: any): string {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  const text = String(value ?? '');
  if (text === '') {
    return "''";
  }
  const needsQuote =
    /[\s]/.test(text) ||
    /[:#&*!|>'"%@`,\[\]{}]/.test(text) ||
    /^[-?](\s|$)/.test(text) ||
    ['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'].includes(text.toLowerCase());
  if (!needsQuote) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 文件名安全化：去掉路径分隔符/控制字符，限长，保证非空。
 *
 * 空格和 `()[]{}'"#%` 一并换成 `-`：这些字符出现在图片目录名里时，markdown 链接目标
 * 需要转义或百分号编码，而各家编辑器（Typora / Obsidian / VSCode）支持程度不一致，
 * 干脆在文件名层面消掉。标题原文仍在 front matter 里，导入回来不会丢。
 */
export function safeExportName(title: unknown, fallback = 'untitled'): string {
  let name = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\s()\[\]{}'"#%]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!name) {
    name = fallback;
  }
  // Windows 保留名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    name = `_${name}`;
  }
  // 还要给 `.assets/` 和 `.mdz` 留位置，所以标题限长 80
  if (name.length > 80) {
    name = name.slice(0, 80).trim();
  }
  return name;
}

/** assets 目录名（Typora 风格：与 md 同名 + .assets） */
export function assetsDirName(title: unknown): string {
  return `${safeExportName(title)}${ASSETS_SUFFIX}`;
}

/**
 * 给 assets 里的文件起名：保留原扩展名，冲突时加序号。
 * 返回 [文件名, 是否需要更新映射]。
 */
export function uniqueAssetName(baseName: string, taken: Set<string>): string {
  const cleaned = String(baseName || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const name = cleaned || 'image';
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * markdown 里写的相对路径。目录名与文件名都已经被 `safeExportName` / `uniqueAssetName`
 * 洗过（没有空格、括号、`#`、`%`），所以这里不需要转义，也不做 encodeURI —— 中文保持原样，
 * Typora / Obsidian / VSCode 都能直接解析。
 */
export function toRelativeLink(assetsDir: string, fileName: string): string {
  return `${assetsDir}/${fileName}`;
}
