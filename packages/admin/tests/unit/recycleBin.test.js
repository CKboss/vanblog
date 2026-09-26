const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

// 断言前剔除注释：注释里经常引用旧写法/契约原文，不剔除会自己匹配自己
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const core = require('../../src/components/RecycleBin/recycleCore');
const { formatBytes, formatDateTime } = require('../../src/services/van-blog/formatTime');

describe('formatTime：共享的时间/体积格式化（坏值绝不渲染 NaN / Invalid Date）', () => {
  it('合法时间 → YYYY-MM-DD HH:mm:ss（本地时区，与 Date 组件一致）', () => {
    const iso = '2026-03-04T05:06:07.000Z';
    const d = new Date(iso);
    const pad = (n) => (n < 10 ? `0${n}` : String(n));
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    assert.equal(formatDateTime(iso), expected);
    assert.equal(formatDateTime(d), expected);
  });

  it('坏值一律 "-"', () => {
    for (const bad of [null, undefined, '', 'nope', NaN, new Date('invalid')]) {
      assert.equal(formatDateTime(bad), '-');
    }
  });

  it('formatBytes：B/KB/MB/GB + 坏值给「未知大小」', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.00 GB');
    for (const bad of [null, undefined, NaN, 0, -5, 'x']) {
      assert.equal(formatBytes(bad), '未知大小');
    }
  });
});

describe('回收站：契约端点', () => {
  it('列表 / 恢复 / 永久删除的 URL 与契约一致（文章 + 草稿）', () => {
    assert.equal(core.RECYCLE_LIST_ENDPOINT, '/api/admin/article/deleted');
    assert.equal(core.DRAFT_RECYCLE_LIST_ENDPOINT, '/api/admin/draft/deleted');
    assert.equal(core.restoreArticleEndpoint(12), '/api/admin/article/12/restore');
    assert.equal(core.purgeArticleEndpoint(12), '/api/admin/article/12/purge');
    assert.equal(core.restoreDraftEndpoint(12), '/api/admin/draft/12/restore');
    assert.equal(core.purgeDraftEndpoint(12), '/api/admin/draft/12/purge');
  });

  it('id 进 URL 前必须编码（防路径注入）', () => {
    assert.equal(core.restoreArticleEndpoint('a/b'), '/api/admin/article/a%2Fb/restore');
    assert.equal(core.purgeArticleEndpoint('a?b=1'), '/api/admin/article/a%3Fb%3D1/purge');
    assert.equal(core.restoreDraftEndpoint('a b'), '/api/admin/draft/a%20b/restore');
  });

  it('权限名与 server 角色权限一致', () => {
    assert.deepEqual(core.RECYCLE_PERMISSIONS.article, {
      restore: 'article:update',
      purge: 'article:delete',
    });
    assert.deepEqual(core.RECYCLE_PERMISSIONS.draft, {
      restore: 'draft:update',
      purge: 'draft:delete',
    });
  });

  it('api.js 六个服务函数打契约端点，全部 skipErrorHandler（文案由组件定制，不炸全局 toast）', () => {
    const api = read('src/services/van-blog/api.js');
    for (const fn of [
      'getDeletedArticles',
      'restoreArticle',
      'purgeArticle',
      'getDeletedDrafts',
      'restoreDraft',
      'purgeDraft',
    ]) {
      const at = api.indexOf(`export async function ${fn}`);
      assert.ok(at >= 0, `api.js 缺少 ${fn}`);
      const body = api.slice(at, at + 500);
      assert.match(body, /skipErrorHandler: true/, `${fn} 应带 skipErrorHandler`);
    }
    assert.match(api, /\/api\/admin\/article\/deleted\?page=/);
    assert.match(api, /\/api\/admin\/draft\/deleted\?page=/);
    assert.match(api, /\/restore`/);
    assert.match(api, /\/purge`/);
  });
});

