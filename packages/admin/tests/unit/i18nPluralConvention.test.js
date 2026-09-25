/**
 * 🔴 ICU 复数约定守卫（多语言路线图「期 1」的第②件）。
 *
 * ## 背景（实测，不是推测）
 * 仓库已装的 `react-intl@3.12.1` 的 `createIntl` **实测支持 ICU 复数**：
 * `{count, plural, one {# article} other {# articles}}` ⇒ `count=1` → "1 article"、`count=2` → "2 articles"。
 * 而现有 `t()` 的形状就是 `intl.formatMessage({ id, defaultMessage }, values)` ⇒
 * 🔴 **不需要改造运行时，缺的只是"约定 + 守卫"**。
 *
 * ## 🔴 判据是**收窄过的**（朴素判据噪音 75%，会制造假缺口）
 * 朴素判据「数字或占位符 + 复数名词」在现有 114 个 key 上命中 **4 条，其中 3 条是假阳性**
 * （`every 10 minutes`、`1–2 minutes`、`5 per 10 minutes` 都是**散文里的常量数字**，不是插值计数）。
 * 🔴 收窄成「**`{占位符}` 紧跟复数名词**」后命中**恰好 1 条**：`init.restore.detail.db` 的
 * `{collections} collections / {documents} documents` ⇒ 英文会渲染成 **"1 collections"**，是真缺陷。
 * ⇒ **本守卫只认插值占位符，不认散文里的字面数字。**
 * 🔴 这条经验与仓库里另一条同源：**假缺口比没守卫更糟，它会训练下一个人忽略红灯。**
 *
 * ## 中文/繁中不需要复数
 * 汉语没有复数变化 ⇒ zh-CN / zh-TW 保持 `{collections} 张表` 这种形状是对的。
 * 🔴 **只有 en-US（以及将来的其它屈折语言）需要用 `plural`。**
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const astInventory = require('../../../../scripts/i18n/astInventory.js');

const ADMIN = path.resolve(__dirname, '../..');
const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];
const PACKS = {};
for (const l of LOCALES) {
  PACKS[l] = astInventory.readPack(path.join(ADMIN, `src/locales/${l}.ts`), `${l}.ts`);
}

/**
 * 🔴 哪些语言需要复数处理。汉语（zh-*）与日语等不需要；英语等屈折语言需要。
 * ⚠️ 将来加语言时要在这里登记 —— 这条清单本身就是"约定"的一部分。
 */
const LOCALES_NEEDING_PLURAL = ['en-US'];

test('i18n 复数 · 反空转：包被真的解析到，且需要复数的语言清单非空', () => {
  for (const l of LOCALES) {
    assert.ok(Object.keys(PACKS[l]).length >= 114, `${l}.ts 的 key 数低于基线 114（解析器坏了？）`);
  }
  assert.ok(LOCALES_NEEDING_PLURAL.length >= 1, '需要复数的语言清单为空 ⇒ 本守卫会退化成恒真');
  for (const l of LOCALES_NEEDING_PLURAL) {
    assert.ok(l in PACKS, `${l} 在"需要复数"清单里，但语言包里没有它`);
  }
});

test('i18n 复数 · 需要复数的语言里，"{占位符} + 复数名词"必须用 ICU plural', () => {
  const bad = [];
  for (const l of LOCALES_NEEDING_PLURAL) {
    for (const [k, v] of Object.entries(PACKS[l])) {
      if (astInventory.needsIcuPlural(v)) bad.push(`${l}  ${k}  ⇒  ${JSON.stringify(v)}`);
    }
  }
  assert.deepStrictEqual(
    bad,
    [],
    '🔴 这些条目会渲染出 "1 collections" 这种英文（插值计数紧跟复数名词，却没用 ICU plural）：\n  ' +
      bad.join('\n  ') +
      '\n修法：把 `{n} noun` 改成 `{n, plural, one {# noun} other {# nouns}}`。' +
      '\n🔴 只改需要复数的语言（en-US 等）；zh-CN / zh-TW 保持原样（汉语没有复数变化）。' +
      '\n⚠️ 改完 zh-CN 与 en-US 的值会不同形，这是**预期的**（"三份包 key 集合相等"钉的是 key，不是值）。',
  );
});

test('i18n 复数 · 已知的样板条目必须真的用了 ICU plural（防止被回退）', () => {
  // 🔴 init.restore.detail.db 是本仓库第一个 ICU 复数样板（2026-09-25 落地）。
  //    钉住它，防止将来有人"简化"回 `{collections} collections`。
  const v = PACKS['en-US']['init.restore.detail.db'];
  assert.ok(typeof v === 'string' && v.length > 0, 'en-US 里找不到 init.restore.detail.db');
  assert.ok(
    astInventory.ICU_PLURAL_RE.test(v),
    `init.restore.detail.db 的 en-US 值不再使用 ICU plural：${JSON.stringify(v)}\n` +
      '它是本仓库的复数样板，回退它会让 "1 collections" 这个缺陷复活。',
  );
  // 🔴 两个计数都要各自有 plural（collections 与 documents）
  const pluralCount = (v.match(/,\s*plural\s*,/g) || []).length;
  assert.strictEqual(
    pluralCount,
    2,
    `init.restore.detail.db 应当有 2 处 plural（collections 与 documents），实际 ${pluralCount}：${JSON.stringify(v)}`,
  );
  // 🔴 中文侧保持原形状（汉语无复数）—— 钉住"不要好心给中文也加 plural"
  assert.ok(
    !astInventory.ICU_PLURAL_RE.test(PACKS['zh-CN']['init.restore.detail.db']),
    'zh-CN 的 init.restore.detail.db 不应该用 ICU plural（汉语没有复数变化，加了只会让文案变丑）',
  );
});

