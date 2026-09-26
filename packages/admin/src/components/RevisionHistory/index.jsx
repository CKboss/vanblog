import {
  getArticleRevisions,
  getRevisionById,
  restoreArticleRevision,
} from '@/services/van-blog/api';
import { Alert, Button, Drawer, Modal, Space, Spin, Table, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'umi';
import {
  detailEmptyContentText,
  emptyText,
  revisionRestoreConfirmContent,
  revisionRestoreNotAppliedText,
  revisionRestoreOkText,
  classifyRevisionsError,
  classifyRevisionsPayload,
  describeDetailFailure,
  describeRestoreRevisionFailure,
  formatRevisionReason,
  formatRevisionSize,
  formatRevisionWordCount,
  formatSavedAt,
  isNotFoundFailure,
  normalizeRestoreResult,
  normalizeRevisionDetail,
  revisionRestoreConfirmTitle,
  revisionRestoreSuccessText,
} from './revisionCore';

/**
 * 「历史版本」抽屉（极简版，任务明确要求不做 diff / 分支）：
 * - 打开时拉某篇文章的版本列表（只有元数据 + reason：'update'=保存更新、
 *   'pre-restore'=某次恢复前服务端自动存的快照）；
 * - 功能开关以响应的 **data.enabled** 为准（false → 平静地说明「未开启」）；
 *   老 server 没有该字段时退回 404/空列表推断（revisionCore.classifyRevisions*）；
 * - 点「查看」拉单个版本的完整内容，用**只读的 <pre>** 展示 —— 不引新的渲染依赖，
 *   也天然免疫正文里的 HTML（纯文本渲染）；
 * - 「恢复到这个版本」走 **PUT**，确认弹窗说明当前状态会先被存成新版本
 *   （响应里的 snapshotRevisionId 就是它，成功 toast 会点出「可再次恢复」）；
 *   restored:false 按未生效处理（warning，不弹成功）。
 *
 * 所有接口带 skipErrorHandler：失败文案由 revisionCore 按状态码定制，不弹全局 toast 风暴。
 *
 * 入口：文章列表每行的「更多」菜单 + 编辑器「操作」菜单（type=article）。
 * trigger 可外部传入（默认一个 <a>历史版本</a>），模式与 UpdateModal 的触发器一致。
 */
export default function RevisionHistory(props) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。
  // 🔴 本文件的 t **会进 useCallback 的依赖数组**（load / 恢复流程里都用它）⇒ 必须用 useCallback([intl])
  //    包成稳定引用，否则每次渲染都是新函数 ⇒ 无限重渲染/重复请求（§7.144 A 那个坑本项目踩过）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const { articleId, articleTitle, onRestored, trigger } = props;
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const fetchRevisions = useCallback(async () => {
    if (articleId == null || articleId === '') {
      setOutcome({
        kind: 'noid',
        revisions: [],
        text: t('revision.needArticleId', '文章还没有保存过（缺少 ID），保存后再来查看历史版本。'),
      });
      return;
    }
    setLoading(true);
    try {
      const payload = await getArticleRevisions(articleId);
      setOutcome(classifyRevisionsPayload(payload, t));
    } catch (err) {
      setOutcome(classifyRevisionsError(err, t));
    } finally {
      setLoading(false);
    }
    // 🔴 依赖数组必须带上 t：这个 useCallback 的回调体里用了 t（缺 ID 时的提示），
    //    不带就会闭包住**首轮渲染的翻译器** ⇒ 切语言后仍是旧译文（§7.144 B）。
    //    t 本身是 useCallback([intl]) 包过的稳定引用 ⇒ 加进依赖不会造成重复请求。
  }, [articleId, t]);

  useEffect(() => {
    if (visible) {
      setDetail(null);
      setDetailError('');
      fetchRevisions();
    }
  }, [visible, fetchRevisions]);

  const handleView = async (record) => {
    if (record?.id == null) {
      message.error(t('revision.detailMissingId', '这个版本缺少 ID，无法查看'));
      return;
    }
    setDetailLoading(true);
    setDetailError('');
    setDetail(null);
    try {
      const payload = await getRevisionById(articleId, record.id);
      setDetail(normalizeRevisionDetail(payload, t));
    } catch (err) {
      setDetailError(describeDetailFailure(err, t));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRestore = (record) => {
    if (record?.id == null || articleId == null || articleId === '') {
      message.error(t('revision.restoreMissingId', '缺少文章或版本 ID，无法恢复'));
      return;
    }
    Modal.confirm({
      title: revisionRestoreConfirmTitle(record, t),
      // 必须解释清楚：当前状态会先被存成一个新版本，所以恢复是可撤销的
      content: revisionRestoreConfirmContent(t),
      okText: revisionRestoreOkText(t),
      cancelText: t('init.restore.confirmCancel', '取消'),
      onOk: async () => {
        try {
          const payload = await restoreArticleRevision(articleId, record.id);
          const result = normalizeRestoreResult(payload);
          if (result.restored === false) {
            // 接口没抛但服务端明说没生效：不能弹成功
            message.warning(revisionRestoreNotAppliedText(t));
          } else {
            message.success(revisionRestoreSuccessText(record, result, t));
          }
          setDetail(null);
          await fetchRevisions();
          // 编辑器入口用这个回调刷新正文；列表入口用它刷新行数据
          onRestored?.();
        } catch (err) {
          message.error(describeRestoreRevisionFailure(err, t));
          // 404：版本已被清理或属于另一篇文章 —— 刷新列表恢复一致视图
          if (isNotFoundFailure(err)) {
            setDetail(null);
            await fetchRevisions();
          }
        }
      },
    });
  };

  const columns = [
    {
      title: t('revision.colSavedAt', '保存时间'),
      dataIndex: 'savedAt',
      key: 'savedAt',
      width: 170,
      render: (_, record) => formatSavedAt(record?.savedAt),
    },
    {
      title: t('common.colTitle', '标题'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (_, record) => record?.title ?? '-',
    },
    {
      title: t('revision.colWordCount', '字数'),
      dataIndex: 'wordCount',
      key: 'wordCount',
      width: 80,
      render: (_, record) => formatRevisionWordCount(record?.wordCount),
    },
    {
      title: t('img.colBytes', '大小'),
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 100,
      render: (_, record) => formatRevisionSize(record?.sizeBytes),
    },
    {
      // 'pre-restore' 的版本是服务端在某次恢复前自动存的快照 —— 展示出来，
      // 用户才明白为什么有一个自己没主动保存过的版本
      title: t('revision.colReason', '来源'),
      dataIndex: 'reason',
      key: 'reason',
      width: 130,
      render: (_, record) => formatRevisionReason(record?.reason, t),
    },
    {
      title: t('common.colOption', '操作'),
      key: 'option',
      width: 170,
      render: (_, record) => (
        <Space>
          <a data-revision-view={String(record?.id)} onClick={() => handleView(record)}>
            {t('common.view', '查看')}
          </a>
          <a data-revision-restore={String(record?.id)} onClick={() => handleRestore(record)}>
            {t('revision.restoreOkBtn', '恢复到这个版本')}
          </a>
        </Space>
      ),
    },
  ];

  const listPane = (
    <Spin spinning={loading}>
      {outcome && outcome.kind !== 'ok' ? (
        // off / empty / noid / error：都把话说清楚，而不是给一个坏掉的空表格
        <Alert
          type={outcome.kind === 'error' ? 'error' : 'info'}
          showIcon
          message={outcome.text || emptyText(t)}
        />
      ) : (
        <Table
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={outcome?.revisions || []}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showQuickJumper: true }}
        />
      )}
    </Spin>
  );

  const detailPane = (
    <div data-revision-detail>
      <Space style={{ marginBottom: 12 }}>
        <Button
          size="small"
          onClick={() => {
            setDetail(null);
            setDetailError('');
          }}
        >
          {t('revision.backToList', '返回列表')}
        </Button>
        <Button
          size="small"
          type="primary"
          onClick={() => handleRestore(detail)}
          disabled={!detail || detail.id == null}
        >
          {revisionRestoreOkText(t)}
        </Button>
      </Space>
      {detail ? (
        <>
          <div style={{ marginBottom: 8 }} data-revision-detail-meta>
            <Tag color="blue">{detail.title}</Tag>
            <span>{t('revision.savedAt', '保存于 {when}', { when: formatSavedAt(detail.savedAt) })}</span>
            <span style={{ marginLeft: 12 }}>{t('revision.wordCountValue', '字数 {count}', { count: formatRevisionWordCount(detail.wordCount) })}</span>
            <span style={{ marginLeft: 12 }}>{t('revision.sizeValue', '大小 {size}', { size: formatRevisionSize(detail.sizeBytes) })}</span>
            <span style={{ marginLeft: 12 }}>{t('revision.reasonValue', '来源 {reason}', { reason: formatRevisionReason(detail.reason, t) })}</span>
          </div>
          {/* 只读展示：纯 preformatted text，不引任何渲染依赖，正文里的 HTML 也不会被执行 */}
          <pre
            data-revision-content
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '55vh',
              overflow: 'auto',
              background: 'rgba(0,0,0,0.02)',
              border: '1px solid rgba(0,0,0,0.06)',
              borderRadius: 4,
              padding: 12,
              margin: 0,
            }}
          >
            {detail.content || detailEmptyContentText(t)}
          </pre>
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <span data-revision-trigger onClick={() => setVisible(true)}>
        {trigger || <a key="revisionsTrigger">{t('revision.title', '历史版本')}</a>}
      </span>
      <Drawer
        title={articleTitle ? t('revision.titleWithArticle', '历史版本：{title}', { title: articleTitle }) : t('revision.title', '历史版本')}
        width={780}
        visible={visible}
        onClose={() => setVisible(false)}
        destroyOnClose={false}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip={t('revision.loadingDetail', '正在加载版本内容…')} />
          </div>
        ) : detailError ? (
          <Alert type="error" showIcon message={detailError} />
        ) : detail ? (
          detailPane
        ) : (
          listPane
        )}
      </Drawer>
    </>
  );
}
