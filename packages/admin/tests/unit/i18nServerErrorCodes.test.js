/**
 * 🔴 期 9（**服务端消息的错误码框架**，方案 B）的守卫。
 *
 * ## 它守的是什么
 * 服务端今天有 **252** 处 `throw` 带中文、**108** 处 `message:` 带中文的返回体
 * （口径见 `astInventory.collectChineseThrows` 的注释），而 admin 的全局 `errorHandler`
 * 与 22 处调用点**直接透出服务端 message** ⇒ 🔴 **在这件事做完之前，"后台完全多语言"不可达**：
 * 把 admin 那 129 个文件全翻完，用户仍会在"操作失败"那一刻看到中文。
 *
 * 机制（三个约束同时成立，任何一条被破坏都会让用户看到坏消息）：
 *  1. 服务端抛错带**稳定错误码**（+ 可选 `params`），而 `message` **仍是中文**
 *     ⇒ 日志与排障线索保留，钉住那些中文字面量的既有测试一条都不用改；
 *  2. admin 建**错误码 → 三语文案**映射（`error.<code>`），`handleAdminRequestError`
 *     **有码用码、无码回落 `message`** ⇒ 🔴 渐进迁移，**任何时刻都可用**；
 *  3. 🔴 三条守卫（本文件）：
 *     ① **每个码都有三语译文**（漏译会红）+ **反向：不留死条目**（包里的 `error.*` 必须有码）
 *        + 🔴 **zh-CN 的值必须与服务端登记表的中文逐字相同**（两处口径漂移会红）；
 *     ② 🔴 **反向：每个码都真的被某处抛出/返回**（防"登记了却没人用"的死码）；
 *     ③ 🔴 **棘轮：禁止新增裸中文 `throw`**（存量慢慢还、增量立刻止住）。
 *
 * ## 🔴 为什么这个守卫在 admin 侧而不是 server 侧
 * 它要同时对账**两份异构数据**：服务端的 TS 登记表（admin 的 `node --test` 不能 `require()` TS，
 * 只能 AST 解析）与 admin 的三份语言包。跨包锚点在本仓库已有先例
 * （`fullBackup.test.js` / `securityHardening.test.js` 都读 server 源码），
 * 而 AST 实现只有 `scripts/i18n/astInventory.js` 一份（由 `i18nSharedImpl.test.js` 钉住）。
 * ⚠️ 运行时的**行为**钉子（body 形状、message 逐字不变、未登记的码 fail-loud）在
 * `packages/server/src/utils/serverErrorCodes.spec.ts`，两边不重复。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const astInventory = require('../../../../scripts/i18n/astInventory.js');

const ADMIN = path.resolve(__dirname, '../..');
const ROOT = path.resolve(__dirname, '../../../..');
const SERVER_SRC = path.join(ROOT, 'packages/server/src');
const REGISTRY_REL = 'packages/server/src/utils/serverErrorCodes.ts';
const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];

// 🔴 fail-loud：登记表解析不出码会直接抛（空集合上的全称命题恒真 = 最坏的假绿）
const REGISTRY = astInventory.collectServerErrorCodes(
  fs.readFileSync(path.join(ROOT, REGISTRY_REL), 'utf8'),
  REGISTRY_REL,
);
const CODES = Object.keys(REGISTRY);

const packs = {};
for (const l of LOCALES) {
  packs[l] = astInventory.readPack(path.join(ADMIN, `src/locales/${l}.ts`), `${l}.ts`);
}

/**
 * 🔴 棘轮预算：`packages/server/src/**\/*.ts`（排除 `*.spec.ts` 与 `test/`）里
 * 「带中文的 `throw` 站点」总数，**只许减不许增**。
 * 基线：2026-09-25 实测 **252**（146 只含字符串字面量 + 97 只含模板片段 + 9 两者都有）；
 * 期 9 第一批迁掉 `category.provider.ts` 的 **9** 处 ⇒ 243；
 * 期 9 第二批迁掉 `article.controller.ts`(9) + `draft.controller.ts`(2) + `export.controller.ts`(2) = **13** 处 ⇒ 230；
 * 期 9 第三批迁掉 `customPage.provider.ts`(5) + `customPage.controller.ts`(6) + `user.provider.ts`(7) +
 * `auth.controller.ts`(1) = **19** 处 ⇒ **211**。
 * 🔴 复算命令：`node scripts/i18n/inventory.js --server-throws`（同一个共享实现，口径必然一致）。
 */
// 🔴 211 → **206**（期 9 第一批）：`user.provider.ts` 那 5 处带 `${label}` / `${MIN}` / `${name}` 的
//   模板消息全部迁进码表（8 个新码：口令 3 类 × admin/collaborator + 协作者用户名冲突 2 条）。
// 🔴 206 → **186**（期 9 第二批）：认证与初始化族 21 个码上线（auth.controller 5、init.controller 9、
//   jwt.strategy 3、initJwt 2、login.guard 1、init.provider 1）。
//   ⚠️ init.controller 里那两处 `已初始化` **刻意没迁**：它是协议字符串（admin 拿它与响应文本比对），
//   译了会让初始化检测静默失效 ⇒ 要改得前后端一起改成按 code 判断，单独排一批。
// 🔴 186 → **164**（期 9 第三批）：评论族 24 处 throw 迁进码表（22 个码，两处重复文本各共用一个）。
//   ⚠️ 这一族**大多是访客可见**的（前台评论表单）⇒ 前台仍显示服务端返回的中文（与今天逐字相同，无回归），
//   等前台多语言那一批直接按 code 取译文。
//   （实测 162：24 处 throw 里有两处重复文本共用同一个码，另一处 `个人主页地址只支持 http/https`
//   也出现两次 ⇒ 站点数 24、码数 22。）
// 🔴 162 → **134**（期 9 第五批）：主题族 10 处 + 图床/静态文件族 18 处 throw 迁进码表（32 个新码，
//   重复文本共用码 ⇒ 站点数 28、码数 32；另外 `validateThemeCss` 的 9 种拒绝**从来不在 throw 口径里**，
//   它们是 `reason:` 属性 ⇒ 那 9 个码是"新增覆盖"，不减 throw 计数）。
// 🔴 134 → **127**（期 9 第六批）：上传校验（uploadLimits 5 处 + img.controller 的自定义提示）
//   与 .mdz 导入（2 处）迁进码表 ⇒ 10 个新码（两处"条件片段"各拆成两个码）。
// 🔴 127 → **126**（期 9 第六批补：图片隐写检测那一档自己的限流也迁进了码表）
// 🔴 126 → **107**（期 9 第八批：主题读取 4 + 路径别名 4 + 落盘文件名 4 + 公开接口 4 + 备份文件名 3 = 19 处迁进码表）
const THROW_BUDGET = 107;

