import { getLog, getPipelineConfig } from '@/services/van-blog/api';
import { ProTable } from '@ant-design/pro-table';
import { Modal, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { history, useIntl } from 'umi';

export default function () {
  const actionRef = useRef();
  const [pipelineConfig, setPipelineConfig] = useState<any[]>([]);
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。`values` 用 `Record<string, any>`（写 unknown 会报 TS2769）。
  // ⚠️ 上面那个 `useEffect(..., [])` 只拉一次流水线配置、**不用 t** ⇒ 没有陈旧语言闭包问题；
  //    🔴 谁要往它的依赖数组里加 t，必须先把 t 用 useCallback([intl]) 包（§7.144 A/B）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  useEffect(() => {
    getPipelineConfig().then(({ data }) => {
      setPipelineConfig(data);
    });
  }, []);
  const columns = [
    {
      title: t('common.colIndex', '序号'),
      align: 'center',
      width: 50,
      render: (text, record, index) => {
        return index + 1;
      },
    },
    {
      title: t('log.colPipelineId', '流水线 id'),
      dataIndex: 'pipelineId',
      key: 'pipelineId',
      align: 'center',
    },
    {
      title: t('common.colName', '名称'),
      dataIndex: 'pipelineName',
      key: 'pipelineName',
      align: 'center',
      render: (name, record) => (
        <a
          onClick={() => {
            history.push('/code?type=pipeline&id=' + record.pipelineId);
          }}
        >
          {name}
        </a>
      ),
    },
    {
      title: t('log.colTriggerEvent', '触发事件'),
      dataIndex: 'eventName',
      key: 'eventName',
      align: 'center',
      render: (eventName) => {
        return (
          <Tag color="blue">
            {pipelineConfig?.find((item) => item.eventName == eventName)?.eventNameChinese}
          </Tag>
        );
      },
    },
    {
      title: t('log.colResult', '结果'),
      dataIndex: 'success',
      key: 'success',
      align: 'center',
      render: (success) => {
        return success ? (
          <Tag color="green">{t('common.success', '成功')}</Tag>
        ) : (
          <Tag color="red">{t('common.fail', '失败')}</Tag>
        );
      },
    },
    {
      title: t('log.detail', '详情'),
      dataIndex: 'detail',
      key: 'detail',
      render: (_, record) => {
        return (
          <a
            onClick={() => {
              Modal.info({
                // 🔴 content 是**在本组件作用域里创建**的元素（t() 在这里就求值好了）⇒ 不受
                //    "Modal.* 是独立 React 根、里面不能用 useIntl" 那条限制（§7.151 A）。
                title: t('log.detail', '详情'),
                width: 800,
                content: (
                  <div
                    style={{
                      maxHeight: '60vh',
                      overflow: 'auto',
                    }}
                  >
                    <p>{t('log.scriptLogs', '脚本日志：')}</p>
                    <pre>
                      {record.logs.map((l) => (
                        <p>{l}</p>
                      ))}
                    </pre>
                    <p>{t('log.input', '输入：')}</p>
                    <pre>{JSON.stringify(record.input, null, 2)}</pre>
                    <p>{t('log.output', '输出：')}</p>
                    <pre>{JSON.stringify(record.output, null, 2)}</pre>
                  </div>
                ),
              });
            }}
          >
            {t('log.detail', '详情')}
          </a>
        );
      },
    },
  ];
  return (
    <>
      <ProTable
        // ghost
        cardBordered
        rowKey="time"
        columns={columns}
        search={false}
        dateFormatter="string"
        actionRef={actionRef}
        options={true}
        headerTitle={t('log.pipeline', '流水线日志')}
        pagination={{
          showQuickJumper: true,
          pageSize: 10,
          simple: true,
          hideOnSinglePage: true,
        }}
        request={async (params) => {
          // console.log(params);
          // const data = await fetchData();
          const { data } = await getLog('runPipeline', params.current, params.pageSize);
          return {
            data: data.data,
            // success 请返回 true，
            // 不然 table 会停止解析数据，即使有数据
            success: true,
            // 不传会使用 data 的长度，如果是分页一定要传
            total: data.total,
          };
        }}
      />
    </>
  );
}
