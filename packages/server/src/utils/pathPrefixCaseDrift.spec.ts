import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

/**
 * 🔴 仓库级横切守卫：**请求路由判定里的路径前缀比较，必须大小写不敏感**。
 *
 * ## 为什么需要这条守卫
 * 同一个缺陷形状在 2026-09-22 这一天里，在**四个不同模块**各被发现一次：
 * "大小写敏感的路径前缀比较" 对着 "大小写不敏感的 Express 路由 / 静态挂载"。
 * Express 默认 `case sensitive routing = false` 且 `strict routing = false`，
 * 而 `main.ts` 两者都没有设置 ⇒ `/STATIC/x`、`/API/admin/meta` 与规范写法命中**同一个处理器**，
 * 但大小写敏感的前缀比较**认不出它们**，于是判定被绕过。
 *
 * 四处的后果各不相同，但都真实：
 * - `utils/staticGuard.ts` —— 匿名单次 GET 就能下载受守目录里的文件
 *   （其中恢复暂存目录含密码哈希与 JWT 密钥）；已在 `d4f58ec2` 修复。
 * - `main.ts` 的 pre-Nest 限流门控 —— 静态资源**完全不受任何频率限制**地被匿名拉取，
 *   并且拿不到 `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy`。
 * - `utils/cacheControl.ts` —— 管理响应在大写变体 URL 上失去 `no-store`。
 * - `utils/rateLimit.ts` —— 更严的限流档可被大小写变体绕过（此前已修）。
 *
 * 🔴 **四处里此前每次只修了被发现的那一处**，所以这条守卫的意义是：
 * **第五处再长出来时会立刻红**，而不是等到有人活体测到。
 *
 * ## 扫描口径（刻意收窄，否则会天天误报到失效）
 * 只关心 **A 类：请求路由判定** —— 比较对象来自请求路径
 * （`req.path` / `req.url` / `req.originalUrl` / `pathFromRequest(...)` / 降级期自建 server 的 `req.url`）。
 * 🔴 **B 类（数据形状校验）大小写敏感是正确的，不要"顺手统一"**：
 * 校验容器内文件路径（Linux 文件系统本来就大小写敏感）、校验归档成员名是否绝对路径、
 * 校验用户提交的评论 path 的**格式**、判协议相对 `//` 与站内相对 `/`、
 * 匹配**应用自己生成并存库**的 `/post/...` URL（不是攻击者可控的大小写变体，且用途是分组而非访问控制）、
 * 以及判"这是不是本站图床的 URL"（输入是我们自己生成的，最坏只影响渲染不影响权限）。
 * B 类逐个登记在下面的白名单里并写明理由。
 *
 * ⚠️ **两个必须记住的坑**（都写在被修文件的注释里，这里再记一次）：
 * 1. 🔴 `main.ts` 那处的 `decodeURIComponent` 是**故意保留**的（静态层会解码，所以要解码后再比一次）
 *    ⇒ **修大小写时绝不能把解码一起去掉**，那是另一个维度的正确防护。
 * 2. 🔴 而 `utils/rateLimit.ts` 那边**必须不解码**（Express 路由匹配用的是未解码的 `req.path`，
 *    解码会让限流器比路由器更宽）⇒ **"要不要解码"取决于下游是谁，这两个模块的口径故意不同、不该统一**。
 *    （`utils/staticGuard.ts` 必须解码，因为下游 serve-static/send 在打开文件前会解码。）
 * 3. ⚠️ **比较用小写副本，`slice` 用原串**：`toLowerCase()` 对非 ASCII **可能改变长度**
 *    （例如带点的土耳其语大写 I 小写后是 2 个字符），用小写副本算偏移会切错位置。
 */

const SRC_ROOT = path.join(__dirname, '..');

