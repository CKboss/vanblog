/**
 * 🔴 i18n key 命名规范守卫（多语言路线图「期 0」的第①件）。
 *
 * ## 为什么需要它
 * 现状：114 个 key 里 **`init.*` 占 82 个（72%）**。接下来要翻译的是 1,820 条 UI 文案
 * （114 个文件），如果不在**大量 key 进来之前**定下命名规范，命名空间会失控 ——
 * 而 key 一旦散布到几十个组件里，**再改名的代价是"牵动所有引用点"**。
 *
 * ## 规范（唯一权威实现在 `scripts/i18n/astInventory.js`，本文件不复述判据）
 *   `<组>.<区域>.<项>`，**最多三段**；段字符集 `A-Za-z0-9_-`；不以点开头/结尾、无空段；
 *   🔴 **第一段必须属于已登记的组** ⇒ 新增组必须显式登记（这就是"防止命名空间失控"的机制）。
 *   已登记的组：`common` / `error` / `init` / `login` / `logout` / `menu` / `theme`
 *   （🔴 `error.*` 是**预留给服务端错误码那一期**的，与前端 key 复用同一套命名，避免两套口径）。
 *
 * ## 🔴 祖父条款（为什么不直接把不合规的 key 改名）
 * 存量里有 **20 个四段 key**（`init.restore.{count,err,detail}.*`），是前几期按语义分组写的。
 * 🔴 **不为了让守卫绿而改它们的 key 名** —— 改名会牵动所有 `t('…')` 引用点与
 * "defaultMessage 与 zh-CN 逐字相同"那条对账，风险远大于收益。
 * ⇒ **白名单豁免段数规则、只对增量生效**，但**仍受"组必须已登记"约束**。
 * ⚠️ 白名单必须**恰好等于**实际不合规的那一批（多一条少一条都红）—— 这是本仓库反复吃过亏的地方。
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
const KEYS = Object.keys(PACKS['zh-CN']);

/** 🔴 当前实测基线（改这些数字必须是有意的，并在注释里写明理由）。 */
// 🔴 114 → 186（2026-09-25 期 3 第二批）→ 194（期 9 第一批：8 个 `error.<code>`）→ 204（期 9 第二批：+10 个）→ 216（期 9 第三批：+12 个）→ 267（期 9 第四批：回收站 +51 个）→ 307（期 3 第三批：Token/高级设置 +41，并把 recycle.colOption 提升为 common.colOption）
//   → 325（期 3 第四批：用户设置 +19，并把 sysconf.token.deleteConfirmTitle 提升为 common.deleteConfirmTitle）
//   → 356（期 3 第五批：HTTPS/Caddy +32，并把 sysconf.token.relatedDocs 提升为 common.relatedDocs）
//   → 462（期 4：SiteInfoForm +106 —— 目前最大的单文件批次）
//   → 493（期 5 第一批：WaterMarkForm +31，新组 `watermark`）
//   → 506（期 5 第一批同轮追加：StaticForm +13，新组 `storage`）
//   → 574（期 5 第二批：图片管理页 +69，新组 `img`，并把 recycle.colTitle 提升为 common.colTitle）
//   → **577**（期 5 第二批同轮追加：ObjTable 2 条 + common.editPost 1 条）
//   这条是**进度下界**（key 变少 = 有人删了译文、或包被截断），所以每翻完一批就该跟着抬 ——
//   期 3 第一批（145 key）时没抬，本轮补上。
//   🔴 这里也是"key 数下界"的**唯一权威口径**：`i18nSharedImpl` 只证明 readPack 没坏（三份相等且非平凡），
//   `localePackParity` 只做"三份都空 ⇒ 集合相等"的反空转（>= 50），都不写具体进度数字。
const BASELINE_KEY_COUNT = 577;
const BASELINE_GRANDFATHERED = 20;
const REGISTERED = astInventory.REGISTERED_KEY_GROUPS;

