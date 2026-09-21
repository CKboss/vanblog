import {
  getDeletedArticles,
  getDeletedDrafts,
  purgeArticle,
  purgeDraft,
  restoreArticle,
  restoreDraft,
} from '@/services/van-blog/api';
import { Alert, Button, Drawer, Modal, Popconfirm, Space, Table, Tag, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useModel } from 'umi';
import {
  DRAFT_PURGE_CONFIRM_CONTENT,
  DRAFT_RECYCLE_EMPTY_TEXT,
  DRAFT_RESTORE_CONFIRM_TEXT,
  DRAFT_RESTORE_CONFIRM_TITLE,
  PURGE_CONFIRM_CONTENT,
  PURGE_OK_TEXT,
  RECYCLE_EMPTY_TEXT,
  RECYCLE_PERMISSIONS,
  RESTORE_CONFIRM_TEXT,
  RESTORE_CONFIRM_TITLE,
  describeListFailure,
  describeRecycleActionFailure,
  draftPurgeConfirmTitle,
  draftPurgeSuccessText,
  draftRestoreSuccessText,
  formatDeletedAt,
  formatWordCount,
  isNotFoundFailure,
  normalizeDeletedList,
  purgeConfirmTitle,
  purgeSuccessText,
  restoreSuccessText,
} from './recycleCore';

/**
 * 回收站抽屉：「已删除」文章/草稿列表 + 恢复 / 永久删除（type 属性区分）。
 *
 * 为什么是列表页工具栏里的抽屉，而不是新菜单项/新路由：回收站是对应列表的
 * 派生状态（从那里删出来的），放在同一个页面的工具栏里最符合现有信息架构，
 * 也不用动 routes.js 和菜单 —— 草稿/文章是一等内容才配一级菜单，垃圾桶不是。
 *
 * ⚠️ 草稿回收站的语义陷阱（recycleCore.js 文件头有完整版）：发布成功的草稿也会
 * 自动进入回收站，而 payload 无法区分「误删」与「发布归档」。恢复发布归档的草稿
 * **不会撤销发布**，只会复活一份旧草稿。所以草稿模式下抽屉顶部常驻一条警示，
 * 确认弹窗与成功提示的文案也对两种情况都说真话 —— UI 不许暗示后端做不到的事。
 *
 * 权限：restore 需要 article:update / draft:update，purge 需要 article:delete /
 * draft:delete（server 侧硬校验）。这里按 initialState.user.permissions 直接
 * 隐藏入口（模式与 Static/img 的 showDelBtn 一致），403 只是兜底文案而不是常态。
 *
 * 契约与防御性见 ./recycleCore.js。列表加载失败（含 server 未实现时的 404）
 * 走抽屉内 Alert，不弹全局 toast（api 层全部带 skipErrorHandler）。
 */

/** 超管（id==0）全权限；协作者看 permissions（'all' 或具体权限名）。与 Static/img 同款判定。 */
function hasPermission(initialState, permission) {
  const user = initialState?.user;
  if (!user) {
    return false;
  }
  if (user.id == 0) {
    return true;
  }
  const ps = user.permissions || [];
  return ps.includes(permission) || ps.includes('all');
}

