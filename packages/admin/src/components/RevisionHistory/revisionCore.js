/**
 * 版本历史（历史版本）的纯逻辑部分 —— 与 React/DOM 解耦，node --test 可直接 require。
 * 模式照抄 src/pages/InitPage/restoreCore.js：刻意 CommonJS。
 *
 * 服务端契约（已上线，2026-09 server 确认）：
 * - GET /api/admin/article/:id/revisions
 *   → { statusCode:200, data:{ revisions:[{ _id, articleId, savedAt, title, wordCount,
 *       sizeBytes, reason }], total, enabled:boolean } }
 *   （只有元数据，没有 content；reason ∈ 'update' | 'pre-restore'）
 * - GET /api/admin/article/:id/revisions/:rid → { statusCode:200, data:{ _id, articleId,
 *   savedAt, title, content, wordCount, sizeBytes, reason } }
 *   ⚠️ 详情路由**嵌在文章下面**：不存在顶层 /api/admin/revisions/:rid —— 早期契约写错过，
 *   单测全绿，只有活体探测的 Cannot GET 404 才暴露（测试里钉了「路径必须含文章 id」防回退）。
 *   版本属于别的文章 → 404（ObjectId 会先校验）。
 * - **PUT** /api/admin/article/:id/revisions/:rid/restore（早期契约写的 POST，server 已更正）
 *   → { statusCode:200, data:{ restored:true, articleId, revisionId, snapshotRevisionId } }；
 *   服务端会先把「恢复前的当前状态」存成新版本（snapshotRevisionId 就是它），所以恢复可撤销。
 *   版本属于别的文章 → 404。
 * - 保留条数上限在服务端（VANBLOG_ARTICLE_REVISIONS_KEEP，默认 10，0=功能关闭）。
 *   功能关闭的判定：**data.enabled === false 为准**；老 server 没有 enabled 字段时
 *   退回「404 或空列表」的旧推断，两种都要平静处理，不弹错误风暴。
 *
 * 防御性：所有字段 optional-chain；畸形行降级为占位值而不是崩掉/渲染 undefined。
 */
const { formatBytes, formatDateTime } = require('../../services/van-blog/formatTime');

function revisionsListEndpoint(articleId) {
  return `/api/admin/article/${encodeURIComponent(articleId)}/revisions`;
}

function revisionDetailEndpoint(articleId, revisionId) {
  // ⚠️ 嵌套在文章下，不是顶层 /api/admin/revisions/:rid（那条 server 上不存在，活体是 Cannot GET 404）
  return `/api/admin/article/${encodeURIComponent(articleId)}/revisions/${encodeURIComponent(revisionId)}`;
}

function revisionRestoreEndpoint(articleId, revisionId) {
  return `/api/admin/article/${encodeURIComponent(articleId)}/revisions/${encodeURIComponent(revisionId)}/restore`;
}

const FEATURE_OFF_TEXT =
  '版本历史功能未开启（服务端 VANBLOG_ARTICLE_REVISIONS_KEEP=0，或 server 版本还不支持）。' +
  '开启后每次保存文章都会自动记录一个版本，超出保留上限的旧版本由服务端自动清理。';

/**
 * 空列表文案：新 server 会用 enabled:true + 空 revisions 明确「功能开着、只是还没版本」，
 * 但老 server 没有 enabled 字段，空列表也可能是功能没开 —— 文案对两种情况都成立。
 */
const EMPTY_TEXT =
  '这篇文章还没有历史版本。保存文章时会自动记录版本（保留条数上限由服务端控制）；' +
  '若服务端未开启版本历史（VANBLOG_ARTICLE_REVISIONS_KEEP=0），这里会一直为空。';

const DETAIL_EMPTY_CONTENT_TEXT = '（这个版本没有正文内容）';

/** reason → 中文标签。'pre-restore' 值得单独说：它解释了为什么多出一个用户没主动存的版本。 */
const REVISION_REASON_LABELS = {
  update: '保存更新',
  'pre-restore': '恢复前自动保存',
};

function formatRevisionReason(reason) {
  if (reason === null || reason === undefined || reason === '') {
    return '-';
  }
  const key = String(reason);
  // 未知 reason 原样展示（服务端以后加新枚举不至于显示成 '-' 吞掉信息）
  return REVISION_REASON_LABELS[key] || key;
}

function toCountOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 列表行归一化：id 收 _id 也收 id；坏行不丢，字段降级为占位值。 */
function normalizeRevisionMeta(row, index) {
  const r = row && typeof row === 'object' ? row : {};
  const id = r._id != null ? r._id : r.id != null ? r.id : null;
  return {
    key: id != null ? String(id) : `revision-row-${index}`,
    id,
    articleId: r.articleId != null ? r.articleId : null,
    savedAt: r.savedAt != null ? r.savedAt : null,
    title: typeof r.title === 'string' && r.title ? r.title : '(无标题)',
    wordCount: toCountOrNull(r.wordCount),
    sizeBytes: toCountOrNull(r.sizeBytes),
    reason: r.reason != null ? String(r.reason) : '',
  };
}

/**
 * 列表接口**成功返回**（HTTP 2xx + 信封 statusCode=200）时的分类：
 * - data.enabled === false → off（服务端明确说功能关闭，最权威的信号）；
 * - 有版本 → ok；空列表 → empty（enabled:true 时就是「还没存过版本」，
 *   老 server 没有 enabled 时 EMPTY_TEXT 两种情况都覆盖）；
 * - 信封畸形（data 不是对象 / revisions 不是数组）按 empty 处理，不白屏。
 * 404 不走这里 —— skipErrorHandler 下它是 throw 出来的，见 classifyRevisionsError。
 */
function classifyRevisionsPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  if (d.enabled === false) {
    return { kind: 'off', revisions: [], text: FEATURE_OFF_TEXT };
  }
  const rows = Array.isArray(d.revisions)
    ? d.revisions
    : Array.isArray(d) // 容忍 data 直接是数组的形状漂移
      ? d
      : [];
  const revisions = rows.map((row, index) => normalizeRevisionMeta(row, index));
  if (!revisions.length) {
    return { kind: 'empty', revisions: [], text: EMPTY_TEXT };
  }
  return { kind: 'ok', revisions, text: '' };
}

function extractStatus(err) {
  return (
    (err && err.response && err.response.status) ||
    (err && err.data && err.data.statusCode) ||
    (err && err.info && err.info.statusCode) ||
    null
  );
}

function extractMessage(err) {
  const raw =
    (err && err.data && err.data.message) ||
    (err && err.info && err.info.errorMessage) ||
    (err && err.message) ||
    '';
  return typeof raw === 'string' ? raw : '';
}

/** 404 判定（组件用它决定失败后要不要刷新列表）。 */
function isNotFoundFailure(err) {
  return extractStatus(err) === 404;
}

/**
 * 列表接口 **throw**（api 层带 skipErrorHandler，404/网络错误/非 200 信封都会到这里）时的分类。
 * 404 = 老 server 没有该路由 → 按功能未开启处理（新 server 用 enabled:false 表达同一件事）；
 * 其余 → kind:'error'，把服务端原因带上。
 */
function classifyRevisionsError(err) {
  const status = extractStatus(err);
  if (status === 404) {
    return { kind: 'off', revisions: [], text: FEATURE_OFF_TEXT };
  }
  const serverMessage = extractMessage(err);
  const detail = serverMessage ? `（${serverMessage}）` : '';
  return { kind: 'error', revisions: [], text: `历史版本加载失败${detail}，请稍后重试。` };
}

/**
 * 单版本详情加载失败。404 的两种真实可能都要说到：这个版本刚被保留策略清掉，
 * 或它属于另一篇文章（嵌套路由会校验 ObjectId 归属）。
 * ⚠️ 别再写「server 没有详情接口」—— 那是早期契约给错路径时代的文案，
 * 路由一直存在（GET /api/admin/article/:id/revisions/:rid，活体 401），留着会把人支去查不存在的 server bug。
 */
function describeDetailFailure(err) {
  const status = extractStatus(err);
  if (status === 404) {
    return '这个版本的内容拿不到（404）：可能刚被服务端的保留策略清理掉，或它属于另一篇文章；请刷新列表确认。';
  }
  const serverMessage = extractMessage(err);
  const detail = serverMessage ? `（${serverMessage}）` : '';
  return `版本内容加载失败${detail}，请稍后重试。`;
}

/**
 * 版本恢复失败。404 = 版本不存在**或属于另一篇文章**（server 契约明确后者也是 404）；
 * 403 = 缺 article:update 权限；401 = 登录失效。
 */
function describeRestoreRevisionFailure(err) {
  const status = extractStatus(err);
  if (status === 404) {
    return '找不到这个版本（404）：它可能已被服务端的保留策略清理，或属于另一篇文章；列表将刷新为最新状态。';
  }
  if (status === 403) {
    return '当前账号没有恢复版本的权限（需要 article:update），请联系管理员。';
  }
  if (status === 401) {
    return '登录已失效，请重新登录后再试。';
  }
  const serverMessage = extractMessage(err);
  const detail = serverMessage ? `（${serverMessage}）` : '';
  return `恢复版本失败${detail}，请稍后重试。`;
}