describe('normalizeDeletedList：形状漂移不白屏', () => {
  it('标准信封 → 归一化行 + total', () => {
    const { articles, total } = core.normalizeDeletedList({
      statusCode: 200,
      data: {
        articles: [
          {
            id: 42,
            title: '旧文',
            pathname: 'jiu-wen',
            category: '技术',
            tags: ['node', 2],
            author: 'someone',
            updatedAt: '2026-09-01T00:00:00.000Z',
            deletedAt: '2026-09-02T00:00:00.000Z',
            wordCount: 1200,
          },
        ],
        total: 41,
      },
    });
    assert.equal(total, 41);
    assert.equal(articles.length, 1);
    const row = articles[0];
    assert.equal(row.id, 42);
    assert.equal(row.key, '42');
    assert.equal(row.title, '旧文');
    assert.equal(row.pathname, 'jiu-wen');
    assert.equal(row.author, 'someone');
    assert.deepEqual(row.tags, ['node', '2']);
    assert.equal(row.wordCount, 1200);
    assert.equal(row.deletedAt, '2026-09-02T00:00:00.000Z');
  });

  it('数字 id 优先于 _id（契约确认 restore/purge 路径参数是数字 id；_id 只是历史兜底）', () => {
    const { articles } = core.normalizeDeletedList({
      data: { articles: [{ id: 7, _id: 'mongo-oid' }], total: 1 },
    });
    assert.equal(articles[0].id, 7);
    const legacy = core.normalizeDeletedList({ data: { articles: [{ _id: 'oid' }] } });
    assert.equal(legacy.articles[0].id, 'oid');
  });

  it('草稿列表的 drafts 键也认；没有信封、直接 {articles,total} 也认', () => {
    const fromDrafts = core.normalizeDeletedList({
      data: { drafts: [{ id: 3, title: '草稿A', author: 'me' }], total: 1 },
    });
    assert.equal(fromDrafts.articles[0].id, 3);
    assert.equal(fromDrafts.articles[0].author, 'me');
    const bare = core.normalizeDeletedList({ articles: [{ _id: 1 }], total: 3 });
    assert.equal(bare.articles.length, 1);
    assert.equal(bare.total, 3);
  });

  it('缺失/畸形一律降级：空对象、articles 不是数组、total 非法、行不是对象', () => {
    assert.deepEqual(core.normalizeDeletedList(null), { articles: [], total: 0 });
    assert.deepEqual(core.normalizeDeletedList({}), { articles: [], total: 0 });
    assert.deepEqual(core.normalizeDeletedList({ data: { articles: 'oops' } }), {
      articles: [],
      total: 0,
    });
    const r = core.normalizeDeletedList({ data: { articles: [{ _id: 1 }, { _id: 2 }], total: NaN } });
    assert.equal(r.total, 2, 'total 非法时退回本页条数');
    const junk = core.normalizeDeletedList({ data: { articles: [null, 42, {}], total: 3 } });
    assert.equal(junk.articles.length, 3);
    assert.equal(junk.articles[0].key, 'deleted-row-0', '没有 id 的行用下标兜底 key');
    assert.equal(junk.articles[2].title, '(无标题)');
    assert.equal(junk.articles[2].wordCount, null);
    assert.equal(junk.articles[2].author, '');
    assert.deepEqual(junk.articles[2].tags, []);
  });

  it('tags 不是数组 / wordCount 非法 → 空数组 / null（界面渲染 "-"）', () => {
    const { articles } = core.normalizeDeletedList({
      data: { articles: [{ _id: 1, tags: 'node', wordCount: '很多' }], total: 1 },
    });
    assert.deepEqual(articles[0].tags, []);
    assert.equal(articles[0].wordCount, null);
    assert.equal(core.formatWordCount(articles[0].wordCount), '-');
    assert.equal(core.formatWordCount(0), '0');
  });

  it('时间格式化走 formatDateTime：坏日期渲染 "-"', () => {
    assert.equal(core.formatDeletedAt('2026-09-02T00:00:00.000Z'), formatDateTime('2026-09-02T00:00:00.000Z'));
    assert.equal(core.formatDeletedAt('garbage'), '-');
    assert.equal(core.formatDeletedAt(null), '-');
  });
});

