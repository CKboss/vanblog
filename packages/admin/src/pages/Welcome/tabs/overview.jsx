import NumSelect from '@/components/NumSelect';
import { useIntl } from 'umi';
import InstallRecordBanner from '@/components/InstallRecordBanner';
import TipTitle from '@/components/TipTitle';
import { getWelcomeData } from '@/services/van-blog/api';
import { reportRequestError } from '@/services/van-blog/requestError';
import { useNum } from '@/services/van-blog/useNum';
import { Area } from '@ant-design/plots';
import { ProCard, StatisticCard } from '@ant-design/pro-card';
import { message, Spin } from 'antd';
import RcResizeObserver from 'rc-resize-observer';
import { useCallback, useEffect, useMemo, useState } from 'react';
import style from '../index.less';
const { Statistic } = StatisticCard;

const OverView = () => {
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
  // 必须带唯一 token：三个 tab 都不传时 key 全是 `...-undefined`，
  // 在概览改「近 30 天」会把文章/访客 tab 的条数一起改掉。
  const [num, setNum] = useNum(5, 'welcome-overview');
  const [responsive, setResponsive] = useState(false);
  const fetchData = useCallback(async () => {
    const { data: res } = await getWelcomeData('overview', num);
    setData(res);
  }, [setData, num]);
  useEffect(() => {
    setLoading(true);
    // 以前只有 .then()：接口一失败（401/500/断网）就没人把 loading 收掉，
    // 整个概览页的 Spin 会永远转下去，看起来像后台卡死。
    fetchData()
      .catch((err) => reportRequestError(message, err, t('welcome.statsLoadFailed', '统计数据加载失败，请稍后重试！')))
      .finally(() => setLoading(false));
    // 🔴 依赖数组带 t：回调体里那条加载失败提示用了 t（不带就会闭包住首轮渲染的翻译器）
  }, [fetchData, setLoading, t]);

  const eachData = useMemo(() => {
    const res = [];
    for (const each of data?.viewer?.grid?.each || []) {
      res.push({
        date: each.date,
        // 🔴 原来是中文字段名（`访客数:` / `访问量:`）+ `yField="访客数"`：那个键**既是数据字段名、
        //    又是坐标轴与图例上显示的文字**（两栖）⇒ 翻译它要连数据一起改，不翻则英文界面出中文轴标签。
        //    改成 ASCII 字段名 + 下面 `meta.alias` 给本地化显示名（@ant-design/charts 的正规做法）。
        visitors: each.visited,
        views: each.viewer,
      });
    }
    return res;
    // 🔴 依赖数组带 t（回调体里用到了 alias）
  }, [data, t]);

  const totalData = useMemo(() => {
    const res = [];
    for (const each of data?.viewer?.grid?.total || []) {
      res.push({
        date: each.date,
        visitors: each.visited,
        views: each.viewer,
      });
    }
    return res;
  }, [data, t]);
  // 🔴 `meta.alias` = 坐标轴 / tooltip / 图例上显示的名字（跟着语言走）；字段名本身保持 ASCII 不变。
  const chartMeta = {
    visitors: { alias: t('welcome.chartVisitors', '访客数') },
    views: { alias: t('welcome.chartViews', '访问量') },
  };
  const lineConfig = {
    data: totalData,
    xField: 'date',
    // autoFit: true,
    height: 200,
    meta: chartMeta,
  };
  const eachConfig = {
    data: eachData,
    xField: 'date',
    height: 200,
    meta: chartMeta,
  };

  return (
    <RcResizeObserver
      key="resize-observer"
      onResize={(offset) => {
        setResponsive(offset.width < 596);
      }}
    >
      <Spin spinning={loading}>
        {/* 安装归因横幅：本站何时/被谁/从哪条路径初始化（台账 install:initialised）。
            老站点没有这一行 ⇒ 组件渲染 null，不显示噪音。 */}
        <InstallRecordBanner />
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.articleCount', '文章数'),
              value: data?.total?.articleNum || 0,
              layout: responsive ? 'horizontal' : 'vertical',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.totalWords', '总字数'),
              layout: responsive ? 'horizontal' : 'vertical',
              value: data?.total?.wordCount || 0,
            }}
          />

          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: (
                <TipTitle
                  title={t('welcome.totalVisitors', '总访客数')}
                  tip={t('welcome.totalVisitorsTip', '以浏览器内缓存的唯一标识符为衡量标准计算全站独立访客的数量')}
                />
              ),
              value: data?.viewer?.now?.visited || 0,
              layout: responsive ? 'horizontal' : 'vertical',
              description: (
                <Statistic title={t('welcome.todayNew', '今日新增')} value={data?.viewer?.add?.visited || 0} trend="up" />
              ),
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: (
                <TipTitle
                  title={t('welcome.totalViews', '总访问数')}
                  tip={t('welcome.totalViewsTip', '以每一次页面的访问及跳转为衡量标准计算全站的访问数量')}
                />
              ),
              layout: responsive ? 'horizontal' : 'vertical',
              value: data?.viewer?.now?.viewer || 0,
              description: (
                <Statistic title={t('welcome.todayNew', '今日新增')} value={data?.viewer?.add?.viewer || 0} trend="up" />
              ),
            }}
          />
        </ProCard>
        <ProCard
          bordered={responsive ? false : true}
          split={responsive ? 'horizontal' : 'vertical'}
          ghost={responsive ? true : false}
        >
          <StatisticCard
            style={{ marginBottom: responsive ? 8 : 0 }}
            colSpan={!responsive ? 12 : 24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartEachVisitors', '访客数趋势图')}</div>
                <NumSelect unit="days" value={num} setValue={setNum} />
              </div>
            }
            chart={<Area yField="visitors" {...eachConfig} />}
          />

          <StatisticCard
            colSpan={!responsive ? 12 : 24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartEachViews', '访问量趋势图')}</div>
                <NumSelect unit="days" value={num} setValue={setNum} />
              </div>
            }
            chart={<Area yField="views" {...eachConfig} />}
          />
        </ProCard>
        <ProCard
          bordered={responsive ? false : true}
          split={responsive ? 'horizontal' : 'vertical'}
          ghost={responsive ? true : false}
        >
          <StatisticCard
            style={{ marginBottom: responsive ? 8 : 0 }}
            colSpan={!responsive ? 12 : 24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartTotalVisitors', '总访客数趋势图')}</div>
                <NumSelect unit="days" value={num} setValue={setNum} />
              </div>
            }
            chart={<Area yField="visitors" {...lineConfig} />}
          />

          <StatisticCard
            colSpan={!responsive ? 12 : 24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartTotalViews', '总访问量趋势图')}</div>
                <NumSelect unit="days" value={num} setValue={setNum} />
              </div>
            }
            chart={<Area yField="views" {...lineConfig} />}
          />
        </ProCard>
      </Spin>
    </RcResizeObserver>
  );
};

export default OverView;
