import { deleteTag, getTags, updateTag } from '@/services/van-blog/api';
import { useIntl } from 'umi';
import { ModalForm, ProFormText } from '@ant-design/pro-form';
import { ProTable } from '@ant-design/pro-table';
import { message, Modal } from 'antd';
import { useRef } from 'react';
/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。列定义是**模块级**常量，拿不到 hook
 * ⇒ 改成函数版，由组件在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前逐字相同。
 * （上一批 Backup.jsx 的 `FORMAT_LABELS` 就是因为直接包了 t 而在模块加载期炸掉、整页白屏。）
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

const buildColumns = (t = IDENTITY_T) => [
  {
    dataIndex: 'name',
    title: t('dataManage.tagColName', '标签名'),
    search: true,
    fieldProps: { showSearch: true, placeholder: t('common.searchOrSelect', '请搜索或选择') },
    request: async () => {
      const { data: tags } = await getTags();
      const data = tags.map((each) => ({
        label: each,
        value: each,
      }));
      return data;
    },
    // render: (text) => {
    //   return <span style={{ marginLeft: 8 }}>{text}</span>;
    // },
  },
  {
    title: t('common.colOption', '操作'),
    valueType: 'option',
    width: 240,
    render: (text, record, _, action) => [
      <a
        key="viewTag"
        onClick={() => {
          window.open(`/tag/${record.name.replace(/#/g, '%23')}`, '_blank');
        }}
      >{t('common.view', '查看')}</a>,
      <ModalForm
        key={`editCateoryC%{${record.name}}`}
        title={t('dataManage.tagRenameModalTitle', '重命名标签 "{name}"', { name: record.name })}
        trigger={<a key={'editC' + record.name} data-tag-rename={String(record.name)}>{t('dataManage.rename', '重命名')}</a>}
        autoFocusFirstInput
        submitTimeout={3000}
        onFinish={async (values) => {
          Modal.confirm({
            // 🔴 原来是"模板字符串 + 两个插值"⇒ 收成一条带 {from}/{to} 的 ICU 整句（英文语序不同，拼接必出接缝）
            content: t(
              'dataManage.tagRenameConfirmContent',
              '确定重命名标签 "{from}" 为 "{to}" 吗？所有文章的该标签都将被更新为新名称!',
              { from: record.name, to: values.newName },
            ),
            onOk: async () => {
              await updateTag(record.name, values.newName);
              message.success(t('dataManage.tagRenameOk', '更新成功！所有文章该标签都将变为新名称！'));
              action?.reload();
              return true;
            },
          });

          return true;
        }}
      >
        <ProFormText
          width="lg"
          name="newName"
          label={t('dataManage.newTagLabel', '新标签')}
          placeholder={t('dataManage.newTagPlaceholder', '请输入新的标签名称')}
          tooltip={t('dataManage.tagRenameHint', '所有文章的该标签都将被更新为新名称')}
          required
          rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
        />
      </ModalForm>,
      <a
        key="delTag"
        onClick={() => {
          Modal.confirm({
            title: t('dataManage.confirmDeleteTitle', '确认删除'),
            content: t(
              'dataManage.tagDeleteConfirmContent',
              '确认删除该标签吗？所有文章的该标签都将被删除，其他标签不变。',
            ),
            onOk: async () => {
              await deleteTag(record.name);
              message.success(t('dataManage.tagDeleteOk', '删除成功！所有文章的该标签都将被删除，其他标签不变。'));
              action?.reload();
              return true;
            },
          });
        }}
      >{t('common.delete', '删除')}</a>,
    ],
  },
];
export default function () {
  // 🔴 期 6 第九批：接上 i18n（语言选择必须在**渲染期**，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);

  const fetchData = async () => {
    const { data: res } = await getTags();
    return res.map((item) => ({
      key: item,
      name: item,
    }));
  };
  const actionRef = useRef();
  return (
    <>
      <ProTable
        rowKey="name"
        columns={buildColumns(t)}
        dateFormatter="string"
        actionRef={actionRef}
        search={{
          collapseRender: () => {
            return null;
          },
          collapsed: false,
        }}
        options={false}
        request={async (params = {}) => {
          let data = await fetchData();
          if (params?.name) {
            // 以前是 `data = [{ key: params.name, name: params.name }]`：
            // 不管搜什么都会「造」出一行并不存在的标签，它的重命名/删除打到服务端
            // 匹配不到任何文章，却照样 toast「更新成功」，用户以为改掉了其实什么都没发生。
            // 改成在真实标签里做模糊过滤，没有命中就让 ProTable 显示「暂无数据」。
            const keyword = String(params.name).trim().toLowerCase();
            data = keyword
              ? data.filter((item) => String(item.name).toLowerCase().includes(keyword))
              : data;
          }
          return {
            data,
            // success 请返回 true，
            // 不然 table 会停止解析数据，即使有数据
            success: true,
            // 不传会使用 data 的长度，如果是分页一定要传
            total: data.length,
          };
        }}
        locale={{ emptyText: t('dataManage.noMatchingTag', '没有匹配的标签') }}
      />
    </>
  );
}
