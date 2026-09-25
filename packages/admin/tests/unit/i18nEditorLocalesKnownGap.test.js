/**
 * 🔴 **这条守卫钉住的是一个「已知缺陷的现状」，不是「期望行为」。**
 *
 * 事实（2026-09-25 实测）：`src/components/Editor/locales.ts` **名字叫 locales，实际只导出一个
 * 单语常量 `cn`**，而 `src/components/Editor/index.tsx` 把它**硬接线**到 4 处（数学插件、`gfm`、
 * `mermaid`、以及一个 JSX 的 `locale={cn}`）。它对 umi 的 locale 运行时
 * （`getLocale` / `useIntl` / `setLocale` / `getDirection` / `formatMessage`）引用数 **全部为 0**
 * ⇒ 🔴 **编辑器界面永远是中文，切换语言不会跟随。**
 *
 * ⚠️ 而且它是**嵌套对象**形状（第三方插件要求 `locale` 是一个对象树），与本项目「扁平 key + `t()`」
 * 的约定不兼容 ⇒ 这是**框架问题**，属多语言路线图的**期 2**，不是顺手能改的体力活。
 *
 * 🔴 **所以本守卫的用途是「防止误解」，而不是「防止退化」**：
 *   · 它挡住的是「有人以为编辑器已经国际化了」——因为文件名和形状都太像语言包；
 *   · 🔴 **期 2 真正改造它的时候，这条守卫会被有意改红**（那时应当删掉或反转这里的断言，
 *     并改成钉「编辑器跟随语言」的正向性质）。**看到它红，先确认是不是期 2 在动手。**
 *
 * 🔴 判据全部是**源码形状**（这条缺陷无法用「产物里搜字符串」证明——本仓库已有四把弱尺子的教训：
 * 「.umi 里生成了文件」「产物里搜到转义的语言名」「localeInfo 注册了三份」「静态 DOM dump 里搜到语言名」
 * 都不能证明「用户看得到、用得了」）。要证明「编辑器真的跟随语言」只能在浏览器里切一次，那属期 2 的验收。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_SRC = path.resolve(__dirname, '../../src');
const LOCALES_TS = path.join(ADMIN_SRC, 'components/Editor/locales.ts');
const EDITOR_TSX = path.join(ADMIN_SRC, 'components/Editor/index.tsx');

// 🔴 复用仓库唯一的 AST 实现（不要在这里重写一份中文盘点逻辑 —— 那会造成第二处会漂移的口径）
const INVENTORY = path.resolve(__dirname, '../../../../scripts/i18n/astInventory.js');

const readOrFail = (p) => {
  assert.ok(fs.existsSync(p), `必须存在：${p}（找不到就说明文件被改名/挪走了，请先更新本守卫的路径）`);
  return fs.readFileSync(p, 'utf8');
};

test('已知缺陷现状：Editor/locales.ts 是单语常量、不跟随语言（期 2 改造时本条应当被有意改红）', async (t) => {
  const locales = readOrFail(LOCALES_TS);
  const editor = readOrFail(EDITOR_TSX);

  await t.test('反空转：这个文件真的有大量中文（否则下面所有「0 引用」都可能是空文件造成的假绿）', () => {
    assert.ok(fs.existsSync(INVENTORY), `共享 AST 模块必须在：${INVENTORY}`);
    const m = require(INVENTORY);
    const r = m.collectChinese(locales, 'Editor/locales.ts');
    const lits = r.literals instanceof Set ? Array.from(r.literals) : r.literals || [];
    // 🔴 上一轮 AST 实测是 60 条中文字面量；这里只钉一个宽松下界，避免它变成"精确值维护负担"
    assert.ok(lits.length >= 40, `Editor/locales.ts 的中文字面量应当 ≥40（实测 ${lits.length}）—— 若真的变少了，说明期 2 已经动手，本守卫应当被删掉或反转`);
    // 🔴 抽样核实：里面确实有编辑器界面文案（不是注释噪音）
    assert.ok(lits.some((s) => String(s).length >= 2), '中文字面量里应当有实际的界面文案');
  });

  await t.test('它只导出一个名为 cn 的单语常量（没有 en / zhTw / 任何第二份语言）', () => {
    const exports = locales.match(/^export\s+(?:const|let|var|function|default)\s+([A-Za-z0-9_]+)?/gm) || [];
    assert.ok(exports.length >= 1, '至少要有一个导出，否则这个文件没被用');
    assert.ok(/^export\s+const\s+cn\s*=/m.test(locales), "必须有 `export const cn =`（当前形状）");
    // 🔴 关键：不许出现第二种语言的导出（一旦出现，说明期 2 已经开始，本守卫要跟着改）
    for (const bad of ['export const en', 'export const zhTw', 'export const zhTW', 'export const enUS', 'export const locales']) {
      assert.ok(!locales.includes(bad), `🔴 出现了 ${bad} —— 说明 Editor/locales.ts 已经不再是单语常量了，本守卫钉的是「已知缺陷的现状」，请把它删掉或反转成钉「编辑器跟随语言」`);
    }
    // 🔴 只有一个具名导出
    assert.strictEqual(exports.length, 1, `导出应当恰好 1 个（实测 ${exports.length}）：${exports.join(' | ')}`);
  });

  await t.test('它对 umi 的 locale 运行时引用数为 0（这就是「不跟随语言」的直接证据）', () => {
    // 🔴 逐个符号钉，而不是笼统搜 "umi"：将来若只接了一半（例如只 import 了 getLocale 却没用），
    //    这条会红，从而逼一次有意识的处理。
    const RUNTIME_SYMBOLS = ["from 'umi'", 'getLocale', 'useIntl', 'setLocale', 'getDirection', 'formatMessage', 'getIntl'];
    for (const sym of RUNTIME_SYMBOLS) {
      const n = locales.split(sym).length - 1;
      assert.strictEqual(n, 0, `🔴 Editor/locales.ts 里出现了 ${sym}（${n} 次）—— 说明它开始接 umi 的 locale 运行时了，本守卫钉的是「已知缺陷的现状」，请更新它`);
    }
  });

  await t.test('Editor/index.tsx 把 cn 硬接线到恰好 4 处（数字变了要来看一眼）', () => {
    assert.ok(/import\s*\{\s*cn\s*\}\s*from\s*'\.\/locales'/.test(editor), "必须是 `import { cn } from './locales'`（当前形状）");
    // 三种形状：`locale: cn`（对象属性，3 处）与 `locale={cn}`（JSX，1 处）
    const propHits = (editor.match(/locale:\s*cn\b/g) || []).length;
    const jsxHits = (editor.match(/locale=\{cn\}/g) || []).length;
    const total = propHits + jsxHits;
    assert.strictEqual(total, 4, `cn 的硬接线处应当恰好 4（实测 ${total}：属性 ${propHits} + JSX ${jsxHits}）—— 变了说明编辑器的接线被改过，请核实并更新本守卫`);
    // 🔴 反向：这 4 处都不经过任何 locale 运行时（即"静态接线"）
    assert.ok(!/locale:\s*(getLocale|getIntl|currentLocale)/.test(editor), '编辑器的 locale 接线目前是静态的；若它开始用 getLocale/getIntl，说明期 2 已动手 ⇒ 本守卫该改');
  });

  await t.test('尺子反证：本守卫真的能抓到「接上了 locale 运行时」这个改动', () => {
    // 🔴 合成输入，不碰真实文件：证明上面那条"0 引用"断言不是恒真的
    const fakeWired = "import { getLocale } from 'umi';\nexport const cn = { a: '甲' };\n";
    const RUNTIME_SYMBOLS = ["from 'umi'", 'getLocale', 'useIntl', 'setLocale', 'getDirection', 'formatMessage', 'getIntl'];
    const hits = RUNTIME_SYMBOLS.filter((sym) => fakeWired.includes(sym));
    assert.ok(hits.length >= 2, `合成的「已接线」文本应当被至少 2 个符号命中（实测 ${hits.length}：${hits.join(', ')}）⇒ 证明判据不是恒真`);
    // 🔴 并且证明真实文件确实不命中（与合成输入形成对照）
    const real = readOrFail(LOCALES_TS);
    const realHits = RUNTIME_SYMBOLS.filter((sym) => real.includes(sym));
    assert.strictEqual(realHits.length, 0, `真实文件不该命中任何符号（实测命中 ${realHits.join(', ')}）`);
  });
});
