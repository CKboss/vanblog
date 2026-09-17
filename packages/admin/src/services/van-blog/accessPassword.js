/**
 * 文章 / 分类「访问密码」表单的纯逻辑部分 —— 与 React/DOM 解耦，`node --test` 可直接 require。
 * 模式照抄 src/components/RecycleBin/recycleCore.js：刻意 CommonJS（babel 能编，裸 node 能测）。
 *
 * ## 为什么需要这个模块（服务端契约，2026-09 起）
 *
 * 访问密码以前是**明文**存在 Mongo 里的，后台表单靠"服务端把明文回传、输入框回填"来编辑。
 * 现在服务端只存 scrypt 哈希，而且**任何响应都不再下发** password（明文或哈希都不给），
 * 只给一个布尔 `hasPassword`。于是表单语义必须跟着变：
 *
 *   | 用户在密码框里 | 提交什么                                   | 服务端结果            |
 *   |----------------|--------------------------------------------|-----------------------|
 *   | 留空（编辑）   | 不带 password 键                           | **保持原样**（不是清空！）|
 *   | 留空（新建）   | 不带 password 键                           | 不加密                |
 *   | 填了新密码     | `password: '<明文>'`                       | 存 scrypt 哈希        |
 *   | 勾「清除密码」 | `clearPassword: true`（且不带 password）   | 存 `''`，解除加密     |
 *   | 又填又勾       | —— 前端先拦下来，不发请求                   | （服务端也会 400）    |
 *
 * 关键取舍：**"留空 = 不修改" 之后，清除必须是一个显式动作**。如果继续让空值兼表
 * "清空"，那么任何一次没碰密码框的保存（改标题、改分类、切隐藏开关…）都会把加密悄悄抹掉，
 * 而密码一旦丢了就**再也找不回来**（以前还能从库里读出来）。所以清除走独立开关 + 二次确认。
 *
 * 服务端唯一真源：`packages/server/src/utils/accessPassword.ts`。
 * 相关接口：PUT /api/admin/article/:id、POST /api/admin/article、
 *           POST /api/admin/draft/publish?id=、PUT /api/admin/category/:name。
 */

/** 密码一旦忘记就找不回来了 —— 这句要出现在用户真的会看到的地方 */
const PASSWORD_UNRECOVERABLE_WARNING =
  '密码以 scrypt 哈希存储，服务端也读不出来：忘记或清除之后无法找回，只能重新设置。';

const CLEAR_PASSWORD_LABEL = '清除密码';

const CLEAR_PASSWORD_TOOLTIP =
  '勾上并提交 = 解除加密（服务端把密码置空）。不勾、密码框留空 = 保持原来的密码不变。';

/** 表单字段名（与服务端 DTO 逐字一致，别改） */
const PASSWORD_FIELD = 'password';
const CLEAR_PASSWORD_FIELD = 'clearPassword';
/** 服务端下发的布尔（不是表单字段，提交前必须摘掉） */
const HAS_PASSWORD_FIELD = 'hasPassword';

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * 从服务端给的记录里读"设没设密码"。
 * 兼容三种形状：新版（只有 hasPassword）、旧版服务端（还在回传 password）、
 * 以及老分类文档（整个键都不存在 ⇒ undefined）。
 * ⚠️ 只用来算布尔，**绝不**把 password 的值填进输入框。
 */
function hasPasswordFromRecord(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  if (record[HAS_PASSWORD_FIELD] === true) {
    return true;
  }
  if (record[HAS_PASSWORD_FIELD] === false) {
    return false;
  }
  // 对着旧服务端（还没升级）时的兜底：那时响应里还有 password
  const legacy = record[PASSWORD_FIELD];
  return typeof legacy === 'string' ? legacy.length > 0 : Boolean(legacy);
}

/**
 * 把服务端记录整理成可以安全喂给 antd 表单的初始值：
 * password / hasPassword / clearPassword 三个键一律摘掉 —— 输入框必须永远是空的，
 * 否则"留空 = 不修改"这条语义就会被回填值破坏（用户以为自己在改，其实只是把旧值又发了一遍）。
 */
function sanitizeRecordForForm(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === PASSWORD_FIELD || key === HAS_PASSWORD_FIELD || key === CLEAR_PASSWORD_FIELD) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 密码框的 placeholder：把"留空是什么后果"写在用户看得见的地方 */
function passwordPlaceholder({ hasPassword = false, isCreate = false } = {}) {
  if (isCreate) {
    return '留空表示不加密';
  }
  return hasPassword ? '已设置密码，留空表示不修改' : '留空表示不加密';
}

