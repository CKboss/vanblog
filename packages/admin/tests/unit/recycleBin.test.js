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
    assert.match(comp, /okText="恢复"/);
    assert.match(comp, /onConfirm=\{\(\) => handleRestore\(record\)\}/);
    // 只查 Popconfirm 块（Alert 的 description 是 antd4 合法属性，别误伤）
    const pop = comp.slice(comp.indexOf('<Popconfirm'), comp.indexOf('</Popconfirm>'));
    assert.ok(pop.includes('<Popconfirm'), '找不到 Popconfirm 块');
    assert.ok(!pop.includes('description='), 'antd 4.24 的 Popconfirm 没有 description 属性');
  });

  it('永久删除走 Modal.confirm：danger 按钮 + core 里的不可撤销文案', () => {
    assert.match(comp, /Modal\.confirm/);
    assert.match(comp, /okButtonProps: \{ danger: true \}/);
    assert.match(comp, /okText: PURGE_OK_TEXT/);
    assert.match(comp, /isDraft \? DRAFT_PURGE_CONFIRM_CONTENT : PURGE_CONFIRM_CONTENT/);
    assert.match(comp, /isDraft \? draftPurgeConfirmTitle\(record\) : purgeConfirmTitle\(record\)/);
  });

  it('恢复/永久删除成功后都刷新抽屉列表并通知父组件（主列表同步）', () => {
    const refreshes = comp.match(/fetchList\(page, pageSize\)/g) || [];
    assert.ok(refreshes.length >= 4, 'restore/purge 的成功路径、404 失败路径与刷新按钮都要重拉列表');
    const notifies = comp.match(/onChanged\?\.\(\)/g) || [];
    assert.equal(notifies.length, 2, '恢复与永久删除成功后都要 onChanged');
    assert.match(comp, /message\.success\(restoreSuccessText\(record\)\)/);
    assert.match(comp, /message\.success\(purgeSuccessText\(record\)\)/);
    assert.match(comp, /message\.success\(draftRestoreSuccessText\(record\)\)/);
    assert.match(comp, /message\.success\(draftPurgeSuccessText\(record\)\)/);
  });

  it('失败路径不静默也不裸报：按状态码定制的文案 + 404 时刷新列表', () => {
    assert.match(comp, /describeRecycleActionFailure\(err, \{/);
    assert.match(comp, /if \(isNotFoundFailure\(err\)\)/);
    assert.match(comp, /setErrorText\(describeListFailure\(err\)\)/);
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
    assert.match(comp, /RECYCLE_EMPTY_TEXT/);
    assert.match(comp, /DRAFT_RECYCLE_EMPTY_TEXT/);
    for (const col of ['标题', '别名', '分类', '标签', '更新时间', '删除时间', '字数', '作者']) {
      assert.ok(comp.includes(`title: '${col}'`), `缺少列：${col}`);
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