/**
 * 🔴 **第二个**棘轮：`message:` 属性带中文的站点（`return { statusCode, message: '中文' }` 那一族）。
 * 为什么必须单列：只数 `throw` 的话，🔴 这一族可以随便新增而没有任何守卫会红 ——
 * 而实测它有 **108** 处（8 在 throw 里 + **100 在 throw 外**，"演示站禁止…"几乎全是这个形状），
 * 比 throw 那一族的一半还多。基线 2026-09-25 实测 **108**（30 个文件），只许减不许增。
 */
// 🔴 108 → **103**（期 9 第二批）：auth.controller 那 5 处 `new UnauthorizedException({ statusCode, message: '中文' })`
//   与 login.guard 那 1 处的对象体一并迁进码表 ⇒ 这一族少了 5 处。
// 🔴 103 → **102**（同上：`img.controller.ts` 那处 429 信封迁进了码表）
// 🔴 102 → **18**（期 9 第七批）：演示站守卫族 **82 处**（8 种文案 ⇒ 8 个码）全部迁进 `codedBody()`。
//   这是单批覆盖最多站点的一族 —— 它此前占了这个口径的 **80%**（102 里 84 处是它）。
const MESSAGE_BODY_BUDGET = 18;

/** 码 → 码表里的中文模板（`{name}` 占位符的权威来源）；供"调用点参数对账"那条判据用 */
const CODE_ZH = (() => {
  const out = {};
  for (const [code, e] of Object.entries(REGISTRY)) out[code] = e && e.zh;
  return out;
})();

/** "间接传参"（`codedError(code, someVar)`）的调用点计数：静态看不见键名，如实报出来 */
let indirect = 0;

/** 读一个服务端源文件（相对仓库根） */
const readServer = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walkServerSources(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'test') continue;
      walkServerSources(abs, out);
    } else if (ent.isFile() && abs.endsWith('.ts') && !abs.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function scanServerSources(collect) {
  const files = walkServerSources(SERVER_SRC, []);
  let total = 0;
  const perFile = {};
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    // 🔴 解析失败会抛（fail-loud）："解析不到"绝不等于"没有问题"
    const hits = collect(fs.readFileSync(abs, 'utf8'), rel);
    if (hits.length > 0) {
      perFile[rel] = hits.length;
      total += hits.length;
    }
  }
  return { files: files.length, total, perFile };
}

const scanServerThrows = () => scanServerSources(astInventory.collectChineseThrows);
const scanServerMessageProps = () => scanServerSources(astInventory.collectChineseMessageProps);

test('服务端错误码 · 反空转：登记表、语言包与源码遍历都真的拿到了东西', () => {
  assert.ok(CODES.length >= 8, `登记表只解析出 ${CODES.length} 个码（下界 8）⇒ 尺子坏了或登记表被清空`);
  for (const l of LOCALES) {
    assert.ok(Object.keys(packs[l]).length >= 100, `${l} 只解析出 ${Object.keys(packs[l]).length} 个 key`);
  }
  const scan = scanServerThrows();
  // 🔴 这条是棘轮的**反空转**：遍历坏了（例如目录名改了）会得到 0 个站点，而 `0 <= 预算` 恒真
  assert.ok(scan.files >= 200, `只遍历到 ${scan.files} 个 server 源文件（下界 200）⇒ 遍历坏了，棘轮会假绿`);
  assert.ok(scan.total > 100, `只数出 ${scan.total} 个带中文的 throw 站点（应远大于 100）⇒ 尺子坏了`);
  const scan2 = scanServerMessageProps();
  assert.ok(scan2.files === scan.files, `两个口径遍历到的文件数不一致（${scan2.files} vs ${scan.files}）⇒ 有一把尺子遍历坏了`);
  // ⚠️ 下界随迁移**下调**（期 9 第七批把演示站那一族 82 处迁走了，实测从 102 降到 18）：
  //    这条反空转要防的是"尺子坏了数出 0"，不是"数字必须很大"⇒ 下界取实测值的一半左右，
  //    🔴 并且**每次下调都要在注释里写明是哪一批迁走的**（否则下界会悄悄失去意义）。
  assert.ok(
    scan2.total > 8,
    `只数出 ${scan2.total} 个「message: 中文」站点（下界 8，2026-09-28 实测 18）⇒ 尺子坏了（而 0 ≤ 预算 会让棘轮恒真）`,
  );
});

test('服务端错误码 · ① 每个码都有三语译文，且 zh-CN 与服务端登记表逐字相同', () => {
  const missing = [];
  const drift = [];
  for (const code of CODES) {
    const key = `error.${code}`;
    for (const l of LOCALES) {
      if (!(key in packs[l])) missing.push(`${key} 缺 ${l}`);
    }
    // 🔴 这条是"message 仍是中文"的另一半：回退文案（zh-CN）必须与服务端真的发出来的那句**逐字相同**，
    //    否则"拿不到翻译器时"与"拿到翻译器时"会给用户两句不同的话（同一性质两处口径）。
    if (key in packs['zh-CN'] && packs['zh-CN'][key] !== REGISTRY[code].zh) {
      drift.push(
        `${key}\n     语言包: ${packs['zh-CN'][key]}\n     登记表: ${REGISTRY[code].zh}`,
      );
    }
  }
  assert.deepStrictEqual(missing, [], `有错误码没有三语译文（漏译会让用户看到裸 key 或中文回退）：\n  ${missing.join('\n  ')}`);
  assert.deepStrictEqual(
    drift,
    [],
    '🔴 zh-CN 的 error.* 与服务端登记表的中文不一致（回退文案与实际 message 会变成两句话）：\n  ' + drift.join('\n  '),
  );
});