export default function RecycleBin(props) {
  const { type = 'article', visible, onClose, onChanged } = props;
  const isDraft = type === 'draft';
  const { initialState } = useModel('@@initialState');
  const perms = RECYCLE_PERMISSIONS[type] || RECYCLE_PERMISSIONS.article;
  const canRestore = useMemo(
    () => hasPermission(initialState, perms.restore),
    [initialState, perms],
  );
  const canPurge = useMemo(() => hasPermission(initialState, perms.purge), [initialState, perms]);

  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [articles, setArticles] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyId, setBusyId] = useState(null);

  const fetchList = useCallback(
    async (p, ps) => {
      setLoading(true);
      setErrorText('');
      try {
        const res = isDraft ? await getDeletedDrafts(p, ps) : await getDeletedArticles(p, ps);
        const { articles: list, total: t } = normalizeDeletedList(res);
        setArticles(list);
        setTotal(t);
        // 删完最后一页的最后一篇时页码会越界：夹回最后一页，别停在空页上
        if (list.length === 0 && t > 0 && p > 1) {
          const lastPage = Math.max(1, Math.ceil(t / ps));
          if (lastPage !== p) {
            setPage(lastPage);
          }
        }
      } catch (err) {
        setArticles([]);
        setTotal(0);
        setErrorText(describeListFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [isDraft],
  );

  useEffect(() => {
    if (visible) {
      fetchList(page, pageSize);
    }
  }, [visible, page, pageSize, fetchList]);

  const handleRestore = async (record) => {
    if (record?.id == null) {
      message.error('这条记录缺少 ID，无法恢复');
      return;
    }
    setBusyId(record.key);
    try {
      if (isDraft) {
        await restoreDraft(record.id);
        message.success(draftRestoreSuccessText(record));
      } else {
        await restoreArticle(record.id);
        message.success(restoreSuccessText(record));
      }
      await fetchList(page, pageSize);
      // 恢复后主列表要能看到这条内容
      onChanged?.();
    } catch (err) {
      message.error(
        describeRecycleActionFailure(err, {
          action: '恢复',
          label: isDraft ? '草稿' : '文章',
          permission: perms.restore,
        }),
      );
      // 404 = 已不在回收站（别人恢复/清除了）：刷新列表恢复一致视图
      if (isNotFoundFailure(err)) {
        await fetchList(page, pageSize);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handlePurge = (record) => {
    if (record?.id == null) {
      message.error('这条记录缺少 ID，无法永久删除');
      return;
    }
    Modal.confirm({
      title: isDraft ? draftPurgeConfirmTitle(record) : purgeConfirmTitle(record),
      content: isDraft ? DRAFT_PURGE_CONFIRM_CONTENT : PURGE_CONFIRM_CONTENT,
      okText: PURGE_OK_TEXT,
      // 危险操作要长得危险：红色按钮 + 明确「不可撤销」
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          if (isDraft) {
            await purgeDraft(record.id);
            message.success(draftPurgeSuccessText(record));
          } else {
            await purgeArticle(record.id);
            message.success(purgeSuccessText(record));
          }
          await fetchList(page, pageSize);
          onChanged?.();
        } catch (err) {
          // purge 只对已在回收站的条目有效（否则 404）：给出人话并刷新
          message.error(
            describeRecycleActionFailure(err, {
              action: '永久删除',
              label: isDraft ? '草稿' : '文章',
              permission: perms.purge,
            }),
          );
          if (isNotFoundFailure(err)) {
            await fetchList(page, pageSize);
          }
        }
      },
    });
  };

  const titleColumn = {
    title: '标题',
    dataIndex: 'title',
    key: 'title',
    ellipsis: true,
    render: (text, record) => <span title={record?.title}>{record?.title ?? '-'}</span>,
  };
  const categoryColumn = {
    title: '分类',
    dataIndex: 'category',
    key: 'category',
    width: 100,
    ellipsis: true,
    render: (_, record) => record?.category || '-',
  };
  const tagsColumn = {
    title: '标签',
    dataIndex: 'tags',
    key: 'tags',
    width: 140,
    render: (_, record) =>
      record?.tags?.length
        ? record.tags.map((t) => (
            <Tag key={`recycle-tag-${record.key}-${t}`} style={{ marginBottom: 4 }}>
              {t}
            </Tag>
          ))
        : '-',
  };
  const updatedAtColumn = {
    title: '更新时间',
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    width: 160,
    render: (_, record) => formatDeletedAt(record?.updatedAt),
  };
  const deletedAtColumn = {
    title: '删除时间',
    dataIndex: 'deletedAt',
    key: 'deletedAt',
    width: 160,
    render: (_, record) => formatDeletedAt(record?.deletedAt),
  };
  const optionColumn = {
    title: '操作',
    key: 'option',
    width: 150,
    render: (_, record) => (
      <Space>
        {canRestore ? (
          <Popconfirm
            title={
              <div style={{ maxWidth: isDraft ? 340 : 260 }}>
                <div>{isDraft ? DRAFT_RESTORE_CONFIRM_TITLE : RESTORE_CONFIRM_TITLE}</div>
                <div style={{ color: 'rgba(0,0,0,0.45)' }}>
                  {isDraft ? DRAFT_RESTORE_CONFIRM_TEXT : RESTORE_CONFIRM_TEXT}
                </div>
              </div>
            }
            okText="恢复"
            cancelText="取消"
            disabled={busyId === record?.key}
            onConfirm={() => handleRestore(record)}
          >
            <a data-recycle-restore={String(record?.id)}>恢复</a>
          </Popconfirm>
        ) : null}
        {/* 永久删除用 Modal.confirm（danger 按钮），文案明说不可撤销；无权限直接不渲染 */}
        {canPurge ? (
          <a
            style={{ color: '#ff4d4f' }}
            data-recycle-purge={String(record?.id)}
            onClick={() => handlePurge(record)}
          >
            永久删除
          </a>
        ) : null}
        {!canRestore && !canPurge ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>当前账号无操作权限</span>
        ) : null}
      </Space>
    ),
  };

  // 文章：标题/别名/分类/标签/更新时间/删除时间/字数；草稿契约没有 pathname/wordCount，但有 author
  const columns = isDraft
    ? [
        titleColumn,
        categoryColumn,
        tagsColumn,
        {
          title: '作者',
          dataIndex: 'author',
          key: 'author',
          width: 100,
          ellipsis: true,
          render: (_, record) => record?.author || '-',
        },
        updatedAtColumn,
        deletedAtColumn,
        optionColumn,
      ]
    : [
        titleColumn,
        {
          title: '别名',
          dataIndex: 'pathname',
          key: 'pathname',
          width: 140,
          ellipsis: true,
          render: (_, record) => record?.pathname || '-',
        },
        categoryColumn,
        tagsColumn,
        updatedAtColumn,
        deletedAtColumn,
        {
          title: '字数',
          dataIndex: 'wordCount',
          key: 'wordCount',
          width: 80,
          render: (_, record) => formatWordCount(record?.wordCount),
        },
        optionColumn,
      ];

  return (
    <Drawer
      title={isDraft ? '回收站（已删除的草稿）' : '回收站（已删除的文章）'}
      width={920}
      visible={visible}
      onClose={onClose}
      destroyOnClose={false}
    >
      <div
        style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}
        data-recycle-toolbar
      >
        <Button
          size="small"
          loading={loading}
          onClick={() => {
            fetchList(page, pageSize);
          }}
        >
          刷新
        </Button>
      </div>
      {isDraft ? (
        // 常驻警示：列表非空时空状态文案看不见，陷阱说明必须一直摆在这
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-recycle-draft-warning
          message="发布成功的草稿也会自动进入回收站"
          description={
            '恢复只作用于草稿本身，不会改动已发布的文章：如果某条草稿是发布时归档进来的，' +
            '恢复它只会得到一份发布前的旧草稿，再次编辑并发布会产生一篇重复的文章。' +
            '列表本身无法区分「误删」与「发布后归档」这两种情况，恢复前请留意。'
          }
        />
      ) : null}
      {errorText ? (
        <Alert type="error" showIcon message={errorText} style={{ marginBottom: 12 }} />
      ) : null}
      <Table
        size="small"
        rowKey="key"
        loading={loading}
        columns={columns}
        dataSource={articles}
        locale={{
          emptyText: errorText
            ? '列表加载失败，见上方提示。'
            : isDraft
              ? DRAFT_RECYCLE_EMPTY_TEXT
              : RECYCLE_EMPTY_TEXT,
        }}
        pagination={{
          showQuickJumper: true,
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, ps) => {
            setPage(p);
            if (ps !== pageSize) {
              setPageSize(ps);
            }
          },
        }}
      />
    </Drawer>
  );
}
