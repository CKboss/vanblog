import { MarkdownProvider } from '../provider/markdown/markdown.provider';
import {
  applyRssMarkdownSchema,
  buildRssSanitizeSchema,
  rssBaseSchema,
  sanitizeRenderedHtml,
  RSS_EXTRA_TAG_NAMES,
  RSS_FORBIDDEN_TAG_NAMES,
  RSS_STYLE_ALLOWED_TAG_NAMES,
  RSS_URL_VALUED_ATTRIBUTE_NAMES,
} from './rssHtmlSanitize';
import { fromHtml } from 'hast-util-from-html';

/**
 * RSS 消毒的**行为级**守卫。
 *
 * 🔴 这一组的期望值全部是**实测出来的**（2026-09-21，用真的 `MarkdownProvider` + 真的
 * `hast-util-from-html/sanitize/to-html` 跑出来的输出），不是按库文档推的。
 *
 * 🔴 **为什么这里用逐字比对（`toBe`）而不是 `toContain`**：站长裁定（§7.91）说"排版字节允许变"，
 * 但**安全策略的输出必须精确** —— "整段连内容一起消失"与"只剩一个空标签"是两种不同的策略，
 * 而 `toContain` 会被"两边都含某个共同子串"骗过（例如断言不含 script 时，`<scriptx>` 也能骗过
 * `not.toContain('<script>')`）。所以：**排版性质用属性断言（见 markdownRenderProperties.spec.ts），
 * 安全策略用逐字断言（本文件）**。
 *
 * ## 白名单的依据（不是猜的）
 * 对本机 dev 库里 **53 篇未删除的真实文章**逐篇扫描（⚠️ 必须先排除软删除：库里有 59 篇，
 * 其中 6 篇是历轮遗留的【临时】探针且 `deleted: true`，把它们算进来会得出"真实文章用了
 * iframe/script/details/kbd"这种**错误**结论 —— 那些标签只存在于探针里）：
 *   · 含原始 HTML 的文章：**7 / 53** 篇
 *   · 标签 × 次数：`font` 64、`br` 27、`h1` 5、`o` 1（Word 粘贴残留）、`img` 1
 *   · 属性 × 次数：`style` 64（CSS 属性**只有 `color`**）、`id` 5、`height` 1、`src` 1
 *   · `src` 取值：1 个，本站相对路径 `/static/img/….image.webp`
 *   · 危险构造：`expression(` / `behavior:` / `-moz-binding` / `javascript:` / `onerror` /
 *     `onclick` / `onload` / script 元素 **全部 0 次**；`iframe` **真实文章里 0 个**
 * ⇒ 所以下面「真实用法零破坏」那一组是**照这张表**逐条钉的，而不是随手挑几个标签。
 */

const mp = new MarkdownProvider();

/** 渲染 + 消毒，一条链走完（与 RSS 出口的调用形状一致）。 */
const renderThenSanitize = (md: string) => sanitizeRenderedHtml(mp.renderMarkdown(md));

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

function anyElementWithClass(html: string, cls: string): boolean {
  const out: boolean[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === 'element') {
      const c = node.properties?.className;
      const list = Array.isArray(c) ? c.map(String) : typeof c === 'string' ? [c] : [];
      if (list.includes(cls)) out.push(true);
    }
    for (const ch of node.children || []) walk(ch);
  };
  walk(fromHtml(html, { fragment: true }));
  return out.length > 0;
}

/** 把渲染输出里所有**文本节点**拼起来（即"访客看到的文字"，不含任何标记）。 */
function textOf(html: string): string {
  let out = '';
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === 'text') out += String(node.value ?? '');
    for (const c of node.children || []) walk(c);
  };
  walk(fromHtml(html, { fragment: true }));
  return out;
}

