const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  SESSION_EXPIRED_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  FORBIDDEN_MESSAGE,
  SILENT_SHOW_TYPE,
  adaptAdminResponse,
  handleAdminRequestError,
  hasJustLoggedIn,
  isAdminLoginPath,
  isSessionExpiredError,
  isSessionExpiredPayload,
  markLoginSuccess,
  notifyLoginSuccess,
  resetRequestErrorState,
  shouldShowRequestError,
  shouldSuppressSessionExpiredToast,
} = require('../../src/services/van-blog/requestError');

function expiredError(extras = {}) {
  return {
    name: 'ResponseError',
    message: 'Unauthorized',
    data: { statusCode: 401, message: 'Unauthorized' },
    response: { status: 401 },
    ...extras,
  };
}

function createMessageApi() {
  const calls = [];
  return {
    calls,
    error(text) {
      calls.push({ type: 'error', text });
    },
    success(text) {
      calls.push({ type: 'success', text });
    },
    destroy() {
      calls.push({ type: 'destroy' });
    },
  };
}

describe('admin request error toasts (#316)', () => {
  beforeEach(() => {
    resetRequestErrorState();
  });

  it('maps JWT Unauthorized to 登录失效 and Forbidden resource to 权限不足', () => {
    assert.deepEqual(adaptAdminResponse({ statusCode: 401, message: 'Unauthorized' }), {
      statusCode: 401,
      message: 'Unauthorized',
      success: false,
      errorMessage: SESSION_EXPIRED_MESSAGE,
    });
    assert.equal(
      adaptAdminResponse({ statusCode: 403, message: 'Forbidden resource' }).errorMessage,
      FORBIDDEN_MESSAGE,
    );
    assert.equal(adaptAdminResponse({ statusCode: 200, data: {} }).success, true);
    assert.equal(adaptAdminResponse({ statusCode: 233, data: {} }).success, true);
  });

  it('still surfaces wrong-password 401 so login failures are visible', () => {
    const res = adaptAdminResponse({
      statusCode: 401,
      message: '用户名或密码错误！',
    });
    assert.equal(res.success, false);
    assert.equal(res.errorMessage, '用户名或密码错误！');
    assert.equal(res.showType, undefined);
    assert.equal(isSessionExpiredPayload({ statusCode: 401, message: '用户名或密码错误！' }), false);
    assert.equal(
      shouldShowRequestError({
        data: { statusCode: 401, message: '用户名或密码错误！' },
      }),
      true,
    );
  });

  it('treats /user/login and /admin/user/login as the admin login page', () => {
    assert.equal(isAdminLoginPath('/user/login'), true);
    assert.equal(isAdminLoginPath('/admin/user/login'), true);
    assert.equal(isAdminLoginPath('/admin/user/login?redirect=/article'), true);
    assert.equal(isAdminLoginPath('/article'), false);
    assert.equal(isAdminLoginPath('/user/restore'), false);
  });

  it('silences session-expired toasts on the login page and shortly after re-login', () => {
    const expired = { statusCode: 401, message: 'Unauthorized' };
    assert.equal(shouldSuppressSessionExpiredToast({ pathname: '/article' }), false);
    assert.equal(shouldSuppressSessionExpiredToast({ pathname: '/user/login' }), true);

    const onArticle = adaptAdminResponse(expired, { pathname: '/article' });
    assert.equal(onArticle.errorMessage, SESSION_EXPIRED_MESSAGE);
    assert.equal(onArticle.showType, undefined);

    const onLogin = adaptAdminResponse(expired, { pathname: '/user/login' });
    assert.equal(onLogin.showType, SILENT_SHOW_TYPE);

    markLoginSuccess(1_000);
    assert.equal(hasJustLoggedIn(1_100), true);
    assert.equal(shouldSuppressSessionExpiredToast({ pathname: '/article', now: 1_100 }), true);
    assert.equal(
      adaptAdminResponse(expired, { pathname: '/article', now: 1_100 }).showType,
      SILENT_SHOW_TYPE,
    );
    assert.equal(shouldSuppressSessionExpiredToast({ pathname: '/article', now: 8_000 }), false);
  });

  it('does not show a failure toast for a stale 401 after successful login', () => {
    const stale = expiredError();
    assert.equal(shouldShowRequestError(stale, { pathname: '/article' }), true);
    assert.equal(isSessionExpiredError(stale), true);

    markLoginSuccess(5_000);
    assert.equal(shouldShowRequestError(stale, { pathname: '/article', now: 5_200 }), false);
    assert.equal(shouldShowRequestError(stale, { pathname: '/user/login', now: 20_000 }), false);

    const skipped = expiredError({
      request: { options: { skipErrorHandler: true } },
    });
    assert.equal(shouldShowRequestError(skipped, { pathname: '/article' }), false);
  });

  it('notifyLoginSuccess clears pending errors before showing only success', () => {
    const api = createMessageApi();
    api.error(SESSION_EXPIRED_MESSAGE);

    notifyLoginSuccess(api, LOGIN_SUCCESS_MESSAGE, 9_000);

    assert.deepEqual(api.calls, [
      { type: 'error', text: SESSION_EXPIRED_MESSAGE },
      { type: 'destroy' },
      { type: 'success', text: LOGIN_SUCCESS_MESSAGE },
    ]);
    assert.equal(hasJustLoggedIn(9_100), true);
    assert.equal(
      api.calls.some((row) => row.type === 'error' && row.type === 'success'),
      false,
    );
    const visibleAfter = api.calls.filter((row, idx, all) => {
      const destroyedAt = all.findIndex((item) => item.type === 'destroy');
      return idx > destroyedAt && (row.type === 'error' || row.type === 'success');
    });
    assert.deepEqual(visibleAfter, [{ type: 'success', text: LOGIN_SUCCESS_MESSAGE }]);
  });

  it('handleAdminRequestError swallows the expired-request race after re-login', () => {
    const api = createMessageApi();
    markLoginSuccess(2_000);

    assert.throws(
      () =>
        handleAdminRequestError(expiredError(), {
          message: api,
          pathname: '/article',
          now: 2_100,
        }),
      (err) => err.data && err.data.message === 'Unauthorized',
    );
    assert.deepEqual(api.calls, []);

    resetRequestErrorState();
    assert.throws(
      () =>
        handleAdminRequestError(expiredError(), {
          message: api,
          pathname: '/article',
          now: 2_100,
        }),
      (err) => err.data && err.data.message === 'Unauthorized',
    );
    assert.deepEqual(api.calls, [{ type: 'error', text: SESSION_EXPIRED_MESSAGE }]);
  });

  it('🔴 登录页必须**显式**把译文传给 notifyLoginSuccess（默认值是 identity，英文下会永远中文）', () => {
    // ## 为什么要有这条（2026-09-26 期 7 第五批，变异对照 B25-M3 打不红 ⇒ 当场补的）
    // `notifyLoginSuccess(messageApi, text, now, t)` 的 `text` 不传就落到 identity 视图（中文）。
    // 把登录页那句显式译文删掉，**所有测试照旧全绿**（棘轮也不会红：中文在**服务层**、不在登录页），
    // 只有活体切到 en-US 才看得见 —— 而这条 toast 是用户登录成功那一刻唯一看到的一句话。
    // ⚠️ 本文件没有 readSrc 这个 helper（第一版凭记忆用了它 ⇒ ReferenceError）⇒ 用与既有断言同一套写法
    const read = (rel) => readFileSync(path.join(__dirname, '../../', rel), 'utf8');
    const loginSrc = read('src/pages/user/Login/index.jsx');
    assert.match(
      loginSrc,
      /notifyLoginSuccess\(message, t\('request\.loginSuccess', '登录成功！'\)\)/,
      '🔴 登录页必须显式传 t(...) 的译文；改回 notifyLoginSuccess(message) 会让英文/繁中用户看到简体中文',
    );
    // 🔴 反向：服务层那个默认值必须仍然是 identity（老调用点行为不变），且函数自己收 t
    assert.match(
      read('src/services/van-blog/requestError.js'),
      /function notifyLoginSuccess\(messageApi, text, now = Date\.now\(\), t = IDENTITY_T\)/,
    );
    // ⚠️ 本文件顶部是**解构**引入的（没有 `re` 这个命名空间对象）⇒ 这里就地 require 一次整个模块
    const mod = require('../../src/services/van-blog/requestError.js');
    const calls = [];
    mod.notifyLoginSuccess({ success: (x) => calls.push(x), destroy() {} }, undefined, Date.now());
    assert.deepEqual(calls, ['登录成功！'], '不传 text/t ⇒ 逐字仍是中文（identity）');
    const calls2 = [];
    mod.notifyLoginSuccess({ success: (x) => calls2.push(x), destroy() {} }, undefined, Date.now(), (id) => `#${id}`);
    assert.deepEqual(calls2, ['#request.loginSuccess'], '传了 t ⇒ 走译文');
  });

  it('login page and request config use the helper so success cannot stack with 登录失效', () => {
    const loginSrc = readFileSync(
      path.join(__dirname, '../../src/pages/user/Login/index.jsx'),
      'utf8',
    );
    const appSrc = readFileSync(path.join(__dirname, '../../src/app.jsx'), 'utf8');
    assert.match(loginSrc, /notifyLoginSuccess/);
    assert.match(loginSrc, /requestError/);
    assert.doesNotMatch(loginSrc, /message\.success\(defaultLoginSuccessMessage\)/);
    assert.match(appSrc, /adaptAdminResponse/);
    assert.match(appSrc, /handleAdminRequestError/);
    assert.match(appSrc, /requestError/);
  });
});
