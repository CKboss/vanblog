const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../../src/services/van-blog/exportFormats.js');

const readSrc = (rel) =>
  fs
    .readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

test('格式清单：md / mdz / zip 三项，各带一句代价说明', () => {
  const keys = core.EXPORT_FORMATS.map((f) => f.key);
  assert.deepStrictEqual(keys, ['md', 'mdz', 'zip']);
  for (const f of core.EXPORT_FORMATS) {
    assert.ok(f.label && f.label.includes(f.key === 'zip' ? '.zip' : `.${f.key}`), `${f.key} 的标签要点明扩展名`);
    assert.ok(f.hint && f.hint.length > 4, `${f.key} 必须有一句代价说明，否则用户是在盲选`);
    assert.ok(f.ext, `${f.key} 要有兜底扩展名`);
  }
  // md 的说明必须讲清"图片仍指向站点"，这是选错格式最容易踩的坑
  assert.match(core.EXPORT_FORMATS[0].hint, /图片仍指向站点/);
});

test('normalizeExportFormat：只认三个值，其它一律回落到 zip（= 老行为）', () => {
  assert.strictEqual(core.normalizeExportFormat('md'), 'md');
  assert.strictEqual(core.normalizeExportFormat('mdz'), 'mdz');
  assert.strictEqual(core.normalizeExportFormat('zip'), 'zip');
  for (const bad of [undefined, null, '', 'pdf', 'MD', 'mdzz', 0, {}, []]) {
    assert.strictEqual(core.normalizeExportFormat(bad), 'zip', `${JSON.stringify(bad)} 应回落到 zip`);
  }
});

test('fallbackFileName：三种格式各自的后缀（zip 是 -markdown.zip，与老行为一致）', () => {
  assert.strictEqual(core.fallbackFileName('我的文章', 'md'), '我的文章.md');
  assert.strictEqual(core.fallbackFileName('我的文章', 'mdz'), '我的文章.mdz');
  assert.strictEqual(core.fallbackFileName('我的文章', 'zip'), '我的文章-markdown.zip');
  assert.strictEqual(core.fallbackFileName('我的文章'), '我的文章-markdown.zip'); // 不传 = 老行为
  assert.strictEqual(core.fallbackFileName('', 'md'), 'article.md');
});

test('loadingText：md 不说"打包"（它根本不打包图片，说打包是误导）', () => {
  assert.strictEqual(core.loadingText('md'), '正在导出 Markdown…');
  assert.match(core.loadingText('mdz'), /打包/);
  assert.match(core.loadingText('zip'), /打包/);
  assert.match(core.loadingText(undefined), /打包/);
});

test('describeExportOutcome：md 格式**绝不**弹「有图片没打进包」', () => {
  // 这个 report 形状正是"带两张图的文章用 .md 导出"：assetsPacked=false、packedImages=0
  const mdReport = { imageRefs: 2, packedImages: 0, localImages: 0, remoteImages: 0, failed: 0, skipped: 0, assetsPacked: false };
  const out = core.describeExportOutcome(mdReport, 'md');
  assert.ok(out, '有图片引用时应该解释一句，而不是什么都不说');
  assert.strictEqual(out.tone, 'info');
  assert.match(out.title, /不含图片/);
  assert.ok(out.lines.join('\n').includes('2'), '要说清识别到几个引用');
  assert.match(out.lines.join('\n'), /\.mdz/, '要告诉用户想要图片该选哪个');

  // 反证：同样的 report 走 zip 格式，就是"有图片没打进包"的警告
  const zipOut = core.describeExportOutcome({ ...mdReport, assetsPacked: true, failed: 1, skipped: 1 }, 'zip');
  assert.strictEqual(zipOut.tone, 'warn');
  assert.match(zipOut.title, /没打进包/);
  assert.match(zipOut.lines.join('\n'), /导出说明\.md/);
});

