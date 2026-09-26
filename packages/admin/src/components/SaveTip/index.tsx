import { isMac, isMobileByScreenSize } from '@/services/van-blog/ua';
import { useCallback, useMemo } from 'react';
import { useIntl } from 'umi';

/**
 * 编辑器页头那个「保存 Ctrl + S」提示。
 *
 * 🔴 多语言（期 6 第四批）：快捷键本身（`⌘ + S` / `Ctrl + S`）**不翻译**（那是按键名），
 *    只有前面那个动词跟着语言走 ⇒ 用一条带 `{shortcut}` 占位符的整句，而不是三段各写一遍。
 * 🔴 t 必须**稳定**（useCallback([intl])）并且进 useMemo 的依赖数组：
 *    这个组件的文案就是在 useMemo 里算的，漏了依赖 ⇒ 切语言后仍显示旧译文（§7.144 B）。
 */
export const SaveTip = () => {
  const intl = useIntl();
  const t = useCallback(
    (id: string, defaultMessage: string, values?: Record<string, any>) =>
      intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const text = useMemo(() => {
    if (isMobileByScreenSize()) {
      return t('editor.save', '保存');
    }
    return t('editor.saveShortcut', '保存 {shortcut}', { shortcut: isMac() ? '⌘ + S' : 'Ctrl + S' });
  }, [t]);
  return <span>{text}</span>;
};
