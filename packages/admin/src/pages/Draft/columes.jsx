import ColumnsToolBar from '@/components/ColumnsToolBar';
import PublishDraftModal from '@/components/PublishDraftModal';
import UpdateModal from '@/components/UpdateModal';
import { genActiveObj } from '@/services/van-blog/activeColTools';
import { deleteDraft, getAllCategories, getDraftById, getTags } from '@/services/van-blog/api';
import { downloadMarkdownExport } from '@/services/van-blog/exportMarkdown';
import ExportFormatDropdown from '@/components/ExportFormatDropdown';
import { message, Modal, Tag } from 'antd';
import { history } from 'umi';
export const columns = [
  {
    dataIndex: 'id',
    valueType: 'number',
    title: 'ID',
    width: 48,
    search: false,
  },
  {
    title: '标题',
    dataIndex: 'title',
    copyable: true,
    ellipsis: true,
    width: 150,
    tip: '标题过长会自动收缩',
    formItemProps: {
      rules: [
        {
          required: true,
          message: '此项为必填项',
        },
      ],
    },
  },
  {
    title: '分类',
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
    title: '标签',
    dataIndex: 'tags',
    search: true,
    fieldProps: { showSearch: true, placeholder: '请搜索或选择' },
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
    title: '创建时间',
    key: 'showTime',
    dataIndex: 'createdAt',
    valueType: 'dateTime',
    sorter: true,
    hideInSearch: true,
    width: 150,
  },
  {
    title: '创建时间',
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
    title: '操作',
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
              编辑
            </a>,
            ,
            <PublishDraftModal
              key="publishRecord1213"
              title={record.title}
              id={record.id}
              action={action}
              trigger={<a key="publishRecord123">发布</a>}
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
                  title: `确定删除草稿 "${record.title}" 吗？`,
                  // 软删除：说清去向和撤销路径（回收站在本页工具栏）
                  content:
                    '删除后草稿会移入本页工具栏的「回收站」，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
                  onOk: async () => {
                    await deleteDraft(record.id);
                    message.success('删除成功，已移入回收站（可恢复）!');
                    action?.reload();
                  },
                });
              }}
            >
              删除
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
