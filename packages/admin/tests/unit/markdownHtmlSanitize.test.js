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
  it('allows underline/font and does not allow script', () => {
    assert.match(adminSanitize, /MARKDOWN_EXTRA_TAG_NAMES = \[[\s\S]*?'u'/);
    assert.match(adminSanitize, /MARKDOWN_EXTRA_TAG_NAMES = \[[\s\S]*?'font'/);
    assert.match(adminSanitize, /MARKDOWN_FORBIDDEN_TAG_NAMES = \['script'\]/);
    assert.match(adminSanitize, /FORBIDDEN_TAG_NAME_SET\.has\(tag\)/);
    assert.match(adminSanitize, /schema\.strip[\s\S]*MARKDOWN_FORBIDDEN_TAG_NAMES/);
    assert.doesNotMatch(adminSanitize, /push\('script'\)/);
  });

  it('uses the same extra tags as the public sanitizer', () => {
    assert.match(websiteSanitize, /"u"/);
    assert.match(websiteSanitize, /"font"/);
    assert.match(websiteSanitize, /MARKDOWN_FORBIDDEN_TAG_NAMES = \["script"\]/);
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
