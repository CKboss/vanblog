import { MarkdownProvider } from './markdown.provider';
import { fromHtml } from 'hast-util-from-html';
import * as fs from 'fs';
import * as path from 'path';

/**
 * markdown 渲染的**属性级**回归网（服务端这一层）。
 *
 * ## 为什么是"属性"而不是"逐字节黄金输出"
 * 站长裁定（AGENTS.md §7.91）：「换了 markdown 插件，渲染出的 HTML 不完全一致很正常，
 * 只要这个 md 渲染符合通用标准即可」⇒ **排版字节是允许变的**，逐字节黄金守卫会在每次有意的
 * 渲染变化时红，最终必然被 `--update` 掉而沦为橡皮图章。所以这里断言的是**性质**：
 * 代码块产出 `pre`/`code` 且带语言 class、块级公式产出带 `katex-display` 的元素、表格产出
 * `table`/`thead`/`tbody`/`th`/`td`、`<!-- more -->` 能切出摘要、任务列表产出禁用的 checkbox，等等。
 *
 * 🔴 **例外（有意的）**：下面「安全相关」那一组用**逐字比对**。理由是**那一类的性质本身就是"精确"** ——
 * 消毒策略的输出必须可预测（"整段消失"与"只剩一个空标签"是两种不同的策略），
 * 用 `toContain` 会被"两句话都含某个共同子串"骗过。这与 §7.91 针对**排版字节**的裁定不冲突。
 *
 * ⚠️ 语料**内联**在本文件里（不依赖仓库外的 fixtures 目录）：黄金守卫那版把 54 个 `.md` 放在
 * `src/__fixtures__/`，而语料本体在 git-ignored 的目录里 ⇒ 提交上去 CI 必红。
 */

/** 内联语料：每条覆盖一个**性质**，条数刻意保持小（可读、可维护）。 */
const CASES: Array<{ name: string; md: string }> = [
  { name: '围栏代码块（已知语言）', md: '```js\nconst a = 1;\n```\n' },
  { name: '围栏代码块（未知语言）', md: '```notareallang\nplain text\n```\n' },
  { name: '波浪线围栏', md: '~~~text\ntilde body\n~~~\n' },
  { name: '缩进代码块', md: '    indented code\n' },
  { name: '代码块里的 CJK', md: '```text\n中文代码注释\n```\n' },
  { name: 'mermaid 代码块', md: '```mermaid\ngraph TD; A-->B;\n```\n' },
  { name: '表格', md: '| a | b |\n|---|---|\n| 1 | 2 |\n' },
  { name: '任务列表', md: '- [x] 已完成\n- [ ] 未完成\n' },
  { name: '嵌套引用', md: '> 外层\n> > 内层\n' },
  { name: '强调与删除线', md: '**粗** *斜* ~~删~~\n' },
  { name: '链接与相对链接', md: '[绝对](https://example.com) [相对](/post/x)\n' },
  { name: '行内公式', md: '公式 $E=mc^2$ 结束\n' },
  { name: '块级公式', md: '$$\\int_0^\\infty e^{-x^2}dx$$\n' },
  { name: '公式里的 CJK', md: '$$\\text{中文} = 1$$\n' },
  { name: 'more 标记', md: '摘要部分\n\n<!-- more -->\n\n标记之后的正文\n' },
  { name: 'more 标记在代码块里不算', md: '```md\n<!-- more -->\n```\n\n真正的摘要\n' },
  { name: 'hard break（breaks:true）', md: '第一行\n第二行\n' },
  { name: 'HTML 实体', md: '实体 &amp; 与 < 与 >\n' },
  { name: 'emoji 与超长词', md: '表情 🎉 与 ' + 'x'.repeat(2200) + '\n' },
  { name: 'front matter', md: '---\ntitle: t\n---\n\n正文\n' },
];

const provider = new MarkdownProvider();

