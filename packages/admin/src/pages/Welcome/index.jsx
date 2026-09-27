import { useTab } from '@/services/van-blog/useTab';
import { useIntl } from 'umi';
import { PageContainer } from '@ant-design/pro-layout';
import style from './index.less';
import { useCallback, lazy, Suspense  } from 'react';
import { Spin } from 'antd';

// 三个 tab 都用 @ant-design/plots（G2，几百 KB）。静态 import 的话，
// 一进后台首页就会把三份图表代码全下载下来，而用户一次只看一个 tab。
const Article = lazy(() => import('./tabs/article'));
const OverView = lazy(() => import('./tabs/overview'));
const Viewer = lazy(() => import('./tabs/viewer'));

const tabFallback = (
  <div style={{ padding: 48, textAlign: 'center' }}>
    <Spin />
  </div>
);
const Welcome = () => {
  // 🔴 期 6 第十三批：接上 i18n（语言选择必须在渲染期）。
  // ⚠️ t 用 useCallback([intl]) 包成**稳定引用**：本文件的 useMemo / useEffect 依赖数组里要放 t
  //    （回调体用了 t 就必须声明它，否则切语言后仍是旧译文；§7.144 B），不稳定则依赖每轮都变（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );

  const [tab, setTab] = useTab('overview', 'tab');

  // const { initialState } = useModel('@@initialState');
  const tabMap = {
    overview: <Suspense fallback={tabFallback}><OverView  /></Suspense>,
    viewer: <Suspense fallback={tabFallback}><Viewer  /></Suspense>,
    article: <Suspense fallback={tabFallback}><Article  /></Suspense>,
  };
  // const showCommentBtn = useMemo(() => {
  //   const url = initialState?.walineServerUrl;
  //   if (!url || url == '') {
  //     return false;
  //   }
  //   return true;
  // }, [initialState]);
  return (
    <PageContainer
      // title={null}
      extra={null}
      header={{ title: null, extra: null, ghost: true }}
      className={style.thinheader}
      onTabChange={(k) => {
        setTab(k);
      }}
      tabActiveKey={tab}
      tabList={[
        {
          tab: t('welcome.tabOverview', '数据概览'),
          key: 'overview',
        },
        {
          tab: t('welcome.tabViewer', '访客统计'),
          key: 'viewer',
        },
        {
          tab: t('welcome.tabArticle', '文章分析'),
          key: 'article',
        },
      ]}
      title={null}
      // extra={
      //   <Space>
      //     {showCommentBtn && (
      //       <Button
      //         type="primary"
      //         onClick={() => {
      //           const urlRaw = data?.link?.walineServerUrl || '';
      //           if (urlRaw == '') {
      //             return;
      //           }
      //           const u = new URL(urlRaw).toString();
      //           window.open(`${u}ui`, '_blank');
      //         }}
      //       >
      //         评论管理
      //       </Button>
      //     )}
      //     <Button
      //       type="primary"
      //       onClick={() => {
      //         const urlRaw = data?.link?.baseUrl || '';
      //         if (urlRaw == '') {
      //           return;
      //         }

      //         window.open(`${urlRaw}`, '_blank');
      //       }}
      //     >
      //       前往主站
      //     </Button>
      //   </Space>
      // }
    >
      {tabMap[tab]}
    </PageContainer>
  );
};

export default Welcome;