test('服务端错误码 · ① 反向：语言包里的每个 error.* 都有登记的码（不留死条目）', () => {
  const dead = [];
  for (const l of LOCALES) {
    for (const key of Object.keys(packs[l])) {
      if (!key.startsWith('error.')) continue;
      const code = key.slice('error.'.length);
      if (!(code in REGISTRY)) dead.push(`${l}: ${key}`);
    }
  }
  assert.deepStrictEqual(
    dead,
    [],
    '🔴 语言包里有 error.* 是死条目（服务端没有这个码 ⇒ 永远不会被用到）：\n  ' +
      dead.join('\n  ') +
      `\n修法：删掉这些 key，或者去 ${REGISTRY_REL} 登记并真的抛出它。`,
  );
});

test('服务端错误码 · ② 反向：每个登记的码都真的被服务端某处抛出/返回（防死码）', () => {
  const unused = [];
  for (const code of CODES) {
    // 🔴 判据用"只有代码才会出现的形状"：`codedError('<code>'` / `codedBody('<code>'`。
    //    不能用裸 `'<code>'`：登记表自己就含这个字符串，会**恒真**（本仓库已多次栽在恒真判据上）。
    // 🔴 三种形状都算"被用到"（期 9 第五批加的第三种）：
    //   ① `codedError('<code>'` / ② `codedBody('<code>'` —— 码名直接出现在调用点；
    //   ③ `code: '<code>'` —— **动态派发**：`validateThemeCss()` 这类校验函数返回
    //      `{ ok:false, reason, code }`，调用点写的是 `throw codedError(checked.code || '兜底码')`
    //      （第一个实参是 Identifier，不是字面量）⇒ 按 ①② 找不到，会把 9 个活码判成死码。
    //      ⚠️ 这条放宽是**有边界**的：仍然要求"码名以字符串字面量的形式出现在源码里"，
    //      只是允许它出现在 `code:` 属性位而不是调用实参位；🔴 登记表自己那个文件被排除在外
    //      （否则恒真），所以"登记了没人用"仍然会被抓（变异对照 B45-M4 验的就是这条）。
    // 🔴 期 9 第八批再加两种形状：**码名被当成字符串实参传给一个"会转发给 codedError"的助手**
    //    （`assertSingleFileName(fileName, 'storedImageNameIllegal')` —— 助手内部才 `codedError(code, …)`）。
    //    这与 `code: '<code>'`（对象属性位）是同一类"动态派发"，只是形状不同。
    //    ⚠️ 边界（为什么这两种形状仍然够严）：要求码名**带引号**且**紧贴左括号或", "之后**
    //    （`('<code>'` / `, '<code>')`）⇒ 注释里随手提到码名（不带这对括号/逗号）不会被误认成"已使用"。
    //    🔴 反向仍然有效：登记表自己那个文件被排除，"登记了没人用"照样会被抓（变异对照验过两次）。
    const needles = [
      `codedError('${code}'`,
      `codedBody('${code}'`,
      `code: '${code}'`,
      `('${code}'`,
      `, '${code}')`,
    ];
    let used = false;
    for (const abs of walkServerSources(SERVER_SRC, [])) {
      if (abs.endsWith('serverErrorCodes.ts')) continue; // 登记表本身不算"使用"
      const src = fs.readFileSync(abs, 'utf8');
      if (needles.some((n) => src.includes(n))) {
        used = true;
        break;
      }
    }
    if (!used) unused.push(code);
  }
  assert.deepStrictEqual(
    unused,
    [],
    '🔴 这些错误码登记了却没有任何地方抛出/返回（死码 ⇒ 三语译文永远用不到，还会让对账数字虚高）：\n  ' +
      unused.join('\n  '),
  );
});

test('服务端错误码 · ③ 棘轮：带中文的 throw 站点不得超过预算（只许减不许增）', () => {
  const scan = scanServerThrows();
  assert.ok(
    scan.total <= THROW_BUDGET,
    `🔴 服务端出现了新的裸中文 throw：实测 ${scan.total} > 预算 ${THROW_BUDGET}。\n` +
      '修法：把它迁到错误码 —— ① 在 `packages/server/src/utils/serverErrorCodes.ts` 的 `SERVER_ERROR_CODES` 里\n' +
      '登记一个码（`zh` 就是今天这句中文，逐字照抄）；② 调用点改成 `throw codedError(\'<code>\')`；\n' +
      '③ 在 admin 的三份语言包里各加一条 `error.<code>`（🔴 zh-CN 的值必须与登记表的 `zh` 逐字相同）。\n' +
      '⚠️ 不要通过调大 `THROW_BUDGET` 来"修"这条：那是把棘轮拆了。\n' +
      '🔴 定位新增的那一处：`node scripts/i18n/inventory.js --server-throws`（口径与本条完全一致，列**全部**文件与行号）\n' +
      '   ⚠️ 下面这份"前 10"只是提示：新增的站点往往落在只有 1 处的小文件里，不会出现在前 10。\n' +
      `当前分布（前 10）：\n  ${Object.entries(scan.perFile)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([f, n]) => `${n} ${f}`)
        .join('\n  ')}`,
  );
  if (scan.total < THROW_BUDGET) {
    // 🔴 与 strict-null-ratchet 同一套做法：减少时提示"基线可以下调"，但**仍然通过**
    //    （否则每修一处都得先改常量，会训练出"顺手放宽常量"的习惯）。
    console.log(`NOTE: 带中文的 throw 站点已降到 ${scan.total}，THROW_BUDGET 可以下调到 ${scan.total}`);
  }
});

test('服务端错误码 · ③ 第二个棘轮：`message:` 带中文的返回体不得超过预算（只许减不许增）', () => {
  const scan = scanServerMessageProps();
  assert.ok(
    scan.total <= MESSAGE_BODY_BUDGET,
    `🔴 服务端出现了新的「中文返回体」：实测 ${scan.total} > 预算 ${MESSAGE_BODY_BUDGET}。\n` +
      '修法与 throw 那一族相同：在 `serverErrorCodes.ts` 登记一个码（`zh` 逐字照抄今天这句），\n' +
      "调用点改成 `return codedBody('<code>')`，再在 admin 三份语言包里各加一条 `error.<code>`。\n" +
      '⚠️ 不要通过调大 `MESSAGE_BODY_BUDGET` 来"修"这条：那是把棘轮拆了。\n' +
      '🔴 定位：`node scripts/i18n/inventory.js --server-throws`（它同时报两个口径的完整分布）。\n' +
      `当前分布（前 8）：\n  ${Object.entries(scan.perFile)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([f, n]) => `${n} ${f}`)
        .join('\n  ')}`,
  );
  if (scan.total < MESSAGE_BODY_BUDGET) {
    console.log(`NOTE: 「message: 中文」站点已降到 ${scan.total}，MESSAGE_BODY_BUDGET 可以下调到 ${scan.total}`);
  }
});

