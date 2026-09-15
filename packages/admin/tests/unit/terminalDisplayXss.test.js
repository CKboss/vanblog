const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '..', '..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const code = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('后台日志渲染不能成为存储型 XSS', () => {
  // 「日志管理 → 系统日志」把日志文本经 ansi-to-html 转成 HTML，再用
  // dangerouslySetInnerHTML 塞进 <code>。ansi-to-html 的 escapeXML 默认是 false，
  // 也就是日志里的尖括号会原样成为标签 —— 而日志里完全可能出现访客可控的字符串
  // （404 路径、上传文件名、评论作者、子进程输出里的 URL）。后台 token 在 localStorage，
  // 一旦被注入就等于交出管理员会话。
  it('TerminalDisplay 显式打开 escapeXML', () => {
    const src = code(read('src/components/TerminalDisplay/index.tsx'));
    assert.match(src, /new convert\(\{\s*escapeXML:\s*true\s*\}\)/);
  });

  it('escapeXML 确实能把标签变成实体，同时保留 ANSI 颜色', () => {
    // 直接用真库验证，别只断言源码里写了这个选项
    const Convert = require(path.join(adminRoot, 'node_modules/ansi-to-html'));
    const conv = new Convert({ escapeXML: true });
    const evil = '<img src=x onerror=alert(1)>';
    const out = conv.toHtml(evil);
    assert.ok(!out.includes('<img'), `尖括号必须被转义，实际输出：${out}`);
    assert.match(out, /&lt;img/);

    // 颜色还得照常工作，否则这个组件就没意义了
    const colored = conv.toHtml('\u001b[31mred\u001b[0m');
    assert.match(colored, /<span style="color:#[0-9a-f]{3,6}">red<\/span>/i);

    // 对照：默认配置（escapeXML: false）确实会漏出真标签，证明这不是白改
    const unsafe = new Convert().toHtml(evil);
    assert.ok(unsafe.includes('<img'), '默认配置本应漏出标签（说明这个修复是必要的）');
  });

  it('后台里唯一一处 dangerouslySetInnerHTML 就是这个组件', () => {
    // 以后再有人加第二处，这条会红，逼他至少想一下"这里的数据是谁写的"
    const { execSync } = require('node:child_process');
    const out = execSync(
      // 既要看源码后缀，也要排除 src/.umi 与 src/.umi-production：
      // 那里是 umi/mfsu 的打包缓存，产物同样是 .js，里面照样能搜到这个字符串
      `grep -rl --exclude-dir=.umi --exclude-dir=.umi-production --include='*.tsx' --include='*.jsx' --include='*.ts' --include='*.js' "dangerouslySetInnerHTML" ${JSON.stringify(
        path.join(adminRoot, 'src'),
      )} || true`,
      { encoding: 'utf8' },
    );
    const files = out.split('\n').filter(Boolean).map((f) => path.relative(adminRoot, f));
    assert.deepEqual(files, ['src/components/TerminalDisplay/index.tsx']);
  });
});
