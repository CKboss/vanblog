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
 *   node scripts/i18n/inventory.js --zh-tw-audit  # 繁中用字审计（🔴 每翻译完一批繁中跑一次，见 zhTwAudit 的说明）
 *   node scripts/i18n/inventory.js --server-throws # 服务端「带中文的 throw」完整分布（期 9 棘轮的定位工具）
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
  // 🔴 戊「测试文件」：`*.test.*` / `*.spec.*` 里的中文是**测试自己的**（断言消息、夹具、注释），
  //    不是用户看得见的 UI 文案 ⇒ **不翻**。
  //    为什么要单列：admin 的 `src/` 下有 2 个共存式测试文件（`components/Editor/plugins/mermaidSafety.test.ts`、
  //    `tocViewport.test.ts`，合计 7 条），它们本来被算进「甲-UI 文案」⇒ 🔴 **虚增了待翻工作量**，
  //    还会误导下一个人去"翻译"一个测试文件（与丙类"形似语言包"同一个理由：分类要反映**该不该翻**）。
  if (/(^|\/)[^/]*\.(test|spec)\.(js|jsx|ts|tsx)$/.test(rel)) {
    return '戊-测试文件（测试内部的中文，不是 UI 文案 ⇒ 不翻）';
  }
  if (uiCount === 0 && inv.comments > 0) return '乙-仅注释（不翻译）';
  if (uiCount === 0) return '（无中文）';
  if (/Core\.js$/.test(rel)) return '丁-核心模块消息（需注入式翻译器）';
  return '甲-UI 文案（需翻译）';
}

/**
 * 🔴 `--zh-tw-audit`：繁中用字审计。**每翻译完一批繁中就跑一次**（手册里的规矩）。
 *
 * ## 为什么需要一个人工审计工具，而不是全靠守卫
 * `localePackParity` 那条守卫用的是「简体专用字表」（`astInventory.SIMPLIFIED_ONLY_ZH`），
 * 🔴 而那张表**天生不可能完备**：本机没有任何简繁映射数据源，也不许装新依赖。
 * 实测代价：表里漏「现」⇒ zh-TW 写出「掃描现有…」守卫全绿（靠浏览器活体证据才发现）；
 * 表里漏「点」⇒ zh-TW 写出「站点配置」守卫全绿（靠**这个审计**逐字过才发现）。
 * ⇒ 所以本工具的输出**不是**"绿了就没事"：它把 zh-TW 里出现过的每个不同汉字摊开给人看，
 * 🔴 **判断"某个字是不是简体专用字"这一步只能由人做**（并且要对照上游繁中语料，
 * 例如 antd `lib/locale/zh_TW.js`、bytemd `locales/zh_Hant.json`，不能凭"我看着像简体"）。
 *
 * 口径：AST 解析语言包后的**值**（不是正则、不是"含中文的行数"）。
 * @returns {number} 退出码：表里的字出现在 zh-TW 里 ⇒ 1（与守卫同判据），否则 0
 */