test('服务端错误码 · 尺子自证：合成输入必须被正确分类（证明判据真的在判）', () => {
  // ① 裸中文 throw 必须数得出（否则棘轮恒真）
  const bare = astInventory.collectChineseThrows(`throw new BadRequestException('中文消息');`, 'synthetic');
  assert.strictEqual(bare.length, 1, '尺子失效：裸中文 throw 没被数出来');
  assert.strictEqual(bare[0].texts[0], '中文消息');
  // ② 🔴 迁移后的形状必须**不**被计入（否则棘轮会把"已修好的"也当成违规，逼人调大预算）
  const coded = astInventory.collectChineseThrows(`throw codedError('someCode');`, 'synthetic');
  assert.strictEqual(coded.length, 0, `codedError() 被算成了裸中文 throw：${JSON.stringify(coded)}`);
  // ③ 模板字符串拼接的中文也要算（漏掉它们会把工作量低估四成：实测 97 + 9 处）
  const tpl = astInventory.collectChineseThrows('throw new Error(`前缀 ${x} 中文后缀`);', 'synthetic');
  assert.strictEqual(tpl.length, 1, '模板字符串里的中文 throw 没被数出来');
  // ④ 没有中文的 throw 不算
  const ascii = astInventory.collectChineseThrows(`throw new Error('boom');`, 'synthetic');
  assert.strictEqual(ascii.length, 0, '纯 ASCII 的 throw 被误算了');
  // ④b 🔴 返回体那一族：throw 里的与 return 里的都要数得出，且 `inThrow` 要分得清
  const inThrow = astInventory.collectChineseMessageProps(
    `throw new HttpException({ statusCode: 401, message: '演示站禁止修改此项！' }, 401);`,
    'synthetic',
  );
  assert.strictEqual(inThrow.length, 1, 'throw 里的 message: 中文没被数出来');
  assert.strictEqual(inThrow[0].inThrow, true, 'inThrow 标记错了（它明明在 throw 里）');
  const inReturn = astInventory.collectChineseMessageProps(
    `const r = () => ({ statusCode: 401, message: '演示站禁止修改此项！' });`,
    'synthetic',
  );
  assert.strictEqual(inReturn.length, 1, 'return 体里的 message: 中文没被数出来');
  assert.strictEqual(inReturn[0].inThrow, false, 'inThrow 标记错了（它在 return 体里，不在 throw 里）');
  assert.strictEqual(
    astInventory.collectChineseMessageProps(`const r = { message: 'ok' };`, 'synthetic').length,
    0,
    '纯 ASCII 的 message 被误算了',
  );
  // ⑤ 🔴 登记表解析必须 fail-loud（0 个码会让上面所有全称断言恒真）
  assert.throws(
    () => astInventory.collectServerErrorCodes(`export const OTHER = { a: entry('中文', Error) };`, 'synthetic'),
    /找不到 SERVER_ERROR_CODES/,
    '登记表解析没有 fail-loud ⇒ 空集合会让对账断言恒真',
  );
  assert.throws(
    () => astInventory.collectServerErrorCodes(`export const SERVER_ERROR_CODES = {};`, 'synthetic'),
    /解析出 0 个错误码/,
    '空登记表没有 fail-loud',
  );
});