test('describeExportOutcome：没问题就返回 null（不要为了弹窗而弹窗）', () => {
  assert.strictEqual(core.describeExportOutcome({ imageRefs: 0, packedImages: 0, failed: 0, skipped: 0 }, 'md'), null);
  assert.strictEqual(core.describeExportOutcome({ imageRefs: 3, packedImages: 3, failed: 0, skipped: 0 }, 'mdz'), null);
  assert.strictEqual(core.describeExportOutcome(null, 'zip'), null);
  assert.strictEqual(core.describeExportOutcome(undefined, undefined), null);
});

test('describeExportOutcome：mdz 失败清单不带"压缩包里的导出说明"（mdz 里没有那个文件）', () => {
  const out = core.describeExportOutcome({ imageRefs: 2, packedImages: 1, failed: 1, skipped: 0, failedUrls: ['https://x/y.png'] }, 'mdz');
  assert.strictEqual(out.tone, 'warn');
  assert.ok(!out.lines.join('\n').includes('导出说明.md'), 'mdz 里没有导出说明.md，不能这么指引');
  assert.deepStrictEqual(out.failedUrls, ['https://x/y.png']);
});

test('接线：服务层把 format 传给接口，并按格式决定文件名与提示', () => {
  const src = readSrc('src/services/van-blog/exportMarkdown.tsx');
  assert.match(src, /format,\s*\n?\s*\}\);|format,\n\s*\}\);/s, '请求体里必须带 format');
  assert.match(src, /normalizeExportFormat\(opts\.format\)/);
  assert.match(src, /fallbackFileName\(safeName\(opts\.title \|\| ''\), format\)/);
  assert.match(src, /loadingText\(format\)/);
  assert.match(src, /describeExportOutcome\(report, format\)/);
  // 老的"按 problems 数量弹警告"逻辑必须已经被纯函数取代（否则 md 会误报）
  assert.ok(!src.includes('const problems = (report.failed || 0) + (report.skipped || 0);'), '旧的内联判断应已移入纯函数');
});

test('接线：三个调用点都提供格式选择，而不是写死一种', () => {
  const article = readSrc('src/pages/Article/columns.jsx');
  assert.match(article, /<ExportFormatDropdown/);
  assert.match(article, /payload=\{\{ id: record\.id, type: 'article', title: record\.title \}\}/);
  assert.ok(!/downloadMarkdownExport\(\{ id: record\.id, type: 'article', title: record\.title \}\)/.test(article), '文章列表不该再写死单一格式');

  const draft = readSrc('src/pages/Draft/columes.jsx');
  assert.match(draft, /<ExportFormatDropdown/);
  assert.match(draft, /type: 'draft'/);

  const editor = readSrc('src/pages/Editor/index.jsx');
  assert.match(editor, /const handleExport = async \(format\)/, 'handleExport 必须收 format');
  assert.match(editor, /children: EXPORT_FORMATS\.map/, '编辑器菜单应是三项子菜单');
  assert.match(editor, /onClick: \(\) => handleExport\(f\.key\)/);
  // 反证：不能再有"onClick: handleExport"这种把事件对象当 format 传进去的写法
  assert.ok(!/onClick: handleExport,/.test(editor), 'onClick 直接传 handleExport 会把事件对象当 format');
  assert.match(editor, /content: value,\n\s*format,/, '两处调用都要把 format 带下去');
});

test('下拉组件用 antd4 的 overlay 写法（antd5 的 menu={{items}} 在 4.24 会静默不渲染）', () => {
  const src = readSrc('src/components/ExportFormatDropdown/index.jsx');
  assert.match(src, /overlay=\{overlay\}/);
  assert.match(src, /<Menu\s/);
  assert.match(src, /Menu\.Item key=\{f\.key\}/);
  assert.ok(!src.includes('menu={{'), '不能用 antd5 的 menu={{ items }} 写法');
  assert.match(src, /downloadMarkdownExport\(\{ \.\.\.\(payload \|\| \{\}\), format: key \}\)/);
  assert.match(src, /trigger=\{\['click'\]\}/);
});
