const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const adminRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(adminRoot, '../..');
const TOOL = path.join(repoRoot, 'scripts/i18n/wrapTCalls.js');

/**
 * 🔴 `scripts/i18n/wrapTCalls.js` 的守卫（2026-09-26 期 6 第五批加的工具）。
 *
 * ## 为什么这个工具要有守卫
 * 它做的事是**批量改写源码**：一旦判据写宽，就会把不该改的地方改掉（注释里的中文、`console.*` 的实参、
 * 已经是 `t(...)` 的 defaultMessage），而且改完文件**照样能解析** ⇒ 只有守卫能拦住。
 * 本项目"新工具自己也要有变异对照"这条规矩（§7.159 A / §7.160 A）在这里同样适用。
 */
function run(srcText, map, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-wrap-'));
  const file = path.join(dir, 'Demo.jsx');
  fs.writeFileSync(file, srcText);
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify(map));
  const args = [TOOL, file, mapFile];
  if (opts.hookAnchor) args.push('--hook-anchor', opts.hookAnchor);
  const out = execFileSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
  return { out, code: fs.readFileSync(file, 'utf8') };
}

test('🔴 wrapTCalls：普通字面量 / JSX 属性 / JSX 文本三种形状都要改对，且**只改映射表里的**', () => {
  const src = [
    "import { Button } from 'antd';",
    'export default function Demo() {',
    "  const a = '导出失败！';",
    '  return (',
    '    <div>',
    '      <Button label="整站备份与恢复">导出</Button>',
    '      <p>还没有整站备份</p>',
    "      <span>{'不在映射表里的中文'}</span>",
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  const { out, code } = run(src, {
    '导出失败！': 'backup.exportFailed',
    '整站备份与恢复': 'backup.title',
    '还没有整站备份': 'backup.empty',
    '导出': 'backup.export',
  });
  // ① 普通字面量
  assert.ok(code.includes("const a = t('backup.exportFailed', '导出失败！');"), code);
  // ② 🔴 JSX 属性里的字符串必须**补上花括号**（`label="…"` → `label={t(…)}`），否则语法就错了
  assert.ok(code.includes("label={t('backup.title', '整站备份与恢复')}"), code);
  // ③ JSX 文本
  assert.ok(code.includes("{t('backup.empty', '还没有整站备份')}"), code);
  assert.ok(code.includes(">{t('backup.export')}</Button>") || code.includes("{t('backup.export', '导出')}"), code);
  // ④ 映射表里没有的**不许动**（否则就是"顺手翻译"，会改到不该改的地方）
  assert.ok(code.includes("'不在映射表里的中文'"), '不在映射表里的中文被改掉了');
  // ⑤ 报告里必须说清"还剩几条"（0 才是清完；不为 0 就是映射表不全）
  // 🔴 5 条 = 4 条映射表里的 + 1 条不在表里的（`'不在映射表里的中文'`）⇒ 改完剩 1
  assert.match(out, /裸中文：5 → 1/, out);
  assert.match(out, /🔴 还没清完/, out);
});

test('🔴 wrapTCalls：**跨行**的 JSX 文本按"折叠后"的形状匹配，且 defaultMessage 写的就是渲染出来的那一份', () => {
  // ## 为什么要这条（2026-09-26 期 6 第五批，Backup.jsx 实测）
  // React 会把 JSX 文本里的"换行 + 缩进"折叠成**一个空格**，所以源码里跨三行的说明文字，
  // 渲染出来是一行。第一版工具只按 `trim()` 查映射表 ⇒ 这类文本**一个都匹配不上**（静默漏改），
  // 而"漏改"正是这个工具最坏的失败模式（要靠活体反向判据才发现，那时栈已经建好了）。
  const src = [
    'export default function Demo() {',
    '  return (',
    '    <div>',
    '      压缩格式默认自动挑本机最强的（一般是 zstd -19）；',
    '      归档存在服务器的备份目录里。',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  const folded = '压缩格式默认自动挑本机最强的（一般是 zstd -19）； 归档存在服务器的备份目录里。';
  const { code, out } = run(src, { [folded]: 'backup.compressorNote' });
  assert.ok(
    code.includes(`{t('backup.compressorNote', '${folded}')}`),
    '🔴 跨行 JSX 文本没被改写，或 defaultMessage 不是"折叠后"的那一份：\n' + code,
  );
  assert.match(out, /裸中文：1 → 0/, out);
});

test('🔴 wrapTCalls：注释、console.* 实参、以及已经是 t() 的 defaultMessage **都不许被改**', () => {
  const src = [
    'export default function Demo() {',
    '  // 这行注释里有 导出失败！ 但不该被改',
    "  console.error('导出失败！', err);",
    "  const x = t('backup.exportFailed', '导出失败！');",
    "  const y = intl.formatMessage({ id: 'backup.title', defaultMessage: '整站备份与恢复' });",
    "  const z = '导出失败！';",
    '  return z;',
    '}',
    '',
  ].join('\n');
  const { code } = run(src, { '导出失败！': 'backup.exportFailed', '整站备份与恢复': 'backup.title' });
  assert.ok(code.includes('// 这行注释里有 导出失败！ 但不该被改'), '注释被改了');
  assert.ok(code.includes("console.error('导出失败！', err);"), 'console.* 的实参被改了（口径与 bareChinese 不一致）');
  assert.ok(code.includes("t('backup.exportFailed', '导出失败！')"), '已有的 t() 被重复包了一层');
  assert.ok(!/t\('backup\.exportFailed', t\(/.test(code), 'defaultMessage 位被改写了（会破坏逐字对账）');
  assert.ok(code.includes("defaultMessage: '整站备份与恢复'"), 'formatMessage 的 defaultMessage 被改了');
  // 🔴 但该改的那一处必须改到
  assert.ok(code.includes("const z = t('backup.exportFailed', '导出失败！');"), code);
});

test('🔴 wrapTCalls：模板字符串**不动**，但必须逐条列出来（那是需要人工收成 ICU 整句的地方）', () => {
  const src = [
    'export default function Demo() {',
    '  const n = 3;',
    '  return `已转存 ${n} 张图片`;',
    '}',
    '',
  ].join('\n');
  const { out, code } = run(src, { '已转存': 'backup.x' });
  assert.ok(code.includes('return `已转存 ${n} 张图片`;'), '模板字符串被改写了（本工具刻意不动它们）');
  assert.match(out, /模板字符串 1 处要\*\*手工\*\*改成 ICU 整句/, out);
});

test('🔴 wrapTCalls：--hook-anchor 命中不是恰好 1 次时必须**拒绝写文件**（fail-loud，不留半成品）', () => {
  const src = ['export default function Demo() {', '  return null;', '}', ''].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-wrap-'));
  const file = path.join(dir, 'Demo.jsx');
  fs.writeFileSync(file, src);
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, '{}');
  let rc = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, file, mapFile, '--hook-anchor', '不存在的锚点'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    rc = e.status;
    stderr = String(e.stderr || '') + String(e.stdout || '');
  }
  assert.strictEqual(rc, 3, '锚点命中 0 次应当以退出码 3 失败');
  assert.match(stderr, /没有插入 hook/, stderr);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), src, '🔴 失败时不许留下改了一半的文件');
});