test('服务端错误码 · admin 侧行为：有码用码、无码回落，且不传翻译器时与改造前逐字相同', () => {
  const re = require('../../src/services/van-blog/requestError');
  const coded = { statusCode: 406, message: '分类名重复，无法创建！', code: 'categoryDuplicateOnCreate' };
  const codedWithParams = {
    statusCode: 400,
    message: '请稍后 30 秒再试',
    code: 'someFutureCode',
    params: { n: 30 },
  };
  const uncoded = { statusCode: 406, message: '还没有迁移的中文消息' };

  // 🔴 不传 t（今天所有既有调用点的形状）⇒ 输出必须与改造前**逐字相同**
  assert.strictEqual(re.adaptAdminResponse(coded).errorMessage, '分类名重复，无法创建！');
  assert.strictEqual(re.adaptAdminResponse(uncoded).errorMessage, '还没有迁移的中文消息');
  assert.deepStrictEqual(re.adaptAdminResponse({ statusCode: 401, message: 'Unauthorized' }).errorMessage, '登录失效');
  assert.deepStrictEqual(
    re.adaptAdminResponse({ statusCode: 403, message: 'Forbidden resource' }).errorMessage,
    '权限不足！',
  );

  // 🔴 传了 t 且有码 ⇒ 用码（并把 params 透传给 ICU）
  const seen = [];
  const fakeT = (id, defaultMessage, values) => {
    seen.push({ id, defaultMessage, values });
    return `#${id}`;
  };
  assert.strictEqual(re.adaptAdminResponse(coded, { t: fakeT }).errorMessage, '#error.categoryDuplicateOnCreate');
  // 🔴 按 **id** 找，不要按**下标**找：`adaptAdminResponse` 内部还会为了 401 判定取一次
  //    `request.sessionExpired` 的译文（期 7 第五批），下标会随之错位（本批实测被绊红过一次）。
  const byId = (id) => seen.find((x) => x.id === id);
  assert.deepStrictEqual(byId('error.categoryDuplicateOnCreate'), {
    id: 'error.categoryDuplicateOnCreate',
    // 🔴 defaultMessage 必须是**服务端那句中文**：漏译时用户看到的是今天的行为，而不是裸 key
    defaultMessage: '分类名重复，无法创建！',
    values: undefined,
  });
  assert.strictEqual(
    re.adaptAdminResponse(codedWithParams, { t: fakeT }).errorMessage,
    '#error.someFutureCode',
  );
  assert.deepStrictEqual(byId('error.someFutureCode').values, { n: 30 }, 'params 没有透传给翻译器（ICU 插值会失效）');

  // 🔴 传了 t 但**没有码** ⇒ 原样回落 message（渐进迁移的关键：任何时刻都可用）
  assert.strictEqual(re.adaptAdminResponse(uncoded, { t: fakeT }).errorMessage, '还没有迁移的中文消息');
  // 🔴 协议级的两条特例仍然优先（它们不带码）—— 但**显示文案现在跟着语言走**（期 7 第五批）：
  //    401 时用户看到的是 `request.sessionExpired` 的译文，不再是写死的中文常量。
  assert.strictEqual(
    re.adaptAdminResponse({ statusCode: 401, message: 'Unauthorized' }, { t: fakeT }).errorMessage,
    '#request.sessionExpired',
  );
  // 🔴 而**线路字面量**那一半没变：服务端 `message` 里那句中文仍然被认成"会话过期"，
  //    并且"我们已经把 mapped 翻译成外文了"这种情况也必须照样认出来（否则 401 检测会静默失效，§7.163 A）
  assert.strictEqual(re.SERVER_SESSION_EXPIRED_TEXT, '登录失效', '线路字面量不许被翻译');
  assert.strictEqual(
    re.isSessionExpiredPayload({ statusCode: 401, message: '登录失效' }, undefined, fakeT),
    true,
    '服务端给的是中文线路字面量 ⇒ 必须认出来',
  );
  assert.strictEqual(
    re.isSessionExpiredPayload(
      { statusCode: 401, message: 'Unauthorized' },
      re.mapAdminErrorMessage({ statusCode: 401, message: 'Unauthorized' }, fakeT),
      fakeT,
    ),
    true,
    '🔴 mapped 已经是译文了 ⇒ 401 判定仍然要成立（这一条就是"拆成线路 vs 显示"要守的性质）',
  );
  // 🔴 上面那条**不够**：`raw === 'Unauthorized'` 那个分支会先返回 true，
  //    于是"接受译文"那半句根本没被执行 —— 变异对照 B25-M2 把它整句换掉，测试**照旧全绿**（空转）。
  //    ⇒ 再补一条**只能靠那半句**才过的：raw 既不是 'Unauthorized' 也不是线路字面量，只有 mapped 是译文。
  assert.strictEqual(
    re.isSessionExpiredPayload(
      { statusCode: 401, message: 'some other server text' },
      re.sessionExpiredMessage(fakeT),
      fakeT,
    ),
    true,
    '🔴 只有 mapped 是当前语言的译文时也必须认出来（这条不能被前面的分支短路掉）',
  );
  assert.strictEqual(
    re.isSessionExpiredError(
      { response: { status: 401 }, message: re.sessionExpiredMessage(fakeT) },
      fakeT,
    ),
    true,
    '🔴 isSessionExpiredError 走 error.message 那条路时同样要认译文',
  );
  assert.strictEqual(
    re.isSessionExpiredPayload({ statusCode: 500, message: '登录失效' }, undefined, fakeT),
    false,
    '非 401 不许误判成会话过期',
  );
  // 🔴 不传 t（identity 路径）时仍然逐字是中文 —— 老行为一个字没变
  assert.strictEqual(
    re.adaptAdminResponse({ statusCode: 401, message: 'Unauthorized' }).errorMessage,
    '登录失效',
  );
});

test('服务端错误码 · admin 侧接线：全局 errorHandler 与 adaptor 都注入了翻译器，且在调用期取 intl', () => {
  const appSrc = fs.readFileSync(path.join(ADMIN, 'src/app.jsx'), 'utf8');
  // 🔴 两个入口都要注入：`adaptor` 决定 umi 自己弹出的文案，`errorHandler` 决定我们兜的那条 ——
  //    只接一个会出现"同一句话一处翻译、一处中文"。
  const adaptorBlock = appSrc.slice(appSrc.indexOf('errorConfig: {'), appSrc.indexOf('errorHandler:'));
  const handlerBlock = appSrc.slice(appSrc.indexOf('errorHandler:'), appSrc.indexOf('requestInterceptors:'));
  assert.ok(adaptorBlock.length > 20 && handlerBlock.length > 20, '切片失败 ⇒ app.jsx 的结构变了，请先更新判据');
  assert.match(adaptorBlock, /t: makeServerErrorTranslator\(\)/, 'errorConfig.adaptor 没有注入翻译器');
  assert.match(handlerBlock, /t: makeServerErrorTranslator\(\)/, 'errorHandler 没有注入翻译器');
  // 🔴 翻译器必须在**调用期**取 intl（模块加载期 `getLocale()` 会拿到 undefined，见手册 §7.134）
  const factory = appSrc.slice(
    appSrc.indexOf('const makeServerErrorTranslator'),
    appSrc.indexOf('export const request'),
  );
  assert.ok(factory.length > 50, '找不到 makeServerErrorTranslator 的定义');
  assert.match(factory, /getIntl\(getLocale\(\)\)/, '翻译器不是用 getIntl(getLocale()) 在调用期造的');
  // 🔴 失败方向：拿不到 intl 时必须返回 undefined（= 回落中文），绝不能抛出把整个错误处理搞崩
  assert.match(factory, /return undefined;/, '翻译器没有"拿不到就回落"的分支');
});

