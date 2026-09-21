import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from '../test-utils/anchorCode';

/**
 * 🔴 **调用方枚举守卫**：`MarkdownProvider.renderMarkdown()` 是"原始 HTML 直通"的（markdown-it 的
 * `html: true`，且这一层**刻意不消毒** —— 见 `provider/markdown/markdownRenderProperties.spec.ts`
 * 里那条"渲染器层仍然直通"的用例），所以**每一个把它的结果发出去的出口都必须自己消毒**。
 *
 * 这条守卫补的正是那个失败方向：如果只在 RSS 出口接了消毒，那么**将来新增一个对外出口**
 * （例如新的导出接口、邮件、Webhook、某种 API）忘了消毒，就会**静默**把未消毒的正文发出去。
 * 有了它，新增的调用点会立刻红，逼作者有意识地决定"这里要不要消毒"。
 *
 * ⚠️ 这是本仓库处理同类问题的既有模式：`pathPermissionMap`/`publicRoutes`（权限）、
 * `queryFilterDrift` 的白名单（写 filter）—— 都是"默认要求 + 显式白名单 + 白名单防腐"。
 *
 * ## 判据
 * 扫 `packages/server/src/**` 的全部**非 spec** 文件，找出每一个 `.renderMarkdown(` 调用点，
 * 断言它**要么**落在某个 `sanitizeRenderedHtml(…)` 的实参范围内（= 被消毒），
 * **要么**出现在下面的显式白名单里且写明理由。
 *
 * ⚠️ 用 `.renderMarkdown(` 而不是 `renderMarkdown(`：后者会匹配到 `markdown.provider.ts` 里的
 * **方法定义**（那不是调用点），也会匹配到 spec 里的替身属性名。
 */

/**
 * 显式白名单：**不需要**消毒的 `renderMarkdown` 调用点。
 *
 * ⚠️ 每条都必须写明理由，而且 🔴 **指向已不存在的 `文件:锚点` 会让守卫红**（防腐机制，
 * 仿 `queryFilterDrift` 与后台分页守卫的做法）—— 否则代码移动之后例外会悄悄跟着漂移，
 * 最终变成"白名单里全是死条目，而真正的调用点没人管"。
 *
 * 目前**为空**：唯一的两个产品调用点都在 RSS 出口，都已消毒。
 * ⚠️ 如果将来要加条目，理由必须属于这几类之一：
 *   ① 结果**不对外**（只写日志、只进内部索引、只用于比较）；
 *   ② 结果随后经过**另一道**消毒/转义（要指明是哪一道）；
 *   ③ 结果是**纯文本**上下文（例如已经被剥掉标记）。
 * 🔴 "调用方是管理员" **不是**合法理由：本项目的威胁模型里协作者也算不可信作者
 *   （canonical 白名单的文件头就是这么写的），而管理员本来就能用 customScript 注入任意 JS。
 */
const UNWRAPPED_ALLOWLIST: Array<{ file: string; anchor: string; why: string }> = [];

const SERVER_SRC = path.join(__dirname, '..');

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      listSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 从 `open` 位置的左括号开始，按**括号配平**取出实参文本（含嵌套的模板串与箭头函数）。 */
function balancedArgs(src: string, openParen: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  let escaped = false;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    // ⚠️ 模板串里的 `${…}` 需要按括号继续配平，这里简化处理：反引号内部整体跳过，
    //    因为实参里的模板串不含未配对的圆括号（本仓库的调用形状如此，有反证盯着）。
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return null;
}

/** 找出所有 `name(` 的左括号位置（在**剥掉注释**的文本上找，避免注释里的字样被当成调用）。 */
function findCallParens(code: string, name: string): number[] {
  const out: number[] = [];
  const needle = name + '(';
  let from = 0;
  for (;;) {
    const i = code.indexOf(needle, from);
    if (i < 0) break;
    out.push(i + needle.length - 1);
    from = i + needle.length;
  }
  return out;
}

type CallSite = { file: string; line: number; wrapped: boolean; wrappedArg?: string };

function collectCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of listSourceFiles(SERVER_SRC)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const code = stripCommentsForAnchor(raw);
    // 先标出所有"被消毒"的区间
    const sanitizedSpans: Array<[number, number, string]> = [];
    for (const p of findCallParens(code, 'sanitizeRenderedHtml')) {
      const args = balancedArgs(code, p);
      if (args === null) continue;
      sanitizedSpans.push([p, p + args.length + 2, args]);
    }
    for (const p of findCallParens(code, '.renderMarkdown')) {
      const hit = sanitizedSpans.find(([s, e]) => p > s && p < e);
      const line = code.slice(0, p).split('\n').length;
      sites.push({
        file: path.relative(SERVER_SRC, file),
        line,
        wrapped: !!hit,
        wrappedArg: hit ? hit[2] : undefined,
      });
    }
  }
  return sites;
}

describe('renderMarkdown 的每个调用点都必须消毒，或在白名单里写明理由', () => {
  const sites = collectCallSites();

  it('尺子有效性：真的扫到了文件与调用点（否则"全部合规"在 0 个调用点时恒真）', () => {
    expect(listSourceFiles(SERVER_SRC).length).toBeGreaterThan(100);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    // RSS 那两处必须在场（这是本守卫存在的理由）
    const rss = sites.filter((s) => s.file.includes('rss.provider.ts'));
    expect(rss.length).toBe(2);
    expect(rss.every((s) => s.wrapped)).toBe(true);
  });

  it('🔴 每个调用点要么被 sanitizeRenderedHtml 包着，要么在白名单里（带理由）', () => {
    const offenders = sites.filter((s) => !s.wrapped).map((s) => `${s.file}:${s.line}`);
    const allowed = UNWRAPPED_ALLOWLIST.map((a) => a.file);
    const unexplained = offenders.filter((o) => !allowed.some((f) => o.startsWith(f.split(':')[0])));
    expect({ offenders, unexplained }).toEqual({ offenders: [], unexplained: [] });
  });

  it('🔴 白名单防腐：每条白名单都必须指向仍然存在的文件与锚点', () => {
    for (const entry of UNWRAPPED_ALLOWLIST) {
      const [rel, ...rest] = entry.file.split(':');
      const full = path.join(SERVER_SRC, rel);
      expect({ entry: rel, exists: fs.existsSync(full) }).toEqual({ entry: rel, exists: true });
      if (rest.length) {
        const anchor = rest.join(':');
        const src = stripCommentsForAnchor(fs.readFileSync(full, 'utf-8'));
        expect({ anchor, found: src.includes(anchor) }).toEqual({ anchor, found: true });
      }
      // 理由必须是真的理由，不是占位符
      expect(entry.why.length).toBeGreaterThan(12);
    }
  });

  it('🔴 消毒的范围只覆盖正文，没有把 RSS 外壳（样式表 link）一起吞进去', () => {
    // 实测依据：`<link rel="stylesheet">` 不在白名单里，整段消毒会把三份样式表摘掉，
    // RSS 里的公式与代码高亮就会全部失去样式。所以外壳必须留在消毒范围之外。
    for (const s of sites.filter((x) => x.wrapped)) {
      expect({ site: `${s.file}:${s.line}`, hasLink: /rel="stylesheet"|rel=\\"stylesheet\\"/.test(s.wrappedArg || '') }).toEqual(
        { site: `${s.file}:${s.line}`, hasLink: false },
      );
      expect((s.wrappedArg || '')).not.toContain('markdown-body rss');
    }
    // 反证：外壳确实还在源码里（不是"因为整个外壳被删了所以没被吞进去"）
    const rssRaw = fs.readFileSync(path.join(SERVER_SRC, 'provider/rss/rss.provider.ts'), 'utf-8');
    const rss = stripCommentsForAnchor(rssRaw);
    expect(rss).toContain('markdown-body rss');
    // ⚠️ 必须在**剥掉注释**的文本上数：源文件的注释里为了说明这件事，本身就写了一遍
    //    那个 link 的字面量，直接数原始文本会得到 4 而不是 3（第一版就是这么红的）。
    //    👉 这正是本仓库反复踩的那一族：**注释会喂饱计数/存在性断言**，
    //    只不过这次是"多算"而不是"少算"，方向相反但根因相同。
    expect(rss.match(/rel="stylesheet"/g)?.length).toBe(3);
    // ⚠️ 刻意**不**断言"原始文本里有几处"：那会把注释的措辞钉死（改一句注释就红），
    //    是过度指定。剥离器本身有效性的反证在下面"注释里的调用不算调用点"那条里。
    expect(rssRaw.length).toBeGreaterThan(rss.length);
  });

  it('⚠️ mermaid 的 replace 在消毒**之前**（顺序被钉住，"顺手调整顺序"会红）', () => {
    // 依据：replace 匹配的是 markdown-it 自己产出的那个 div 开标签；消毒要经过解析+序列化，
    // 序列化后的属性写法理论上可能变（例如不带引号）⇒ 先消毒再 replace 有静默失配的风险。
    // 实测两种顺序当前输出相同，但钉住现有顺序可以避免将来"输出悄悄变了"。
    const bodySite = sites.find((s) => s.file.includes('rss.provider.ts') && s.wrapped && /article\.content/.test(s.wrappedArg || ''));
    expect(bodySite).toBeTruthy();
    expect(bodySite!.wrappedArg).toContain('.replace(');
    expect(bodySite!.wrappedArg).toContain('class="mermaid"');
  });

  it('两个出口都被覆盖：content（正文）与 description（摘要）各自消毒', () => {
    const rss = fs.readFileSync(
      path.join(SERVER_SRC, 'provider/rss/rss.provider.ts'),
      'utf-8',
    );
    const code = stripCommentsForAnchor(rss);
    // ⚠️ 摘要也必须消毒：很多阅读器只显示 description，漏掉它等于留了半个口子
    expect(code.match(/sanitizeRenderedHtml\(/g)?.length).toBe(2);
    expect(code).toMatch(/description:\s*sanitizeRenderedHtml\(/);
  });

  it('尺子有效性反证：那把"是否被包住"的尺子分得清包住与没包住', () => {
    const synthetic = [
      'const a = sanitizeRenderedHtml(this.md.renderMarkdown(x));',
      'const b = this.md.renderMarkdown(y);',
      'const c = sanitizeRenderedHtml(f(g), h); // 里面没有 renderMarkdown',
    ].join('\n');
    const spans: Array<[number, number]> = [];
    for (const p of findCallParens(synthetic, 'sanitizeRenderedHtml')) {
      const args = balancedArgs(synthetic, p);
      if (args !== null) spans.push([p, p + args.length + 2]);
    }
    const calls = findCallParens(synthetic, '.renderMarkdown');
    expect(calls.length).toBe(2);
    const wrapped = calls.filter((p) => spans.some(([s, e]) => p > s && p < e));
    expect(wrapped.length).toBe(1);
    // ⚠️ 反证的反证：如果尺子恒判"包住"，上面那条就会是 2；如果恒判"没包住"，就会是 0
    expect(wrapped.length).not.toBe(calls.length);
    expect(wrapped.length).not.toBe(0);
  });

  it('尺子有效性反证：注释里的调用不算调用点', () => {
    const synthetic = [
      '// 这里写着 sanitizeRenderedHtml(this.md.renderMarkdown(x)) 但它是注释',
      'const b = this.md.renderMarkdown(y);',
    ].join('\n');
    const code = stripCommentsForAnchor(synthetic);
    expect(findCallParens(code, '.renderMarkdown').length).toBe(1);
    // 反证：未剥注释时会数到 2（证明剥离器真的在工作，而不是"本来就只有一个"）
    expect(findCallParens(synthetic, '.renderMarkdown').length).toBe(2);
  });

  it('括号配平的尺子在嵌套形状上不出错（箭头函数 / 模板串 / 多行实参）', () => {
    const src = 'sanitizeRenderedHtml(\n  this.mp\n    .renderMarkdown(c)\n    .replace(/x/g, `a(b)`),\n  (err) => log(err),\n)';
    const p = findCallParens(src, 'sanitizeRenderedHtml')[0];
    const args = balancedArgs(src, p);
    expect(args).not.toBeNull();
    expect(args).toContain('.renderMarkdown(c)');
    // 模板串里的圆括号不许提前结束配平
    expect(args).toContain('log(err)');
  });
});
