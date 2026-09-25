/**
 * 🔴 i18n 硬编码棘轮（照 scripts/tests/strict-null-ratchet.test.sh 的先例形状）
 *
 * ## 为什么需要它
 * 多语言改造的最大风险不是"翻不完"，而是**腐烂**：每翻译完一个文件，下一个人加新功能时
 * 又会写回硬编码中文，而没有守卫会红。本仓库已经反复证明"没有守卫的约定会漂"
 * （API Token 默认值六处口径两处错、api.md 限流表漏掉一整个桶、一个分页闸门在 docs/ 里一次都没提过）。
 *
 * ## 判据
 * 对**已经接入 i18n 的文件**（下面 TRANSLATED_FILES 清单），用 AST 数出
 * 「**没有被包在 t()/formatMessage() 的 defaultMessage 位、也不在注释里**」的含中文字面量与 JSX 文本节点，
 * 🔴 **每文件一个预算，只许减少不许增加**。
 *
 * 🔴 **必须用 AST，不能用正则**：正则口径在本项目已被证明不可靠两次
 * （`grep -acE "^\s*'"` 数语言包 key 得 128/117/116，真值 105/105/105；
 *  以及"带引号字面量"正则漏掉 19 条 JSX 文本节点，使语言包从 63 key 补到 82 key）。
 *
 * 🔴 **为什么按"已翻译文件"而不是全仓**：全仓 admin/src 下有 129 个文件、1,887 条待翻译项
 * （实测口径见 vanblog_dev/I18N-ARCHITECTURE-2026-09-25.md），把它们全纳入就是 1,887 条永久红。
 * **假缺口比没守卫更糟 —— 它会训练下一个人忽略红灯。**
 *
 * 🔴 **两处刻意保留的例外，用"反向断言"钉住**（不是靠白名单放过，而是要求它们**必须仍然存在**）：
 *   - `已初始化`：那是**协议字符串**（匹配服务端 HttpException 的文本），翻译了会静默破坏初始化检测；
 *   - `初始化密钥`：那是**要照着敲进 shell 的命令与启动日志标签**（服务端输出的就是简体），
 *     翻译了 `grep` 就抓不到东西；
 *   - `语言 · Language`：那是**静态双语 tooltip**，服务于"还没切语言的人"，刻意不走 t()。
 * 把它们钉成"必须在"，才能防止有人好心把它们"翻译掉"而破坏行为。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 🔴 AST 逻辑不再内联在本文件里，而是 require 仓库内的**唯一权威实现**
//    `scripts/i18n/astInventory.js`（CLI 工具 `scripts/i18n/inventory.js` 用的是同一份）。
// 为什么：此前守卫与一次性分类脚本各有一份 AST 逻辑 ⇒ 🔴 **两处实现同一件事就一定会漂移**。
// 由 `i18nSharedImpl.test.js` 钉住"两边确实共用同一实现"。
// ⚠️ 那个模块内部同样 fail-loud：找不到 @babel/parser 或解析失败都会抛错，
//    🔴 **"解析不到"绝不等于"没有问题"**（跳过就等于给这些文件发永久通行证）。
const astInventory = require('../../../../scripts/i18n/astInventory.js');

const ADMIN = path.resolve(__dirname, '../..');
// 🔴 汉字正则（HAN）也在共享模块里，本文件不再各自定义一份。

/**
 * 🔴 已接入 i18n 的文件 → 裸中文预算（只许减少不许增加）。
 * 基线于 2026-09-25 用 AST 实测取出（排除注释、排除 t()/formatMessage() 的 defaultMessage 位、按文件内去重）。
 * ⚠️ 0 表示"这个文件已经完全翻译干净"，任何新增裸中文都会红。
 */
