/**
 * 🔴 安全文档里的**默认值口径**必须与代码一致 —— 钉住一个已经漂过三次的数字。
 *
 * 为什么需要这条守卫（事实，不是推测）：
 * `VANBLOG_API_TOKEN_TTL_DAYS` 的默认值在代码里是 90（`token.provider.ts` 的 `createAPIToken`，
 * 回落写法是 `|| 90`，夹在 1–36500）。而这个"默认值"在 docs 里一度有**六处**口径，
 * 其中**三处仍写着旧的 365**：`docs/reference/secure.md`、`docs/advanced/security.md` 的环境变量表
 * （🔴 而同一份文件 135 行之后又写着"本轮再改成默认 90 天"⇒ **同文件内自相矛盾**）、
 * 以及 `docs/advanced/token.md`（**双重错误**：既写默认 365，又写"填 0/填字母/不设都回落成 365"）。
 * 第一轮只对齐了其中三处（`env.md` 本来就对、`api.md` 与 `secure.md` 与 `initJwt.ts` 的注释被改对），
 * 🔴 **也就是说"改一个默认值要同步全部口径"这件事，连续两轮都没做全**。
 *
 * 用户后果不是 cosmetic：Token **等价于超级管理员**，而照旧文档做的集成会以为凭证还有一年，
 * 实际在第 90 天**静默失效**（脚本开始 401）。
 *
 * 🔴 这条守卫刻意**只钉"不得再出现旧的默认值"**，不钉"每处都必须写出 90"：
 * 后者会误伤那些只说"可用某变量调"而不复述默认值的行，把守卫变成噪音；
 * 而"陈旧默认值不得以**当前值**的口吻出现"这一条是精确的、可机械判定的。
 *
 * ⚠️ **尺子的一个坑，已处理**：夹取上限 `36500` **含有子串 `365`** ⇒
 * 朴素的 `includes('365')` 会把"范围 1 ~ 36500 天"这种**正确**的行判成漂移（本文件开发时实测到两处假阳性）。
 * 所以判定用的是"前后都不接数字的 365"（`STALE_DEFAULT_RE`）。
 *
 * 🔴 **2026-09-23 扩充**：本文件的口径从"TTL 那一个默认值"扩成"**文档里以当前值口吻写出的数值，
 * 必须与代码里的权威常量一致**"。扩充的起因是实测出的一条不对称：代码里的
 * `FULL_CONTENT_MAX_PAGE_SIZE = 20` 被**两条**守卫钉住（`publicReadAmplification.spec.ts` 导入常量做行为断言、
 * `audit-hardening-round4-security-public-cost.spec.ts` 用 toMatch 钉字面量），
 * 而 🔴 **文档里那个 20 一条守卫都没有** —— 把 `docs/reference/api.md` 的整节删掉、或把文档里的 20 改成 21，
 * 全仓守卫一律全绿（实测）。这与 TTL 漂过三次、`api.md` 限流表漏一整桶是同族。
 *
 * 🔴 **扩充时刻意没有另建一个 spec**：同一性质（"文档数值 vs 代码常量"）只留一处口径，
 * 否则就是第二份会漂移的实现（本仓库已多次为此付学费）。下面那个 describe 复用了本文件的
 * `listMarkdown` / `EXCLUDED_PATH_RE` / `HISTORICAL_RE`。
 *
 * 🔴 **判定用"短语锚点"而不是"某行里出现了这个数字"**，原因是实测到的两个假缺口来源：
 * ①`docs/advanced/security.md` 讲读放大的那一行同时含有 7 个数字（20/60/59/41/508/100/5），
 *   所以"提到常量的行里不许有别的数字"会**立刻假红**；
 * ②`docs/advanced/performance.md` 里有 `1,076,400 B`，🔴 **裸的有界数字提取会从中取出 `400`**
 *   （千分位分隔符让无关数字含有被追踪值的有界形式）⇒ 只按"数字出现"判定必然制造假缺口。
 * 而**假缺口比没守卫更糟**：它会训练下一个人忽略红灯。
 *
 * ⚠️ 另一处取舍：**历史说明是合法的**（"早先默认是 100 年""默认值从 365 天改成了 90 天"），
 * 它们必须继续存在，否则文档就丢掉了"为什么改"的依据。所以带历史标记词的行被排除在断言之外，
 * 并且 🔴 **反空转里要求"至少有一行被判定为历史说明"** —— 如果哪天分类器把所有行都判成历史，
 * 断言就会退化成恒真，这条下界会红。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';

// 🔴 层数照抄既有跨切面守卫的约定（`utils/envVarMentions.spec.ts` 用 4 层）：
// packages/server/src/utils → 上 4 层 = 仓库根。少算一层会 ENOENT，
// 而 jest 报的是 `Test Suites: 1 failed / Tests: 0 total` —— 既不是红也不是绿的第三种形态。
const REPO_ROOT = path.resolve(__dirname, '../../../' + '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const TOKEN_PROVIDER = path.join(
  REPO_ROOT,
  'packages/server/src/provider/token/token.provider.ts',
);
const ADMIN_ADVANCE_FORM = path.join(
  REPO_ROOT,
  'packages/admin/src/pages/SystemConfig/tabs/Advance.jsx',
);

/** 变量名：拆成相邻字符串拼接，免得本文件的字面量喂饱别的"文档里不许出现某变量"类扫描。 */
const TTL_VAR = 'VANBLOG_API_TOKEN_' + 'TTL_DAYS';

