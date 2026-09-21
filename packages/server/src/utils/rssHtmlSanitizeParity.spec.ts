import { fromHtml } from 'hast-util-from-html';
import { sanitize } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';

/**
 * canonical（前台白名单）的**类型形状**：只声明本文件用到的那部分。
 *
 * 🔴 **为什么用 `jest.requireActual` 而不是 `import`**（这是一条踩过的坑，别改回 import）：
 * server 的 `tsconfig.json` 里有 `"composite": true`，而 composite **隐含 rootDir = 该 tsconfig 所在目录**
 * ⇒ 静态 import `../../../website/utils/markdownSanitize` 会让 CI 口径的 tsc 直接报
 * **TS6059（不在 rootDir 下）+ TS6307（不在项目文件清单里）**，本仓库"三个 tsc 口径 0 错"的基线就红了。
 * ⚠️ 而 `tsconfig.build.json` 不会报，因为它把所有 spec 文件都 `exclude` 掉了 —— 也就是说这个错**只在 CI 口径暴露**，
 * 本地只跑 jest 是看不见的（jest 用 ts-jest 逐文件转译，不做项目级的 rootDir 检查）。
 * ⇒ 用字符串形式的 `requireActual`：TS 不会把它当模块解析（所以不报 6059/6307），
 * 而 jest 仍然会在运行时解析并转译那个 TS 文件（**实测可行**：canonical 那个文件没有任何 import，
 * 且 jest 的 `rootDir: "src"` 只影响**用例发现**、不影响模块解析）。
 * 🔴 生产代码**绝对不能**用这条路（rootDir 被注释掉 ⇒ 产物布局会从 `dist/src/` 变成
 * `dist/packages/server/src/`，多处硬依赖前者；且 Dockerfile 的 server 阶段只 COPY `./packages/server`）
 * ⇒ 所以生产代码用镜像，**只有测试**这样跨包取值。
 * ⚠️ 既有先例是反方向的：`packages/website/__tests__/articleExcerptParity.spec.ts` 静态 import
 * `../../server/src/utils/articleExcerpt`（website 侧的 tsconfig 不是 composite，所以那边不报）。
 */
