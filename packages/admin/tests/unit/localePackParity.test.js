/**
 * 🔴 多语言守卫：三份语言包的 key 集合必须完全相等，且翻译必须真的存在。
 *
 * 覆盖面：**第一期**＝安装页家族 + 登录/忘记密码页 + 语言切换器；
 * 🔴 **第二期第一块**＝后台侧边栏菜单（`config/routes.js` 的 `locale` 字段 ↔ 三份包的 `menu.*`）；
 * 🔴 **期 2 / 期 3 起**＝**所有**已接 i18n 的源文件，覆盖面由 `discoverI18nFiles()` 遍历 `src/`
 * 自动发现（不再是手维护的清单）⇒ 每翻一批，这批的对账自动生效，不需要记得回来改本文件。
 *
 * **它防的是本仓库反复付过学费的那一族失效**：一个性质有多处口径 ⇒ 改一处忘另一处
 * （API Token 默认值曾有六处口径、两处是错的；`api.md` 的限流表曾漏掉一整个桶）。
 * 多语言天生就是「同一批 key、N 份口径」，所以**必须**有守卫，否则加一个 key 忘了翻译
 * 是静默的（用户会看到裸 key，或者看到永远不变的中文）。
 *
 * 形状刻意与 `siteInfoFieldParity.test.js` 同族（三方集合双向相等 + 反空转 + 尺子反证），
 * 因为那一条已被证明是有效的模式。
 *
 * ⚠️ 语言包是 `.ts`，而本目录是 `node --test`（解析不到 TS 别名与 ESM）⇒ 不能 `require()` 它们。
 * 🔴 但也**不要退回正则解析**：包与调用点都走共享模块 `scripts/i18n/astInventory.js` 的
 * `readPack()` / `collectTCalls()`（`@babel/parser` + typescript 插件，与其它三条 i18n 守卫同一份实现）。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

// 🔴 AST 逻辑（解析语言包 / 抽 t() 调用点）**只用共享模块这一份实现**：
//    `scripts/i18n/astInventory.js`（CLI 工具 `scripts/i18n/inventory.js` 与另外三条 i18n 守卫同源，
//    由 `i18nSharedImpl.test.js` 钉住）。
// ⚠️ 本文件曾经自带两份正则实现（`parsePack` / `parseTCalls`）：
//    🔴 正则数语言包 key 在本仓库已被证明不可靠（`grep -c "^\s*'"` 得 128/117/116，真值 105/105/105），
//    🔴 而手维护的"哪些文件接了 i18n"清单**实测漏过**（期 3 第一批的 ImgTab/WalineTab 没进清单
//       ⇒ 它们 31 条 defaultMessage 与语言包是否一致从来没被查过，守卫却全绿）。
//    ⇒ 现在：包用 AST 解析，覆盖面**遍历源码目录自动发现**（跟着代码走，不跟着清单走）。
const astInventory = require('../../../../scripts/i18n/astInventory.js');

const adminRoot = path.resolve(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

const LOCALES = ['zh-CN', 'zh-TW', 'en-US'];
const PACK_REL = (l) => `src/locales/${l}.ts`;
const INIT_DIR = 'src/pages/InitPage';

/** 剥掉块注释与整行注释（⚠️ 不剥行尾注释：那会啃掉 URL 之类的内容）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const packs = {};
for (const l of LOCALES) {
  const rel = PACK_REL(l);
  assert.ok(existsSync(path.join(adminRoot, rel)), `语言包不存在：${rel}`);
  // 🔴 readPack 内部 fail-loud：解析出 0 个 key 会抛错，不会出现"三份都空 ⇒ 集合相等"的假绿
  packs[l] = astInventory.readPack(path.join(adminRoot, rel), rel);
}

/**
 * 🔴 自动发现「已经接了 i18n 的源文件」：遍历 `src/`，谁的 AST 里有 `collectTCalls`
 *    抽得到的调用点（`t('id','默认文案')` 或 `formatMessage({id, defaultMessage})`），谁就在覆盖面里。
 *
 * 为什么不用手维护的清单：见文件头（清单实测漏过一整批文件，而漏的那批守卫全绿）。
 * ⚠️ 跳过 `.umi*`（umi 生成物，数它会把覆盖面变成假的）与 `locales`（语言包本身没有调用点）。
 */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.umi', '.umi-production', 'locales']);
const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
function discoverI18nFiles(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(ent.name)) continue;
      discoverI18nFiles(abs, out);
    } else if (ent.isFile() && SCAN_EXTS.has(path.extname(ent.name))) {
      // 🔴 解析失败会抛错（fail-loud）—— "解析不了"绝不等于"这个文件没接 i18n"
      if (astInventory.collectTCalls(readFileSync(abs, 'utf8'), abs).length > 0) out.push(abs);
    }
  }
  return out;
}

/**
 * 🔴 允许 zh-TW 与 zh-CN **逐字相同**的 key 白名单。
 *
 * 这不是偷懒：这几条**在简繁两种写法下本来就是同一个字符串**
 * （不含任何简繁异形字），例如「取消」「文章」「初始化成功!」。
 * 把它们排除在「必须不同」之外是正确的；🔴 但白名单必须**恰好等于**实际相同的那一批，
 * 这样任何人新增了第 6 条相同的值都会红 ⇒ 他必须有意识地把它加进白名单并说明理由。
 */
const IDENTICAL_ZH_TW_OK = [
  'init.success.title', // 初始化成功! —— 五个字简繁同形
  'init.baseUrl.invalidLine2', // 例: https://blog.example.com —— 只有「例」一个字，简繁同形
  'init.restore.confirmCancel', // 取消
  'init.restore.count.articles', // 文章
  'init.restore.count.unknownSize', // 未知大小
  'init.restore.uninitLine1Strong', // 不包含 —— 三个字简繁同形
  // 🔴 第二期第一块（侧边栏菜单）新增的三条：这几个词简繁逐字相同，
  //    「文章」「草稿」「附件」「管理」四个字都不含简繁异形字。
  //    ⚠️ 这不是偷懒：把它们排除在「必须不同」之外是正确的，而白名单必须**恰好等于**
  //    实际相同的那一批 ⇒ 谁再多复制一条简体当繁中，这条就会红。
  // 🔴 第二期第二块（侧边栏底部 / 主题三档 / 登出提示）新增的五条：
  //    「主站」「登出」「亮色模式」「暗色模式」「登出成功！」简繁逐字相同
  //    （不含简繁异形字：主/站/登/出/亮/色/模/式/暗/成/功 都同形）。
  //    ⚠️ 白名单必须**恰好等于**实际相同的那一批 ⇒ 谁再多复制一条简体当繁中，这条就会红。
  'common.mainSite', // 主站
  'common.logout', // 登出
  'theme.light', // 亮色模式
  'theme.dark', // 暗色模式
  'logout.ok', // 登出成功！
  'menu.article', // 文章管理
  'menu.draft', // 草稿管理
  'menu.file', // 附件管理
  // 🔴 「文章 ID」简繁逐字相同（ID 是拉丁字母，无繁简差异）
  'sysconf.img.colArticleId',
  // 🔴 期 3 第二批（CommentSystem / Customizing）新增的两条：
  //    「保存」= 保 + 存，「更新成功！」= 更 + 新 + 成 + 功 + ！
  //    逐字核实这 6 个字**都不是简化字**（简繁同形，没有对应的繁体异形字）；
  //    本机可查的繁中语料 antd `lib/locale/zh_TW.js` 里「成」「功」也正是这两个字形。
  //    ⚠️ 别把这条当成"可以随便加"的先例：白名单必须**恰好等于**实际相同的那一批。
  'common.save', // 保存
  'common.updateSuccess', // 更新成功！
  // 🔴 期 9 第四批（回收站）新增 8 条：都是**简繁同形**的短词或纯标点/占位符模板 ——
  //    操作 / 作者（两个字简繁同形）、文章 / 草稿（同上）、「{title}」与（{message}）（只有引号与占位符）、
  //    （需要 {permission}）（需/要/perm 均同形）。逐字核实过，不是偷懒。
  'recycle.colAuthor', // 作者
  'recycle.titleQuoted', // 「{title}」
  'recycle.actionFallback', // 操作
  'recycle.labelArticle', // 文章
  'recycle.labelDraft', // 草稿
  'recycle.detailWrap', // （{message}）
  'recycle.permissionWrap', // （需要 {permission}）
  // 🔴 期 3 第三批：`common.colOption`（从 recycle.colOption **提升**上来，Token 页与回收站共用）
  //    与 `sysconf.token.title`（'Token 管理' —— Token 是拉丁字母，管理简繁同形）。
  'common.colOption', // 操作
  'sysconf.token.title', // Token 管理
  // 🔴 期 3 第四批：`common.edit`（修改 —— 修/改 两字简繁同形）
  'common.edit', // 修改
  // 🔴 期 4（SiteInfoForm）新增 3 条：`作者名字` / `作者描述` / `作者 Logo` ——
  //    作/者/名/字/描/述 与 Logo 全部简繁同形，逐字核实过（不是偷懒）。
  'siteInfo.author.label', // 作者名字
  'siteInfo.authorDesc.label', // 作者描述
  'siteInfo.authorLogo.label', // 作者 Logo
  // 🔴 期 5 第二批（图片管理页）新增 14 条：都是**简繁同形**的短词或纯占位符模板 ——
  //    高 / 格式 / 尺寸 / 大小 / 列表 / 信息类短词，以及 `{count} 篇`、`文章 {id}`、`被 {count} 篇文章引用`
  //    这类"只有量词与占位符"的模板（篇/文章/引用/被/等共 都简繁同形）。逐字核实过，不是偷懒。
  'img.refsTitle', // 被引用文章
  'img.refsColId', // 文章 ID
  'img.colFormat', // 格式
  'img.colDimensions', // 尺寸
  'img.colBytes', // 大小
  'img.colRefs', // 引用文章
  'img.notReferenced', // 未被引用
  'img.refPopoverTitle', // 被 {count} 篇文章引用
  'img.refArticleFallback', // 文章 {id}
  'img.refMore', // …等共 {count} 篇
  'img.refCount', // {count} 篇
  'img.viewList', // 列表
  'img.uploadExists', // {name} 已存在!
  'img.meta.height', // 高
  'common.colValue', // 值（ObjTable 的列头，简繁同形）
  'customPage.pathPlaceholder', // 例如 /uptime（只有「例如」两字… 例/如 简繁同形）
];

