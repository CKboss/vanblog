import { writeClipBoardText } from '@/services/van-blog/clipboard';
import { message } from 'antd';
import { getImgLink } from '../img/tools';

/**
 * 附件链接规则和图片一致：相对路径补上当前站点 host，并转义圆括号，
 * 免得粘进 Markdown 后把 `[名字](url)` 结构破坏掉。
 */
export const getAttachmentLink = (realPath: string, autoCompleteHost = true) =>
  getImgLink(realPath, autoCompleteHost);

export const copyAttachmentLink = (
  realPath: string,
  isMarkdown = false,
  displayName?: string,
  info?: string,
  autoCompleteHost = true,
) => {
  const url = getAttachmentLink(realPath, autoCompleteHost);
  const text = isMarkdown ? `[${displayName || '附件'}](${url})` : url;
  writeClipBoardText(text).then((res) => {
    if (res) {
      message.success(`${info || ''}已复制${isMarkdown ? ' Markdown ' : '附件'}链接到剪切板！`);
    } else {
      message.error(`${info || ''}复制链接到剪切板失败！`);
    }
  });
};

export const downloadAttachment = (name: string, url: string) => {
  const tag = document.createElement('a');
  tag.setAttribute('download', name);
  tag.href = getAttachmentLink(url);
  tag.dispatchEvent(new MouseEvent('click'));
};
