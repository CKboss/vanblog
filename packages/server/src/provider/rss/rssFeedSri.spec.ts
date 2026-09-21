import * as fs from 'fs';
import * as path from 'path';
import {
  RSS_KATEX_CSS_VERSION,
  RSS_KATEX_CSS_SRI,
  RSS_HLJS_CSS_VERSION,
  RSS_HLJS_CSS_SRI,
} from './rss.provider';

/**
 * 🔴 RSS 里两个第三方 CDN 样式表的**完整性校验（SRI）**守卫。
 *
 * ## 这条守卫钉的是什么
 * feed 的每条 item 外壳里硬编码了两个外链样式表（katex 与 highlight.js 的主题）。
 * 2026-09-21 之前它们**既没有 `integrity` 也没有 `crossorigin`** ⇒ CDN 域被劫持/被投毒时，
 * 攻击者可以用 CSS 做 **UI 重绘与遮罩钓鱼**（盖一层假登录框），以及用
 * **属性选择器 + `background:url()`** 把页面内容逐字符外泄到自己的域。
 * ⚠️ 严重性低于站内同源脚本注入（CSS 不执行 JS，且多数阅读器会剥掉 link），
 * 但"零成本的纵深防御没做"仍然是缺陷，所以补上。
 *
 * ## ⚠️ 为什么 hash 只能"钉住"而不能"在测试里重算"
 * SRI 的正确性依赖**下载那个 URL 的真实内容**再算 sha384 —— 单元测试**绝不能联网**
 * （会让测试结果取决于外网与 CDN 状态，正是要避免的负载敏感/环境敏感形状）。
 * 所以这里的分工是：
 *   · **测试钉住**：hash 的格式、版本与 hash 的对应关系、模板确实同时输出了 integrity 与 crossorigin；
 *   · **人工/CI 之外核实**：改动版本时必须重新下载并重算（命令写在下面）。
 * 🔴 **写错 hash 比不写更糟**：浏览器会**拒绝应用**那张样式表 ⇒ 所有阅读器里的公式与代码高亮全部失去样式。
 * 所以本轮这两个值是**独立下载并计算了两次、两次逐字一致**才写进来的：
 *   · katex 0.16.47 `dist/katex.min.css` —— 23,827 B，
 *     sha256 `0289a02cf451a44dd73add683a09644252363871ac11713a647b732cee8b1ee3`
 *   · highlight.js 11.6.0 `build/styles/default.min.css` —— 1,144 B，
 *     sha256 `fbde0ac0921d86c356c41532e7319c887a23bd1b8ff00060cab447249f03c7cf`
 *
 * ## 重算命令（换版本时必须跑，把输出逐字粘回 rss.provider.ts）
 * ```
 * curl -sSL <url> -o /tmp/x.css
 * openssl dgst -sha384 -binary /tmp/x.css | openssl base64 -A ; echo
 * sha256sum /tmp/x.css          # 一并记进注释，便于日后复核"算的是不是同一个文件"
 * ```
 *
 * ## 🔴 为什么 katex 的版本是 0.16.47 而不是原来的 0.16.9
 * 这不是顺手升级，是**修一个实测出来的渲染缺陷**：产生公式标记的渲染器是 0.16.47/0.17.0
 * （服务端经 `@mdit/plugin-katex`，前台 `packages/website` 的 katex 是 0.16.47），
 * 而两份 CSS 的类选择器差集实测为"0.16.47 独有 `smash` 与 `mathsfit`、0.16.9 独有 0 条"，
 * 且**当前渲染器确实会产出这两个类**（`\smash{x}` → `smash`，`\mathsfit{x}` → `mathsfit`）
 * ⇒ **用这两个命令的公式在 RSS 阅读器里此前是错排的**。
 * ⚠️ 升级不改任何 HTML 结构（CSS 不参与我们生成的标记；`markdown.provider.ts` 头注释已实测记录
 * "katex 0.16.47 与 0.17.0 对同一批公式产出的 HTML 逐字节相同"），变的只是 link 上的两个字符串。
 */

const PROVIDER_SRC = path.join(__dirname, 'rss.provider.ts');

