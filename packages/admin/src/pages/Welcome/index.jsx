import { useTab } from '@/services/van-blog/useTab';
import { PageContainer } from '@ant-design/pro-layout';
import style from './index.less';
import { lazy, Suspense } from 'react';
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
          tab: '数据概览',
          key: 'overview',
        },
        {
          tab: '访客统计',
          key: 'viewer',
        },
        {
          tab: '文章分析',
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
