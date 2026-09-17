const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

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

const core = require('../../src/components/RevisionHistory/revisionCore');

describe('版本历史：契约端点', () => {
  it('列表 / 详情 / 恢复的 URL 与契约一致，且 id 都过 encodeURIComponent', () => {
    assert.equal(core.revisionsListEndpoint(9), '/api/admin/article/9/revisions');
    assert.equal(core.revisionDetailEndpoint(9, 'r1'), '/api/admin/article/9/revisions/r1');
    // ⚠️ 这条钉子的意义：详情路径**必须包含文章 id**。曾经按早期契约写成顶层
    // /api/admin/revisions/:rid，而那条路由 server 上根本不存在（活体 Cannot GET 404），
    // 于是「历史版本 → 查看」会在生产上静默 404 —— 单测全绿，只有活体探测能抓到。
    assert.match(core.revisionDetailEndpoint(9, 'r1'), /^\/api\/admin\/article\/9\/revisions\//);
    assert.doesNotMatch(core.revisionDetailEndpoint(9, 'r1'), /^\/api\/admin\/revisions\//);
    assert.equal(
      core.revisionRestoreEndpoint(9, 'r1'),
      '/api/admin/article/9/revisions/r1/restore',
    );
    assert.equal(core.revisionDetailEndpoint(9, 'a/b'), '/api/admin/article/9/revisions/a%2Fb');
    assert.equal(core.revisionRestoreEndpoint(9, 'a?b'), '/api/admin/article/9/revisions/a%3Fb/restore');
  });

  it('api.js：两个 GET 带 skipErrorHandler；恢复是 **PUT**（server 已确认，不是 POST）', () => {
    const api = read('src/services/van-blog/api.js');
    assert.match(api, /export async function getArticleRevisions/);
    assert.match(api, /export async function getRevisionById/);
    assert.match(api, /export async function restoreArticleRevision/);
    const listFn = api.slice(api.indexOf('export async function getArticleRevisions'));
    assert.match(listFn.slice(0, 400), /\/revisions`/);
    assert.match(listFn.slice(0, 400), /skipErrorHandler: true/);
    const detailFn = api.slice(api.indexOf('export async function getRevisionById'));
    assert.match(detailFn.slice(0, 500), /\/api\/admin\/article\/\$\{encodeURIComponent\(articleId\)\}\/revisions\//);
    assert.doesNotMatch(detailFn, /`\/api\/admin\/revisions\//);
    assert.match(detailFn.slice(0, 300), /skipErrorHandler: true/);
    const restoreFn = api.slice(
      api.indexOf('export async function restoreArticleRevision'),
      api.indexOf('export async function restoreArticleRevision') + 300,
    );
    assert.match(restoreFn, /method: 'PUT'/);
    assert.ok(!/method: 'POST'/.test(restoreFn), '恢复版本必须是 PUT（POST 已下线，会 404）');
    assert.match(restoreFn, /skipErrorHandler: true/);
  });
});

describe('classifyRevisionsPayload：成功返回的分类（enabled 优先）', () => {
  it('enabled:false → off（服务端明确关闭，最权威的信号），带 VANBLOG_ARTICLE_REVISIONS_KEEP 说明', () => {
    const out = core.classifyRevisionsPayload({
      statusCode: 200,
      data: { revisions: [], total: 0, enabled: false },
    });
    assert.equal(out.kind, 'off');
    assert.equal(out.text, core.FEATURE_OFF_TEXT);
    assert.match(core.FEATURE_OFF_TEXT, /未开启/);
    assert.match(core.FEATURE_OFF_TEXT, /VANBLOG_ARTICLE_REVISIONS_KEEP/);
    // enabled:false 时就算带了 revisions 也按关闭处理（不自相矛盾地渲染列表）
    const weird = core.classifyRevisionsPayload({
      data: { revisions: [{ _id: 'r1' }], enabled: false },
    });
    assert.equal(weird.kind, 'off');
  });

  it('enabled:true + 有版本 → ok，元数据归一化（_id 收进 id，articleId 保留）', () => {
    const out = core.classifyRevisionsPayload({
      statusCode: 200,
      data: {
        revisions: [
          { _id: 'r2', articleId: 9, savedAt: '2026-09-10T08:00:00.000Z', title: '新标题', wordCount: 900, sizeBytes: 4096, reason: 'update' },
          { _id: 'r1', articleId: 9, savedAt: '2026-09-09T08:00:00.000Z', title: '旧标题', wordCount: 800, sizeBytes: 3000, reason: 'pre-restore' },
        ],
        total: 2,
        enabled: true,
      },
    });
    assert.equal(out.kind, 'ok');
    assert.equal(out.revisions.length, 2);
    assert.equal(out.revisions[0].id, 'r2');
    assert.equal(out.revisions[0].key, 'r2');
    assert.equal(out.revisions[0].articleId, 9);
    assert.equal(out.revisions[1].reason, 'pre-restore');
  });

  it('空列表 → empty；文案对「enabled:true 还没版本」和「老 server 没开功能」两种情况都成立', () => {
    const out = core.classifyRevisionsPayload({ statusCode: 200, data: { revisions: [], total: 0, enabled: true } });
    assert.equal(out.kind, 'empty');
    assert.equal(out.text, core.EMPTY_TEXT);
    assert.match(core.EMPTY_TEXT, /还没有历史版本/);
    assert.match(core.EMPTY_TEXT, /VANBLOG_ARTICLE_REVISIONS_KEEP=0/, '老 server 没有 enabled 字段时空列表也可能是功能没开，文案要覆盖');
  });

  it('形状漂移全部降级为 empty/占位值，不 throw', () => {
    assert.equal(core.classifyRevisionsPayload(null).kind, 'empty');
    assert.equal(core.classifyRevisionsPayload({}).kind, 'empty');
    assert.equal(core.classifyRevisionsPayload({ data: { revisions: 'oops' } }).kind, 'empty');
    const arr = core.classifyRevisionsPayload({ data: [{ _id: 'r1' }] });
    assert.equal(arr.kind, 'ok');
    assert.equal(arr.revisions.length, 1);
    const junk = core.classifyRevisionsPayload({ data: { revisions: [null, { id: 'r9' }, {}] } });
    assert.equal(junk.kind, 'ok');
    assert.equal(junk.revisions[0].key, 'revision-row-0');
    assert.equal(junk.revisions[0].title, '(无标题)');
    assert.equal(junk.revisions[1].id, 'r9', '_id 缺失时收 id');
    assert.equal(junk.revisions[2].wordCount, null);
    assert.equal(junk.revisions[2].sizeBytes, null);
    assert.equal(junk.revisions[2].reason, '');
  });
});

describe('reason 标签：pre-restore 要能解释「为什么有个我没存过的版本」', () => {
  it('已知枚举翻译成中文，未知枚举原样展示（服务端加新值不丢信息），空值 "-"', () => {
    assert.equal(core.REVISION_REASON_LABELS['update'], '保存更新');
    assert.equal(core.REVISION_REASON_LABELS['pre-restore'], '恢复前自动保存');
    assert.equal(core.formatRevisionReason('update'), '保存更新');
    assert.equal(core.formatRevisionReason('pre-restore'), '恢复前自动保存');
    assert.equal(core.formatRevisionReason('future-reason'), 'future-reason');
    assert.equal(core.formatRevisionReason(''), '-');
    assert.equal(core.formatRevisionReason(null), '-');
    assert.equal(core.formatRevisionReason(undefined), '-');
  });
});

describe('classifyRevisionsError / describeDetailFailure / describeRestoreRevisionFailure', () => {
  it('列表 404 → off（老 server 没有该路由，与新 server 的 enabled:false 同义）', () => {
    const out = core.classifyRevisionsError({ response: { status: 404 } });
    assert.equal(out.kind, 'off');
    assert.equal(out.text, core.FEATURE_OFF_TEXT);
    assert.equal(core.classifyRevisionsError({ data: { statusCode: 404 } }).kind, 'off');
  });

  it('其它失败 → error + 服务端原因', () => {
    const out = core.classifyRevisionsError({ data: { statusCode: 500, message: '数据库炸了' } });
    assert.equal(out.kind, 'error');
    assert.match(out.text, /历史版本加载失败/);
    assert.match(out.text, /数据库炸了/);
    assert.equal(core.classifyRevisionsError(null).kind, 'error');
  });

  it('详情 404：两种真实可能（被保留策略清掉 / 属于另一篇文章），且不许再提「server 没有详情接口」', () => {
    const out = core.describeDetailFailure({ response: { status: 404 } });
    assert.match(out, /404/);
    assert.match(out, /保留策略/);
    assert.match(out, /属于另一篇文章/);
    // 详情路由一直存在（嵌套在文章下，活体 401）：旧文案会把人支去查不存在的 server bug，钉死不许回来
    assert.doesNotMatch(out, /单版本详情接口/);
    assert.doesNotMatch(out, /server 版本/);
    const other = core.describeDetailFailure({ data: { message: 'boom' } });
    assert.match(other, /版本内容加载失败/);
    assert.match(other, /boom/);
  });

  it('恢复失败：404=版本没了或属于另一篇文章（契约明确）、403=点名 article:update、401=登录失效', () => {
    assert.match(core.describeRestoreRevisionFailure({ response: { status: 404 } }), /属于另一篇文章/);
    assert.match(core.describeRestoreRevisionFailure({ response: { status: 404 } }), /刷新为最新状态/);
    assert.match(core.describeRestoreRevisionFailure({ response: { status: 403 } }), /article:update/);
    assert.match(core.describeRestoreRevisionFailure({ data: { statusCode: 401 } }), /登录已失效/);
    assert.match(core.describeRestoreRevisionFailure({ data: { message: 'x' } }), /恢复版本失败（x）/);
    assert.equal(core.isNotFoundFailure({ response: { status: 404 } }), true);
    assert.equal(core.isNotFoundFailure({ response: { status: 403 } }), false);
  });
});

describe('normalizeRevisionDetail / normalizeRestoreResult：归一化', () => {
  it('详情：完整字段；content 非字符串一律 ""（界面给占位文案）；reason 也收进来', () => {
    const d = core.normalizeRevisionDetail({
      statusCode: 200,
      data: {
        _id: 'r1',
        articleId: 9,
        savedAt: '2026-09-09T08:00:00.000Z',
        title: '旧标题',
        content: '# hello',
        wordCount: 800,
        sizeBytes: 3000,
        reason: 'pre-restore',
      },
    });
    assert.equal(d.id, 'r1');
    assert.equal(d.articleId, 9);
    assert.equal(d.content, '# hello');
    assert.equal(d.reason, 'pre-restore');
    const bad = core.normalizeRevisionDetail({ data: { _id: 'r2', content: { weird: true } } });
    assert.equal(bad.content, '');
    assert.equal(bad.reason, '');
    assert.equal(core.normalizeRevisionDetail(null).content, '');
    assert.equal(core.normalizeRevisionDetail(null).title, '(无标题)');
    assert.match(core.DETAIL_EMPTY_CONTENT_TEXT, /没有正文内容/);
  });

  it('恢复响应：restored/snapshotRevisionId 归一化；缺字段 → null（老形状也当成功）', () => {
    const full = core.normalizeRestoreResult({
      statusCode: 200,
      data: { restored: true, articleId: 9, revisionId: 'r1', snapshotRevisionId: 'snap1' },
    });
    assert.deepEqual(full, { restored: true, articleId: 9, revisionId: 'r1', snapshotRevisionId: 'snap1' });
    const legacy = core.normalizeRestoreResult({ statusCode: 200, data: null });
    assert.deepEqual(legacy, { restored: null, articleId: null, revisionId: null, snapshotRevisionId: null });
    const notApplied = core.normalizeRestoreResult({ data: { restored: false } });
    assert.equal(notApplied.restored, false);
    assert.equal(core.normalizeRestoreResult(null).restored, null);
  });

  it('展示格式化：坏值 "-" / "未知大小"', () => {
    assert.equal(core.formatSavedAt('garbage'), '-');
    assert.equal(core.formatSavedAt(null), '-');
    assert.equal(core.formatRevisionSize(null), '-');
    assert.equal(core.formatRevisionSize(2048), '2.0 KB');
    assert.equal(core.formatRevisionWordCount(null), '-');
    assert.equal(core.formatRevisionWordCount(0), '0');
  });
});

describe('恢复确认与成功文案：可撤销性必须说透（snapshotRevisionId 是它的凭据）', () => {
  it('确认弹窗标题点名版本，内容解释「当前状态先存成新版本」', () => {
    assert.equal(
      core.revisionRestoreConfirmTitle({ title: '旧标题' }),
      '把文章恢复到「旧标题」这个版本吗？',
    );
    assert.match(core.REVISION_RESTORE_CONFIRM_CONTENT, /当前的状态保存成一个新的历史版本/);
    assert.match(core.REVISION_RESTORE_CONFIRM_CONTENT, /可撤销/);
    assert.equal(core.REVISION_RESTORE_OK_TEXT, '恢复到这个版本');
  });

  it('成功文案：响应带 snapshotRevisionId 时点出「已自动存为新版本，可再次恢复」', () => {
    const withSnapshot = core.revisionRestoreSuccessText(
      { title: '旧标题', savedAt: '2026-09-09T08:00:00.000Z' },
      { restored: true, snapshotRevisionId: 'snap1' },
    );
    assert.match(withSnapshot, /已恢复到「旧标题」/);
    assert.match(withSnapshot, /已自动存为一个新的历史版本/);
    assert.match(withSnapshot, /可再次恢复回来/);
    // 老形状（没有 snapshotRevisionId）也要说可撤销，只是不点名快照
    const legacy = core.revisionRestoreSuccessText({ title: 'T' }, null);
    assert.match(legacy, /恢复前的内容也存成了新版本/);
    assert.ok(core.revisionRestoreSuccessText(null, null).includes('(无标题)'));
  });

  it('restored:false 有专门的警示文案（不能弹成功）', () => {
    assert.match(core.REVISION_RESTORE_NOT_APPLIED_TEXT, /没有生效/);
    assert.match(core.REVISION_RESTORE_NOT_APPLIED_TEXT, /文章未改动/);
  });
});

describe('RevisionHistory 组件接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/components/RevisionHistory/index.jsx'));

  it('打开抽屉才拉列表；列表失败走 classifyRevisionsError，不弹全局 toast', () => {
    assert.match(comp, /if \(visible\) \{/);
    assert.match(comp, /await getArticleRevisions\(articleId\)/);
    assert.match(comp, /setOutcome\(classifyRevisionsPayload\(payload\)\)/);
    assert.match(comp, /setOutcome\(classifyRevisionsError\(err\)\)/);
  });

  it('功能关闭/空列表用 Alert 平静说明，而不是坏掉的空表格', () => {
    assert.match(comp, /outcome\.kind !== 'ok'/);
    assert.match(comp, /<Alert/);
    assert.match(comp, /message=\{outcome\.text \|\| EMPTY_TEXT\}/);
  });

  it('列表展示 reason 来源列（pre-restore 解释「没主动存过的版本」）', () => {
    assert.match(comp, /title: '来源'/);
    assert.match(comp, /formatRevisionReason\(record\?\.reason\)/);
  });

  it('正文只读展示：纯 <pre>，绝无 dangerouslySetInnerHTML（不引新渲染依赖，也不给 XSS 机会）', () => {
    assert.match(comp, /<pre/);
    assert.match(comp, /data-revision-content/);
    assert.match(comp, /whiteSpace: 'pre-wrap'/);
    assert.match(comp, /\{detail\.content \|\| DETAIL_EMPTY_CONTENT_TEXT\}/);
    assert.ok(!comp.includes('dangerouslySetInnerHTML'));
    assert.ok(!comp.includes('MarkdownView'));
  });

  it('恢复：确认弹窗（解释可撤销）→ PUT → normalized 结果；restored:false 弹 warning 不弹成功', () => {
    assert.match(comp, /Modal\.confirm/);
    assert.match(comp, /content: REVISION_RESTORE_CONFIRM_CONTENT/);
    assert.match(comp, /okText: REVISION_RESTORE_OK_TEXT/);
    assert.match(comp, /const payload = await restoreArticleRevision\(articleId, record\.id\)/);
    assert.match(comp, /normalizeRestoreResult\(payload\)/);
    assert.match(comp, /if \(result\.restored === false\) \{/);
    assert.match(comp, /message\.warning\(REVISION_RESTORE_NOT_APPLIED_TEXT\)/);
    assert.match(comp, /message\.success\(revisionRestoreSuccessText\(record, result\)\)/);
    assert.match(comp, /onRestored\?\.\(\)/);
  });

  it('恢复失败：按状态码定制的文案；404 时刷新列表恢复一致视图', () => {
    assert.match(comp, /message\.error\(describeRestoreRevisionFailure\(err\)\)/);
    assert.match(comp, /if \(isNotFoundFailure\(err\)\)/);
    assert.ok(!comp.includes('reportRequestError'), '文案统一走 core 的 describe*，不再用通用兜底');
  });

  it('没有文章 ID 时不请求，直接说明「保存后再来」', () => {
    assert.match(comp, /articleId == null \|\| articleId === ''/);
    assert.match(comp, /保存后再来查看历史版本/);
  });

  it('详情加载失败给 Alert 而不是白屏', () => {
    assert.match(comp, /setDetailError\(describeDetailFailure\(err\)\)/);
    assert.match(comp, /detailError \? \(/);
  });
});

describe('历史版本入口：文章列表 + 编辑器', () => {
  it('文章列表每行的「更多」菜单里有历史版本，恢复后刷新列表', () => {
    const cols = codeOnly(read('src/pages/Article/columns.jsx'));
    assert.match(cols, /import RevisionHistory from '@\/components\/RevisionHistory'/);
    assert.match(cols, /<RevisionHistory/);
    assert.match(cols, /articleId=\{record\?\.id\}/);
    assert.match(cols, /articleTitle=\{record\?\.title\}/);
  });

  it('编辑器「操作」菜单里有历史版本（仅文章且有 ID），恢复后重拉正文', () => {
    const editor = codeOnly(read('src/pages/Editor/index.jsx'));
    assert.match(editor, /import RevisionHistory from '@\/components\/RevisionHistory'/);
    assert.match(editor, /key: 'revisionsBtn'/);
    assert.match(editor, /type == 'article' && currObj\?\.id != null/);
    assert.match(editor, /历史版本/);
    assert.match(editor, /fetchData\(true\)/);
  });
});