/**
 * 🔴 「简体专用字」表与它的例外清单**只有一处权威实现**：`scripts/i18n/astInventory.js` 的
 * `SIMPLIFIED_ONLY_ZH` / `SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW`。
 * 扩充纪律、两次漏字（「现」「点」）的实测教训、以及"凭看着像简体批量加会误伤"的证据都记在那里 ——
 * 因为审计工具 `node scripts/i18n/inventory.js --zh-tw-audit` 用的是同一份，
 * 🔴 两处各存一份必然漂移（本仓库已为"同一性质两处口径"反复付过学费）。
 * 这条与上面的白名单互补：白名单管「合法相同」，这张表管「非法相同」。
 */
const SIMPLIFIED_ONLY = astInventory.SIMPLIFIED_ONLY_ZH;

describe('多语言第一期：三份语言包的 key 集合完全相等', () => {
  it('zh-CN / zh-TW / en-US 三方的 key 集合两两相等（双向）', () => {
    const a = Object.keys(packs['zh-CN']).sort();
    const b = Object.keys(packs['zh-TW']).sort();
    const c = Object.keys(packs['en-US']).sort();
    assert.deepEqual(b, a, 'zh-TW 的 key 集合与 zh-CN 不一致（漏翻译或多了幽灵 key）');
    assert.deepEqual(c, a, 'en-US 的 key 集合与 zh-CN 不一致（漏翻译或多了幽灵 key）');
  });

  it('反空转：key 数不少于 50（否则「集合相等」可能是三份都空）', () => {
    const n = Object.keys(packs['zh-CN']).length;
    assert.ok(n >= 50, `只解析到 ${n} 个 key，疑似解析器坏了而不是语言包真的这么小`);
    for (const l of LOCALES) {
      assert.ok(
        Object.values(packs[l]).every((v) => typeof v === 'string' && v.trim().length > 0),
        `${l} 里有空值`,
      );
    }
  });

  it('反空转：解析器不是恒返回空 —— 已知必然存在的 key 必须被解析到', () => {
    for (const l of LOCALES) {
      assert.ok('init.step.user' in packs[l], `${l} 连 init.step.user 都没解析到 ⇒ 解析器坏了`);
      assert.ok('init.setupKey.hint1' in packs[l], `${l} 缺 init.setupKey.hint1`);
    }
  });
});

describe('多语言第一期：翻译必须真的存在（不是复制简体充数）', () => {
  it('en-US 的每一条都必须与 zh-CN 不同', () => {
    const same = Object.keys(packs['zh-CN']).filter(
      (k) => packs['en-US'][k] === packs['zh-CN'][k],
    );
    assert.deepEqual(same, [], `en-US 这些 key 直接抄了简体：${same.join(', ')}`);
  });

  it('en-US 里不许出现中日韩统一表意文字（除了刻意保留的命令/日志标记）', () => {
    // 🔴 两处刻意保留简体：`grep 初始化密钥` 与启动日志里那一行的标签，
    //    因为它们匹配的是 **server 实际输出的文字**，翻译了命令就抓不到东西。
    const ALLOW = ['init.setupKey.placeholder', 'init.setupKey.hint2'];
    const bad = Object.keys(packs['en-US']).filter(
      (k) => !ALLOW.includes(k) && /[\u4e00-\u9fff]/.test(packs['en-US'][k]),
    );
    assert.deepEqual(bad, [], `en-US 这些 key 还留着中文：${bad.join(', ')}`);
    // 反过来钉住：那两处**必须**真的含中文（否则说明有人把命令也翻了 ⇒ 命令会失效）
    for (const k of ALLOW) {
      assert.match(
        packs['en-US'][k],
        /初始化密钥/,
        `${k} 必须原样保留「初始化密钥」：它匹配的是 server 的简体日志输出`,
      );
    }
  });

  it('zh-TW 与 zh-CN 相同的 key 必须恰好等于白名单（多一条少一条都红）', () => {
    const same = Object.keys(packs['zh-CN'])
      .filter((k) => packs['zh-TW'][k] === packs['zh-CN'][k])
      .sort();
    assert.deepEqual(
      same,
      [...IDENTICAL_ZH_TW_OK].sort(),
      'zh-TW 与 zh-CN 逐字相同的 key 集合变了：新增的说明忘了做繁中转换，' +
        '减少的说明白名单里有条目已经不需要了（请一并删掉，别留死条目）',
    );
  });

  it('zh-TW 里不许出现简体专用字（防「整包复制简体」）', () => {
    const hits = [];
    for (const [k, v] of Object.entries(packs['zh-TW'])) {
      // 🔴 逐值全扫，**不跳过任何 key**：`IDENTICAL_ZH_TW_OK` 那批本来就与简体逐字相同，
      //    但它们（取消 / 文章 / 保存 / 更新成功！…）不含简体专用字 ⇒ 不会误报。
      //    ⚠️ 这里以前写着"白名单里的那几条跳过"而代码并没有跳过 —— 注释与代码不符已修正。
      const found = [...v].filter((ch) => SIMPLIFIED_ONLY.includes(ch));
      if (found.length > 0) hits.push(`${k}: ${[...new Set(found)].join('')}`);
    }
    assert.deepEqual(
      hits,
      [],
      `zh-TW 这些值里含简体专用字（疑似直接复制简体）：\n  ${hits.join('\n  ')}\n` +
        '修法：改成繁体字形（套地区用词，不是字形转换）；' +
        '🔴 若你确信某个字**在繁体里也合法**（例如 只 / 量 / 限 / 台），那是字表收错了字 —— ' +
        '去 `scripts/i18n/astInventory.js` 的 SIMPLIFIED_ONLY_ZH 把它删掉，并对照上游繁中语料逐字核实。',
    );
  });

  it('🔴 「简体专用字表」与「刻意保留简体」的例外清单必须互斥、有理由、且不留死条目', () => {
    const allowed = astInventory.SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW;
    // 反空转：清单为空时下面两条会恒真（"没有重叠""没有死条目"），所以先钉住它非空
    assert.ok(
      allowed.length >= 1,
      '例外清单空了 ⇒ 要么确实没有例外（那就把本断言与共享模块里的清单一并删掉，别留恒真的绿），要么被误删了',
    );
    const overlap = allowed.filter((e) => SIMPLIFIED_ONLY.includes(e.ch)).map((e) => e.ch);
    assert.deepEqual(
      overlap,
      [],
      `这些字同时出现在「简体专用字表」与「刻意保留例外」里（两套机制打架，必须二选一）：${overlap.join(' ')}`,
    );
    const dead = allowed.filter((e) => !Object.values(packs['zh-TW']).some((v) => v.includes(e.ch)));
    assert.deepEqual(
      dead.map((e) => e.ch),
      [],
      `例外清单里有死条目（zh-TW 里已经不含这些字了）：${dead.map((e) => e.ch).join(' ')} —— 请连理由一起删掉`,
    );
    for (const e of allowed) {
      assert.ok(
        typeof e.why === 'string' && e.why.length > 10,
        `例外「${e.ch}」没有写理由 —— 没有理由的例外就是缺陷（下一个人无法判断它该不该留）`,
      );
    }
  });
});

