import ColumnsToolBar from '@/components/ColumnsToolBar';
import RevisionHistory from '@/components/RevisionHistory';
import UpdateModal from '@/components/UpdateModal';
import {
  deleteArticle,
  getAllCategories,
  getArticleById,
  getTags,
  updateArticle,
} from '@/services/van-blog/api';
import { getPathname } from '@/services/van-blog/getPathname';
import { downloadMarkdownExport } from '@/services/van-blog/exportMarkdown';
import ExportFormatDropdown from '@/components/ExportFormatDropdown';
import { formatDateTime } from '@/services/van-blog/formatTime';
import { describeScheduledTag, isScheduled } from '@/services/van-blog/schedule';
import { message, Modal, Space, Switch, Tag } from 'antd';
import { useState } from 'react';
import { history } from 'umi';
import { genActiveObj } from '../../services/van-blog/activeColTools';

function HiddenSwitch({ record, action }) {
  const [loading, setLoading] = useState(false);
  return (
    <span data-article-hidden-toggle={String(record.id)}>
      <Switch
        size="small"
        loading={loading}
        checked={Boolean(record.hidden)}
        checkedChildren="是"
        unCheckedChildren="否"
        aria-label={`是否隐藏 ${record.title}`}
        onChange={async (checked) => {
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({
              title: '演示站禁止修改信息！',
              content: '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
            });
            return;
          }
          setLoading(true);
          try {
            await updateArticle(record.id, { hidden: checked });
            message.success(checked ? '已设为隐藏' : '已取消隐藏');
            action?.reload();
          } finally {
            setLoading(false);
          }
        }}
      />
    </span>
  );
}

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
    width: 150,
    copyable: true,
    ellipsis: true,
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
    valueType: 'select',
    width: 100,
    request: async () => {
      const { data: categories } = await getAllCategories();
      const data = categories.map((each) => ({
        label: each,
        value: each,
      }));
      return data;
    },
  },
  {
    title: '标签',
    dataIndex: 'tags',
    valueType: 'select',
    fieldProps: { showSearch: true, placeholder: '请搜索或选择' },
    width: 120,
    search: true,
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
    title: '顶置',
    key: 'top',
    dataIndex: 'top',
    valueType: 'number',
    sorter: true,
    width: 80,
    hideInSearch: true,
  },
  {
    title: '浏览量',
    key: 'viewer',
    dataIndex: 'viewer',
    valueType: 'number',
    sorter: true,
    width: 80,
    hideInSearch: true,
  },
  {
    title: '是否隐藏',
    key: 'hidden',
    dataIndex: 'hidden',
    width: 100,
    hideInSearch: true,
    tooltip: '隐藏后前台不展示，也不计入总字数 / 时间线等。可在此直接开关，不必打开修改信息。',
    render: (_, record, __, action) => <HiddenSwitch record={record} action={action} />,
  },
  {
    title: '定时发布',
    key: 'publishAt',
    dataIndex: 'publishAt',
    width: 190,
    hideInSearch: true,
    tooltip:
      '定时中的文章在到点之前对所有前台页面不可见（列表/搜索/RSS/sitemap 都不出现），到点后服务端会在一分钟内自动发布。以 publishAt 是否晚于当前时间为准。',
    render: (_, record) => {
      const text = describeScheduledTag(record?.publishAt);
      // 没定时的显示 '-'：定时状态只由 publishAt 推导，服务端加没加指示字段都不影响这里
      return text ? (
        <Tag color="orange" data-article-scheduled-tag={String(record?.id)}>
          {text}
        </Tag>
      ) : (
        '-'
      );
    },
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
        <Space>
          <ColumnsToolBar
            outs={[
              <a
                key={'editable' + record.id}
                onClick={() => {
                  history.push(
                    `/editor?type=${record?.about ? 'about' : 'article'}&id=${record.id}`,
                  );
                }}
              >
                编辑
              </a>,
              <a
                href={`/post/${getPathname(record)}`}
                onClick={(ev) => {
                  if (record?.hidden) {
                    Modal.confirm({
                      title: '此文章为隐藏文章！',
                      content: (
                        <div>
                          <p>
                            隐藏文章在未开启通过 URL 访问的情况下（默认关闭），会出现 404 页面！
                          </p>
                          <p>
                            您可以在{' '}
                            <a
                              onClick={() => {
                                // 以前推的是 `?subTab=layout`，但 SystemConfig 读 `tab`、
                                // SiteInfo 读 `siteInfoTab`，没人读 subTab：
                                // 点「布局配置」只会停在默认的「站点配置 → 基本设置」。
                                history.push('/site/setting?tab=siteInfo&siteInfoTab=layout');
                              }}
                            >
                              布局配置
                            </a>{' '}
                            中修改此项。
                          </p>
                        </div>
                      ),
                      onOk: () => {
                        window.open(`/post/${getPathname(record)}`, '_blank');
                        return true;
                      },
                      okText: '仍然访问',
                      cancelText: '返回',
                    });
                    ev.preventDefault();
                  } else if (isScheduled(record?.publishAt)) {
                    // 定时中的文章前台还不可见：别让「查看」看起来像已经发布了
                    Modal.confirm({
                      title: '此文章处于「定时待发布」状态！',
                      content: (
                        <div>
                          <p>
                            这篇文章定时于 <b>{formatDateTime(record?.publishAt)}</b>{' '}
                            自动发布，在那之前它对所有前台页面不可见，现在打开会是 404 页面。
                          </p>
                          <p>想改时间或取消定时：编辑 →「修改信息」→「定时发布」。</p>
                        </div>
                      ),
                      onOk: () => {
                        window.open(`/post/${getPathname(record)}`, '_blank');
                        return true;
                      },
                      okText: '仍然访问',
                      cancelText: '返回',
                    });
                    ev.preventDefault();
                  }
                }}
                target="_blank"
                rel="noopener noreferrer"
                key={'view' + record.id}
              >
                查看
              </a>,
            ]}
            nodes={[
              <UpdateModal
                currObj={record}
                setLoading={() => {}}
                type="article"
                onFinish={() => {
                  action?.reload();
                }}
              />,
              // 三种格式并列，各说清代价；默认不再是"永远一个 zip"
              <ExportFormatDropdown
                key={'exportArticle' + record.id}
                payload={{ id: record.id, type: 'article', title: record.title }}
              />,
              <RevisionHistory
                key={'revisions' + record.id}
                articleId={record?.id}
                articleTitle={record?.title}
                onRestored={() => {
                  action?.reload();
                }}
              />,
              <a
                key={'deleteArticle' + record.id}
                onClick={() => {
                  Modal.confirm({
                    title: `确定删除 "${record.title}"吗？`,
                    // 软删除：说清楚去向和撤销路径（回收站在本页工具栏）
                    content:
                      '删除后文章会移入本页工具栏的「回收站」，前台立刻不可见，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
                    onOk: async () => {
                      if (location.hostname == 'blog-demo.mereith.com') {
                        if ([28, 29].includes(record.id)) {
                          message.warn('演示站禁止删除此文章！');
                          return false;
                        }
                      }
                      await deleteArticle(record.id);
                      message.success('删除成功，已移入回收站（可恢复）!');
                      action?.reload();
                    },
                  });
                }}
              >
                删除
              </a>,
            ]}
          />
        </Space>
      );
    },
  },
];
export const articleKeys = [
  'category',
  'hidden',
  'id',
  'option',
  'publishAt',
  'showTime',
  'tags',
  'title',
  'top',
  'viewer',
];
export const articleKeysSmall = ['category', 'hidden', 'id', 'option', 'publishAt', 'title'];
export const articleObjAll = genActiveObj(articleKeys, articleKeys);
export const articleObjSmall = genActiveObj(articleKeysSmall, articleKeys);