const BUDGET = {
  // 仍有 18 条：站点 URL 校验那一组的文案尚未翻译（属后续批次的体力活，不是框架问题）
  'src/app.jsx': 18,
  'src/components/ThemeButton/index.tsx': 0,
  'src/components/LogoutButton/index.jsx': 0,
  // 1 条 = 协议字符串「已初始化」，刻意保留（见下面的反向断言）
  'src/pages/InitPage/index.tsx': 1,
  'src/pages/InitPage/RestoreFromBackup.tsx': 0,
  // 4 条 = 要照着敲的命令与启动日志标签，刻意保留简体
  'src/pages/InitPage/setupKeyCore.js': 4,
  // 16 条 = 注入式翻译器的 identity 回落分支（不传 t 时必须返回中文，那是刻意设计）
  'src/pages/InitPage/restoreCore.js': 16,
  // 1 条 = 静态双语 tooltip「语言 · Language」
  'src/pages/user/Login/index.jsx': 1,
  'src/pages/user/Restore/index.jsx': 8,
  // 🔴 期 3 第一批（2026-09-25）：这两个文件已全量接 i18n ⇒ 预算 0，新增硬编码中文会立刻红。
  'src/pages/SystemConfig/tabs/WalineTab.jsx': 0,
  'src/pages/SystemConfig/tabs/ImgTab.jsx': 0,
};
const TOTAL_BUDGET = Object.values(BUDGET).reduce((a, b) => a + b, 0); // = 48

/** 🔴 刻意保留的例外：必须仍然存在（反向钉住，防止被"好心翻译掉"而破坏行为）。 */
const REQUIRED_EXCEPTIONS = [
  { file: 'src/pages/InitPage/index.tsx', text: '已初始化', why: '协议字符串：匹配服务端 HttpException 文本，翻译会静默破坏初始化检测' },
  { file: 'src/pages/InitPage/setupKeyCore.js', text: '初始化密钥', why: '要照着敲进 shell 的命令与启动日志标签；服务端输出就是简体，翻译了 grep 抓不到' },
  { file: 'src/pages/user/Login/index.jsx', text: '语言 · Language', why: '静态双语 tooltip，服务于"还没切语言的人"，刻意不走 t()' },
  { file: 'src/pages/user/Restore/index.jsx', text: '语言 · Language', why: '同上' },
];

/**
 * 数出一个文件里"裸中文"的去重条数。
 *
 * 🔴 **实现不在这个文件里** —— 它是 `scripts/i18n/astInventory.js` 的 `bareChineseFromFile()`，
 *    与 CLI 工具 `scripts/i18n/inventory.js` **共用同一份 AST 实现**（一个性质只留一处权威口径）。
 *    由 `i18nSharedImpl.test.js` 钉住这件事。
 *
 * 语义（在共享模块里实现，这里只记录口径，避免两处描述漂移）：
 * 🔴 排除注释、排除 `t()`/`formatMessage()` 的**第 2 个实参**（defaultMessage 位）、
 *    以及对象字面量里 key 名为 `defaultMessage` 的属性值 —— 那些是**刻意保留的中文**，不是"未翻译"。
 * ⚠️ 那个 `index === 1` 极易写反（写成 0 就会把 id 跳过、把 defaultMessage 算进来，
 *    本文件第一版就是这么错的，实测把 ThemeButton 报成 3 条而真值是 0）⇒
 *    🔴 共享模块里保留了这个警告，本文件的"尺子自证"断言（已翻干净的文件必须是 0）也仍然守着它。
 */
function countBare(rel) {
  const abs = path.join(ADMIN, rel);
  // 🔴 fail-loud：文件不存在 / 解析失败都会抛错，绝不当成"0 条"
  return astInventory.bareChineseFromFile(abs, rel);
}

test('i18n 棘轮 · 反空转：清单里的文件全部真实存在且内容正常', () => {
  const files = Object.keys(BUDGET);
  assert.ok(files.length >= 9, `清单至少应有 9 个文件，实际 ${files.length}（清单被清空 ⇒ 守卫会退化成恒真）`);
  for (const rel of files) {
    const abs = path.join(ADMIN, rel);
    assert.ok(fs.existsSync(abs), `文件不存在：${rel}`);
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.length > 200, `${rel} 内容异常短（${src.length} 字节），可能读错了文件`);
  }
});

