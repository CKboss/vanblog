/**
 * 回收站（「已删除」文章/草稿列表）的纯逻辑部分 —— 与 React/DOM 解耦，node --test 可直接 require。
 * 模式照抄 src/pages/InitPage/restoreCore.js：刻意 CommonJS（babel 能编，裸 node 能测）。
 *
 * 服务端契约（已上线，2026-09 server 确认）：
 * - GET /api/admin/article/deleted?page=&pageSize=
 *   → { statusCode:200, data:{ articles:[{ id, title, pathname, category, tags, top, hidden,
 *       author, cover, wordCount, publishAt, createdAt, updatedAt, deletedAt }], total } }
 *   （行内没有 content/password；`id` 是**数字 id**，restore/purge 的路径参数也是它。
 *   历史原因这里仍兼容 `_id` 兜底，但正常路径永远有 id。）
 * - GET /api/admin/draft/deleted?page=&pageSize= → data:{ drafts:[{ id, title, category,
 *   tags, author, createdAt, updatedAt, deletedAt }], total }
 * - PUT /api/admin/article/:id/restore、DELETE /api/admin/article/:id/purge
 * - PUT /api/admin/draft/:id/restore、DELETE /api/admin/draft/:id/purge
 * - purge 只对**已在回收站里**的条目有效，否则 404（UI 只从回收站行发起，404 时刷新列表）。
 * - 权限：列表为协作者可读；restore 需要 article:update / draft:update，
 *   purge 需要 article:delete / draft:delete（UI 按 permissions 隐藏入口 + 403 兜底文案）。
 * - restore/purge 有副作用：重算总字数、触发该文章的 ISR、发 afterUpdateArticle 流水线事件
 *   —— 成功提示里带一句，省得「恢复为什么会跑我的流水线」变成支持问题。
 *
 * ⚠️ 草稿回收站的语义陷阱（server 侧明确提示过）：**发布草稿成功后，草稿会被软删除**
 * （既有上游语义，不是新功能）⇒ 草稿回收站里既有「误删的草稿」也有「发布后归档的草稿」，
 * 而 payload 里**没有任何字段能可靠区分这两种**。恢复「发布后归档」的草稿不会碰已发布的
 * 文章，只会复活一份发布前的旧草稿（再发布会产生重复文章）。所以草稿的恢复/删除文案
 * 必须**同时为两种情况说真话**，不能只按「误删」场景承诺「恢复后回到列表」就完事。
 *
 * 防御性原则：所有字段 optional-chain；缺失/畸形一律降级为 '-'、null 或空数组，
 * 绝不把 undefined / NaN / Invalid Date 渲染出去，更不白屏。
 */
const { formatDateTime } = require('../../services/van-blog/formatTime');

const RECYCLE_LIST_ENDPOINT = '/api/admin/article/deleted';
const DRAFT_RECYCLE_LIST_ENDPOINT = '/api/admin/draft/deleted';

function restoreArticleEndpoint(id) {
  return `/api/admin/article/${encodeURIComponent(id)}/restore`;
}

function purgeArticleEndpoint(id) {
  return `/api/admin/article/${encodeURIComponent(id)}/purge`;
}

function restoreDraftEndpoint(id) {
  return `/api/admin/draft/${encodeURIComponent(id)}/restore`;
}

function purgeDraftEndpoint(id) {
  return `/api/admin/draft/${encodeURIComponent(id)}/purge`;
}

/** 权限名（与 server 的角色权限一致）：UI 用它决定是否渲染入口，403 文案也点名它。 */
const RECYCLE_PERMISSIONS = {
  article: { restore: 'article:update', purge: 'article:delete' },
  draft: { restore: 'draft:update', purge: 'draft:delete' },
};

/** 非负有限数字才认；其余（null/undefined/字符串/NaN）→ null，界面渲染 '-'。 */
function toCountOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 单行归一化。id 取 row.id ?? row._id（契约是数字 id，_id 只是历史兜底）；
 * key 是 Table 的 rowKey，没有 id 时用调用方传的下标兜底，保证 React 不炸。
 */
function normalizeDeletedArticle(row, index) {
  const r = row && typeof row === 'object' ? row : {};
  const id = r.id != null ? r.id : r._id != null ? r._id : null;
  return {
    key: id != null ? String(id) : `deleted-row-${index}`,
    id,
    title: typeof r.title === 'string' && r.title ? r.title : '(无标题)',
    pathname: typeof r.pathname === 'string' ? r.pathname : '',
    category: typeof r.category === 'string' ? r.category : '',
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => t != null).map((t) => String(t)) : [],
    author: typeof r.author === 'string' ? r.author : '',
    updatedAt: r.updatedAt != null ? r.updatedAt : null,
    deletedAt: r.deletedAt != null ? r.deletedAt : null,
    wordCount: toCountOrNull(r.wordCount),
  };
}

