export const WALINE_ADMIN_PATH: string;
export const WALINE_NOTIFICATION_DOCS_URL: string;
export const WALINE_SERVER_ENV_DOCS_URL: string;

type EmailFieldCopy = Readonly<{
  name: string;
  label: string;
  tooltip: string;
  placeholder: string;
}>;

type WalineEmailFieldsCopy = Readonly<{
  smtpEnabled: EmailFieldCopy;
  smtpHost: EmailFieldCopy;
  smtpPort: EmailFieldCopy;
  smtpUser: EmailFieldCopy;
  smtpPassword: EmailFieldCopy;
  authorEmail: EmailFieldCopy;
  senderName: EmailFieldCopy;
  senderEmail: EmailFieldCopy;
}>;

/** identity 视图（不传 t ⇒ 中文，与改造前逐字相同）。🔴 已接 i18n 的消费方请用下面的函数版。 */
export const WALINE_EMAIL_FIELDS: WalineEmailFieldsCopy;

/**
 * 🔴 多语言：**注入式翻译器**（`.js` 模块的类型权威就是这个 `.d.ts`；只在 `.js` 里写 JSDoc 类型**不生效**，
 * 本项目已在 `mobileToolbar.d.ts` 上踩过一次 —— §7.166）。
 * 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前逐字相同。
 */
export type InjectedT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;
export function walineEmailFields(t?: InjectedT): WalineEmailFieldsCopy;
export function walineAdminPath(t?: InjectedT): string;