test('🔴 服务端错误码 · 尺子反证（合成输入）：中文 throw 必须被数到，中文**日志**必须不被数到', () => {
  // ## 为什么要这条（2026-09-27 期 9 第 0 批）
  // 上面那两条棘轮（THROW_BUDGET / MESSAGE_BODY_BUDGET）的反空转只验了"**总量**够大"
  // （files ≥200、total >100、total2 >50）—— 那能抓住"遍历坏了"，抓不住"**口径错了**"：
  // 一把把日志文本也算进来的尺子，总量只会更大，反空转照样全绿，
  // 而它会逼人去做**错的事**（翻译 `logger.warn(…)`：日志属开发者界面，翻它会让同一条日志
  // 在不同语言下长得不一样，排查问题时 grep 都 grep 不到）。
  // 🔴 反过来，一把**漏数**的尺子同样危险：本期实测过一次 —— 我先写了一把新尺子（AST 遍历），
  // 只认 acorn 的 `Literal`/`Property`，而 `parseSource` 出的是 babel 的 `StringLiteral`/`ObjectProperty`
  // ⇒ 普通字符串字面量一条都没数到（只数到模板字符串），报出 160 条的假数字（真值 374）。
  // 👉 所以反证必须**正反两个方向**：该数的形状要数到，不该数的形状要漏掉。
  //    合成输入直接喂给共享模块的两个收集器（与棘轮同一个口径，不另起一套遍历）。
  const SRC = [
    "import { BadRequestException, Logger } from '@nestjs/common';",
    "const logger = new Logger('synthetic');",
    "export function boom() {",
    "  logger.warn('这条是日志，不该被数进去');",
    "  console.log('这条也不该被数进去');",
    "  // 这条是注释，也不该被数进去",
    "  throw new BadRequestException('这条是用户可见的错误消息，必须被数到');",
    "}",
    "export function envelope() {",
    "  return { statusCode: 400, message: '这条是响应信封里的消息，也必须被数到' };",
    "}",
    "export function tpl(ctx) {",
    "  throw new BadRequestException(`模板形状的也要数到：${ctx}`);",
    "}",
  ].join('\n');

  const throws = astInventory.collectChineseThrows(SRC, 'synthetic.ts');
  const msgs = astInventory.collectChineseMessageProps(SRC, 'synthetic.ts');
  // 🔴 两个收集器返回的形状是 `{ line, texts: [...] }`（不是 `{ text }`）——
  //    第一版按 `x.text` 读 ⇒ 恒 undefined ⇒ 正向断言假红。👉 写断言前先把返回值**打印出来**看形状。
  const flat = (rows) => (rows || []).flatMap((r) => (r.texts || []).map((t) => `${r.line}:${t}`));
  const throwTexts = flat(throws);
  const msgTexts = flat(msgs);

  // ① 正向：用户可见的三种形状（字符串字面量 / 模板字符串 / 响应信封）都要被数到
  assert.ok(throws.length >= 2, `🔴 中文 throw 只数到 ${throws.length} 条（期望 ≥2：字符串字面量 + 模板）⇒ 尺子漏数`);
  assert.ok(
    throwTexts.some((x) => x.includes('必须被数到')),
    `🔴 字符串字面量形状的 throw 没被数到（这正是本期实测漏掉的那一类）：${JSON.stringify(throwTexts).slice(0, 200)}`,
  );
  assert.ok(
    throwTexts.some((x) => x.includes('模板形状')),
    `🔴 模板字符串形状的 throw 没被数到：${JSON.stringify(throwTexts).slice(0, 200)}`,
  );
  assert.ok(msgs.length >= 1, `🔴 「message: 中文」只数到 ${msgs.length} 条（期望 ≥1）⇒ 尺子漏数`);

  // ② 反向：日志 / console / 注释都**不该**被数到（数到了就会逼人翻译日志）
  const all = [...throwTexts, ...msgTexts].join('\n');
  for (const banned of ['不该被数进去']) {
    assert.ok(
      !all.includes(banned),
      `🔴 尺子把**开发者界面**的中文也算进了用户可见口径（日志/console/注释）⇒ 会逼人翻译日志：${all.slice(0, 200)}`,
    );
  }
  assert.ok(!/logger|console/.test(all), `🔴 计数结果里混进了 logger/console 的文本：${all.slice(0, 200)}`);
});

