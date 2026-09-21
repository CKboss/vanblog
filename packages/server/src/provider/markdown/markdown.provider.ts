import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { Injectable, Logger } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import taskLists from 'markdown-it-task-lists';
// 数学公式插件的迁移史（两次，理由都是**维护状态**而不是漏洞）：
//   ① `markdown-it-katex` —— 2016 年停止维护（2.0.3 至今仍是"最新"），带着一个**没有修复版本**
//      的 XSS 公告，内部钉 katex 0.6 ⇒ 换成 `@traptitech/markdown-it-katex`（见 §7.47）。
//   ② `@traptitech/markdown-it-katex` 3.6.0 —— **2022-07-08 之后未再更新**，且它是渲染用户正文
//      这条热路径上唯一的公式插件 ⇒ 2026-09-21 换成 `@mdit/plugin-katex`（见 §7.77.2 / §7.89）。
//
// 🔴 迁移前实测过的事实（都是量出来的，不是推理）：
//   · **katex 0.16.47 与 0.17.0 对同一批公式产出的 HTML 逐字节相同**（8/8）⇒ 新插件依赖的
//     `katex: ^0.17.0` 不会改变数学标记；前台仍然加载自己的 `katex@0.16` 样式表，选择器是
//     `.katex`/`.katex-display`，不受影响。
//   · 语料差分（59 例，含 8 篇真实文章）：markdown-it **13→14 是 59/59 逐字节相同**；
//     插件替换只有 **2/59** 不同，且都只差 **1 个字节** —— 块级公式的外层容器从
//     `<p class="katex-block ">`（双引号 + 尾随空格）变成 `<p class='katex-block'>`。
//     ⚠️ 全仓对 `katex-block` 这个类名的字面依赖是 **0 处**（grep 过 ts/tsx/css/less/scss/js/jsx/md），
//     所以这 1 字节是惰性的；内部的 `.katex-display`/`.katex` 标记完全一致。
//   · `@mdit/plugin-katex@1.0.1` 是 **ESM-only**（`"type": "module"`，exports 里只有 `default`
//     条件、没有 `require`，也没有根 `main`/`types`）。本包是 CommonJS（`module: CommonJS`、
//     无 `"type": "module"`），运行时**可以**加载它：Node 24（镜像的 runner 就是 node:24-alpine）
//     支持 `require(esm)`，而该包**没有 top-level await**（实测 require 成功、`typeof katex === 'function'`）。
//     ⚠️ 但 TypeScript 的 `moduleResolution` 是 **Node10**（`module: CommonJS` 的默认值），
//     Node10 **不读 exports 映射**、只找根 `main`/`types` ⇒ 直接 import 会报 TS2307。
//     所以 `tsconfig.json` 里给它加了一条 `paths` 映射指到 `dist/index.d.ts`
//     （与既有的 `"mongoose"` 那条同一手法），**而不是**把整个包的 moduleResolution 换成
//     node16/bundler —— 那会改变全仓所有 import 的解析规则，blast radius 太大。
//     ⚠️ 如果将来把 server 迁到 ESM 或把 moduleResolution 升级到 node16+，那条 paths 就可以删掉。
import { katex } from '@mdit/plugin-katex';

// x86asm ships without aliases in highlight.js 11; users write ```asm / ```nasm.
if (hljs.getLanguage('x86asm')) {
  hljs.registerAliases(['asm', 'assembly', 'nasm', 'intel', 'x86'], {
    languageName: 'x86asm',
  });
}

@Injectable()
export class MarkdownProvider {
  logger = new Logger(MarkdownProvider.name);
  md: MarkdownIt = null;
  constructor() {
    this.md = new MarkdownIt({
      html: true,
      breaks: true,
      linkify: false,
      highlight: (str, lang) => {
        if (lang == 'mermaid') {
          return `<div class="mermaid">${str}</div>`;
        }
        if (lang && hljs.getLanguage(lang)) {
          try {
            return (
              '<pre class="hljs" style="background: #f3f3f3; padding: 8px;><code>' +
              hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
              '</code></pre>'
            );
          } catch (e) {
            // 以前是 console.log(e)：高亮失败会退回"转义后的纯代码块"（行为是对的），
            // 但那条错误只进 stdout、不进结构化日志，后台日志页里看不到，
            // 于是"某个语言的代码块没有高亮"永远查不出原因。
            this.logger.warn(
              `代码高亮失败，已退回纯文本代码块（lang=${lang || '未指定'}）：${
                (e as Error)?.message || e
              }`,
            );
          }
          return (
            '<pre class="hljs" style="background: #f3f3f3;padding: 8px;"><code>' +
            this.md.utils.escapeHtml(str) +
            '</code></pre>'
          );
        }
      },
    })
      .use(taskLists)
      // ⚠️ 不传任何 options：`@mdit/plugin-katex` 的默认分隔符行为与旧插件在本项目语料上
      //    实测一致（`$…$` 行内、`$$…$$` 块级、`$a \$ b$` 转义都相同，而 `$5 与 $10` 两边都
      //    **不**当成公式）。显式传 options 反而会引入一处"我们以为等价、其实不等价"的风险。
      .use(katex);
  }
  renderMarkdown(content: string) {
    return this.md.render(content);
  }

  getDescription(content: string) {
    // 委托给共享的 articleOverviewMarkdown：RSS 的 description 与前台列表摘要是同一个
    // 产品语义（`<!-- more -->` 之前；没有标记就取前 200 字），两份实现必漂移 ——
    // 这里的旧实现 `stripFrontMatter(content).split('<!-- more -->')[0]` 就会在
    // 代码块里的示例标记处截断，还会把没有标记的全文整个塞进 description。
    // 剥 front matter 的逻辑也在那条链里（articleExcerpt → frontMatter）。
    return articleOverviewMarkdown(content);
  }
}