test('i18n 棘轮 · 尺子自证：已知含裸中文的必须数得出，已翻干净的必须是 0', () => {
  // 🔴 反向验证尺子：src/app.jsx 明明含未翻译文案，必须数得出东西（否则守卫恒真）
  assert.ok(countBare('src/app.jsx').size > 0, '尺子失效：src/app.jsx 含未翻译的中文文案，却数出 0 条');
  // 🔴 正向验证"排除 defaultMessage 位"真的生效：这三个文件已翻译干净，必须是 0
  for (const rel of [
    'src/components/ThemeButton/index.tsx',
    'src/components/LogoutButton/index.jsx',
    'src/pages/InitPage/RestoreFromBackup.tsx',
  ]) {
    assert.strictEqual(
      countBare(rel).size,
      0,
      `${rel} 应当已翻译干净（0 条裸中文）；若不为 0，说明"排除 defaultMessage 位"的判据失效了`,
    );
  }
});

test('i18n 棘轮 · 逐文件：裸中文条数不得超过预算（只许减不许增）', () => {
  const over = [];
  for (const [rel, budget] of Object.entries(BUDGET)) {
    const n = countBare(rel).size;
    if (n > budget) over.push(`${rel}: 实际 ${n} > 预算 ${budget}`);
  }
  assert.deepStrictEqual(
    over,
    [],
    '🔴 已翻译的文件里出现了新的硬编码中文（棘轮只许减不许增）：\n  ' +
      over.join('\n  ') +
      "\n修法：把新增的中文改成 t('<命名空间>.<key>', '<中文默认文案>') 并同步三份语言包；" +
      '\n如果这条中文是刻意保留的例外（协议字符串 / 要照着敲的命令 / 静态双语标签），' +
      '\n请在 REQUIRED_EXCEPTIONS 里登记理由并同步调高该文件预算。',
  );
});

test('i18n 棘轮 · 总量：全部已翻译文件的裸中文总数不得超过基线', () => {
  let total = 0;
  for (const rel of Object.keys(BUDGET)) total += countBare(rel).size;
  assert.ok(total <= TOTAL_BUDGET, `裸中文总数 ${total} 超过基线 ${TOTAL_BUDGET}（翻译进度在倒退）`);
});

test('i18n 棘轮 · 反向钉住刻意保留的例外：它们必须仍然存在', () => {
  const missing = [];
  for (const ex of REQUIRED_EXCEPTIONS) {
    const items = countBare(ex.file);
    const hit = [...items].some((s) => s.includes(ex.text));
    if (!hit) missing.push(`${ex.file} 里找不到「${ex.text}」（理由：${ex.why}）`);
  }
  assert.deepStrictEqual(
    missing,
    [],
    '🔴 刻意保留的例外被改掉了 —— 它们不是"漏翻译"，改掉会破坏行为：\n  ' + missing.join('\n  '),
  );
});

test('i18n 棘轮 · 预算不得被悄悄放宽：清单条数与总预算都钉死', () => {
  // 🔴 9 → 11（2026-09-25 期 3 第一批）：新增 `SystemConfig/tabs/WalineTab.jsx` 与
  //   `SystemConfig/tabs/ImgTab.jsx`，两者都**已全量接 i18n ⇒ 预算 0**。
  //   🔴 注意 TOTAL_BUDGET 仍是 48：加进来的两个文件预算都是 0，所以**总预算不变** ——
  //   这正是棘轮该有的形状（覆盖面扩大、允许的硬编码中文总量不增加）。
  assert.strictEqual(Object.keys(BUDGET).length, 11, '清单文件数变了 ⇒ 必须是有意的，并要在注释里说明');
  assert.strictEqual(TOTAL_BUDGET, 48, '总预算变了 ⇒ 只允许调小；调大需要在注释里写明理由');
  assert.strictEqual(REQUIRED_EXCEPTIONS.length, 4, '例外清单条数变了 ⇒ 必须是有意的');
});
