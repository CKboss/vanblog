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
  assert.match(src, /loadingText\(format, t\)/);
  // 🔴 期 7 第三批起 exportFormats 的函数收注入式翻译器（尾参 t）⇒ 锚点换形状，性质没放
    assert.match(src, /describeExportOutcome\(report, format, t\)/);
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

test('classifyExportFailure：无图的 mdz 是"提示 + 可一键改导 md"，不是错误', () => {
  const body = {
    statusCode: 400,
    code: 'NO_IMAGES_FOR_MDZ',
    imageRefs: 0,
    message: '这篇内容里没有可打包的图片，.mdz 与 .md 完全等价 —— 请改选 Markdown (.md)。',
  };
  const out = core.classifyExportFailure(body, 'mdz');
  assert.equal(out.kind, 'no-images');
  assert.equal(out.tone, 'info', '必须是 info，不能是 error（用户看到的就不该是红色报错）');
  assert.equal(out.offerMd, true, '要提供"改为导出 .md"这一步操作');
  assert.match(out.detail, /没有任何图片引用/);
  assert.equal(out.message, body.message, '服务端的权威文案照实显示');

  // 有图片引用但都不可打包（外链抓不到等）时，措辞不同、且带上数量
  const withRefs = core.classifyExportFailure({ ...body, imageRefs: 3 }, 'mdz');
  assert.match(withRefs.detail, /识别到 3 个图片引用/);

  // md / zip 格式不会走到这个 code；万一服务端给了，也不该提议"改导 md"（本来就是 md）
  assert.equal(core.classifyExportFailure(body, 'md').offerMd, false);
});

test('classifyExportFailure：其它失败仍是错误，且不提议改导 md', () => {
  const out = core.classifyExportFailure({ statusCode: 400, message: '不支持的导出格式：pdf' }, 'zip');
  assert.equal(out.kind, 'error');
  assert.equal(out.tone, 'error');
  assert.equal(out.offerMd, false);
  assert.equal(out.message, '不支持的导出格式：pdf');
  // 空/畸形 body 也不能崩
  assert.equal(core.classifyExportFailure(null, 'mdz').kind, 'error');
  assert.equal(core.classifyExportFailure({}, 'mdz').message, '导出失败！');
});

test('⚠️ 判据是机器可读的 code，不是中文文案（改文案不该让分支静默失效）', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src/services/van-blog/exportFormats.js'),
    'utf8',
  );
  assert.match(src, /EXPORT_NO_IMAGES_CODE = 'NO_IMAGES_FOR_MDZ'/);
  assert.match(src, /b\.code === EXPORT_NO_IMAGES_CODE/);
  // 服务层必须走分类函数，而不是自己 message.error 一把梭
  const tsx = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src/services/van-blog/exportMarkdown.tsx'),
    'utf8',
  );
  assert.match(tsx, /classifyExportFailure\(parsed, format, t\)/);
  assert.match(tsx, /failure\.kind === 'no-images'/);
  assert.match(tsx, /改为导出 Markdown \(\.md\)/);
  assert.match(tsx, /onOk: \(\) => downloadMarkdownExport\(\{ \.\.\.opts, format: 'md' \}\)/);
  // 服务端也要带 code（否则前端只能匹配文案）
  const ctrl = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', '..', 'server/src/controller/admin/export/export.controller.ts'),
    'utf8',
  );
  assert.match(ctrl, /code: 'NO_IMAGES_FOR_MDZ'/);
  assert.match(ctrl, /imageRefs: report\.imageRefs/);
});

// 🔴 期 7 第三批新增：**跨层**断言 —— 界面上那个文件名与服务端写进 zip 的那个必须**逐字相同**
const fsx = require('fs');
const pathx = require('path');