test('i18n 复数 · ICU 语法必须能被 react-intl 真的解析（不只是形状像）', () => {
  // 🔴 这条是"尺子有效性"的正向证明：用仓库已装的 react-intl 真的渲染一次。
  //    上一轮已实测 createIntl 支持 plural；这里把它变成常驻断言，
  //    这样将来若 react-intl 被降级/替换导致 plural 不再工作，本守卫会红。
  let createIntl = null;
  try {
    // eslint-disable-next-line global-require
    createIntl = require('react-intl').createIntl;
  } catch (e) {
    try {
      const fs = require('fs');
      const root = path.resolve(__dirname, '../../../../node_modules/.pnpm');
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith('react-intl@')) continue;
        const cand = path.join(root, d, 'node_modules/react-intl');
        if (fs.existsSync(cand)) {
          // eslint-disable-next-line global-require
          createIntl = require(cand).createIntl;
          break;
        }
      }
    } catch (e2) {
      createIntl = null;
    }
  }
  if (typeof createIntl !== 'function') {
    // 🔴 fail-loud：找不到 react-intl 就明确失败，不要静默跳过（跳过等于这条断言恒真）
    assert.fail('找不到 react-intl 的 createIntl ⇒ 无法验证 ICU plural 真的可用（不允许静默跳过）');
  }
  const intl = createIntl({ locale: 'en-US', messages: PACKS['en-US'] });
  const one = intl.formatMessage(
    { id: 'init.restore.detail.db' },
    { db: 'vanBlog', collections: 1, documents: 1 },
  );
  const many = intl.formatMessage(
    { id: 'init.restore.detail.db' },
    { db: 'vanBlog', collections: 7, documents: 42 },
  );
  assert.ok(
    /1 collection\b/.test(one) && !/1 collections/.test(one),
    `复数 one 分支没生效：${JSON.stringify(one)}`,
  );
  assert.ok(
    /7 collections/.test(many) && /42 documents/.test(many),
    `复数 other 分支没生效：${JSON.stringify(many)}`,
  );
});

test('i18n 复数 · 尺子反证：合成输入必须被点名，且收窄判据确实排除了散文常量', () => {
  const n = astInventory.needsIcuPlural;
  // ① 真的该报的形状
  assert.strictEqual(n('{files} files'), true, '尺子失效："{files} files" 没被点名');
  assert.strictEqual(n('{count} items selected'), true, '尺子失效："{count} items selected" 没被点名');
  // ② 已经用了 plural 的不再报
  assert.strictEqual(n('{c, plural, one {# collection} other {# collections}}'), false, '已用 plural 的不应再报');
  // ③ 🔴 散文里的常量数字不报（这就是"收窄"的意义 —— 朴素判据会把这些当假阳性）
  assert.strictEqual(n('reprints it every 10 minutes'), false, '散文常量被误报 ⇒ 判据没收窄');
  assert.strictEqual(n('usually takes 1–2 minutes'), false, '散文常量被误报 ⇒ 判据没收窄');
  assert.strictEqual(n('rate limit: 5 per 10 minutes'), false, '散文常量被误报 ⇒ 判据没收窄');
  // ③b 🔴 以 s 结尾的**英语功能词**不是复数名词（期 9 第四批实测到的两个假阳性）
  assert.strictEqual(n('That {label} is no longer in the recycle bin'), false, '`{label} is` 被误报成需要复数');
  assert.strictEqual(
    n('Your account is not allowed to {action} this {label}'),
    false,
    '`{action} this` 被误报成需要复数',
  );
  assert.strictEqual(n('{who} has {n} posts'), true, '同一句里既有功能词又有真复数名词时，仍然要报');
  // 🔴 反向：停用词表**不许**把真的复数名词放过去（bus/gas/class 这类"以 s 结尾的名词"刻意没收）
  assert.strictEqual(n('{n} class'), true, '停用词表把真名词 class 吞了');
  assert.strictEqual(n('{n} address'), true, '停用词表把真名词 address 吞了');
  // ④ 占位符后面没有复数名词的不报（例如中文量词、或纯数值单位）
  assert.strictEqual(n('Took {seconds}s.'), false, '单位后缀不应被点名');
  assert.strictEqual(n('Static files {folder}: {files}'), false, '占位符在句尾、后面没有名词 ⇒ 不该点名');
  // ⑤ 非字符串不报（防御）
  assert.strictEqual(n(undefined), false);
  assert.strictEqual(n(null), false);
  // ⑥ 🔴 反向验证"收窄前 vs 收窄后"的命中数差异，证明收窄不是空话
  const naive = /\{[A-Za-z_][A-Za-z0-9_]*\}\s+[A-Za-z]+s\b|\b\d+\s+[A-Za-z]+s\b/;
  const naiveHits = Object.values(PACKS['en-US']).filter((v) => typeof v === 'string' && naive.test(v)).length;
  const narrowHits = Object.values(PACKS['en-US']).filter((v) => n(v)).length;
  assert.ok(
    naiveHits > narrowHits,
    `收窄判据应当比朴素判据命中更少（朴素 ${naiveHits} vs 收窄 ${narrowHits}）—— ` +
      '如果相等，说明本仓库的语料里散文常量消失了，判据可以放宽（但要先确认）。',
  );
  assert.strictEqual(narrowHits, 0, `收窄判据在真实语料上应当 0 命中（都已修），实际 ${narrowHits}`);
});
