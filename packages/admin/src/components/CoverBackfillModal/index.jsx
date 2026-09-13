import { backfillCoversFromContent, revertBackfilledCovers } from '@/services/van-blog/api';
import { summarizeBackfill, toRevertPayload } from '@/services/van-blog/coverBackfill';
import { reportRequestError } from '@/services/van-blog/requestError';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Col, Empty, message, Modal, Row, Space, Spin, Tag } from 'antd';
import { useState } from 'react';

// 一行文本的省略样式：不用 Typography 的 ellipsis（它要量宽度，几十行里跑测量不划算），
// 父容器给了 minWidth:0，纯 CSS 就能截断，鼠标悬停用 title 看全文。
const LINE_STYLE = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const URL_STYLE = {
  ...LINE_STYLE,
  fontSize: 12,
  color: 'rgba(0, 0, 0, 0.45)',
};

const LIST_STYLE = {
  maxHeight: 320,
  overflowY: 'auto',
  marginTop: 8,
};

/**
 * 「从正文首图补封面」：dryRun 预览 → 勾选 → 写入 → 可撤销。
 *
 * 为什么要预览：一次会改几十篇文章的 cover，写错了肉眼很难发现，
 * 所以打开弹窗就先发一次 `dryRun: true`（只统计不写库），确认写入时才发第二次
 * （`dryRun: false` + 用户勾选的 ids）。写入响应里的 items 带 previousCover，
 * 存下来就能精确撤销这一次改动。
 *
 * 权限：文章管理页的工具栏本来就不做前端权限判断（新建/导入/生成拼音路径都一样），
 * 由服务端 AdminGuard 把关；演示站会回 `{ statusCode: 401, message: '演示站禁止修改此项！' }`，
 * 接口刻意不带 skipErrorHandler，这句话由全局 errorHandler 弹出来，
 * 这里 catch 到之后只走 reportRequestError 兜底（它检测到全局已经弹过就不再弹第二条），
 * 因此失败时既不会误报成功，也不会进入撤销阶段。
 */
