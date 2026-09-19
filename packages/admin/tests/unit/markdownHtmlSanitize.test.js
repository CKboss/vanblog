const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const editorSrc = readFileSync(
  path.join(adminRoot, 'src/components/Editor/index.tsx'),
  'utf8',
);
// 编辑器不再自己内联一份 schema，改用与前台同构的共享模块（见 markdownConsistency.test.js）
const adminSanitize = readFileSync(
  path.join(adminRoot, 'src/components/Editor/markdownSanitize.ts'),
  'utf8',
);
const websiteSanitize = readFileSync(
  path.join(adminRoot, '../website/utils/markdownSanitize.ts'),
  'utf8',
);
const adminCss = readFileSync(
  path.join(adminRoot, 'src/style/github-markdown.css'),
  'utf8',
);

describe('admin editor HTML-in-Markdown sanitizer (#490)', () => {
  /**
   * 取出「整段 strip 掉」的标签清单（两份文件都适用）。
   * ⚠️ 不能像以前那样钉字面量 `MARKDOWN_FORBIDDEN_TAG_NAMES = ['script']`：
   * 2026-09 起这个清单里还有 `style`（`<style>` 的元素本来就会被丢，但 rehype-sanitize
   * 对不在白名单的标签是**保留子节点**的，于是 CSS 会被当成可见正文渲染出来；进 strip 才会连内容一起删）。
   * 钉字面量的结果是"每加一个就该改测试"，而且改的人容易直接把新值填回去而不想为什么。
   * 现在改成：两份文件的清单必须**逐项相同**，且都必须含 script 与 style。
   * ⚠️ 用全局匹配而不是"每行取第一个"：admin 那份是单行写法，website 那份是多行写法。
   */
  const forbidden = (src) => {
    const block = (src.match(/MARKDOWN_FORBIDDEN_TAG_NAMES = \[([\s\S]*?)\] as const/) || ['', ''])[1];
    return (block.match(/['"][a-zA-Z]+['"]/g) || []).map((x) => x.slice(1, -1)).sort();
  };

  it('allows underline/font and does not allow script', () => {
    assert.match(adminSanitize, /MARKDOWN_EXTRA_TAG_NAMES = \[[\s\S]*?'u'/);
    assert.match(adminSanitize, /MARKDOWN_EXTRA_TAG_NAMES = \[[\s\S]*?'font'/);
    assert.ok(forbidden(adminSanitize).includes('script'), '编辑器必须整段 strip 掉 script');
    assert.ok(forbidden(adminSanitize).includes('style'), '编辑器必须整段 strip 掉 style（否则 CSS 会被当正文渲染）');
    assert.match(adminSanitize, /FORBIDDEN_TAG_NAME_SET\.has\(tag\)/);
    assert.match(adminSanitize, /schema\.strip[\s\S]*MARKDOWN_FORBIDDEN_TAG_NAMES/);
    assert.doesNotMatch(adminSanitize, /push\('script'\)/);
  });

  it('uses the same extra tags as the public sanitizer', () => {
    assert.match(websiteSanitize, /"u"/);
    assert.match(websiteSanitize, /"font"/);
    assert.ok(forbidden(websiteSanitize).includes('script'), '前台必须整段 strip 掉 script');
    assert.ok(forbidden(websiteSanitize).includes('style'), '前台必须整段 strip 掉 style');
    // 两边"整段 strip"的清单必须逐项一致（否则预览与发布行为不同）
    assert.deepEqual(forbidden(adminSanitize), forbidden(websiteSanitize));
    // 两边放行的标签集合一致（顺序可以不同）
    const tags = (src) =>
      (src.match(/MARKDOWN_EXTRA_TAG_NAMES = \[[\s\S]*?\] as const/) || [''])[0]
        .split(/[\r\n]+/)
        .map((line) => (line.match(/['"]([a-z]+)['"]/) || [])[1])
        .filter(Boolean)
        .sort();
    assert.deepEqual(tags(adminSanitize), tags(websiteSanitize));
  });

  it('editor 确实在用这份共享 schema', () => {
    assert.match(
      editorSrc,
      /import \{ sanitizeMarkdownSchema as sanitize \} from '\.\/markdownSanitize'/,
    );
    assert.match(editorSrc, /sanitize=\{sanitize\}/);
    assert.doesNotMatch(editorSrc, /const sanitize = \(schema\) =>/);
  });

  it('passes allowDangerousHtml so preview parses raw HTML like the public Viewer', () => {
    assert.match(editorSrc, /remarkRehype=\{\{\s*allowDangerousHtml:\s*true/);
    assert.match(adminCss, /\.markdown-body u\s*\{[\s\S]*text-decoration:\s*underline/);
  });
});
