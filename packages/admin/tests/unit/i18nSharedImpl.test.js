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
// 🔴 期 3 第二批新增的消费方：`localePackParity` 原本自带两份正则实现（parsePack / parseTCalls）
//    和一份**手维护**的"哪些文件接了 i18n"清单 ⇒ 实测漏过一整批文件（期 3 第一批的 ImgTab/WalineTab
//    从来没被对账过，守卫却全绿）。现在它也 require 共享模块，所以一并钉进消费方网。
const PARITY = path.join(ADMIN, 'tests/unit/localePackParity.test.js');
// 🔴 期 9（服务端错误码框架）新增的消费方：它要 AST 解析**服务端的 TS 登记表**
//    （`node --test` 不能 require TS）与三份语言包，两件事都只有共享模块一份实现。
const SERVER_CODES = path.join(ADMIN, 'tests/unit/i18nServerErrorCodes.test.js');
// 🔴 期 9 第四批新增的消费方：`recycleBin.test.js` 用 AST 断言"组件里每个 core 文案函数调用都传了 t"
//    （判据是 CallExpression 的最后一个实参是不是 `t`），所以它也 require 共享模块、一并钉进网里。
const RECYCLE = path.join(ADMIN, 'tests/unit/recycleBin.test.js');

// 🔴 共享模块（唯一权威实现）
const astInventory = require(SHARED);

test('i18n 共享实现 · 反空转：这些文件都真实存在且非空', () => {
  for (const f of [SHARED, CLI, RATCHET, NAMING, PLURAL, PARITY, SERVER_CODES, RECYCLE]) {
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
    'collectTCalls',
    'collectTCallsFromFile',
    'collectChineseThrows',
    'collectChineseMessageProps',
    'collectServerErrorCodes',
    // 🔴 期 6 第三批新增：语言包/locale 数据文件的判据（`inventory.js` 与 `pageSurface.js` 共用一份权威）
    'isLocalePayloadFile',
    'readPack',
    'validateKeyShape',
    'needsIcuPlural',
  ]) {
    assert.strictEqual(typeof astInventory[fn], 'function', `共享模块没有导出 ${fn}（消费方会拿到 undefined）`);
  }
  assert.ok(Array.isArray(astInventory.REGISTERED_KEY_GROUPS) && astInventory.REGISTERED_KEY_GROUPS.length >= 7);
  // 🔴 20 → 19（期 7 第四批）：`init.restore.count.unknownSize` 提升为 `common.unknownSize` ⇒ 除名（这张表只许减）
  assert.ok(Array.isArray(astInventory.GRANDFATHERED_KEYS) && astInventory.GRANDFATHERED_KEYS.length === 19);
  // 🔴 简体专用字表也只许有共享模块这一份（localePackParity 与 `inventory.js --zh-tw-audit` 都用它）
  assert.ok(
    typeof astInventory.SIMPLIFIED_ONLY_ZH === 'string' && [...astInventory.SIMPLIFIED_ONLY_ZH].length >= 60,
    `SIMPLIFIED_ONLY_ZH 不见了或异常短（${[...(astInventory.SIMPLIFIED_ONLY_ZH || '')].length} 字）⇒ 守卫会退化成恒真`,
  );
  assert.ok(
    Array.isArray(astInventory.SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW) &&
      astInventory.SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW.every((e) => e && typeof e.ch === 'string' && typeof e.why === 'string'),
    'SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW 必须是 [{ch, why}] 形状（没有理由的例外就是缺陷）',
  );
});

