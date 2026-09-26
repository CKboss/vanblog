import { getLog } from '@/services/van-blog/api';
import { ProTable } from '@ant-design/pro-table';
import { Tag } from 'antd';
import { useRef } from 'react';
import { useIntl } from 'umi';

export default function () {
  const actionRef = useRef();
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件没有把 t 放进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
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
      title: t('log.colLoginTime', '登录时间'),
      dataIndex: 'time',
      key: 'time',
      align: 'center',
      render: (text, record) => {
        return new Date(record.time).toLocaleString();
      },
    },
    {
      title: t('log.colLoginAddress', '登录地址'),
      dataIndex: 'address',
      key: 'address',
      align: 'center',
    },
    {
      title: t('log.colLoginIp', '登录IP'),
      dataIndex: 'ip',
      key: 'ip',
      align: 'center',
    },
    {
      title: t('log.colLoginDevice', '登录设备'),
      dataIndex: 'platform',
      key: 'platform',
      align: 'center',
    },
    {
      title: t('log.colLoginStatus', '登录状态'),
      dataIndex: 'success',
      key: 'success',
      align: 'center',
      render: (text, record) => {
        return (
          <Tag color={record.success ? 'success' : 'error'} style={{ marginRight: 0 }}>
            {record.success ? t('common.success', '成功') : t('common.fail', '失败')}
          </Tag>
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
        headerTitle={t('log.login', '登录日志')}
        pagination={{
          showQuickJumper: true,
          pageSize: 10,
          simple: true,
          hideOnSinglePage: true,
        }}
        request={async (params) => {
          // console.log(params);
          // const data = await fetchData();
          const { data } = await getLog('login', params.current, params.pageSize);
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
