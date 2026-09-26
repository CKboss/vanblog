import { message } from 'antd';

/**
 * 🔴 多语言：尾参 `t = IDENTITY_T`（注入式翻译器）⇒ 不传 t 时输出与改造前逐字相同。
 * ⚠️ `message.*` 渲染进**脱离 React 树的独立根**（§7.151）⇒ 这里的文案只能是**调用期算好的字符串**，
 *    不能塞一个用 `useIntl()` 的组件进去。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

export { IDENTITY_T };

export const checkDemo = (t: any = IDENTITY_T) => {
  if (location.hostname == 'blog-demo.mereith.com') {
    message.warn(t('common.demoForbidden', '演示站禁止此操作！'));
    return false;
  }
  return true;
};
