/**
 * Admin request / login toast helpers.
 *
 * After the session expires, umi's request error handler shows 「登录失效」.
 * Logging in again then shows 「登录成功」 while that toast (or a late 401
 * from the request that sent the user to the login page) is still visible
 * (#316). Successful re-login must clear pending errors and ignore the
 * stale unauthorized race.
 */

/**
 * 🔴 多语言（期 7 第五批）：这四条以前是**一份常量同时干两件事**，本轮把它拆开：
 *
 * ① **线路字面量**（`SERVER_SESSION_EXPIRED_TEXT`）：服务端的 `message` 字段里可能出现的那句中文。
 *    🔴 它是**协议的一部分**（与 `已初始化` / `初始化密钥` / `导出说明.md` / Caddy URL 锚点同一类），
 *    **永不翻译** —— `isSessionExpiredPayload` / `isSessionExpiredError` 靠它认 401。
 * ② **显示文案**（`sessionExpiredMessage(t)` 等四个函数）：跟着语言走，由调用方在**调用期**注入 t
 *    （`app.jsx` 的 `makeServerErrorTranslator()` 已经在 adaptor 与 errorHandler 两处注入了）。
 *
 * 🔴 为什么必须拆：只把显示文案翻译掉、比对仍拿中文常量，那么 en-US 下 `mapped`（已翻译）
 * 与 `SESSION_EXPIRED_MESSAGE`（中文）**永不相等** ⇒ 401 检测静默失效：会话过期不再弹提示、
 * 也不再抑制"刚登录却又弹一条登录失效"的竞态 —— 而且**全都不报错**（§7.163 A 预判的就是这个）。
 * ⇒ 现在比对**同时接受**线路字面量与当前语言的显示文案（见 isSessionExpiredPayload）。
 *
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**（requestError.test.js / adminRobustness.test.js
 * 的黄金样本一个字都不用改）。SCREAMING_CASE 常量保留为 identity 视图；
 * 🔴 函数体内不许再引用它们（localePackParity 有一条判据专门盯这件事）。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

/** 🔴 线路字面量：服务端 401 时 `message` 里可能就是这句中文（不是文案，是协议） */
const SERVER_SESSION_EXPIRED_TEXT = '登录失效';
/** 🔴 线路字面量：NestJS 的 403 默认短语（本来就是英文，与语言无关） */
const SERVER_FORBIDDEN_TEXT = 'Forbidden resource';

function sessionExpiredMessage(t = IDENTITY_T) {
  return t('request.sessionExpired', '登录失效');
}
const SESSION_EXPIRED_MESSAGE = sessionExpiredMessage();

function loginSuccessMessage(t = IDENTITY_T) {
  return t('request.loginSuccess', '登录成功！');
}
const LOGIN_SUCCESS_MESSAGE = loginSuccessMessage();

function forbiddenMessage(t = IDENTITY_T) {
  return t('request.forbidden', '权限不足！');
}
const FORBIDDEN_MESSAGE = forbiddenMessage();

function defaultErrorMessage(t = IDENTITY_T) {
  return t('request.defaultError', '操作失败，请稍后重试！');
}
const DEFAULT_ERROR_MESSAGE = defaultErrorMessage();
const LOGIN_SUCCESS_GRACE_MS = 5000;
const SILENT_SHOW_TYPE = 0;
/**
 * 🔴 服务端错误码 → admin i18n key 的前缀（`error.<code>`）。
 * 码的权威登记表在**服务端** `packages/server/src/utils/serverErrorCodes.ts`；
 * 三语文案在本包 `src/locales/*.ts` 的 `error.*` 下；
 * 两边由 `tests/unit/i18nServerErrorCodes.test.js` 双向对账（含"zh-CN 的值必须与服务端登记表的中文逐字相同"）。
 */
const SERVER_ERROR_KEY_PREFIX = 'error.';

let loginSuccessAt = 0;

function markLoginSuccess(now = Date.now()) {
  loginSuccessAt = now;
}

function resetRequestErrorState() {
  loginSuccessAt = 0;
}

function hasJustLoggedIn(now = Date.now()) {
  return Boolean(loginSuccessAt) && now - loginSuccessAt < LOGIN_SUCCESS_GRACE_MS;
}

function isAdminLoginPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return path === '/user/login' || path.endsWith('/user/login');
}

function getAdminPathname(pathname) {
  if (pathname) {
    return pathname;
  }
  if (typeof window !== 'undefined' && window.location && window.location.pathname) {
    return window.location.pathname;
  }
  return '';
}