test('🔴 服务端错误码 · ④ 调用点传的 params 必须与码表里的占位符**对得上**（两个方向都查）', () => {
  // ## 为什么要这条（2026-09-28 期 9 第二批，一条"本该绿"的变异对照揭出来的洞）
  // 我把调用点写成 `codedError('loginThrottled', { secs: … })`（码表里是 `{seconds}`）⇒
  // 🔴 **全套测试都是绿的**：admin 侧的三份包对账只看 key 与文本，服务端那条
  // "填完不许残留占位符"的 spec 是**自己按码表的占位符造样例参数**，所以它也发现不了
  // "调用点传错了名字"。后果是**用户界面上直接出现字面 `{seconds}`** ——
  // 这类缺陷静态判据一个都抓不到，只有真触发一次才看得见（而登录限流这条路径很难在验收里撞上）。
  // ⇒ 补一条静态判据，把"调用点的参数名"与"码表里的占位符"**两个方向**都对上：
  //   ① 传了码表里没有的名字 ⇒ 那个参数**永远不会被渲染**（多半是拼错，或者占位符被改名忘了同步）；
  //   ② 码表里有占位符但调用点没传 ⇒ 用户会看到字面 `{name}`。
  const files = walkServerSources(SERVER_SRC, []);
  const problems = [];
  let callSites = 0;
  for (const abs of files) {
    if (abs.endsWith('serverErrorCodes.ts')) continue; // 登记表本身不含调用点
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const src = fs.readFileSync(abs, 'utf8');
    // 🔴 预筛要**同时**认两种形状：`codedError(`/`codedBody(` 调用，以及 `{ code: '<码>', params: {…} }`
    //    对象（后者出现在"把码当数据传给助手"的地方，例如 `assertUploadedImage(…, { tooLarge: { code, params } })`）。
    //    第一版只筛前者 ⇒ `img.controller.ts` 整个文件被 `continue` 跳过，
    //    变异对照 B46-M2（把 `max` 改成 `mp`）因此**全绿**（这是"预筛把该看的文件筛掉了"的典型）。
    if (!/coded(Error|Body)\(|code:\s*'/.test(src)) continue;
    // 🔴 解析失败会抛（fail-loud）："解析不到"绝不等于"没有问题"
    const ast = astInventory.parseSource(src, rel);
    // ⚠️ babel 的形状是 StringLiteral / ObjectProperty（acorn 是 Literal / Property）⇒ 两种都认。
    //    本项目已经因为只认一种而**数漏过一半**（见 §7.181 B）。
    const str = (nd) =>
      nd && (nd.type === 'StringLiteral' || nd.type === 'Literal') && typeof nd.value === 'string'
        ? nd.value
        : null;
    const walk = (nd, visit) => {
      if (!nd || typeof nd !== 'object') return;
      if (Array.isArray(nd)) {
        nd.forEach((x) => walk(x, visit));
        return;
      }
      if (typeof nd.type === 'string') visit(nd);
      for (const k of Object.keys(nd)) {
        if (k === 'loc' || k === 'start' || k === 'end' || k === 'comments') continue;
        const v = nd[k];
        if (v && typeof v === 'object') walk(v, visit);
      }
    };
    walk(ast.program || ast, (nd) => {
      // 🔴 这一段必须在下面那句 CallExpression 早退**之前**：第一版把它插在早退之后 ⇒
      //    对 ObjectExpression 节点**永远走不到**（变异对照 B46-M2 因此一直是绿的：
      //    把 params 的 `max` 改成 `mp`，560 条断言全过）。
      //    👉 🔴 **插判据前先看清它在回调里的位置**：早退之后的代码只对一个子集生效，
      //    而"全绿"看起来与"判据生效"一模一样 —— 只有变异对照能分辨。
      // 🔴 期 9 第六批补：还有一种形状是"**把 `{ code, params }` 当对象传给助手**"
      //    （`assertUploadedImage(buf, name, { tooLarge: { code: 'stegoImageTooLarge', params: { max } } })`）
      //    ⇒ 它既不是 `codedError('<code>'`，params 也不在调用实参位上，第一版判据**完全看不见**
      //    （变异对照 B46-M2 把 `max` 改成 `mp`，全套 560 条断言全绿）。
      //    下面这段在**同一个 AST 遍历**里顺手处理：遇到 `{ code: '<字面量>', params: { … } }` 就对账一次。
      if (nd.type === 'ObjectExpression') {
        const props = {};
        for (const pp of nd.properties || []) {
          if (!pp || (pp.type !== 'ObjectProperty' && pp.type !== 'Property') || !pp.key) continue;
          props[pp.key.name || pp.key.value] = pp.value;
        }
        const codeLit = str(props.code);
        if (codeLit && CODE_ZH[codeLit] && props.params && props.params.type === 'ObjectExpression') {
          callSites += 1;
          const wantP = new Set(
            [...String(CODE_ZH[codeLit]).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]),
          );
          const gotP = new Set();
          for (const pp of props.params.properties || []) {
            if (!pp || (pp.type !== 'ObjectProperty' && pp.type !== 'Property') || !pp.key) continue;
            const k = pp.key.name || pp.key.value;
            if (typeof k === 'string') gotP.add(k);
          }
          const unk = [...gotP].filter((k) => !wantP.has(k));
          const miss = [...wantP].filter((k) => !gotP.has(k));
          if (unk.length) {
            problems.push(
              `${rel}: { code: '${codeLit}', params: { ${unk.join(', ')} } } 传了码表里没有的参数` +
                `（码表占位符是 {${[...wantP].join(', ') || '无'}}）⇒ 这些参数永远不会被渲染`,
            );
          }
          if (miss.length) {
            problems.push(
              `${rel}: { code: '${codeLit}', … } 少传了 {${miss.join(', ')}} ⇒ 用户会看到字面占位符`,
            );
          }
        }
      }
      if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'Identifier') return;
      if (!/^coded(Error|Body)$/.test(nd.callee.name)) return;
      const code = str(nd.arguments && nd.arguments[0]);
      if (!code) return;
      callSites += 1;
      const entry = CODE_ZH[code];
      if (!entry) {
        problems.push(`${rel}: codedError('${code}') 但登记表里没有这个码（拼错？）`);
        return;
      }
      const want = new Set(
        [...String(entry).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]),
      );
      const arg = nd.arguments && nd.arguments[1];
      const got = new Set();
      if (arg && (arg.type === 'ObjectExpression')) {
        for (const p of arg.properties || []) {
          if (!p || (p.type !== 'ObjectProperty' && p.type !== 'Property') || !p.key) continue;
          const k = p.key.name || p.key.value;
          if (typeof k === 'string') got.add(k);
        }
      } else if (arg && arg.type === 'Identifier') {
        // 传的是一个变量（例如 `LIMITS` / `shortParams`）⇒ 静态看不出键名，**跳过但不算通过**：
        // 这类调用点由"运行时不许残留占位符"那条 spec 兜（它按码表造样例参数），
        // 这里只登记数量，避免把"看不见"当成"没问题"。
        indirect += 1;
        return;
      }
      const unknown = [...got].filter((k) => !want.has(k));
      const missing = [...want].filter((k) => !got.has(k));
      if (unknown.length) {
        problems.push(
          `${rel}: codedError('${code}') 传了码表里没有的参数 {${unknown.join(', ')}}` +
            `（码表占位符是 {${[...want].join(', ') || '无'}}）⇒ 这些参数永远不会被渲染`,
        );
      }
      if (missing.length) {
        problems.push(
          `${rel}: codedError('${code}') 少传了 {${missing.join(', ')}} ⇒ 用户界面上会出现字面占位符`,
        );
      }
    });
  }
  assert.deepStrictEqual(
    problems,
    [],
    '🔴 调用点的参数名与码表里的占位符对不上（界面上会渲染出字面 `{xxx}`，或者传了个没人用的参数）：\n  ' +
      problems.slice(0, 10).join('\n  '),
  );
  // 🔴 反空转：这条判据必须真的走到了调用点（否则"0 个问题"是因为一个都没看）
  assert.ok(callSites >= 40, `只找到 ${callSites} 个 codedError/codedBody 调用点（下界 40）⇒ 遍历或解析坏了`);
  assert.ok(Object.keys(CODE_ZH).length >= 50, `登记表只解析出 ${Object.keys(CODE_ZH).length} 个码（下界 50）`);
  // ℹ️ 间接传参（传变量而不是对象字面量）的调用点数量：静态看不见键名，如实报出来
  console.log(`NOTE: codedError/codedBody 调用点 ${callSites} 个，其中 ${indirect} 个是间接传参（静态判据看不见键名）`);
});

