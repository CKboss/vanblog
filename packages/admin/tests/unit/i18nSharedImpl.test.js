/**
 * 🔴 钉住"i18n 的 AST 逻辑只有一份实现"（防止守卫与工具分叉）。
 *
 * ## 为什么需要这条守卫
 * 本轮之前有两份各自为政的 AST/正则逻辑：`i18nHardcodedRatchet.test.js` 内联的 `countBare`，
 * 和一次性的分类脚本。🔴 **两处实现同一件事就一定会漂移** —— 而漂移的表现是
 * "两个工具报出不同的数字，而你无法判断哪个对"（本仓库已多次为此付出代价）。
 * 所以现在两边都 require `scripts/i18n/astInventory.js`，**由本守卫钉住这件事**。
 *
 * ## 🔴 判据是"行为等价 + 结构上没有第二份实现"，不是"文件存在"
 * "某个文件存在"是本仓库已被证明无效的弱尺子之一（它证明不了任何行为）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const ADMIN = path.resolve(__dirname, '../..');
const SHARED = path.join(ROOT, 'scripts/i18n/astInventory.js');
const CLI = path.join(ROOT, 'scripts/i18n/inventory.js');
const RATCHET = path.join(ADMIN, 'tests/unit/i18nHardcodedRatchet.test.js');
const NAMING = path.join(ADMIN, 'tests/unit/i18nKeyNaming.test.js');
const PLURAL = path.join(ADMIN, 'tests/unit/i18nPluralConvention.test.js');

// 🔴 共享模块（唯一权威实现）
const astInventory = require(SHARED);

test('i18n 共享实现 · 反空转：这些文件都真实存在且非空', () => {
  for (const f of [SHARED, CLI, RATCHET, NAMING, PLURAL]) {
    assert.ok(fs.existsSync(f), `文件不存在：${f}`);
    assert.ok(fs.statSync(f).size > 500, `文件异常小（${fs.statSync(f).size} B）：${f}`);
  }
  // 🔴 共享模块必须真的导出了这些 API（否则下面所有断言都在测空气）
  for (const fn of [
    'loadParser',
    'parseSource',
    'collectChinese',
    'bareChinese',
    'bareChineseFromFile',
    'readPack',
    'validateKeyShape',
    'needsIcuPlural',
  ]) {
    assert.strictEqual(typeof astInventory[fn], 'function', `共享模块没有导出 ${fn}（消费方会拿到 undefined）`);
  }
  assert.ok(Array.isArray(astInventory.REGISTERED_KEY_GROUPS) && astInventory.REGISTERED_KEY_GROUPS.length >= 7);
  assert.ok(Array.isArray(astInventory.GRANDFATHERED_KEYS) && astInventory.GRANDFATHERED_KEYS.length === 20);
});

test('i18n 共享实现 · 三个消费方都 require 同一份模块（结构判据）', () => {
  const consumers = { [CLI]: null, [RATCHET]: null, [NAMING]: null, [PLURAL]: null };
  for (const f of Object.keys(consumers)) {
    const src = fs.readFileSync(f, 'utf8');
    // 🔴 剥掉注释再判：注释里提到模块名不算"用了它"
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
      .join('\n');
    const m = stripped.match(/require\((['"])([^'"]*astInventory\.js)\1\)/);
    assert.ok(m, `${path.relative(ROOT, f)} 没有 require astInventory.js ⇒ 它可能自己实现了一份`);
    consumers[f] = m[2];
  }
  // 🔴 四个消费方 require 的必须是同一个文件（解析成绝对路径后比较）
  const resolved = new Set();
  for (const [f, spec] of Object.entries(consumers)) {
    resolved.add(path.resolve(path.dirname(f), spec));
  }
  assert.strictEqual(resolved.size, 1, `消费方 require 到了不同的文件：${[...resolved].join(', ')}`);
  assert.strictEqual([...resolved][0], SHARED, 'require 解析出来的不是 scripts/i18n/astInventory.js');
});

test('i18n 共享实现 · 没有第二份 AST 实现（守卫里不许再内联 babel 解析）', () => {
  // 🔴 判据：消费方里不许出现"自己 parse AST"的形状。
  //    以前 i18nHardcodedRatchet 里有 loadParser() 与 parser.parse(...)，重构后应当只剩 require。
  for (const f of [RATCHET, NAMING, PLURAL]) {
    const src = fs.readFileSync(f, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
      .join('\n');
    assert.ok(
      !/function\s+loadParser\s*\(/.test(stripped),
      `${path.relative(ROOT, f)} 里又出现了自己的 loadParser() ⇒ AST 实现分叉了，请改成 require 共享模块`,
    );
    assert.ok(
      !/\.parse\(\s*src\s*,\s*\{[\s\S]*?plugins\s*:/.test(stripped),
      `${path.relative(ROOT, f)} 里出现了自己的 parser.parse(..., {plugins}) ⇒ AST 实现分叉了`,
    );
  }
  // 🔴 反向：共享模块里**必须**有那份实现（否则上面两条会变成"两边都没有"的假绿）
  const sharedSrc = fs.readFileSync(SHARED, 'utf8');
  assert.ok(/function\s+loadParser\s*\(/.test(sharedSrc), '共享模块里没有 loadParser（实现被删了？）');
  assert.ok(/BABEL_PLUGINS/.test(sharedSrc), '共享模块里没有 BABEL_PLUGINS（插件列表被内联回去了？）');
  // 🔴 插件列表必须含 optionalChaining（漏了它 src/app.jsx 会解析失败，这是实测踩过的坑）
  assert.ok(
    astInventory.BABEL_PLUGINS.some((p) => p === 'optionalChaining'),
    'BABEL_PLUGINS 里没有 optionalChaining ⇒ src/app.jsx 会解析失败（本仓库实测踩过）',
  );
});

test('i18n 共享实现 · 行为等价：共享模块的结果与守卫的既有基线逐字一致', () => {
  // 🔴 这条是"行为等价"的实证：用共享模块重算棘轮的基线，必须与棘轮里写死的数字一致。
  const EXPECTED = {
    'src/app.jsx': 18,
    'src/components/ThemeButton/index.tsx': 0,
    'src/components/LogoutButton/index.jsx': 0,
    'src/pages/InitPage/index.tsx': 1,
    'src/pages/InitPage/RestoreFromBackup.tsx': 0,
    'src/pages/InitPage/setupKeyCore.js': 4,
    'src/pages/InitPage/restoreCore.js': 16,
    'src/pages/user/Login/index.jsx': 1,
    'src/pages/user/Restore/index.jsx': 8,
  };
  let total = 0;
  for (const [rel, want] of Object.entries(EXPECTED)) {
    const got = astInventory.bareChineseFromFile(path.join(ADMIN, rel), rel).size;
    assert.strictEqual(
      got,
      want,
      `共享模块算出的 ${rel} 裸中文条数（${got}）与本处记录的棘轮基线（${want}）不一致。两种可能：\n` +
        `  ① 🔴 **基线过期了**：有人改了 ${rel}（新增/删除了硬编码中文），而 i18nHardcodedRatchet 的 BUDGET\n` +
        '     已被同步更新、本处这份副本没跟上 ⇒ 请把本处 EXPECTED 同步成同一个数字（🔴 两处必须一致）；\n' +
        '  ② 🔴 **两份实现分叉了**：共享模块的语义与棘轮不再一致 ⇒ 那是真缺陷，要查 astInventory.js。\n' +
        '  判别方法：看 i18nHardcodedRatchet 那条"逐文件预算"断言是红是绿 —— 它绿而本条红 ⇒ 是 ①；两条都红 ⇒ 先看它。',
    );
    total += got;
  }
  assert.strictEqual(total, 48, `裸中文总数应当是 48（棘轮的 TOTAL_BUDGET），实际 ${total}`);
  // 🔴 语言包解析也要与既有基线一致（114/114/114）
  for (const l of ['zh-CN', 'zh-TW', 'en-US']) {
    const n = Object.keys(astInventory.readPack(path.join(ADMIN, `src/locales/${l}.ts`), l)).length;
    assert.ok(n >= 114, `${l}.ts 解析出 ${n} 个 key，低于基线 114`);
  }
});

test('i18n 共享实现 · 尺子反证：合成输入必须被正确分类（证明判据真的在判）', () => {
  // ① 裸中文必须数得出
  const bare = astInventory.bareChinese(`const a = '未翻译的中文';\nexport default a;`, 'synthetic');
  assert.strictEqual(bare.size, 1, '尺子失效：裸中文字面量没被数出来');
  assert.ok([...bare][0].includes('未翻译的中文'));
  // ② defaultMessage 位必须被排除（这是棘轮语义的核心）
  const withDefault = astInventory.bareChinese(
    `const x = t('common.about', '关于');\nconst y = intl.formatMessage({ id: 'a.b', defaultMessage: '中文' });`,
    'synthetic',
  );
  assert.strictEqual(withDefault.size, 0, `defaultMessage 位没被排除，实际数出：${[...withDefault].join(' | ')}`);
  // ③ 🔴 但 t() 的**第 1 个**实参（id）照常遍历 —— 防止"index 写反"那个历史缺陷复活
  const idHasHan = astInventory.bareChinese(`const x = t('中文ID', 'about');`, 'synthetic');
  assert.strictEqual(idHasHan.size, 1, 't() 的第 1 个实参应当照常统计（index 判据可能写反了）');
  // ④ JSX 文本节点必须数得出（正则盘点最容易漏的一类）
  const jsx = astInventory.bareChinese(`const C = () => <div>你好世界</div>;`, 'synthetic');
  assert.strictEqual(jsx.size, 1, 'JSX 文本节点没被数出来');
  assert.ok([...jsx][0].startsWith('JSX:'), 'JSX 桶应当带 JSX: 前缀（口径区分）');
  // ⑤ 注释不计入裸中文，但单独计数
  const cmt = astInventory.collectChinese(`// 这是注释里的中文\nconst a = 1;\n`, 'synthetic', {});
  assert.strictEqual(cmt.literals.size, 0, '注释里的中文不应算作字面量');
  assert.strictEqual(cmt.comments, 1, '注释里的中文行数应当单独计为 1');
  // ⑥ 🔴 解析失败必须抛错，不能当成 0 条（fail-loud）
  assert.throws(
    () => astInventory.parseSource('const = ;', 'broken.js'),
    /解析失败/,
    '解析失败没有抛错 ⇒ 会被当成"0 条"，那是最坏的假阴性',
  );
});
