const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
/** 断言前剔除注释：新注释里经常引用「不要那样写」的旧代码 */
const code = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('后台编辑器预览的字体（与前台 Apple 皮肤一致）', () => {
  const adminCss = read('packages/admin/src/style/apple-preview.css');
  const siteCss = read('packages/website/styles/apple.css');
  const hook = read('packages/admin/src/components/Editor/useApplePreviewFont.ts');
  const editor = code(read('packages/admin/src/components/Editor/index.tsx'));
  const siteFont = read('packages/website/utils/appleFont.ts');
  const layout = read('packages/website/components/Layout/index.tsx');

  it('字体栈两边一致（两个包不共享构建产物，只能靠测试盯住）', () => {
    const stackOf = (css, token) => {
      const m = css.match(new RegExp(`--${token}:([\\s\\S]*?);`));
      assert.ok(m, `找不到 --${token}`);
      return m[1]
        .replace(/\s+/g, ' ')
        .replace(/['"]/g, '')
        .trim();
    };
    assert.equal(stackOf(adminCss, 'ap-font'), stackOf(siteCss, 'ap-font'), '--ap-font 两边要一样');
    assert.equal(
      stackOf(adminCss, 'ap-font-mono'),
      stackOf(siteCss, 'ap-font-mono'),
      '--ap-font-mono 两边要一样',
    );
    // Maple Mono 打头，且兜底栈一个都不能少（远程字体挂了也不能退化成浏览器默认字体）
    for (const css of [adminCss, siteCss]) {
      const stack = stackOf(css, 'ap-font');
      assert.ok(stack.startsWith('Maple Mono NF CN, Maple Mono,'), 'Maple Mono 要排在最前');
      for (const fallback of ['-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif']) {
        assert.ok(stack.includes(fallback), `兜底字体缺失：${fallback}`);
      }
    }
  });

  it('拉丁子集用本地 @font-face 且 font-display: swap', () => {
    assert.match(adminCss, /@font-face/);
    assert.match(adminCss, /font-family: 'Maple Mono'/);
    assert.match(adminCss, /font-display: swap/);
    assert.match(adminCss, /latin-400-normal\.woff2/);
  });

  it('只作用于预览面板，不外泄到后台其它页面，也不动编辑区', () => {
    // 剔除 CSS 注释再判断：注释里正好写了「不动 CodeMirror 编辑区」这句话
    const cssCode = adminCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // 每条字体规则都必须带 .vanblog-apple-preview 作用域
    const rules = cssCode.match(/^[^@/\s][^{]*\{/gm) || [];
    for (const selector of rules) {
      assert.ok(
        selector.includes('.vanblog-apple-preview'),
        `选择器缺少作用域：${selector.trim()}`,
      );
    }
    assert.match(adminCss, /\.vanblog-apple-preview \.bytemd-preview/);
    // 代码相关必须走 mono 令牌
    assert.match(adminCss, /bytemd-preview code,[\s\S]*?font-family: var\(--ap-font-mono\)/);
    // 不许碰 CodeMirror（左侧编辑区）
    assert.doesNotMatch(cssCode, /CodeMirror|bytemd-editor/);
  });

  it('远程字体样式表非阻塞注入，且只在皮肤开启时注入', () => {
    assert.match(hook, /media = 'print'/);
    assert.match(hook, /link\.media !== 'all'/);
    assert.match(hook, /flipToAll/);
    assert.match(hook, /preconnect/);
    assert.match(hook, /if \(!enabled\)/);
    // 用引用计数，避免多个编辑器实例反复插拔
    assert.match(hook, /refCount/);
    assert.match(hook, /APPLE_FONT_CSS_URL: string \| null/);
  });

  it('字体源地址与前台一致（换源要同时换两处，测试会提醒）', () => {
    const urlOf = (src) => (src.match(/https:\/\/[^'"\s]+result\.css/) || [])[0];
    assert.ok(urlOf(hook), '后台没有字体源地址');
    assert.equal(urlOf(hook), urlOf(siteFont), '前后台的字体源地址不一致');
    assert.equal(urlOf(hook), urlOf(layout) || urlOf(hook));
  });

  it('编辑器按 uiStyle 判定皮肤，取不到设置时退回默认皮肤而不是崩掉', () => {
    assert.match(editor, /getSiteInfo\(\)/);
    assert.match(editor, /uiStyle !== undefined && uiStyle !== 'default'/);
    assert.match(editor, /setAppleSkin\(false\)|useState\(false\)/);
    assert.match(editor, /useApplePreviewFont\(appleSkin\)/);
    assert.match(editor, /vanblog-apple-preview/);
    assert.match(editor, /import '..\/..\/style\/apple-preview.css'/);
    // 失败要兜住（不能因为取不到站点设置就让编辑器白屏）
    assert.match(editor, /\.catch\(\(\) =>/);
  });
});
