import { deleteComment, getComments, updateComment } from '@/services/van-blog/api';
import { useIntl } from 'umi';
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
  // 🔴 期 6 第十批：接上 i18n（语言选择必须在渲染期，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  // 🔴 t 用 useCallback([intl]) 包成**稳定引用**：本文件的 useCallback 依赖数组里要放 t
  //    （hook 的回调体用了 t 就必须声明它，否则切语言后仍是旧译文 —— §7.144 B），
  //    而不稳定的 t 会让依赖数组每轮都变 ⇒ 重复请求/无限重渲染（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );


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
      reportRequestError(message, err, t('comment.loadFailed', '加载评论失败！'));
    } finally {
      setLoading(false);
    }
    // 🔴 依赖数组必须带 t（回调体里用了它：加载失败/状态标签/空态文案）
  }, [page, pageSize, status, keyword, pathFilter, t]);

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
      reportRequestError(message, err, t('request.defaultError', '操作失败，请稍后重试！'));
      return false;
    } finally {
      setMutating(false);
    }
  };

  const changeStatus = (record, nextStatus) =>
    runMutation(
      () => updateComment(record.id, { status: nextStatus }),
      t('comment.markedAs', '已标记为「{status}」！', { status: statusMeta(nextStatus, t).label }),
    );

  const removeComment = (record) => runMutation(() => deleteComment(record.id), t('comment.deletedToast', '已删除！'));

  // 批量只做了「通过 / 删除」两个高频操作，逐条并发调用现有接口，服务端没有批量路由
  const bulkApprove = () =>
    runMutation(async () => {
      await Promise.all(selectedRowKeys.map((id) => updateComment(id, { status: 'approved' })));
      setSelectedRowKeys([]);
    },
      // 🔴 原来是"模板字符串 + 插值"⇒ 收成一条带 {count} 的 ICU 整句（英文要 plural：1 comment / N comments）
      t('comment.bulkApproved', '已批量通过 {count} 条评论！', { count: selectedRowKeys.length }),
    );

  const bulkDelete = () =>
    runMutation(async () => {
      await Promise.all(selectedRowKeys.map((id) => deleteComment(id)));
      setSelectedRowKeys([]);
    },
      t('comment.bulkDeleted', '已批量删除 {count} 条评论！', { count: selectedRowKeys.length }),
    );

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
      t('comment.savedToast', '已保存！'),
    );
    // 保存失败时弹窗留着，用户改完可以直接再提交
    if (ok) {
      setEditTarget(null);
    }
  };

  const columns = [
    {
      title: t('common.colNickname', '昵称'),
      dataIndex: 'nick',
      width: 170,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Space size={4} wrap>
            <span>{record.nick || t('comment.anonymous', '匿名')}</span>
            {record.isAuthor ? <Tag color="blue">{t('common.colAuthor', '作者')}</Tag> : null}
          </Space>
          {record.parentId ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('comment.replyTo', '回复 @{name}', {
                name: record.replyToNick || t('comment.unknownNick', '未知'),
              })}
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
      title: t('recycle.labelFallback', '内容'),
      dataIndex: 'content',
      render: (_, record) => (
        <div style={{ maxWidth: 480 }}>
          {/* 只显示 markdown 源码、不渲染成 HTML：评论内容来自匿名访客，直接渲染等于存储型 XSS */}
          <Paragraph
            style={{ marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            ellipsis={{ rows: 2, expandable: true, symbol: t('comment.expand', '展开') }}
          >
            {record.content}
          </Paragraph>
          {record.reason ? (
            <Text type="warning" style={{ fontSize: 12 }}>
              {t('comment.pendingReason', '待审原因：{reason}', { reason: record.reason })}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: t('common.article', '文章'),
      dataIndex: 'articleId',
      width: 90,
      render: (_, record) => (
        <a href={record.path} target="_blank" rel="noreferrer">
          #{record.articleId}
        </a>
      ),
    },
    {
      title: t('comment.colStatus', '状态'),
      dataIndex: 'status',
      width: 90,
      render: (_, record) => {
        const meta = statusMeta(record.status, t);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: t('comment.colSubmittedAt', '提交时间'),
      dataIndex: 'createdAt',
      width: 110,
      render: (_, record) => (
        <Tooltip title={record.createdAt ? new Date(record.createdAt).toLocaleString() : '-'}>
          <span>{formatTimeAgo(record.createdAt, t)}</span>
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
      title: t('common.colOption', '操作'),
      key: 'action',
      width: 230,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4} wrap>
          {record.status !== 'approved' ? (
            <a onClick={() => changeStatus(record, 'approved')}>{t('comment.approve', '通过')}</a>
          ) : null}
          {record.status !== 'pending' ? (
            <a onClick={() => changeStatus(record, 'pending')}>{t('comment.pendingShort', '待审')}</a>
          ) : null}
          {record.status !== 'spam' ? (
            <a onClick={() => changeStatus(record, 'spam')}>{t('comment.markSpam', '标记垃圾')}</a>
          ) : null}
          <a onClick={() => openEdit(record)}>{t('common.editPost', '编辑')}</a>
          <Popconfirm
            title={
              record.rootId
                ? t('comment.deleteConfirmTitle', '确认删除这条评论吗？')
                : t('comment.deleteConfirmTitleWithReplies', '确认删除这条评论吗？删除顶层评论会连带删除它的全部回复')
            }
            okText={t('common.delete', '删除')}
            cancelText={t('init.restore.confirmCancel', '取消')}
            onConfirm={() => removeComment(record)}
          >
            <a style={{ color: '#ff4d4f' }}>{t('common.delete', '删除')}</a>
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
        {statusTabs(counts, t).map((tab) => (
          <TabPane tab={`${tab.label} (${tab.count})`} key={tab.key} />
        ))}
      </Tabs>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder={t('comment.searchPlaceholder', '搜索昵称 / 内容 / 邮箱')}
          allowClear
          style={{ width: 240 }}
          onSearch={(value) => {
            setKeyword(String(value || '').trim());
            setPage(1);
          }}
        />
        <Input.Search
          placeholder={t('comment.pathFilterPlaceholder', '按文章路径过滤，如 /post/1')}
          allowClear
          style={{ width: 240 }}
          onSearch={(value) => {
            setPathFilter(String(value || '').trim());
            setPage(1);
          }}
        />
        <Button onClick={() => fetchList()}>{t('recycle.refresh', '刷新')}</Button>
        {selectedRowKeys.length ? (
          <>
            <Text type="secondary">
              {t('comment.selectedCount', '已选 {count} 条', { count: selectedRowKeys.length })}
            </Text>
            <Button size="small" type="primary" loading={mutating} onClick={bulkApprove}>{t('comment.bulkApprove', '批量通过')}</Button>
            <Popconfirm
              title={t('comment.bulkDeleteConfirm', '确认删除选中的 {count} 条评论吗？', {
                count: selectedRowKeys.length,
              })}
              okText={t('common.delete', '删除')}
              cancelText={t('init.restore.confirmCancel', '取消')}
              onConfirm={bulkDelete}
            >
              <Button size="small" danger loading={mutating}>{t('common.batchDelete', '批量删除')}</Button>
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
          showQuickJumper: true,
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50', '100'],
          // 🔴 这个形参原本就叫 `t`（antd 传进来的是**总数**）⇒ 会遮蔽翻译器（本项目"t 遮蔽"那一族）
          //    ⇒ 改名 `total`，并把"共 N 条"收成一条 ICU 整句（英文要用 plural）。
          showTotal: (total) => t('comment.totalCount', '共 {count} 条', { count: total }),
          onChange: (p, ps) => {
            // 改每页条数时回到第一页，否则 current 可能停在不存在的页码上
            setPage(ps !== pageSize ? 1 : p);
            setPageSize(ps);
            setSelectedRowKeys([]);
          },
        }}
        locale={{
          emptyText: status === 'pending' ? t('comment.noPending', '没有待审核的评论，全部处理完了') : t('comment.emptyText', '暂无评论'),
        }}
      />
      <Modal
        title={
          editTarget
            ? t('comment.editTitleWithId', '编辑评论 #{id}', { id: editTarget.id })
            : t('comment.editTitle', '编辑评论')
        }
        visible={editTarget !== null}
        confirmLoading={mutating}
        okText={t('common.save', '保存')}
        cancelText={t('init.restore.confirmCancel', '取消')}
        destroyOnClose
        onOk={submitEdit}
        onCancel={() => setEditTarget(null)}
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="nick"
            label={t('common.colNickname', '昵称')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            extra={t('comment.nickMaxLength', '不超过 30 个字符（服务端限制）')}
          >
            <Input maxLength={30} placeholder={t('comment.nickField', '评论者昵称')} />
          </Form.Item>
          <Form.Item
            name="content"
            label={t('comment.contentField', '内容（markdown 源码）')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          >
            <Input.TextArea rows={8} placeholder={t('comment.contentPlaceholder', '评论内容')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
