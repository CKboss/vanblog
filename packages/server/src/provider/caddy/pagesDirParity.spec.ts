/**
 * 🔴 跨语言一致性守卫：`VANBLOG_CADDY_HTML_PAGES_DIR` 在 **TS 侧**与 **JS 侧**必须得出同一个结论。
 *
 * ## 为什么需要这条守卫（缺陷的由来）
 * 这个变量同时决定两件事，而它们必须指向**同一个目录**才有效：
 *   - JS 侧 `scripts/caddyConfig.js` 把它写进 caddy 的 `vanblog-serve-html` 路由 `vars.root`；
 *   - TS 侧用它决定**哨兵文件写到哪**（caddy 用 `try_files` 判断哨兵存在性，而 `try_files`
 *     相对当前 root 解析 ⇒ 哨兵必须与 root 同目录），并且 `provider/isr/artifactReaper`
 *     拿它去**删产物**。
 * 修复前 JS 侧校验、TS 侧不校验（三处都是裸 `env || DEFAULT`）⇒ 给一个非法值时两侧得出
 * **不同目录**：caddy 回落默认、服务端照用非法值 ⇒ 直服静默失效，而 reaper 可能删错地方。
 *
 * ## TS 与 JS 无法共用实现，所以只能"对齐 + 守卫"
 * 这条 spec 的做法不是"两边都提到某个关键词"（那是空断言），而是：
 *   1. 从 `scripts/caddyConfig.js` **原文里按花括号配平切出真正的 `resolvePagesDir` 与
 *      `hasControlChars`**，用 `new Function` 装载 ⇒ 跑的是**仓库里那份代码**，
 *      任何人改了 JS 侧规则，这里立刻看得见；
 *   2. 对**同一批取值**（`scripts/tests/fixtures/pages-dir-cases.json`，与 shell 守卫共用）
 *      真跑两侧，逐个比对 `provided / rejected / rule / dir / normalized`；
 *   3. 再对其中几个取值**真跑一次生成器**（子进程 + 真模板），断言可观测后果
 *      （`vars.root` 被改写成什么、stderr 有没有 WARN）⇒ 证明"我切出来的那个函数"
 *      确实是生成器**在用**的那个，而不是文件里一段没人调用的死代码。
 *
 * ⚠️ 两侧的 `dir` 形状有一处**有意差异**，映射关系写死在这里：
 *    JS 用 `dir === null` 表示"不改写模板、沿用模板默认"（生成器的默认值来自模板而非常量），
 *    TS 的 `dir` 永远是可直接使用的具体路径（回落 `DEFAULT_WEBSITE_PAGES_DIR`）。
 *    所以比对时 `JS.dir === null` ⇔ `TS.dir === DEFAULT_WEBSITE_PAGES_DIR`。
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  DEFAULT_WEBSITE_PAGES_DIR,
  PAGES_DIR_REJECT_RULES,
  SERVE_HTML_PAGES_DIR_ENV,
  resolveWebsitePagesDir,
} from './caddy.provider';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const GENERATOR = resolve(REPO_ROOT, 'scripts/caddyConfig.js');
const TEMPLATE = resolve(REPO_ROOT, 'caddyTemplate.json');
const CASES_FILE = resolve(REPO_ROOT, 'scripts/tests/fixtures/pages-dir-cases.json');

/* ─────────────────────────── 从 JS 原文切出真函数 ─────────────────────────── */

