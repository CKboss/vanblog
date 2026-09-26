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

/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / coverBackfill.js / batch.ts / recycleCore.js 同一套模式）。
 * 本模块是纯逻辑 CommonJS（`node --test` 直接 require），模块加载期拿不到 umi 运行时 ⇒ 翻译器由调用方在渲染期注入。
 *
 * 🔴 **不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前逐字相同**：`revisionHistory.test.js` 里那 ~15 条黄金样本
 * （`FEATURE_OFF_TEXT` 含「未开启」、`EMPTY_TEXT` 含「还没有历史版本」与那个环境变量名、
 * `REVISION_REASON_LABELS['update'] === '保存更新'`、`classifyRevisionsError(...).text` 含服务端原因…）
 * 一个字都不用改就照旧通过 —— 这是本批最重要的兼容性证据。
 *
 * 🔴 **内部转发**：`classifyRevisionsPayload/Error` 返回的 `text` 来自这里的函数，
 * `revisionRestoreSuccessText` 内部还要拼 `（{when} 保存的版本）` 与两句快照说明 ⇒
 * 每一处内部调用都要把 t 传下去（§7.156 A ③ 那个坑本项目已踩两次，别再踩第三次）。
 *
 * 🔴 SCREAMING_CASE 常量保留为**同一份文案的 identity 视图**（中文只有一份，在 defaultMessage 里）。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

function featureOffText(t = IDENTITY_T) {
  return t(
    'revision.featureOff',
    '版本历史功能未开启（服务端 VANBLOG_ARTICLE_REVISIONS_KEEP=0，或 server 版本还不支持）。开启后每次保存文章都会自动记录一个版本，超出保留上限的旧版本由服务端自动清理。',
  );
}
const FEATURE_OFF_TEXT = featureOffText();

/**
 * 空列表文案：新 server 会用 enabled:true + 空 revisions 明确「功能开着、只是还没版本」，
 * 但老 server 没有 enabled 字段，空列表也可能是功能没开 —— 文案对两种情况都成立。
 */
function emptyText(t = IDENTITY_T) {
  return t(
    'revision.empty',
    '这篇文章还没有历史版本。保存文章时会自动记录版本（保留条数上限由服务端控制）；若服务端未开启版本历史（VANBLOG_ARTICLE_REVISIONS_KEEP=0），这里会一直为空。',
  );
}
const EMPTY_TEXT = emptyText();

function detailEmptyContentText(t = IDENTITY_T) {
  return t('revision.detailEmptyContent', '（这个版本没有正文内容）');
}
const DETAIL_EMPTY_CONTENT_TEXT = detailEmptyContentText();

/** reason → 标签。'pre-restore' 值得单独说：它解释了为什么多出一个用户没主动存的版本。 */
function revisionReasonLabels(t = IDENTITY_T) {
  return {
    update: t('revision.reasonUpdate', '保存更新'),
    'pre-restore': t('revision.reasonPreRestore', '恢复前自动保存'),
  };
}
const REVISION_REASON_LABELS = revisionReasonLabels();

function formatRevisionReason(reason, t = IDENTITY_T) {
  if (reason === null || reason === undefined || reason === '') {
    return '-';
  }
  const key = String(reason);
  // 未知 reason 原样展示（服务端以后加新枚举不至于显示成 '-' 吞掉信息）
  return revisionReasonLabels(t)[key] || key;
}

function toCountOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 列表行归一化：id 收 _id 也收 id；坏行不丢，字段降级为占位值。 */
function normalizeRevisionMeta(row, index, t = IDENTITY_T) {
  const r = row && typeof row === 'object' ? row : {};
  const id = r._id != null ? r._id : r.id != null ? r.id : null;
  return {
    key: id != null ? String(id) : `revision-row-${index}`,
    id,
    articleId: r.articleId != null ? r.articleId : null,
    savedAt: r.savedAt != null ? r.savedAt : null,
    title: typeof r.title === 'string' && r.title ? r.title : t('revision.untitled', '(无标题)'),
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
function classifyRevisionsPayload(payload, t = IDENTITY_T) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  if (d.enabled === false) {
    return { kind: 'off', revisions: [], text: featureOffText(t) };
  }
  const rows = Array.isArray(d.revisions)
    ? d.revisions
    : Array.isArray(d) // 容忍 data 直接是数组的形状漂移
      ? d
      : [];
  const revisions = rows.map((row, index) => normalizeRevisionMeta(row, index, t));
  if (!revisions.length) {
    // 🔴 这里必须用**函数版**（传 t），不能用 identity 常量 EMPTY_TEXT：
    //    常量是模块加载期求值的中文，用它就等于"注入了 t 也不生效"。
    //    本批第一版就漏了这一处，🔴 是活体探针在 en-US 下量出来的（抽屉标题是英文、正文却是中文）；
    //    而"每个调用点都要传 t"那条守卫**看不见它**（这里根本没有函数调用，只是引用了常量）⇒ 已补一条判据。
    return { kind: 'empty', revisions: [], text: emptyText(t) };
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
function classifyRevisionsError(err, t = IDENTITY_T) {
  const status = extractStatus(err);
  if (status === 404) {
    return { kind: 'off', revisions: [], text: featureOffText(t) };
  }
  const serverMessage = extractMessage(err);
  // 🔴 服务端原因用 ICU 占位符包一层（英文的括号与语序不同）；没有原因时传空串
  const detail = serverMessage ? t('revision.detailWrap', '（{message}）', { message: serverMessage }) : '';
  return {
    kind: 'error',
    revisions: [],
    text: t('revision.listFailed', '历史版本加载失败{detail}，请稍后重试。', { detail }),
  };
}

/**
 * 单版本详情加载失败。404 的两种真实可能都要说到：这个版本刚被保留策略清掉，
 * 或它属于另一篇文章（嵌套路由会校验 ObjectId 归属）。
 * ⚠️ 别再写「server 没有详情接口」—— 那是早期契约给错路径时代的文案，
 * 路由一直存在（GET /api/admin/article/:id/revisions/:rid，活体 401），留着会把人支去查不存在的 server bug。
 */
function describeDetailFailure(err, t = IDENTITY_T) {
  const status = extractStatus(err);
  if (status === 404) {
    return t(
      'revision.detailNotFound',
      '这个版本的内容拿不到（404）：可能刚被服务端的保留策略清理掉，或它属于另一篇文章；请刷新列表确认。',
    );
  }
  const serverMessage = extractMessage(err);
  const detail = serverMessage ? t('revision.detailWrap', '（{message}）', { message: serverMessage }) : '';
  return t('revision.detailFailed', '版本内容加载失败{detail}，请稍后重试。', { detail });
}

/**
 * 版本恢复失败。404 = 版本不存在**或属于另一篇文章**（server 契约明确后者也是 404）；
 * 403 = 缺 article:update 权限；401 = 登录失效。
 */
function describeRestoreRevisionFailure(err, t = IDENTITY_T) {
  const status = extractStatus(err);
  if (status === 404) {
    return t(
      'revision.restoreNotFound',
      '找不到这个版本（404）：它可能已被服务端的保留策略清理，或属于另一篇文章；列表将刷新为最新状态。',
    );
  }
  if (status === 403) {
    return t(
      'revision.restoreForbidden',
      '当前账号没有恢复版本的权限（需要 article:update），请联系管理员。',
    );
  }
  if (status === 401) {
    return t('revision.restoreUnauthorized', '登录已失效，请重新登录后再试。');
  }
  const serverMessage = extractMessage(err);
  const detail = serverMessage ? t('revision.detailWrap', '（{message}）', { message: serverMessage }) : '';
  return t('revision.restoreFailed', '恢复版本失败{detail}，请稍后重试。', { detail });
}

/** 单版本详情归一化：content 非字符串一律按 ''（界面显示「没有正文」占位）。 */
function normalizeRevisionDetail(payload, t = IDENTITY_T) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  const id = d._id != null ? d._id : d.id != null ? d.id : null;
  return {
    id,
    articleId: d.articleId != null ? d.articleId : null,
    savedAt: d.savedAt != null ? d.savedAt : null,
    title: typeof d.title === 'string' && d.title ? d.title : t('revision.untitled', '(无标题)'),
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
function revisionRestoreOkText(t = IDENTITY_T) {
  return t('revision.restoreOkBtn', '恢复到这个版本');
}
const REVISION_RESTORE_OK_TEXT = revisionRestoreOkText();

function revisionRestoreConfirmTitle(record, t = IDENTITY_T) {
  const title = record && record.title ? record.title : t('revision.untitled', '(无标题)');
  return t('revision.restoreConfirmTitle', '把文章恢复到「{title}」这个版本吗？', { title });
}
function revisionRestoreConfirmContent(t = IDENTITY_T) {
  return t(
    'revision.restoreConfirmContent',
    '恢复前，服务端会先把文章当前的状态保存成一个新的历史版本，所以这次恢复本身也是可撤销的（之后可以再恢复回现在的内容）。确认后用该版本的正文覆盖文章当前正文。',
  );
}
const REVISION_RESTORE_CONFIRM_CONTENT = revisionRestoreConfirmContent();

/** 恢复失败但接口没抛（restored:false）时的警示文案。 */
function revisionRestoreNotAppliedText(t = IDENTITY_T) {
  return t(
    'revision.restoreNotApplied',
    '服务端报告这次恢复没有生效（restored=false），文章未改动；请刷新列表后重试。',
  );
}
const REVISION_RESTORE_NOT_APPLIED_TEXT = revisionRestoreNotAppliedText();

/**
 * 成功文案：点出 snapshotRevisionId —— 「当前内容已存为一个历史版本」正是这次操作
 * 可撤销的原因，值得在 toast 里说出来（server 侧明确要求 surface 它）。
 */
function revisionRestoreSuccessText(record, result, t = IDENTITY_T) {
  const title = record && record.title ? record.title : t('revision.untitled', '(无标题)');
  const when =
    record && record.savedAt
      ? t('revision.savedVersionWhen', '（{when} 保存的版本）', { when: formatDateTime(record.savedAt) })
      : '';
  const snapshot =
    result && result.snapshotRevisionId != null
      ? t('revision.restoreSnapshot', '恢复前的当前内容已自动存为一个新的历史版本，可再次恢复回来。')
      : t('revision.restoreSnapshotAlt', '恢复前的内容也存成了新版本，可随时再恢复回来。');
  return t('revision.restoreSuccess', '已恢复到「{title}」{when}；{snapshot}', { title, when, snapshot });
}

module.exports = {
  // 🔴 注入式翻译器的回落实现也导出（消费方的单测可以用它验"不传 t 时逐字相同"）
  IDENTITY_T,
  featureOffText,
  emptyText,
  detailEmptyContentText,
  revisionReasonLabels,
  revisionRestoreOkText,
  revisionRestoreConfirmContent,
  revisionRestoreNotAppliedText,
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