describe('多语言：每个已接 i18n 的文件里的每个 id 都必须在三份包里存在，且 defaultMessage 与 zh-CN 一致', () => {
  // 🔴 覆盖面**自动发现**（理由见文件头与 discoverI18nFiles）：不再手维护"哪些文件接了 i18n"的清单。
  const FILES = discoverI18nFiles(path.join(adminRoot, 'src'), [])
    .map((abs) => path.relative(adminRoot, abs).split(path.sep).join('/'))
    .sort();
  const calls = [];
  for (const rel of FILES) {
    for (const c of astInventory.collectTCalls(read(rel), rel)) calls.push({ ...c, rel });
  }

  it('反空转：自动发现确实找到了文件与调用点（不是遍历/解析器坏了）', () => {
    // 🔴 这两个下界**只许往上调**：每翻译完一批文件，覆盖面就该跟着涨；
    //    谁把它调小 ⇒ 等于悄悄缩覆盖面（本仓库最忌讳的那类"假绿"）。
    // ⚠️ 文件下界是 **10** 而不是 11：`InitPage/setupKeyCore.js` 与 `restoreCore.js` 是**丁类核心模块**
    //    （纯 JS、被 `node --test` 直接 require、拿不到 umi 运行时）⇒ 它们用**注入式翻译器**，
    //    调用点是 `t(id, 中文常量)` 这种**动态 id**，自动发现**看不见**（`collectTCalls` 刻意跳过动态 id）。
    //    它们的对账由本文件下面那个「纯 JS 核心模块的注入式翻译器」describe 单独钉（SETUP_KEY_HINT_IDS ↔ 三份包）。
    // 🔴 10 → 12（期 9 第四批：RecycleBin 两个文件）→ **14 / 260**（期 3 第三批：`Token.tsx` + `Advance.jsx`；
    //    实测 14 个文件 / 266 个调用点，下界取 260 留一点余量）。⚠️ 下界只许往上调：谁调小就是悄悄缩覆盖面。
    assert.ok(
      FILES.length >= 24,
      `只自动发现 ${FILES.length} 个已接 i18n 的文件（下界 24）⇒ 遍历或解析器坏了`,
    );
    assert.ok(
      calls.length >= 680,
      `只抽到 ${calls.length} 个 t() 调用点（下界 680）⇒ 疑似解析器坏了`,
    );
    // 🔴 反向钉住"遍历没跑偏"：这几个是已知必然在覆盖面里的文件（漏了任何一个都说明跳过逻辑写宽了）
    for (const rel of [
      'src/app.jsx',
      'src/pages/InitPage/index.tsx',
      'src/pages/SystemConfig/tabs/CommentSystem.jsx',
      'src/pages/SystemConfig/tabs/Customizing.jsx',
      'src/components/RecycleBin/index.jsx',
      'src/components/RecycleBin/recycleCore.js',
      'src/pages/SystemConfig/tabs/Token.tsx',
      'src/pages/SystemConfig/tabs/Advance.jsx',
      'src/pages/SystemConfig/tabs/User.jsx',
      'src/pages/SystemConfig/tabs/Caddy.jsx',
      'src/components/SiteInfoForm/index.tsx',
      'src/components/WaterMarkForm/index.tsx',
      'src/components/StaticForm/index.tsx',
      'src/pages/Static/img/index.tsx',
      'src/pages/Static/img/tools.tsx',
      'src/components/ObjTable/index.tsx',
      'src/pages/CustomPage/index.jsx',
      'src/components/CustomPageModal/index.tsx',
    ]) {
      assert.ok(FILES.includes(rel), `${rel} 没被自动发现 ⇒ 遍历跳过了它（覆盖面是假的）`);
    }
  });

  it('每个调用点都必须带字面量 defaultMessage（缺了它，语言包万一少一个 key 用户就看到裸 key）', () => {
    const bare = calls.filter(
      (c) => typeof c.defaultMessage !== 'string' || c.defaultMessage.length === 0,
    );
    assert.deepEqual(
      bare.map((c) => `${c.rel}:${c.line} → ${c.id}`),
      [],
      '这些 t() 调用点没有字面量 defaultMessage（第二实参必须是与 zh-CN 包逐字相同的中文）：\n  ',
    );
  });

  it('🔴 不稳定的 `t` 不许出现在 useCallback/useEffect/useMemo 的依赖数组里（会造成无限渲染/请求循环）', () => {
    // ## 这条守的是什么（实测事故，2026-09-26 期 9 第四批）
    // `const t = (id, dm, values) => intl.formatMessage(...)` **每次渲染都是新函数**；
    // 一旦它进了 `useCallback(..., [t])`，而那个 callback 又被 `useEffect` 依赖 ⇒
    // 每轮渲染都重建 ⇒ effect 每轮都重跑 ⇒ **无限请求循环**（回收站抽屉表格永远 loading、
    // 一行都不渲染，还把服务端 admin 限流打满，后续请求全 429）。
    // 🔴 **单测看不见这个缺陷**（组件不跑），只有浏览器活体证据能抓到 ⇒ 所以要在这里用 AST 钉住。
    // 修法：`const t = useCallback((id, dm, values) => intl.formatMessage(...), [intl])`
    //（`intl` 只在语言变化时换引用 ⇒ 既稳定、又能在切语言后拿到新译文）。
    const HOOKS = new Set(['useCallback', 'useEffect', 'useMemo']);
    const offenders = [];
    for (const rel of FILES) {
      const src = read(rel);
      const stableT = /const\s+t\s*=\s*useCallback\(/.test(src);
      const ast = astInventory.parseSource(src, rel);
      astInventory.walkAst(ast.program, (nd) => {
        if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'Identifier') return;
        if (!HOOKS.has(nd.callee.name)) return;
        const args = nd.arguments || [];
        const last = args[args.length - 1];
        if (!last || last.type !== 'ArrayExpression') return;
        const hasT = (last.elements || []).some((el) => el && el.type === 'Identifier' && el.name === 't');
        if (hasT && !stableT) {
          offenders.push(`${rel}:${nd.loc ? nd.loc.start.line : '?'} ${nd.callee.name}([…, t]) 而 t 不是 useCallback 包的`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      '🔴 这些地方的依赖数组里放了**每次渲染都会变**的 t（会造成无限渲染/请求循环，界面上表现为永远 loading）：\n  ' +
        offenders.join('\n  ') +
        '\n修法：const t = useCallback((id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values), [intl]);',
    );
  });

  it('🔴 hook 的回调体里用了 `t`，依赖数组就必须带上 `t`（否则切语言后仍是旧译文）', () => {
    // ## 这条与上一条（"不稳定的 t 不许进依赖数组"）是**一对**，缺一条就有缺陷：
    //   - 只钉"稳定" ⇒ 有人图省事把 `t` 从依赖数组里删掉，闭包永远闭住**首轮渲染**的翻译器
    //     ⇒ 🔴 切语言之后再触发的提示仍是旧语言（要重挂载才更新）。实测就是这样发现的：
    //     `CommentSystem.jsx` 的 `load` 原本是 `useCallback(..., [])`，而它体内用了 `t`。
    //   - 只钉"声明" ⇒ 有人会放一个不稳定的 `t` 进去 ⇒ 无限渲染/请求循环（§7.144 A）。
    // ⇒ 正确的形状只有一个：`t` 用 `useCallback([intl])` 包，**并且**出现在用到它的那些依赖数组里。
    const HOOKS = new Set(['useCallback', 'useEffect', 'useMemo']);
    const refersToT = (nd) => {
      let found = false;
      const walk = (n) => {
        if (!n || typeof n !== 'object' || found) return;
        if (n.type === 'Identifier' && n.name === 't') {
          found = true;
          return;
        }
        for (const k of Object.keys(n)) {
          if (k === 'loc') continue;
          const v = n[k];
          if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && walk(x));
          else if (v && typeof v === 'object' && v.type) walk(v);
        }
      };
      walk(nd);
      return found;
    };
    const stale = [];
    for (const rel of FILES) {
      const src = read(rel);
      const ast = astInventory.parseSource(src, rel);
      astInventory.walkAst(ast.program, (nd) => {
        if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'Identifier') return;
        if (!HOOKS.has(nd.callee.name)) return;
        const args = nd.arguments || [];
        if (args.length < 2) return; // 没有依赖数组（例如 useEffect(fn)）⇒ 每次渲染都跑，不存在 staleness
        const deps = args[args.length - 1];
        if (!deps || deps.type !== 'ArrayExpression') return;
        if (!refersToT(args[0])) return;
        const names = (deps.elements || []).map((e) => (e && e.type === 'Identifier' ? e.name : null));
        if (!names.includes('t')) {
          stale.push(
            `${rel}:${nd.loc ? nd.loc.start.line : '?'} ${nd.callee.name} 的回调体用了 t，但依赖数组是 [${names
              .filter(Boolean)
              .join(', ')}]`,
          );
        }
      });
    }
    assert.deepEqual(
      stale,
      [],
      '🔴 这些 hook 闭包住了**首轮渲染的翻译器**（切语言后提示/文案仍是旧语言，要重挂载才更新）：\n  ' +
        stale.join('\n  ') +
        '\n修法：把 t 加进依赖数组（并且 t 必须是 useCallback([intl]) 包的，见上一条断言）。',
    );
  });

  it('🔴 翻译器名 `t` 不许被遮蔽（形参 / 解构），否则那几条文案会悄悄不跟随语言', () => {
    // ## 这条守的是什么（本仓库已实测踩到 **3 次**）
    // 组件里的翻译器叫 `t`，而 `t` 是 JS 里最常见的临时形参名之一 ⇒ **遮蔽不会报错**，
    // 只会让某几条文案悄悄用上错误的值（甚至把翻译器当成标签字符串渲染出来）。
    // 实测三例：`RecycleBin/index.jsx` 的 `const { articles: list, total: t } = …`、
    // 同文件的 `record.tags.map((t) => …)`、以及 `User.jsx` 的 `data.map((t) => getPermissionLabel(t))`。
    // 🔴 更阴的是 `fetchList` 里那个：`try` 块里的 `t` 是 total、`catch` 块里的 `t` 是翻译器 ——
    //    **同一个函数里同名不同物**，读代码的人一定会看错。
    //
    // ## 判据（两条，都是 AST，不靠正则）
    // ① 文件里声明了翻译器（`const t = …`）⇒ 任何函数/箭头函数的**形参**都不许叫 `t`；
    // ② 任何**解构**（对象/数组模式）都不许绑定出名为 `t` 的变量。
    // ⚠️ `recycleCore.js` 那类**注入式翻译器**模块故意豁免①：它的每个文案函数都用形参 `t`
    //    （`function purgeOkText(t = IDENTITY_T)`），那是**同一个东西**、不是遮蔽；它没有 `const t = …`。
    const offenders = [];
    for (const rel of FILES) {
      const src = read(rel);
      // 🔴 判据要挑对：**"组件级翻译器"**= 这个文件用 `useIntl()` 且声明了 `const t = …`。
      //    第一版只看 `const t = ` ⇒ `recycleCore.js` 被误伤（它里面那句
      //    `const t = typeof options.t === 'function' ? options.t : IDENTITY_T` 是**局部翻译器绑定**，
      //    而它的 `function xxx(t = IDENTITY_T)` 形参正是注入式翻译器本身，不是遮蔽）。
      const declaresTranslator = /useIntl\(\)/.test(src) && /const\s+t\s*=/.test(src);
      const ast = astInventory.parseSource(src, rel);
      const paramHits = [];
      const destructHits = [];
      const checkPattern = (pat, where) => {
        if (!pat) return;
        if (pat.type === 'Identifier' && pat.name === 't') destructHits.push(where);
        if (pat.type === 'ObjectPattern') {
          for (const pr of pat.properties || []) {
            const v = pr.value || pr.argument;
            if (v && v.type === 'Identifier' && v.name === 't') destructHits.push(`${where}（对象解构）`);
            checkPattern(v, where);
          }
        }
        if (pat.type === 'ArrayPattern') {
          for (const el of pat.elements || []) if (el) checkPattern(el, `${where}（数组解构）`);
        }
      };
      astInventory.walkAst(ast.program, (nd) => {
        const line = nd.loc ? nd.loc.start.line : '?';
        if (
          nd.type === 'FunctionDeclaration' ||
          nd.type === 'FunctionExpression' ||
          nd.type === 'ArrowFunctionExpression'
        ) {
          for (const pa of nd.params || []) {
            if (pa.type === 'Identifier' && pa.name === 't') paramHits.push(`第 ${line} 行形参 t`);
            if (
              declaresTranslator &&
              pa.type === 'AssignmentPattern' &&
              pa.left &&
              pa.left.type === 'Identifier' &&
              pa.left.name === 't'
            ) {
              paramHits.push(`第 ${line} 行形参 t（带默认值）`);
            }
            // 🔴 只对**解构形状**的形参查（ObjectPattern/ArrayPattern/带默认值的解构）；
            //    普通 Identifier 形参由上面那条"组件级翻译器"规则管 ——
            //    第一版把两者混在一起，结果 `recycleCore.js` 的 `function xxx(t = IDENTITY_T)`
            //    被当成"解构出 t"误伤了 5 处（判据写错的典型症状：红的地方全是**合法**代码）。
            if (pa.type !== 'Identifier') checkPattern(pa, `第 ${line} 行`);
          }
        }
        if (nd.type === 'VariableDeclarator' && (nd.id.type === 'ObjectPattern' || nd.id.type === 'ArrayPattern')) {
          checkPattern(nd.id, `第 ${line} 行`);
        }
      });
      if (declaresTranslator) {
        for (const h of paramHits) offenders.push(`${rel}: 声明了翻译器 const t，但${h}会遮蔽它`);
      }
      for (const h of destructHits) offenders.push(`${rel}: ${h}解构出了名为 t 的变量（会遮蔽翻译器）`);
    }
    assert.deepEqual(
      offenders,
      [],
      '🔴 这些地方把 `t` 用作形参/解构名，会**遮蔽**组件的翻译器（不报错，只会让文案悄悄不跟随语言）：\n  ' +
        offenders.join('\n  ') +
        '\n修法：把那个形参/解构名改掉（例如 `map((tag) => …)`、`const { total: rowCount } = …`）。',
    );
  });

  it('🔴 注入式翻译器模块的**每个调用点**都必须把 t 传进去（漏一个 = 那条文案永远中文，而且看不出来）', () => {
    // ## 这条守的是什么
    // 有两个**纯 JS/TS 模块**用"注入式翻译器"（不传 t 时落到 IDENTITY_T ⇒ 输出中文，逐字与改造前相同）：
    //   · `components/RecycleBin/recycleCore.js`
    //   · `pages/Static/img/tools.tsx`（`copyImgLink` / `mergeMetaInfo`）
    // 🔴 "不传 t 也能跑、只是显示中文"这个设计的代价是：**漏传 t 不会报错**，界面上只是一直是中文。
    // 所以要在这里用 AST 钉住：这些函数在 admin 源码里的**每一个调用点**，最后一个实参都必须是 `t`
    //（或 options 对象里带 `t`，那是 `describeRecycleActionFailure` 的形状）。
    const INJECTED = {
      'src/components/RecycleBin/recycleCore.js': [
        'recycleEmptyText', 'draftRecycleEmptyText', 'untitledText',
        'restoreConfirmTitle', 'restoreConfirmText', 'draftRestoreConfirmTitle', 'draftRestoreConfirmText',
        'purgeConfirmContent', 'draftPurgeConfirmContent', 'purgeOkText',
        'purgeConfirmTitle', 'draftPurgeConfirmTitle',
        'restoreSuccessText', 'purgeSuccessText', 'draftRestoreSuccessText', 'draftPurgeSuccessText',
        'describeListFailure', 'normalizeDeletedList', 'actionText', 'labelText', 'articleLabel',
      ],
      'src/pages/Static/img/tools.tsx': ['copyImgLink', 'mergeMetaInfo'],
    };
    const OPTIONS_STYLE = new Set(['describeRecycleActionFailure']);
    // 🔴 三类**合法**的"不传 t"，都要显式登记（否则这条判据会把设计好的行为当成缺陷）：
    //  ① 定义模块自己：`const RECYCLE_EMPTY_TEXT = recycleEmptyText()` 这类**刻意 identity** 的常量
    //     （既有消费方与 30 条单测就靠它保持逐字相同）；模块内部有没有漏传 t 由它自己的单测钉
    //     （recycleBin.test.js 的"两条路径不许漂" + 黄金样本）。
    //  ② **尚未接 i18n** 的消费方：走 identity ⇒ 输出与今天逐字相同（不是缺陷，是 backlog）。
    //     🔴 这张表是**钉死的**：谁新增一个不传 t 的消费方，这里就会红（要么补 t、要么登记进表并说明）。
    const NOT_YET_I18N_CONSUMERS = ['src/components/Editor/imgUpload.tsx'];
    // 🔴 每个 it 都有自己的作用域：上一版直接用了**别的 it 里**定义的 stripComments ⇒ ReferenceError。
    const noComments = (x) =>
      x
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => {
          const y = l.trim();
          return !y.startsWith('//') && !y.startsWith('*');
        })
        .join('\n');
    const missing = [];
    const unregistered = [];
    let callSites = 0;
    let checkedSites = 0;
    const all = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const a = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!SCAN_SKIP_DIRS.has(e.name)) walk(a);
        } else if (SCAN_EXTS.has(path.extname(e.name))) all.push(a);
      }
    })(path.join(adminRoot, 'src'));
    for (const abs of all) {
      const rel = path.relative(adminRoot, abs).split(path.sep).join('/');
      let ast;
      try {
        ast = astInventory.parseSource(readFileSync(abs, 'utf8'), rel);
      } catch (e) {
        continue; // 解析失败由上面那条 AST 判据负责报（不重复报）
      }
      const raw = readFileSync(abs, 'utf8');
      const isDefiningModule = rel in INJECTED;
      const wired = astInventory.collectTCalls(raw, rel).length > 0;
      if (!wired && !isDefiningModule) {
        // 尚未接 i18n 的文件：只统计它有没有调用这些函数（有就必须登记在表里）
        const names = Object.values(INJECTED).flat();
        if (names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(noComments(raw)))) {
          if (!NOT_YET_I18N_CONSUMERS.includes(rel)) unregistered.push(rel);
        }
        continue;
      }
      if (isDefiningModule) continue; // ① 定义模块自己豁免
      const wanted = new Set(Object.values(INJECTED).flat());
      astInventory.walkAst(ast.program, (nd) => {
        if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'Identifier') return;
        const name = nd.callee.name;
        if (!wanted.has(name) && !OPTIONS_STYLE.has(name)) return;
        const args = nd.arguments || [];
        callSites += 1;
        checkedSites += 1;
        if (OPTIONS_STYLE.has(name)) {
          const opt = args[1];
          const props = opt && opt.type === 'ObjectExpression'
            ? (opt.properties || []).map((pr) => pr.key && (pr.key.name || pr.key.value))
            : [];
          if (!props.includes('t')) missing.push(`${rel}: ${name}(…) 的 options 里没有 t`);
          return;
        }
        const last = args[args.length - 1];
        if (!last || last.type !== 'Identifier' || last.name !== 't') {
          missing.push(`${rel}: ${name}(…) 的最后一个实参不是 t（实际 ${last ? last.type : '无实参'}）`);
        }
      });
    }
    assert.deepEqual(
      unregistered,
      [],
      '🔴 这些文件调用了注入式翻译器函数、但自己**还没接 i18n**、也没登记在 NOT_YET_I18N_CONSUMERS 里：\n  ' +
        unregistered.join('\n  ') +
        '\n要么把 t 传进去（更好），要么登记进那张表并写明它属于哪一批。',
    );
    assert.ok(
      checkedSites >= 20,
      `只检查了 ${checkedSites} 个调用点（下界 20）⇒ 判据没在干活，这条会假绿`,
    );
    void callSites;
    assert.deepEqual(
      missing,
      [],
      '🔴 这些调用点没把翻译器传进去（那几条文案会**永远显示中文**，而且不报错、界面上看不出差别）：\n  ' +
        missing.join('\n  ') +
        '\n修法：把组件里的 t 作为最后一个实参传进去（options 形状的函数则放进 options）。',
    );
  });

  it('🔴 被渲染进 `Modal.info/confirm/...` 的组件不许用 `useIntl()`（那是**独立 React 根**，没有 IntlProvider）', () => {
    // ## 这条守的是什么（2026-09-26 期 5 第二批，活体探针抓到的真缺陷）
    // antd 4 的 `Modal.info/confirm/success/error/warning` 会 `ReactDOM.render` 到一个**新建的容器**
    // （`antd/es/modal/confirm.js` 里的 `render()` / `reactUnmount(container)`），而 umi 的 plugin-locale
    // **不给这些静态方法打补丁** ⇒ 🔴 那棵树上没有 `IntlProvider`，content 里的组件调 `useIntl()` 会**直接抛错**，
    // 表现为"点了没反应/弹窗空白"。实测：`ObjTable` 用了 `useIntl()` 之后，en-US 下右键「信息」弹窗**不出现**。
    // 🔴 单测看不见这个（组件不跑），只有浏览器活体能抓到 ⇒ 所以在这里用**静态判据**把它钉住。
    // 修法：那种组件用 `getIntl(getLocale())`（普通函数、不依赖 context），与 `app.jsx` 同一套路。
    const stripComments = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => {
          const x = l.trim();
          return !x.startsWith('//') && !x.startsWith('*');
        })
        .join('\n');
    const all = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const a = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!SCAN_SKIP_DIRS.has(e.name)) walk(a);
        } else if (SCAN_EXTS.has(path.extname(e.name))) all.push(a);
      }
    })(path.join(adminRoot, 'src'));
    assert.ok(all.length >= 100, `只扫到 ${all.length} 个源文件（下界 100）⇒ 遍历坏了，这条会假绿`);

    const offenders = [];
    let modalSites = 0;
    let parseFails = [];
    for (const abs of all) {
      const raw = readFileSync(abs, 'utf8');
      const rel = path.relative(adminRoot, abs);
      const src = stripComments(raw);
      // 🔴 用 **AST** 取 `Modal.<method>({ content: … })` 里 content 的那棵子树。
      //    第一版是"从 Modal. 往后截 1500 字符、再从 content: 往后截 900 字符"——
      //    🔴 那个窗口会**越过 Modal 调用本身**，把后面正常渲染的 `<SiteInfoForm>` 也算进来
      //    （实测误报 2 条：InitPage 与 SiteInfo 的 Modal.warn）。窗口式判据在这种嵌套结构上不可靠。
      let ast;
      try {
        // 🔴 AST 用**原始源码**解析，不要用剥掉注释的那份：本仓库的注释里有 JSX 片段
        //    （例如 `{/* … */}` 被块注释正则啃掉后剩下的形状），实测剥完再解析会在
        //    `Static/img/index.tsx` 上报 "Unexpected token"（原始文件是好的）。
        //    剥注释只用于**文本级**的 `useIntl(` 判据（那里必须剥，否则注释里提到 useIntl 就会误报）。
        ast = astInventory.parseSource(raw, rel);
      } catch (e) {
        parseFails.push(`${rel}: ${String(e.message).slice(0, 80)}`);
        continue;
      }
      // 本文件的 import 映射：组件名 → 源文件绝对路径
      const imports = {};
      for (const m of src.matchAll(/import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+'([^']+)'/g)) {
        let target = m[2];
        if (target.startsWith('@/')) target = path.join(adminRoot, 'src', target.slice(2));
        else if (target.startsWith('.')) target = path.resolve(path.dirname(abs), target);
        else continue;
        const cand = ['.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx', '/index.ts', '/index.js']
          .map((ext) => target + ext)
          .find((f) => existsSync(f));
        if (cand) imports[m[1]] = cand;
      }
      astInventory.walkAst(ast.program, (nd) => {
        if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'MemberExpression') return;
        if (!nd.callee.object || nd.callee.object.name !== 'Modal') return;
        const method = nd.callee.property && (nd.callee.property.name || nd.callee.property.value);
        if (!['info', 'confirm', 'success', 'error', 'warning', 'warn'].includes(method)) return;
        modalSites += 1;
        const arg0 = (nd.arguments || [])[0];
        if (!arg0 || arg0.type !== 'ObjectExpression') return;
        const contentProp = (arg0.properties || []).find(
          (pr) => pr.type === 'ObjectProperty' && pr.key && (pr.key.name || pr.key.value) === 'content',
        );
        if (!contentProp) return;
        const comps = new Set();
        astInventory.walkAst(contentProp.value, (n2) => {
          if (
            n2.type === 'JSXOpeningElement' &&
            n2.name &&
            n2.name.type === 'JSXIdentifier' &&
            /^[A-Z]/.test(n2.name.name)
          ) {
            comps.add(n2.name.name);
          }
        });
        for (const comp of comps) {
          const file = imports[comp];
          if (!file) continue; // 第三方组件或本文件内定义的组件（不在本判据范围）
          const csrc = stripComments(readFileSync(file, 'utf8'));
          if (/\buseIntl\s*\(/.test(csrc)) {
            offenders.push(
              `${rel} 的 Modal.${method} content 里渲染了 <${comp}>，而 ${path.relative(adminRoot, file)} 用了 useIntl()`,
            );
          }
        }
      });
    }
    assert.deepEqual(
      parseFails,
      [],
      '🔴 这些文件 AST 解析失败（判据没覆盖到它们 ⇒ 会假绿）：\n  ' + parseFails.join('\n  '),
    );
    assert.ok(modalSites >= 10, `只扫到 ${modalSites} 处 Modal.* 调用（下界 10）⇒ 判据没在干活，这条会假绿`);
    assert.deepEqual(
      offenders,
      [],
      '🔴 这些组件会在**没有 IntlProvider 的 React 根**里调 useIntl()（弹窗会抛错/空白，单测看不见）：\n  ' +
        offenders.join('\n  ') +
        '\n修法：把那个组件里的 `useIntl()` 换成 `getIntl(getLocale())`（渲染期调用，不要提到模块顶层）。',
    );
  });

  it('🔴 三份包里的**数字集合**与**必须原样保留的技术标识符**必须一致（翻译不许改契约）', () => {
    // ## 为什么要有这条（2026-09-26 期 5 第一批）
    // 水印那批文案里全是**契约数字**：短边 52px 跳过、缩到 8px 还放不下就跳过、长边小于 320 抬到 320、
    // 每个 8x8 块最多动 4 个色阶、隐写内容最多 200 字节、缩略图默认 300px 约 10KB…
    // 而 `watermarkText.test.js` 有一条**跨包钉子**把 52px 与服务端 `utils/watermark.ts` 钉在一起 ——
    // 🔴 但那条钉子只看**中文源码**，翻译时把 en-US 写成 60px 它**看不见**。
    // 生成语言包的脚本当时逐 key 比对了数字序列（一次性），🔴 这条把它变成**常驻守卫**：
    // 以后任何人改任何一条译文，数字变了就红。
    //
    // ## 判据
    // ① 每个 key 的**数字序列**（按出现顺序）三份必须完全相同；
    // ② zh-CN 里出现的**技术标识符**必须在另两份里原样出现：
    //    全大写词（VANBLOG_WATERMARK_STYLE / JSON / WARN / GIF / OSS…）、带扩展名的文件名
    //    （package.json / vanblog-access.log…）、以及一小撮必须原样保留的工具/字段名。
    // ⚠️ 刻意**不**比单位词（字节/位元組/bytes）：那是本该翻的东西。
    // 🔴 比**排序后的多重集**，不比出现顺序：翻译本来就会改语序
    //    （实测 `init.restore.err.429`：zh「每 10 分钟 5 次」↔ en "5 per 10 minutes" —— 数字没变、只是顺序变了，
    //    那是**合法**的；第一版按序列比，把它误报成契约漂移）。
    //    ⚠️ 但多重集仍然抓得住"少了一个数字""把 52 改成 60"这类真漂移。
    const digits = (v) => (String(v).match(/\d+(?:\.\d+)?/g) || []).slice().sort((a, b) => a - b).join(',');
    const TOKEN_RE =
      /\b[A-Z][A-Z0-9_]{2,}\b|\b[A-Za-z0-9_.-]+\.(?:js|ts|tsx|jsx|json|md|log|png|webp|zip)\b|\b(?:sharp|avifenc|picgo|picgoConfig|libavif-apps|Waline|waline|Caddy|caddy)\b/g;
    const bad = [];
    // 🔴 用本文件既有的 `packs`（不是我自己再造一份解析）—— 一个性质只留一处权威口径
    const ALL = Object.keys(packs['zh-CN']);
    for (const k of ALL) {
      const cn = String(packs['zh-CN'][k]);
      const dCN = digits(cn);
      const tokens = [...new Set(cn.match(TOKEN_RE) || [])];
      for (const l of ['zh-TW', 'en-US']) {
        const v = String(packs[l][k]);
        if (digits(v) !== dCN) {
          bad.push(`${l}  ${k}: 数字集合 [${digits(v)}] ≠ zh-CN [${dCN}]（已排序；顺序不同是合法的）`);
        }
        for (const tok of tokens) {
          if (!v.includes(tok)) bad.push(`${l}  ${k}: 缺少必须原样保留的技术标识符 ${tok}`);
        }
      }
    }
    assert.ok(ALL.length >= 400, `只比了 ${ALL.length} 个 key（下界 400）⇒ 解析器坏了，这条会假绿`);
    assert.deepEqual(
      bad,
      [],
      '🔴 译文改了**契约**（数字或技术标识符）—— 这类漂移没有任何别处会红：\n  ' +
        bad.slice(0, 20).join('\n  ') +
        (bad.length > 20 ? `\n  …共 ${bad.length} 条` : '') +
        '\n修法：把数字/标识符改回与 zh-CN 一致。' +
        '\n⚠️ 如果确实是**有意**改的（例如服务端门槛变了），那要三份一起改，并且先改服务端与那条跨包钉子。',
    );
  });

  it('每个 id 都在三份语言包里存在', () => {
    const missing = [];
    for (const { id, rel } of calls) {
      for (const l of LOCALES) {
        if (!(id in packs[l])) missing.push(`${rel} → ${id} 缺 ${l}`);
      }
    }
    assert.deepEqual(missing, [], `有 id 在语言包里不存在：\n  ${missing.join('\n  ')}`);
  });

  it('每个 defaultMessage 都与 zh-CN 包里同 id 的值逐字相同（防两处口径漂移）', () => {
    const drift = [];
    for (const { id, defaultMessage, rel } of calls) {
      const want = packs['zh-CN'][id];
      if (want !== undefined && want !== defaultMessage) {
        drift.push(`${rel} → ${id}\n     源码: ${defaultMessage}\n     zh-CN: ${want}`);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `defaultMessage 与 zh-CN 语言包不一致（同一性质两处口径必然漂移，请改成一致）：\n  ${drift.join('\n  ')}`,
    );
  });

  it('🔴 与服务端约定的字符串绝不可进语言包：`已初始化` 是协议不是文案', () => {
    // InitPage 用 String(info?.message).includes('已初始化') 匹配 **服务端 HttpException 的文本**。
    // 翻译它会让「站点已初始化 ⇒ 跳登录页」这条分支永久失效。
    const src = read(`${INIT_DIR}/index.tsx`);
    assert.match(src, /includes\('已初始化'\)/, 'wire-contract 匹配被改动了，请确认这是有意的');
    for (const l of LOCALES) {
      const leaked = Object.entries(packs[l]).filter(([, v]) => v.includes('已初始化'));
      assert.deepEqual(leaked.map(([k]) => k), [], `${l} 里出现了 wire-contract 字符串`);
    }
  });
});

