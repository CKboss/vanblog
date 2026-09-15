import convert from 'ansi-to-html';

/**
 * ⚠️ `escapeXML` 必须显式打开：ansi-to-html 的默认值是 **false**，
 * 也就是日志里的 `<`、`>`、`&` 会**原样当成 HTML** 输出，
 * 而本组件是用 `dangerouslySetInnerHTML` 渲染的 —— 只要有一行日志里带上了
 * 访问者能控制的字符串（404 的路径、上传文件名、评论作者、子进程输出里的 URL……），
 * 就是一条**存到后台的 XSS**：谁打开「日志管理 → 系统日志」谁中招，
 * 而后台 token 就放在 localStorage 里，等于直接把管理员会话交出去。
 *
 * 打开之后 ANSI 颜色照常渲染（这正是这个库的用途），只是尖括号变成实体。
 */
const ansiToHtml = new convert({ escapeXML: true });
export default function ({ content }: { content: string }) {
  return (
    <code
      dangerouslySetInnerHTML={{
        __html: content
          .split('\n')
          .map((s) => ansiToHtml.toHtml(s))
          .join('<br/>'),
      }}
    />
  );
}