test('🔴 导出说明.md：admin 文案里引用的文件名 = 服务端产物的文件名（跨层线路契约）', () => {
  // 🔴 四层：tests/unit → tests → admin → packages → 仓库根（第一版写了三层 ⇒ 路径变成 packages/packages/…）
  const repoRoot = pathx.resolve(__dirname, '../../../..');
  const SERVER = pathx.join(repoRoot, 'packages/server/src/provider/export/markdownExport.provider.ts');
  {
    // ## 为什么要这条（2026-09-26 期 7 第三批）
    // `EXPORT_NOTE_FILENAME` 是**唯一一条刻意不翻译**的中文（棘轮预算 1、REQUIRED_EXCEPTIONS 里反向钉住）：
    // 它是服务端产物的文件名，翻译了用户就在压缩包里找不到它。
    // 🔴 但"不翻译"必须**两边一起成立** —— 服务端哪天改了名（或者反过来，有人把好心的翻译加回来），
    // 界面就会指向一个不存在的文件，而且**所有测试照旧全绿**（没有任何一条断言跨这两层）。
    const core = require('../../src/services/van-blog/exportFormats.js');
    assert.equal(core.EXPORT_NOTE_FILENAME, '导出说明.md', 'admin 这边必须是这个字面名');
    assert.ok(fsx.existsSync(SERVER), `找不到服务端文件：${SERVER}`);
    const src = fsx.readFileSync(SERVER, 'utf8');
    assert.match(
      src,
      /relativePath:\s*'导出说明\.md'/,
      '🔴 服务端不再把说明文件写成 导出说明.md ⇒ admin 的 EXPORT_NOTE_FILENAME 与那条文案必须同步改（这是线路契约）',
    );
    // 🔴 文案里必须是**占位符**，不是把文件名写死在语言包里（否则 en-US 会出现汉字、zh-TW 会出现简体字）
    const packs = ['zh-CN', 'zh-TW', 'en-US'].map((l) => {
      const p = pathx.join(repoRoot, `packages/admin/src/locales/${l}.ts`);
      const m = fsx.readFileSync(p, 'utf8').match(/'export\.outcomeZipNote':\s*'([^']*)'/);
      assert.ok(m, `${l} 包里必须有 export.outcomeZipNote`);
      return m[1];
    });
    for (const v of packs) {
      assert.ok(v.includes('{note}'), `export.outcomeZipNote 必须用 {note} 占位符，实际：${v}`);
      assert.ok(!v.includes('导出说明'), `语言包里不许出现那个文件名（它是线路契约、由调用期喂进去），实际：${v}`);
    }
    // 🔴 组装出来必须与 identity 时代的文案逐字相同（这是"不传 t 时输出不变"的具体一例）
    const out = core.describeExportOutcome({ imageRefs: 2, packedImages: 1, failed: 1 }, 'zip');
    assert.ok(
      out.lines.some((l) => l === `压缩包里的「${core.EXPORT_NOTE_FILENAME}」有完整清单。`),
      `identity 路径下那句话必须逐字不变，实际：${JSON.stringify(out.lines)}`,
    );
  }
});

// 🔴 期 7 第三批：注入翻译器之后，**identity 与注入两条路径都要对**（与 revisionCore 那组同一手法）。
// ⚠️ 其中"无图选 .mdz"那条分支在**浏览器里走不到**（umi-request 对 400 直接 reject，嗅探分支成了死代码，
//    实测浮层只有 `http error`；服务端契约本身是对的：400 + NO_IMAGES_FOR_MDZ）⇒ 只能在这里验（§7.162 E）。
const pathL = require('node:path');
const astInv = require(pathL.resolve(__dirname, '../../../../scripts/i18n/astInventory.js'));
const adminRootL = pathL.resolve(__dirname, '../..');
const packOfL = (l) => astInv.readPack(pathL.join(adminRootL, `src/locales/${l}.ts`), `${l}.ts`);
// 🔴 用**真的 react-intl** 来格式化，不要自己实现 ICU：
//    英文那几条是 `{refs, plural, one {# image reference} other {# image references}}`，
//    自己写的"只替换 {name}"的假 t 会把整段 plural 原样吐出来（第一版就是这么红的）。
//    👉 这也是本项目"不要复刻别人的公式/语法"那条规矩的又一次应用（同族：encryptPwd 的 6 次 sha256）。
// 🔴 `react-intl` 不是 admin 的**直接**依赖（它是 `@umijs/plugin-locale` 带进来的），
//    在 pnpm 的 store 里 ⇒ 直接 `require('react-intl')` 会 MODULE_NOT_FOUND。
//    这里**按目录形状找**（`node_modules/.pnpm/react-intl@*/node_modules/react-intl`），不写死版本号；
//    找不到就**大声失败**（不许静默跳过 —— 那几条 ICU 复数断言是本批唯一的复数证据）。
const repoRootL = pathL.resolve(__dirname, '../../../..');
const pnpmDirL = pathL.join(repoRootL, 'node_modules/.pnpm');
const reactIntlDirL = (() => {
  if (!fs.existsSync(pnpmDirL)) return null;
  const hit = fs.readdirSync(pnpmDirL).filter((d) => d.startsWith('react-intl@')).sort().pop();
  return hit ? pathL.join(pnpmDirL, hit, 'node_modules/react-intl') : null;
})();
assert.ok(reactIntlDirL && fs.existsSync(reactIntlDirL),
  `🔴 在 ${pnpmDirL} 下找不到 react-intl（本文件要用**真的 ICU 实现**验复数，不接受自己实现的替代品）`);