describe('回收站文案：确认弹窗必须说清后果', () => {
  it('空状态解释这个列表是什么（软删除 + 可恢复 + 永久删除不可撤销）', () => {
    assert.match(core.RECYCLE_EMPTY_TEXT, /软删除/);
    assert.match(core.RECYCLE_EMPTY_TEXT, /恢复/);
    assert.match(core.RECYCLE_EMPTY_TEXT, /永久删除/);
    assert.match(core.RECYCLE_EMPTY_TEXT, /不可撤销/);
  });

  it('永久删除确认：标题带文章名，内容明说不可撤销，按钮是危险文案', () => {
    assert.equal(core.purgeConfirmTitle({ title: '旧文' }), '永久删除「旧文」？');
    assert.equal(core.purgeConfirmTitle(null), '永久删除「(无标题)」？');
    assert.match(core.PURGE_CONFIRM_CONTENT, /不可撤销/);
    assert.match(core.PURGE_CONFIRM_CONTENT, /无法再从回收站恢复/);
    assert.equal(core.PURGE_OK_TEXT, '永久删除');
  });

  it('成功提示点名文章，并带一句副作用说明（流水线 / ISR / 总字数会刷新）', () => {
    assert.match(core.restoreSuccessText({ title: '旧文' }), /已恢复「旧文」/);
    assert.match(core.restoreSuccessText({ title: '旧文' }), /流水线会运行/);
    assert.match(core.restoreSuccessText({ title: '旧文' }), /前台缓存与总字数会刷新/);
    assert.match(core.purgeSuccessText({ title: '旧文' }), /已永久删除「旧文」/);
    assert.match(core.purgeSuccessText({ title: '旧文' }), /不可撤销/);
    assert.match(core.purgeSuccessText({ title: '旧文' }), /总字数与前台缓存会随之刷新/);
  });

  it('列表加载失败：404 说人话（server 未实现），其余带上服务端原因', () => {
    const notFound = core.describeListFailure({ response: { status: 404 } });
    assert.match(notFound, /还没有回收站接口/);
    const withMessage = core.describeListFailure({ data: { statusCode: 500, message: '数据库炸了' } });
    assert.match(withMessage, /回收站列表加载失败/);
    assert.match(withMessage, /数据库炸了/);
    const bare = core.describeListFailure(null);
    assert.match(bare, /回收站列表加载失败/);
  });

  it('动作失败：404=已不在回收站（要刷新）、403=点名缺的权限、401=登录失效、其余带服务端原因', () => {
    const opts = { action: '永久删除', label: '文章', permission: 'article:delete' };
    assert.match(core.describeRecycleActionFailure({ response: { status: 404 } }, opts), /已不在回收站中/);
    assert.match(core.describeRecycleActionFailure({ response: { status: 404 } }, opts), /刷新为最新状态/);
    const forbidden = core.describeRecycleActionFailure({ response: { status: 403 } }, opts);
    assert.match(forbidden, /没有永久删除这条文章的权限/);
    assert.match(forbidden, /article:delete/);
    assert.match(core.describeRecycleActionFailure({ data: { statusCode: 401 } }, opts), /登录已失效/);
    const generic = core.describeRecycleActionFailure({ data: { statusCode: 500, message: 'boom' } }, opts);
    assert.match(generic, /永久删除失败/);
    assert.match(generic, /boom/);
    assert.equal(core.isNotFoundFailure({ response: { status: 404 } }), true);
    assert.equal(core.isNotFoundFailure({ response: { status: 500 } }), false);
    assert.equal(core.isNotFoundFailure(null), false);
  });
});

