import { useEffect } from 'react';

/**
 * 与 packages/website/utils/appleFont.ts 保持一致（两个包不共享构建产物，改一处要改两处）。
 * 设成 null 就不会注入任何远程样式表 —— 这是自托管字体的入口。
 */
export const APPLE_FONT_CSS_URL: string | null =
  'https://static.zeoseven.com/zsft/442/main/result.css';

export const APPLE_FONT_PRECONNECT_HOSTS = [
  'https://static.zeoseven.com',
  'https://cdn.jsdelivr.net',
];

const LINK_ID = 'vanblog-apple-font-css';
const PRECONNECT_PREFIX = 'vanblog-apple-font-preconnect-';

/**
 * 给后台预览注入 Apple 皮肤用的中文字体样式表。
 *
 * ⚠️ 必须**非阻塞**：普通 `<link rel="stylesheet">` 是渲染阻塞的，而这个域名在部分网络下
 * DNS 解析不了（实测有机器上 `static.zeoseven.com` 不可解析，而 zeoseven.com 是通的），
 * 阻塞加载会把后台页面拖成白屏直到超时。所以用 `media="print"` 让浏览器低优先级取、
 * 不阻塞渲染，加载完（或兜底定时器到点）再把 media 改成 `all`。
 *
 * 后台是 umi + React 17，直接操作 DOM 即可（不像前台那样要绕 next/head 的 props 丢失问题）。
 * 用模块级引用计数，多个编辑器实例/反复进出页面也只注入一份。
 */
let refCount = 0;

function flipToAll() {
  if (typeof document === 'undefined') {
    return;
  }
  const link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (link && link.media !== 'all') {
    link.media = 'all';
  }
}

export function ensureAppleFontLink(): () => void {
  if (typeof document === 'undefined' || !APPLE_FONT_CSS_URL) {
    return () => undefined;
  }
  refCount += 1;

  const head = document.head;
  APPLE_FONT_PRECONNECT_HOSTS.forEach((host, index) => {
    const id = `${PRECONNECT_PREFIX}${index}`;
    if (document.getElementById(id)) {
      return;
    }
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'preconnect';
    link.href = host;
    link.crossOrigin = 'anonymous';
    head.appendChild(link);
  });

  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = APPLE_FONT_CSS_URL;
    // 先以 print 身份加载：不阻塞渲染
    link.media = 'print';
    link.addEventListener('load', flipToAll);
    // 域名不可达时 load 永远不触发，那就一直停在 print（= 用兜底字体），不影响可用性；
    // 这里再补一个 error 监听，纯粹为了把无效节点摘掉，别让它挂在 head 里
    link.addEventListener('error', () => {
      const node = document.getElementById(LINK_ID);
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    head.appendChild(link);
    // 命中缓存时 load 可能已经错过，兜底再翻一次
    setTimeout(flipToAll, 1500);
  }

  return () => {
    refCount -= 1;
    if (refCount > 0) {
      return;
    }
    // 最后一个使用者卸载时才摘掉，避免频繁进出编辑器反复插拔
    const node = document.getElementById(LINK_ID);
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
    APPLE_FONT_PRECONNECT_HOSTS.forEach((_host, index) => {
      const pre = document.getElementById(`${PRECONNECT_PREFIX}${index}`);
      if (pre && pre.parentNode) {
        pre.parentNode.removeChild(pre);
      }
    });
  };
}

/** 皮肤是 Apple 风格时才注入；关闭或改成默认皮肤时会自动清理 */
export default function useApplePreviewFont(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return ensureAppleFontLink();
  }, [enabled]);
}
