const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '../../../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 剥掉注释，再断言"某文本不存在"。
 * ⚠️ 必须剥：这两份 sanitize 文件的注释里**故意**写着被禁的旧写法
 * （小写 `allowfullscreen` / `frameborder`、以前 push 到 `*` 的 `src`/`style`），
 * 不剥注释的话"不存在"断言会匹配到解释性注释而**假红**，或者反过来靠注释**假绿**。
 * 本仓库已经为这个形状吃过 6 次亏。
 * 简化实现：按字符扫，跳过三种引号的字符串、行注释与块注释；不特殊处理正则字面量
 * （这两份文件里的正则不含引号，够用）。
 * ⚠️ 这段说明里不能写出"斜杠星 + 星斜杠"那个序列本身，否则会提前闭合本注释块（踩过）。
 */
function noComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] === undefined ? '' : src[i + 1]);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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
      // 全局属性：无障碍、tooltip、代码块行号、边框
      // ⚠️ `style` 与 `src` **不再**是全局属性（2026-09 收紧，按标签发放，见下面两条用例）
      'ariaLabel', 'ariaHidden', 'title', 'dataLine', 'border',
      // iframe 的展示属性：⚠️ 必须是 hast 的驼峰名。小写的 allowfullscreen/frameborder
      //    rehype-sanitize 根本匹配不到（它比的是 property-information 的属性名），
      //    以前两份文件写的都是小写 ⇒ 嵌入视频的全屏按钮一直被静默摘掉。
      'allowFullScreen', 'frameBorder', 'scrolling', 'framespacing',
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

  it('两边都不再把 src / style 挂在全局 * 上，且 iframe 的 src 带值白名单', () => {
    for (const [label, src] of [['前台', site], ['编辑器', admin]]) {
      const code = noComments(src);
      // 主动摘除的那一行必须在（两份文件引号风格不同，所以用容错正则）
      assert.match(
        code,
        /entry\s*!==\s*(['"])src\1\s*&&\s*entry\s*!==\s*(['"])style\2/,
        `${label} 没有把 src/style 从全局属性里摘掉`,
      );
      // src 仍然发给 iframe，但带值白名单（否则 data:text/html 的 iframe 又能用了）
      assert.match(
        code,
        /\[\s*(['"])src\1\s*,\s*IFRAME_SRC_HTTPS_ONLY\s*\]/,
        `${label} 的 iframe src 没有值白名单`,
      );
      // 值白名单必须**同时**接受 https:// 与协议相对 //host/…（只认 ^https?:// 会弄坏既有嵌入）
      assert.match(code, /\^\(https\?:\)\?/, `${label} 的 iframe src 正则不接受协议相对写法`);
    }
  });

  it('两边都用 hast 的驼峰属性名，小写写法不许回来', () => {
    for (const [label, src] of [['前台', site], ['编辑器', admin]]) {
      const code = noComments(src);
      assert.doesNotMatch(
        code,
        /['"]allowfullscreen['"]/,
        `${label} 还在用小写 allowfullscreen（rehype-sanitize 匹配不到，等于没放行）`,
      );
      assert.doesNotMatch(
        code,
        /['"]frameborder['"]/,
        `${label} 还在用小写 frameborder（同上）`,
      );
      assert.match(code, /['"]allowFullScreen['"]/, `${label} 缺少驼峰 allowFullScreen`);
      assert.match(code, /['"]frameBorder['"]/, `${label} 缺少驼峰 frameBorder`);
    }
  });

  it('两边的 style 白名单逐项相同：含排版标签，不含 a / input / button', () => {
    const lists = {};
    for (const [label, src] of [['前台', site], ['编辑器', admin]]) {
      const m = noComments(src).match(
        /MARKDOWN_STYLE_ALLOWED_TAG_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/,
      );
      assert.ok(m, `${label} 没有 MARKDOWN_STYLE_ALLOWED_TAG_NAMES`);
      const list = (m[1].match(/['"][a-z0-9]+['"]/g) || []).map((x) => x.slice(1, -1));
      for (const t of ['p', 'div', 'span', 'font', 'center', 'table', 'td', 'img', 'iframe', 'h1', 'li', 'code']) {
        assert.ok(list.includes(t), `${label} 的 style 白名单少了 ${t}（既有文章会掉排版）`);
      }
      for (const t of ['a', 'input', 'button', 'script', 'style', 'form', 'link', 'meta']) {
        assert.ok(!list.includes(t), `${label} 的 style 白名单不该含 ${t}`);
      }
      lists[label] = list;
    }
    // 两份必须**逐项相同**，否则就是"预览里有、发布后没了"
    assert.deepEqual(lists['编辑器'], lists['前台'], '两份 style 白名单不一致');
  });

  it('两边都有「URL 属性必须有协议白名单」的漂移守卫', () => {
    for (const [label, src] of [['前台', site], ['编辑器', admin]]) {
      const code = noComments(src);
      assert.match(code, /URL_VALUED_ATTRIBUTE_NAMES/, `${label} 缺少 URL 类属性表`);
      assert.match(
        code,
        /function findUrlAttributesMissingProtocols/,
        `${label} 缺少漂移检查函数`,
      );
      assert.match(
        code,
        /ensureUrlAttributeProtocols\(schema\)/,
        `${label} 没有在 sanitize 流程里补协议表`,
      );
      // ⚠️ 判据必须是"非空数组"：空数组与键不存在在 safeProtocol() 里同样等于放行一切协议，
      //    而空数组更危险（看着像已经配好了）。
      assert.match(
        code,
        /!Array\.isArray\(list\)\s*\|\|\s*list\.length === 0/,
        `${label} 的漂移判据没有覆盖"空数组"这种形状`,
      );
      for (const attr of ['srcset', 'poster', 'longDesc', 'action', 'formaction']) {
        assert.ok(code.includes(attr), `${label} 的 URL 属性表少了 ${attr}`);
      }
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