// eslint-disable-next-line import/no-dynamic-require
const { createIntl } = require(reactIntlDirL);
const makeTL = (locale) => {
  const pack = packOfL(locale);
  const intl = createIntl({ locale, messages: pack, defaultLocale: 'en-US' });
  return (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
};

test('🔴 注入 t 之后：导出下拉三项、下载中提示、结果汇总都是英文（identity 路径仍逐字是中文）', () => {
  const en = makeTL('en-US');
  const tw = makeTL('zh-TW');
  const formats = core.exportFormats(en);
  assert.equal(formats.length, 3);
  assert.equal(formats[0].label, 'Markdown (.md)', '.md 那项的标签本来就没有中文 ⇒ 三种语言一样');
  assert.equal(formats[1].label, 'Typora image bundle (.mdz)');
  assert.equal(formats[2].label, 'Everything in one archive (.zip)');
  assert.equal(formats[0].hint, 'Body only; images still point at the site (fastest)');
  // 🔴 key/ext 是**契约字段**，不许跟着语言变（服务端与文件名都靠它）
  assert.deepEqual(formats.map((f) => f.key), ['md', 'mdz', 'zip']);
  assert.deepEqual(formats.map((f) => f.ext), ['.md', '.mdz', '-markdown.zip']);
  assert.deepEqual(core.exportFormats().map((f) => f.key), ['md', 'mdz', 'zip'], 'identity 路径的 key 顺序不变');
  assert.equal(core.loadingText('md', en), 'Exporting Markdown…');
  assert.equal(core.loadingText('zip', en), 'Packing Markdown and images…');
  assert.equal(core.loadingText('zip'), '正在打包 Markdown 与图片…', 'identity 路径逐字不变');
  assert.equal(core.loadingText('zip', tw), '正在打包 Markdown 與圖片…');
});

test('🔴 结果汇总：英文的计数句必须是 ICU 复数**渲染后**的形状（不是字面 {refs}）', () => {
  const en = makeTL('en-US');
  const out = core.describeExportOutcome(
    { imageRefs: 1, packedImages: 1, localImages: 1, remoteImages: 0, failed: 1, skipped: 2 },
    'zip',
    en,
  );
  assert.equal(out.title, 'Export finished, but some images did not make it into the archive');
  assert.equal(
    out.lines[0],
    'Found 1 image reference in the body and packed 1 image (1 local, 0 external).',
    '🔴 单数必须是 "1 image reference" / "1 image"（ICU plural 生效），实测：' + out.lines[0],
  );
  assert.equal(out.lines[1], '1 image could not be fetched; the md keeps the original links.');
  assert.equal(out.lines[2], 'Skipped 2 references (data URIs, relative paths that could not be resolved, and so on).');
  assert.equal(out.lines[3], `The ${core.EXPORT_NOTE_FILENAME} inside the archive has the full list.`);
  assert.ok(!out.lines.join(' ').includes('{'), '🔴 任何一行都不许留下字面占位符');
  // 复数形状
  const plural = core.describeExportOutcome({ imageRefs: 3, packedImages: 2, failed: 0, skipped: 0 }, 'md', en);
  assert.equal(
    plural.lines[0],
    'Found 3 image references in the body; the links still point at the site. That is what the .md format does.',
  );
  // identity 路径仍逐字是中文（黄金样本在上面那几组里，这里再钉一次"两条路径不同"）
  assert.ok(core.describeExportOutcome({ imageRefs: 3 }, 'md').lines[0].includes('正文里识别到 3 个图片引用'));
});

test('🔴 无图选 .mdz：失败分类的文案（浏览器走不到这条分支 ⇒ 只能在这里验）', () => {
  const en = makeTL('en-US');
  const tw = makeTL('zh-TW');
  const body = { statusCode: 400, code: 'NO_IMAGES_FOR_MDZ', imageRefs: 0, message: '这篇内容里没有可打包的图片' };
  const out = core.classifyExportFailure(body, 'mdz', en);
  assert.equal(out.kind, 'no-images');
  assert.equal(out.message, '这篇内容里没有可打包的图片', '🔴 服务端的 message 是**权威文案**，照实显示（不翻译）');
  assert.equal(out.tone, 'info', '这不是失败 ⇒ 必须是 info，不能弹红');
  assert.equal(out.offerMd, true, 'mdz 才需要"一键改导 .md"');
  assert.equal(out.detail, 'The body has no image references at all, so .mdz and .md would be identical.');
  const withRefs = core.classifyExportFailure({ ...body, imageRefs: 2 }, 'mdz', en);
  assert.equal(
    withRefs.detail,
    'Found 2 image references in the body, but none of them is a local or fetchable image that can go into a .mdz.',
  );
  // 繁体
  assert.equal(core.classifyExportFailure({ code: 'NO_IMAGES_FOR_MDZ', imageRefs: 0 }, 'mdz', tw).detail,
    '正文裡沒有任何圖片引用，.mdz 與 .md 的內容完全相同。');
  // 服务端没给 message 时才用我们的兜底
  assert.equal(core.classifyExportFailure({ code: 'NO_IMAGES_FOR_MDZ' }, 'mdz', en).message,
    'This post has no images, so there is no .mdz.');
  // 真错误那条
  const err = core.classifyExportFailure({ message: 'boom' }, 'zip', en);
  assert.equal(err.kind, 'error');
  assert.equal(err.message, 'boom');
  assert.equal(core.classifyExportFailure({}, 'zip', en).message, 'Export failed');
  assert.equal(core.classifyExportFailure({}, 'zip').message, '导出失败！', 'identity 路径逐字不变');
});
