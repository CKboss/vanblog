import CoverBackfillModal from '@/components/CoverBackfillModal';
import ImportArticleModal from '@/components/ImportArticleModal';
import NewArticleModal from '@/components/NewArticleModal';
import RecycleBin from '@/components/RecycleBin';
import { backfillArticlePathname, getArticlesByOption } from '@/services/van-blog/api';
import { batchExport, batchDelete } from '@/services/van-blog/batch';
import { useNum } from '@/services/van-blog/useNum';
import { PageContainer } from '@ant-design/pro-layout';
import { ProTable } from '@ant-design/pro-table';
import { Button, Modal, Space, message } from 'antd';
import RcResizeObserver from 'rc-resize-observer';
import { useCallback, useMemo, useRef, useState } from 'react';
import { history, useIntl } from 'umi';
import { articleObjAll, articleObjSmall, getColumns } from './columns';

export default () => {
  const actionRef = useRef();
  const [colKeys, setColKeys] = useState(articleObjAll);
  // 🔴 语言选择必须在**渲染期**；而下面 `useMemo(() => getColumns(t), [t])` 把 t 放进了依赖数组 ⇒
  //    t **必须**用 useCallback([intl]) 包成稳定引用（否则每次渲染重算列 ⇒ ProTable 重建，
  //    本项目已因此踩过"抽屉永远 loading + 打爆限流"，见 §7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const columns = useMemo(() => getColumns(t), [t]);
  const [simplePage, setSimplePage] = useState(false);
  const [simpleSearch, setSimpleSearch] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [recycleVisible, setRecycleVisible] = useState(false);
  const [pageSize, setPageSize] = useNum(10, 'article-page-size');
  const searchSpan = useMemo(() => {
    if (!simpleSearch) {
      return 8;
    } else {
      return 24;
    }
  }, [simpleSearch]);

  /** 给没有自定义路径名的老文章补上标题拼音，已有别名不动。 */
  const handleBackfillPathname = () => {
    Modal.confirm({
      title: t('article.genPinyinTitle', '批量生成拼音路径名？'),
      content: t(
        'article.genPinyinContent',
        '为所有「自定义路径名」为空的文章按标题生成汉语拼音路径（重名自动追加 -2、-3）。已有路径名不会被修改，旧的 /post/数字id 链接依然可用。',
      ),
      okText: t('common.generate', '生成'),
      cancelText: t('init.restore.confirmCancel', '取消'),
      onOk: async () => {
        setBackfilling(true);
        try {
          const res = await backfillArticlePathname(false);
          const data = res?.data || {};
          // 🔴 3 个计数收进一条 ICU 模板；⚠️ 英文用**列表式**表达（不逐项加 plural，
          //    那样句子读不成人话；复数守卫只要求"计数紧跟复数名词"时才用 plural）
          message.success(
            t(
              'article.genPinyinDone',
              '已生成 {updated} 个路径名（扫描 {scanned} 篇，跳过 {skipped} 篇）',
              {
                updated: data.updated || 0,
                scanned: data.scanned || 0,
                skipped: data.skipped || 0,
              },
            ),
          );
          actionRef?.current?.reload();
        } finally {
          setBackfilling(false);
        }
      },
    });
  };
  return (
    <PageContainer
      title={null}
      extra={null}
      ghost
      className="t-8"
      header={{ title: null, extra: null, ghost: true }}
    >
      <RcResizeObserver
        key="resize-observer"
        onResize={(offset) => {
          const r = offset.width < 1000;

          setSimpleSearch(offset.width < 750);
          setSimplePage(offset.width < 600);
          if (r) {
            setColKeys(articleObjSmall);
          } else {
            setColKeys(articleObjAll);
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
                    await batchDelete(selectedRowKeys, false, t);
                    message.success(t('common.batchDeleteOk', '批量删除成功！'));
                    actionRef.current.reload();
                    onCleanSelected();
                  }}
                >
                  {t('common.batchDelete', '批量删除')}
                </a>
                <a
                  onClick={() => {
                    batchExport(selectedRowKeys);
                    onCleanSelected();
                  }}
                >
                  {t('common.batchExport', '批量导出')}
                </a>
                <a onClick={onCleanSelected}>{t('common.clearSelection', '取消选择')}</a>
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
            if (sort.viewer) {
              if (sort.viewer == 'ascend') {
                option.sortViewer = 'asc';
              } else {
                option.sortViewer = 'desc';
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
            const { data } = await getArticlesByOption(option);
            const { articles, total } = data;
            return {
              data: articles,
              // success 请返回 true，
              // 不然 table 会停止解析数据，即使有数据
              success: Boolean(data),
              // 不传会使用 data 的长度，如果是分页一定要传
              total: total,
            };
          }}
          editable={false}
          columnsState={{
            // persistenceKey: 'van-blog-article-table',
            // persistenceType: 'localStorage',
            value: colKeys,
            onChange(value) {
              setColKeys(value);
            },
          }}
          rowKey="id"
          search={{
            labelWidth: 'auto',
            span: searchSpan,
            className: 'searchCard',
          }}
          pagination={{
            showQuickJumper: true,
            pageSize: pageSize,
            simple: simplePage,
            onChange: (p, ps) => {
              if (ps != pageSize) {
                setPageSize(ps);
              }
            },
          }}
          dateFormatter="string"
          // 🔴 表头标题复用**菜单那一条** `menu.article`（与图片管理/草稿管理/自定义页面同一套做法）
          headerTitle={simpleSearch ? undefined : t('menu.article', '文章管理')}
          options={simpleSearch ? false : true}
          toolBarRender={() => [
            <Button
              key="editAboutMe"
              onClick={() => {
                history.push(`/editor?type=about&id=${0}`);
              }}
            >
              {t('article.editAbout', '编辑关于')}
            </Button>,
            <NewArticleModal
              key="newArticle123"
              onFinish={(data) => {
                actionRef?.current?.reload();
                history.push(`/editor?type=article&id=${data.id}`);
              }}
            />,
            <ImportArticleModal
              key="importArticleBtn"
              onFinish={() => {
                actionRef?.current?.reload();
                message.success(t('common.importOk', '导入成功！'));
              }}
            />,
            <Button
              key="backfillPathnameBtn"
              loading={backfilling}
              onClick={handleBackfillPathname}
            >
              {t('article.genPinyin', '生成拼音路径')}
            </Button>,
            <Button key="recycleBinBtn" onClick={() => setRecycleVisible(true)}>
              {t('common.recycleBin', '回收站')}
            </Button>,
            // 与其它批量操作并排：组件自带按钮 + 弹窗，打开就先跑 dryRun 预览，
            // 写入成功后留在弹窗里给「撤销本次改动」，同时 reload 列表让新封面立刻可见
            <CoverBackfillModal
              key="coverBackfillBtn"
              onFinish={() => {
                actionRef?.current?.reload();
              }}
            />,
          ]}
        />
      </RcResizeObserver>
      {/* 回收站抽屉：恢复/永久删除后顺带刷新主列表（恢复的文章要立刻可见） */}
      <RecycleBin
        type="article"
        visible={recycleVisible}
        onClose={() => setRecycleVisible(false)}
        onChanged={() => actionRef?.current?.reload()}
      />
    </PageContainer>
  );
};
