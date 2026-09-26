import ImportDraftModal from '@/components/ImportDraftModal';
import NewDraftModal from '@/components/NewDraftModal';
import RecycleBin from '@/components/RecycleBin';
import { getDraftsByOption } from '@/services/van-blog/api';
import { useNum } from '@/services/van-blog/useNum';
import { PageContainer } from '@ant-design/pro-layout';
import { ProTable } from '@ant-design/pro-table';
import RcResizeObserver from 'rc-resize-observer';
import { useCallback, useMemo, useRef, useState } from 'react';
import { history, useIntl } from 'umi';
import { getColumns, draftKeysObj, draftKeysObjSmall } from './columes';
import { Button, Space, message } from 'antd';
import { batchExport, batchDelete } from '@/services/van-blog/batch';
export default () => {
  const actionRef = useRef();
  const [colKeys, setColKeys] = useState(draftKeysObj);
  // 🔴 这里的 t **必须**用 useCallback([intl]) 包：下面 `useMemo(() => getColumns(t), [t])`
  //    把 t 放进了依赖数组 —— 不稳定的 t 会让每次渲染都重算列 ⇒ ProTable 重建
  //    （本项目已因此踩过"抽屉永远 loading + 打爆限流"的坑，见 §7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const columns = useMemo(() => getColumns(t), [t]);
  const [simplePage, setSimplePage] = useState(false);
  const [simpleSearch, setSimpleSearch] = useState(false);
  const [recycleVisible, setRecycleVisible] = useState(false);
  const [pageSize, setPageSize] = useNum(10, 'draft-page-size');
  const searchSpan = useMemo(() => {
    if (!simpleSearch) {
      return 8;
    } else {
      return 24;
    }
  }, [simpleSearch]);
  return (
    <PageContainer
      title={null}
      extra={null}
      ghost
      header={{ title: null, extra: null, ghost: true }}
      className="t-8"
    >
      <RcResizeObserver
        key="resize-observer"
        onResize={(offset) => {
          setSimpleSearch(offset.width < 750);
          const r = offset.width < 800;
          setSimplePage(offset.width < 600);
          if (r) {
            setColKeys(draftKeysObjSmall);
          } else {
            setColKeys(draftKeysObj);
          }
          //  小屏幕的话把默认的 col keys 删掉一些
        }}
      >
        <ProTable
          columns={columns}
          actionRef={actionRef}
          cardBordered
          rowSelection={{
            fixed: true,
            preserveSelectedRowKeys: true,
          }}
          tableAlertOptionRender={({ selectedRowKeys, onCleanSelected }) => {
            return (
              <Space>
                <a
                  onClick={async () => {
                    await batchDelete(selectedRowKeys, true);
                    message.success(t('draft.batchDeleteOk', '批量删除成功！'));
                    actionRef.current.reload();
                    onCleanSelected();
                  }}
                >
                  {t('draft.batchDelete', '批量删除')}
                </a>
                <a
                  onClick={() => {
                    batchExport(selectedRowKeys, true);
                    onCleanSelected();
                  }}
                >
                  {t('draft.batchExport', '批量导出')}
                </a>
                <a onClick={onCleanSelected}>{t('draft.clearSelection', '取消选择')}</a>
              </Space>
            );
          }}
          request={async (params = {}, sort, filter) => {
            const option = {};
            if (sort.createdAt) {
              if (sort.createdAt == 'ascend') {
                option.sortCreatedAt = 'asc';
              } else {
                option.sortCreatedAt = 'desc';
              }
            }
            if (sort.top) {
              if (sort.top == 'ascend') {
                option.sortTop = 'asc';
              } else {
                option.sortTop = 'desc';
              }
            }

            // 搜索
            const { current, pageSize, ...searchObj } = params;
            if (searchObj) {
              for (const [targetName, target] of Object.entries(searchObj)) {
                switch (targetName) {
                  case 'title':
                    if (target.trim() != '') {
                      option.title = target;
                    }
                    break;
                  case 'tags':
                    if (target.trim() != '') {
                      option.tags = target;
                    }
                    break;
                  case 'endTime':
                    if (searchObj?.startTime) {
                      option.startTime = searchObj?.startTime;
                    }
                    if (searchObj?.endTime) {
                      option.endTime = searchObj?.endTime;
                    }
                    break;
                  case 'category':
                    if (target.trim() != '') {
                      option.category = target;
                    }
                    break;
                }
              }
            }
            option.page = current;
            option.pageSize = pageSize;
            const { data } = await getDraftsByOption(option);
            const { drafts, total } = data;

            return {
              data: drafts,
              // success 请返回 true，
              // 不然 table 会停止解析数据，即使有数据
              success: Boolean(data),
              // 不传会使用 data 的长度，如果是分页一定要传
              total: total,
            };
          }}
          editable={false}
          columnsState={{
            // persistenceKey: 'van-blog-draft-table',
            // persistenceType: 'localStorage',
            value: colKeys,
            onChange(value) {
              setColKeys(value);
            },
          }}
          rowKey="id"
          search={{
            labelWidth: 'auto',
            className: 'searchCard',
            span: searchSpan,
          }}
          pagination={{
            showQuickJumper: true,
            pageSize: pageSize,
            onChange: (p, ps) => {
              if (ps != pageSize) {
                setPageSize(ps);
              }
            },
            simple: simplePage,
          }}
          dateFormatter="string"
          // 🔴 表头标题复用**菜单那一条** `menu.draft`（同一个东西 ⇒ 一处口径，与图片管理/自定义页面同做法）
          headerTitle={simpleSearch ? undefined : t('menu.draft', '草稿管理')}
          options={simpleSearch ? false : true}
          toolBarRender={() => [
            <NewDraftModal
              key="newDraft123"
              onFinish={(data) => {
                actionRef?.current?.reload();
                history.push(`/editor?type=draft&id=${data.id}`);
              }}
            />,
            <ImportDraftModal
              key="importDraftMarkdown"
              onFinish={() => {
                actionRef?.current?.reload();
                message.success(t('draft.importOk', '导入成功！'));
              }}
            />,
            <Button key="draftRecycleBinBtn" onClick={() => setRecycleVisible(true)}>
              {t('draft.recycleBinBtn', '回收站')}
            </Button>,
          ]}
        />
      </RcResizeObserver>
      {/* 草稿回收站：⚠️ 发布成功的草稿也会自动进去（发布即归档）；
          抽屉里有常驻警示，恢复文案对「误删 / 发布归档」两种情况都说真话 */}
      <RecycleBin
        type="draft"
        visible={recycleVisible}
        onClose={() => setRecycleVisible(false)}
        onChanged={() => actionRef?.current?.reload()}
      />
    </PageContainer>
  );
};
