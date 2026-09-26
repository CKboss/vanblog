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
import { useIntl, useModel } from 'umi';
import {
  RECYCLE_PERMISSIONS,
  describeListFailure,
  describeRecycleActionFailure,
  draftPurgeConfirmContent,
  draftPurgeConfirmTitle,
  draftPurgeSuccessText,
  draftRecycleEmptyText,
  draftRestoreConfirmText,
  draftRestoreConfirmTitle,
  draftRestoreSuccessText,
  formatDeletedAt,
  formatWordCount,
  isNotFoundFailure,
  normalizeDeletedList,
  purgeConfirmContent,
  purgeConfirmTitle,
  purgeOkText,
  purgeSuccessText,
  recycleEmptyText,
  restoreConfirmText,
  restoreConfirmTitle,
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
  // 🔴 语言选择必须在**渲染期**（`useIntl()` 是 hook；模块加载期 umi 插件运行时还没初始化）。
  //    `t()` 的第二个实参是 defaultMessage，必须与 zh-CN 语言包里的值逐字相同（localePackParity 钉住）；
  //    而 recycleCore 里那些文案函数**不传 t 时输出与改造前逐字相同**（它那 30 条既有单测就是证据）。
  const intl = useIntl();
  // 🔴 **必须用 `useCallback` 包**：`t` 会进 `fetchList` 的依赖数组，而"每次渲染新建一个函数"
  //    会让 `useCallback` → `useEffect` 这条链每轮都重跑 ⇒ **实测造成无限请求循环**：
  //    抽屉表格永远 `loading`、一行都不渲染，而且把服务端的 admin 限流打满（后续请求全 429）。
  //    🔴 这个缺陷**单测看不见**（组件根本不跑），只有浏览器活体证据能抓到 ——
  //    诊断线索是 `spin: 1` + `/api/admin/article/deleted` 已经 200 返回了 6 条数据。
  //    `intl` 只在语言变化时换引用 ⇒ 这样既稳定、又能在切语言后拿到新译文。
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
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
        // 🔴 这里原本把 total 解构成 `t` —— 与本组件的翻译器 `t` **同名**（会遮蔽），
        //    而且 try 里的 `t` 与 catch 里的 `t` 含义还不一样 ⇒ 改名，别留这种坑。
        const { articles: list, total: rowCount } = normalizeDeletedList(res, t);
        setArticles(list);
        setTotal(rowCount);
        // 删完最后一页的最后一篇时页码会越界：夹回最后一页，别停在空页上
        if (list.length === 0 && rowCount > 0 && p > 1) {
          const lastPage = Math.max(1, Math.ceil(rowCount / ps));
          if (lastPage !== p) {
            setPage(lastPage);
          }
        }
      } catch (err) {
        setArticles([]);
        setTotal(0);
        setErrorText(describeListFailure(err, t));
      } finally {
        setLoading(false);
      }
    },
    [isDraft, t],
  );

  useEffect(() => {
    if (visible) {
      fetchList(page, pageSize);
    }
  }, [visible, page, pageSize, fetchList]);

  const handleRestore = async (record) => {
    if (record?.id == null) {
      message.error(t('recycle.missingIdRestore', '这条记录缺少 ID，无法恢复'));
      return;
    }
    setBusyId(record.key);
    try {
      if (isDraft) {
        await restoreDraft(record.id);
        message.success(draftRestoreSuccessText(record, t));
      } else {
        await restoreArticle(record.id);
        message.success(restoreSuccessText(record, t));
      }
      await fetchList(page, pageSize);
      // 恢复后主列表要能看到这条内容
      onChanged?.();
    } catch (err) {
      message.error(
        describeRecycleActionFailure(err, {
          // 🔴 传 **key** 而不是中文：这些词会被插进句子里，传中文的话英文界面会出现夹生句
          actionKey: 'restore',
          labelKey: isDraft ? 'draft' : 'article',
          permission: perms.restore,
          t,
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
      message.error(t('recycle.missingIdPurge', '这条记录缺少 ID，无法永久删除'));
      return;
    }
    Modal.confirm({
      title: isDraft ? draftPurgeConfirmTitle(record, t) : purgeConfirmTitle(record, t),
      content: isDraft ? draftPurgeConfirmContent(t) : purgeConfirmContent(t),
      okText: purgeOkText(t),
      // 危险操作要长得危险：红色按钮 + 明确「不可撤销」
      okButtonProps: { danger: true },
      cancelText: t('init.restore.confirmCancel', '取消'),
      onOk: async () => {
        try {
          if (isDraft) {
            await purgeDraft(record.id);
            message.success(draftPurgeSuccessText(record, t));
          } else {
            await purgeArticle(record.id);
            message.success(purgeSuccessText(record, t));
          }
          await fetchList(page, pageSize);
          onChanged?.();
        } catch (err) {
          // purge 只对已在回收站的条目有效（否则 404）：给出人话并刷新
          message.error(
            describeRecycleActionFailure(err, {
              actionKey: 'purge',
              labelKey: isDraft ? 'draft' : 'article',
              permission: perms.purge,
              t,
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
    // 🔴 用 common.colTitle（从 recycle.colTitle 提升）：图片管理页的「被引用文章」弹窗也要用它
    title: t('common.colTitle', '标题'),
    dataIndex: 'title',
    key: 'title',
    ellipsis: true,
    render: (text, record) => <span title={record?.title}>{record?.title ?? '-'}</span>,
  };
  const categoryColumn = {
    // 🔴 提升为 common.colCategory：草稿/文章列表的「分类」列与这里是同一个性质
    title: t('common.colCategory', '分类'),
    dataIndex: 'category',
    key: 'category',
    width: 100,
    ellipsis: true,
    render: (_, record) => record?.category || '-',
  };
  const tagsColumn = {
    title: t('common.colTags', '标签'),
    dataIndex: 'tags',
    key: 'tags',
    width: 140,
    render: (_, record) =>
      record?.tags?.length
        ? // 🔴 这里的 map 参数原本也叫 `t`（与翻译器同名、会遮蔽）⇒ 改名 tag
          record.tags.map((tag) => (
            <Tag key={`recycle-tag-${record.key}-${tag}`} style={{ marginBottom: 4 }}>
              {tag}
            </Tag>
          ))
        : '-',
  };
  const updatedAtColumn = {
    title: t('recycle.colUpdatedAt', '更新时间'),
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    width: 160,
    render: (_, record) => formatDeletedAt(record?.updatedAt),
  };
  const deletedAtColumn = {
    title: t('recycle.colDeletedAt', '删除时间'),
    dataIndex: 'deletedAt',
    key: 'deletedAt',
    width: 160,
    render: (_, record) => formatDeletedAt(record?.deletedAt),
  };
  const optionColumn = {
    // 🔴 用 common.colOption（从 recycle.colOption 提升）：这一列头在回收站与 Token 页是同一个性质 ⇒ 一个 key
    title: t('common.colOption', '操作'),
    key: 'option',
    width: 150,
    render: (_, record) => (
      <Space>
        {canRestore ? (
          <Popconfirm
            title={
              <div style={{ maxWidth: isDraft ? 340 : 260 }}>
                <div>{isDraft ? draftRestoreConfirmTitle(t) : restoreConfirmTitle(t)}</div>
                <div style={{ color: 'rgba(0,0,0,0.45)' }}>
                  {isDraft ? draftRestoreConfirmText(t) : restoreConfirmText(t)}
                </div>
              </div>
            }
            okText={t('recycle.restore', '恢复')}
            cancelText={t('init.restore.confirmCancel', '取消')}
            disabled={busyId === record?.key}
            onConfirm={() => handleRestore(record)}
          >
            <a data-recycle-restore={String(record?.id)}>{t('recycle.restore', '恢复')}</a>
          </Popconfirm>
        ) : null}
        {/* 永久删除用 Modal.confirm（danger 按钮），文案明说不可撤销；无权限直接不渲染 */}
        {canPurge ? (
          <a
            style={{ color: '#ff4d4f' }}
            data-recycle-purge={String(record?.id)}
            onClick={() => handlePurge(record)}
          >
            {t('recycle.purge', '永久删除')}
          </a>
        ) : null}
        {!canRestore && !canPurge ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            {t('recycle.noPermission', '当前账号无操作权限')}
          </span>
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
          title: t('common.colAuthor', '作者'),
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
          title: t('recycle.colPathname', '别名'),
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
          title: t('recycle.colWordCount', '字数'),
          dataIndex: 'wordCount',
          key: 'wordCount',
          width: 80,
          render: (_, record) => formatWordCount(record?.wordCount),
        },
        optionColumn,
      ];

  return (
    <Drawer
      title={
        isDraft
          ? t('recycle.drawerTitleDraft', '回收站（已删除的草稿）')
          : t('recycle.drawerTitleArticle', '回收站（已删除的文章）')
      }
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
          {t('recycle.refresh', '刷新')}
        </Button>
      </div>
      {isDraft ? (
        // 常驻警示：列表非空时空状态文案看不见，陷阱说明必须一直摆在这
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-recycle-draft-warning
          message={t('recycle.draftWarningTitle', '发布成功的草稿也会自动进入回收站')}
          description={t(
            'recycle.draftWarningDesc',
            '恢复只作用于草稿本身，不会改动已发布的文章：如果某条草稿是发布时归档进来的，恢复它只会得到一份发布前的旧草稿，再次编辑并发布会产生一篇重复的文章。列表本身无法区分「误删」与「发布后归档」这两种情况，恢复前请留意。',
          )}
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
            ? t('recycle.listLoadFailed', '列表加载失败，见上方提示。')
            : isDraft
              ? draftRecycleEmptyText(t)
              : recycleEmptyText(t),
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
