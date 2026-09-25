/**
 * Admin request / login toast helpers.
 *
 * After the session expires, umi's request error handler shows 「登录失效」.
 * Logging in again then shows 「登录成功」 while that toast (or a late 401
 * from the request that sent the user to the login page) is still visible
 * (#316). Successful re-login must clear pending errors and ignore the
 * stale unauthorized race.
 */

const SESSION_EXPIRED_MESSAGE = '登录失效';
const LOGIN_SUCCESS_MESSAGE = '登录成功！';
const FORBIDDEN_MESSAGE = '权限不足！';
const DEFAULT_ERROR_MESSAGE = '操作失败，请稍后重试！';
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

function isSessionExpiredPayload(resData, mappedMessage) {
  if (!resData || typeof resData !== 'object') {
    return false;
  }
  const status = resData.statusCode;
  const raw = resData.message;
  const mapped = mappedMessage || resData.errorMessage;
  if (status == 401 && raw === 'Unauthorized') {
    return true;
  }
  if (status == 401 && (raw === SESSION_EXPIRED_MESSAGE || mapped === SESSION_EXPIRED_MESSAGE)) {
    return true;
  }
  return false;
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
    errorMessage = SESSION_EXPIRED_MESSAGE;
  }
  if (errorMessage === 'Forbidden resource') {
    errorMessage = FORBIDDEN_MESSAGE;
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
    isSessionExpiredPayload(resData, errorMessage) &&
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

function isSessionExpiredError(error) {
  if (!error) {
    return false;
  }
  const data = error.data || error.info || {};
  const mapped = data.errorMessage || error.message;
  if (isSessionExpiredPayload(data, mapped)) {
    return true;
  }
  const httpStatus = error.response && error.response.status;
  return httpStatus == 401 && (mapped === 'Unauthorized' || mapped === SESSION_EXPIRED_MESSAGE);
}

function shouldShowRequestError(error, context = {}) {
  if (error?.request?.options?.skipErrorHandler) {
    return false;
  }
  const info = resolveErrorInfo(error, context);
  if (info.showType === SILENT_SHOW_TYPE) {
    return false;
  }
  if (isSessionExpiredError(error) && shouldSuppressSessionExpiredToast(context)) {
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
  const text = fallbackText || DEFAULT_ERROR_MESSAGE;
  if (text && messageApi && typeof messageApi.error === 'function') {
    messageApi.error(text);
  }
  return true;
}

function notifyLoginSuccess(messageApi, text = LOGIN_SUCCESS_MESSAGE, now = Date.now()) {
  markLoginSuccess(now);
  if (messageApi && typeof messageApi.destroy === 'function') {
    messageApi.destroy();
  }
  if (messageApi && typeof messageApi.success === 'function') {
    messageApi.success(text);
  }
}

module.exports = {
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