test('🔴 服务端错误码 · ⑤ 响应助手 `tooManyRequests()` 必须走 `codedBody()`（429 信封不许退回"只有 message"）', () => {
  // ## 为什么要这条（2026-09-28 期 9 第四批）
  // 🔴 429 限流信封以前是**两个棘轮都数不到的盲区**：中文既不在 `throw` 里、也不在 `{ message: … }` 里，
  //    而是当**实参**传给响应助手 `tooManyRequests(res, secs, '请求过于频繁，请稍后再试')`，
  //    由助手内部拼 `res.status(429).json({ statusCode: 429, message })`。
  //    ⇒ 那 5 处（3 处共用一句短的 + 2 处各一句长的运维指引）**从来没进过任何账**，
  //    而它偏偏是访客/脚本**最先撞到**的错误之一（全局桶、公开写桶、静态资源桶都用它）。
  // 现在助手改成收**错误码**（默认 `rateLimited`）并用 `codedBody()` 组装信封 ⇒
  // 这条判据钉住"不许再退回手写 `{ statusCode, message }`"：一旦有人图省事把助手改回去，
  // 429 就又不带 code 了，而**两个棘轮都不会红**（因为它们本来就看不见这一族）。
  const src = readServer('packages/server/src/utils/rateLimit.ts');
  const fn = src.slice(src.indexOf('function tooManyRequests'), src.indexOf('export function rateLimitMiddleware'));
  assert.ok(fn.length > 80, `截取到的 tooManyRequests 函数体太短（${fn.length}）⇒ 锚点可能失效`);
  // 🔴 助手自己**默认**用 `codedBody('rateLimited')`；带码的那两处在**调用点**写 `codedBody('<code>', params)`
  //    （理由见 rateLimit.ts 里那段注释：admin 的"防死码"判据按 `codedBody('<code>'` 这个形状找码名）。
  assert.match(
    fn,
    /codedBody\('rateLimited'\)/,
    '🔴 `tooManyRequests()` 的默认信封不再是 `codedBody(\'rateLimited\')` ⇒ 429 可能丢掉 code，前端/后台无法翻译。' +
      '（这一族是清点口径的盲区：两个棘轮都看不见它，所以只能靠这条判据守。）',
  );
  // 🔴 三个码都必须真的出现在这个文件的 `codedBody('…')` 调用点里（默认那个 + 两个长指引）
  for (const code of ['rateLimited', 'initRateLimited', 'publicListRateLimited']) {
    assert.ok(
      src.includes(`codedBody('${code}'`),
      `🔴 rateLimit.ts 里找不到 codedBody('${code}'…) 的调用点 ⇒ 那个码会变成死码（或信封退回手写）`,
    );
  }
  // 🔴 反向判据要**按性质写、不要按形状写**：第一版写的是
  //    `doesNotMatch(/json\(\{\s*statusCode:\s*429,\s*message\s*\}\)/)`，
  //    而变异对照把它打成 `json({ statusCode: 429, message: body.message })` ⇒ **正则没匹配上，判据假绿**
  //    （B44-M1 实测：rc=0，全套 559 条断言都绿，而 429 信封已经丢掉 code 了）。
  //    性质其实是："信封不许在助手内部**手写对象字面量**，必须原样发出调用点用 `codedBody()` 造好的那个"
  //    ⇒ 判据改成 `.json(` 后面**不许紧跟 `{`**（形状无关，怎么改写都拦得住）。
  assert.doesNotMatch(
    fn,
    /\.json\(\s*\{/,
    '🔴 `tooManyRequests()` 又在内部**手写响应体**了（`json({…})`）⇒ 429 信封会丢掉 `code`，前端/后台无法翻译。' +
      '正确写法是把调用点用 `codedBody(<code>, params)` 造好的 body 原样发出去。',
  );
  // 🔴 反向：调用点不许再传中文文案（第三个参数只能是 `codedBody(…)`）
  const calls = [...src.matchAll(/tooManyRequests\([\s\S]{0,260}?\n\s*\);|tooManyRequests\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 5, `只找到 ${calls.length} 个 tooManyRequests 调用点（下界 5）⇒ 锚点可能失效`);
  const withChinese = calls.filter((c) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(c));
  assert.deepStrictEqual(
    withChinese,
    [],
    '🔴 这些 `tooManyRequests()` 调用点还在传中文文案（应该传错误码）：\n  ' + withChinese.join('\n  '),
  );
});

test('🔴 服务端错误码 · ⑥ 演示站信封：前端预拦截与服务端拦截必须说**同一句话**（三语都对齐）', () => {
  // ## 为什么要这条（2026-09-27 期 9 第七批）
  // 演示站的写操作有**两道**拦截：
  //   ① 前端预拦截（`common.demoBlocked`，点了就直接弹 Modal，不发请求）；
  //   ② 服务端拦截（`error.demoSiteBlocked`，绕过前端直接打接口时才会看到）。
  // 🔴 同一个操作在两条路上给用户的必须是**同一句话** —— 否则"我用界面点是 A，用脚本打是 B"，
  //    站长会以为是两个不同的限制（而 `common.demoBlocked` 与 `backup.demoBlockedEdit` 早就各写了一份，
  //    英文还**不一样**：`Not allowed on the demo site` vs `This cannot be changed on the demo site!`
  //    ⇒ 本条判据把服务端那条与 `common.demoBlocked` 对齐，并把既有的两处不一致**如实报出来**）。
  for (const l of LOCALES) {
    const viaServer = packs[l]['error.demoSiteBlocked'];
    const viaUi = packs[l]['common.demoBlocked'];
    assert.ok(viaServer, `${l} 缺 error.demoSiteBlocked`);
    assert.ok(viaUi, `${l} 缺 common.demoBlocked`);
    assert.strictEqual(
      viaServer,
      viaUi,
      `🔴 ${l} 里"演示站禁止"这句话在**前端预拦截**与**服务端拦截**两条路上不一致：\n` +
        `   common.demoBlocked   = ${JSON.stringify(viaUi)}\n` +
        `   error.demoSiteBlocked = ${JSON.stringify(viaServer)}\n` +
        '   同一个操作必须说同一句话（改一边就要改另一边）。',
    );
  }
  // 🔴 8 个演示站码必须都在（少一个就意味着某一类操作在英文下退回中文）
  const demoCodes = CODES.filter((c) => c.startsWith('demoSite'));
  assert.strictEqual(demoCodes.length, 8, `演示站码应该是 8 个，实测 ${demoCodes.length}：${demoCodes.join(', ')}`);
  for (const c of demoCodes) {
    for (const l of LOCALES) {
      const v = packs[l]['error.' + c];
      assert.ok(v && String(v).length > 3, `${l} 的 error.${c} 缺失或太短`);
      if (l === 'en-US') {
        assert.ok(!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(v), `🔴 en-US 的 error.${c} 里夹了中文：${v}`);
        assert.ok(!/'/.test(v), `🔴 en-US 的 error.${c} 里有单引号（ICU 会当转义符）：${v}`);
      }
    }
  }
  // 🔴 反向：8 种文案不许在英文里**合并成一句**（合并之后站长看不出哪一类操作被挡住）
  const enTexts = demoCodes.map((c) => packs['en-US']['error.' + c]);
  assert.strictEqual(
    new Set(enTexts).size,
    demoCodes.length,
    '🔴 演示站那 8 条英文译文有重复 ⇒ 说明被合并成同一句了（站长会看不出被挡的是哪一类操作）：' +
      enTexts.join(' | '),
  );
});
