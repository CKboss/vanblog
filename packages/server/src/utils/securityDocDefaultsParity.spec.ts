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
