import { transferRemoteImages } from '@/services/van-blog/api';
import { message, Modal } from 'antd';
import { BytemdPlugin } from 'bytemd';

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。bytemd 插件的 action 是纯对象、在工厂里就构造好，
 * 拿不到 React 上下文 ⇒ 由 `components/Editor/index.tsx` 在渲染期把 t 传进来。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前逐字相同。
 * ⚠️ `message.*` / `Modal.*` 渲染进**脱离 React 树的独立根**（§7.151）⇒ 只能传算好的字符串。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type EditorT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

export function transferRemotePlugin(
  setLoading: (loading: boolean) => void,
  applyContent: (content: string) => void,
  t: EditorT = IDENTITY_T,
): BytemdPlugin {
  return {
    actions: [
      {
        title: t('editor.transferTitle', '外链图片转存'),
        icon,
        handler: {
          type: 'action',
          click(ctx) {
            const current = ctx.editor.getValue();
            Modal.confirm({
              title: t('editor.transferTitle', '外链图片转存'),
              content:
                t(
                  'editor.transferConfirmContent',
                  '将扫描正文中的远程图片（Markdown 与 HTML <img>），下载后存入本站图床并改写链接。已是本站 /static 或图床中的地址、相对路径和 data: 图片会跳过。失败的链接保持原样。是否继续？',
                ),
              okText: t('editor.transferStart', '开始转存'),
              cancelText: t('init.restore.confirmCancel', '取消'),
              async onOk() {
                setLoading(true);
                try {
                  const res = await transferRemoteImages({
                    content: current,
                    siteHost:
                      typeof window !== 'undefined' ? window.location.host : undefined,
                  });
                  const data = res?.data;
                  if (!data) {
                    message.error(t('editor.transferFailedNoData', '转存失败！'));
                    return;
                  }
                  if (typeof data.content === 'string' && data.content !== current) {
                    ctx.editor.setValue(data.content);
                    applyContent(data.content);
                  }
                  const transferred = data.transferred?.length || 0;
                  const skipped = data.skipped?.length || 0;
                  const failed = data.failed || [];
                  if (failed.length) {
                    // 🔴 原来是"模板字符串 + 三个插值 + 一段 join"⇒ 收成**一条带 4 个 ICU 占位符**的整句
                    //    （英文的语序与复数都跟中文不同，拼接式必然出接缝问题：§7.152 B / §7.156 B / §7.160 C / §7.162 A）
                    message.warning(
                      t('editor.transferPartial', '已转存 {transferred} 张，跳过 {skipped} 张，失败 {failed} 张：{urls}', {
                        transferred,
                        skipped,
                        failed: failed.length,
                        urls: failed.map((item) => item.url).join('、'),
                      }),
                    );
                  } else if (transferred === 0) {
                    message.info(
                      t('editor.transferNone', '没有需要转存的外链图片（跳过 {skipped} 张）', { skipped }),
                    );
                  } else {
                    message.success(
                      t('editor.transferDone', '已转存 {transferred} 张外链图片到本站图床（跳过 {skipped} 张）', {
                        transferred,
                        skipped,
                      }),
                    );
                  }
                } catch (err) {
                  message.error(t('editor.transferFailed', '外链图片转存失败！'));
                } finally {
                  setLoading(false);
                }
              },
            });
          },
        },
      },
    ],
  };
}

const icon = `<svg
viewBox="0 0 1024 1024"
version="1.1"
xmlns="http://www.w3.org/2000/svg"
width="16"
height="16"
fill="currentColor"
>
<path d="M896 640v192a64 64 0 0 1-64 64H192a64 64 0 0 1-64-64V640h64v192h640V640h64zM512 128l256 256h-160v256h-192V384H256l256-256z"></path>
</svg>`;