/** 单版本详情归一化：content 非字符串一律按 ''（界面显示「没有正文」占位）。 */
function normalizeRevisionDetail(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  const id = d._id != null ? d._id : d.id != null ? d.id : null;
  return {
    id,
    articleId: d.articleId != null ? d.articleId : null,
    savedAt: d.savedAt != null ? d.savedAt : null,
    title: typeof d.title === 'string' && d.title ? d.title : '(无标题)',
    content: typeof d.content === 'string' ? d.content : '',
    wordCount: toCountOrNull(d.wordCount),
    sizeBytes: toCountOrNull(d.sizeBytes),
    reason: d.reason != null ? String(d.reason) : '',
  };
}

/**
 * 恢复接口的响应归一化：{ restored, articleId, revisionId, snapshotRevisionId }。
 * restored 显式为 false 时组件必须按「未生效」处理（不能弹成功）；
 * 字段缺失（老形状）→ null，按成功处理但不展示快照信息。
 */
function normalizeRestoreResult(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  return {
    restored: d.restored === true ? true : d.restored === false ? false : null,
    articleId: d.articleId != null ? d.articleId : null,
    revisionId: d.revisionId != null ? d.revisionId : null,
    snapshotRevisionId: d.snapshotRevisionId != null ? d.snapshotRevisionId : null,
  };
}

/** 展示层格式化（坏值 → '-' / '未知大小'，见 formatTime.js）。 */
function formatSavedAt(value) {
  return formatDateTime(value);
}

function formatRevisionSize(bytes) {
  return bytes == null ? '-' : formatBytes(bytes);
}

function formatRevisionWordCount(value) {
  return value == null ? '-' : String(value);
}

/** 恢复确认：必须解释「当前状态会先被存成一个新版本，所以这次恢复可撤销」。 */
const REVISION_RESTORE_OK_TEXT = '恢复到这个版本';
function revisionRestoreConfirmTitle(record) {
  const title = record && record.title ? record.title : '(无标题)';
  return `把文章恢复到「${title}」这个版本吗？`;
}
const REVISION_RESTORE_CONFIRM_CONTENT =
  '恢复前，服务端会先把文章当前的状态保存成一个新的历史版本，所以这次恢复本身也是可撤销的' +
  '（之后可以再恢复回现在的内容）。确认后用该版本的正文覆盖文章当前正文。';

/** 恢复失败但接口没抛（restored:false）时的警示文案。 */
const REVISION_RESTORE_NOT_APPLIED_TEXT = '服务端报告这次恢复没有生效（restored=false），文章未改动；请刷新列表后重试。';

/**
 * 成功文案：点出 snapshotRevisionId —— 「当前内容已存为一个历史版本」正是这次操作
 * 可撤销的原因，值得在 toast 里说出来（server 侧明确要求 surface 它）。
 */
function revisionRestoreSuccessText(record, result) {
  const title = record && record.title ? record.title : '(无标题)';
  const when = record && record.savedAt ? `（${formatDateTime(record.savedAt)} 保存的版本）` : '';
  const snapshot =
    result && result.snapshotRevisionId != null
      ? '恢复前的当前内容已自动存为一个新的历史版本，可再次恢复回来。'
      : '恢复前的内容也存成了新版本，可随时再恢复回来。';
  return `已恢复到「${title}」${when}；${snapshot}`;
}

module.exports = {
  FEATURE_OFF_TEXT,
  EMPTY_TEXT,
  DETAIL_EMPTY_CONTENT_TEXT,
  REVISION_REASON_LABELS,
  REVISION_RESTORE_OK_TEXT,
  REVISION_RESTORE_CONFIRM_CONTENT,
  REVISION_RESTORE_NOT_APPLIED_TEXT,
  revisionsListEndpoint,
  revisionDetailEndpoint,
  revisionRestoreEndpoint,
  formatRevisionReason,
  normalizeRevisionMeta,
  classifyRevisionsPayload,
  classifyRevisionsError,
  isNotFoundFailure,
  describeDetailFailure,
  describeRestoreRevisionFailure,
  normalizeRevisionDetail,
  normalizeRestoreResult,
  formatSavedAt,
  formatRevisionSize,
  formatRevisionWordCount,
  revisionRestoreConfirmTitle,
  revisionRestoreSuccessText,
};
