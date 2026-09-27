/**
 * Admin copy for Waline comment-notification SMTP fields (#342).
 *
 * VanBlog already maps these to Waline env (SMTP_*, AUTHOR_EMAIL, SENDER_*).
 * The gap is discoverability: users with a custom-domain mailbox need to
 * know which field is the inbox vs the From address, and that SMTP 密码
 * is usually an app password / 授权码.
 */

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是模块级常量（不是组件），拿不到 hook
 * ⇒ 由消费方在渲染期把 t 传进来；🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**。
 * ⚠️ 下面那些大写常量是**identity 视图**（只为既有测试与还没接 i18n 的消费方保留）；
 *    🔴 已接 i18n 的消费方**必须**改用函数版并传 t，否则文案永远中文（localePackParity 有判据盯着）。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

const walineAdminPath = (t = IDENTITY_T) => t('waline.adminPath', '站点管理 / 系统设置 / 评论设置');

/** identity 视图（`walineEmailFields.test.js` 钉着它的中文措辞）；已接 i18n 的要调 `walineAdminPath(t)` */
const WALINE_ADMIN_PATH = walineAdminPath();

const WALINE_NOTIFICATION_DOCS_URL = 'https://waline.js.org/guide/features/notification.html';

const WALINE_SERVER_ENV_DOCS_URL = 'https://waline.js.org/reference/server/env.html';

const walineEmailFields = (t = IDENTITY_T) => Object.freeze({
  smtpEnabled: Object.freeze({
    name: 'smtp.enabled',
    label: t('waline.smtpEnabledLabel', '是否启用邮件通知'),
    tooltip:
      t('waline.smtpEnabledTooltip', '启用后，新评论会发到「博主邮箱」；访客被回复时会发到其填写的邮箱。换成自定义域名邮箱时，也在本表单改 SMTP / 发件地址，不用另外部署邮件服务。'),
    placeholder: t('waline.smtpEnabledPlaceholder', '默认关闭'),
  }),
  smtpHost: Object.freeze({
    name: 'smtp.host',
    label: t('waline.smtpHostLabel', 'SMTP 地址(host)'),
    tooltip:
      t('waline.smtpHostTooltip', '邮箱服务商的 SMTP 服务器（如 smtp.example.com），不是博客域名。自定义域名邮箱请到服务商后台查看，常见还有 smtp.exmail.qq.com、smtp.gmail.com。'),
    placeholder: t('waline.smtpHostPlaceholder', '例如 smtp.exmail.qq.com 或 smtp.example.com'),
  }),
  smtpPort: Object.freeze({
    name: 'smtp.port',
    label: t('waline.smtpPortLabel', 'SMTP 端口号'),
    tooltip: t('waline.smtpPortTooltip', '常见为 465（SSL）或 587（STARTTLS），以邮箱服务商说明为准。'),
    placeholder: t('waline.smtpPortPlaceholder', '例如 465 或 587'),
  }),
  smtpUser: Object.freeze({
    name: 'smtp.user',
    label: t('waline.smtpUserLabel', 'SMTP 用户名'),
    tooltip:
      t('waline.smtpUserTooltip', 'SMTP 登录账号。自定义域名邮箱一般填完整邮箱，例如 noreply@yourdomain.com。'),
    placeholder: t('waline.exampleEmailPlaceholder', '例如 noreply@yourdomain.com'),
  }),
  smtpPassword: Object.freeze({
    name: 'smtp.password',
    label: t('waline.smtpPasswordLabel', 'SMTP 密码（授权码）'),
    tooltip:
      t('waline.smtpPasswordTooltip', '多数服务商不是登录密码，而是 SMTP 授权码 / 应用专用密码（App Password）。Gmail、QQ、企业邮和多数自定义域名邮箱都要先在邮箱后台开启 SMTP 并生成授权码。'),
    placeholder: t('waline.smtpPasswordPlaceholder', '请输入 SMTP 授权码或应用专用密码'),
  }),
  authorEmail: Object.freeze({
    name: 'authorEmail',
    label: t('waline.authorEmailLabel', '博主邮箱（通知收件人）'),
    tooltip:
      t('waline.authorEmailTooltip', '有新评论时通知这个地址。可填自定义域名邮箱，也可以和发件地址不同（例如用域名邮箱发信、用常用邮箱收信）。建议与你在评论里用的邮箱一致，避免自己回复时再给自己发通知。'),
    placeholder: t('waline.authorEmailPlaceholder', '新评论通知发到这个邮箱，例如 you@yourdomain.com'),
  }),
  senderName: Object.freeze({
    name: 'sender.name',
    label: t('waline.senderNameLabel', '发件人显示名称'),
    tooltip: t('waline.senderNameTooltip', '收件箱里显示的 From 名称，可填站点名。不影响 SMTP 登录账号。'),
    placeholder: t('waline.senderNamePlaceholder', '例如站点名称'),
  }),
  senderEmail: Object.freeze({
    name: 'sender.email',
    label: t('waline.senderEmailLabel', '发件地址（From）'),
    tooltip:
      t('waline.senderEmailTooltip', '通知邮件的发件邮箱。使用自定义域名邮箱时填该域名邮箱（如 noreply@yourdomain.com）。多数服务商要求与 SMTP 用户名一致，否则可能报 501 Mail from address must be same as authorization user。'),
    placeholder: t('waline.exampleEmailPlaceholder', '例如 noreply@yourdomain.com'),
  }),
});

/** identity 视图 */
const WALINE_EMAIL_FIELDS = walineEmailFields();

module.exports = {
  WALINE_ADMIN_PATH,
  WALINE_NOTIFICATION_DOCS_URL,
  WALINE_SERVER_ENV_DOCS_URL,
  WALINE_EMAIL_FIELDS,
  // 🔴 函数版（消费方在渲染期传 t）
  walineAdminPath,
  walineEmailFields,
};