/** 密码框下方的常驻说明（extra）：语义 + 不可找回的警告 */
function passwordHelp({ hasPassword = false, isCreate = false } = {}) {
  const semantic = isCreate
    ? '留空 = 不加密；填了 = 用这个密码加密。'
    : hasPassword
    ? '这篇/这个分类已经设过密码。留空 = 保持原密码不变；填新值 = 改成新密码；要解除加密请勾选「清除密码」。'
    : '留空 = 不加密；填了 = 用这个密码加密。';
  return `${semantic}${PASSWORD_UNRECOVERABLE_WARNING}`;
}

/** 「清除密码」开关只在"确实设过密码"且不是新建时出现 */
function shouldShowClearOption({ hasPassword = false, isCreate = false } = {}) {
  return Boolean(hasPassword) && !isCreate;
}

/**
 * 由表单值算出"这次提交要给服务端哪些键"。
 *
 * @returns {{patch: object, error: string|null}}
 *  - `error` 非空 ⇒ 不要发请求，直接把这句话给用户看；
 *  - `patch` 是要 merge 进提交体的键（可能是 `{}`，即"不带任何密码相关的键"）。
 */
function buildAccessPasswordPatch({
  password,
  clearRequested = false,
  hasPassword = false,
  isCreate = false,
  isPrivate = undefined,
} = {}) {
  const blank = isBlank(password);
  const clear = clearRequested === true || clearRequested === 'true';

  if (clear && !blank) {
    return {
      patch: {},
      error: '不能同时「填写新密码」和「清除密码」：要换密码就只填新密码，要解除加密就只勾清除。',
    };
  }
  if (clear) {
    // 只有"确实设过密码"才允许清除；新建时勾它没有意义（本来就是空的），
    // 而且服务端会把它当成"写入空串"——一样是 no-op，但别让用户以为做了什么
    if (!isCreate && !hasPassword) {
      return { patch: {}, error: '这篇/这个分类本来就没有设置密码，无需清除。' };
    }
    return { patch: { [CLEAR_PASSWORD_FIELD]: true }, error: null };
  }
  if (!blank) {
    return { patch: { [PASSWORD_FIELD]: String(password) }, error: null };
  }
  // 留空
  if (isPrivate === true && (isCreate || !hasPassword)) {
    // 选了"加密"却没有任何密码可用：以前服务端会存一个空密码，
    // 结果是"标记为加密但没有密码"—— 谁填什么都能进（或谁都进不去，取决于版本）。
    // 现在直接在表单里拦下来。
    return { patch: {}, error: '如若加密，请填写密码！' };
  }
  return { patch: {}, error: null };
}

/**
 * 组装最终提交体：先把表单里的 password / hasPassword / clearPassword 三个键**全部摘掉**，
 * 再 merge buildAccessPasswordPatch() 算出来的那几个。
 * 这样即使 antd 的 store 里残留了 initialValues 带进来的服务端字段，也不可能被回传。
 */
function buildSubmitValues(values, accessPatch) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (key === PASSWORD_FIELD || key === HAS_PASSWORD_FIELD || key === CLEAR_PASSWORD_FIELD) {
      continue;
    }
    out[key] = value;
  }
  return Object.assign(out, accessPatch || {});
}

/** 二次确认的文案（清除密码是**不可撤销**的，必须让用户在读完之后再点一次） */
function clearConfirmTitle(targetLabel) {
  return `确定清除${targetLabel || ''}的访问密码吗？`;
}

function clearConfirmContent(targetLabel) {
  return (
    `这会解除${targetLabel || '它'}的加密，任何人都能看到内容。` +
    '密码是哈希存储的，清除之后**无法恢复**原来的密码；' +
    '如果只是想换一个密码，请不要勾选清除，直接在密码框里填新密码。'
  );
}

/** 「加密」列/字段旁边的提示：取消加密**不会**删掉已设置的密码 */
const PRIVATE_TOGGLE_HINT =
  '取消加密不会删除已设置的密码（要删除请用「清除密码」）；重新打开加密时会继续沿用原密码。';

module.exports = {
  PASSWORD_UNRECOVERABLE_WARNING,
  CLEAR_PASSWORD_LABEL,
  CLEAR_PASSWORD_TOOLTIP,
  PASSWORD_FIELD,
  CLEAR_PASSWORD_FIELD,
  HAS_PASSWORD_FIELD,
  PRIVATE_TOGGLE_HINT,
  isBlank,
  hasPasswordFromRecord,
  sanitizeRecordForForm,
  passwordPlaceholder,
  passwordHelp,
  shouldShowClearOption,
  buildAccessPasswordPatch,
  buildSubmitValues,
  clearConfirmTitle,
  clearConfirmContent,
};