describe('多语言第一期：纯 JS 核心模块的注入式翻译器', () => {
  const setupKeyCore = require('../../src/pages/InitPage/setupKeyCore');
  const restoreCore = require('../../src/pages/InitPage/restoreCore');

  it('SETUP_KEY_HINT_IDS 与 SETUP_KEY_HINTS 一一对应，且每个 id 都在三份包里', () => {
    const ids = setupKeyCore.SETUP_KEY_HINT_IDS;
    assert.equal(ids.length, setupKeyCore.SETUP_KEY_HINTS.length, '两个数组长度必须一致');
    assert.ok(ids.length >= 4, `只有 ${ids.length} 条提示，疑似常量被改小了`);
    for (const id of ids) {
      for (const l of LOCALES) assert.ok(id in packs[l], `${id} 缺 ${l}`);
    }
  });

  it('zh-CN 包里每条 hint 的值 == 模块里的中文常量（模块常量是权威，包不得漂）', () => {
    setupKeyCore.SETUP_KEY_HINT_IDS.forEach((id, i) => {
      assert.equal(
        packs['zh-CN'][id],
        setupKeyCore.SETUP_KEY_HINTS[i],
        `${id} 的 zh-CN 值与 setupKeyCore.SETUP_KEY_HINTS[${i}] 不一致`,
      );
    });
  });

  it('不传翻译器时 getSetupKeyHints() 原样返回中文（单测与旧行为逐字一致）', () => {
    assert.deepEqual(setupKeyCore.getSetupKeyHints(), setupKeyCore.SETUP_KEY_HINTS);
  });

  it('传入翻译器时 getSetupKeyHints(t) 走 id（证明注入真的生效，不是恒返回中文）', () => {
    const seen = [];
    const out = setupKeyCore.getSetupKeyHints((id, dm) => {
      seen.push(id);
      return `#${id}`;
    });
    assert.deepEqual(seen, setupKeyCore.SETUP_KEY_HINT_IDS, '翻译器必须按顺序收到每个 id');
    assert.deepEqual(out, setupKeyCore.SETUP_KEY_HINT_IDS.map((id) => `#${id}`));
  });

  it('restoreCore：注入翻译器后 describeRestoreFailure 返回 id 而不是中文', () => {
    const out = restoreCore.describeRestoreFailure(429, '', (id) => `#${id}`);
    assert.deepEqual(out, ['#init.restore.err.429']);
    // 🔴 而不传翻译器时仍是中文（既有单测依赖这一点）
    assert.deepEqual(restoreCore.describeRestoreFailure(429, ''), [
      '初始化相关请求太频繁（限流：每 10 分钟 5 次），请稍后再试。',
    ]);
  });

  it('restoreCore：占位符插值在不传翻译器时与旧实现逐字相同', () => {
    assert.equal(
      restoreCore.parseRestoreResponse(500, '').message,
      '恢复请求失败（HTTP 500）',
      'identity 翻译器必须把 {status} 插值成与旧模板字符串相同的结果',
    );
    assert.equal(
      restoreCore.parseRestoreResponse(400, JSON.stringify({ statusCode: 409 })).message,
      '恢复被拒绝（statusCode=409）',
    );
    // 注入翻译器时走 id + values
    const got = restoreCore.parseRestoreResponse(500, '', (id, dm, values) => `${id}|${JSON.stringify(values)}`);
    assert.equal(got.message, 'init.restore.err.httpFailed|{"status":500}');
  });

  it('restoreCore：formatRestoreCounts 与 describeFileSize 都接受翻译器', () => {
    assert.equal(
      restoreCore.formatRestoreCounts({ articles: 3 }, (id) => `#${id}`),
      '#init.restore.count.articles 3',
    );
    assert.equal(restoreCore.formatRestoreCounts({ articles: 3 }), '文章 3');
    assert.equal(restoreCore.describeFileSize(0, (id) => `#${id}`), '#init.restore.count.unknownSize');
    assert.equal(restoreCore.describeFileSize(0), '未知大小');
  });
});

