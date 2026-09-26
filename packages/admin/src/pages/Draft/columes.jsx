import ColumnsToolBar from '@/components/ColumnsToolBar';
import PublishDraftModal from '@/components/PublishDraftModal';
import UpdateModal from '@/components/UpdateModal';
import { genActiveObj } from '@/services/van-blog/activeColTools';
import { deleteDraft, getAllCategories, getDraftById, getTags } from '@/services/van-blog/api';
import { downloadMarkdownExport } from '@/services/van-blog/exportMarkdown';
import ExportFormatDropdown from '@/components/ExportFormatDropdown';
import { message, Modal, Tag } from 'antd';
import { history } from 'umi';
// 🔴 从"模块级常量"改成**接收翻译器的函数**：`columns` 里的文案必须在渲染期取语言，
//    而模块加载期 umi 插件运行时还没初始化（与 Token.tsx / SiteInfoForm / app.jsx 的 links 同一条约束）。
//    ⚠️ 调用方（Draft/index.jsx）用 `useMemo(() => getColumns(t), [t])`，
//    🔴 所以那边的 t 必须是 `useCallback([intl])` 包过的稳定引用（否则每次渲染都重算 ⇒ 表格重建）。
export const getColumns = (t) => [
  {
    dataIndex: 'id',
    valueType: 'number',
    title: 'ID',
    width: 48,
    search: false,
  },
  {
    title: t('common.colTitle', '标题'),
    dataIndex: 'title',
    copyable: true,
    ellipsis: true,
    width: 150,
    tip: t('draft.colTitleTip', '标题过长会自动收缩'),
    formItemProps: {
      rules: [
        {
          required: true,
          // 🔴 不是 `init.field.required`（那条是「这是必填项」）：这里是「此项为必填项」，
          //    中文本来就是两句话 ⇒ 各自一个 key（要不要统一属**中文文案修订**，交站长裁定）。
          message: t('common.fieldRequired', '此项为必填项'),
        },
      ],
    },
  },
  {
    // 🔴 `common.colCategory` / `common.colTags` / `common.colAuthor` 是从 `recycle.*` **提升**上来的：
    //    回收站的列、草稿/文章列表的列、表单里的字段标签说的是**同一个性质** ⇒ 一个 key（提升时同步改了
    //    RecycleBin 与 draftRecycleBin.test.js 里那条按 key 定位的锚点）。
    title: t('common.colCategory', '分类'),
    dataIndex: 'category',
    width: 120,
    valueType: 'select',
    request: async () => {
      const { data: categories } = await getAllCategories();
      const data = categories?.map((each) => ({
        label: each,
        value: each,
      }));

      return data;
    },
  },
  {
    title: t('common.colTags', '标签'),
    dataIndex: 'tags',
    search: true,
    fieldProps: { showSearch: true, placeholder: t('common.searchOrSelect', '请搜索或选择') },
    valueType: 'select',
    width: 120,
    renderFormItem: (_, { defaultRender }) => {
      return defaultRender(_);
    },
    request: async () => {
      const { data: tags } = await getTags();
      const data = tags.map((each) => ({
        label: each,
        value: each,
      }));
      return data;
    },
    render: (val, record) => {
      if (!record?.tags?.length) {
        return '-';
      } else {
        return record?.tags?.map((each) => (
          <Tag style={{ marginBottom: 4 }} key={`tag-${each}`}>
            {each}
          </Tag>
        ));
      }
    },
  },
  {
    title: t('common.createdAt', '创建时间'),
    key: 'showTime',
    dataIndex: 'createdAt',
    valueType: 'dateTime',
    sorter: true,
    hideInSearch: true,
    width: 150,
  },
  {
    title: t('common.createdAt', '创建时间'),
    dataIndex: 'createdAt',
    valueType: 'dateRange',
    hideInTable: true,
    search: {
      transform: (value) => {
        return {
          startTime: value[0],
          endTime: value[1],
        };
      },
    },
  },
  {
    title: t('common.colOption', '操作'),
    valueType: 'option',
    key: 'option',
    width: 120,
    render: (text, record, _, action) => {
      return (
        <ColumnsToolBar
          outs={[
            <a
              key={'editable' + record.id}
              onClick={() => {
                history.push(`/editor?type=draft&id=${record.id}`);
              }}
            >
              {t('common.editPost', '编辑')}
            </a>,
            ,
            <PublishDraftModal
              key="publishRecord1213"
              title={record.title}
              id={record.id}
              action={action}
              trigger={
                <a key="publishRecord123">{t('common.publish', '发布')}</a>
              }
            />,
          ]}
          nodes={[
            <UpdateModal
              currObj={record}
              setLoading={() => {}}
              type="draft"
              onFinish={() => {
                action?.reload();
              }}
            />,
              <ExportFormatDropdown
                key={'exportDraft' + record.id}
                payload={{ id: record.id, type: 'draft', title: record.title }}
              />,
            <a
              key={'deleteDraft' + record.id}
              onClick={() => {
                Modal.confirm({
                  title: t('draft.deleteConfirmTitle', '确定删除草稿 "{title}" 吗？', {
                    title: record.title,
                  }),
                  // 软删除：说清去向和撤销路径（回收站在本页工具栏）
                  content: t(
                    'draft.deleteConfirmContent',
                    '删除后草稿会移入本页工具栏的「回收站」，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
                  ),
                  onOk: async () => {
                    await deleteDraft(record.id);
                    message.success(t('draft.deleteOk', '删除成功，已移入回收站（可恢复）!'));
                    action?.reload();
                  },
                });
              }}
            >
              {t('common.delete', '删除')}
            </a>,
          ]}
        ></ColumnsToolBar>
      );
    },
  },
];
export const draftKeys = ['category', 'id', 'option', 'showTime', 'tags', 'title'];
export const draftKeysSmall = ['category', 'id', 'option', 'title'];

export const draftKeysObj = genActiveObj(draftKeys, draftKeys);
export const draftKeysObjSmall = genActiveObj(draftKeysSmall, draftKeys);