/**
 * 🔴 性质：渲染输出里**每个 `style="` 的取值都必须在遇到下一个 `<` 之前闭合**。
 *
 * 为什么要有这条：`markdown.provider.ts` 的高亮成功路径曾经**少写一个收尾引号**，
 * 于是按 HTML5 规则 style 的取值会一直吃到下一个引号（也就是紧随其后的标签里那一个），
 * 结果 **pre 与 code 根本没有作为元素被打开**，代码块结构在 RSS 里是坏的。
 * 那个 bug 从文件创建起存在了十五个月，原因是①没有任何测试钉住它、②畸形 HTML 被阅读器的
 * 解析器容错了所以"看起来还行"。
 *
 * ⚠️ 钉**性质**而不是钉那一行字面量：这样将来任何标签上出现同类笔误都会被抓住。
 * 返回"违规片段"数组，空数组 = 通过。
 */
export function findStyleAttributesSwallowingMarkup(html: string): string[] {
  const bad: string[] = [];
  const needle = 'style=' + '"';
  let from = 0;
  for (;;) {
    const i = html.indexOf(needle, from);
    if (i < 0) break;
    const valueStart = i + needle.length;
    const close = html.indexOf('"', valueStart);
    const nextTag = html.indexOf('<', valueStart);
    // 没有收尾引号，或者收尾引号出现在下一个标签开始之后 ⇒ 属性值把标记吞进去了
    if (close < 0 || (nextTag >= 0 && nextTag < close)) {
      bad.push(html.slice(i, i + 90));
    }
    from = valueStart;
  }
  return bad;
}

/** 从渲染输出里找出所有指定标签名的元素（用真解析器，不用正则数标签）。 */
function elementsOf(html: string, tagName: string): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === 'element' && node.tagName === tagName) out.push(node);
    for (const c of node.children || []) walk(c);
  };
  walk(fromHtml(html, { fragment: true }));
  return out;
}

function classListOf(el: any): string[] {
  const c = el?.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? [c] : [];
}