describe('RecycleBin 组件接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/components/RecycleBin/index.jsx'));

  it('恢复是「一次点击 + Popconfirm 确认」，且不用 antd5 才有的 description 属性', () => {
    assert.match(comp, /<Popconfirm/);
    // 🔴 期 9 第四批起按钮文案走 t()：锚点换成新形状，性质不变（确认按钮必须是「恢复」那一句，
    //    且带 zh-CN 的 defaultMessage）
    assert.match(comp, /okText=\{t\('recycle\.restore', '恢复'\)\}/);
    assert.match(comp, /onConfirm=\{\(\) => handleRestore\(record\)\}/);
    // 只查 Popconfirm 块（Alert 的 description 是 antd4 合法属性，别误伤）
    const pop = comp.slice(comp.indexOf('<Popconfirm'), comp.indexOf('</Popconfirm>'));
    assert.ok(pop.includes('<Popconfirm'), '找不到 Popconfirm 块');
    assert.ok(!pop.includes('description='), 'antd 4.24 的 Popconfirm 没有 description 属性');
  });

  it('永久删除走 Modal.confirm：danger 按钮 + core 里的不可撤销文案', () => {
    assert.match(comp, /Modal\.confirm/);
    assert.match(comp, /okButtonProps: \{ danger: true \}/);
    assert.match(comp, /okText: purgeOkText\(t\)/);
    assert.match(comp, /isDraft \? draftPurgeConfirmContent\(t\) : purgeConfirmContent\(t\)/);
    assert.match(comp, /isDraft \? draftPurgeConfirmTitle\(record, t\) : purgeConfirmTitle\(record, t\)/);
  });

  it('恢复/永久删除成功后都刷新抽屉列表并通知父组件（主列表同步）', () => {
    const refreshes = comp.match(/fetchList\(page, pageSize\)/g) || [];
    assert.ok(refreshes.length >= 4, 'restore/purge 的成功路径、404 失败路径与刷新按钮都要重拉列表');
    const notifies = comp.match(/onChanged\?\.\(\)/g) || [];
    assert.equal(notifies.length, 2, '恢复与永久删除成功后都要 onChanged');
    assert.match(comp, /message\.success\(restoreSuccessText\(record, t\)\)/);
    assert.match(comp, /message\.success\(purgeSuccessText\(record, t\)\)/);
    assert.match(comp, /message\.success\(draftRestoreSuccessText\(record, t\)\)/);
    assert.match(comp, /message\.success\(draftPurgeSuccessText\(record, t\)\)/);
  });

  it('失败路径不静默也不裸报：按状态码定制的文案 + 404 时刷新列表', () => {
    assert.match(comp, /describeRecycleActionFailure\(err, \{/);
    assert.match(comp, /if \(isNotFoundFailure\(err\)\)/);
    assert.match(comp, /setErrorText\(describeListFailure\(err, t\)\)/);
    assert.match(comp, /<Alert\s+type="error"/);
    assert.ok(!comp.includes('reportRequestError'), '文案统一走 core 的 describe*，不再用通用兜底');
  });

  it('权限门控：无 article:delete / draft:delete 就不渲染永久删除（模式与 Static/img 一致）', () => {
    assert.match(comp, /useModel\('@@initialState'\)/);
    assert.match(comp, /function hasPermission\(initialState, permission\)/);
    assert.match(comp, /user\.id == 0/);
    assert.match(comp, /ps\.includes\(permission\) \|\| ps\.includes\('all'\)/);
    assert.match(comp, /\{canPurge \? \(/);
    assert.match(comp, /\{canRestore \? \(/);
    assert.match(comp, /当前账号无操作权限/);
  });

  it('服务端分页：Table 的 pagination 用 state 里的 current/pageSize/total', () => {
    assert.match(comp, /current: page,/);
    assert.match(comp, /total,/);
    assert.match(comp, /showSizeChanger: true/);
    assert.match(comp, /isDraft \? await getDeletedDrafts\(p, ps\) : await getDeletedArticles\(p, ps\)/);
  });

  it('空状态用 core 的解释文案；文章列覆盖契约要求的字段，草稿列换成作者', () => {
    assert.match(comp, /recycleEmptyText\(t\)/);
    assert.match(comp, /draftRecycleEmptyText\(t\)/);
    // 🔴 列标题现在都走 t()：锚点是「key + zh-CN defaultMessage」这一对，
    //    既钉住"列在"，也钉住"它的中文默认文案没被顺手改掉"（那是语言包对账的另一半）
    const COLS = {
      标题: 'common.colTitle', // 🔴 已从 recycle.colTitle 提升（图片管理页也要用）
      别名: 'recycle.colPathname',
      分类: 'recycle.colCategory',
      标签: 'recycle.colTags',
      更新时间: 'recycle.colUpdatedAt',
      删除时间: 'recycle.colDeletedAt',
      字数: 'recycle.colWordCount',
      作者: 'recycle.colAuthor',
      // 🔴 「操作」已提升为 common.colOption（Token 页也要用它）⇒ 锚点跟着换，性质不变
      操作: 'common.colOption',
    };
    for (const [label, key] of Object.entries(COLS)) {
      assert.ok(
        comp.includes(`title: t('${key}', '${label}')`),
        `缺少列「${label}」（或它没接 i18n / key 改名了）：期望 title: t('${key}', '${label}')`,
      );
    }
  });

  it('缺少 id 的记录不许发起恢复/永久删除（防打 undefined 进 URL）', () => {
    assert.match(comp, /record\?\.id == null/);
    assert.match(comp, /这条记录缺少 ID，无法恢复/);
    assert.match(comp, /这条记录缺少 ID，无法永久删除/);
  });

  it('草稿模式常驻「发布归档」警示（列表非空时空状态文案看不见）', () => {
    assert.match(comp, /data-recycle-draft-warning/);
    assert.match(comp, /发布成功的草稿也会自动进入回收站/);
    assert.match(comp, /不会改动已发布的文章/);
  });
});

describe('回收站入口与删除文案（Article 页 / columns / Editor）', () => {
  it('文章管理工具栏有「回收站」按钮，抽屉恢复后刷新主列表', () => {
    const page = codeOnly(read('src/pages/Article/index.jsx'));
    assert.match(page, /import RecycleBin from '@\/components\/RecycleBin'/);
    assert.match(page, /key="recycleBinBtn"/);
    assert.match(page, /回收站/);
    assert.match(page, /<RecycleBin/);
    assert.match(page, /type="article"/);
    assert.match(page, /onChanged=\{\(\) => actionRef\?\.current\?\.reload\(\)\}/);
  });

  it('列表页删除确认说清「进回收站、可恢复」，成功提示同步改口', () => {
    const cols = codeOnly(read('src/pages/Article/columns.jsx'));
    assert.match(cols, /删除后文章会移入本页工具栏的「回收站」/);
    assert.match(cols, /只有在回收站里「永久删除」才不可撤销/);
    assert.match(cols, /删除成功，已移入回收站（可恢复）/);
  });

  it('编辑器删除文章的确认也说明去向', () => {
    const editor = codeOnly(read('src/pages/Editor/index.jsx'));
    assert.match(editor, /删除后文章会移入「文章管理 → 回收站」/);
    assert.match(editor, /删除文章成功，已移入回收站（可恢复）/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 期 9 第四批：多语言接线（注入式翻译器）
//
// 这一组断言守的是"**接线**"而不是"文案好不好"：
//  ① 组件里每个 core 文案函数都必须拿到翻译器（漏一个 ⇒ 那条文案永远中文，而且**看不出来**）；
//  ② 组件不许再用那些**模块加载期就固定**的中文常量（用了就等于切语言不跟随）；
//  ③ 🔴 不传翻译器时输出与改造前**逐字相同**（黄金样本）—— 这是"注入式翻译器"模式的验收线；
//  ④ 🔴 传翻译器（用 zh-CN 包的值插值）时结果与 ③ **逐字相同** ⇒ 两条路径不许漂
//     （这条同时证明了"包里的 ICU 模板"与"源码里的 defaultMessage"是同一句话）；
//  ⑤ 🔴 期 9 接线：服务端带 `code` 时 detail 用 `error.<code>` 的译文，没有码就回落中文原文。
// ─────────────────────────────────────────────────────────────────────────────
const astInventory = require('../../../../scripts/i18n/astInventory.js');

describe('RecycleBin 多语言接线（期 9 第四批）', () => {
  const compSrc = read('src/components/RecycleBin/index.jsx');
  const packs = {};
  for (const l of ['zh-CN', 'zh-TW', 'en-US']) {
    packs[l] = astInventory.readPack(path.join(adminRoot, `src/locales/${l}.ts`), `${l}.ts`);
  }
  // 用某一份语言包的值当译文的假翻译器（`{k}` 插值与 react-intl 的 ICU 简单占位符同形）
  const makeFakeT = (locale) => (id, defaultMessage, values) => {
    const tpl = id in packs[locale] ? packs[locale][id] : defaultMessage;
    if (!values) return tpl;
    return String(tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, k) =>
      Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : whole,
    );
  };
  const zhT = makeFakeT('zh-CN');
  const enT = makeFakeT('en-US');

  it('反空转：core 的文案函数确实抽得到 t() 调用点，且三份包都被解析到', () => {
    const calls = astInventory.collectTCalls(read('src/components/RecycleBin/recycleCore.js'), 'recycleCore.js');
    assert.ok(calls.length >= 25, `recycleCore.js 只抽到 ${calls.length} 个 t() 调用点（下界 25）⇒ 判据或文件坏了`);
    assert.deepEqual(
      calls.filter((c) => typeof c.defaultMessage !== 'string').map((c) => c.id),
      [],
      '有调用点没有字面量 defaultMessage（语言包漏 key 时用户会看到裸 key）',
    );
    for (const l of ['zh-CN', 'zh-TW', 'en-US']) {
      assert.ok(Object.keys(packs[l]).length >= 250, `${l} 只解析出 ${Object.keys(packs[l]).length} 个 key`);
    }
  });

  it('🔴 组件里每一个 core 文案函数调用都把翻译器传进去了（漏一个 = 那条文案永远中文）', () => {
    const TEXT_FNS = new Set([
      'recycleEmptyText', 'draftRecycleEmptyText', 'untitledText',
      'restoreConfirmTitle', 'restoreConfirmText', 'draftRestoreConfirmTitle', 'draftRestoreConfirmText',
      'purgeConfirmContent', 'draftPurgeConfirmContent', 'purgeOkText',
      'purgeConfirmTitle', 'draftPurgeConfirmTitle',
      'restoreSuccessText', 'purgeSuccessText', 'draftRestoreSuccessText', 'draftPurgeSuccessText',
      'describeListFailure', 'normalizeDeletedList',
    ]);
    const ast = astInventory.parseSource(compSrc, 'RecycleBin/index.jsx');
    const missing = [];
    astInventory.walkAst(ast.program, (nd) => {
      if (nd.type !== 'CallExpression' || !nd.callee || nd.callee.type !== 'Identifier') return;
      const name = nd.callee.name;
      const args = nd.arguments || [];
      if (name === 'describeRecycleActionFailure') {
        const opt = args[1];
        const props =
          opt && opt.type === 'ObjectExpression'
            ? (opt.properties || []).map((p) => p.key && (p.key.name || p.key.value))
            : [];
        if (!props.includes('t')) missing.push(`${name}(…) 的 options 里没有 t（译文不会生效）`);
        // 🔴 不许再传中文的 action/label：它们会被插进句子里，英文界面就会出现夹生句
        if (props.includes('action') || props.includes('label')) {
          missing.push(`${name}(…) 仍在传 action/label（应传 actionKey/labelKey，中文参数会插进外文句子）`);
        }
        if (!props.includes('actionKey') || !props.includes('labelKey')) {
          missing.push(`${name}(…) 缺 actionKey/labelKey`);
        }
        return;
      }
      if (!TEXT_FNS.has(name)) return;
      const last = args[args.length - 1];
      if (!last || last.type !== 'Identifier' || last.name !== 't') {
        missing.push(`${name}(…) 的最后一个实参不是 t（实际 ${last ? last.type : '无实参'}）`);
      }
    });
    assert.deepEqual(
      missing,
      [],
      '🔴 这些调用点没有把翻译器传进去（那几条文案会永远显示中文，而且从界面上看不出差别）：\n  ' +
        missing.join('\n  '),
    );
  });

  it('组件不再引用那些中文常量（常量仍导出给既有消费方，但组件必须走函数）', () => {
    const comp = codeOnly(compSrc);
    for (const c of [
      'RECYCLE_EMPTY_TEXT', 'DRAFT_RECYCLE_EMPTY_TEXT', 'PURGE_OK_TEXT',
      'PURGE_CONFIRM_CONTENT', 'DRAFT_PURGE_CONFIRM_CONTENT',
      'RESTORE_CONFIRM_TITLE', 'RESTORE_CONFIRM_TEXT',
      'DRAFT_RESTORE_CONFIRM_TITLE', 'DRAFT_RESTORE_CONFIRM_TEXT',
    ]) {
      assert.ok(
        !comp.includes(c),
        `组件仍在用常量 ${c} —— 那是**模块加载期**就固定的中文，切语言不跟随（要改用同名函数并传 t）`,
      );
    }
    // 🔴 翻译器必须在渲染期取（useIntl 是 hook）
    assert.match(comp, /const intl = useIntl\(\)/);
    // 🔴 也不许有与翻译器同名的局部变量遮蔽它（本批就抓到过两个：`total: t` 与 `tags.map((t) =>`）
    assert.ok(!comp.includes('total: t'), 'fetchList 里又把 total 解构成 t 了（会遮蔽翻译器）');
    assert.ok(!comp.includes('map((t)'), 'tags 的 map 参数又叫 t 了（会遮蔽翻译器）');
  });

  it('🔴 不传翻译器时，输出与改造前逐字相同（黄金样本）', () => {
    assert.equal(core.purgeConfirmTitle({ title: '旧文' }), '永久删除「旧文」？');
    assert.equal(core.purgeConfirmTitle(null), '永久删除「(无标题)」？');
    assert.equal(core.draftPurgeConfirmTitle({ title: '旧草稿' }), '永久删除草稿「旧草稿」？');
    assert.equal(
      core.restoreSuccessText({ title: '旧文' }),
      '已恢复「旧文」，它已回到文章列表。恢复按「文章更新」处理：绑定文章更新的流水线会运行，前台缓存与总字数会刷新。',
    );
    assert.equal(
      core.describeRecycleActionFailure({ response: { status: 404 } }, { action: '恢复', label: '文章' }),
      '这条文章已不在回收站中（可能刚被恢复或已被永久删除），列表将刷新为最新状态。',
    );
    assert.equal(
      core.describeRecycleActionFailure(
        { response: { status: 403 } },
        { action: '永久删除', label: '草稿', permission: 'draft:delete' },
      ),
      '当前账号没有永久删除这条草稿的权限（需要 draft:delete），请联系管理员。',
    );
    assert.equal(
      core.describeRecycleActionFailure({ data: { statusCode: 500, message: 'boom' } }, { action: '恢复', label: '文章' }),
      '恢复失败（boom），请稍后重试。',
    );
    assert.equal(
      core.describeListFailure({ data: { statusCode: 500, message: '数据库炸了' } }),
      '回收站列表加载失败（数据库炸了），请稍后重试；这不影响文章管理里的其它功能。',
    );
    assert.equal(core.normalizeDeletedArticle({}, 0).title, '(无标题)');
    assert.equal(core.RECYCLE_EMPTY_TEXT, core.recycleEmptyText());
  });

  it('🔴 传翻译器（用 zh-CN 包插值）时结果与不传时逐字相同 —— 两条路径不许漂', () => {
    const rec = { title: '旧文' };
    const pairs = [
      ['purgeConfirmTitle', core.purgeConfirmTitle(rec), core.purgeConfirmTitle(rec, zhT)],
      ['draftPurgeConfirmTitle', core.draftPurgeConfirmTitle(rec), core.draftPurgeConfirmTitle(rec, zhT)],
      ['restoreSuccessText', core.restoreSuccessText(rec), core.restoreSuccessText(rec, zhT)],
      ['purgeSuccessText', core.purgeSuccessText(rec), core.purgeSuccessText(rec, zhT)],
      ['draftRestoreSuccessText', core.draftRestoreSuccessText(rec), core.draftRestoreSuccessText(rec, zhT)],
      ['draftPurgeSuccessText', core.draftPurgeSuccessText(rec), core.draftPurgeSuccessText(rec, zhT)],
      ['recycleEmptyText', core.recycleEmptyText(), core.recycleEmptyText(zhT)],
      ['draftRecycleEmptyText', core.draftRecycleEmptyText(), core.draftRecycleEmptyText(zhT)],
      ['restoreConfirmText', core.restoreConfirmText(), core.restoreConfirmText(zhT)],
      ['draftRestoreConfirmText', core.draftRestoreConfirmText(), core.draftRestoreConfirmText(zhT)],
      ['purgeConfirmContent', core.purgeConfirmContent(), core.purgeConfirmContent(zhT)],
      ['draftPurgeConfirmContent', core.draftPurgeConfirmContent(), core.draftPurgeConfirmContent(zhT)],
      [
        'actionFailure403',
        core.describeRecycleActionFailure({ response: { status: 403 } }, { action: '永久删除', label: '草稿', permission: 'draft:delete' }),
        core.describeRecycleActionFailure(
          { response: { status: 403 } },
          { actionKey: 'purge', labelKey: 'draft', permission: 'draft:delete', t: zhT },
        ),
      ],
      [
        'listFailureGeneric',
        core.describeListFailure({ data: { statusCode: 500, message: '数据库炸了' } }),
        core.describeListFailure({ data: { statusCode: 500, message: '数据库炸了' } }, zhT),
      ],
    ];
    const drift = pairs.filter(([, a, b]) => a !== b).map(([n, a, b]) => `${n}\n     不传 t: ${a}\n     传 zhT : ${b}`);
    assert.deepEqual(
      drift,
      [],
      '🔴 zh-CN 包里的模板与源码里 JS 拼出来的中文**不是同一句话**（两条路径漂了）：\n  ' + drift.join('\n  '),
    );
  });

  it('🔴 期 9 接线：服务端带 code 时用 error.<code> 的译文，没有码就回落中文原文', () => {
    const coded = { data: { statusCode: 400, message: '非法的归档名', code: 'exportArchiveNameInvalid' } };
    const out = core.describeRecycleActionFailure(coded, { actionKey: 'restore', labelKey: 'article', t: enT });
    assert.ok(out.includes('Invalid archive name'), `没有用上 error.<code> 的英文译文：${out}`);
    assert.ok(!out.includes('非法的归档名'), `仍然夹着服务端那句中文：${out}`);
    // 🔴 无码回落（渐进迁移：任何时刻都可用）
    const uncoded = { data: { statusCode: 400, message: '还没迁移的中文原因' } };
    const out2 = core.describeRecycleActionFailure(uncoded, { actionKey: 'restore', labelKey: 'article', t: enT });
    assert.ok(out2.includes('还没迁移的中文原因'), `无码时没有回落服务端原文：${out2}`);
    // 列表加载失败那条也要走同一套
    const out3 = core.describeListFailure(coded, enT);
    assert.ok(out3.includes('Invalid archive name'), `describeListFailure 没有用上译文：${out3}`);
  });

  it('🔴 英文译文里没有汉字、没有 ICU 会当转义符的单引号，且与中文不同形', () => {
    const keys = Object.keys(packs['zh-CN']).filter((k) => k.startsWith('recycle.'));
    assert.ok(keys.length >= 45, `recycle.* 只有 ${keys.length} 个 key（下界 45）`);
    const bad = [];
    for (const k of keys) {
      const en = packs['en-US'][k];
      if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(en)) bad.push(`${k}: 英文里有汉字`);
      if (en.includes("'")) bad.push(`${k}: 英文里有单引号（ICU 会把它当转义符 ⇒ 整句解析出错）`);
      if (en === packs['zh-CN'][k]) bad.push(`${k}: 英文与中文相同（疑似没翻）`);
    }
    assert.deepEqual(bad, [], bad.join('\n  '));
  });
});