/**
 * 🔴 语言切换器必须**真的被渲染**，而不只是"被编译进产物"。
 *
 * **它防的是 v2026.9.6 那个已发版的缺陷**：`@umijs/plugin-locale` 启用后，`SelectLang`
 * 组件确实被编译进了 bundle（产物里按 `\uXXXX` 转义形式能搜到 `简体中文`/`繁體中文`），
 * 但**没有任何用户能到达的页面渲染它** ⇒ 站长在后台"什么都没看到"。两个成因：
 *   1. 🔴 `src/app.jsx` 导出的运行时 `layout` 配置里提供了 `rightContentRender`，
 *      它会**整体覆盖** plugin-layout 生成的右侧内容 —— 而那个"自动出现"的切换器
 *      正是 plugin-layout 的 `genRenderRightContent({ locale: hasPlugins([...]) })`
 *      放进去的 ⇒ **"启用插件头部就会自动出现切换器"这个推断在本仓库不成立**。
 *   2. `/user`（登录、忘记密码）与 `/init` 都是 `layout: false` ⇒ 拿不到头部；
 *      而 `/init` 在**已初始化**的站点上不可达 ⇒ 上一轮写在安装页里的那个只有全新安装才看得到。
 *
 * ⚠️ **判据的口径**（这一节的存在理由）：
 * 🔴 **"某个生成文件存在"（`.umi/plugin-locale/SelectLang.tsx`）、"localeInfo 注册了三份"、
 * "ConfigProvider 已接管"这三条都是真的，但没有一条能证明切换器会被渲染。**
 * 唯一可靠的尺子是：①**源码里那个真正生效的渲染点确实引用了它**（本节），
 * ②**构建产物里搜得到切换器要显示的文字**（见 `docs`/手册记录的转义形式口径）。
 *
 * ⚠️ 一律**先剥注释再断言**：本仓库的注释里会写 `<SelectLang />` 来解释成因，
 * 若不剥注释，那些注释会喂饱断言 ⇒ 守卫变成恒真（本仓库已为此付过 5 次学费）。
 */