/** 🔴 前后都不接数字，所以夹取上限那个五位数不会被误判成旧的默认值。 */
const STALE_DEFAULT_RE = /(^|[^\d])365([^\d]|$)/;

/** 历史说明的标记词：带这些词的行是在讲"曾经是多少"，不是当前的默认值。 */
const HISTORICAL_RE =
  /原来是|原本是|曾经是|早先|改成|再改成|过时|本轮再改|此前写的是/;

/** 生成的镜像与构建产物不参与对账（镜像由 releaseDoc.js 生成，dist 不入库）。 */
const EXCLUDED_PATH_RE =
  /(^|\/)(changelog\.md$|\.vuepress\/)/;

function listMarkdown(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listMarkdown(full, out);
    } else if (entry.endsWith('.md')) {
      const rel = path.relative(REPO_ROOT, full);
      if (!EXCLUDED_PATH_RE.test(rel)) out.push(full);
    }
  }
  return out;
}

interface StatedDefault {
  rel: string;
  line: number;
  text: string;
  historical: boolean;
  /** 该行是否以"当前值"的口吻出现了旧的默认值。 */
  staleCurrent: boolean;
}

function collectStatements(): StatedDefault[] {
  const out: StatedDefault[] = [];
  for (const file of listMarkdown(DOCS_DIR)) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (!text.includes(TTL_VAR)) return;
      const historical = HISTORICAL_RE.test(text);
      out.push({
        rel,
        line: i + 1,
        text,
        historical,
        staleCurrent: !historical && STALE_DEFAULT_RE.test(text),
      });
    });
  }
  return out;
}

/** 从代码里取出**权威默认值**，而不是在本文件里硬编码一个 90。 */
function codeDefault(): number | null {
  if (!existsSync(TOKEN_PROVIDER)) return null;
  const src = readFileSync(TOKEN_PROVIDER, 'utf8');
  const m = src.match(
    new RegExp(TTL_VAR + '\\)\\s*\\|\\|\\s*(\\d+)'),
  );
  return m ? Number(m[1]) : null;
}