interface SiteSanitizeModule {
  sanitizeMarkdownSchema: (schema: any) => any;
  MARKDOWN_EXTRA_TAG_NAMES: readonly string[];
  MARKDOWN_FORBIDDEN_TAG_NAMES: readonly string[];
  MARKDOWN_STYLE_ALLOWED_TAG_NAMES: readonly string[];
  URL_VALUED_ATTRIBUTE_NAMES: readonly string[];
  findUrlAttributesMissingProtocols: (schema: any) => string[];
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const site: SiteSanitizeModule = jest.requireActual('../../../website/utils/markdownSanitize');
const siteTransform = site.sanitizeMarkdownSchema;
const MARKDOWN_EXTRA_TAG_NAMES = site.MARKDOWN_EXTRA_TAG_NAMES;
const MARKDOWN_FORBIDDEN_TAG_NAMES = site.MARKDOWN_FORBIDDEN_TAG_NAMES;
const MARKDOWN_STYLE_ALLOWED_TAG_NAMES = site.MARKDOWN_STYLE_ALLOWED_TAG_NAMES;
const URL_VALUED_ATTRIBUTE_NAMES = site.URL_VALUED_ATTRIBUTE_NAMES;
const siteFindMissingProtocols = site.findUrlAttributesMissingProtocols;

import {
  applyRssMarkdownSchema,
  buildRssSanitizeSchema,
  rssBaseSchema,
  RSS_EXTRA_TAG_NAMES,
  RSS_FORBIDDEN_TAG_NAMES,
  RSS_STYLE_ALLOWED_TAG_NAMES,
  RSS_URL_VALUED_ATTRIBUTE_NAMES,
} from './rssHtmlSanitize';

/**
 * 🔴 跨包一致性守卫：服务端这份 RSS 白名单**必须**与前台 canonical 那份等价。
 *
 * 为什么要这条：白名单是**安全相关的判断**，而本仓库反复吃过"同一个判断散落多处然后漂移"的亏
 * （`tag.provider.ts` 里 `getAllTags` 上方的注释就是这么写的："复制一个安全相关的判断到第二处，
 * 漂移的后果是泄漏"）。这里不得不有第二份（原因见上面的 import 注释），所以**必须**有守卫钉住它不漂移。
 *
 * 手法沿用既有先例：`packages/admin/tests/unit/markdownConsistency.test.js` 钉住
 * "admin 编辑器那份镜像 ↔ website canonical" 一致；本文件钉住 "server RSS 这份镜像 ↔ website canonical"。
 * ⚠️ 但那条既有守卫是**源码文本级**的（比对两份文件里有没有同一批字符串），
 * 本文件比它更强：**直接比对解析后的 schema 对象与消毒输出**（行为级），
 * 因为文本级比对挡不住"字面量都在、但组合方式变了"这种漂移。
 *
 * ⚠️ **一条本文件覆盖不到、需要在 website 侧补的**：bytemd 传给 canonical 的**基底 schema**
 * 与 `hast-util-sanitize` 的 `defaultSchema` 只差 `attributes['*']` 里的一个 `className`
 * （2026-09-21 逐键实测：顶层 7 个键逐个相同、`tagNames` 都是 61 个、1712 vs 1700 字节）。
 * 这条事实**在 server 侧无法活体核实**（bytemd 不在 server 的依赖里，pnpm 严格隔离解析不到），
 * 所以这里只能用"行为后果"钉住它（class 必须活下来，见 `rssHtmlSanitize.spec.ts` 的 className 那组）。
 * 🔴 如果将来 bytemd 升级、它的基底又多了别的差异，**只有 website 侧的守卫能发现** ⇒
 * 建议在 `packages/website/__tests__/` 里补一条：把 bytemd 的基底与
 * `defaultSchema + className` 逐键比对。（已登记，超出本轮授权范围。）
 */

/** 用**同一个** hast-util-sanitize 跑两边的 schema，隔离出"变换本身"的差异。 */
function runWith(schema: any, html: string): string {
  return toHtml(sanitize(fromHtml(html, { fragment: true }), schema));
}

/** 两边都从同一个基底出发（深拷贝，因为两个变换都是就地修改）。 */
const siteSchema = () => siteTransform(rssBaseSchema());
const serverSchema = () => applyRssMarkdownSchema(rssBaseSchema());

/** 共享向量：危险构造 + 真实用法 + markdown 常规产出，三类都要在两边得到**逐字相同**的结果。 */
const VECTORS: Array<{ name: string; html: string }> = [
  { name: 'script 元素', html: '<script>alert(1)</script>' },
  { name: 'style 元素', html: '<style>body{display:none}</style>' },
  { name: 'javascript 锚', html: '<p><a href="javascript:alert(2)">裸 a</a></p>' },
  { name: 'img onerror', html: '<img src=x onerror="alert(3)">' },
  { name: 'div onmouseover', html: '<div onmouseover="alert(2)">悬停</div>' },
  { name: 'svg onload', html: '<svg onload="alert(1)"><circle r="10"/></svg>' },
  { name: 'iframe data:', html: '<iframe src="data:text/html;base64,PHNjcmlwdD4="></iframe>' },
  { name: 'iframe https', html: '<iframe src="https://ok.example" width="10" height="10"></iframe>' },
  { name: 'iframe 协议相对', html: '<iframe src="//player.bilibili.com/x"></iframe>' },
  { name: '真实用法 font', html: '<p><font style="color:red">红字</font></p>' },
  { name: '真实用法 br', html: 'a<br>b' },
  { name: '真实用法 h1 id', html: '<h1 id="x">标题</h1>' },
  { name: '真实用法 img', html: '<img src="/static/img/a.webp" height="10" alt="z">' },
  { name: 'data: 内联图片', html: '<img src="data:image/png;base64,iVBORw0KGgo=" alt="i">' },
  { name: 'a 上的 style', html: '<a style="position:fixed" href="/x">链接</a>' },
  { name: 'button 复制控件', html: '<button type="button" disabled>复制</button>' },
  { name: '任务列表 checkbox', html: '<input type="checkbox" disabled>' },
  { name: 'class 必须活下来', html: '<pre class="hljs"><code class="language-js">x</code></pre>' },
  { name: 'katex class', html: '<span class="katex"><span class="katex-html">E</span></span>' },
  { name: '脚注锚点', html: '<sup><a href="#fn-1" id="fnref-1">1</a></sup>' },
  { name: '表格', html: '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' },
  { name: 'Word 残留 o:p', html: '<o:p>段落</o:p>' },
  { name: 'aria 与 data-line', html: '<span aria-hidden="true" data-line="1" title="t">x</span>' },
  { name: 'mailto 链接', html: '<a href="mailto:a@b.c">mail</a>' },
];

describe('RSS 白名单 ↔ 前台 canonical：必须等价（跨包一致性守卫）', () => {
  it('尺子有效性：两边都真的解析出了 schema，且 canonical 那份是可用的', () => {
    const a = siteSchema();
    const b = serverSchema();
    // ⚠️ 反空转：如果任一边是空的/undefined，下面所有 toEqual 都会恒真
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(Array.isArray(a.tagNames)).toBe(true);
    expect(a.tagNames.length).toBeGreaterThan(50);
    expect(b.tagNames.length).toBeGreaterThan(50);
    expect(typeof siteTransform).toBe('function');
  });

  it('🔴 四张数据表逐项相同（顺序也要相同，否则说明有人重排过其中一边）', () => {
    expect([...RSS_EXTRA_TAG_NAMES]).toEqual([...MARKDOWN_EXTRA_TAG_NAMES]);
    expect([...RSS_FORBIDDEN_TAG_NAMES]).toEqual([...MARKDOWN_FORBIDDEN_TAG_NAMES]);
    expect([...RSS_STYLE_ALLOWED_TAG_NAMES]).toEqual([...MARKDOWN_STYLE_ALLOWED_TAG_NAMES]);
    expect([...RSS_URL_VALUED_ATTRIBUTE_NAMES]).toEqual([...URL_VALUED_ATTRIBUTE_NAMES]);
  });

  it('🔴 解析后的 schema 对象深度相等（这比文本比对强：挡得住"字面量都在但组合方式变了"）', () => {
    expect(serverSchema()).toEqual(siteSchema());
  });

  it('🔴 全部共享向量的消毒输出逐字相同（行为级一致性）', () => {
    const diffs: string[] = [];
    for (const v of VECTORS) {
      const site = runWith(siteSchema(), v.html);
      const server = runWith(serverSchema(), v.html);
      if (site !== server) {
        diffs.push(`${v.name}\n  canonical: ${JSON.stringify(site)}\n  server   : ${JSON.stringify(server)}`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('向量集本身有效（反空转：条数、名字唯一、且危险与真实两类都在场）', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    const names = VECTORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(VECTORS.every((v) => v.html.length > 0)).toBe(true);
    expect(names.filter((n) => /script|onerror|onload|onmouseover|javascript|data:/.test(n)).length)
      .toBeGreaterThanOrEqual(6);
    expect(names.filter((n) => n.startsWith('真实用法')).length).toBeGreaterThanOrEqual(4);
  });

  it('🔴 一致性守卫真的能抓到漂移（用**合成 schema** 证明尺子不是恒真）', () => {
    // 故意造一份"少一个标签"的 server 侧变换，喂给同一把尺子，必须报出差异
    const drifted = () => {
      const s = applyRssMarkdownSchema(rssBaseSchema());
      s.tagNames = s.tagNames.filter((t: string) => t !== 'iframe');
      return s;
    };
    const diffs: string[] = [];
    for (const v of VECTORS) {
      if (runWith(siteSchema(), v.html) !== runWith(drifted(), v.html)) diffs.push(v.name);
    }
    // ⚠️ 至少 iframe 那几条向量必须暴露差异，否则"逐项相同"这条断言可能根本量不到东西
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs).toEqual(expect.arrayContaining(['iframe https']));
    // 并且 schema 深度相等那条也会红
    expect(drifted()).not.toEqual(siteSchema());
  });

  it('🔴 反向反证：多放行一个标签也算漂移（不只是"少放行"才危险）', () => {
    const loosened = () => {
      const s = applyRssMarkdownSchema(rssBaseSchema());
      s.tagNames.push('script');
      s.strip = s.strip.filter((t: string) => t !== 'script');
      return s;
    };
    expect(loosened()).not.toEqual(siteSchema());
    expect(runWith(loosened(), '<script>alert(1)</script>')).not.toBe(
      runWith(siteSchema(), '<script>alert(1)</script>'),
    );
  });

  it('两边都不存在"被放行却没有协议白名单"的 URL 属性（canonical 的漂移守卫在 server 侧同样成立）', () => {
    expect(siteFindMissingProtocols(siteSchema())).toEqual([]);
    // server 侧用同一判据（实现是镜像的，所以这里直接跑 canonical 那个函数，
    // 它对任何 schema 都适用 —— 这也顺带证明了两个 schema 在这个性质上一致）
    expect(siteFindMissingProtocols(buildRssSanitizeSchema())).toEqual([]);
  });

  it('镜像的**行为**与 canonical 一致：script 被 strip、事件属性被摘、javascript: 被摘', () => {
    const s = buildRssSanitizeSchema();
    expect(runWith(s, '<script>alert(1)</script>')).toBe('');
    expect(runWith(s, '<img src=x onerror="alert(3)">')).toBe('<img src="x">');
    expect(runWith(s, '<p><a href="javascript:alert(2)">裸 a</a></p>')).toBe('<p><a>裸 a</a></p>');
    // ⚠️ 这三条与 rssHtmlSanitize.spec.ts 里的断言重复是**有意的**：那边钉"消毒器对外表现正确"，
    //    这边钉"镜像的 schema 与 canonical 等价"。两边同时红才说明是 schema 漂移，只有一边红说明是管线问题。
  });
});