describe('多语言第一期：语言切换器必须真的被渲染（不是只被编译进产物）', () => {
  /**
   * 四个"必须有切换器"的位置。
   * 🔴 `why` 说明每一处为什么必须有 —— 断言失败时要能看出是哪一处、为什么。
   */
  const REQUIRED = [
    {
      file: 'src/app.jsx',
      why: '后台头部：运行时 layout 的 rightContentRender 会覆盖 plugin-layout 生成的右侧内容',
      // 🔴 必须落在这个函数体内，不能只是"文件里某处出现过"
      scope: /rightContentRender:\s*\(\)\s*=>\s*\{[\s\S]*?\n    \},/,
    },
    {
      file: 'src/app.jsx',
      why:
        '🔴 侧边栏 links 区：handleSizeChange() 在视口 >768px 时把 header 设成 display:none，' +
        '所以 rightContentRender 里的切换器在桌面端不可见；links 区是桌面端唯一常驻可见的操作区' +
        '（主题按钮与登出本来就在这里各重复了一份）',
      // 🔴 必须落在 links 数组里，不能只是"文件里某处出现过"
      scope: /links:\s*\[[\s\S]*?\n    \],/,
    },
    {
      file: 'src/pages/user/Login/index.jsx',
      why: '登录页是 layout:false 且是站长看到的第一屏 ⇒ 登录之前就要能切换语言',
      scope: null,
    },
    {
      file: 'src/pages/user/Restore/index.jsx',
      why: '忘记密码页同为 layout:false，同样在登录之前',
      scope: null,
    },
    {
      file: 'src/pages/InitPage/index.tsx',
      why: '安装页是 layout:false（⚠️ 已初始化的站点上 /init 不可达，只有全新安装看得到）',
      scope: null,
    },
  ];

  it('反空转：清单必须是这 4 处、且每个文件都真实存在', () => {
    assert.equal(REQUIRED.length, 5, '清单条数变了 ⇒ 这条期望值必须一起改（这个摩擦是刻意留的）');
    for (const r of REQUIRED) {
      assert.ok(existsSync(path.join(adminRoot, r.file)), `文件不存在：${r.file}`);
    }
  });

  for (const r of REQUIRED) {
    it(`${r.file} 必须 import 并渲染 <SelectLang />（${r.why}）`, () => {
      const raw = read(r.file);
      // 🔴 剥注释后再断言：注释里提到 <SelectLang /> 不算数
      const src = stripComments(raw);
      const target = r.scope ? (src.match(r.scope) || [''])[0] : src;
      if (r.scope) {
        assert.ok(
          target.length > 0,
          `🔴 在 ${r.file} 里找不到该处应有的作用域（rightContentRender / links 数组）⇒ 尺子失效（不是"没有切换器"）。` +
            `请先核实这个正则是否还对得上当前源码形状；解析不到 ≠ 不存在。`,
        );
      }
      assert.match(
        target,
        // ⚠️ 允许带属性：放在 links 数组里的那一份必须带 key（React 对数组子元素的要求），
        //    所以形状是 `<SelectLang key="langSider" />`。仍然要求"行首 + 自闭合"，
        //    因此注释里提到的 <SelectLang /> 不会算数（注释已被 stripComments 剥掉）。
        /^\s*<SelectLang(\s[^>]*)?\/>/m,
        `🔴 ${r.file} 没有渲染 <SelectLang />。${r.why}。` +
          `⚠️ 注意"组件被编译进产物"不等于"它被渲染"—— v2026.9.6 就是这样发出去的。`,
      );
      assert.match(
        src,
        /^import\s*\{[^}]*\bSelectLang\b[^}]*\}\s*from\s*'umi';/m,
        `🔴 ${r.file} 没有从 'umi' 导入 SelectLang（渲染点存在但导入缺失 ⇒ 运行时是 undefined）。`,
      );
    });
  }

  it('🔴 语言自称不许在本仓库硬编码第二遍（必须来自 umi SelectLang 内置的 defaultLangUConfigMap）', () => {
    // ⚠️ 一个性质只留一处权威口径：语言自称（简体中文/繁體中文/English）由 umi 的
    //    defaultLangUConfigMap 提供；本仓库再抄一份就一定会漂。
    const LABELS = ['简体中文', '繁體中文'];
    for (const r of REQUIRED) {
      const src = stripComments(read(r.file));
      for (const label of LABELS) {
        assert.ok(
          !src.includes(label),
          `🔴 ${r.file} 里硬编码了语言自称「${label}」⇒ 应当复用 SelectLang 内置的标签，` +
            `否则就出现了第二处会漂移的口径。`,
        );
      }
    }
  });

  it('尺子反证：只出现在注释里的 <SelectLang /> 必须**不**算数', () => {
    // 🔴 这条证明上面的 stripComments 是承重的：把渲染点删掉、只在注释里留一份，
    //    守卫必须红。若哪天有人"顺手"把 stripComments 去掉，这条会先红。
    const onlyInComment = [
      "import { SelectLang } from 'umi';",
      'export default function () {',
      '  return (',
      '    <div>',
      '      {/* <SelectLang /> 这里只是注释，不是渲染 */}',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const stripped = stripComments(onlyInComment);
    assert.ok(
      !/^\s*<SelectLang\s*\/>/m.test(stripped),
      '🔴 尺子坏了：只写在注释里的 <SelectLang /> 被判成"已渲染" ⇒ stripComments 没生效',
    );
    // 反向：真实渲染的形状必须被认出来（否则上面那条"不红"只是因为正则太严）
    const real = onlyInComment.replace(
      "      {/* <SelectLang /> 这里只是注释，不是渲染 */}",
      '      <SelectLang />',
    );
    assert.match(
      stripComments(real),
      /^\s*<SelectLang\s*\/>/m,
      '🔴 尺子坏了：真实的 <SelectLang /> 渲染点没被认出来 ⇒ 正则需要修，而不是放宽断言',
    );
  });
});