describe('RSS 消毒：危险构造必须被摘掉（逐字比对，安全策略的输出必须精确）', () => {
  it('script 元素整段消失（strip：连内容一起删，不是只删标签）', () => {
    const out = sanitizeRenderedHtml('<script>alert(1)</script>');
    expect(out).toBe('');
    // ⚠️ 关键：脚本体也不许留下（如果只是 drop 标签、保留子节点，alert(1) 会变成可见文本）
    expect(out).not.toContain('alert(1)');
    expect(elementsOf(out, 'script').length).toBe(0);
  });

  it('style 元素整段消失，且它的 CSS 文本不会变成可见文字', () => {
    const out = sanitizeRenderedHtml('<style>body{display:none}</style>');
    expect(out).toBe('');
    // 🔴 这正是 canonical 把 style 放进 strip 而不是"不在白名单里"的理由：
    //    rehype-sanitize 对白名单外的标签是**保留子节点**的，于是 CSS 文本会被当成正文渲染出来。
    expect(out).not.toContain('display:none');
  });

  it('javascript: 的 href 被摘掉、链接文字保留（逐字）', () => {
    expect(sanitizeRenderedHtml('<p><a href="javascript:alert(2)">裸 a</a></p>')).toBe(
      '<p><a>裸 a</a></p>',
    );
  });

  it('事件属性被摘掉：img 的 onerror、div 的 onmouseover、svg 的 onload（逐字）', () => {
    expect(sanitizeRenderedHtml('<img src=x onerror="alert(3)">')).toBe('<img src="x">');
    expect(sanitizeRenderedHtml('<div onmouseover="alert(2)">悬停</div>')).toBe('<div>悬停</div>');
    const svg = sanitizeRenderedHtml('<svg onload="alert(1)"><circle r="10"/></svg>');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('alert(1)');
    expect(elementsOf(svg, 'svg').length).toBe(0);
  });

  it('iframe 的 data: src 被摘掉，而 https 的 src 与展示属性完整保留（逐字）', () => {
    // 拦的是 data:text/html 这种"在文章里内嵌任意第三方文档"的钓鱼/挂马形状
    expect(
      sanitizeRenderedHtml('<iframe src="data:text/html;base64,PHNjcmlwdD4="></iframe>'),
    ).toBe('<iframe></iframe>');
    // ⚠️ 但合法的视频嵌入（B 站 / YouTube / 腾讯视频）必须原样保留，否则弄坏既有文章
    expect(
      sanitizeRenderedHtml('<iframe src="https://ok.example" width="10" height="10"></iframe>'),
    ).toBe('<iframe src="https://ok.example" width="10" height="10"></iframe>');
  });

  it('a 上的内联 style 被摘掉（点击劫持的最短路径），href 保留（逐字）', () => {
    expect(sanitizeRenderedHtml('<a style="position:fixed;inset:0" href="/x">链接</a>')).toBe(
      '<a href="/x">链接</a>',
    );
  });

  it('markdown 语法写的 javascript: 链接本来就不会变成 a（markdown-it 自带的 validateLink）', () => {
    const md = '[点我](javascript:alert(1))';
    const raw = mp.renderMarkdown(md);
    expect(raw).not.toContain('<a href="javascript:');
    // 消毒前后都不该出现 javascript: 的 href
    expect(sanitizeRenderedHtml(raw)).not.toContain('javascript:alert(1)"');
  });

  it('尺子有效性反证：消毒器确实在跑，而不是"输入本来就干净"', () => {
    const dirty = '<script>alert(1)</script><p>正文</p>';
    // ①未消毒的原文里 script 确实在（证明输入是脏的）
    expect(dirty).toContain('alert(1)');
    // ②消毒后 script 没了、但正文还在（证明是消毒器干的，不是"整段被丢掉"）
    const out = sanitizeRenderedHtml(dirty);
    expect(out).not.toContain('alert(1)');
    expect(out).toBe('<p>正文</p>');
  });
});

describe('RSS 消毒：真实内容零破坏（照 53 篇文章的实测统计表逐条钉）', () => {
  it('真实用法 font[style=color] 逐字节不变（真实文章里 64 处，是最大宗的原始 HTML 用法）', () => {
    const rendered = mp.renderMarkdown('<font style="color:red">红字</font>');
    expect(sanitizeRenderedHtml(rendered)).toBe(rendered);
    expect(sanitizeRenderedHtml('<p><font style="color:red">红字</font></p>')).toBe(
      '<p><font style="color:red">红字</font></p>',
    );
  });

  it('真实用法 br / h1[id] / img[src,height,alt] 逐字节不变', () => {
    expect(sanitizeRenderedHtml('a<br>b')).toBe('a<br>b');
    expect(sanitizeRenderedHtml('<h1 id="x">标题</h1>')).toBe('<h1 id="x">标题</h1>');
    expect(sanitizeRenderedHtml('<img src="/static/img/a.webp" height="10" alt="z">')).toBe(
      '<img src="/static/img/a.webp" height="10" alt="z">',
    );
  });

  it('本站相对路径的 img src 保留（真实文章里那唯一一个 src 就是相对路径）', () => {
    const out = sanitizeRenderedHtml('<img src="/static/img/d4b309fa.image.webp">');
    expect(out).toContain('src="/static/img/d4b309fa.image.webp"');
  });

  it('data: 的内联图片仍然放行（protocols.src 里有 data，这是 canonical 的既有行为）', () => {
    const out = sanitizeRenderedHtml(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="inline">',
    );
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="');
  });

  it('白名单外的排版包裹标签被摘掉但**文字保留**（真实文章里那 1 处 Word 残留 o:p）', () => {
    // ⚠️ 这是一条**如实记录的行为变化**：`<o:p>` 不在白名单里，元素被 drop、子节点（文字）保留。
    //    对真实内容的影响是"少一层无意义的包裹"，文字与排版都不受影响。
    expect(sanitizeRenderedHtml('<o:p>段落</o:p>')).toBe('段落');
  });

  it('markdown 自身产出的常规结构不被破坏（表格 / 列表 / 引用 / 强调）', () => {
    const table = renderThenSanitize('| a | b |\n|---|---|\n| 1 | 2 |\n');
    for (const tag of ['table', 'thead', 'tbody', 'th', 'td']) {
      expect({ tag, n: elementsOf(table, tag).length }).toEqual({ tag, n: expect.any(Number) });
      expect(elementsOf(table, tag).length).toBeGreaterThan(0);
    }
    const list = renderThenSanitize('- 甲\n- 乙\n');
    expect(elementsOf(list, 'li').length).toBe(2);
    const quote = renderThenSanitize('> 引用\n');
    expect(elementsOf(quote, 'blockquote').length).toBe(1);
    const em = renderThenSanitize('**粗** *斜* ~~删~~\n');
    expect(elementsOf(em, 'strong').length).toBe(1);
    expect(elementsOf(em, 'em').length).toBe(1);
  });

  it('任务列表的 checkbox 保留且仍是禁用的（消毒没有把它变成可交互控件）', () => {
    const out = renderThenSanitize('- [x] 已完成\n- [ ] 未完成\n');
    const inputs = elementsOf(out, 'input');
    expect(inputs.length).toBe(2);
    for (const i of inputs) {
      expect(String(i.properties?.type)).toBe('checkbox');
      expect(i.properties?.disabled === true || i.properties?.disabled === 'disabled').toBe(true);
    }
  });
});