/** 剥掉注释再断言"不存在"，否则注释里的同名字样会喂饱断言（本仓库踩过三次）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

describe('RSS 外链样式表的 SRI（完整性校验）', () => {
  it('尺子有效性：源文件真的被读到，且常量都非空', () => {
    const src = fs.readFileSync(PROVIDER_SRC, 'utf8');
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('RssProvider');
    for (const v of [RSS_KATEX_CSS_VERSION, RSS_KATEX_CSS_SRI, RSS_HLJS_CSS_VERSION, RSS_HLJS_CSS_SRI]) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('🔴 两个 hash 的格式合法（sha384-<64 位 base64>），且互不相同', () => {
    // sha384 = 48 字节 = base64 后 64 个字符。格式错了浏览器会直接拒绝加载样式表。
    const SRI_RE = /^sha384-[A-Za-z0-9+/]{64}$/;
    expect(RSS_KATEX_CSS_SRI).toMatch(SRI_RE);
    expect(RSS_HLJS_CSS_SRI).toMatch(SRI_RE);
    expect(RSS_KATEX_CSS_SRI).not.toBe(RSS_HLJS_CSS_SRI);
  });

  it('🔴 版本与 hash 的对应关系被钉住（改了版本没重算 hash 就会红）', () => {
    // ⚠️ 这条断言的值是**实测下载算出来的**那两组，逐字写死。
    //    它的作用不是"证明 hash 正确"（那要联网下载才能证明），而是**让"版本变了而 hash 没跟着变"
    //    这种最危险的组合立刻变红** —— 那会让所有阅读器里的样式表加载失败。
    expect(RSS_KATEX_CSS_VERSION).toBe('0.16.47');
    expect(RSS_KATEX_CSS_SRI).toBe(
      'sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA',
    );
    expect(RSS_HLJS_CSS_VERSION).toBe('11.6.0');
    expect(RSS_HLJS_CSS_SRI).toBe(
      'sha384-4Y0nObtF3CbKnh+lpzmAVdAMtQXl+ganWiiv73RcGVdRdfVIya8Cao1C8ZsVRRDz',
    );
  });

  it('🔴 模板里两个 CDN link 都同时带 integrity 与 crossorigin，且引用的是常量而不是写死的字面量', () => {
    const code = stripComments(fs.readFileSync(PROVIDER_SRC, 'utf8'));
    // 两个 link 都必须把常量插值进去（写死字面量就会出现"改了常量但模板没变"的漂移）
    expect(code).toContain('katex@${RSS_KATEX_CSS_VERSION}/dist/katex.min.css');
    expect(code).toContain('integrity="${RSS_KATEX_CSS_SRI}"');
    expect(code).toContain('highlightjs/cdn-release@${RSS_HLJS_CSS_VERSION}/build/styles/default.min.css');
    expect(code).toContain('integrity="${RSS_HLJS_CSS_SRI}"');
    // crossorigin 是 SRI 生效的前提之一（跨域资源必须以 CORS 匿名方式取，否则浏览器不校验/直接拒绝）
    expect((code.match(/crossorigin="anonymous"/g) || []).length).toBe(2);
    // 🔴 旧的"裸 link"形状不许回来：不带 integrity 的 CDN link 一个都不能有
    expect(code).not.toMatch(/katex@[0-9.]+\/dist\/katex\.min\.css">/);
    expect(code).not.toMatch(/default\.min\.css">/);
  });

  it('⚠️ 本站自己的 markdown.css **不加** SRI（它随每次部署变化，钉 hash 会让它每次发版都失效）', () => {
    const code = stripComments(fs.readFileSync(PROVIDER_SRC, 'utf8'));
    expect(code).toContain('href="${siteUrl}markdown.css">');
    // 反证：markdown.css 那一行上没有 integrity（否则说明有人给它也钉了 hash）
    const line = code.split('\n').find((l) => l.includes('markdown.css')) || '';
    expect(line).not.toContain('integrity');
  });

  it('🔴 三个 link 都在**外壳**里，而外壳不经过消毒器（否则 link 会被白名单摘掉）', () => {
    const code = stripComments(fs.readFileSync(PROVIDER_SRC, 'utf8'));
    // 外壳是模板字符串：div.markdown-body.rss + 三个 link + 已消毒的正文
    expect(code).toContain('<div class="markdown-body rss">');
    expect((code.match(/rel="stylesheet"/g) || []).length).toBe(3);
    expect(code).toContain('${renderedBody}</div>');
    // 🔴 消毒只作用于 renderedBody 与 description 两处（这条与 wiring 守卫互补：
    //    那边钉"每个 renderMarkdown 都被消毒包住"，这边钉"外壳没有被一起消毒"）
    expect((code.match(/sanitizeRenderedHtml\(/g) || []).length).toBe(2);
  });

  it('🔴 link 元素确实不在白名单里 —— 这正是"外壳绝不能一起消毒"的实测依据', () => {
    // ⚠️ 这条把上面那个约束的**原因**钉住：如果有人将来"顺手"把外壳也消毒，
    //    三个样式表会全部消失（每个阅读器里的公式与代码高亮都变成无样式）。
    //    既有守卫 rssHtmlSanitizeWiring.spec.ts 已经用变异 M7 证明它能抓到那种改动；
    //    这里从白名单侧再钉一次：link 不在 tagNames 里。
    const { buildRssSanitizeSchema, sanitizeRenderedHtml } = require('../../utils/rssHtmlSanitize');
    const schema = buildRssSanitizeSchema();
    expect(schema.tagNames).not.toContain('link');
    expect(sanitizeRenderedHtml('<link rel="stylesheet" href="/a.css">')).toBe('');
  });
});