test('i18n key 命名 · 反空转：三份包都真的被解析到，且 key 数不低于基线', () => {
  for (const l of LOCALES) {
    const n = Object.keys(PACKS[l]).length;
    // 🔴 解析到 0 个 key 会让下面所有断言恒真 ⇒ 这里必须 fail-loud
    assert.ok(n > 0, `${l}.ts 解析出 0 个 key（尺子坏了，不是语言包真的空）`);
    assert.ok(
      n >= BASELINE_KEY_COUNT,
      `${l}.ts 只有 ${n} 个 key，低于基线 ${BASELINE_KEY_COUNT}（key 被删了？翻译进度在倒退）`,
    );
  }
  // 🔴 三份包的 key 集合必须相等（这条在 localePackParity 里也钉，这里只钉"本守卫扫到的是同一批"）
  assert.strictEqual(KEYS.length, Object.keys(PACKS['en-US']).length, 'zh-CN 与 en-US 的 key 数不等');
});

test('i18n key 命名 · 每个 key 的形状都合法（段数 / 字符集 / 无空段 / 不以点开头结尾）', () => {
  const bad = [];
  for (const k of KEYS) {
    const r = astInventory.validateKeyShape(k);
    if (!r.ok) bad.push(`${k}  ⇒ ${r.reasons.join('；')}`);
  }
  assert.deepStrictEqual(
    bad,
    [],
    '🔴 有 key 不符合命名规范：\n  ' +
      bad.join('\n  ') +
      `\n规范：<组>.<区域>.<项>，最多 ${astInventory.KEY_MAX_SEGMENTS} 段；` +
      `第一段必须属于已登记的组（${REGISTERED.join(', ')}）。\n` +
      '修法：①新 key 请按规范命名；②如果是**新增一个组**，请把它加进 astInventory.js 的 ' +
      'REGISTERED_KEY_GROUPS（🔴 那是一次有意的命名空间扩张，要在 AGENTS.md 里说明）；' +
      '③🔴 **不要**为了让这条绿而给存量 key 加进祖父白名单 —— 白名单只覆盖那 20 条历史四段 key。',
  );
});

test('i18n key 命名 · 第一段必须属于已登记的组（防命名空间失控）', () => {
  const usedGroups = [...new Set(KEYS.map((k) => k.split('.')[0]))].sort();
  const unregistered = usedGroups.filter((g) => !REGISTERED.includes(g));
  assert.deepStrictEqual(
    unregistered,
    [],
    `🔴 出现了未登记的组：${unregistered.join(', ')}。\n` +
      `已登记：${REGISTERED.join(', ')}。\n` +
      '新增组必须显式登记（改 astInventory.js 的 REGISTERED_KEY_GROUPS）并在 AGENTS.md 说明理由 —— ' +
      '这正是"防止命名空间失控"的机制：让扩张变成一次有记录的、需要过守卫的决定。',
  );
  // 🔴 反向：登记的组里如果有从来没被用过的，说明登记提前了（不是错，但要知道）
  const unused = REGISTERED.filter((g) => !usedGroups.includes(g));
  assert.ok(
    unused.length <= 1,
    `已登记但未被使用的组有 ${unused.length} 个（${unused.join(', ')}）—— ` +
      '预留可以，但预留太多说明规范跑在了需求前面。当前只允许 `error.*` 一个预留（服务端错误码那一期）。',
  );
});

test('i18n key 命名 · 祖父条款白名单必须恰好等于实际的四段 key（多一条少一条都红）', () => {
  const actualFourSeg = KEYS.filter((k) => k.split('.').length > astInventory.KEY_MAX_SEGMENTS).sort();
  const whitelist = [...astInventory.GRANDFATHERED_KEYS].sort();
  assert.deepStrictEqual(
    actualFourSeg,
    whitelist,
    '🔴 祖父条款白名单与实际不合规的 key 不一致：\n' +
      `  实际四段 key（${actualFourSeg.length}）: ${actualFourSeg.join(', ')}\n` +
      `  白名单（${whitelist.length}）    : ${whitelist.join(', ')}\n` +
      '两种可能：①有人新写了四段 key ⇒ 请改成 ≤3 段（🔴 不要往白名单里加）；' +
      '②有人把存量 key 改名了 ⇒ 请同步白名单并说明理由。',
  );
  assert.strictEqual(
    whitelist.length,
    BASELINE_GRANDFATHERED,
    `祖父白名单条数变了（${whitelist.length} ≠ ${BASELINE_GRANDFATHERED}）⇒ 只允许减少（把存量 key 改成合规形状），` +
      '不允许增加（那等于放弃规范）。',
  );
  // 🔴 白名单里的每一条都必须真实存在于包中（防止留下死条目）
  for (const k of whitelist) {
    assert.ok(k in PACKS['zh-CN'], `祖父白名单里的 ${k} 在 zh-CN 包里不存在（死条目，请删掉）`);
  }
});