/**
 * 整个列表响应归一化：接受标准信封 {statusCode,data:{articles|drafts,total}}，
 * 也容忍 server 直接回 {articles,total}（形状漂移不白屏）。
 * total 缺失/非法时退回本页条数，分页器至少不会显示 NaN。
 */
function normalizeDeletedList(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  const rows = Array.isArray(d.articles)
    ? d.articles
    : Array.isArray(d.drafts) // 草稿列表的键名按契约是 drafts；articles 也容忍
      ? d.drafts
      : [];
  const articles = rows.map((row, index) => normalizeDeletedArticle(row, index));
  const total = toCountOrNull(d.total);
  return { articles, total: total != null ? total : articles.length };
}

/** 界面上的时间列：坏值渲染 '-'（formatDateTime 已兜底）。 */
function formatDeletedAt(value) {
  return formatDateTime(value);
}

/** 字数列：null → '-'。 */
function formatWordCount(value) {
  return value == null ? '-' : String(value);
}

/** 空状态文案：解释这个列表是什么（任务要求「Empty state that explains what this list is」）。 */
const RECYCLE_EMPTY_TEXT =
  '这里列出的是在「文章管理」中被删除的文章（软删除）：它们不会出现在前台，也不计入统计。' +
  '你可以随时「恢复」把它们放回文章列表，或「永久删除」彻底移除（不可撤销）。当前没有已删除的文章。';

/**
 * 草稿空状态：必须同时说清「发布成功的草稿也会出现在这里」，
 * 否则用户会把发布归档误读成丢了草稿，或把恢复误读成撤销发布。
 */
const DRAFT_RECYCLE_EMPTY_TEXT =
  '这里列出的是被删除的草稿。注意：草稿在发布成功后也会自动进入这里（发布即归档草稿，是既有行为）。' +
  '恢复只作用于草稿本身：误删的草稿会回到草稿列表；发布后归档的草稿恢复出来只是一份发布前的旧副本，' +
  '不会改动已发布的文章。当前没有已删除的草稿。';

function articleLabel(record) {
  const title = record && typeof record === 'object' && record.title ? record.title : '(无标题)';
  return `「${title}」`;
}

/** 文章恢复确认（Popconfirm 用；antd4 的 Popconfirm 没有 description，只有 title）。 */
const RESTORE_CONFIRM_TITLE = '确认恢复这篇文章吗？';
const RESTORE_CONFIRM_TEXT = '恢复后文章会带着删除前的内容和设置回到「文章管理」列表。';

/** 文章永久删除确认：危险样式 + 明说不可撤销。 */
function purgeConfirmTitle(record) {
  return `永久删除${articleLabel(record)}？`;
}
const PURGE_CONFIRM_CONTENT =
  '永久删除会把这篇文章（含正文、别名、标签等全部内容）从数据库里彻底移除，此操作不可撤销，' +
  '删除后无法再从回收站恢复。如果只是误删，请改用「恢复」。';
const PURGE_OK_TEXT = '永久删除';

/**
 * 草稿恢复确认：payload 无法区分「误删」与「发布后归档」，
 * 所以文案对两种情况都说真话（不能暗示恢复=撤销发布）。
 */
const DRAFT_RESTORE_CONFIRM_TITLE = '确认恢复这个草稿吗？';
const DRAFT_RESTORE_CONFIRM_TEXT =
  '恢复只作用于草稿本身：它会回到「草稿管理」列表，可以继续编辑。' +
  '注意：发布成功的草稿也会自动进入回收站 —— 如果这条正是发布时归档的，恢复它不会改动已发布的文章，' +
  '你只会得到一份发布前的旧草稿；再次编辑并发布它会产生一篇重复的文章，请先确认这是你要的。';

function draftPurgeConfirmTitle(record) {
  return `永久删除草稿${articleLabel(record)}？`;
}
const DRAFT_PURGE_CONFIRM_CONTENT =
  '永久删除会把这份草稿从数据库里彻底移除，此操作不可撤销，删除后无法再从回收站恢复。' +
  '如果它已经发布过，删除这份草稿不影响那篇已发布的文章。';