function zhTwAudit() {
  const packs = {};
  for (const l of ['zh-CN', 'zh-TW', 'en-US']) {
    const abs = path.join(ROOT, 'packages/admin/src/locales', `${l}.ts`);
    packs[l] = astInventory.readPack(abs, l);
  }
  const table = astInventory.SIMPLIFIED_ONLY_ZH;
  const allowed = astInventory.SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW;

  const where = new Map(); // 汉字 → 出现它的 key 列表
  for (const [k, v] of Object.entries(packs['zh-TW'])) {
    for (const ch of v) {
      if (!astInventory.HAN.test(ch)) continue;
      if (!where.has(ch)) where.set(ch, []);
      where.get(ch).push(k);
    }
  }
  const distinct = [...where.keys()].sort();

  console.log('=== 繁中用字审计（口径：AST 解析 zh-TW 语言包的值，逐字去重）===');
  console.log(`  zh-TW: ${Object.keys(packs['zh-TW']).length} key，值里出现过的不同汉字 ${distinct.length} 个`);
  console.log(`  简体专用字表 ${[...table].length} 字；刻意保留简体的例外 ${allowed.length} 个`);

  const hits = distinct.filter((ch) => table.includes(ch));
  if (hits.length > 0) {
    console.log(`  🔴 命中简体专用字 ${hits.length} 个（守卫同样会红）：`);
    for (const ch of hits) console.log(`     ${ch} ← ${where.get(ch).join(', ')}`);
  } else {
    console.log('  ✓ 没有命中简体专用字表里的字');
  }

  for (const e of allowed) {
    const keys = [...where.entries()].filter(([ch]) => ch === e.ch).flatMap(([, ks]) => ks);
    console.log(`  ⚠️ 刻意保留简体「${e.ch}」出现在 ${keys.length} 条：${keys.join(', ') || '（🔴 一条都没有 = 死条目）'}`);
    console.log(`     理由：${e.why}`);
  }

  // 🔴 这一段才是本工具的重点：表外的字**必须人工逐字过一遍**
  const review = distinct.filter((ch) => !table.includes(ch) && !allowed.some((e) => e.ch === ch));
  console.log(`  --- 🔴 表外汉字 ${review.length} 个：请人工逐字核实（表不完备，只有人能判断）---`);
  const LINE = 40;
  for (let i = 0; i < review.length; i += LINE) {
    console.log('    ' + review.slice(i, i + LINE).join(''));
  }
  console.log('  判定规矩：只把「繁体里一定换成另一个字形」的字加进 SIMPLIFIED_ONLY_ZH；');
  console.log('            简繁同形或繁体合法的（只/量/限/台/准/别/云/余/强/松/核/没/里/黑/静/降/填/目/粘…）绝不收。');
  console.log('            加字之前先对照上游繁中语料核实，加完必须重跑 localePackParity（假阳性比漏报更糟）。');
  return hits.length > 0 ? 1 : 0;
}

/**
 * 🔴 `--server-throws`：列出服务端「带中文的 `throw` 站点」的**完整分布**。
 *
 * ## 为什么需要它
 * `i18nServerErrorCodes.test.js` 的棘轮红了之后只打印"前 10 个文件"，
 * 🔴 而**新增的那一处往往落在只有 1 个站点的小文件里**（变异对照实测过：新加一个文件 ⇒ 计数 243 → 244，
 * 而那个文件根本不在前 10 里）⇒ 光看守卫消息定位不到。
 * 口径与守卫**完全一致**（同一个 `astInventory.collectChineseThrows`、同一套排除规则），
 * 所以"守卫数的"与"这里列的"必然是同一个集合。
 * @returns {number} 退出码：超过预算 ⇒ 1（预算与守卫里的 `THROW_BUDGET` 同源，见下面的常量说明）
 */