describe('RSS 消毒：className 陷阱 —— katex 与代码高亮的 class 必须活下来', () => {
  /**
   * 🔴 这组是"className 陷阱"的**行为守卫**（父代理明确要求钉行为、不要钉库内部的基底形状，
   * 因为后者会随依赖升级假红）。
   * 陷阱本身：`hast-util-sanitize` 的 `defaultSchema` 比 bytemd 传给 canonical 的基底
   * **少一个 `attributes['*']` 里的 `className`**（逐键比对：顶层 7 个键逐个相同、
   * `tagNames` 都是 61 个、1712 vs 1700 字节，唯一差异就是它）。
   * 少了它 ⇒ RSS 里所有 class 被摘掉 ⇒ katex 排版、代码高亮、`<div class="markdown-body rss">` 全毁。
   */
  it('基底 schema 确实补上了 className（缺了它下面两条会红，但原因很难查，所以单独钉一条）', () => {
    const base = rssBaseSchema();
    expect(base.attributes['*']).toContain('className');
    // 反证：原始 defaultSchema 里**没有**它 —— 证明这一步不是空转
    const { defaultSchema } = jest.requireActual('hast-util-sanitize');
    expect(defaultSchema.attributes['*']).not.toContain('className');
  });

  it('行内公式：katex 的 class 与 katex-html 结构在消毒后仍然存在', () => {
    const out = renderThenSanitize('公式 $E=mc^2$ 结束');
    expect(anyElementWithClass(out, 'katex')).toBe(true);
    expect(anyElementWithClass(out, 'katex-html')).toBe(true);
    expect(out).toContain('E=mc');
  });

  it('块级公式：katex-display 与 katex-block 的 class 在消毒后仍然存在', () => {
    const out = renderThenSanitize('$$\\int_0^\\infty e^{-x^2}dx$$\n');
    expect(anyElementWithClass(out, 'katex-display')).toBe(true);
    expect(out).toContain('katex-block');
  });

  it('代码高亮：pre 的 hljs class、style、以及 hljs-* 的 span class 全部保留（本例逐字节不变）', () => {
    const md = '```js\nconst a = 1;\n```';
    const raw = mp.renderMarkdown(md);
    const out = sanitizeRenderedHtml(raw);
    expect(out).toBe(raw);
    expect(anyElementWithClass(out, 'hljs')).toBe(true);
    expect(out).toContain('hljs-keyword');
    // 🔴 顺带钉住那个"少写收尾引号"的 bug 没有回来：pre 必须是**真的元素**
    const pres = elementsOf(out, 'pre');
    expect(pres.length).toBe(1);
    expect(String(pres[0].properties?.style)).not.toContain('<');
  });

  it('🔴 katex 的 MathML 现在**保留**（2026-09-21 修好了，原"已知局限"那条断言按设计变红并被替换）', () => {
    // ⚠️ 这条原来是"如实钉住现状：MathML 被 drop、读屏器支持会丢"，并且**它自己的注释就写着**
    //    "将来谁修了它，这条会红，逼他有意识地更新这里与文档" ⇒ 它按设计变红了，这里是**有意识地更新**。
    // 🔴 旧行为比"丢读屏支持"更糟：`.katex-mathml` **没有** aria-hidden（只有 `.katex-html` 有），
    //    读屏器读的正是它，而 drop 之后子节点塌成**乱码重复文本**（实测 `E=mc2E=mc^2`）。
    const out = renderThenSanitize('公式 $E=mc^2$ 结束');
    expect(anyElementWithClass(out, 'katex-mathml')).toBe(true);
    // ① MathML 元素活着，而且结构完整（math → semantics → mrow → mi/mo/msup）
    const maths = elementsOf(out, 'math');
    expect(maths.length).toBe(1);
    expect(elementsOf(out, 'semantics').length).toBe(1);
    expect(elementsOf(out, 'mi').length).toBeGreaterThan(0);
    expect(elementsOf(out, 'msup').length).toBe(1);
    // ② LaTeX 源仍在 annotation 里（读屏器/复制公式都靠它），且 encoding 是 katex 那一个
    const ann = elementsOf(out, 'annotation');
    expect(ann.length).toBe(1);
    expect(ann[0].properties?.encoding).toBe('application/x-tex');
    // ③ 命名空间 URI 原样保留（被定值正则钉住，换成别的命名空间会被整条摘掉，见下面走私那组）
    expect(maths[0].properties?.xmlns).toBe('http://www.w3.org/1998/Math/MathML');
    // ④ 🔴 视觉副本也还在（两份都在，说明不是"用 MathML 换掉了视觉渲染"）
    expect(anyElementWithClass(out, 'katex-html')).toBe(true);
    expect(out).toContain('aria-hidden="true"');
    // ⑤ 🔴 **不再是乱码重复文本**：旧行为下 katex-mathml 里是 `E=mc2E=mc^2`（摊平文本 + LaTeX 源拼接）。
    //    现在 katex-mathml 内部是**元素**而不是那串裸文本 ⇒ 断言"那串乱码不在输出里"。
    expect(out).not.toContain('E=mc2E=mc^2');
  });

  it('🔴 块级公式与含表格/颜色的公式：MathML 同样保留，且 katex 的排版属性一个都没被误杀', () => {
    // ⚠️ 这组是"定值正则没有过紧"的证据：这些属性都是 katex 真实产出的，
    //    实测 18 个属性里 16 个存活，只有刻意排除的两个颜色属性没活（见下一条）。
    const block = renderThenSanitize('$$\\int_{0}^{\\infty} e^{-x^2}dx=\\frac{\\sqrt{\\pi}}{2}$$');
    expect(elementsOf(block, 'math').length).toBe(1);
    expect(elementsOf(block, 'msubsup').length).toBe(1);
    expect(elementsOf(block, 'mfrac').length).toBe(1);
    expect(elementsOf(block, 'msqrt').length).toBe(1);
    expect(block).toContain('display="block"');

    const cases = renderThenSanitize('$$\\begin{cases} x+y=3 \\\\ x-y=1 \\end{cases}$$');
    expect(elementsOf(cases, 'mtable').length).toBe(1);
    expect(elementsOf(cases, 'mtr').length).toBe(2);
    expect(elementsOf(cases, 'mstyle').length).toBeGreaterThan(0);
    // mtable 的三个排版属性都是"列表值"，正则必须接受空格分隔
    expect(cases).toContain('rowspacing=');
    expect(cases).toContain('columnalign=');
    expect(cases).toContain('columnspacing=');
    expect(cases).toContain('scriptlevel=');

    const smash = renderThenSanitize('$\\smash{x}$ 与 $\\sqrt[3]{8}$');
    expect(elementsOf(smash, 'math').length).toBe(2);
    expect(elementsOf(smash, 'mpadded').length).toBeGreaterThan(0);
    expect(elementsOf(smash, 'mroot').length).toBe(1);
  });

  it('🔴 刻意排除的两个颜色属性确实没放行，而**视觉**颜色仍然在（零视觉损失的证据）', () => {
    const out = renderThenSanitize('$\\textcolor{red}{x}$ 与 $\\colorbox{yellow}{y}$');
    // MathML 那份不带颜色（mathcolor / mathbackground 接受颜色值，属于可以塞 url(...) 的属性族）
    expect(out).not.toContain('mathcolor');
    expect(out).not.toContain('mathbackground');
    // 🔴 但 katex 的**视觉**副本用内联 style 表达颜色，而 span 上的 style 是放行的 ⇒ 看起来仍然是红的
    expect(anyElementWithClass(out, 'katex-html')).toBe(true);
    expect(out).toMatch(/style="[^"]*color:\s*red/);
    // ⚠️ 所以排除颜色属性的代价是"读屏器那份不带颜色"，而颜色对读屏器本来没有意义 ⇒ 零视觉损失。
  });

  it('🔴 MathML 白名单**没有**顺带放行 mXSS 的经典载体', () => {
    const s = buildRssSanitizeSchema();
    // annotation-xml（encoding=text/html 时内部按 HTML 解析）、mglyph / malignmark（mtext+table+mglyph 利用链）
    for (const bad of ['annotation-xml', 'mglyph', 'malignmark', 'maction', 'svg']) {
      expect(s.tagNames).not.toContain(bad);
    }
    // 实测后果：这些元素被 drop，而它们内部的危险构造也一起消失
    const out = sanitizeRenderedHtml(
      '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
    );
    expect(out).not.toContain('annotation-xml');
    expect(out).not.toContain('text/html');
    expect(out).not.toMatch(/onerror/i);
    const glyph = sanitizeRenderedHtml('<math><mtext><table><mglyph src="x"></mglyph></table></mtext></math>');
    expect(glyph).not.toContain('mglyph');
  });

  it('🔴 属性**值**走私全部被定值正则挡住（含命名空间混淆，这是 MathML 特有的风险）', () => {
    const cases: Array<[string, string, RegExp]> = [
      // 命名空间混淆：把 math 的命名空间换成 XHTML
      ['xmlns 换成 XHTML', '<math xmlns="http://www.w3.org/1999/xhtml"><mtext>x</mtext></math>', /1999\/xhtml/],
      // annotation 的 encoding 换成会让内部按 HTML 解析的值
      ['encoding=text/html', '<math><annotation encoding="text/html">x</annotation></math>', /text\/html/],
      // 长度属性里塞 CSS 函数
      ['width 塞 expression', '<math><mpadded width="expression(alert(1))"><mi>x</mi></mpadded></math>', /expression\(/i],
      ['fence 塞 url(javascript:)', '<math><mo fence="url(javascript:alert(1))">x</mo></math>', /javascript:/i],
      // 属性值里塞引号与标记（试图逃出属性）
      ['mathvariant 塞引号', '<math><mi mathvariant=\'a" onmouseover="alert(1)\'>x</mi></math>', /onmouseover/i],
    ];
    for (const [name, html, forbidden] of cases) {
      const out = sanitizeRenderedHtml(html);
      // 🔴 双向：既断言"走私的值没活下来"，也断言"元素本身还在"（否则"整段被丢掉"也能让上一条恒真）
      expect({ name, out }).toEqual({ name, out: expect.not.stringMatching(forbidden) });
      expect(out).toContain('<math');
    }
  });

  it('🔴 **作者手写的** MathML 走的是同一份白名单（不存在"katex 专用通道"可以绕过）', () => {
    // ⚠️ 这条钉住的是方案选择的核心前提：本轮**没有**用"抽走 katex 子树再放回"那种依赖信任的方案，
    //    因为作者可以伪造 class="katex-mathml"（markdown-it 是 html:true，原始 HTML 原样透传，
    //    而 class 在白名单里）⇒ 实测伪造的 span 会被保留。既然伪造挡不住，就只能让
    //    "katex 产出的"与"作者手写的"走**完全相同**的白名单，谁都拿不到额外信任。
    const forged = renderThenSanitize(
      '正文 <span class="katex-mathml"><math><mrow><mi>x</mi></mrow></math></span> 结束',
    );
    expect(forged).toContain('katex-mathml'); // 伪造的 class 确实保留（这是既有行为，不是本轮引入）
    // 但作者借这个通道**得不到任何额外能力**：危险构造照样被摘
    const forgedBad = renderThenSanitize(
      '<span class="katex-mathml"><math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math></span>',
    );
    expect(forgedBad).not.toContain('annotation-xml');
    expect(forgedBad).not.toMatch(/onerror/i);
    // 事件属性在 MathML 元素上同样被摘（withoutEventHandlers 对所有属性键生效）
    expect(sanitizeRenderedHtml('<math onload="alert(1)"><mi>x</mi></math>')).not.toMatch(/onload/i);
    // href 在 MathML 上**根本没有放行**（MathML 的 href 是经典向量）
    const hrefOut = sanitizeRenderedHtml('<math><mrow href="javascript:alert(1)"><mi>x</mi></mrow></math>');
    expect(hrefOut).not.toContain('javascript:');
    expect(hrefOut).not.toContain('href');
  });

  it('⚠️ 如实钉住：annotation 的内容按**标记**解析，嵌套元素会迁移到它外面（已知且无害）', () => {
    // 实测行为：`<annotation>` 在 HTML 解析里不是原始文本容器，里面写的元素会被当标记解析；
    // 序列化后该元素**迁移到 annotation 外面**成为兄弟节点。
    // ⚠️ 这条本身无害（迁出去的仍受同一份白名单约束，且 katex 只往 annotation 里放已转义的 LaTeX 文本），
    // 但"知道并钉住"与"没想到"是两件事 —— 将来若有人依赖"annotation 里都是纯文本"，这条会提醒他。
    const out = sanitizeRenderedHtml(
      '<math><annotation encoding="application/x-tex">a &lt; b <b>粗</b></annotation></math>',
    );
    expect(out).toContain('<annotation');
    expect(out).toContain('<b>粗</b>');
    // 迁移的证据：b 在 annotation **之后**（成为兄弟），而不是在它内部
    expect(out.indexOf('</annotation>')).toBeLessThan(out.indexOf('<b>'));
  });

  it('⚠️ 已知局限（继承自 canonical）：div 上的 position:fixed 遮罩与 style 里的 url() 拦不住', () => {
    expect(sanitizeRenderedHtml('<div style="position:fixed;inset:0;z-index:9999">罩</div>')).toBe(
      '<div style="position:fixed;inset:0;z-index:9999">罩</div>',
    );
    expect(sanitizeRenderedHtml('<div style="background:url(javascript:alert(1))">x</div>')).toBe(
      '<div style="background:url(javascript:alert(1))">x</div>',
    );
    // ⚠️ 要拦这些只能过滤 style 的**值**（拒 position:fixed|sticky、拒 z-index 超阈值、拒 url(...)），
    //    而那会误伤正常排版 —— canonical 的注释里明写了这条取舍，这里**继承**，不试图修。
    //    注意 a/input/button 上的 style 已经被摘掉了（见上面那组），所以最短的点击劫持路径是堵住的。
  });
});