export default function CoverBackfillModal(props) {
  const { onFinish } = props;
  const [visible, setVisible] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [reverting, setReverting] = useState(false);
  // summary 是 summarizeBackfill() 的结果；result 非空表示已经真的写过库（进入撤销阶段）
  const [summary, setSummary] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [reverted, setReverted] = useState(false);

  const busy = previewLoading || writing || reverting;
  const previewItems = summary?.items || [];
  const allIds = summary?.ids || [];
  const writtenItems = result?.items || [];
  const allSelected = allIds.length > 0 && selectedIds.length === allIds.length;

  /** 预览：只统计不写库，默认全选，用户只做减法。 */
  const runPreview = async () => {
    setPreviewLoading(true);
    setSummary(null);
    setResult(null);
    setReverted(false);
    setSelectedIds([]);
    try {
      const res = await backfillCoversFromContent({ dryRun: true, onlyMissing: true });
      const data = summarizeBackfill(res?.data);
      setSummary(data);
      setSelectedIds(data.ids);
    } catch (err) {
      reportRequestError(message, err, '预览失败！');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpen = () => {
    setVisible(true);
    // 打开弹窗就立刻预览，不用再点一次「扫描」
    runPreview();
  };

  const handleClose = () => {
    // 请求在飞的时候不让关：关了也还要 setState，而且用户看不到结果
    if (busy) {
      return;
    }
    setVisible(false);
  };

  const toggleOne = (id, checked) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((v) => v !== id)));
  };

  /** 确认写入：只写勾选的那几篇，写完把 items（含 previousCover）留给撤销用。 */
  const handleConfirm = async () => {
    if (!selectedIds.length || busy) {
      return;
    }
    setWriting(true);
    try {
      const res = await backfillCoversFromContent({
        dryRun: false,
        onlyMissing: true,
        ids: selectedIds,
      });
      const data = summarizeBackfill(res?.data);
      setResult(data);
      setSelectedIds([]);
      message.success(`已为 ${data.changed} 篇文章补上封面`);
      if (onFinish) {
        // 列表要立刻显示新封面，不能等用户手动刷新
        onFinish();
      }
    } catch (err) {
      reportRequestError(message, err, '写入失败！');
    } finally {
      setWriting(false);
    }
  };

  /** 撤销本次改动：把写入响应里的 previousCover 原样回传（原来没封面就写回空串）。 */
  const handleRevert = async () => {
    if (!writtenItems.length || busy) {
      return;
    }
    setReverting(true);
    try {
      const res = await revertBackfilledCovers(toRevertPayload(writtenItems));
      setReverted(true);
      message.success(`已撤销 ${res?.data?.reverted ?? 0} 篇文章的封面改动`);
      if (onFinish) {
        onFinish();
      }
    } catch (err) {
      reportRequestError(message, err, '撤销失败！');
    } finally {
      setReverting(false);
    }
  };

  // 用 div + Tag 而不是 Space：antd 4 的 Space 不会把 data-* 透传到 DOM，
  // 而摘要这块要给单测/e2e 一个稳定的钩子；Tag 自带右间距，换行也正常。
  const renderRows = (rows) => (
    <div data-cover-backfill-summary>
      {(rows || []).map((row) => (
        <Tag key={row.key} color={row.primary ? 'blue' : undefined} style={{ marginBottom: 4 }}>
          {`${row.label} ${row.value}`}
        </Tag>
      ))}
    </div>
  );

  const renderItem = (item, selectable) => (
    <Col key={item.id} xs={24} sm={12} md={8}>
      <div style={{ display: 'flex', alignItems: 'flex-start', padding: '6px 0' }}>
        {selectable ? (
          <Checkbox
            style={{ marginRight: 8, marginTop: 4 }}
            checked={selectedIds.includes(item.id)}
            onChange={(e) => toggleOne(item.id, e.target.checked)}
          />
        ) : null}
        <img
          // 预览一律先拿 300px 缩略图：几十张原图一起拉会把弹窗卡住
          src={item.thumb || item.cover}
          alt=""
          width={64}
          height={48}
          loading="lazy"
          decoding="async"
          data-cover-backfill-thumb
          style={{
            flex: '0 0 auto',
            marginRight: 8,
            objectFit: 'cover',
            borderRadius: 2,
            background: '#f5f5f5',
          }}
          onError={(e) => {
            // 缩略图是「图片管理 → 补缩略图」手动生成的，老图可能还没有；退回原图。
            // 只退一次：原图也 404 时再赋一次 src 会无限触发 onError。
            const img = e.currentTarget;
            if (img.dataset.coverBackfillFallback === '1' || !item.cover) {
              return;
            }
            img.dataset.coverBackfillFallback = '1';
            img.src = item.cover;
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={LINE_STYLE} title={item.title}>
            {item.title}
          </div>
          <div style={URL_STYLE} title={item.cover}>
            {item.cover}
          </div>
        </div>
      </div>
    </Col>
  );

  const footer = result ? (
    <Space>
      <Button onClick={handleClose}>关闭</Button>
      <Button
        data-cover-backfill-revert
        loading={reverting}
        disabled={!writtenItems.length || reverted}
        onClick={handleRevert}
      >
        {reverted ? '已撤销本次改动' : '撤销本次改动'}
      </Button>
    </Space>
  ) : (
    <Space>
      <Button onClick={handleClose}>取消</Button>
      <Button
        type="primary"
        data-cover-backfill-confirm
        loading={writing}
        // 没选中任何一篇（包括「一条都没匹配上」）或还有请求在飞时，不许提交
        disabled={!selectedIds.length || busy}
        onClick={handleConfirm}
      >
        {`确认写入（${selectedIds.length} 篇）`}
      </Button>
    </Space>
  );

  return (
    <>
      <Button
        title="扫描文章正文，把第一张可用图片补进「封面为空」的文章；先看预览，写入后可撤销"
        onClick={handleOpen}
      >
        从正文首图补封面
      </Button>
      <Modal
        title={result ? '补封面完成' : '从正文首图补封面'}
        visible={visible}
        width={760}
        maskClosable={false}
        onCancel={handleClose}
        footer={footer}
      >
        {result ? (
          <>
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={`已为 ${result.changed} 篇文章补上封面（扫描 ${result.scanned} 篇）`}
              description="如果发现某篇配错了图，点右下角「撤销本次改动」可以把这批文章的封面恢复成写入前的值（原来为空就恢复为空）。"
            />
            {renderRows(result.rows)}
            <div style={LIST_STYLE} data-cover-backfill-written>
              <Row gutter={[8, 0]}>{writtenItems.map((item) => renderItem(item, false))}</Row>
            </div>
          </>
        ) : (
          <Spin spinning={previewLoading} tip="正在扫描文章正文里的首图…">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="只给「封面为空」的文章补，已有封面不会改动；写入前可以先取消勾选个别文章。"
            />
            {summary ? renderRows(summary.rows) : null}
            {!summary && !previewLoading ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="预览没跑起来，点下面按钮重试"
              >
                <Button icon={<ReloadOutlined />} onClick={runPreview}>
                  重新扫描
                </Button>
              </Empty>
            ) : null}
            {summary && !previewItems.length ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={summary.emptyText}
                data-cover-backfill-empty
              />
            ) : null}
            {summary && previewItems.length ? (
              <>
                <Space size={8} wrap style={{ marginTop: 12 }}>
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selectedIds.length > 0 && !allSelected}
                    disabled={busy}
                    onChange={(e) => setSelectedIds(e.target.checked ? allIds : [])}
                  >
                    全选
                  </Checkbox>
                  <Button
                    size="small"
                    type="link"
                    disabled={busy}
                    onClick={() => setSelectedIds(allIds.filter((id) => !selectedIds.includes(id)))}
                  >
                    反选
                  </Button>
                  <span data-cover-backfill-count>
                    {`已选 ${selectedIds.length} / ${allIds.length} 篇`}
                  </span>
                  <Button
                    size="small"
                    type="link"
                    icon={<ReloadOutlined />}
                    loading={previewLoading}
                    onClick={runPreview}
                  >
                    重新扫描
                  </Button>
                </Space>
                <div style={LIST_STYLE} data-cover-backfill-preview>
                  <Row gutter={[8, 0]}>{previewItems.map((item) => renderItem(item, true))}</Row>
                </div>
              </>
            ) : null}
          </Spin>
        )}
      </Modal>
    </>
  );
}