describe('安全文档的默认值口径与代码一致（TTL 已漂过三次）', () => {
  const statements = collectStatements();
  const current = statements.filter((s) => !s.historical);
  const historical = statements.filter((s) => s.historical);

  it('代码里的权威默认值是 90 天（守卫的比对基准来自代码，不是硬编码）', () => {
    expect(codeDefault()).toBe(90);
  });

  it('🔴 没有任何一行以「当前值」的口吻写着旧的 365 天默认值', () => {
    const offenders = statements
      .filter((s) => s.staleCurrent)
      .map((s) => `${s.rel}:${s.line}`);
    // 断言消息里点名文件与行，否则红灯只说"有漂移"而不知道去哪修。
    expect(offenders).toEqual([]);
  });

  it('反空转：真的扫到了多处口径，且语料同时覆盖 reference 与 advanced 两个目录', () => {
    // 🔴 没有这三条下界，"解析到 0 行 ⇒ 全部通过"会是一个恒真的绿。
    expect(statements.length).toBeGreaterThanOrEqual(5);
    expect(current.length).toBeGreaterThanOrEqual(2);
    expect(historical.length).toBeGreaterThanOrEqual(1);
    const rels = statements.map((s) => s.rel).join(' ');
    expect(rels).toContain('docs/reference/');
    expect(rels).toContain('docs/advanced/');
  });

  it('反空转：语料真的包含那两份最容易漂的文件', () => {
    const rels = statements.map((s) => s.rel);
    expect(rels.some((r) => r.endsWith('docs/advanced/token.md'))).toBe(true);
    expect(rels.some((r) => r.endsWith('docs/reference/secure.md'))).toBe(true);
  });

  it('尺子有效性 A：把一行的默认值改回旧值，同一套判定必须点名它', () => {
    // 🔴 合成输入，不碰真实文件。
    const synthetic = `- 新签发的 API Token 默认 **365 天**，可用 \`${TTL_VAR}\` 调。`;
    const historicalFlag = HISTORICAL_RE.test(synthetic);
    expect(historicalFlag).toBe(false);
    expect(STALE_DEFAULT_RE.test(synthetic)).toBe(true);
    expect(!historicalFlag && STALE_DEFAULT_RE.test(synthetic)).toBe(true);
  });

  it('尺子有效性 B：夹取上限那个五位数不算旧默认值（否则正确的行会被判成漂移）', () => {
    // ⚠️ 开发本守卫时实测到过两处这样的假阳性，所以单独钉住。
    const clampLine = `- 范围 **1 ~ 36500 天**，可用 \`${TTL_VAR}\` 调。`;
    expect(STALE_DEFAULT_RE.test(clampLine)).toBe(false);
  });

  it('尺子有效性 C：历史说明里出现旧值不算漂移（否则会逼着文档删掉"为什么改"的依据）', () => {
    const histLine = `- ⚠️ **默认值从 365 天改成了 90 天**，可用 \`${TTL_VAR}\` 调。`;
    expect(HISTORICAL_RE.test(histLine)).toBe(true);
    // 与真实判定同一套逻辑：历史 ⇒ 不算 staleCurrent。
    const historicalFlag = HISTORICAL_RE.test(histLine);
    expect(!historicalFlag && STALE_DEFAULT_RE.test(histLine)).toBe(false);
  });

  it('🔴 后台表单只有登录锁定的开关，没有次数与秒数字段（这是 secure.md 那条断言的代码依据）', () => {
    // 文档说"后台能改的是开关；次数与秒数没有表单字段"，而 `docs/advanced/security.md`
    // 曾写着"后台可改 maxRetryTimes / durationSeconds"⇒ 两份文档互相矛盾。
    // 权威是表单本身：钉住"这两个键不是表单项"，谁加了字段就会红，从而被强制回来同步文档。
    expect(existsSync(ADMIN_ADVANCE_FORM)).toBe(true);
    const form = readFileSync(ADMIN_ADVANCE_FORM, 'utf8');
    expect(form).toContain('enableMaxLoginRetry');
    expect(/name=\{?'maxRetryTimes'/.test(form)).toBe(false);
    expect(/name=\{?'durationSeconds'/.test(form)).toBe(false);
  });

  it('🔴 代码里登录锁定的默认阈值是 5 次 / 300 秒（文档两处都引用了这两个数）', () => {
    const guard = readFileSync(
      path.join(REPO_ROOT, 'packages/server/src/provider/auth/login.guard.ts'),
      'utf8',
    );
    expect(guard).toContain('DEFAULT_MAX_LOGIN_RETRY = ' + '5');
    expect(guard).toContain('DEFAULT_LOGIN_WINDOW_SECONDS = ' + '300');
  });
});


/* ------------------------------------------------------------------ *
 * 🔴 文档里的分页/单页数值 vs 代码常量（文档侧此前无任何守卫）
 * ------------------------------------------------------------------ */

/** 常量名拆成相邻字符串拼接，免得本文件的字面量喂饱别的"不许出现某名字"类扫描。 */
const FULL_CAP_CONST = 'FULL_CONTENT_MAX_' + 'PAGE_SIZE';
const PAGE_MAX_CONST = 'MAX_' + 'PAGE_SIZE';
const PUBLIC_CONTROLLER = path.join(
  REPO_ROOT,
  'packages/server/src/controller/public/public.controller.ts',
);
const PAGINATION_UTIL = path.join(REPO_ROOT, 'packages/server/src/utils/pagination.ts');

/** 一行文档（相对路径 + 行号 + 原文），抽成数据以便用合成输入做尺子反证。 */
interface DocLine {
  rel: string;
  line: number;
  text: string;
}

/** 短语锚点：捕获组 1 是"以上下限口吻写出的那个数字"。 */
interface NumAnchor {
  re: RegExp;
  name: string;
}

function collectDocLines(): DocLine[] {
  const out: DocLine[] = [];
  for (const file of listMarkdown(DOCS_DIR)) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => out.push({ rel, line: i + 1, text }));
  }
  return out;
}

