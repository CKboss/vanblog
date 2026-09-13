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

function mapAdminErrorMessage(resData) {
  let errorMessage = resData?.message;
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
  const errorMessage = mapAdminErrorMessage(resData);
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
  const { message: messageApi, pathname, now } = deps;
  if (error?.request?.options?.skipErrorHandler) {
    throw error;
  }
  const context = { pathname, now };
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
  markLoginSuccess,
  resetRequestErrorState,
  hasJustLoggedIn,
  isAdminLoginPath,
  isSessionExpiredPayload,
  isSessionExpiredError,
  shouldSuppressSessionExpiredToast,
  shouldShowRequestError,
  adaptAdminResponse,
  handleAdminRequestError,
  reportRequestError,
  notifyLoginSuccess,
};
