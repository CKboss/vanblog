import { ProCard, StatisticCard } from '@ant-design/pro-card';
import { message, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWelcomeData } from '@/services/van-blog/api';
import ArticleList from '@/components/ArticleList';
import { getRecentTimeDes } from '@/services/van-blog/tool';
import { reportRequestError } from '@/services/van-blog/requestError';
import { Link, useIntl } from 'umi';
import TipTitle from '@/components/TipTitle';
import style from '../index.less';
import NumSelect from '@/components/NumSelect';
import { useNum } from '@/services/van-blog/useNum';
import RcResizeObserver from 'rc-resize-observer';

const Viewer = () => {
  // 🔴 期 6 第十三批：接上 i18n（语言选择必须在渲染期）。
  // ⚠️ t 用 useCallback([intl]) 包成**稳定引用**：本文件的 useMemo / useEffect 依赖数组里要放 t
  //    （回调体用了 t 就必须声明它，否则切语言后仍是旧译文；§7.144 B），不稳定则依赖每轮都变（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );

  const [data, setData] = useState();
  const [loading, setLoading] = useState(true);
  const [responsive, setResponsive] = useState(false);
  // 必须带唯一 token：三个 tab 都不传时 key 全是 `...-undefined`，互相串数据
  const [num, setNum] = useNum(5, 'welcome-viewer');
  const fetchData = useCallback(async () => {
    const { data: res } = await getWelcomeData('viewer', 5, num);
    setData(res);
  }, [setData, num]);
  useEffect(() => {
    setLoading(true);
    // 以前只有 .then()：接口失败时 loading 永远收不掉，整页 Spin 转不停
    fetchData()
      .catch((err) => reportRequestError(message, err, t('welcome.statsLoadFailed', '统计数据加载失败，请稍后重试！')))
      .finally(() => setLoading(false));
    // 🔴 依赖数组带 t：回调体里那条加载失败提示用了 t（不带就会闭包住首轮渲染的翻译器）
  }, [fetchData, setLoading, t]);

  const recentHref = useMemo(() => {
    if (!data) {
      return undefined;
    }
    if (!data?.siteLastVisitedPathname) {
      return undefined;
    }
    return data?.siteLastVisitedPathname;
  }, [data]);
  const recentVisitTime = useMemo(() => {
    if (!data) {
      return '-';
    }
    if (!data.siteLastVisitedTime) {
      return '-';
    }
    // 🔴 `getRecentTimeDes(timestr, now, t)`：t 是**第 3 个**参数（第 2 个是 now）⇒ 显式补 undefined
    return getRecentTimeDes(data?.siteLastVisitedTime, undefined, t);
    // 🔴 依赖数组带 t（回调体里把它传给了 getRecentTimeDes ⇒ 相对时间的文案跟着语言走）
  }, [data, t]);

  return (
    <RcResizeObserver
      key="resize-observer"
      onResize={(offset) => {
        setResponsive(offset.width < 596);
      }}
    >
      <Spin spinning={loading}>
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <a
                  href="https://tongji.baidu.com/main/homepage/"
                  className="ua blue"
                  target="_blank"
                  rel="noreferrer"
                >{t('welcome.baiduTongji', '百度统计')}</a>
              ),
              formatter: () => {
                if (data?.enableBaidu) {
                  return <span>{t('welcome.enabled', '已开启')}</span>;
                } else {
                  // umi 配了 base: '/admin/'，<Link> 里的路径是相对 base 的：
                  // 写成 `/admin/site/setting` 会渲染成 /admin/admin/... 直接 404。
                  // 外层 tab 由 SystemConfig 的 `tab` 读，内层由 SiteInfo 的 `siteInfoTab` 读。
                  return <Link to={`/site/setting?tab=siteInfo&siteInfoTab=more`}>{t('welcome.notConfigured', '未配置')}</Link>;
                }
              },
              status: data?.enableBaidu ? 'success' : 'error',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <a
                  href="https://analytics.google.com/analytics/web/"
                  className="ua blue"
                  target="_blank"
                  rel="noreferrer"
                >{t('welcome.googleAnalytics', '谷歌分析')}</a>
              ),
              formatter: () => {
                if (data?.enableGA) {
                  return <span>{t('welcome.enabled', '已开启')}</span>;
                } else {
                  return <Link to={`/site/setting?tab=siteInfo&siteInfoTab=more`}>{t('welcome.notConfigured', '未配置')}</Link>;
                }
              },
              status: data?.enableGA ? 'success' : 'error',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: t('welcome.recentVisits', '最近访问'),
              value: recentVisitTime,
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: t('welcome.recentVisitPath', '最近访问路径'),
              formatter: (val) => {
                return (
                  <a className="ua blue" target="_blank" rel="noreferrer" href={recentHref}>
                    {data?.siteLastVisitedPathname || '-'}
                  </a>
                );
              },
            }}
          />
        </ProCard>
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <TipTitle
                  title={t('welcome.totalVisitors', '总访客数')}
                  tip={t('welcome.totalVisitorsTip', '以浏览器内缓存的唯一标识符为衡量标准计算全站独立访客的数量')}
                />
              ),
              value: data?.totalVisited || 0,
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <TipTitle
                  title={t('welcome.totalViews', '总访问数')}
                  tip={t('welcome.totalViewsTip', '以每一次页面的访问及跳转为衡量标准计算全站的访问数量')}
                />
              ),
              value: data?.totalViewer || 0,
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <TipTitle
                  title={t('welcome.topArticleVisitors', '单篇最高访客数')}
                  tip={t('welcome.topArticleVisitorsTip', '以浏览器内缓存的唯一标识符为衡量标准计算出单篇文章最高的独立访客数')}
                />
              ),
              value: data?.maxArticleVisited || 0,
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              layout: responsive ? 'horizontal' : 'vertical',
              title: (
                <TipTitle
                  title={t('welcome.topArticleViews', '单篇最高访问量')}
                  tip={t('welcome.topArticleViewsTip', '以每一次页面的访问及跳转为衡量标准计算出单篇文章最高的访问量')}
                />
              ),
              value: data?.maxArticleViewer || 0,
            }}
          />
        </ProCard>
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered={responsive ? false : true}
          ghost={responsive ? true : false}
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <ProCard
            ghost
            colSpan={responsive ? 24 : 12}
            style={{ marginBottom: responsive ? 8 : 0 }}
          >
            <StatisticCard
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>{t('welcome.recentTop', '最近访问TOP')}</div>
                  <NumSelect unit="items" value={num} setValue={setNum} />
                </div>
              }
              className={style['card-full-title']}
              chart={
                <div style={{ marginTop: -14 }}>
                  <ArticleList showRecentViewTime articles={data?.recentVisitArticles || []} />
                </div>
              }
            />
          </ProCard>
          <ProCard ghost colSpan={responsive ? 24 : 12}>
            <StatisticCard
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>{t('welcome.articleTop', '文章访问量TOP')}</div>
                  <NumSelect unit="items" value={num} setValue={setNum} />
                </div>
              }
              className={style['card-full-title']}
              chart={
                <div style={{ marginTop: -14 }}>
                  <ArticleList showViewerNum articles={data?.topViewer || []} />
                </div>
              }
            />
          </ProCard>
        </ProCard>
      </Spin>
    </RcResizeObserver>
  );
};

export default Viewer;