describe('RSS 消毒：代码块里的字面 HTML 必须仍然是文本（消毒器最常见的 bug）', () => {
  it('围栏代码块里演示用的 script 字面量不会被吃掉、也不会变成元素', () => {
    const md = '```html\n<script>alert("cb")</script>\n```';
    const raw = mp.renderMarkdown(md);
    const out = sanitizeRenderedHtml(raw);
    // ①不许出现真的 script 元素
    expect(elementsOf(out, 'script').length).toBe(0);
    // ②但演示用的**文字**必须还在。
    //    ⚠️ 不能断言"输出里含 `&lt;script` 或 `&#x3C;script` 这样的连续字面量"——
    //    highlight.js 会把它拆成 `&#x3C;` + `<span class="hljs-name">script</span>`，
    //    中间隔着标记，所以连续字面量根本不存在（第一版就是这么写红的）。
    //    正确的判据是**把所有文本节点拼起来**看访客实际看到的文字。
    const text = textOf(out);
    expect(text).toContain('script');
    expect(text).toContain('alert(');
    // 且转义确实发生了（不是把原文当成 HTML 放过去）
    expect(/(&lt;|&#x3C;)/.test(out)).toBe(true);
    // ③反证：这段代码块**不是**因为"整段被丢掉"才没有 script 元素
    expect(elementsOf(out, 'pre').length).toBe(1);
    expect(elementsOf(out, 'code').length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeGreaterThan(100);
    // ④🔴 对照：同样这段内容如果**不经代码块**、直接当原始 HTML 写，就会被整段 strip 掉
    //    （证明"文本保留"是因为它在代码块里，而不是因为消毒器放水）
    expect(sanitizeRenderedHtml('<script>alert("cb")</script>')).toBe('');
  });

  it('行内代码里的字面 HTML 同样保留为文本', () => {
    const out = renderThenSanitize('用 `<img src=x onerror=alert(1)>` 演示\n');
    expect(elementsOf(out, 'img').length).toBe(0);
    expect(elementsOf(out, 'code').length).toBe(1);
    expect(out).toContain('onerror=alert(1)');
  });
});

describe('RSS 消毒：对既有内容的实际影响（53 篇真实文章实测后的归类，逐类钉住）', () => {
  /**
   * 实测（2026-09-21，本机 dev 库 53 篇未删除文章，只读）：
   *   · 逐字相同 **4** 篇，有变化 **49** 篇；正文总字节 189,017 → 178,477（**−5.58%**）
   *   · 含 script 元素的：raw **0** 篇、消毒后 **0** 篇（真实内容本来就没有）
   * 变化**全部**落在下面四类，**没有一类丢失正文内容**：
   *   ① HTML 注释被删（`<!-- more -->` 恰好 13 字节 ⇒ 这解释了大多数文章"恰好 −13"）；
   *   ② 实体重新编码（`&amp;`→`&#x26;`、`&lt;`→`&#x3C;`、`&gt;`→`>`）—— 同一个字符的合法转义；
   *   ③ 属性引号规范化（`src=x`→`src="x"`、`src='x'`→`src="x"`）—— 语义相同、而且更规范；
   *   ④ katex 的 MathML 元素被 drop（见上面"已知局限"那条）—— 这是大额差异的来源
   *      （一篇公式密集的文章 −6344 字节）。
   * ⚠️ 所以"49 篇有变化"**不是**"49 篇被弄坏"：①②③ 解析后完全等价，④ 是已登记的读屏器局限。
   */
  it('① HTML 注释被删（含 <!-- more --> 摘要标记，它恰好 13 字节）', () => {
    const md = '摘要\n\n<!-- more -->\n\n正文';
    const raw = mp.renderMarkdown(md);
    const clean = sanitizeRenderedHtml(raw);
    expect(raw.length - clean.length).toBe(13);
    expect(clean).not.toContain('more');
    // 🔴 正文一个字都没少
    expect(clean).toContain('摘要');
    expect(clean).toContain('正文');
    expect(sanitizeRenderedHtml('<p>文本 <!-- 注释 --> 更多</p>')).toBe('<p>文本  更多</p>');
  });

  it('② 实体被重新编码，但解析后是同一个字符（不是内容变化）', () => {
    const clean = sanitizeRenderedHtml('<p>&amp; &lt; &gt;</p>');
    expect(clean).toContain('&#x26;');
    expect(clean).toContain('&#x3C;');
    // 反证：解析回来的**文本**与原来一致
    expect(textOf(clean)).toBe(textOf('<p>&amp; &lt; &gt;</p>'));
  });

  it('③ 属性引号被规范化（无引号/单引号 → 双引号），语义不变', () => {
    expect(sanitizeRenderedHtml('<img src=x>')).toBe('<img src="x">');
    expect(sanitizeRenderedHtml("<img src='x'>")).toBe('<img src="x">');
  });

  it('④ 大写标签被规范化；块级元素嵌在 p 里时按 HTML5 规则重排（既有行为，不是消毒引入的）', () => {
    const clean = sanitizeRenderedHtml('<p><BR><DIV>x</DIV></p>');
    expect(clean).toContain('<br>');
    expect(clean).toContain('<div>x</div>');
    expect(clean).not.toContain('<BR>');
    // ⚠️ HTML5 解析器遇到 p 里的块级元素会先闭合 p，这是**解析器**的行为，
    //    任何"解析 → 序列化"的消毒器都一样；markdown-it 自己不会产出这种嵌套，
    //    只有作者手写原始 HTML 才可能出现。文字 x 没有丢。
    expect(textOf(clean)).toContain('x');
  });

  it('🔴 综合反证：一段同时含四类形状的真实感正文，消毒后所有可见文字都还在', () => {
    const md = [
      '# 标题',
      '',
      '摘要部分 <!-- more --> 之后是正文，含 & 与 < 与 > 字符。',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '公式 $E=mc^2$ 与 <font style="color:red">红字</font>、<br>换行、',
      '<img src="/static/img/a.webp" height="10" alt="图">',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    const raw = mp.renderMarkdown(md);
    const clean = sanitizeRenderedHtml(raw);
    // 可见文字一个不少（逐段核对）
    for (const expectText of ['标题', '摘要部分', '之后是正文', '红字', 'const', 'E=mc']) {
      expect({ expectText, present: textOf(clean).includes(expectText) }).toEqual({
        expectText,
        present: true,
      });
    }
    // 结构元素都还在
    for (const tag of ['h1', 'pre', 'code', 'table', 'img', 'font', 'br']) {
      expect({ tag, n: elementsOf(clean, tag).length }).not.toEqual({ tag, n: 0 });
    }
    // 且 comment 确实没了
    expect(clean).not.toContain('<!--');
    // 反证：raw 里确实有那个注释（证明"没了"是消毒的结果，不是输入本来就没有）
    expect(raw).toContain('<!-- more -->');
  });
});

describe('RSS 消毒：失败方向、幂等与 schema 形状', () => {
  it('空串与非字符串输入都返回空串（失败方向是"少发"，绝不把未消毒的原文返回）', () => {
    expect(sanitizeRenderedHtml('')).toBe('');
    expect(sanitizeRenderedHtml(undefined as any)).toBe('');
    expect(sanitizeRenderedHtml(null as any)).toBe('');
    expect(sanitizeRenderedHtml(123 as any)).toBe('');
    // 🔴 失败方向的判据：返回值绝不是输入本身（除非输入本来就是空串）
    const dirty: any = '<script>alert(1)</script>';
    expect(sanitizeRenderedHtml(dirty)).not.toBe(dirty);
  });

  it('幂等：消毒两次与一次结果相同（RSS 会被反复重建，不能越洗越短）', () => {
    for (const html of [
      '<p><font style="color:red">红字</font></p>',
      '<p><a href="javascript:x">t</a></p>',
      '<img src=x onerror="alert(1)">',
      '<iframe src="https://ok.example"></iframe>',
    ]) {
      const once = sanitizeRenderedHtml(html);
      expect(sanitizeRenderedHtml(once)).toBe(once);
    }
  });

  it('幂等：真实渲染结果消毒两次不变（含公式与代码块）', () => {
    for (const md of ['公式 $E=mc^2$ 结束', '```js\nconst a = 1;\n```', '<font style="color:red">红</font>']) {
      const once = renderThenSanitize(md);
      expect(sanitizeRenderedHtml(once)).toBe(once);
    }
  });

  it('schema 形状：禁掉的标签进了 strip，额外标签进了 tagNames，且 script/style 不在 tagNames 里', () => {
    const s = buildRssSanitizeSchema();
    expect([...RSS_FORBIDDEN_TAG_NAMES]).toEqual(['script', 'style']);
    for (const t of RSS_FORBIDDEN_TAG_NAMES) {
      expect(s.strip).toContain(t);
      expect(s.tagNames).not.toContain(t);
    }
    for (const t of RSS_EXTRA_TAG_NAMES) {
      expect(s.tagNames).toContain(t);
    }
    expect(s.tagNames).toContain('button');
    expect(s.clobberPrefix).toBe('');
  });

  it('🔴 src 与 style 都**不是**全局属性（按标签发放），且 a/input/button 上没有 style', () => {
    const s = buildRssSanitizeSchema();
    const star = (s.attributes['*'] || []).map((e: any) => (Array.isArray(e) ? e[0] : e));
    expect(star).not.toContain('src');
    expect(star).not.toContain('style');
    for (const tag of ['a', 'input', 'button']) {
      const names = (s.attributes[tag] || []).map((e: any) => (Array.isArray(e) ? e[0] : e));
      // ⚠️ 断言的是"这个标签的属性表里没有 style"，并且带上 tag 名让失败信息可读
      expect({ tag, hasStyle: names.includes('style') }).toEqual({ tag, hasStyle: false });
    }
    // style 发放给排版标签（49 个里的抽样）
    for (const tag of ['p', 'div', 'pre', 'code', 'font', 'table']) {
      const names = (s.attributes[tag] || []).map((e: any) => (Array.isArray(e) ? e[0] : e));
      expect(names).toContain('style');
    }
    expect(RSS_STYLE_ALLOWED_TAG_NAMES.length).toBe(49);
  });

  it('🔴 防御性收口真的在工作（双向对照：基底里塞进 src/style，变换后必须被摘掉）', () => {
    // ⚠️ 为什么需要这条：实测 `hast-util-sanitize@4.1.0` 的 `defaultSchema.attributes['*']`
    //    有 **72** 项，而里面**既没有 `src` 也没有 `style`**（也没有 `href`）⇒ 那道
    //    "从全局属性里摘掉 src/style"的过滤**在当前基底上是空操作**。
    //    于是"删掉这道过滤"这个变异**不会产生任何可观测效果**（变异对照 M10 因此 NOT_RED）。
    //    这是本仓库记过的三种 0 红成因里的第三种：变异生效了、断言也覆盖着，
    //    但**当前状态下无可观测效果** ⇒ 必须用**双向对照**把守卫变成非空转：
    //    喂一份"确实带着 src/style"的基底，证明这道过滤真的会摘掉它们。
    //    （canonical 的注释也写明它是**防御性**的：即使调用方传进来的基底带着，也不会漏给所有标签。）
    const baseWithLeaks = () => {
      const b = rssBaseSchema();
      b.attributes['*'].push('src', 'style');
      return b;
    };
    // ① 反证：不经变换时，它们确实在全局属性里
    const leaked = baseWithLeaks();
    expect(leaked.attributes['*']).toContain('src');
    expect(leaked.attributes['*']).toContain('style');
    // ② 经过变换后必须都被摘掉
    const fixed = applyRssMarkdownSchema(baseWithLeaks());
    expect(fixed.attributes['*']).not.toContain('src');
    expect(fixed.attributes['*']).not.toContain('style');
    // ③ 而且 className 这类合法的全局属性不受牵连
    expect(fixed.attributes['*']).toContain('className');
  });

  it('🔴 每个被放行的 URL 类属性都有非空协议白名单（空表 = 放行一切，含 javascript:）', () => {
    const s = buildRssSanitizeSchema();
    const allowed = new Set<string>();
    for (const key of Object.keys(s.attributes)) {
      for (const entry of s.attributes[key] || []) {
        const n = Array.isArray(entry) ? entry[0] : entry;
        if (typeof n === 'string') allowed.add(n);
      }
    }
    const missing: string[] = [];
    for (const attr of RSS_URL_VALUED_ATTRIBUTE_NAMES) {
      if (!allowed.has(attr)) continue;
      const list = s.protocols?.[attr];
      // ⚠️ 判据是 Array.isArray 且 length > 0：空数组与"没有这个键"在库的 safeProtocol() 里
      //    是同一件事（都等于放行一切协议）。空数组 = "没有洞"的错觉，比没有键更危险。
      if (!Array.isArray(list) || list.length === 0) missing.push(attr);
    }
    expect(missing).toEqual([]);
    // 反证：protocols.src 确实含 data（放行 data: 图片）与 http/https
    expect(s.protocols.src).toEqual(expect.arrayContaining(['data', 'http', 'https']));
  });

  it('事件属性一个都不放行（on* 全表扫描，而不是只抽查 onerror）', () => {
    const s = buildRssSanitizeSchema();
    const offenders: string[] = [];
    for (const key of Object.keys(s.attributes)) {
      for (const entry of s.attributes[key] || []) {
        const n = Array.isArray(entry) ? entry[0] : entry;
        if (typeof n === 'string' && /^on[a-z]{3,}$/i.test(n)) offenders.push(`${key}:${n}`);
      }
    }
    expect(offenders).toEqual([]);
    // 反证：`open`（details 的属性）只有 4 个字符，不该被这条正则误伤
    expect(/^on[a-z]{3,}$/i.test('open')).toBe(false);
  });

  it('每次调用返回**新的** schema 对象（就地修改的实现不能共享单例，否则第二次调用会看到脏状态）', () => {
    const a = buildRssSanitizeSchema();
    const b = buildRssSanitizeSchema();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    // 反证：改 a 不会影响 b（证明真的是深拷贝基底）
    a.tagNames.push('__probe__');
    expect(b.tagNames).not.toContain('__probe__');
    expect(rssBaseSchema().tagNames).not.toContain('__probe__');
  });
});