function isSessionExpiredPayload(resData, mappedMessage, t = IDENTITY_T) {
  if (!resData || typeof resData !== 'object') {
    return false;
  }
  const status = resData.statusCode;
  const raw = resData.message;
  const mapped = mappedMessage || resData.errorMessage;
  // 🔴 `raw` 只跟**线路字面量**比（服务端不会因为界面语言而改口）；
  //    `mapped` 是**我们自己产的显示文案** ⇒ 要同时接受"线路字面量""identity 中文""当前语言的译文"三种，
  //    否则注入 t 之后这条判定会静默失效（§7.163 A）。
  // 🔴 而且**只在真的是 401 时才去取译文**：非 401 的响应根本不需要那句话，
  //    白取一次会往翻译器的调用记录里塞一条无关项（`i18nServerErrorCodes.test.js` 就是这么被绊红的：
  //    它按**下标**读 spy 日志 ⇒ 多一次调用就整体错位。那边也一并改成按 id 找，两边都更结实）。
  if (status != 401) {
    return false;
  }
  if (
    raw === 'Unauthorized' ||
    raw === SERVER_SESSION_EXPIRED_TEXT ||
    mapped === SERVER_SESSION_EXPIRED_TEXT
  ) {
    return true;
  }
  return mapped === sessionExpiredMessage(t);
}

function shouldSuppressSessionExpiredToast({ pathname, now = Date.now() } = {}) {
  if (isAdminLoginPath(getAdminPathname(pathname))) {
    return true;
  }
  return hasJustLoggedIn(now);
}

/**
 * 🔴 期 9（服务端错误码框架）：**有码用码、无码回落服务端的 message**。
 *
 * 为什么要"回落"而不是"必须有码"：迁移是渐进的（服务端今天还有 243 处带中文的 `throw`），
 * 🔴 任何时刻都必须是可用状态 —— 没迁移的接口照旧显示服务端那句中文，迁移过的显示当前语言的译文。
 *
 * @param {*} resData 服务端响应体（可能带 `code` 与 `params`）
 * @param {Function} [t] **注入式翻译器** `(id, defaultMessage, values) => string`。
 *   🔴 本模块是纯 JS、会被 `node --test` 直接 `require()` ⇒ 拿不到 umi 运行时，
 *   所以翻译器由调用方（`app.jsx`，在**调用期**用 `getIntl(getLocale())` 造）注入。
 *   🔴 **不传 t 时本模块的输出与改造前逐字相同**（这条由 requestError.test.js 钉住）。
 * @returns {string|undefined} 译文；没有码或没有翻译器时返回 `undefined`（表示"交回原逻辑"）
 */
function translateServerErrorMessage(resData, t) {
  const code = resData?.code;
  if (!code || typeof t !== 'function') {
    return undefined;
  }
  // 🔴 defaultMessage 用**服务端那句中文**：万一语言包漏了这个码，用户看到的仍是今天的行为（中文），
  //    而不是裸 key 或 undefined。漏译由守卫拦（不靠运行时兜底），但兜底方向必须是"退回旧行为"。
  return t(SERVER_ERROR_KEY_PREFIX + code, resData?.message, resData?.params);
}

function mapAdminErrorMessage(resData, t) {
  const translated = translateServerErrorMessage(resData, t);
  let errorMessage = translated === undefined ? resData?.message : translated;
  if (resData?.statusCode == 401 && resData?.message === 'Unauthorized') {
    errorMessage = sessionExpiredMessage(t);
  }
  if (errorMessage === SERVER_FORBIDDEN_TEXT) {
    errorMessage = forbiddenMessage(t);
  }
  return errorMessage;
}

function adaptAdminResponse(resData = {}, context = {}) {
  const statusCode = resData?.statusCode;
  const success = statusCode == 200 || statusCode == 233;
  const errorMessage = mapAdminErrorMessage(resData, context?.t);
  const result = {
    ...resData,
    success,
    errorMessage,
  };
  if (
    !success &&
    isSessionExpiredPayload(resData, errorMessage, context?.t) &&
    shouldSuppressSessionExpiredToast(context)
  ) {
    result.showType = SILENT_SHOW_TYPE;
  }
  return result;
}

function resolveErrorInfo(error, context) {
  const data = error?.data || error?.info;
  if (data && typeof data === 'object') {
    return adaptAdminResponse(data, context);
  }
  return {
    success: false,
    errorMessage: error?.message,
  };
}

