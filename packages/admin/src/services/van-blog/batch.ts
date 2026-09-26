import { checkDemo } from './check';
import { parseObjToMarkdown } from './parseMarkdownFile';
import { getArticleById, deleteArticle, deleteDraft, getDraftById } from './api';
import { Modal } from 'antd';

/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / recycleCore.js / Static/img/tools.tsx 同一套模式）。
 * 本模块是纯逻辑（还被 `node --test` 直接 require 的那类），模块加载期拿不到 umi 运行时 ⇒
 * 翻译器由调用方（文章页 / 草稿页的组件）在渲染期注入。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**。
 */
function interpolate(template: any, values?: Record<string, any>) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
export const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  interpolate(defaultMessage, values);

// 批量操作
export const batchDelete = (
  ids: string[],
  isDraft = false,
  t: (id: string, defaultMessage: string, values?: Record<string, any>) => string = IDENTITY_T,
) => {
  return new Promise((resolve, reject) => {
    const result = checkDemo();
    if (!result) {
      reject();
      return;
    }
    Modal.confirm({
      title: t('common.batchDeleteConfirmTitle', '确定要删除选中内容吗？'),
      content: t('common.batchDeleteConfirmContent', '删除后无法恢复'),
      onOk: async () => {
        // 旧实现用 fn(id).finally() 计数：**失败也会 +1**，最后照样 resolve(true)，
        // 于是 token 过期 / 服务端 500 / 演示站拦截时，界面同时弹「登录失效」和
        // 「批量删除成功！」，而列表刷新后一条都没少。空选择还永远不 settle（转圈卡死）。
        if (!ids.length) {
          resolve(false);
          return;
        }
        const fn = isDraft ? deleteDraft : deleteArticle;
        const settled = await Promise.allSettled(ids.map((id) => fn(id)));
        const failed = settled.filter((r) => r.status === 'rejected').length;
        if (failed) {
          reject(
            new Error(
              t('common.batchDeleteFailed', '{failed} / {total} 条删除失败', {
                failed,
                total: ids.length,
              }),
            ),
          );
          return;
        }
        resolve(true);
      },
    });
  });
};

export const batchExport = async (ids: string[], isDraft = false) => {
  for (const id of ids) {
    await exportEachById(id, isDraft);
  }
};

export const exportEachById = async (id: string, isDraft = false) => {
  const fn = isDraft ? getDraftById : getArticleById;
  // 以前这里写死了 getArticleById，草稿批量导出实际去请求文章接口，导不出东西
  const { data: obj } = await fn(id);
  const md = parseObjToMarkdown(obj);
  const data = new Blob([md]);
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${obj.title}.md`;
  link.click();
};