/** 🔴 有界数字：前后都不再接数字，所以 200 / 1200 不会被当成 20（与 365 ⊂ 36500 同族的坑）。 */
function hasBoundedNumber(text: string, n: number): boolean {
  return new RegExp('(^|[^0-9])' + String(n) + '([^0-9]|$)').test(text);
}

/** 从代码里取权威常量值，而不是在本文件里硬编码 20 / 100。 */
function codeConst(file: string, name: string): number | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const m = src.match(new RegExp('export const ' + name + '\\s*=\\s*(\\d+)\\s*;'));
  return m ? Number(m[1]) : null;
}

interface AnchorHit {
  rel: string;
  line: number;
  anchor: string;
  got: number;
  text: string;
}

/**
 * 纯函数：从若干文档行里按锚点取数值，并把"以当前值口吻写着别的数"的挑出来。
 * 🔴 做成纯函数是为了能用**合成输入**做尺子反证（不碰真实文档）。
 */
function scanAnchors(
  lines: DocLine[],
  anchors: NumAnchor[],
  authoritative: number,
): { hits: AnchorHit[]; offenders: AnchorHit[]; historicalExcluded: number } {
  const hits: AnchorHit[] = [];
  const offenders: AnchorHit[] = [];
  let historicalExcluded = 0;
  for (const l of lines) {
    for (const a of anchors) {
      a.re.lastIndex = 0;
      let m: RegExpExecArray | null = a.re.exec(l.text);
      while (m !== null) {
        const got = Number(m[1]);
        const hit: AnchorHit = {
          rel: l.rel,
          line: l.line,
          anchor: a.name,
          got,
          text: l.text.trim(),
        };
        // 🔴 历史说明里的旧值不算漂移（否则文档会丢掉"为什么改"的依据）。
        if (HISTORICAL_RE.test(l.text)) {
          historicalExcluded += 1;
        } else {
          hits.push(hit);
          if (got !== authoritative) offenders.push(hit);
        }
        m = a.re.exec(l.text);
      }
    }
  }
  return { hits, offenders, historicalExcluded };
}

/** 单页上限（含全文形态）的锚点：全部带足够上下文，🔴 不含裸「同一个 N」那种会命中端口号的宽锚点。 */
const FULL_CAP_ANCHORS: NumAnchor[] = [
  { re: /单页夹到\s*\**\s*(\d+)\s*条/g, name: '单页夹到 N 条' },
  { re: /按\**单页\s*(\d+)\s*条/g, name: '按单页 N 条' },
  { re: /不受\s*(\d+)\s*那一档/g, name: '不受 N 那一档' },
  { re: /也算到了同一个\s*(\d+)/g, name: '也算到了同一个 N' },
  {
    re: new RegExp('那个\\s*\\**\\s*(\\d+)\\**\\s*是[^。\\n]*' + FULL_CAP_CONST, 'g'),
    name: '那个 N 是…常量',
  },
];

/**
 * 🔴 `MAX_PAGE_SIZE` 是 `FULL_CONTENT_MAX_PAGE_SIZE` 的**子串** ⇒ 必须用"名字有界"的锚点，
 * 否则讲单页上限的那一行会被算到 MAX_PAGE_SIZE 头上（实测裸匹配每份文档多算 1 处）。
 */
const PAGE_MAX_ANCHORS: NumAnchor[] = [
  {
    re: new RegExp('(?<![A-Z_])' + PAGE_MAX_CONST + '`?（\\**(\\d+)\\**）', 'g'),
    name: '夹到 MAX_PAGE_SIZE（N）',
  },
  { re: /\|\s*(\d+)（`MAX_PAGE_SIZE`）\s*\|/g, name: '表格 N（MAX_PAGE_SIZE）' },
];

