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
const THROW_BUDGET = 211;

/**
 * 🔴 **第二个**棘轮：`message:` 属性带中文的站点（`return { statusCode, message: '中文' }` 那一族）。
 * 为什么必须单列：只数 `throw` 的话，🔴 这一族可以随便新增而没有任何守卫会红 ——
 * 而实测它有 **108** 处（8 在 throw 里 + **100 在 throw 外**，"演示站禁止…"几乎全是这个形状），
 * 比 throw 那一族的一半还多。基线 2026-09-25 实测 **108**（30 个文件），只许减不许增。
 */
const MESSAGE_BODY_BUDGET = 108;

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
  assert.ok(
    scan2.total > 50,
    `只数出 ${scan2.total} 个「message: 中文」站点（应远大于 50）⇒ 尺子坏了（而 0 ≤ 预算 会让棘轮恒真）`,
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
    const needles = [`codedError('${code}'`, `codedBody('${code}'`];
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
  assert.deepStrictEqual(seen[0], {
    id: 'error.categoryDuplicateOnCreate',
    // 🔴 defaultMessage 必须是**服务端那句中文**：漏译时用户看到的是今天的行为，而不是裸 key
    defaultMessage: '分类名重复，无法创建！',
    values: undefined,
  });
  assert.strictEqual(
    re.adaptAdminResponse(codedWithParams, { t: fakeT }).errorMessage,
    '#error.someFutureCode',
  );
  assert.deepStrictEqual(seen[1].values, { n: 30 }, 'params 没有透传给翻译器（ICU 插值会失效）');

  // 🔴 传了 t 但**没有码** ⇒ 原样回落 message（渐进迁移的关键：任何时刻都可用）
  assert.strictEqual(re.adaptAdminResponse(uncoded, { t: fakeT }).errorMessage, '还没有迁移的中文消息');
  // 🔴 协议级的两条特例仍然优先（它们不带码，也不许被翻译盖掉）
  assert.strictEqual(
    re.adaptAdminResponse({ statusCode: 401, message: 'Unauthorized' }, { t: fakeT }).errorMessage,
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
