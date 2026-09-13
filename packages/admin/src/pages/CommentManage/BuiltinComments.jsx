import { deleteComment, getComments, updateComment } from '@/services/van-blog/api';
import { statusMeta, statusTabs } from '@/services/van-blog/commentAdmin';
import { formatTimeAgo } from '@/services/van-blog/relativeTime';
import { reportRequestError } from '@/services/van-blog/requestError';
import {
  Button,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

const { TabPane } = Tabs;
const { Paragraph, Text } = Typography;

/**
 * 内置评论的管理面板（provider === 'builtin' 时由 CommentManage/index.jsx 渲染）。
 *
 * 用普通 antd Table 而不是 ProTable：这里的筛选是「带计数的状态页签 + 关键词 + 路径」
 * 三个自定义控件，而且列表接口本身就回 counts（DataManage 那些 ProTable 页签没有这种形态），
 * 套 ProTable 的搜索表单反而要绕开它的内置逻辑，代码更多。
 *
 * 隐私约定：email / ip / ua 只允许出现在本管理页（AdminGuard 后面），
 * 不许 console.log 整条评论对象，也不许把这些字段透传给别的组件。
 */
export default function BuiltinComments() {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 默认停在「待审核」：进评论管理页最要紧的就是待审队列，页签上随时能看到条数
  const [status, setStatus] = useState('pending');
  const [keyword, setKeyword] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [editTarget, setEditTarget] = useState(null);
  const [editForm] = Form.useForm();

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getComments({
        page,
        pageSize,
        status,
        keyword,
        path: pathFilter,
      });
      setList(data?.data || []);
      setTotal(Number(data?.total) || 0);
      // counts 是服务端全局计数（不随筛选变化），直接跟着列表回来，页签不用另发请求
      setCounts(data?.counts || {});
    } catch (err) {
      reportRequestError(message, err, '加载评论失败！');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, keyword, pathFilter]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  /**
   * 所有写操作（改状态 / 编辑 / 删除 / 批量）统一走这里：
   * 成功 → 刷新列表（counts 一起回来，页签计数同步）；
   * 失败 → reportRequestError 兜底（全局 errorHandler 已弹过服务端原因时不会重复弹）；
   * 无论成败 mutating 都在 finally 里收掉，按钮不会一直转圈。
   */
  const runMutation = async (mutation, successText) => {
    setMutating(true);
    try {
      await mutation();
      message.success(successText);
      await fetchList();
      return true;
    } catch (err) {
      reportRequestError(message, err, '操作失败，请稍后重试！');
      return false;
    } finally {
      setMutating(false);
    }
  };

  const changeStatus = (record, nextStatus) =>
    runMutation(
      () => updateComment(record.id, { status: nextStatus }),
      `已标记为「${statusMeta(nextStatus).label}」！`,
    );

  const removeComment = (record) => runMutation(() => deleteComment(record.id), '已删除！');

  // 批量只做了「通过 / 删除」两个高频操作，逐条并发调用现有接口，服务端没有批量路由
  const bulkApprove = () =>
    runMutation(async () => {
      await Promise.all(selectedRowKeys.map((id) => updateComment(id, { status: 'approved' })));
      setSelectedRowKeys([]);
    }, `已批量通过 ${selectedRowKeys.length} 条评论！`);

  const bulkDelete = () =>
    runMutation(async () => {
      await Promise.all(selectedRowKeys.map((id) => deleteComment(id)));
      setSelectedRowKeys([]);
    }, `已批量删除 ${selectedRowKeys.length} 条评论！`);

  const openEdit = (record) => {
    setEditTarget(record);
  };

  // 弹窗带 destroyOnClose，Form 在 visible 变 true 的那次渲染里才挂载；
  // 若在 openEdit 里同步 setFieldsValue，会打在还没接上组件的 form 实例上（antd 会警告），
  // 所以放到 effect 里，等 Modal/Form 挂载完成后再回填。
  useEffect(() => {
    if (editTarget) {
      editForm.setFieldsValue({ nick: editTarget.nick, content: editTarget.content });
    }
  }, [editTarget, editForm]);

  const submitEdit = async () => {
    let values;
    try {
      values = await editForm.validateFields();
    } catch (err) {
      // 表单校验失败：antd 已经在字段旁边标红，不用再弹 toast
      return;
    }
    const ok = await runMutation(
      () => updateComment(editTarget.id, { nick: values.nick, content: values.content }),
      '已保存！',
    );
    // 保存失败时弹窗留着，用户改完可以直接再提交
    if (ok) {
      setEditTarget(null);
    }
  };

  const columns = [
    {
      title: '昵称',
      dataIndex: 'nick',
      width: 170,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={4} wrap>
            <span>{record.nick || '匿名'}</span>
            {record.isAuthor ? <Tag color="blue">作者</Tag> : null}
          </Space>
          {record.parentId ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              回复 @{record.replyToNick || '未知'}
            </Text>
          ) : null}
          {record.email ? (
            <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {record.email}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '内容',
      dataIndex: 'content',
      render: (_, record) => (
        <div style={{ maxWidth: 480 }}>
          {/* 只显示 markdown 源码、不渲染成 HTML：评论内容来自匿名访客，直接渲染等于存储型 XSS */}
          <Paragraph
            style={{ marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
          >
            {record.content}
          </Paragraph>
          {record.reason ? (
            <Text type="warning" style={{ fontSize: 12 }}>
              待审原因：{record.reason}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '文章',
      dataIndex: 'articleId',
      width: 90,
      render: (_, record) => (
        <a href={record.path} target="_blank" rel="noreferrer">
          #{record.articleId}
        </a>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (_, record) => {
        const meta = statusMeta(record.status);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '提交时间',
      dataIndex: 'createdAt',
      width: 110,
      render: (_, record) => (
        <Tooltip title={record.createdAt ? new Date(record.createdAt).toLocaleString() : '-'}>
          <span>{formatTimeAgo(record.createdAt)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 130,
      render: (_, record) => <span style={{ wordBreak: 'break-all' }}>{record.ip || '-'}</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4} wrap>
          {record.status !== 'approved' ? (
            <a onClick={() => changeStatus(record, 'approved')}>通过</a>
          ) : null}
          {record.status !== 'pending' ? (
            <a onClick={() => changeStatus(record, 'pending')}>待审</a>
          ) : null}
          {record.status !== 'spam' ? (
            <a onClick={() => changeStatus(record, 'spam')}>标记垃圾</a>
          ) : null}
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm
            title={
              record.rootId
                ? '确认删除这条评论吗？'
                : '确认删除这条评论吗？删除顶层评论会连带删除它的全部回复'
            }
            okText="删除"
            cancelText="取消"
            onConfirm={() => removeComment(record)}
          >
            <a style={{ color: '#ff4d4f' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Tabs
        activeKey={status}
        onChange={(key) => {
          setStatus(key);
          setPage(1);
          setSelectedRowKeys([]);
        }}
      >
        {statusTabs(counts).map((tab) => (
          <TabPane tab={`${tab.label} (${tab.count})`} key={tab.key} />
        ))}
      </Tabs>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="搜索昵称 / 内容 / 邮箱"
          allowClear
          style={{ width: 240 }}
          onSearch={(value) => {
            setKeyword(String(value || '').trim());
            setPage(1);
          }}
        />
        <Input.Search
          placeholder="按文章路径过滤，如 /post/1"
          allowClear
          style={{ width: 240 }}
          onSearch={(value) => {
            setPathFilter(String(value || '').trim());
            setPage(1);
          }}
        />
        <Button onClick={() => fetchList()}>刷新</Button>
        {selectedRowKeys.length ? (
          <>
            <Text type="secondary">已选 {selectedRowKeys.length} 条</Text>
            <Button size="small" type="primary" loading={mutating} onClick={bulkApprove}>
              批量通过
            </Button>
            <Popconfirm
              title={`确认删除选中的 ${selectedRowKeys.length} 条评论吗？`}
              okText="删除"
              cancelText="取消"
              onConfirm={bulkDelete}
            >
              <Button size="small" danger loading={mutating}>
                批量删除
              </Button>
            </Popconfirm>
          </>
        ) : null}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={list}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
        scroll={{ x: 1080 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50', '100'],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            // 改每页条数时回到第一页，否则 current 可能停在不存在的页码上
            setPage(ps !== pageSize ? 1 : p);
            setPageSize(ps);
            setSelectedRowKeys([]);
          },
        }}
        locale={{
          emptyText: status === 'pending' ? '没有待审核的评论，全部处理完了' : '暂无评论',
        }}
      />
      <Modal
        title={editTarget ? `编辑评论 #${editTarget.id}` : '编辑评论'}
        visible={editTarget !== null}
        confirmLoading={mutating}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        onOk={submitEdit}
        onCancel={() => setEditTarget(null)}
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="nick"
            label="昵称"
            rules={[{ required: true, message: '这是必填项' }]}
            extra="不超过 30 个字符（服务端限制）"
          >
            <Input maxLength={30} placeholder="评论者昵称" />
          </Form.Item>
          <Form.Item
            name="content"
            label="内容（markdown 源码）"
            rules={[{ required: true, message: '这是必填项' }]}
          >
            <Input.TextArea rows={8} placeholder="评论内容" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
