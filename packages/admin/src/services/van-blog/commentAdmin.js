/**
 * 内置评论后台的纯函数：状态 → 标签/颜色、状态页签计数、CommentSetting 规范化与关键词校验。
 *
 * 单独抽出来的原因：评论管理页（pages/CommentManage）与「评论系统」设置卡片
 * （SystemConfig/tabs/CommentSystem.jsx）共用同一套映射和服务端上限，
 * 而且都是无副作用的纯逻辑，能被 node:test 直接 require() 做行为测试
 * （见 tests/unit/commentAdmin.test.js），不用去测 JSX。
 *
 * 用 module.exports（和 requestError.js 一致）而不是 ESM export：
 * 单测跑在裸 node 下，require() 不了 ESM。
 */

// 服务端 comment.provider.ts 认的四个状态，顺序即页签顺序
const COMMENT_STATUSES = ['pending', 'approved', 'spam', 'deleted'];

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是服务层纯逻辑模块（裸 node 下也要能 require），
 * 拿不到 hook ⇒ 由消费方在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**。
 * ⚠️ 下面大写常量是 **identity 视图**（给单测与还没接 i18n 的消费方用）；
 *    已接 i18n 的消费方必须调函数版并传 t（localePackParity 有判据 + 反证盯着）。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

const commentStatusMeta = (t = IDENTITY_T) => ({
  pending: { label: t('comment.statusPending', '待审核'), color: 'orange' },
  approved: { label: t('comment.statusApproved', '已通过'), color: 'green' },
  spam: { label: t('comment.statusSpam', '垃圾'), color: 'red' },
  deleted: { label: t('comment.statusDeleted', '已删除'), color: 'default' },
});

/** identity 视图 */
const COMMENT_STATUS_META = commentStatusMeta();

// 与服务端 CommentSetting 的默认值/上限保持一致（server 是权威，这里只做表单兜底）
const COMMENT_PROVIDERS = ['builtin', 'waline', 'off'];
const COMMENT_MODERATIONS = ['post', 'pre', 'none'];
const MAX_CONTENT_LENGTH_CAP = 20000;
const RATE_LIMIT_CAP = 1000;
const MAX_KEYWORDS = 200;
const MAX_KEYWORD_LENGTH = 30;

const DEFAULT_COMMENT_SETTING = {
  provider: 'builtin',
  moderation: 'post',
  keywords: [],
  requireEmail: false,
  pendingOnLink: true,
  maxContentLength: 2000,
  rateLimitPer10Min: 10,
};

/** 状态 → { label, color }；未知状态也要能渲染（脏数据不能让整列崩掉） */
function statusMeta(status, t = IDENTITY_T) {
  const meta = commentStatusMeta(t);
  return (
    meta[status] || {
      label: status ? String(status) : t('comment.statusUnknown', '未知状态'),
      color: 'default',
    }
  );
}

/**
 * 状态页签（含每个状态的计数）。「全部」= 待审+已通过+垃圾，**不加已删除**：
 * 服务端 status=all 的过滤器是 `{ $ne: 'deleted' }`，页签计数若把已删除算进去，
 * 数字就会和列表实际条数对不上。
 */
// 🔴 注意：这个函数体里原本有一个 `.filter((t) => …)` 的**局部参数也叫 t** ⇒ 会遮蔽翻译器
//    （本项目"t 遮蔽"那一族）⇒ 局部参数改名 `tab`。
function statusTabs(counts, t = IDENTITY_T) {
  const meta = commentStatusMeta(t);
  const safe = counts && typeof counts === 'object' ? counts : {};
  const tabs = COMMENT_STATUSES.map((key) => ({
    key,
    label: meta[key].label,
    count: Number(safe[key]) || 0,
  }));
  const all = tabs
    .filter((tab) => tab.key !== 'deleted')
    .reduce((sum, tab) => sum + tab.count, 0);
  tabs.push({ key: 'all', label: t('comment.statusAll', '全部'), count: all });
  return tabs;
}

/** 正整数收敛：非法值回退默认，越界夹到 [1, cap]（和服务端的夹取方向一致） */
function toPositiveInt(value, fallback, cap) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const i = Math.floor(n);
  if (i < 1) {
    return 1;
  }
  return Math.min(i, cap);
}

/**
 * 把服务端返回（或本地缓存）的设置收敛成完整、合法的 CommentSetting：
 * 枚举非法回默认、数字夹上限、keywords 强制成字符串数组。
 * 设置表单的 initialValues 一律先过这里，免得脏数据直接灌进 antd 控件。
 */
function normalizeCommentSetting(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    provider: COMMENT_PROVIDERS.includes(src.provider)
      ? src.provider
      : DEFAULT_COMMENT_SETTING.provider,
    moderation: COMMENT_MODERATIONS.includes(src.moderation)
      ? src.moderation
      : DEFAULT_COMMENT_SETTING.moderation,
    keywords: Array.isArray(src.keywords)
      ? src.keywords.map((k) => String(k)).filter((k) => k !== '')
      : [],
    requireEmail: Boolean(src.requireEmail),
    // pendingOnLink 默认开：字段缺失时 Boolean(undefined) 会错成 false
    pendingOnLink:
      src.pendingOnLink === undefined
        ? DEFAULT_COMMENT_SETTING.pendingOnLink
        : Boolean(src.pendingOnLink),
    maxContentLength: toPositiveInt(
      src.maxContentLength,
      DEFAULT_COMMENT_SETTING.maxContentLength,
      MAX_CONTENT_LENGTH_CAP,
    ),
    rateLimitPer10Min: toPositiveInt(
      src.rateLimitPer10Min,
      DEFAULT_COMMENT_SETTING.rateLimitPer10Min,
      RATE_LIMIT_CAP,
    ),
  };
}

/**
 * 保存前校验关键词，返回给用户的错误文案；合法返回 null。
 * 上限（200 个 / 每个 30 字符）和服务端一致，提前拦下来比等 400 报错友好。
 */
function validateKeywords(keywords, t = IDENTITY_T) {
  const list = Array.isArray(keywords) ? keywords : [];
  if (list.length > MAX_KEYWORDS) {
    // 🔴 原来是"模板字符串 + 两个插值"⇒ 收成一条带 {max}/{count} 的 ICU 整句（英文语序与复数都不同）
    return t('comment.keywordsTooMany', '待审关键词最多 {max} 个，当前 {count} 个', {
      max: MAX_KEYWORDS,
      count: list.length,
    });
  }
  const tooLong = list.find((k) => String(k).length > MAX_KEYWORD_LENGTH);
  if (tooLong !== undefined) {
    return t('comment.keywordTooLong', '单个关键词不能超过 {max} 字符：「{keyword}…」', {
      max: MAX_KEYWORD_LENGTH,
      keyword: String(tooLong).slice(0, 10),
    });
  }
  return null;
}

module.exports = {
  COMMENT_STATUSES,
  COMMENT_STATUS_META,
  COMMENT_PROVIDERS,
  COMMENT_MODERATIONS,
  MAX_CONTENT_LENGTH_CAP,
  RATE_LIMIT_CAP,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  DEFAULT_COMMENT_SETTING,
  statusMeta,
  statusTabs,
  normalizeCommentSetting,
  validateKeywords,
};
