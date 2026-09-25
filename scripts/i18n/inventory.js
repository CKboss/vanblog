#!/usr/bin/env node
/**
 * 🔴 i18n 待翻译盘点工具（**仓库内正式工具**，零新依赖）。
 *
 * ## 它解决什么问题
 * 此前"还有多少中文要翻"这个问题只有**一次性脚本**能回答，产物落在 git-ignored 的
 * `vanblog_dev/i18n-classification/`，⇒ 下一轮要重新写一遍，而且 🔴 **两份 AST 逻辑会漂移**。
 * 现在：**本工具与 `i18nHardcodedRatchet.test.js` 共用 `scripts/i18n/astInventory.js` 这一份实现**
 * （由 `packages/admin/tests/unit/i18nSharedImpl.test.js` 钉住）。
 *
 * ## 🔴 口径分开报（这是本工具存在的第二个理由）
 * **"含中文的行数"是上界，不是工作量**：实测 3,441 行里含 **1,816 行注释**（注释不翻译）。
 * 所以本工具分别报四个互不重叠的桶：
 *   - `literals`  ：字符串字面量（去重）
 *   - `templates` ：模板字符串片段（去重）
 *   - `jsx`       ：JSX 文本节点（去重）—— 🔴 **正则盘点最容易漏的一类**（曾因此漏掉约 19 条）
 *   - `comments`  ：注释里的中文**行数**（🔴 不翻译，单列，避免虚高工作量）
 *
 * ## 用法
 *   node scripts/i18n/inventory.js                # 人类可读的汇总
 *   node scripts/i18n/inventory.js --tsv <file>   # 额外写出逐文件 TSV
 *   node scripts/i18n/inventory.js --json <file>  # 额外写出机器可读 JSON
 *
 * ⚠️ **本工具只读，不改任何文件**（除了你显式指定的 --tsv/--json 输出路径）。
 * 🔴 **测量类命令绝不接 `2>/dev/null`** —— 那会把工具失败静默变成"看起来合理的 0"
 *    （本仓库实测过：`rg '\p{Han}'` 因为吞了 stderr 而返回 0 个文件，真值是 136）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const astInventory = require('./astInventory.js');

const ROOT = path.resolve(__dirname, '../..');
const ADMIN_SRC = path.join(ROOT, 'packages/admin/src');

/** 🔴 排除目录：`.umi*` 是生成物（数它会把工作量虚高一个量级），`locales` 是语言包本身。 */
function isExcludedDir(name) {
  return name === 'node_modules' || name === '.umi' || name === '.umi-production' || name === 'locales';
}

const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js']);

/** 递归收集待盘点的源文件（🔴 用真实遍历，不猜扩展名 —— 猜错过 `.tsx` vs `.jsx`）。 */
function collectFiles(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`inventory: 读不了目录 ${dir}：${String(e && e.message).split('\n')[0]}`);
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isExcludedDir(ent.name)) continue;
      collectFiles(abs, out);
    } else if (ent.isFile() && EXTS.has(path.extname(ent.name))) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * 🔴 归类（四类互斥）。判据基于**可核实的结构特征**，不是文件名直觉：
 *  - 「语言包（已多语言）」：形似语言包**且提供 ≥2 种语言** ⇒ 它真的是语言包，不计入工作量。
 *  - 丙「形似语言包」：文件里导出的是一个**扁平 key → 中文字符串**的大对象，
 *    且 🔴 **对 umi 的 locale 运行时（`umi` / `getLocale` / `useIntl` / `formatMessage`）引用数为 0**
 *    ⇒ **它形似语言包、实为单语常量**（实例：`components/Editor/locales.ts` 只导出一个 `cn`，
 *    硬接线到编辑器 4 处 ⇒ 编辑器界面永远中文、切语言不跟随）。
 *    🔴 **把它算作"已翻译"会掩盖一个用户可见缺陷，所以单列一类。**
 *  - 丁「核心模块消息」：文件名以 `Core.js` 结尾（本仓库的既有约定：纯 JS、被 `node --test` 直接
 *    `require()`、拿不到 umi 运行时）⇒ 必须用**注入式翻译器**模式改造，而不是 `useIntl()`。
 *  - 乙「仅注释」：UI 三个桶都是 0，只有注释里有中文 ⇒ **不需要翻译**。
 *  - 甲「UI 文案」：其余含中文的 ⇒ **真正的工作量**。
 */