test('🔴 wrapTCalls：**模块作用域**的字面量绝不改写（那里没有 t ⇒ 加载期 ReferenceError ⇒ 整页白屏）', () => {
  // ## 这条守卫是被真事故逼出来的（2026-09-26 期 6 第六批，`Backup.jsx`）
  // `const FORMAT_LABELS = { auto: '自动（挑本机最强的）', … }` 是**模块级常量**，工具照映射表把它包成了
  // `t('backup.compressorAuto', …)` ⇒ 模块加载期 `t` 不存在 ⇒ 整个路由 chunk 抛 ReferenceError。
  // 🔴 危害在于它**全绿**：`umi build` 成功（语法没问题）、`node --test` 全绿（没有测试渲染那个页面）、
  // 类型门禁也绿（.jsx 不参与 tsc）⇒ **只有浏览器活体**能看见（页面白屏、内容区一片空）。
  // 正确做法是把常量改成函数版（收尾参 `t = IDENTITY_T`），那是**人的判断**，工具不该替它决定。
  const src = [
    "import { Card } from 'antd';",
    '',
    'const FORMAT_LABELS = {',
    "  auto: '自动（挑本机最强的）',",
    "  zstd: 'zstd -19 --long（最小且快，推荐）',",
    '};',
    '',
    'export default function Demo() {',
    '  return <Card title="整站备份与恢复">{FORMAT_LABELS.auto}</Card>;',
    '}',
    '',
  ].join('\n');
  const { out, code } = run(src, {
    '自动（挑本机最强的）': 'backup.compressorAuto',
    'zstd -19 --long（最小且快，推荐）': 'backup.compressorZstd',
    '整站备份与恢复': 'backup.fullSectionTitle',
  });
  // ① 模块作用域那两条**必须原样留着**
  assert.ok(code.includes("  auto: '自动（挑本机最强的）',"), '🔴 模块级常量被包了 t（会在加载期炸）：\n' + code);
  assert.ok(code.includes("  zstd: 'zstd -19 --long（最小且快，推荐）',"), '🔴 同上');
  // ② 组件里那条必须改到
  assert.ok(code.includes("title={t('backup.fullSectionTitle', '整站备份与恢复')}"), code);
  // ③ 报告必须**说出来**（沉默跳过 = 下一个人以为清完了）
  assert.match(out, /模块作用域\*\* 2 处\*\*没有改写/, out);
  assert.match(out, /手工改成函数版/, out);
  // ④ 🔴 "还剩几条"不许因为模块作用域没改就报 0（否则工具会说"清完了"）
  assert.match(out, /裸中文：3 → 2/, out);
  assert.match(out, /🔴 还没清完/, out);
  assert.match(out, /其中 2 处是模块作用域/, out);
});