function serverThrows() {
  const SERVER_SRC = path.join(ROOT, 'packages/server/src');
  // 🔴 这个数字必须与 `packages/admin/tests/unit/i18nServerErrorCodes.test.js` 的 `THROW_BUDGET` 一致。
  //    ⚠️ 两处写同一个数字就是两处口径 —— 但守卫在 admin 的 node:test 里、本工具在 scripts/ 下，
  //    互相 require 会把"守卫"与"报数工具"耦合成一条依赖链；折中办法是**在这里注明出处**，
  //    并由守卫那条断言负责"数字漂了就红"（守卫是权威，本工具只是打印）。
  const THROW_BUDGET = 211;
  // 🔴 第二个口径的预算（`message:` 带中文的返回体），与守卫里的 `MESSAGE_BODY_BUDGET` 必须一致。
  const MESSAGE_BODY_BUDGET = 108;
  const walk = (dir, out) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'test') continue;
        walk(abs, out);
      } else if (ent.isFile() && abs.endsWith('.ts') && !abs.endsWith('.spec.ts')) out.push(abs);
    }
    return out;
  };
  const files = walk(SERVER_SRC, []);
  const perFile = [];
  let total = 0;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const hits = astInventory.collectChineseThrows(fs.readFileSync(abs, 'utf8'), rel);
    if (hits.length > 0) {
      perFile.push({ rel, n: hits.length, lines: hits.map((h) => h.line) });
      total += hits.length;
    }
  }
  perFile.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));
  const msgPerFile = [];
  let msgTotal = 0;
  let msgOutside = 0;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const hits = astInventory.collectChineseMessageProps(fs.readFileSync(abs, 'utf8'), rel);
    if (hits.length > 0) {
      msgPerFile.push({ rel, n: hits.length, outside: hits.filter((h) => !h.inThrow).length });
      msgTotal += hits.length;
      msgOutside += hits.filter((h) => !h.inThrow).length;
    }
  }
  msgPerFile.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));
  console.log('=== 服务端「带中文的 throw 站点」分布（口径同 i18nServerErrorCodes 棘轮）===');
  console.log(`  扫描文件 ${files.length} 个（排除 *.spec.ts 与 test/）；命中文件 ${perFile.length} 个；站点合计 ${total}`);
  console.log(`  棘轮预算 ${THROW_BUDGET} ⇒ ${total <= THROW_BUDGET ? '✓ 未超' : '🔴 超了 ' + (total - THROW_BUDGET)}`);
  for (const f of perFile) console.log(`    ${String(f.n).padStart(3)}  ${f.rel}  (行 ${f.lines.join(',')})`);
  console.log('--- 第二个口径：`message:` 带中文的返回体（棘轮同样只许减不许增）---');
  console.log(
    `  命中文件 ${msgPerFile.length} 个；站点合计 ${msgTotal}（其中在 throw 外 ${msgOutside}）；` +
      `预算 ${MESSAGE_BODY_BUDGET} ⇒ ${msgTotal <= MESSAGE_BODY_BUDGET ? '✓ 未超' : '🔴 超了 ' + (msgTotal - MESSAGE_BODY_BUDGET)}`,
  );
  for (const f of msgPerFile.slice(0, 12)) console.log(`    ${String(f.n).padStart(3)}  ${f.rel}  (throw 外 ${f.outside})`);
  return total <= THROW_BUDGET && msgTotal <= MESSAGE_BODY_BUDGET ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  let tsvOut = null;
  let jsonOut = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tsv') tsvOut = args[++i];
    else if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--zh-tw-audit') return zhTwAudit();
    else if (args[i] === '--server-throws') return serverThrows();
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(
        '用法: node scripts/i18n/inventory.js [--tsv <file>] [--json <file>]\n' +
          '      node scripts/i18n/inventory.js --zh-tw-audit   # 繁中用字审计（每翻译完一批跑一次）\n' +
          '      node scripts/i18n/inventory.js --server-throws # 服务端带中文 throw 的完整分布（期 9 棘轮红了用它定位）',
      );
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

  // 🔴 **真实剩余工作量**（bareChinese 口径：排除注释、排除 t()/formatMessage() 的 defaultMessage 位）。
  //    为什么必须单列：上面那份甲/丁类计数用的是 `collectChinese(..., {})`，它**把 defaultMessage 位也算进去**
  //    ⇒ 已经翻译完的文件里的中文会被继续计入，🔴 **高估剩余工作量**（实测差 174 条：1,887 → 1,713）。
  //    棘轮（i18nHardcodedRatchet）用的就是这个口径 ⇒ 两边必然一致。
  let bareTotal = 0;
  const bareFiles = [];
  let testFileItems = 0;
  let testFiles = 0;
  for (const abs of files) {
    const rel = path.relative(path.join(ROOT, 'packages/admin'), abs);
    const n = astInventory.bareChineseFromFile(abs, rel).size;
    // 🔴 `*.test.*` / `*.spec.*` 不计入"待翻工作量"（那是测试自己的中文，见上面戊类的说明）；
    //    但**单独报出来**，免得"少了几条"看起来像进度而其实是口径变了。
    if (/(^|\/)[^/]*\.(test|spec)\.(js|jsx|ts|tsx)$/.test(rel)) {
      if (n) { testFileItems += n; testFiles += 1; }
      continue;
    }
    if (n > 0) {
      bareTotal += n;
      bareFiles.push({ rel, n });
    }
  }
  bareFiles.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));
  console.log(`  --- 🔴 真实剩余（bareChinese 口径 = 棘轮口径）---`);
  console.log(`    ${bareFiles.length} 个文件 / ${bareTotal} 条（甲/丁类那份计数含 defaultMessage 位，会高估）`);
  console.log(
    `    ⚠️ 另有 ${testFiles} 个**测试文件** / ${testFileItems} 条中文**不计入**（那是测试自己的断言消息与夹具，不是 UI 文案）`,
  );
  console.log('    前 10：');
  for (const f of bareFiles.slice(0, 10)) console.log(`      ${String(f.n).padStart(4)}  ${f.rel}`);

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
module.exports = { classify, providesMultipleLanguages, zhTwAudit };

// 🔴 只有作为 CLI 直接执行时才跑 main()（被 require 时不能跑，否则守卫会触发一次全量盘点）
if (require.main === module) {
  process.exitCode = main();
}