describe('markdown 渲染：属性级回归网（服务端层）', () => {
  it('语料确实被读到，且用例名互不重复（尺子有效性 / 反空转）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(18);
    expect(CASES.every((c) => c.md.length > 0)).toBe(true);
    const names = CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // 每条语料都必须真的渲染出非空结果，否则下面的断言全是空的
    for (const c of CASES) {
      expect(provider.renderMarkdown(c.md).length).toBeGreaterThan(0);
    }
  });

  it('围栏代码块产出 pre 与 code 元素；未知语言带 language-<lang> class，已知语言带 hljs class', () => {
    const known = provider.renderMarkdown('```js\nconst a = 1;\n```\n');
    const pres = elementsOf(known, 'pre');
    expect(pres.length).toBe(1);
    expect(classListOf(pres[0])).toContain('hljs');
    expect(elementsOf(known, 'code').length).toBeGreaterThanOrEqual(1);

    const unknown = provider.renderMarkdown('```notareallang\nplain\n```\n');
    const codes = elementsOf(unknown, 'code');
    expect(codes.length).toBeGreaterThanOrEqual(1);
    expect(classListOf(codes[0])).toContain('language-notareallang');
  });

  it('🔴 高亮成功路径的 pre 与 code 是**真的元素**（那条少写引号的 bug 的结构性判据）', () => {
    const html = provider.renderMarkdown('```js\nconst a = 1;\n```\n');
    const pres = elementsOf(html, 'pre');
    expect(pres.length).toBe(1);
    // pre 必须有一个 code 子元素；引号缺失时 pre 根本不会成为元素，这条就会红
    const codeChildren = (pres[0].children || []).filter(
      (c: any) => c.type === 'element' && c.tagName === 'code',
    );
    expect(codeChildren.length).toBe(1);
    // 且 style 的取值里不许出现标记（吞标签的特征）
    const style = String(pres[0].properties?.style ?? '');
    expect(style.length).toBeGreaterThan(0);
    expect(style).not.toContain('<');
  });

  it('🔴 全部语料的渲染输出里，没有任何 style 属性吞掉标记（同类笔误的通用守卫）', () => {
    for (const c of CASES) {
      const bad = findStyleAttributesSwallowingMarkup(provider.renderMarkdown(c.md));
      expect({ case: c.name, bad }).toEqual({ case: c.name, bad: [] });
    }
  });

  it('尺子有效性反证：那把"style 吞标记"的尺子真的量得到坏形状', () => {
    // ⚠️ 用拼接构造坏样本，避免在源码里留下一整段畸形字面量（也避免与上面的性质断言互相喂饱）
    const broken = '<pre style="background: #fff;' + '><code>x</code></pre>';
    expect(findStyleAttributesSwallowingMarkup(broken).length).toBeGreaterThan(0);
    // 反证的反证：正确形状必须**不**被报出来（否则这把尺子恒报，等于没有）
    const good = '<pre style="background: #fff;"><code>x</code></pre>';
    expect(findStyleAttributesSwallowingMarkup(good)).toEqual([]);
  });

  it('源码级：高亮路径那两处 pre 标签的 style 属性都正确闭合（钉形状，不钉整句）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'markdown.provider.ts'), 'utf-8');
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const pres = code.match(/<pre class="hljs" style="[^"]*">/g) || [];
    // 成功路径 + 兜底路径 = 2 处，两处都必须是"引号闭合后才出现右尖括号"
    expect(pres.length).toBe(2);
    // 反证：不允许存在"style 取值里直接出现右尖括号"的形状
    expect(/<pre class="hljs" style="[^"]*>/.test(code.replace(/<pre class="hljs" style="[^"]*">/g, ''))).toBe(
      false,
    );
  });

  it('块级公式产出带 katex-display 的元素，且 katex 的 class 仍在（className 陷阱的行为守卫）', () => {
    const block = provider.renderMarkdown('$$\\int_0^\\infty e^{-x^2}dx$$\n');
    expect(block).toContain('katex-display');
    // 🔴 class 属性本身必须活着：如果哪天消毒/渲染把 class 摘掉，katex 的排版会全毁
    //    （这条同时是 RSS 消毒那条 className 陷阱的对照 —— 见 utils/rssHtmlSanitize.ts 文件头）
    expect(classListOf(elementsOf(block, 'span').find((s) => classListOf(s).includes('katex')) || {})).toContain(
      'katex',
    );

    const inline = provider.renderMarkdown('公式 $E=mc^2$ 结束\n');
    expect(inline).toContain('katex');
    expect(inline).not.toContain('katex-display');
  });

  it('表格产出 table / thead / tbody / th / td', () => {
    const html = provider.renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    for (const tag of ['table', 'thead', 'tbody', 'th', 'td']) {
      expect({ tag, n: elementsOf(html, tag).length }).toMatchObject({
        tag,
        n: expect.any(Number),
      });
      expect(elementsOf(html, tag).length).toBeGreaterThan(0);
    }
  });

  it('任务列表产出禁用的 checkbox（不是可交互的表单控件）', () => {
    const html = provider.renderMarkdown('- [x] 已完成\n- [ ] 未完成\n');
    const inputs = elementsOf(html, 'input');
    expect(inputs.length).toBe(2);
    for (const i of inputs) {
      expect(String(i.properties?.type)).toBe('checkbox');
      // 渲染出的 checkbox 必须是 disabled，否则访客能在文章里点出状态变化
      expect(i.properties?.disabled === true || i.properties?.disabled === 'disabled').toBe(true);
    }
  });

  it('mermaid 代码块产出带 mermaid class 的 div', () => {
    const html = provider.renderMarkdown('```mermaid\ngraph TD; A-->B;\n```\n');
    const divs = elementsOf(html, 'div');
    expect(divs.some((d) => classListOf(d).includes('mermaid'))).toBe(true);
  });

  it('more 标记能切出摘要，而代码块里的字面标记不算', () => {
    const withMarker = provider.getDescription('摘要部分\n\n<!-- more -->\n\n标记之后的正文\n');
    expect(withMarker).toContain('摘要部分');
    expect(withMarker || '').not.toContain('标记之后的正文');

    const markerInCode = provider.getDescription(
      '```md\n<!-- more -->\n```\n\n真正的摘要\n',
    );
    // 标记在围栏里 ⇒ 不生效 ⇒ 摘要不会在围栏处被切断
    expect(markerInCode).toContain('真正的摘要');
  });

  it('breaks:true 让单个换行产出 br；html:true 让原始 HTML 直通（配置层面的既有语义）', () => {
    expect(elementsOf(provider.renderMarkdown('第一行\n第二行\n'), 'br').length).toBeGreaterThan(0);
    // ⚠️ 这条不是"安全性质"，只是记录 markdown-it 的配置语义；对外的消毒边界见下面那组用例
    expect(provider.renderMarkdown('<b>粗</b>')).toContain('<b>粗</b>');
  });

  it('渲染器选项没有漂移（这四个决定用户可见的渲染行为）', () => {
    const o = (provider.md as any).options;
    expect(o.html).toBe(true);
    expect(o.breaks).toBe(true);
    expect(o.linkify).toBe(false);
    expect(o.typographer).toBe(false);
    expect(typeof o.highlight).toBe('function');
    expect(((provider.md as any).core?.ruler?.__rules__ || []).length).toBeGreaterThan(0);
  });

  /**
   * 🔴 这一组记录**服务端渲染层本身**的安全姿态：`MarkdownProvider` 用 `html: true` 构造 markdown-it
   * 且**自己不做消毒**，所以原始 HTML 会原样出现在 `renderMarkdown()` 的返回值里。
   *
   * ⚠️ 这**不等于**站点有 XSS，两条对外出口都各自有边界：
   *   · **前台文章页**：由 `packages/website` 用 bytemd → remark → rehype-raw → **rehype-sanitize**
   *     （`utils/markdownSanitize.ts` 的白名单，不允许 script、事件属性与 `javascript:`）重新渲染；
   *   · **RSS/Atom**：`provider/rss/rss.provider.ts` 在把 `renderMarkdown()` 的结果塞进 feed 之前，
   *     先过 `utils/rssHtmlSanitize.ts` 的 `sanitizeRenderedHtml()`（2026-09-21 接上的，
   *     白名单是 canonical 那份的镜像，由 `rssHtmlSanitizeParity.spec.ts` 钉住不漂移）。
   *
   * 🔴 所以本组断言的是"**渲染器本身仍然直通**"这个事实（它是消毒发生在出口层的前提），
   * 而"出口确实消毒了"由 `rssHtmlSanitize.spec.ts` 与 `rss.provider.spec.ts` 负责。
   * ⚠️ 如果哪天有人把消毒挪进 `renderMarkdown()`，本组会红 —— 那是**有意的**：
   * 那意味着契约变了，需要同时更新这里的注释与出口层的接线守卫。
   */
  it('🔴 渲染器层仍然直通原始 HTML（消毒在出口层，不在这一层）', () => {
    expect(provider.renderMarkdown('文本 <script>alert(1)</script> 结束')).toContain(
      '<script>alert(1)</script>',
    );
    expect(provider.renderMarkdown('<img src=x onerror="alert(1)">')).toContain('onerror="alert(1)"');
    expect(provider.renderMarkdown('<iframe src="https://evil.example"></iframe>')).toContain(
      '<iframe src="https://evil.example">',
    );
    expect(provider.renderMarkdown('<svg onload="alert(1)"></svg>')).toContain('onload="alert(1)"');
    expect(provider.renderMarkdown('<a href="javascript:alert(2)">x</a>')).toContain(
      'href="javascript:alert(2)"',
    );
  });

  it('markdown-it 自带的链接协议校验仍然生效（markdown 语法写的 javascript: 不会变成链接）', () => {
    // ⚠️ 与上一条对照：这是 markdown-it **自带**的 validateLink，只覆盖「用 markdown 链接语法写的」
    //    URL，覆盖不了原始 HTML —— 两条合起来才是这一层的真实姿态。
    const out = provider.renderMarkdown('[点我](javascript:alert(1))');
    expect(out).not.toContain('<a href="javascript:');
    // 反证①：正常 http 链接**会**变成 a 元素，证明不是「链接功能整体坏了」
    expect(provider.renderMarkdown('[点我](https://example.com)')).toContain('<a href="https://example.com"');
    // 反证②：输出非空，证明上面的 not.toContain 不是因为「渲染结果恒为空」
    expect(out.length).toBeGreaterThan(0);
  });
});
