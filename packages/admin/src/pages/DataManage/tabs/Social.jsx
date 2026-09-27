import { deleteSocial, getSocial, getSocialTypes, updateSocial } from '@/services/van-blog/api';
import { useIntl } from 'umi';
import { EditableProTable } from '@ant-design/pro-table';
import { Modal, Spin } from 'antd';
import { useRef, useState } from 'react';

const CUSTOM_SOCIAL_TYPE = 'custom';

function isCustomSocialType(type) {
  return type === CUSTOM_SOCIAL_TYPE || String(type || '').startsWith(`${CUSTOM_SOCIAL_TYPE}-`);
}

function socialRowKey(item) {
  if (isCustomSocialType(item.type) && item.id) {
    return item.id;
  }
  return item.type || item.key;
}

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
    const { data } = await getSocial();

    setLoading(false);
    return (data || []).map((item) => ({ key: socialRowKey(item), ...item }));
  };
  const columns = [
    {
      title: t('customPage.type', '类型'),
      dataIndex: 'type',
      valueType: 'select',
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
      request: async () => {
        const { data } = await getSocialTypes();
        return data || [];
      },
    },
    {
      title: t('dataManage.socialDisplayName', '显示名称'),
      dataIndex: 'label',
      fieldProps: {
        placeholder: t('dataManage.socialDisplayNamePlaceholder', '自定义时必填，如 Telegram'),
      },
      formItemProps: (form) => {
        return {
          rules: [
            {
              validator: async (_, value) => {
                const type = form?.getFieldValue?.('type');
                if (isCustomSocialType(type) && !String(value || '').trim()) {
                  throw new Error(t('dataManage.socialDisplayNameRequired', '自定义社交媒体需要填写显示名称'));
                }
              },
            },
          ],
        };
      },
    },
    {
      title: t('common.colValue', '值'),
      dataIndex: 'value',
      fieldProps: {
        placeholder: t('dataManage.socialValueLabel', '链接 / 邮箱 / 微信二维码地址'),
      },
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('dataManage.socialIconUrl', '图标 URL'),
      dataIndex: 'icon',
      fieldProps: {
        placeholder: t('dataManage.socialIconUrlPlaceholder', '可选，自定义社交媒体的图标地址'),
      },
    },
    {
      title: t('dataManage.colLastSet', '最后设置时间'),
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
            action?.startEditable?.(record.key);
          }}
        >{t('common.editPost', '编辑')}</a>,
        <a
          key="delete"
          onClick={async () => {
            Modal.confirm({
              onOk: async () => {
                await deleteSocial(socialRowKey(record));
                action?.reload();
              },
              // 🔴 三个页签（社交媒体 / 友情链接 / 导航菜单）共用这一句 ⇒ 一个 ICU key（{name}）
              title: t('dataManage.deleteConfirmTitle', '确认删除"{name}"吗?', { name: record.label || record.type }),
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
          headerTitle={t('dataManage.tabSocial', '社交媒体')}
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
            };
          }}
          editable={{
            type: 'multiple',
            editableKeys,
            onSave: async (rowKey, data, row) => {
              if (location.hostname == 'blog-demo.mereith.com') {
                Modal.info({ title: t('common.demoBlocked', '演示站禁止修改此项！') });
                return;
              }
              const toSaveObj = {
                type: data.type,
                value: data.value,
                label: data.label,
                icon: data.icon,
                id: data.id,
              };
              await updateSocial(toSaveObj);
              actionRef?.current?.reload();
            },
            onChange: setEditableRowKeys,
          }}
        />
      </Spin>
    </>
  );
}