/** api.md 的分页节：切出表头含「单页上限」的那张表的数据行。 */
function paginationTableRows(): string[][] {
  const api = path.join(DOCS_DIR, 'reference/api.md');
  if (!existsSync(api)) return [];
  const txt = readFileSync(api, 'utf8');
  const m = txt.match(/^## 分页与单页上限$([\s\S]*?)^## /m);
  if (!m) return [];
  const tableLines = m[1].split('\n').filter((l) => l.trim().startsWith('|'));
  const header = (tableLines[0] || '').split('|').map((c) => c.trim());
  const capIdx = header.findIndex((c) => c.includes('单页上限'));
  if (capIdx < 0) return [];
  return tableLines.slice(2).map((l) => l.split('|').map((c) => c.trim()));
}

describe('文档里的分页/单页数值必须与代码常量一致（文档侧此前无守卫）', () => {
  const docLines = collectDocLines();
  const fullCap = codeConst(PUBLIC_CONTROLLER, FULL_CAP_CONST);
  const pageMax = codeConst(PAGINATION_UTIL, PAGE_MAX_CONST);
  const fullScan = scanAnchors(docLines, FULL_CAP_ANCHORS, fullCap ?? -1);
  const pageScan = scanAnchors(docLines, PAGE_MAX_ANCHORS, pageMax ?? -1);
  const docsNamingConst = docLines
    .filter((l) => l.text.includes(FULL_CAP_CONST))
    .map((l) => l.rel)
    .filter((v, i, a) => a.indexOf(v) === i);

  it('🔴 权威值来自代码而不是硬编码：单页上限 20、MAX_PAGE_SIZE 100，且上限不是环境变量', () => {
    expect(fullCap).toBe(20);
    expect(pageMax).toBe(100);
    // 文档写着"不是环境变量（想放宽只能改常量并重新构建镜像）"⇒ 钉住这个前提。
    const src = readFileSync(PUBLIC_CONTROLLER, 'utf8');
    const at = src.indexOf('export const ' + FULL_CAP_CONST);
    expect(at).toBeGreaterThan(0);
    const around = src.slice(Math.max(0, at - 900), at + 120);
    expect(around.includes('process' + '.env')).toBe(false);
  });

  it('🔴 文档里每一处「单页上限」措辞的数值都等于代码常量（失败信息点名文件:行与可 grep 的行文本）', () => {
    const offenders = fullScan.offenders.map(
      (o) => `${o.rel}:${o.line} [${o.anchor}] 写着 ${o.got}、代码是 ${fullCap} :: ${o.text.slice(0, 90)}`,
    );
    expect(offenders).toEqual([]);
  });

  it('🔴 MAX_PAGE_SIZE 的口径同样对账（用名字有界的锚点，因为它是 FULL_CONTENT_MAX_PAGE_SIZE 的子串）', () => {
    const offenders = pageScan.offenders.map(
      (o) => `${o.rel}:${o.line} [${o.anchor}] 写着 ${o.got}、代码是 ${pageMax} :: ${o.text.slice(0, 90)}`,
    );
    expect(offenders).toEqual([]);
  });

  it('🔴 子串陷阱的反证：裸名字匹配会比有界匹配多算（所以锚点必须有界）', () => {
    const corpus = docLines.map((l) => l.text).join('\n');
    const bare = (corpus.match(new RegExp(PAGE_MAX_CONST, 'g')) || []).length;
    const bounded = (corpus.match(new RegExp('(?<![A-Z_])' + PAGE_MAX_CONST, 'g')) || []).length;
    expect(bare).toBeGreaterThan(bounded);
    expect(bounded).toBeGreaterThan(0);
  });

  it('🔴 api.md 分页表里「匿名 + 响应含正文」那一行的上限单元格必须写着权威值', () => {
    const rows = paginationTableRows();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // 判据是语义的：匿名、且响应里有正文（"没有"也含"有"⇒ 先排除"没有"）。
    const constrained = rows.filter((c) => {
      const shape = c[1] || '';
      const body = c[3] || '';
      return shape.includes('匿名') && !body.includes('没有') && body.includes('有');
    });
    expect(constrained.length).toBe(1);
    const capCell = constrained[0][2] || '';
    expect(hasBoundedNumber(capCell, fullCap ?? -1)).toBe(true);
  });

  it('正向存在：提到该常量的两份文档各自都写明了权威值（不是只在其中一处）', () => {
    expect(docsNamingConst.length).toBe(2);
    for (const rel of docsNamingConst) {
      const lines = docLines.filter((l) => l.rel === rel).map((l) => l.text);
      expect(lines.some((t) => hasBoundedNumber(t, fullCap ?? -1))).toBe(true);
    }
  });

  it('反空转：语料、锚点命中数与目录覆盖都达到下界（否则"解析到 0 处 ⇒ 全部通过"是恒真的）', () => {
    expect(docLines.length).toBeGreaterThan(2000);
    expect(docsNamingConst.length).toBeGreaterThanOrEqual(2);
    expect(fullScan.hits.length).toBeGreaterThanOrEqual(5);
    expect(pageScan.hits.length).toBeGreaterThanOrEqual(2);
    expect(docsNamingConst.some((r) => r.endsWith('docs/reference/api.md'))).toBe(true);
    expect(docsNamingConst.some((r) => r.endsWith('docs/advanced/security.md'))).toBe(true);
    // 🔴 并证明这 5 处没有一处被历史分类器误吞（否则断言会在"全部算历史"时退化成恒真）。
    expect(fullScan.hits.every((h) => h.got === fullCap)).toBe(true);
  });

  it('尺子有效性 A（合成输入）：文档写 21 而代码是 20 ⇒ 必须被点名，且失败信息带着锚点名', () => {
    const synthetic: DocLine[] = [
      { rel: 'synthetic/a.md', line: 3, text: '- **匿名的"含全文列表"单页夹到 21 条**（`X`）。' },
      { rel: 'synthetic/a.md', line: 9, text: '并按**单页 21 条**写分页。' },
    ];
    const r = scanAnchors(synthetic, FULL_CAP_ANCHORS, 20);
    expect(r.hits.length).toBe(2);
    expect(r.offenders.length).toBe(2);
    expect(r.offenders.map((o) => o.anchor)).toEqual(['单页夹到 N 条', '按单页 N 条']);
    expect(r.offenders.every((o) => o.got === 21)).toBe(true);
  });

  it('尺子有效性 B（合成输入）：边界匹配 ⇒ 200 / 1200 不会被当成 20，而会被如实报为不同的值', () => {
    expect(hasBoundedNumber('单页 200 条', 20)).toBe(false);
    expect(hasBoundedNumber('单页 1200 条', 20)).toBe(false);
    expect(hasBoundedNumber('单页 20 条', 20)).toBe(true);
    const synthetic: DocLine[] = [
      { rel: 'synthetic/b.md', line: 1, text: '单页夹到 200 条。' },
      { rel: 'synthetic/b.md', line: 2, text: '单页夹到 1200 条。' },
    ];
    const r = scanAnchors(synthetic, FULL_CAP_ANCHORS, 20);
    // 取到的是 200 / 1200 本身（不是从中截出 20），因此都被如实判为漂移。
    expect(r.offenders.map((o) => o.got)).toEqual([200, 1200]);
  });

  it('🔴 尺子有效性 C（合成输入）：千分位数字里的 400 不被锚点命中（裸有界提取会取出它）', () => {
    const trap = '实测首页一个摘要里就有 3,497,836 B 和 1,076,400 B 两张 webp，缩略图只有 300px。';
    // 裸提取确实会取出 400 ⇒ 这正是"只按数字出现判定"会制造假缺口的证据。
    const bare = trap.match(/(^|[^0-9])400([^0-9]|$)/);
    expect(bare).not.toBeNull();
    // 而短语锚点一个都不命中 ⇒ 不会把它当成"上限口径"。
    const r = scanAnchors([{ rel: 'synthetic/c.md', line: 1, text: trap }], FULL_CAP_ANCHORS, 20);
    expect(r.hits.length).toBe(0);
    expect(r.offenders.length).toBe(0);
  });

  it('尺子有效性 D（合成输入）：历史说明里写着旧上限不算漂移（否则会逼文档删掉"为什么改"的依据）', () => {
    const synthetic: DocLine[] = [
      { rel: 'synthetic/d.md', line: 1, text: '- ⚠️ **单页夹到 100 条**是闸门落地前的口径，改成 20 条了。' },
    ];
    const r = scanAnchors(synthetic, FULL_CAP_ANCHORS, 20);
    expect(r.historicalExcluded).toBe(1);
    expect(r.offenders.length).toBe(0);
  });
});
