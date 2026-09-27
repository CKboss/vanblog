import { ProCard, StatisticCard } from '@ant-design/pro-card';
import { useIntl } from 'umi';
import { message, Spin } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { getWelcomeData } from '@/services/van-blog/api';
import { reportRequestError } from '@/services/van-blog/requestError';
import style from '../index.less';
import NumSelect from '@/components/NumSelect';
import { Pie, Column } from '@ant-design/plots';
import { useNum } from '@/services/van-blog/useNum';
import RcResizeObserver from 'rc-resize-observer';

const ArticleTab = () => {
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
  const [num, setNum] = useNum(5, 'welcome-article');
  const fetchData = useCallback(async () => {
    const { data: res } = await getWelcomeData('article', 5, 5, num);
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
  const pieConfig = {
    data: data?.categoryPieData || [],
    // appendPadding: 10,
    angleField: 'value',
    colorField: 'type',
    radius: 0.75,
    label: {
      type: 'spider',
      labelHeight: 28,
      content: '{name}\n{percentage}',
    },
    interactions: [
      {
        type: 'element-selected',
      },
      {
        type: 'element-active',
      },
    ],
  };
  const columnConfig = {
    data: data?.columnData || [],
    xField: 'type',
    yField: 'value',
    label: {
      // 可手动配置 label 数据标签位置
      position: 'middle',
      // 'top', 'bottom', 'middle',
      // 配置样式
    },
    color: () => {
      return '#1772B4';
    },
    xAxis: {
      label: {
        autoHide: true,
        autoRotate: false,
      },
    },
    meta: {
      type: {
        alias: t('dataManage.tagColName', '标签名'),
      },
      value: {
        alias: t('welcome.articleQuantity', '文章数量'),
      },
    },
  };
  return (
    <RcResizeObserver
      key="resize-observer"
      onResize={(offset) => {
        setResponsive(offset.width < 596);
      }}
    >
      <Spin spinning={loading}>
        <ProCard
          bordered
          split={responsive ? 'horizontal' : 'vertical'}
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.articleCount', '文章数'),
              value: data?.articleNum || 0,
              layout: responsive ? 'horizontal' : 'vertical',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.totalWords', '总字数'),
              value: data?.wordNum || 0,
              layout: responsive ? 'horizontal' : 'vertical',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.categoryCount', '分类数'),
              value: data?.categoryNum || 0,
              layout: responsive ? 'horizontal' : 'vertical',
            }}
          />
          <StatisticCard
            colSpan={responsive ? 24 : 6}
            statistic={{
              title: t('welcome.tagCount', '标签数'),
              value: data?.tagNum || 0,
              layout: responsive ? 'horizontal' : 'vertical',
            }}
          />
        </ProCard>
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartCategoryPie', '分类饼图')}</div>
              </div>
            }
            chart={
              <div style={{ marginTop: -30 }}>
                <Pie {...pieConfig} />
              </div>
            }
          />
        </ProCard>
        <ProCard
          split={responsive ? 'horizontal' : 'vertical'}
          bordered
          style={{ marginBottom: responsive ? 8 : 0 }}
        >
          <StatisticCard
            colSpan={24}
            className={style['card-full-title']}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>{t('welcome.chartTagColumn', '标签文章数 TOP 柱状图')}</div>
                <NumSelect unit="items" value={num} setValue={setNum} />
              </div>
            }
            chart={
              <div style={{ marginTop: -10 }}>
                <Column {...columnConfig} />
              </div>
            }
          />
        </ProCard>
      </Spin>
    </RcResizeObserver>
  );
};

export default ArticleTab;
