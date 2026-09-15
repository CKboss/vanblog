import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { Injectable, Logger } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import taskLists from 'markdown-it-task-lists';
import mk from 'markdown-it-katex';

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