test('i18n 共享实现 · 所有消费方都 require 同一份模块（结构判据）', () => {
  const consumers = {
    [CLI]: null,
    [RATCHET]: null,
    [NAMING]: null,
    [PLURAL]: null,
    [PARITY]: null,
    [SERVER_CODES]: null,
    [RECYCLE]: null,
  };
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
  for (const f of [RATCHET, NAMING, PLURAL, PARITY, SERVER_CODES, RECYCLE]) {
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
  // 🔴 localePackParity 曾经自带两份**正则**实现（`parsePack` 解析语言包、`parseTCalls` 抽调用点），
  //    已改成用共享模块的 readPack / collectTCalls ⇒ 这里钉住它们**不许再回来**：
  //    正则数语言包 key 在本仓库已被证明不可靠（`grep -c "^\s*'"` 得 128/117/116，真值 105/105/105）。
  const paritySrc = fs
    .readFileSync(PARITY, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
    .join('\n');
  assert.ok(
    !/function\s+parsePack\s*\(/.test(paritySrc),
    'localePackParity 里又出现了自己的 parsePack（正则解析语言包）⇒ 请改用 astInventory.readPack',
  );
  assert.ok(
    !/function\s+parseTCalls\s*\(/.test(paritySrc),
    'localePackParity 里又出现了自己的 parseTCalls（正则抽 t() 调用）⇒ 请改用 astInventory.collectTCalls',
  );
  assert.ok(
    /astInventory\.readPack\(/.test(paritySrc) && /astInventory\.collectTCalls\(/.test(paritySrc),
    'localePackParity 没有用上共享模块的 readPack / collectTCalls（那上面两条会变成"两边都没有"的假绿）',
  );
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
  // ⚠️ 本处 EXPECTED 是 `i18nHardcodedRatchet` 的 BUDGET 的**副本**（故意的：副本对不上就说明有一边漂了）。
  // 🔴 期 3 第一批只把两个新文件加进了棘轮、忘了同步这份副本（预算都是 0 所以总数没露馅）；
  //    第二批起补齐 ⇒ **两处的文件清单与总数必须逐字相同**（棘轮那条"清单条数"断言钉住条数，本条钉住数字）。
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
    'src/pages/SystemConfig/tabs/WalineTab.jsx': 0,
    'src/pages/SystemConfig/tabs/ImgTab.jsx': 0,
    'src/pages/SystemConfig/tabs/CommentSystem.jsx': 0,
    'src/pages/SystemConfig/tabs/Customizing.jsx': 4,
    'src/components/RecycleBin/index.jsx': 0,
    'src/components/RecycleBin/recycleCore.js': 0,
    'src/pages/SystemConfig/tabs/Token.tsx': 0,
    'src/pages/SystemConfig/tabs/Advance.jsx': 0,
    'src/pages/SystemConfig/tabs/User.jsx': 0,
    // 🔴 预算 1 = Caddy 页那个**URL 锚点**（永久例外，不是欠条；账目见棘轮里 TOTAL_BUDGET 的注释）
    'src/pages/SystemConfig/tabs/Caddy.jsx': 1,
    'src/components/SiteInfoForm/index.tsx': 0,
    'src/components/WaterMarkForm/index.tsx': 0,
    'src/components/StaticForm/index.tsx': 0,
    'src/pages/Static/img/index.tsx': 0,
    'src/pages/Static/img/tools.tsx': 0,
    'src/components/ObjTable/index.tsx': 0,
    'src/pages/CustomPage/index.jsx': 0,
    'src/components/CustomPageModal/index.tsx': 0,
    'src/pages/LogManage/index.jsx': 0,
    'src/pages/LogManage/tabs/Login.jsx': 0,
    'src/pages/LogManage/tabs/Pipeline.tsx': 0,
    'src/pages/LogManage/tabs/System.tsx': 0,
    'src/pages/Draft/index.jsx': 0,
    'src/pages/Draft/columes.jsx': 0,
    'src/components/NewDraftModal/index.jsx': 0,
    'src/components/ImportDraftModal/index.jsx': 0,
    'src/components/AuthorField/index.tsx': 0,
    'src/components/TagSelectField/index.jsx': 0,
    'src/components/ExportFormatDropdown/index.jsx': 0,
    'src/components/PublishDraftModal/index.jsx': 0,
    'src/components/UpdateModal/index.tsx': 0,
    'src/services/van-blog/accessPassword.js': 0,
    'src/components/NewArticleModal/index.jsx': 0,
    'src/components/ImportArticleModal/index.jsx': 0,
    'src/components/CoverImageField/index.jsx': 0,
    'src/pages/Article/index.jsx': 0,
    'src/pages/Article/columns.jsx': 0,
    'src/services/van-blog/batch.ts': 0,
    'src/components/CoverBackfillModal/index.jsx': 0,
    'src/services/van-blog/coverBackfill.js': 0,
    'src/components/RevisionHistory/index.jsx': 0,
    'src/components/RevisionHistory/revisionCore.js': 0,
    'src/services/van-blog/tagTokens.js': 0,
    'src/services/van-blog/importPathname.js': 0,
    'src/services/van-blog/schedule.js': 0,
    'src/components/PathnameField/index.jsx': 0,
    'src/services/van-blog/exportFormats.js': 1,
    'src/services/van-blog/exportMarkdown.tsx': 0,
    'src/services/van-blog/formatTime.js': 0,
    'src/services/van-blog/relativeTime.js': 0,
    'src/services/van-blog/tool.js': 0,
    'src/services/van-blog/check.ts': 0,
    'src/services/van-blog/parseMarkdownFile.jsx': 0,
    'src/components/CopyUploadBtn/index.tsx': 0,
    'src/components/UploadBtn/index.tsx': 0,
    'src/services/van-blog/requestError.js': 1,
    'src/components/Editor/history.tsx': 0,
    'src/components/Editor/emoji.tsx': 0,
    'src/components/Editor/insertMore.tsx': 0,
    'src/components/Editor/plugins/codeBlock.tsx': 0,
    'src/components/Editor/plugins/mobileToolbar.js': 0,
    'src/components/Editor/plugins/customContainer.tsx': 6,
    'src/components/Editor/imgUpload.tsx': 0,
    'src/components/Editor/fileUpload.tsx': 0,
    'src/components/Editor/transferRemote.tsx': 0,
    'src/components/EditorProfileModal/index.tsx': 0,
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
  assert.strictEqual(
    total,
    61,
    // 🔴 55 → 61（期 6 第一批）：多的 6 条是 `customContainer.tsx` 的容器模板 —— 被**插入用户文章正文**的
    //    Markdown（内容，不是界面文案），且 `customContainerRemark.js` 靠这几个中文标题识别存量文章的容器。
    // 🔴 54 → 55（期 7 第五批）：多的 1 条是 `requestError.js` 的 `SERVER_SESSION_EXPIRED_TEXT = '登录失效'`
    //    —— **与服务端比对的线路字面量**（永久例外，与 `已初始化` 同族）；显示文案已拆成 `request.sessionExpired` 走 t。
    // 🔴 53 → 54（期 7 第三批）：多的 1 条是 `exportFormats.js` 的 `导出说明.md`（**服务端产物文件名** = 线路契约，
    //    永久例外，与 Caddy URL 同类；文案那条走 `{note}` 占位符 ⇒ 语言包里没有汉字）。
    // 🔴 54 → 53：UpdateModal 那张跨层欠条**已还**（期 7 第一批把 accessPassword.js 接了注入式翻译器，
    //   实参与模板一起翻 ⇒ 该文件预算归 0）
    `裸中文总数应当是 61（棘轮的 TOTAL_BUDGET = 48 目标底 + Customizing 4 条欠条 + 9 条永久例外：Caddy URL 锚点 1、导出说明.md 1、登录失效线路字面量 1、容器模板 6），实际 ${total}`,
  );
  // 🔴 语言包解析的"进度下界"权威口径在 `i18nKeyNaming.test.js` 的 BASELINE_KEY_COUNT，
  //    本处**只**证明共享模块的 readPack 没坏（三份都解析得出、条数相等且非平凡）——
  //    同一个数字写两处就是两处口径，改一处忘另一处只是时间问题。
  const counts = ['zh-CN', 'zh-TW', 'en-US'].map(
    (l) => Object.keys(astInventory.readPack(path.join(ADMIN, `src/locales/${l}.ts`), l)).length,
  );
  assert.deepStrictEqual(
    counts,
    [counts[0], counts[0], counts[0]],
    `三份包解析出的 key 数不相等（${counts.join('/')}）⇒ readPack 坏了或包真的不齐`,
  );
  assert.ok(counts[0] >= 100, `只解析出 ${counts[0]} 个 key，疑似 readPack 坏了（不是包真的这么小）`);
});

test('i18n 共享实现 · 🔴 bareChinese 排除 `console.*` 的实参（口径），且**只**排除 console 里的', () => {
  // ## 为什么要有这条（2026-09-26 期 5 第四批）
  // `LogManage/tabs/System.tsx` 有一句 `console.error('[系统日志] 拉取失败', err)`：
  // 那是**开发者界面**、不是 UI 文案；而且翻它会反过来坏事 —— 日志文本跟着界面语言漂，
  // 按文本 grep 日志、以及 `leakAndErrorHardening` 那条"这个文件必须打 console.error"的钉子都会失效。
  // 🔴 这是**口径**改动（实测影响 admin src 的 7 条 / 3 个文件：Footer 5、Editor 1、LogManage/System 1），
  // 所以正负两个方向都要钉住：
  //   正：console 里的中文不计入 bareChinese，但 `consoleChinese()` 要能单独报出来（inventory 明着打印）；
  //   负：🔴 **同一个字符串出现在 console 之外时必须照常被计入**（否则"排除 console"会退化成"排除这句话"）。
  const eq = (a, b, m) => assert.strictEqual(a, b, m);
  eq(
    astInventory.bareChinese("console.error('[系统日志] 拉取失败', err);", 't').size,
    0,
    '🔴 console.* 里的中文不该计入 bareChinese（它是开发者界面，不是 UI 文案）',
  );
  eq(
    astInventory.bareChinese('console.log(`共 ${n} 张：失败`);', 't').size,
    0,
    '🔴 console.* 里的**模板串**同样不该计入',
  );
  assert.ok(
    astInventory.consoleChinese("console.error('[系统日志] 拉取失败', err);", 't').size >= 1,
    '🔴 consoleChinese 必须能把这些条数**单独报出来**（口径变化要看得见，不能静默扣掉）',
  );
  eq(
    astInventory.bareChinese("message.error('保存失败');", 't').size,
    1,
    '🔴 反向：`message.error` 是 UI 文案，必须照常被计入（否则这条口径就把所有错误提示都放过了）',
  );
  eq(
    astInventory.bareChinese("const a = '拉取失败';\nconsole.log(a);", 't').size,
    1,
    '🔴 反向：字符串**定义在 console 之外**、只是被 console 打印 ⇒ 必须计入（排除的是"位置"，不是"这句话"）',
  );
  // 🔴 真实源码上的钉子：`LogManage/tabs/System.tsx` 现在是"整页翻完、只留那句 console.error"的状态 ⇒
  //    它的 bareChinese 必须**恰好是 0**（UI 文案全进了 t() 的 defaultMessage 位，console 那句被口径排除），
  //    而 consoleChinese 必须仍然报得出那 1 条（证明"排除"是**看得见**的，不是悄悄丢掉）。
  //    ⚠️ 第一版这里写的是 `bareChinese >= 3`（当时 System.tsx 还没翻）⇒ 翻完就变成陈旧的假红；
  //    🔴 教训：**守卫的期望值要选一个"改造完成后仍然成立"的形状**，别钉住改造过程中的中间态。
  const sysRel = 'src/pages/LogManage/tabs/System.tsx';
  const sysSrc = fs.readFileSync(path.join(ADMIN, sysRel), 'utf8'); // 🔴 本文件没有 read() 助手，用 fs+ADMIN
  eq(
    astInventory.bareChinese(sysSrc, sysRel).size,
    0,
    '🔴 System.tsx 应该已经全量接 i18n（只剩那句刻意不翻的 console.error，而它不计入 bareChinese）',
  );
  assert.ok(
    astInventory.consoleChinese(sysSrc, sysRel).size >= 1,
    '🔴 System.tsx 里那句 console.error 的中文必须由 consoleChinese **单独报出来**（口径变化要看得见）',
  );
  assert.ok(
    /console\.error\('\[系统日志\] 拉取失败'/.test(sysSrc),
    '🔴 那句 console.error 的文本必须**逐字保持简体**（日志要能按文本 grep；leakAndErrorHardening 也钉着它）',
  );
});

test('i18n 共享实现 · 🔴 `pageSurface.js` 必须把**整页的块**都量出来（漏一个就会留下半页中文）', () => {
  // ## 为什么要有这条（2026-09-26 期 5 第八批）
  // "按页面切批次"的前提是**知道页面有哪些块**，而这件事本项目**靠人读 import 列表错了 4 次**：
  // `StaticForm`（图床设置页）、`ObjTable`（图片信息弹窗）、`UpdateModal`（草稿页）、
  // 🔴 `RevisionHistory`（文章页 —— 它是 **columns.jsx** 引进来的，不在 index.jsx 的 import 里）。
  // 所以把测量做成了工具（`scripts/i18n/pageSurface.js`：从入口递归跟 import，逐文件量 bareChinese），
  // 并且 🔴 在这里钉住它的输出：文章页必须量到 RevisionHistory 与 CoverBackfillModal（那两个漏过的），
  // 总量必须 ≥ 100 条（现在实测 117 条；工具坏掉时会变成"只报入口文件自己"⇒ 立刻红）。
  const { execFileSync } = require('child_process');
  const SURFACE = path.join(ROOT, 'scripts/i18n/pageSurface.js');
  const run = (entry, env) =>
    execFileSync(process.execPath, [SURFACE, entry], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, env || {}),
    });
  // 🔴 用 `SHOW_ALL=1` 拿**闭包成员**（含已翻完的 0 条文件）：判据钉的是"**结构**"（谁在这个页面里、
  //    多行 import 有没有被跟进去），🔴 与翻译进度无关 ⇒ 翻完一个文件不会再让这条假红
  //    （前两版钉子都因为钉了"还没翻"这个中间态而假红过，见 §7.153 B / §7.159 B）。
  const out = run('packages/admin/src/pages/Article/index.jsx', { SHOW_ALL: '1' });
  for (const must of ['RevisionHistory', 'CoverBackfillModal', 'exportFormats.js', 'UpdateModal']) {
    assert.ok(out.includes(must), `🔴 文章页闭包里必须有 ${must}（本项目曾漏掉 RevisionHistory）：\n` + out.slice(0, 400));
  }
  assert.ok(out.includes('exportFormats.js'), '🔴 服务层常量也算页面表面的一部分（导出格式的三项说明）');
  const m = out.match(/合计 (\d+) 条 \/ (\d+) 个文件（闭包共 (\d+) 个文件/);
  assert.ok(m, '🔴 没读到合计行 ⇒ 工具的输出形状变了（判据要跟着改，不要放宽）：\n' + out.slice(-300));
  // 🔴 钉**闭包规模**（结构，不随进度缩小）：文章页的 import 闭包实测 40+ 个文件；
  //    掉到 30 以下 ⇒ 递归没跟着 import 走（例如多行 import 又没被认出来）
  assert.ok(Number(m[3]) >= 30, `🔴 文章页闭包只有 ${m[3]} 个文件（下界 30）⇒ 递归坏了，会假绿`);

  // 🔴 第二条钉子专门打**多行 import**（这个工具自己刚踩过的坑）：
  //    `RevisionHistory/index.jsx` 的 `import { …20 行… } from './revisionCore'` 曾被
  //    "正则 + 200 字符窗口"整块漏掉（revisionCore.js 26 条没被量到），而当时那条钉子**没抓到**
  //    （它只查了两个名字、而且都在第 1 层）⇒ 🔴 工具的钉子必须覆盖"工具最容易坏的那种输入"。
  // 🔴 期 6 第三批：`pageSurface.js` 必须把**语言包/locale 数据**文件挑出去（口径与 `inventory.js` 一致）。
  //    `components/Editor/locales.ts` 里那 16 条中文**就是译文**（bytemd 的 mermaid 没有 zh_Hant、
  //    math-ssr 完全不带 locale）⇒ 数它等于叫下一个人去"翻译一个语言包"。
  //    第一版 pageSurface 直接调 bareChinese ⇒ 🔴 两个尺子口径漂了（它把 locales.ts 算进 16 条）。
  const outEditor = run('packages/admin/src/pages/Editor/index.jsx', { SHOW_ALL: '1' });
  assert.ok(
    outEditor.includes('语言包/locale 数据（不计入工作量）') && outEditor.includes('Editor/locales.ts'),
    '🔴 pageSurface 必须把 Editor/locales.ts 认成语言包并**说出来**（沉默少报与多报一样坏）：\n' +
      outEditor.slice(0, 500),
  );
  assert.ok(
    !/\d+ 条\s+packages\/admin\/src\/components\/Editor\/locales\.ts/.test(outEditor),
    '🔴 Editor/locales.ts 不该被当成"待翻译工作量"计数（它是 locale 数据本身）',
  );
  // 🔴 判据本身也要有反证：共享模块那条 isLocalePayloadFile 必须认得这两种形状、且不误伤普通组件
  assert.strictEqual(astInventory.isLocalePayloadFile('src/components/Editor/locales.ts'), true);
  assert.strictEqual(astInventory.isLocalePayloadFile('src/locales/zh-CN.ts'), true);
  assert.strictEqual(astInventory.isLocalePayloadFile('src/components/Editor/index.tsx'), false);
  assert.strictEqual(astInventory.isLocalePayloadFile('src/components/EditorProfileModal/index.tsx'), false);

  const out2 = run('packages/admin/src/components/RevisionHistory/index.jsx', { SHOW_ALL: '1' });
  assert.ok(
    out2.includes('revisionCore.js'),
    '🔴 多行 import 没被跟进去（revisionCore.js 就在那条 20 行的 import 后面）：\n' + out2.slice(0, 400),
  );
  assert.ok(
    out2.includes('formatTime.js'),
    '🔴 第 2 层依赖（revisionCore → formatTime）没被跟进去 ⇒ 递归深度不够：\n' + out2.slice(0, 400),
  );
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

test('i18n 共享实现 · collectTCalls 的尺子反证：三种形状都认，helper 定义与动态 id 不认', () => {
  // ① 最常见形状：t('id', '默认文案')
  const a = astInventory.collectTCalls(`const x = t('common.save', '保存');`, 'synthetic');
  assert.strictEqual(a.length, 1, `t('id','dm') 没被抽出来：${JSON.stringify(a)}`);
  assert.strictEqual(a[0].id, 'common.save');
  assert.strictEqual(a[0].defaultMessage, '保存');
  // ② 带插值的第三实参不能干扰前两个
  const b = astInventory.collectTCalls(`t('a.b.c', '共 {n} 项', { n: 3 });`, 'synthetic');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].defaultMessage, '共 {n} 项');
  // ③ formatMessage({ id, defaultMessage }) 对象形状
  const c = astInventory.collectTCalls(`intl.formatMessage({ id: 'a.b', defaultMessage: '中文' });`, 'synthetic');
  assert.strictEqual(c.length, 1, 'formatMessage 的对象形状没被抽出来');
  assert.strictEqual(c[0].id, 'a.b');
  assert.strictEqual(c[0].defaultMessage, '中文');
  // ④ 🔴 `t` helper 自己的定义处（简写属性、没有字面量）**必须不算**调用点 ——
  //    否则会对账出一个 id=undefined 的幽灵条目（实测：11 个文件里每个都有这一处）
  const d = astInventory.collectTCalls(`const t = (id, dm, v) => intl.formatMessage({ id, dm }, v);`, 'synthetic');
  assert.strictEqual(d.length, 0, `t() helper 的定义被当成了调用点：${JSON.stringify(d)}`);
  // ⑤ 动态 id 跳过；有字面量 id 但 defaultMessage 是变量的，仍要抽出 id（dm 记为 null，
  //    由消费方那条"每个调用点都必须带字面量 defaultMessage"去点名）
  const e = astInventory.collectTCalls(`t(someKey);\nt('a.b', dyn);`, 'synthetic');
  assert.strictEqual(e.length, 1, `动态 id 应当被跳过，实际：${JSON.stringify(e)}`);
  assert.strictEqual(e[0].id, 'a.b');
  assert.strictEqual(e[0].defaultMessage, null);
  // ⑥ 🔴 注释里的 t() 不算（AST 天然满足，但必须钉住 —— 正则实现正是在这里翻车：
  //    注释里写一句 t('x.y','…') 就会凭空多出一个"必须存在于语言包"的 key）
  const f = astInventory.collectTCalls(`// t('dead.key', '死条目')\nconst x = 1;\n`, 'synthetic');
  assert.strictEqual(f.length, 0, `注释里的 t() 被算成了调用点：${JSON.stringify(f)}`);
  // ⑦ fail-loud
  assert.throws(
    () => astInventory.collectTCalls('const = ;', 'broken.js'),
    /解析失败/,
    '解析失败没有抛错 ⇒ 会被当成"这个文件没接 i18n"，覆盖面就悄悄少了一个文件',
  );
});

test('i18n 共享实现 · 反向：真实源码里抽到的调用点必须与"人工数得出来的"一致（防抽多/抽漏）', () => {
  // 🔴 上面全是合成输入。这一条拿**真实文件**做交叉核实：
  //    CommentSystem.jsx 里 t() 调用点的数量，用另一把独立的尺子（剥注释后数 `t('` 出现次数）复核，
  //    两把尺子必须给出同一个数字 ⇒ 既证明没抽漏，也证明没把 helper 定义/注释抽进来。
  const rel = 'src/pages/SystemConfig/tabs/CommentSystem.jsx';
  const src = fs.readFileSync(path.join(ADMIN, rel), 'utf8');
  const viaAst = astInventory.collectTCalls(src, rel).length;
  const viaText = (
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
      .match(/\bt\(\s*'/g) || []
  ).length;
  assert.ok(viaAst >= 30, `${rel} 只抽到 ${viaAst} 个调用点，疑似尺子坏了（这个文件已全量接 i18n）`);
  assert.strictEqual(
    viaAst,
    viaText,
    `${rel}: AST 抽到 ${viaAst} 个调用点，而独立文本尺子数到 ${viaText} 个 ⇒ 有一把尺子抽多/抽漏了`,
  );
});