/** 成功提示：恢复按「文章更新」处理（流水线会跑、ISR 与总字数会刷新），一句带过防支持问题。 */
function restoreSuccessText(record) {
  return (
    `已恢复${articleLabel(record)}，它已回到文章列表。` +
    '恢复按「文章更新」处理：绑定文章更新的流水线会运行，前台缓存与总字数会刷新。'
  );
}

function purgeSuccessText(record) {
  return `已永久删除${articleLabel(record)}，此操作不可撤销；总字数与前台缓存会随之刷新。`;
}

function draftRestoreSuccessText(record) {
  return (
    `已恢复草稿${articleLabel(record)}，它已回到草稿列表。` +
    '如果它曾发布过：已发布的文章不受影响，这只是发布前的旧草稿。'
  );
}

function draftPurgeSuccessText(record) {
  return `已永久删除草稿${articleLabel(record)}，此操作不可撤销。`;
}

function extractFailureStatus(err) {
  return (
    (err && err.response && err.response.status) ||
    (err && err.data && err.data.statusCode) ||
    (err && err.info && err.info.statusCode) ||
    null
  );
}

function extractFailureMessage(err) {
  const raw =
    (err && err.data && err.data.message) ||
    (err && err.info && err.info.errorMessage) ||
    (err && err.message) ||
    '';
  return typeof raw === 'string' ? raw : '';
}

/** 列表加载失败 → 抽屉内 Alert 的文案（不弹全局 toast，避免每次打开抽屉炸一条）。 */
function describeListFailure(err) {
  const status = extractFailureStatus(err);
  const serverMessage = extractFailureMessage(err);
  if (status === 404) {
    return '当前 server 还没有回收站接口（404）：请把 server 升级到包含「文章回收站」的版本后再用这个列表。';
  }
  const detail = serverMessage ? `（${serverMessage}）` : '';
  return `回收站列表加载失败${detail}，请稍后重试；这不影响文章管理里的其它功能。`;
}

/** 404 = 这条已经不在回收站里（刚被别人恢复/清除）：调用方应刷新列表。 */
function isNotFoundFailure(err) {
  return extractFailureStatus(err) === 404;
}

/**
 * 恢复/永久删除失败的统一文案：404（已不在回收站）、403（缺权限，点名需要的权限）、
 * 401（登录失效）、其余带上服务端原因。action='恢复'|'永久删除'，label='文章'|'草稿'。
 */
function describeRecycleActionFailure(err, options) {
  const action = (options && options.action) || '操作';
  const label = (options && options.label) || '内容';
  const permission = options && options.permission;
  const status = extractFailureStatus(err);
  const serverMessage = extractFailureMessage(err);
  if (status === 404) {
    return `这条${label}已不在回收站中（可能刚被恢复或已被永久删除），列表将刷新为最新状态。`;
  }
  if (status === 403) {
    return `当前账号没有${action}这条${label}的权限${permission ? `（需要 ${permission}）` : ''}，请联系管理员。`;
  }
  if (status === 401) {
    return '登录已失效，请重新登录后再试。';
  }
  const detail = serverMessage ? `（${serverMessage}）` : '';
  return `${action}失败${detail}，请稍后重试。`;
}

module.exports = {
  RECYCLE_LIST_ENDPOINT,
  DRAFT_RECYCLE_LIST_ENDPOINT,
  RECYCLE_EMPTY_TEXT,
  DRAFT_RECYCLE_EMPTY_TEXT,
  RESTORE_CONFIRM_TITLE,
  RESTORE_CONFIRM_TEXT,
  DRAFT_RESTORE_CONFIRM_TITLE,
  DRAFT_RESTORE_CONFIRM_TEXT,
  PURGE_CONFIRM_CONTENT,
  DRAFT_PURGE_CONFIRM_CONTENT,
  PURGE_OK_TEXT,
  RECYCLE_PERMISSIONS,
  restoreArticleEndpoint,
  purgeArticleEndpoint,
  restoreDraftEndpoint,
  purgeDraftEndpoint,
  normalizeDeletedArticle,
  normalizeDeletedList,
  formatDeletedAt,
  formatWordCount,
  articleLabel,
  purgeConfirmTitle,
  draftPurgeConfirmTitle,
  restoreSuccessText,
  purgeSuccessText,
  draftRestoreSuccessText,
  draftPurgeSuccessText,
  describeListFailure,
  describeRecycleActionFailure,
  isNotFoundFailure,
};