describe('多语言第二期第一块：侧边栏菜单的 locale 接线（routes.js ↔ 三份语言包）', () => {
  /**
   * 🔴 这一组钉的是**方案 (B) 的接线**：`config/routes.js` 保留中文 `name`、另加显式
   * `locale: 'menu.xxx'`，由 ProLayout 的 `formatMessage({ id: locale, defaultMessage: name })`
   * 渲染（权威实现：`@umijs/route-utils` 的 `transformRoute`，`getItemLocaleName` 里
   * `return item.locale || `${parentName}.${name}`` ⇒ 显式 locale 优先）。
   *
   * 🔴 为什么不是把 `name` 改成 key（方案 A）：`defaultMessage` 永远是 `name`，所以
   *   - (B) 漏翻译 ⇒ 用户看到**中文**（与改动前一致）；
   *   - (A) 漏翻译 ⇒ 用户看到**裸 key**（菜单上出现 `article`），而且所有直接读 `name` 的
   *     消费方（面包屑、`document.title`、`attachmentManage.test.js` 的两条断言）全部跟着变。
   * 👉 下面那条「name 必须仍是中文显示文本」钉的**不是文案，而是这个安全前提本身**。
   */
  const routesSrc = stripComments(read('config/routes.js'));

  function parseRouteLocales(src) {
    const out = [];
    const re = /locale:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }
  function parseRouteNames(src) {
    const out = [];
    const re = /name:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
  }

  const routeLocales = parseRouteLocales(routesSrc);
  const routeNames = parseRouteNames(routesSrc);
  const menuKeys = Object.keys(packs['zh-CN'])
    .filter((k) => k.startsWith('menu.'))
    .sort();
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  it('反空转：routes.js 恰好 15 处 locale，全部 menu. 前缀且互不重复', () => {
    assert.equal(
      routeLocales.length,
      15,
      `抽到 ${routeLocales.length} 处 locale（期望 15）⇒ 要么解析器坏了，要么菜单增删了而这条期望值没跟着改`,
    );
    for (const l of routeLocales) {
      assert.ok(l.startsWith('menu.'), `locale 必须是 menu. 前缀：${l}`);
    }
    assert.equal(new Set(routeLocales).size, routeLocales.length, 'routes.js 里有重复的 locale');
  });

  it('反空转：确实抽到了 name（不是解析器坏了）', () => {
    assert.ok(routeNames.length >= 17, `只抽到 ${routeNames.length} 个 name，疑似解析器坏了`);
  });

  it('每个路由 locale 都在三份语言包里存在', () => {
    const missing = [];
    for (const l of routeLocales) {
      for (const loc of LOCALES) {
        if (!(l in packs[loc])) missing.push(`${l} 缺 ${loc}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `路由引用了语言包里没有的 key（菜单会静默回落到中文 name，切语言时那一格不变）：\n  ${missing.join('\n  ')}`,
    );
  });

  it('🔴 反向：语言包里的每个 menu.* 都被某个路由用到（不留死条目）', () => {
    const dead = menuKeys.filter((k) => !routeLocales.includes(k));
    assert.deepEqual(
      dead,
      [],
      `语言包里有 ${dead.length} 条 menu.* 没有任何路由引用 ⇒ 死条目，改菜单时必然漂：${dead.join(', ')}`,
    );
  });

  it('🔴 方案 (B) 的安全前提：routes.js 的 name 必须仍是中文显示文本，不是 key', () => {
    const bad = routeNames.filter((n) => !CJK.test(n));
    assert.deepEqual(
      bad,
      [],
      `routes.js 里这些 name 不是中文显示文本：${bad.join(', ')}\n` +
        '🔴 把 name 改成 key 等于把方案从 (B) 退化成 (A)：漏翻译时菜单会显示裸 key，' +
        '而且所有直接读 name 的消费方（面包屑 / document.title / attachmentManage.test.js）都会跟着变。',
    );
    assert.ok(
      routeNames.every((n) => !n.startsWith('menu.')),
      'name 不许是 menu. 开头的 key（同上）',
    );
  });

  it('locale 不许侵占既有命名空间（init. / common. / login.）', () => {
    const clash = routeLocales.filter((l) => /^(init|common|login)\./.test(l));
    assert.deepEqual(clash, [], `locale 用了既有命名空间：${clash.join(', ')}`);
  });

  it('menu.* 的 en-US 值必须与 zh-CN 不同（防拿中文充英文）', () => {
    const same = menuKeys.filter((k) => packs['en-US'][k] === packs['zh-CN'][k]);
    assert.deepEqual(same, [], `这些 menu.* 的 en-US 与 zh-CN 逐字相同：${same.join(', ')}`);
  });

  it('尺子反证：合成"一份包少一个 menu key" ⇒ 必须被上面那条点名', () => {
    const fake = {};
    for (const loc of LOCALES) fake[loc] = { ...packs[loc] };
    delete fake['en-US']['menu.welcome'];
    const missing = [];
    for (const l of routeLocales) {
      for (const loc of LOCALES) if (!(l in fake[loc])) missing.push(`${l} 缺 ${loc}`);
    }
    assert.deepEqual(missing, ['menu.welcome 缺 en-US'], '尺子失效：少一个 key 竟然没被点名');
  });

  it('尺子反证：合成"一个死条目" ⇒ 必须被反向那条点名', () => {
    const fakeLocales = routeLocales.filter((l) => l !== 'menu.about');
    const dead = menuKeys.filter((k) => !fakeLocales.includes(k));
    assert.deepEqual(dead, ['menu.about'], '尺子失效：死条目竟然没被点名');
  });

  it('尺子反证：合成"一个被改成 key 的 name" ⇒ 必须被安全前提那条点名', () => {
    const bad = [...routeNames, 'article'].filter((n) => !CJK.test(n));
    assert.deepEqual(bad, ['article'], '尺子失效：name 被改成 key 竟然没被点名');
  });
});

describe('尺子有效性反证（合成输入，不碰真实语言包）', () => {
  // 🔴 把判定逻辑抽成纯函数，才能用合成输入证明它真的会抓到问题 ——
  //    否则「三份包恰好相等」永远可能只是因为比较器坏了。
  const diffKeys = (a, b) => Object.keys(a).filter((k) => !(k in b)).concat(Object.keys(b).filter((k) => !(k in a)));
  const identicalExcept = (a, b, allow) =>
    Object.keys(a).filter((k) => a[k] === b[k] && !allow.includes(k));

  it('合成：一份包少一个 key ⇒ 必须被点名', () => {
    const good = { 'a.b': 'x', 'a.c': 'y' };
    const missing = { 'a.b': 'x' };
    assert.deepEqual(diffKeys(good, missing), ['a.c']);
    assert.deepEqual(diffKeys(good, { ...good }), [], '两份一致时不应报差异');
  });

  it('合成：zh-TW 出现一条与 zh-CN 相同且不在白名单里的值 ⇒ 必须被点名', () => {
    const cn = { 'a.b': '设置', 'a.c': '取消' };
    const tw = { 'a.b': '設定', 'a.c': '取消' }; // a.c 合法相同
    assert.deepEqual(identicalExcept(cn, tw, ['a.c']), [], '白名单内的相同不算问题');
    assert.deepEqual(identicalExcept(cn, tw, []), ['a.c'], '白名单外漏掉就必须报出来');
  });

  it('合成：简体专用字检测真的会命中，且不会误伤合法繁体', () => {
    assert.ok([...'設定'].some((c) => SIMPLIFIED_ONLY.includes(c)) === false, '合法繁体不该被报');
    assert.ok([...'设置'].some((c) => SIMPLIFIED_ONLY.includes(c)) === true, '简体必须被报');
  });
});
