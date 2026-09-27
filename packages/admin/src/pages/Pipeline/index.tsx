import TipTitle from '@/components/TipTitle';
import { PageContainer } from '@ant-design/pro-layout';
import ProTable from '@ant-design/pro-table';
import { Button, message, Modal, Space, Tag } from 'antd';
import { getPiplelines, getPipelineConfig, deletePipelineById } from '@/services/van-blog/api';
import PipelineModal from './components/PipelineModal';
import { useEffect, useRef, useState } from 'react';
import { history, useIntl } from 'umi';

export default function () {
  // 🔴 期 6 第十二批：接上 i18n（语言选择必须在渲染期）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [pipelineConfig, setPipelineConfig] = useState<any[]>([]);
  const actionRef = useRef<any>();

  useEffect(() => {
    // 缺 catch 时接口一失败就是一个未处理的 promise rejection；
    // data 为空也要退回 []，否则下面 columns 里 pipelineConfig.find 会抛。
    getPipelineConfig()
      .then(({ data }) => {
        setPipelineConfig(data || []);
      })
      .catch(() => {
        setPipelineConfig([]);
      });
  }, []);

  const columns = [
    {
      dataIndex: 'id',
      valueType: 'number',
      title: 'ID',
      width: 48,
    },
    {
      dataIndex: 'name',
      valueType: 'text',
      title: t('common.colName', '名称'),
      width: 120,
    },
    {
      title: t('pipeline.colAsync', '是否异步'),
      width: 60,
      render: (_, record) => {
        const passive = pipelineConfig.find((item) => item.eventName === record.eventName)?.passive;
        return (
      <Tag
        children={passive ? t('pipeline.asyncTag', '异步') : t('code.blocking', '阻塞')}
        color={passive ? 'green' : 'red'}
      />
    );
      },
    },
    {
      dataIndex: 'eventName',
      valueType: 'text',
      title: t('log.colTriggerEvent', '触发事件'),
      width: 120,
      render: (eventName) => {
        return pipelineConfig.find((item) => item.eventName === eventName)?.eventNameChinese;
      },
    },
    {
      dataIndex: 'enabled',
      title: t('comment.colStatus', '状态'),
      width: 60,
      render: (enabled: boolean) => (
        <Tag
      children={enabled ? t('theme.activate', '启用') : t('pipeline.disabledTag', '禁用')}
      color={enabled ? 'green' : 'gray'}
    />
      ),
    },
    {
      title: t('common.colOption', '操作'),
      width: 180,
      render: (_, record, action) => {
        return (
          <>
            <Space>
              <a
                onClick={() => {
                  history.push('/code?type=pipeline&id=' + record.id);
                }}
              >{t('pipeline.editScript', '编辑脚本')}</a>
              <PipelineModal
                mode="edit"
                trigger={<a>{t('common.editInfo', '修改信息')}</a>}
                initialValues={record}
                onFinish={() => {
                  actionRef.current?.reload();
                }}
              />

              <a
                onClick={async () => {
                  Modal.confirm({
                    title: t('pipeline.deleteConfirm', '确定删除该流水线吗？ '),
                    onOk: async () => {
                      await deletePipelineById(record.id);
                      console.log(action);
                      actionRef.current.reload();
                      message.success(t('common.deleteSuccess', '删除成功！'));
                    },
                  });
                }}
              >{t('common.delete', '删除')}</a>
            </Space>
          </>
        );
      },
    },
  ];

  return (
    <PageContainer
      header={{
        title: (
          <TipTitle
      title={t('menu.site.pipeline', '流水线')}
      tip={t('pipeline.pageTip', '流水线允许用户在特定事件时，自动触发执行自定义代码。')}
    />
        ),
      }}
      extra={
        <Button
          onClick={() => {
            window.open('https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/pipeline.md', '_blank');
          }}
        >{t('init.wizard.helpDoc', '帮助文档')}</Button>
      }
    >
      <ProTable
        actionRef={actionRef}
        pagination={{
          showQuickJumper: true,
          hideOnSinglePage: true,
        }}
        toolBarRender={(action) => {
          return [
            <PipelineModal
              mode="create"
              key="createPipelineBtn1"
              trigger={<Button type="primary">{t('common.create', '新建')}</Button>}
              onFinish={() => {
                action.reload();
              }}
            />,
            <Button
              key="viewLog"
              onClick={() => {
                history.push('/site/log?tab=pipeline');
              }}
            >{t('pipeline.runLog', '运行日志')}</Button>,
          ];
        }}
        headerTitle={t('pipeline.listTitle', '流水线列表')}
        columns={columns}
        search={false}
        rowKey="id"
        request={async () => {
          const data = await getPiplelines();
          return {
            data: data.data,
            success: true,
            total: data.data.length,
          };
        }}
      />
    </PageContainer>
  );
}