/**
 * 按**花括号配平**切出一个顶层 `function <name>(...) { ... }` 的完整源码。
 * ⚠️ 不能用"到下一个 `^}` 为止"这种正则：函数体里有嵌套块，那样会切短。
 * ⚠️ 也不要把源码复制进本文件 —— 复制品不会随 JS 侧改动而失效，守卫就空转了。
 */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`在 ${GENERATOR} 里找不到 function ${name}(`);
  const braceOpen = src.indexOf('{', start);
  if (braceOpen < 0) throw new Error(`${name} 没有函数体`);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的花括号不配平`);
}

/** 装载 JS 侧的真函数（每次调用都重新读文件，避免缓存掩盖改动）。 */
function loadJsResolver(): {
  resolvePagesDir: (raw: unknown) => { dir: string | null; warns: string[] };
  source: string;
  envName: string;
} {
  const src = readFileSync(GENERATOR, 'utf8');
  const fnMain = sliceFunction(src, 'resolvePagesDir');
  const fnControl = sliceFunction(src, 'hasControlChars');
  const envMatch = src.match(/const PAGES_DIR_ENV = '([^']+)';/);
  if (!envMatch) throw new Error('在生成器里找不到 PAGES_DIR_ENV 常量');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'PAGES_DIR_ENV',
    `${fnControl}\n${fnMain}\nreturn resolvePagesDir;`,
  ) as (envName: string) => (raw: unknown) => { dir: string | null; warns: string[] };
  return { resolvePagesDir: factory(envMatch[1]), source: fnMain, envName: envMatch[1] };
}

/** 从 JS 的拒绝文案里认出是哪条规则（顺序与两侧实现一致）。 */
function jsRuleOf(warn: string): string | undefined {
  if (warn.includes('含控制字符')) return 'control-chars';
  if (warn.includes('含花括号')) return 'braces';
  if (warn.includes('不是绝对路径')) return 'not-absolute';
  if (warn.includes('含 .. 段')) return 'dot-dot';
  if (warn.includes('文件系统根')) return 'filesystem-root';
  return undefined;
}

interface CaseRow {
  id: string;
  unset?: boolean;
  raw?: unknown;
  provided: boolean;
  rejected: boolean;
  rule?: string;
  dir: string | null;
  normalized: boolean;
}

const CASES: CaseRow[] = (JSON.parse(readFileSync(CASES_FILE, 'utf8')) as { cases: CaseRow[] }).cases;

/** 期望的生效目录（null ⇒ 各自的默认）。 */
function expectedTsDir(c: CaseRow): string {
  return c.dir === null ? DEFAULT_WEBSITE_PAGES_DIR : c.dir;
}

describe('取值表本身必须可信（否则下面所有比对都是空转）', () => {
  it('表非空，且 id 唯一', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it('🔴 每条拒绝规则都至少有一个"只可能被它拦住"的取值（逐层隔离）', () => {
    // 教训：`{env.HOME}/x` 会先被"不是绝对路径"拦下，于是删掉花括号规则也测不出来。
    // 所以每条规则都要有一个**绝对路径 + 无其它违规**的取值，只可能命中它自己。
    const byRule = new Map<string, string[]>();
    for (const c of CASES) {
      if (!c.rejected || !c.rule) continue;
      byRule.set(c.rule, [...(byRule.get(c.rule) ?? []), c.id]);
    }
    for (const rule of PAGES_DIR_REJECT_RULES) {
      expect(byRule.get(rule)?.length ?? 0).toBeGreaterThan(0);
    }
    // 表里不许出现"没人覆盖的规则名"（写错规则名会让上面那条悄悄放过）
    for (const rule of byRule.keys()) {
      expect(PAGES_DIR_REJECT_RULES).toContain(rule);
    }
  });

  it('⚠️ 每条拒绝取值都真的是"只可能被它拦住"（不是碰巧被前一条拦下）', () => {
    for (const c of CASES) {
      if (!c.rejected || !c.rule || typeof c.raw !== 'string') continue;
      const raw = c.raw as string;
      const hasControl = /[\u0000-\u001f\u007f]/.test(raw.trim());
      const hasBraces = raw.includes('{') || raw.includes('}');
      const absolute = raw.trim().startsWith('/');
      const hasDotDot = raw.trim().split('/').includes('..');
      // 声明的规则必须是**第一个**命中的（两侧实现的判定顺序一致）
      const order: Array<[string, boolean]> = [
        ['control-chars', hasControl],
        ['braces', hasBraces],
        ['not-absolute', !absolute],
        ['dot-dot', hasDotDot],
      ];
      const firstHit = order.find(([, hit]) => hit)?.[0];
      if (c.rule !== 'filesystem-root') {
        expect({ id: c.id, firstHit, declared: c.rule }).toEqual({
          id: c.id,
          firstHit: c.rule,
          declared: c.rule,
        });
      } else {
        // filesystem-root 是最后一条：前面几条都不该命中
        expect({ id: c.id, firstHit }).toEqual({ id: c.id, firstHit: undefined });
      }
    }
  });

  it('两侧的环境变量名是同一个（名字漂了，整条守卫就在比对空气）', () => {
    expect(loadJsResolver().envName).toBe(SERVE_HTML_PAGES_DIR_ENV);
  });
});

describe('TS 侧与 JS 侧对同一批取值的结论必须完全一致', () => {
  const js = loadJsResolver();

  it.each(CASES.map((c) => [c.id, c] as const))('%s：两侧一致且符合取值表', (_id, c) => {
    const raw = c.unset ? undefined : c.raw;
    const ts = resolveWebsitePagesDir(raw);
    const jsRes = js.resolvePagesDir(raw);

    // 1) provided：JS 侧没有这个字段，用"是否有 dir 或有 warn"等价推断 —— 但更可靠的
    //    判据是：未设置/空值时 JS 既不改写（dir=null）也**不产生任何 WARN**。
    if (!c.provided) {
      expect({ id: c.id, jsDir: jsRes.dir, jsWarns: jsRes.warns.length }).toEqual({
        id: c.id,
        jsDir: null,
        jsWarns: 0,
      });
      expect({ id: c.id, tsProvided: ts.provided, tsWarns: ts.warns.length }).toEqual({
        id: c.id,
        tsProvided: false,
        tsWarns: 0,
      });
    }

    // 2) rejected 必须一致
    const jsRejected = jsRes.dir === null && c.provided;
    expect({ id: c.id, ts: ts.rejected, js: jsRejected }).toEqual({
      id: c.id,
      ts: c.rejected,
      js: c.rejected,
    });

    // 3) 生效目录必须一致（按 null ⇔ DEFAULT 的映射）
    const jsEffective = jsRes.dir === null ? DEFAULT_WEBSITE_PAGES_DIR : jsRes.dir;
    expect({ id: c.id, ts: ts.dir, js: jsEffective, want: expectedTsDir(c) }).toEqual({
      id: c.id,
      ts: expectedTsDir(c),
      js: expectedTsDir(c),
      want: expectedTsDir(c),
    });

    // 4) 规范化结论必须一致：JS 用一条 warn 表达，TS 用 normalized 字段
    const jsNormalized = jsRes.warns.some((w) => w.includes('已规范化'));
    expect({ id: c.id, ts: ts.normalized, js: jsNormalized }).toEqual({
      id: c.id,
      ts: c.normalized,
      js: c.normalized,
    });

    // 5) 被拒时：两侧都必须给出**理由**，且规则一致
    if (c.rejected) {
      const rejectWarn = jsRes.warns.find((w) => w.includes('已被忽略'));
      expect(rejectWarn).toBeDefined();
      expect({ id: c.id, jsRule: jsRuleOf(rejectWarn as string), tsRule: ts.rule }).toEqual({
        id: c.id,
        jsRule: c.rule,
        tsRule: c.rule,
      });
      expect(ts.reason).toBeTruthy();
      // 🔴 拒绝的 WARN 必须点名后果，并且**不能**再说"服务端仍会写到你给的路径"
      //    —— 那句话在修复前成立，现在两侧都回落默认，留着会误导运维。
      const warnText = ts.warns.join('\n');
      expect(warnText).toContain('已被忽略');
      expect(warnText).toContain(DEFAULT_WEBSITE_PAGES_DIR);
      expect(warnText).not.toContain('仍会把哨兵');
    } else {
      expect(ts.rule).toBeUndefined();
      expect(jsRes.warns.some((w) => w.includes('已被忽略'))).toBe(false);
    }
  });
});

describe('尺子有效性反证（证明上面的比对真的有牙）', () => {
  it('把 JS 侧的一条规则删掉，比对必须失败（⇒ 不是恒真）', () => {
    const js = loadJsResolver();
    // 从**真源码**里删掉花括号规则，模拟"有人只改了 JS 侧"
    const mutated = js.source.replace(
      /if \(text\.includes\('\{'\) \|\| text\.includes\('\}'\)\) \{[\s\S]*?\n  \}\n/,
      '',
    );
    expect(mutated).not.toBe(js.source); // 变异真的发生了
    expect(mutated).not.toContain("text.includes('{')");
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'PAGES_DIR_ENV',
      `${sliceFunction(readFileSync(GENERATOR, 'utf8'), 'hasControlChars')}\n` +
        `function resolvePagesDir(raw) ${mutated.slice(mutated.indexOf('{'))}\n` +
        'return resolvePagesDir;',
    ) as (e: string) => (raw: unknown) => { dir: string | null; warns: string[] };
    const broken = factory(js.envName);

    const braceCase = CASES.find((c) => c.rule === 'braces') as CaseRow;
    expect(braceCase).toBeDefined();
    // 变异后 JS 侧会**接受** `/{env.HOME}/x`，而 TS 侧仍拒绝 ⇒ 两侧不一致
    const jsRes = broken(braceCase.raw);
    const tsRes = resolveWebsitePagesDir(braceCase.raw);
    expect(jsRes.dir).not.toBeNull();
    expect(tsRes.rejected).toBe(true);
    expect(jsRes.dir === null ? DEFAULT_WEBSITE_PAGES_DIR : jsRes.dir).not.toBe(tsRes.dir);
  });

  it('取值表里一条**故意写错**的期望，必须被上面的断言抓到', () => {
    const wrong: CaseRow = { ...CASES.find((c) => c.id === 'valid-plain')!, dir: '/not/what/it/is' };
    const ts = resolveWebsitePagesDir(wrong.raw);
    // 用与上面完全相同的判据（只是把期望换成错的），必须不相等
    expect(ts.dir === wrong.dir).toBe(false);
  });

  it('⚠️ 空表/全通过的陷阱：必须同时存在"接受"与"拒绝"两类取值', () => {
    expect(CASES.some((c) => c.rejected)).toBe(true);
    expect(CASES.some((c) => !c.rejected && c.provided)).toBe(true);
    expect(CASES.some((c) => !c.provided)).toBe(true);
    expect(CASES.some((c) => c.normalized)).toBe(true);
  });
});

/* ─────────────────── 端到端：切出来的函数确实是生成器在用的那个 ─────────────────── */

/** 在生成结果里找 `vanblog-serve-html` 子树下的所有 `vars.root`。 */
function serveHtmlRoots(node: unknown, out: string[] = [], inside = false): string[] {
  if (Array.isArray(node)) {
    for (const child of node) serveHtmlRoots(child, out, inside);
    return out;
  }
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    const nowInside = inside || n.group === 'vanblog-serve-html';
    if (n.handler === 'vars' && typeof n.root === 'string' && nowInside) out.push(n.root as string);
    for (const v of Object.values(n)) serveHtmlRoots(v, out, nowInside);
  }
  return out;
}

function runGenerator(value?: string): { roots: string[]; stderr: string; status: number } {
  const env = { ...process.env } as Record<string, string>;
  if (value === undefined) delete env[SERVE_HTML_PAGES_DIR_ENV];
  else env[SERVE_HTML_PAGES_DIR_ENV] = value;
  const r = spawnSync(process.execPath, [GENERATOR, TEMPLATE, 'permission', 'me@example.com'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) {
    throw new Error(`生成器退出码 ${r.status}：${(r.stderr || '').slice(0, 400)}`);
  }
  return { roots: serveHtmlRoots(JSON.parse(r.stdout)), stderr: r.stderr || '', status: r.status as number };
}

describe('端到端：真跑生成器，验证可观测后果（也证明切出来的函数不是死代码）', () => {
  it('未设置 ⇒ 沿用模板里的默认目录，且不打 WARN', () => {
    const out = runGenerator(undefined);
    expect(out.roots.length).toBeGreaterThan(0);
    for (const root of out.roots) expect(root).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    expect(out.stderr).not.toContain('已被忽略');
  });

  it('合法值 ⇒ 两个 server 的 root 都被改写成它', () => {
    const out = runGenerator('/srv/next/pages');
    expect(out.roots.length).toBeGreaterThan(0);
    for (const root of out.roots) expect(root).toBe('/srv/next/pages');
    expect(out.stderr).not.toContain('已被忽略');
    // 与 TS 侧结论一致
    expect(resolveWebsitePagesDir('/srv/next/pages').dir).toBe('/srv/next/pages');
  });

  it.each([
    ['相对路径', 'relative/pages'],
    ['花括号占位符', '/{env.HOME}/pages'],
    ['.. 段', '/a/../b'],
    ['文件系统根', '/'],
  ])('非法值（%s）⇒ 生成器回落默认目录 + stderr 大声 WARN，且与 TS 侧同样拒绝', (_label, value) => {
    const out = runGenerator(value);
    for (const root of out.roots) expect(root).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    expect(out.stderr).toContain('已被忽略');
    const ts = resolveWebsitePagesDir(value);
    expect(ts.rejected).toBe(true);
    expect(ts.dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('需要规范化的值 ⇒ 生成器写入的是**规范化后**的目录，与 TS 侧同一个字符串', () => {
    const out = runGenerator('/a//b/');
    for (const root of out.roots) expect(root).toBe('/a/b');
    expect(resolveWebsitePagesDir('/a//b/').dir).toBe('/a/b');
  });

  it('⚠️ 生成器**绝不会**因为一个垃圾值而整份配置失败（那会退回降级模板、HTTPS 静默变自签）', () => {
    for (const value of ['relative', '/', '{env.X}', '/a/../b', '   ']) {
      expect(runGenerator(value).status).toBe(0);
    }
  });
});

/* ─────────────────────── 漂移绊线：三处调用点都在用共用函数 ─────────────────────── */

describe('三处解析点必须都在调用共用函数（不是各自 env || DEFAULT）', () => {
  const SITES = [
    'packages/server/src/provider/caddy/caddy.provider.ts',
    'packages/server/src/utils/degradedServeHtml.ts',
    'packages/server/src/provider/isr/artifactReaper.ts',
  ] as const;

  it.each(SITES.map((s) => [s.split('/').pop() as string, s] as const))(
    '%s：调用 resolveWebsitePagesDir，且不再有裸 env || DEFAULT',
    (_label, rel) => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      // ⚠️ 必须剥注释：本文件的注释里就写着 `env || DEFAULT` 这个形状（解释为什么不能用它），
      //    不剥注释的话"不许出现"会假红、"必须出现"会假绿。
      const code = stripCommentsForAnchor(src);
      expect(code).toContain('resolveWebsitePagesDir(');
      expect(code).not.toMatch(/SERVE_HTML_PAGES_DIR_ENV\]\s*\|\|\s*DEFAULT_WEBSITE_PAGES_DIR/);
    },
  );

  it('⚠️ 反证：上面那把尺子量得到坏形状（否则 doesNotMatch 恒真）', () => {
    const bad = 'const dir = process.env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR;';
    expect(bad).toMatch(/SERVE_HTML_PAGES_DIR_ENV\]\s*\|\|\s*DEFAULT_WEBSITE_PAGES_DIR/);
    expect(stripCommentsForAnchor(`// 注释里提到 ${bad}\nconst ok = 1;`)).not.toContain('DEFAULT_WEBSITE_PAGES_DIR');
  });

  it('全仓库不再有第四处解析点（新增调用点必须走共用函数）', () => {
    // ⚠️ 扫的是**标识符** `SERVE_HTML_PAGES_DIR_ENV` 而不是它的值：值会出现在解释性注释里
    //    （本文件的注释就写着这个变量名），按值扫会把注释当成违规点 —— 那样守卫要么天天假红、
    //    要么被人放宽到失去意义。
    const { execSync } = require('child_process') as typeof import('child_process');
    const out: string = execSync(
      `grep -rn "SERVE_HTML_PAGES_DIR_ENV" packages/server/src --include=*.ts || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const nonSpec = out
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .filter((l) => !l.includes('.spec.ts'));

    // 1) 任何非 spec 文件都不许再有"裸回落"形状
    const bare = nonSpec.filter((l) =>
      /SERVE_HTML_PAGES_DIR_ENV\]\s*\|\|\s*DEFAULT_WEBSITE_PAGES_DIR/.test(l),
    );
    expect(bare).toEqual([]);

    // 2) 允许**读**这个变量的文件集合是精确的三处（多一处 = 有人新写了一份解析口径）
    const files = [...new Set(nonSpec.map((l) => l.split(':')[0]))].sort();
    expect(files).toEqual(
      [
        'packages/server/src/provider/caddy/caddy.provider.ts',
        'packages/server/src/provider/isr/artifactReaper.ts',
        'packages/server/src/utils/degradedServeHtml.ts',
      ].sort(),
    );

    // 3) 而这三处**每一处**都必须把读到的值喂给共用函数（不许读了不用/自己解析）
    for (const rel of files) {
      const code = stripCommentsForAnchor(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
      expect({ rel, feeds: code.includes('resolveWebsitePagesDir(') }).toEqual({ rel, feeds: true });
    }
  });

  it('⚠️ 反证：上面第 1 条与第 2 条尺子都量得到坏形状', () => {
    const badLine =
      'packages/server/src/x.ts:10:  const d = process.env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR;';
    expect([badLine].filter((l) => /SERVE_HTML_PAGES_DIR_ENV\]\s*\|\|\s*DEFAULT_WEBSITE_PAGES_DIR/.test(l))).toEqual([
      badLine,
    ]);
    const newSite = 'packages/server/src/newthing.ts:3:import { SERVE_HTML_PAGES_DIR_ENV } from "./x";';
    expect(newSite.includes('.spec.ts')).toBe(false); // 不会被 spec 过滤掉 ⇒ 会进入文件集合比对
  });
});

describe('行为兼容性：未设置与合法值时的结果与修复前逐字节相同', () => {
  it('未设置 ⇒ 默认常量（三处调用点看到的都是它）', () => {
    const r = resolveWebsitePagesDir(undefined);
    expect(r.dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
    expect(r.provided).toBe(false);
    expect(r.rejected).toBe(false);
    expect(r.warns).toEqual([]);
  });

  it('🔴 合法自定义值必须**原样生效**（reaper 靠这条：回落默认会删错目录）', () => {
    const r = resolveWebsitePagesDir('/srv/custom/pages');
    expect(r.dir).toBe('/srv/custom/pages');
    expect(r.rejected).toBe(false);
    expect(r.dir).not.toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('非字符串（数字/对象/数组）一律当未设置，绝不 toString 后拿去用', () => {
    for (const raw of [123, 0, {}, [], true, Symbol.iterator]) {
      const r = resolveWebsitePagesDir(raw);
      expect(r.dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
      expect(r.provided).toBe(false);
    }
  });
});