/**
 * 🔴 这个文件是否**提供多于一种语言**？判据是源码里出现的语言代码字面量种类数 ≥2。
 * 认两类写法：本项目语言包的 `zh-CN`/`zh-TW`/`en-US`，以及上游库 locale 文件的
 * `zh_Hans`/`zh_Hant`（例如 `import x from 'bytemd/locales/zh_Hant.json'`）。
 * ⚠️ 这是一个**结构特征**判据，不是"文件名像不像语言包"的直觉。
 */
function providesMultipleLanguages(src) {
  const found = new Set();
  const re = /['"](zh-CN|zh-TW|en-US|zh_Hans|zh_Hant|en)['"]/g;
  let mm;
  while ((mm = re.exec(src)) !== null) found.add(mm[1]);
  // `zh_Hans.json` 这种出现在 import 路径里时不带引号包裹整体，所以再补一次路径形状的匹配
  const re2 = /locales\/(zh_Hans|zh_Hant|en|ja|ko|fr|de|es|ru|ar)\.json/g;
  while ((mm = re2.exec(src)) !== null) found.add(mm[1]);
  return found.size >= 2;
}

function classify(rel, src, inv) {
  const uiCount = inv.literals.size + inv.templates.size + inv.jsxTexts.size;
  const looksLikePack = /(^|\/)locales?\.(ts|js|tsx|jsx)$/.test(rel) || /(^|\/)locales?\//.test(rel);
  // 🔴 判据从「有没有引用 umi 的 locale 运行时」改成「**提供了几种语言**」，因为前者会误判：
  // 一个合法的语言包文件**刻意不应该**在模块加载期调 `getLocale()`（它内部走 umi 的
  // `plugin.applyPlugins(...)`，依赖插件运行时已初始化 ⇒ 模块加载期调用会拿到 undefined），
  // 语言选择必须由**消费方在渲染期**做。所以「不引用 umi」不是缺陷特征，「只有一种语言」才是。
  if (looksLikePack) {
    // 🔴 提供多语言 ⇒ 它**就是**语言包，里面的中文是合法译文、不是待翻译文案。
    // 单列一类，否则它会落进甲类把工作量虚增，并误导下一个人去"翻译"一个语言包。
    if (providesMultipleLanguages(src)) return '语言包（已多语言，不计入工作量）';
    return '丙-形似语言包（只提供单一语言，切语言不跟随）';
  }
  if (uiCount === 0 && inv.comments > 0) return '乙-仅注释（不翻译）';
  if (uiCount === 0) return '（无中文）';
  if (/Core\.js$/.test(rel)) return '丁-核心模块消息（需注入式翻译器）';
  return '甲-UI 文案（需翻译）';
}

function main() {
  const args = process.argv.slice(2);
  let tsvOut = null;
  let jsonOut = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tsv') tsvOut = args[++i];
    else if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法: node scripts/i18n/inventory.js [--tsv <file>] [--json <file>]');
      return 0;
    } else {
      console.error(`inventory: 未知参数 ${args[i]}（用 --help 看用法）`);
      return 9;
    }
  }

  if (!fs.existsSync(ADMIN_SRC)) {
    console.error(`inventory: 找不到 ${ADMIN_SRC}`);
    return 9;
  }

  const files = collectFiles(ADMIN_SRC, []).sort();
  const rows = [];
  let parseFailures = 0;
  for (const abs of files) {
    const rel = path.relative(path.join(ROOT, 'packages/admin'), abs);
    const src = fs.readFileSync(abs, 'utf8');
    let inv;
    try {
      inv = astInventory.collectChinese(src, rel, {});
    } catch (e) {
      // 🔴 fail-loud：解析失败必须显式报出来，不能当成"0 条"
      parseFailures += 1;
      console.error(`🔴 解析失败：${rel} —— ${String(e && e.message).split('\n')[0]}`);
      continue;
    }
    const hanLines = src.split('\n').filter((l) => astInventory.HAN.test(l)).length;
    rows.push({
      file: rel,
      literals: inv.literals.size,
      templates: inv.templates.size,
      jsx: inv.jsxTexts.size,
      comments: inv.comments,
      hanLines,
      cls: classify(rel, src, inv),
    });
  }

  const withHan = rows.filter((r) => r.literals + r.templates + r.jsx + r.comments > 0);
  const sum = (f) => withHan.reduce((a, r) => a + f(r), 0);
  const byClass = {};
  for (const r of withHan) {
    if (!byClass[r.cls]) byClass[r.cls] = { files: 0, literals: 0, templates: 0, jsx: 0, comments: 0 };
    const b = byClass[r.cls];
    b.files += 1;
    b.literals += r.literals;
    b.templates += r.templates;
    b.jsx += r.jsx;
    b.comments += r.comments;
  }

  console.log('=== i18n 待翻译盘点（packages/admin/src，已排除 .umi* 与 locales）===');
  console.log(`  扫描文件: ${files.length}   含中文的文件: ${withHan.length}   🔴 解析失败: ${parseFailures}`);
  if (parseFailures > 0) {
    console.log('  🔴 有解析失败 ⇒ 上面的数字不完整，请先修解析（不要把它当成"0 条"）');
  }
  console.log('  --- 四个桶（口径分开，不要相加当成"工作量"）---');
  console.log(`    字符串字面量(去重): ${sum((r) => r.literals)}`);
  console.log(`    模板字符串片段    : ${sum((r) => r.templates)}`);
  console.log(`    JSX 文本节点(去重): ${sum((r) => r.jsx)}`);
  console.log(`    注释里的中文行数  : ${sum((r) => r.comments)}   ⚠️ 不翻译，是"含中文行数"虚高的主因`);
  console.log(`    含中文的行(上界)  : ${sum((r) => r.hanLines)}`);
  console.log('  --- 按归类 ---');
  for (const k of Object.keys(byClass).sort()) {
    const b = byClass[k];
    console.log(
      `    ${k}: ${b.files} 文件 / 字面量 ${b.literals} / 模板 ${b.templates} / JSX ${b.jsx} / 注释行 ${b.comments}`,
    );
  }

  // 🔴 按目录聚合，便于排期（实测最大的桶是 components，不是任何页面组）
  const byTop = {};
  for (const r of withHan) {
    if (!r.cls.startsWith('甲')) continue;
    const m = r.file.match(/^src\/([^/]+)/);
    const top = m ? m[1] : '(root)';
    if (!byTop[top]) byTop[top] = { files: 0, items: 0 };
    byTop[top].files += 1;
    byTop[top].items += r.literals + r.templates + r.jsx;
  }
  console.log('  --- 甲类（真工作量）按顶层目录，降序 ---');
  for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1].items - a[1].items)) {
    console.log(`    ${String(v.items).padStart(5)} 条 / ${String(v.files).padStart(3)} 文件   ${k}`);
  }

  if (tsvOut) {
    const lines = ['file\tcls\tliterals\ttemplates\tjsx\tcomments\thanLines'];
    for (const r of rows) {
      lines.push(`${r.file}\t${r.cls}\t${r.literals}\t${r.templates}\t${r.jsx}\t${r.comments}\t${r.hanLines}`);
    }
    fs.writeFileSync(tsvOut, lines.join('\n') + '\n', 'utf8');
    console.log(`  ✔ TSV 已写出: ${tsvOut} (${lines.length - 1} 行)`);
  }
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ rows, byClass, byTop, parseFailures }, null, 2), 'utf8');
    console.log(`  ✔ JSON 已写出: ${jsonOut}`);
  }
  // 🔴 解析失败时以非 0 退出，避免"看起来跑完了但数字不完整"被当成结论
  return parseFailures > 0 ? 1 : 0;
}

// 🔴 导出给守卫用（`i18nEditorLocaleFollows.test.js` 会在进程内调 `classify`，
// 这样"丙类归零"这个验收判据可以被断言，而不必靠跑一次 CLI 再解析输出）。
module.exports = { classify, providesMultipleLanguages };

// 🔴 只有作为 CLI 直接执行时才跑 main()（被 require 时不能跑，否则守卫会触发一次全量盘点）
if (require.main === module) {
  process.exitCode = main();
}
