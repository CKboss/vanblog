const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '../../../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const SITE_SANITIZE = 'packages/website/utils/markdownSanitize.ts';
const ADMIN_SANITIZE = 'packages/admin/src/components/Editor/markdownSanitize.ts';
const EDITOR = 'packages/admin/src/components/Editor/index.tsx';
// 前台渲染器拆成了「按需选择器 + 外壳 + 轻量/完整两个变体」（性能优化，见 perfBudget.spec.ts），
// 所以校验插件清单时要把这几个文件拼起来看。
const SITE_VIEWER_FILES = [
  'packages/website/components/Markdown/index.tsx',
  'packages/website/components/Markdown/MarkdownView.tsx',
  'packages/website/components/Markdown/MarkdownBase.tsx',
  'packages/website/components/Markdown/MarkdownRich.tsx',
];
const SITE_VIEWER = SITE_VIEWER_FILES.map(read).join('\n');

describe('编辑器预览 与 前台渲染：sanitize 白名单必须一致', () => {
  const site = read(SITE_SANITIZE);
  const admin = read(ADMIN_SANITIZE);

  it('编辑器不再自己手写一份，而是用共享实现', () => {
    const editor = read(EDITOR);
    assert.match(editor, /import \{ sanitizeMarkdownSchema as sanitize \} from '\.\/markdownSanitize'/);
    assert.match(editor, /sanitize=\{sanitize\}/);
    // 内联那份已经删掉
    assert.doesNotMatch(editor, /const sanitize = \(schema\) =>/);
  });

  it('两边的标签白名单/黑名单、属性白名单逐项对齐', () => {
    const required = [
      // 额外放行的标签（少了任何一个，预览和前台就会不一样）
      'center', 'iframe', 'section', 'button', 'u', 'font',
      // 明确禁掉并 strip 的
      'script',
      // button / font 的属性
      'type', 'disabled', 'color', 'size', 'face',
      // 全局属性：无障碍、tooltip、代码块行号、内嵌样式与 iframe 参数
      'ariaLabel', 'ariaHidden', 'title', 'dataLine',
      'style', 'src', 'scrolling', 'border', 'frameborder',
      'framespacing', 'allowfullscreen',
    ];
    for (const name of required) {
      const needle = new RegExp(`['"\`]${name}['"\`]`);
      assert.ok(needle.test(site), `前台 sanitize 缺少 ${name}`);
      assert.ok(needle.test(admin), `编辑器 sanitize 缺少 ${name}`);
    }
  });

  it('两边都允许 data: 图片、都清掉 clobberPrefix、都过滤 on* 事件属性', () => {
    for (const [label, src] of [['前台', site], ['编辑器', admin]]) {
      assert.match(src, /protocols\.src\.push\((['"])data\1\)/, `${label} 没放行 data: 图片`);
      assert.match(src, /clobberPrefix = (['"])\1/, `${label} 没清 clobberPrefix（脚注锚点会断）`);
      assert.match(src, /EVENT_HANDLER_ATTR = \/\^on\[a-z\]\{3,\}\$\/i/, `${label} 没过滤事件属性`);
    }
  });
});

describe('编辑器预览 与 前台渲染：插件与流水线', () => {
  const editor = read(EDITOR);
  const viewer = SITE_VIEWER;

  it('渲染类插件两边都在（缺一个就会出现预览与发布不一致）', () => {
    const shared = [
      ['gfm', /gfm\(/],
      // 编辑器里的 KaTeX 改成按需加载了（正文有公式才 import），所以匹配动态导入
      ['math', /import\('@bytemd\/plugin-math-ssr'\)|math\(/],
      ['highlight', /highlightSsr\(\)/],
      ['mermaid', /mermaid/],
      ['customContainer', /customContainer\(\)/],
      ['rawHTML', /rawHTML\(\)/],
      ['codeBlock', /customCodeBlock\(\)/],
      ['linkTarget', /LinkTarget\(\)/],
      ['heading', /Heading\(\)/],
      // 6 种补充语法（==高亮== / 上下标 / :emoji: / 定义列表 / GitHub 提示块 / [[toc]]）
      ['extraSyntax', /extraSyntax\(\)/],
    ];
    for (const [name, re] of shared) {
      assert.ok(re.test(editor), `编辑器缺少 ${name}`);
      assert.ok(re.test(viewer), `前台缺少 ${name}`);
    }
    // 两边都开 allowDangerousHtml（否则 rawHTML 不生效），并且都要把定义列表的
    // hast handler 传给 remark-rehype（否则 dl/dt/dd 会被当未知节点摊成 div）
    assert.match(editor, /remarkRehype=\{\{ allowDangerousHtml: true, handlers: defListHastHandlers \}\}/);
    // 前台的 remarkRehype 选项提成了模块级常量 REMARK_REHYPE_OPTIONS（内联对象字面量
    // 会让下游 MarkdownViewer 的 useMemo 每次重渲染都 miss、整篇重新 processSync），
    // 字段内容必须与编辑器那边逐项一致
    assert.match(viewer, /const REMARK_REHYPE_OPTIONS = \{\s*allowDangerousHtml: true,[\s\S]*?handlers: defListHastHandlers,\s*\};/);
    assert.match(viewer, /remarkRehype=\{REMARK_REHYPE_OPTIONS\}/);
    // 单个 ~x~ 归下标，删除线用 ~~x~~：两边必须一致，否则预览和发布不一样
    assert.match(editor, /singleTilde: false/);
    assert.ok((viewer.match(/singleTilde: false/g) || []).length >= 2, '前台 Base/Rich 两个变体都要关单波浪删除线');
  });

  it('front matter：编辑器用插件解析，前台渲染前剥掉，两边都不会显示成正文', () => {
    assert.match(editor, /frontmatter\(\)/);
    assert.match(viewer, /stripFrontMatter\(props\.content\)/);
  });

  it('编辑器独有的能力（不影响渲染一致性）有注释说明', () => {
    // 上传/历史/工具栏/软换行这些是编辑器行为，前台不需要
    for (const name of ['imgUploadPlugin', 'fileUploadPlugin', 'transferRemotePlugin', 'insertMore', 'historyIcon', 'mobileToolbarPlugin', 'softLineBreaksPlugin']) {
      assert.ok(editor.includes(name), `编辑器少了 ${name}`);
      assert.ok(!viewer.includes(name), `${name} 不该出现在前台渲染里`);
    }
  });
});

describe('编辑器预览 与 前台渲染：未知容器标题回落一致', () => {
  it('两边都是 title 属性 > 内置映射 > 容器名', () => {
    assert.match(
      read('packages/website/components/Markdown/customContainer.tsx'),
      /CUSTOM_CONTAINER_TITLE\[tagName\] \|\| tagName/,
    );
    assert.match(
      read('packages/admin/src/components/Editor/plugins/customContainerRemark.js'),
      /CUSTOM_CONTAINER_TITLE\[tagName\] \|\| tagName/,
    );
  });
});
