/**
 * 🔴 期 6 第十二批接 i18n 时踩到两个坑，都记在这里（细节见手册 §7.177）：
 * ① JSX **子元素位置**上的 `//` 不是注释，是会被渲染出来的文本；
 * ② `{/* … *\/}` 形式的注释**跨多行**时，清点器（astInventory 的 JSXText 分支）会把中间几行
 *    当成 JSX 文本数进"裸中文"⇒ 这里的 JSX 注释一律写成**单行**，长解释放文件头的块注释。
 */
import { getRecentTimeDes } from '@/services/van-blog/tool';
import { useIntl } from 'umi';
import './index.css';

export default ({
  articles,
  showViewerNum,
  showRecentViewTime,
}: {
  // FIXME: Add Article type
  articles: any[];
  showViewerNum: boolean;
  showRecentViewTime: boolean;
}) => {
  // 🔴 期 6 第十二批：接上 i18n（原来是隐式返回的箭头函数 ⇒ 改成块体才能放 hook）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
  <div>
    {articles.map(({ id, title, viewer = 0, lastVisitedTime }) => (
      <a
        // FIXME: uaa is not a good name
        className="article-list-item uaa"
        key={id}
        href={`/post/${id}`}
        target="_blank"
        rel="noreferrer"
      >
        <div className="">{title}</div>
        {/* 🔴 模板 → ICU 整句（英文要 plural：1 view / N views） */}
        {showViewerNum && (
          <div>{t('article.viewerCount', '{count}人次', { count: viewer || 0 })}</div>
        )}
        {/* 🔴 t 是 getRecentTimeDes 的第 3 个参数（第 2 个是 now）⇒ 显式补 undefined */}
        {showRecentViewTime && <div>{getRecentTimeDes(lastVisitedTime, undefined, t)}</div>}
      </a>
    ))}
  </div>
  );
};