function isSessionExpiredError(error, t = IDENTITY_T) {
  if (!error) {
    return false;
  }
  const data = error.data || error.info || {};
  const mapped = data.errorMessage || error.message;
  if (isSessionExpiredPayload(data, mapped, t)) {
    return true;
  }
  const httpStatus = error.response && error.response.status;
  // 🔴 同上：`mapped` 可能是线路字面量、identity 中文，或当前语言的译文 ⇒ 三种都认
  return (
    httpStatus == 401 &&
    (mapped === 'Unauthorized' ||
      mapped === SERVER_SESSION_EXPIRED_TEXT ||
      mapped === sessionExpiredMessage(t))
  );
}

function shouldShowRequestError(error, context = {}) {
  if (error?.request?.options?.skipErrorHandler) {
    return false;
  }
  const info = resolveErrorInfo(error, context);
  if (info.showType === SILENT_SHOW_TYPE) {
    return false;
  }
  if (isSessionExpiredError(error, context?.t) && shouldSuppressSessionExpiredToast(context)) {
    return false;
  }
  return Boolean(info.errorMessage || error?.message);
}

function handleAdminRequestError(error, deps = {}) {
  const { message: messageApi, pathname, now, t } = deps;
  if (error?.request?.options?.skipErrorHandler) {
    throw error;
  }
  // 🔴 `t` 一路透传到 mapAdminErrorMessage：全局 errorHandler 是服务端错误码唯一的翻译落点
  //    （业务代码里的 reportRequestError 只负责"全局没弹时兜一句本地文案"）。
  const context = { pathname, now, t };
  if (shouldShowRequestError(error, context)) {
    const info = resolveErrorInfo(error, context);
    const text = info.errorMessage || error.message;
    if (text && messageApi && typeof messageApi.error === 'function') {
      messageApi.error(text);
    }
  }
  throw error;
}

/**
 * 业务代码里 catch 到请求错误时的统一收尾提示。
 *
 * 全局 errorHandler 已经弹过服务端的具体原因（比如「路径名重复」「登录失效」）时
 * 返回 false 且不再弹，避免同一次失败叠两条 toast；只有它不会弹的情况
 * （接口带 skipErrorHandler、或者压根没有可展示的 message）才用这里的兜底文案。
 * 调用方无论如何都要在 finally 里把自己的 loading 收掉，否则页面会一直转圈。
 */
function reportRequestError(messageApi, error, fallbackText, context) {
  if (shouldShowRequestError(error, context)) {
    return false;
  }
  // 🔴 兜底文案也跟着语言走（context 里有 t 就用；没有 ⇒ identity，与今天逐字相同）
  const text = fallbackText || defaultErrorMessage(context?.t);
  if (text && messageApi && typeof messageApi.error === 'function') {
    messageApi.error(text);
  }
  return true;
}

// 🔴 默认值**不写**在签名上（那等于在函数体里引用 identity 常量 ⇒ 判据会报，而且理由正当）：
//    改成"没传 text 就在函数体里调**函数版**"⇒ 老调用点（不传 t）行为逐字不变，
//    已接 i18n 的调用方（登录页）显式传 `t('request.loginSuccess', '登录成功！')`。
function notifyLoginSuccess(messageApi, text, now = Date.now(), t = IDENTITY_T) {
  // 🔴 兜底那句也要能跟着语言走 ⇒ 这个函数自己也收 t（尾参，identity 兜底）。
  //    现在的调用方（登录页）**显式**传了译文，所以这条兜底暂时走不到；
  //    但不收 t 就等于"将来任何新调用点都必然是中文"，而且 localePackParity 会当场报出来。
  const finalText = text || loginSuccessMessage(t);
  markLoginSuccess(now);
  if (messageApi && typeof messageApi.destroy === 'function') {
    messageApi.destroy();
  }
  if (messageApi && typeof messageApi.success === 'function') {
    messageApi.success(finalText);
  }
}

module.exports = {
  IDENTITY_T,
  SERVER_SESSION_EXPIRED_TEXT,
  SERVER_FORBIDDEN_TEXT,
  sessionExpiredMessage,
  loginSuccessMessage,
  forbiddenMessage,
  defaultErrorMessage,
  SESSION_EXPIRED_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  FORBIDDEN_MESSAGE,
  DEFAULT_ERROR_MESSAGE,
  LOGIN_SUCCESS_GRACE_MS,
  SILENT_SHOW_TYPE,
  SERVER_ERROR_KEY_PREFIX,
  markLoginSuccess,
  resetRequestErrorState,
  hasJustLoggedIn,
  isAdminLoginPath,
  isSessionExpiredPayload,
  isSessionExpiredError,
  shouldSuppressSessionExpiredToast,
  shouldShowRequestError,
  translateServerErrorMessage,
  mapAdminErrorMessage,
  adaptAdminResponse,
  handleAdminRequestError,
  reportRequestError,
  notifyLoginSuccess,
};
