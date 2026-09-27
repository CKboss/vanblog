import { Button, message, notification } from 'antd';
import { getIntl, getLocale } from 'umi';
/**
 * 🔴 期 6 第十二批：**非组件作用域**的翻译器（懒取）。
 *
 * 这个文件里的 `getInitialState()` / `layout()` / `rightContentRender` 都是 umi 的**运行时配置函数**，
 * 不是 React 组件 ⇒ 🔴 在里面调 `useIntl()` 会违反 hooks 规则（而且会崩）。
 * 但 🔴 也不能在**模块加载期**调 `getIntl()`：那时 umi 的 locale 插件运行时还没初始化，会拿到 undefined
 * （`Static/img/tools.tsx` 的注释里记着这条实测）。
 * ⇒ 所以做成"每次调用时才取 intl"的懒函数：调用时机都在运行时（请求回来后 / 渲染右侧内容时）。
 * ⚠️ `Modal.*` / `message.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 只能传**算好的字符串**。
 */
const rt = (id, defaultMessage, values) => {
  const intl = getIntl(getLocale());
  return intl ? intl.formatMessage({ id, defaultMessage }, values) : defaultMessage;
};

import defaultSettings from '../config/defaultSettings';
const { pwa } = defaultSettings;
const isHttps = document.location.protocol === 'https:';

const clearCache = () => {
  // remove all caches
  if (window.caches) {
    caches
      .keys()
      .then((keys) => {
        keys.forEach((key) => {
          caches.delete(key);
        });
      })
      .catch((e) => console.log(e));
  }
}; // if pwa is true

if (pwa) {
  // Notify user if offline now
  window.addEventListener('sw.offline', () => {
    // 🔴 这两处都在**模块作用域的事件回调**里（`window.addEventListener` / 更新提示），
    //    不是 React 组件 ⇒ 用懒取的翻译器：调用时才 `getIntl(getLocale())`
    //    （模块加载期取会拿到 undefined，umi 的 locale 运行时还没初始化）。
    message.warning(rt('global.offlineWarning', '当前处于离线状态'));
  }); // Pop up a prompt on the page asking the user if they want to use the latest version

  window.addEventListener('sw.updated', (event) => {
    const e = event;

    const reloadSW = async () => {
      // Check if there is sw whose state is waiting in ServiceWorkerRegistration
      // https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration
      const worker = e.detail && e.detail.waiting;

      if (!worker) {
        return true;
      } // Send skip-waiting event to waiting SW with MessageChannel

      await new Promise((resolve, reject) => {
        const channel = new MessageChannel();

        channel.port1.onmessage = (msgEvent) => {
          if (msgEvent.data.error) {
            reject(msgEvent.data.error);
          } else {
            resolve(msgEvent.data);
          }
        };

        worker.postMessage(
          {
            type: 'skip-waiting',
          },
          [channel.port2],
        );
      });
      clearCache();
      window.location.reload();
      return true;
    };

    const key = `open${Date.now()}`;
    const btn = (
      <Button
        type="primary"
        onClick={() => {
          notification.close(key);
          reloadSW();
        }}
      >
        {rt('recycle.refresh', '刷新')}
      </Button>
    );
    notification.open({
      message: rt('global.newContentTitle', '有新内容'),
      description: rt('global.newContentBody', '请点击“刷新”按钮或者手动刷新页面'),
      btn,
      key,
      onClose: async () => null,
    });
  });
} else if ('serviceWorker' in navigator && isHttps) {
  // unregister service worker
  const { serviceWorker } = navigator;

  if (serviceWorker.getRegistrations) {
    serviceWorker.getRegistrations().then((sws) => {
      sws.forEach((sw) => {
        sw.unregister();
      });
    });
  }

  serviceWorker.getRegistration().then((sw) => {
    if (sw) sw.unregister();
  });
  clearCache();
}
