import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { Injectable, Logger } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import taskLists from 'markdown-it-task-lists';
// ⚠️ 以前是 `markdown-it-katex`：那个包 2016 年就停止维护（2.0.3 至今仍是"最新"），
// 带着一个**没有修复版本**的 XSS 公告，而且内部钉的是 katex 0.6。
// `@traptitech/markdown-it-katex` 是社区维护的等价替代（同样的默认导出、同样的
// markdown-it 插件签名，内部用 katex 0.16），前台/后台/RSS 三处的 katex 版本就此对齐。
// 渲染出来的数学标记会从 katex 0.6 变成 0.16（class 仍是 .katex，样式表前台已经在加载）。
import mk from '@traptitech/markdown-it-katex';

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
            console.log(e);
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
      .use(mk);
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