/** 需要盯住的敏感路径前缀（A 类判定会用到的那些）。 */
// ⚠️ 一律用**不带尾斜杠**的形式：`'/static` 同时覆盖 `'/static'`（静态根本身）与 `'/static/'`（目录前缀）。
//    第一版写成 `'/static/` 因此漏掉了 `staticGuard.ts` 里 `p.toLowerCase() === '/static'` 那一行
//    —— 是"已修四处必须是安全形状"那条断言把它抓出来的（尺子有效性反证起作用了）。
const SENSITIVE_PREFIXES = ["'/static", "'/api", "'/admin", "'/rss", "'/sitemap", "'/swagger"];

/** 视为"比较"的语法形状。 */
const COMPARISON_RE = /startsWith\(|===|!==|indexOf\(|includes\(|\.match\(/;

type Hit = { file: string; line: number; text: string; kind: 'compare' | 'prefixList'; lines: string[] };

/** 回溯窗口：`toLowerCase()` 常常在比较的**前一行**（`const lower = p.toLowerCase();`）。 */
const BACK_WINDOW = 14;
/** 前缀数组声明之后，允许在多远的范围内找到大小写不敏感的比较。 */
const FWD_WINDOW = 44;

/**
 * 剥掉注释、**保留字符串**。
 * 🔴 剥多少取决于要断言什么：这里要断言的是"代码里有没有某个比较"，
 * 所以必须剥注释（否则注释里举例的字面量会喂饱守卫 —— 本仓库已三次栽在这上面），
 * 但**必须保留字符串**（因为前缀本身就是字符串字面量，剥掉就什么都不剩了）。
 * ⚠️ 不能用"见到 `//` 就截断"的简单口径：`'https://…'` 里的 `//` 会把整行吃掉。
 */
function stripCommentsKeepStrings(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        // 转义：连下一个字符一起原样输出
        if (i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
          continue;
        }
      } else if (c === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // 保留换行，这样行号仍然可用
        if (src[i] === '\n') {
          out += '\n';
        }
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (!name.endsWith('.ts')) {
      continue;
    }
    // 本文件与所有 spec 都不扫：spec 里的字面量是断言用的，不是路由判定
    if (name.endsWith('.spec.ts') || name.endsWith('.d.ts')) {
      continue;
    }
    acc.push(full);
  }
  return acc;
}

function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const full of walk(SRC_ROOT, [])) {
    const rel = path.relative(SRC_ROOT, full).split(path.sep).join('/');
    const stripped = stripCommentsKeepStrings(readFileSync(full, 'utf8'));
    const lines = stripped.split('\n');
    for (let idx = 0; idx < lines.length; idx += 1) {
      const text = lines[idx];
      const matched = SENSITIVE_PREFIXES.filter((p) => text.includes(p));
      if (matched.length === 0) {
        continue;
      }
      if (COMPARISON_RE.test(text)) {
        hits.push({ file: rel, line: idx + 1, text: text.trim(), kind: 'compare', lines });
        continue;
      }
      // 🔴 第二类形状：**前缀数组声明**（例如 `const PREFIXES = ['/static/', '/rss/']`）。
      //    这种写法下比较那一行用的是变量（`prefix`），逐行启发式**扫不到** ——
      //    `main.ts` 就是这个形状，第一版守卫因此对它**零命中**（尺子有效性反证抓到的）。
      //    ⇒ 单独登记，并要求在它之后 FWD_WINDOW 行内出现大小写不敏感的比较。
      if (matched.length >= 2 && /[=:]\s*\[/.test(text)) {
        hits.push({ file: rel, line: idx + 1, text: text.trim(), kind: 'prefixList', lines });
      }
    }
  }
  return hits;
}

/** 取比较的接收者：`X.startsWith(` 或 `X ===` 里的 X（可能是 `a.b` 或 `f().g`）。 */
function receiverOf(text: string): string {
  const m = /([A-Za-z_$][\w$.]*(?:\([^()]*\))?)\s*(?:\.startsWith\(|===|!==)/.exec(text);
  return m ? m[1] : '';
}

/**
 * 判定一处命中是不是"安全形状"：比较是大小写不敏感的。
 * 🔴 三种被认可的形式（都由已修的四处 A 类判定归纳而来）：
 * 1. **同一行**里接收者表达式含 `toLowerCase(`（`p.toLowerCase().startsWith('/static/')`）；
 * 2. 接收者是一个变量，而**回溯窗口内**有 `const <该变量> = ….toLowerCase()…`
 *    （`const lower = path.toLowerCase();` 然后 `lower.startsWith('/admin/')`）；
 * 3. `kind === 'prefixList'`：**前向窗口内**出现 `toLowerCase(`（前缀在数组里、比较用变量）。
 * ⚠️ 口径是保守的：形式 2/3 只看"窗口内有没有 toLowerCase"，不做真正的数据流分析，
 * 所以**理论上**可能把"窗口里恰好有个无关的 toLowerCase"误判成安全（假绿）。
 * 🔴 用两条断言把假绿的风险压住：白名单必须逐条写理由且 anchor 必须真实存在（防腐），
 * 而"已修的四处必须是安全形状"那条断言**直接钉住具体代码文本**（不依赖窗口启发式）。
 */
function isCaseInsensitiveShape(hit: Hit, lines: string[]): boolean {
  if (hit.kind === 'prefixList') {
    for (let i = hit.line - 1; i < Math.min(lines.length, hit.line - 1 + FWD_WINDOW); i += 1) {
      if (lines[i].includes('toLowerCase(')) {
        return true;
      }
    }
    return false;
  }
  if (hit.text.includes('toLowerCase(')) {
    return true;
  }
  const recv = receiverOf(hit.text);
  if (!recv) {
    return false;
  }
  const assignRe = new RegExp('(const|let|var)\\s+' + recv.replace(/\$/g, '\\$') + '\\s*=.*toLowerCase\\(');
  for (let i = Math.max(0, hit.line - 1 - BACK_WINDOW); i < hit.line; i += 1) {
    if (assignRe.test(lines[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 白名单：**逐条写明为什么这一处大小写敏感是正确的 / 或为什么它已经在别处归一化了**。
 * 🔴 防腐机制：每条的 `anchor` 必须在对应文件里**真实存在**，否则守卫红
 * （逼人确认"这处还是原来那处吗"，而不是让白名单悄悄失效）。
 * 仿 `utils/queryFilterDrift.spec.ts` 的手法。
 */
type Entry = { file: string; anchor: string; klass: string; reason: string };

const ALLOWLIST: Entry[] = [
  {
    file: 'utils/rateLimit.ts',
    anchor: "return typeof path === 'string' && path.startsWith('/static/');",
    klass: 'A-已在上游归一化',
    reason:
      'isStaticAssetPath 的入参是中间件里**唯一一次**经 normalizeRateLimitPath 归一化后的 path' +
      '（去尾斜杠 + 转小写 + 切 query/hash），所以这里比的是已归一化的值；' +
      '由 rateLimitPathNormalization.spec.ts 的行为级断言钉住。',
  },
  {
    file: 'utils/rateLimit.ts',
    anchor: "if (path.startsWith('/api/admin/init') && !SAFE_METHODS.has(method)) {",
    klass: 'A-已在上游归一化',
    reason: '同上：path 来自 normalizeRateLimitPath。⚠️ 这一行的**逐字形状**另被审计 spec 钉住，不要改写。',
  },
  {
    file: 'utils/rateLimit.ts',
    anchor: "if (path.startsWith('/api/public/') && !SAFE_METHODS.has(method)) {",
    klass: 'A-已在上游归一化',
    reason: '同上：path 来自 normalizeRateLimitPath。⚠️ 这一行的**逐字形状**另被审计 spec 钉住，不要改写。',
  },
  {
    file: 'utils/rateLimit.ts',
    anchor: "return normalized === '/api/public/category' || normalized === '/api/public/tag';",
    klass: 'A-已在上游归一化',
    reason: 'isPublicAggregateListPath 内部先调 normalizeRateLimitPath 得到 normalized 再比较。',
  },
  {
    file: 'provider/static/local.provider.ts',
    anchor: "if (!raw.startsWith('/static/')) {",
    klass: 'B-数据形状校验',
    reason:
      '判"这是不是本站图床的 URL"，输入是**应用自己生成并存库**的封面/图片 URL，不是请求路径；' +
      '最坏后果是"封面被当外链处理"，**影响渲染不影响权限**（已登记，有意不改）。',
  },
  {
    file: 'utils/coverFromContent.ts',
    anchor: "return value.startsWith('/static/');",
    klass: 'B-数据形状校验',
    reason: '同上：判文章封面是不是本站图床 URL，输入来自库里的正文，不是请求路径。',
  },
  {
    file: 'utils/coverFromContent.ts',
    anchor: "if (!preferLocal || url.startsWith('/static/')) {",
    klass: 'B-数据形状校验',
    reason: '同上：判 URL 归属，输入来自库里数据。',
  },
  {
    file: 'utils/markdownExport.ts',
    anchor: "if (url.startsWith('/static/')) {",
    klass: 'B-数据形状校验',
    reason: '导出 markdown 时判图片是不是本站资源（决定要不要打包进 zip），输入来自库里的正文。',
  },
  {
    file: 'utils/markdownExport.ts',
    anchor: "if (parsed.pathname.startsWith('/static/') && sameSite) {",
    klass: 'B-数据形状校验',
    reason: '同上：解析正文里的绝对 URL 后判归属。',
  },
  {
    file: 'utils/degradedHold.ts',
    anchor: "if (req.method === 'GET' && normalized === '/api/public/health') {",
    klass: 'A-低严重度（不改）',
    reason:
      '🔴 这是**第五处 A 类形状**（比较对象来自降级期自建 server 的 req.url），而 normalized 只去尾斜杠、不小写化。' +
      '⚠️ 但它**不是安全洞**：降级期用的是 Node 原生 http.createServer，**完全没有路由**，' +
      '不存在"大小写不敏感的下游会服务别的内容"这回事；大写变体只会落到通用 503 分支，' +
      '拿到通用 body 而不是健康检查 body ⇒ 后果是**外观/低**（健康探测方用的是规范小写路径）。' +
      '⚠️ 已报告给父代理裁定是否要顺手小写化（改它会让大写健康探测也拿到 health body，行为更一致但属可选）。',
  },
];

describe('横切守卫：请求路由判定的路径前缀比较必须大小写不敏感', () => {
  const hits = collectHits();

  it('尺子有效性①：扫描器真的扫到了东西（否则后面全是空断言）', () => {
    // 反空转：整个 src 下这类比较至少有十几处
    expect(hits.length).toBeGreaterThan(10);
    // 并且必须扫到了我们关心的那几个文件
    const files = new Set(hits.map((h) => h.file));
    for (const f of ['main.ts', 'utils/cacheControl.ts', 'utils/staticGuard.ts', 'utils/rateLimit.ts']) {
      expect(files.has(f)).toBe(true);
    }
    // 🔴 两类形状都要扫到：只有 'compare' 会漏掉 main.ts 那种"前缀在数组里、比较用变量"的写法
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.has('compare')).toBe(true);
    expect(kinds.has('prefixList')).toBe(true);
    expect(hits.some((h) => h.file === 'main.ts' && h.kind === 'prefixList')).toBe(true);
  });

  it('尺子有效性②：注释剥除器真的在工作（注释里的举例字面量不算命中）', () => {
    // rateLimit.ts 的注释里有大量 `/api/public/` 与 startsWith 的字样（讲解历史取舍），
    // 如果不剥注释，它们会被算成命中并要求白名单 ⇒ 用"命中的行都不含中文讲解特征"来反证。
    for (const h of hits) {
      expect(h.text.startsWith('*')).toBe(false);
      expect(h.text.startsWith('//')).toBe(false);
    }
    // 并且剥除器保留字符串（否则前缀字面量会被一起吃掉、hits 恒空 ⇒ 上面那条 >10 就是它的反证）
    const stripped = stripCommentsKeepStrings("const a = '/static/x'; // 注释里也有 '/static/'");
    expect(stripped.includes("'/static/x'")).toBe(true);
    expect(stripped.includes('注释里也有')).toBe(false);
    // ⚠️ 字符串里的 `//` 不能被当成行注释（否则 'https://…' 会被整行吃掉）
    const kept = stripCommentsKeepStrings("const u = 'https://example.com/a';");
    expect(kept.includes('example.com')).toBe(true);
  });

  it('🔴 每一处命中要么本身就是大小写不敏感的形状，要么在白名单里且写明理由', () => {
    const unclassified: string[] = [];
    for (const h of hits) {
      if (isCaseInsensitiveShape(h, h.lines)) {
        continue;
      }
      const entry = ALLOWLIST.find((e) => e.file === h.file && h.text.includes(e.anchor));
      if (!entry) {
        unclassified.push(`${h.file}:${h.line}  ${h.text}`);
      }
    }
    // 失败信息要能直接照着去看
    expect(unclassified).toEqual([]);
  });

  it('🔴 已修的四处 A 类判定确实是"大小写不敏感"的形状（不是靠白名单混过去的）', () => {
    const byFile = new Map<string, string[]>();
    for (const h of hits) {
      const arr = byFile.get(h.file) || [];
      arr.push(h.text);
      byFile.set(h.file, arr);
    }
    expect(byFile.size).toBeGreaterThan(3);
    // main.ts 的 pre-Nest 门控：🔴 直接钉**源码文本**，不依赖窗口启发式
    //（它的比较行用的是变量 prefix，逐行口径本来就扫不到 —— 那正是要钉住的地方）
    const mainSrc = readFileSync(path.join(SRC_ROOT, 'main.ts'), 'utf8');
    expect(mainSrc.includes('lower.startsWith(prefix.toLowerCase())')).toBe(true);
    expect(mainSrc.includes('const lower = p.toLowerCase();')).toBe(true);
    // 🔴 并且 decodeURIComponent 那个维度**必须还在**（修大小写时不许把它一起去掉）
    expect(mainSrc.includes('decodeURIComponent(rawPath)')).toBe(true);
    // 🔴 门控的前缀清单必须**恰好**是这四条（防止"过度修复"成匹配所有路径，
    //    那会把 API 与前台一起拖进 pre-Nest 限流）
    const m = /const PRE_NEST_LIMITED_PREFIXES = \[([^\]]*)\];/.exec(mainSrc);
    expect(m).not.toBeNull();
    const prefixes = (m as RegExpExecArray)[1]
      .split(',')
      .map((x) => x.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(prefixes).toEqual(['/static/', '/rss/', '/sitemap/', '/swagger']);

    // cacheControl.ts 的管理面 no-store 判定
    // ⚠️ 判据读**文件源码**而不是命中行：`const lower = path.toLowerCase();` 那一行
    //    不含敏感前缀字面量，所以它本身不是"命中"，但它是四个分支安全的原因。
    const ccSrc = readFileSync(path.join(SRC_ROOT, 'utils/cacheControl.ts'), 'utf8');
    expect(ccSrc.includes('const lower = path.toLowerCase();')).toBe(true);
    const ccHits = byFile.get('utils/cacheControl.ts') || [];
    expect(ccHits.length).toBeGreaterThanOrEqual(4);
    // ⚠️ 判据用"接收者标识符"而不是 `lower.`：四个分支里有两条是 `lower === '…'`（不含点号）
    expect(ccHits.filter((t) => /\blower\b/.test(t)).length).toBeGreaterThanOrEqual(4);

    // staticGuard.ts 的三处（已提交，本守卫只负责钉住它**继续**是安全形状）
    const sgHits = byFile.get('utils/staticGuard.ts') || [];
    // 三处：`=== '/static'`（静态根本身）、`hadStaticPrefix` 那次、以及归一化后的那次
    expect(sgHits.filter((t) => t.includes('toLowerCase()')).length).toBeGreaterThanOrEqual(3);
  });

  it('🔴 白名单的防腐机制：每条 anchor 都必须在对应文件里真实存在', () => {
    const stale: string[] = [];
    for (const e of ALLOWLIST) {
      const full = path.join(SRC_ROOT, e.file);
      let src = '';
      try {
        src = stripCommentsKeepStrings(readFileSync(full, 'utf8'));
      } catch {
        stale.push(`${e.file} 读不到`);
        continue;
      }
      if (!src.includes(e.anchor)) {
        stale.push(`${e.file} 里找不到 anchor：${e.anchor.slice(0, 60)}`);
      }
      // 理由必须真的写了（防止白名单退化成"只列文件名"）
      expect(e.reason.length).toBeGreaterThan(20);
      expect(e.klass.length).toBeGreaterThan(0);
    }
    expect(stale).toEqual([]);
  });

  it('🔴 白名单不是死的：每一条都真的被某次命中用到（否则它在掩盖一个已消失的形状）', () => {
    const unused: string[] = [];
    for (const e of ALLOWLIST) {
      const used = hits.some((h) => h.file === e.file && h.text.includes(e.anchor));
      if (!used) {
        unused.push(`${e.file} :: ${e.anchor.slice(0, 50)}`);
      }
    }
    expect(unused).toEqual([]);
  });

  it('🔴 A 类白名单只允许"已在上游归一化"与"低严重度且有据"两种理由', () => {
    for (const e of ALLOWLIST) {
      if (!e.klass.startsWith('A-')) {
        continue;
      }
      const ok = e.klass === 'A-已在上游归一化' || e.klass === 'A-低严重度（不改）';
      expect(ok).toBe(true);
      // A 类必须说明"谁归一化的"或"为什么严重度低"
      expect(e.reason.length).toBeGreaterThan(60);
    }
  });
});

describe('isAdminNoStorePath：大小写变体与规范路径同样拿到 no-store（行为级）', () => {
  // 直接 require 被测模块（避免 import 提升把别的模块一起拉进来）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { isAdminNoStorePath } = require('./cacheControl') as typeof import('./cacheControl');

  it('替身自检：规范路径确实被认出来（否则下面的断言可能恒真）', () => {
    expect(isAdminNoStorePath('/api/admin/meta')).toBe(true);
    expect(isAdminNoStorePath('/admin')).toBe(true);
  });

  it('🔴 大小写变体与尾斜杠变体同样被认出来', () => {
    for (const p of [
      '/API/admin/meta',
      '/Api/Admin/Meta',
      '/ADMIN',
      '/Admin/',
      '/api/admin/',
      '/api/admin/auth/login',
      '/API/ADMIN/AUTH/LOGIN',
    ]) {
      expect([p, isAdminNoStorePath(p)]).toEqual([p, true]);
    }
  });

  it('🔴 反方向：公开面与前台资源**不许**被认成管理面（否则守卫靠"全都返回 true"恒真）', () => {
    for (const p of [
      '/api/public/meta',
      '/API/PUBLIC/META',
      '/post/some-article',
      '/static/img/a.webp',
      '/STATIC/img/a.webp',
      '/rss/feed.xml',
      '/',
      '/category',
    ]) {
      expect([p, isAdminNoStorePath(p)]).toEqual([p, false]);
    }
  });
});