test('i18n key 命名 · menu.* 只允许被 routes.js 的 locale 字段使用（方案 B 专用）', () => {
  // 🔴 这条钉住的是"方案 B 的边界"：menu.* 是 ProLayout 通过 routes.js 的 `locale` 字段消费的，
  //    不是给组件里 t() 用的。如果将来有组件开始 t('menu.xxx')，说明两套机制混用了。
  const menuKeys = KEYS.filter((k) => k.startsWith('menu.'));
  assert.ok(menuKeys.length >= 15, `menu.* 至少应有 15 条（侧边栏菜单），实际 ${menuKeys.length}`);
  const fs = require('fs');
  const routesSrc = fs.readFileSync(path.join(ADMIN, 'config/routes.js'), 'utf8');
  for (const k of menuKeys) {
    assert.ok(
      routesSrc.includes(`'${k}'`) || routesSrc.includes(`"${k}"`),
      `menu key ${k} 没有出现在 config/routes.js 里 ⇒ 它不是被 ProLayout 消费的，` +
        '请核实它是不是应该属于别的组（menu.* 是方案 B 专用命名空间）。',
    );
  }
});

test('i18n key 命名 · 🔴 routes.js 的每条路由都不会让 ProLayout 查一个不存在的 menu.* key', () => {
  // ## 这条钉住的是一个**实测出来过的真缺陷**（2026-09-25）
  // 浏览器实测：登录页控制台有 **48 条** `[React Intl] Missing message`：
  //   `menu.登录`（36 次）与 `menu.忘记密码`（12 次）。
  // 成因：`@umijs/route-utils@2.2.2` 的 `transformRoute` 会为**整棵路由树**（含 `layout: false`
  // 的路由）计算 `locale = item.locale || 'menu.' + name` 并调用 `formatMessage`；
  // 那两条路由当时既没有 `locale` 也没有对应语言包条目 ⇒ 每次都报 Missing message。
  // 🔴 修法是权威实现里的逃生口：`if ('locale' in item && locale === false || !name) return false;`
  //    ⇒ 给它们显式写 `locale: false`，`formatMessage` 根本不会被调用。
  // 🔴 **判据复刻自权威实现**（`transformRoute.js` 的 `getItemLocaleName`），不是猜的。
  const fs = require('fs');
  const routesSrc = fs.readFileSync(path.join(ADMIN, 'config/routes.js'), 'utf8');
  const ast = astInventory.parseSource(routesSrc, 'config/routes.js');
  const items = [];
  astInventory.walkAst(ast.program, (nd) => {
    if (nd.type !== 'ObjectExpression') return;
    let name = null;
    let locale;
    let hasLocale = false;
    for (const p of nd.properties || []) {
      if (p.type !== 'ObjectProperty' || !p.key) continue;
      const k = p.key.value || p.key.name;
      if (k === 'name' && p.value && p.value.type === 'StringLiteral') name = p.value.value;
      if (k === 'locale') {
        hasLocale = true;
        if (p.value && p.value.type === 'BooleanLiteral') locale = p.value.value;
        else if (p.value && p.value.type === 'StringLiteral') locale = p.value.value;
      }
    }
    if (name !== null) items.push({ name, locale, hasLocale });
  });
  // 🔴 反空转：解析不到路由就必须红（"0 条 ⇒ 全部通过"是恒真的）
  assert.ok(items.length >= 17, `routes.js 里带 name 的路由应当 ≥17 条，实际 ${items.length}（尺子坏了？）`);

  const bad = [];
  let explicit = 0;
  let disabled = 0;
  for (const it of items) {
    // 复刻 getItemLocaleName
    let loc;
    if ((it.hasLocale && it.locale === false) || !it.name) loc = false;
    else loc = it.locale || `menu.${it.name}`;
    if (loc === false) {
      disabled += 1;
      continue;
    }
    if (it.hasLocale && typeof it.locale === 'string') explicit += 1;
    if (!(loc in PACKS['zh-CN'])) {
      bad.push(`name="${it.name}" ⇒ 会查 ${JSON.stringify(loc)}，但语言包里没有（控制台会报 Missing message）`);
    }
  }
  assert.deepStrictEqual(
    bad,
    [],
    '🔴 这些路由会让 ProLayout 去查一个不存在的 menu.* key（浏览器控制台会刷 Missing message）：\n  ' +
      bad.join('\n  ') +
      '\n修法二选一：① 它**是**菜单项 ⇒ 在语言包三份里都加上这个 menu.* 条目；' +
      '\n② 它**不是**菜单项（例如 layout:false 的登录页）⇒ 给这条路由显式写 `locale: false`' +
      '（那是 @umijs/route-utils 的 getItemLocaleName 提供的逃生口，会让 formatMessage 根本不被调用）。',
  );
  // 🔴 钉住当前的形状：15 条显式 locale + 2 条 locale:false（登录页与忘记密码页）
  assert.strictEqual(explicit, 15, `显式 locale 的路由数变了（${explicit} ≠ 15）⇒ 必须是有意的，并要同步语言包`);
  assert.strictEqual(disabled, 2, `locale:false 的路由数变了（${disabled} ≠ 2）⇒ 那两条是登录页与忘记密码页`);
});

