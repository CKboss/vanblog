/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是服务层/工具模块，拿不到 hook
 * ⇒ 由调用方在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type InjectedT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

import { writeClipBoardText } from '@/services/van-blog/clipboard';
import { message } from 'antd';
import { getImgLink } from '../img/tools';

/**
 * 附件链接规则和图片一致：相对路径补上当前站点 host，并转义圆括号，
 * 免得粘进 Markdown 后把 `[名字](url)` 结构破坏掉。
 */
export const getAttachmentLink = (realPath: string, autoCompleteHost = true) =>
  getImgLink(realPath, autoCompleteHost);

// 🔴 翻译器是**第 6 个**参数（既有调用方不传 ⇒ 落到 IDENTITY_T ⇒ 逐字与改造前相同）。
//    🔴 原来那两句是"模板字符串 + 三元 + 前缀"拼出来的 ⇒ 收成两条独立的 ICU 整句
//    （英文语序与冠词都不同，拼接必出接缝：§7.152 B / §7.171 B / §7.172 A）。
export const copyAttachmentLink = (
  realPath: string,
  isMarkdown = false,
  displayName?: string,
  info?: string,
  autoCompleteHost = true,
  t: InjectedT = IDENTITY_T,
) => {
  const url = getAttachmentLink(realPath, autoCompleteHost);
  const text = isMarkdown
    ? `[${displayName || t('file.attachmentFallbackName', '附件')}](${url})`
    : url;
  writeClipBoardText(text).then((res) => {
    if (res) {
      message.success(
        isMarkdown
          ? t('file.copiedMarkdownLink', '{prefix}已复制 Markdown 链接到剪切板！', { prefix: info || '' })
          : t('file.copiedAttachmentLink', '{prefix}已复制附件链接到剪切板！', { prefix: info || '' }),
      );
    } else {
      message.error(t('file.copyLinkFailed', '{prefix}复制链接到剪切板失败！', { prefix: info || '' }));
    }
  });
};

export const downloadAttachment = (name: string, url: string) => {
  const tag = document.createElement('a');
  tag.setAttribute('download', name);
  tag.href = getAttachmentLink(url);
  tag.dispatchEvent(new MouseEvent('click'));
};
