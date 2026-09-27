import { deleteDonate, getDonate, updateDonate } from '@/services/van-blog/api';
import { useIntl } from 'umi';
import { EditableProTable } from '@ant-design/pro-table';
import { Modal, Spin } from 'antd';
import { useRef, useState } from 'react';

export default function () {
  // 🔴 期 6 第九批：接上 i18n（语言选择必须在**渲染期**，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);

  const [loading, setLoading] = useState(true);
  const [editableKeys, setEditableRowKeys] = useState([]);
  const actionRef = useRef();
  const fetchData = async () => {
    setLoading(true);
    const { data } = await getDonate();
    setLoading(false);
    return data.map((item) => ({ key: item.name, ...item }));
  };
  const columns = [
    {
      title: t('dataManage.donateName', '捐赠人'),
      dataIndex: 'name',
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('dataManage.donateAmount', '金额'),
      valueType: 'money',
      dataIndex: 'value',
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('dataManage.colLastDonate', '最后捐赠时间'),
      valueType: 'date',
      editable: false,
      dataIndex: 'updatedAt',
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('common.colOption', '操作'),
      valueType: 'option',
      key: 'option',
      width: 200,
      render: (text, record, _, action) => [
        <a
          key="editable"
          onClick={() => {
            action?.startEditable?.(record.name);
          }}
        >{t('common.editPost', '编辑')}</a>,
        <a
          key="delete"
          onClick={async () => {
            Modal.confirm({
              onOk: async () => {
                await deleteDonate(record.name);
                action?.reload();
              },
              title: t('dataManage.deleteDonateConfirmTitle', '确认删除"{name}"的捐赠吗?', { name: record.name }),
            });
          }}
        >{t('common.delete', '删除')}</a>,
      ],
    },
  ];
  return (
    <>
      <Spin spinning={loading}>
        <EditableProTable
          actionRef={actionRef}
          rowKey="key"
          headerTitle={t('dataManage.donateCardTitle', '捐赠详情')}
          scroll={{
            x: 960,
          }}
          recordCreatorProps={{
            position: 'bottom',
            record: () => ({ key: Date.now() }),
          }}
          loading={false}
          columns={columns}
          request={async () => {
            let data = await fetchData();
            return {
              data,
              success: true,
              total: data.length,
            };
          }}
          editable={{
            type: 'multiple',
            editableKeys,
            onSave: async (rowKey, data, row) => {
              await updateDonate(data);
              actionRef?.current?.reload();
            },
            onChange: setEditableRowKeys,
          }}
        />
      </Spin>
    </>
  );
}