test('i18n key 命名 · 尺子反证：合成输入必须被点名（证明判据真的在判）', () => {
  const v = astInventory.validateKeyShape;
  // ① 四段且不在白名单 ⇒ 必须不合规
  const r1 = v('init.some.new.key');
  assert.strictEqual(r1.ok, false, '尺子失效：四段且不在白名单的 key 被判为合规');
  assert.ok(
    r1.reasons.some((x) => x.includes('段数')),
    `四段 key 的失败理由必须点名"段数"，实际：${r1.reasons.join('；')}`,
  );
  // ② 未登记的组 ⇒ 必须不合规，且理由点名"组"
  // 🔴 这个合成组名**当初就踩过坑**：原来写的是 `siteInfo.basic.title`，
  //    而 2026-09-26 期 4 真的把 `siteInfo` 登记成了组（SiteInfoForm 那批）⇒ 合成用例变成合法，
  //    反证反过来报"尺子失效" —— 🔴 红的消息指向了错误的方向（听起来像判据坏了，其实是夹具过期了）。
  //    ⇒ **规矩：合成夹具要用"一看就是假"的名字，并且先断言它当前确实不合法**；
  //      这样将来它被真的登记了，红的是"换个名字重做这条反证"，而不是"尺子失效"。
  const SYNTH_GROUP = 'zzNotARealGroup';
  assert.ok(
    !astInventory.REGISTERED_KEY_GROUPS.includes(SYNTH_GROUP),
    `${SYNTH_GROUP} 居然已经是登记组了 ⇒ 换一个一看就是假的名字重做这条反证`,
  );
  const r2 = v(`${SYNTH_GROUP}.basic.title`);
  assert.strictEqual(r2.ok, false, '尺子失效：未登记组的 key 被判为合规');
  assert.ok(
    r2.reasons.some((x) => x.includes('不是已登记的组')),
    `未登记组的失败理由必须点名"组"，实际：${r2.reasons.join('；')}`,
  );
  // ③ 非法字符 / 空段 / 首尾点 ⇒ 都必须不合规
  for (const bad of ['init.a b', 'init..x', '.init', 'init.', 'init.中文']) {
    assert.strictEqual(v(bad).ok, false, `尺子失效：${JSON.stringify(bad)} 被判为合规`);
  }
  // ④ 合规的形状必须放行（否则守卫会变成"什么都红"）
  for (const good of ['common.about', 'init.setupKey.cardTitle', 'error.article.notFound']) {
    assert.strictEqual(v(good).ok, true, `尺子过严：${good} 被判为不合规（${v(good).reasons.join('；')}）`);
  }
  // ⑤ 🔴 祖父白名单里的四段 key 必须被放行（证明豁免真的生效，不是摆设）
  assert.strictEqual(
    v('init.restore.detail.db').ok,
    true,
    '祖父条款失效：白名单里的 init.restore.detail.db 被判为不合规',
  );
});
