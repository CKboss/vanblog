import CopyUploadBtn from '@/components/CopyUploadBtn';
import ObjTable from '@/components/ObjTable';
import UploadBtn from '@/components/UploadBtn';
import {
  backfillThumbnails,
  deleteImgBySign,
  detectStegoByFile,
  detectStegoBySign,
  getImgReferences,
  getImgs,
  replaceImgBySign,
  searchArtclesByLink,
} from '@/services/van-blog/api';
import { PageContainer } from '@ant-design/pro-components';
import {
  Button,
  Empty,
  Image,
  message,
  Modal,
  Pagination,
  Popover,
  Radio,
  Space,
  Spin,
  Table,
  Upload,
} from 'antd';
import RcResizeObserver from 'rc-resize-observer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Item, Menu, Separator, useContextMenu } from 'react-contexify';
import 'react-contexify/dist/ReactContexify.css';
import { createPortal } from 'react-dom';
import { history, useModel } from 'umi';
import TipTitle from '../../../components/TipTitle';
import { useTab } from '../../../services/van-blog/useTab';
import type { StaticItem } from '../type';
import {
  copyImgLink,
  displayImgName,
  downloadImg,
  formatDateTime,
  getImgLink,
  getThumbLink,
  mergeMetaInfo,
} from './tools';
const MENU_ID = 'static-img';
/** 展示模式：小缩略图（默认，一屏最多）/ 大图（看得清）/ 列表（带信息和操作） */
const VIEW_MODE_KEY = 'van-blog-admin-img-view-mode';
type ViewMode = 'thumb' | 'large' | 'list';

/** 每种模式一屏放多少张：小图模式就是为了"一次看更多"。 */
const PAGE_SIZE: Record<ViewMode, { desktop: number; mobile: number }> = {
  thumb: { desktop: 60, mobile: 24 },
  large: { desktop: 15, mobile: 9 },
  list: { desktop: 20, mobile: 10 },
};
/** 网格列数与列宽。 */
const GRID: Record<'thumb' | 'large', { desktop: [number, string]; mobile: [number, string] }> = {
  thumb: { desktop: [12, '7.6%'], mobile: [6, '15%'] },
  large: { desktop: [5, '18.5%'], mobile: [3, '30%'] },
};
export const errorImg =
  'data:image/png;base64,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';

function Portal({ children }) {
  return createPortal(children, document.querySelector('#root'));
}

const ImgPage = () => {
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [page, setPage] = useTab(1, 'page');
  const [responsive, setResponsive] = useState(false);
  const [clickItem, setClickItem] = useState<StaticItem>();
  const [backfilling, setBackfilling] = useState(false);
  /** 引用文章数：realPath -> {count, articles} */
  const [refs, setRefs] = useState<Record<string, any>>({});
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    const saved = window.localStorage.getItem(VIEW_MODE_KEY);
    return saved === 'large' || saved === 'list' ? saved : 'thumb';
  });
  const { initialState } = useModel('@@initialState');
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<StaticItem | null>(null);

  const pageSize = PAGE_SIZE[viewMode][responsive ? 'mobile' : 'desktop'];

  const setViewMode = (mode: ViewMode) => {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
    setViewModeState(mode);
    // 每页数量跟着模式变，回到第一页，不然容易停在空白页
    (setPage as any)(1);
  };

  const showDelBtn = useMemo(() => {
    if (!initialState?.user) {
      return false;
    }
    if (initialState?.user?.id == 0) {
      return true;
    } else {
      const ps = initialState?.user?.permissions;
      if (!ps || ps.length == 0) {
        return false;
      } else {
        if (ps.includes('img:delete') || ps.includes('all')) {
          return true;
        }
        return false;
      }
    }
  }, [initialState]);

  const showReplaceBtn = useMemo(() => {
    const user: any = initialState?.user;
    if (!user) {
      return false;
    }
    if (user.id == 0) {
      return true;
    }
    const ps = user.permissions || [];
    return ps.includes('img:replace') || ps.includes('all');
  }, [initialState]);

  const showBackfillBtn = useMemo(() => {
    const user: any = initialState?.user;
    if (!user) {
      return false;
    }
    if (user.id == 0) {
      return true;
    }
    const ps = user.permissions || [];
    return ps.includes('all');
  }, [initialState]);

  function showDetectResult(res: any, title: string) {
    const d = res?.data || {};
    Modal.info({
      title,
      width: 560,
      content: d.found ? (
        <div>
          <p>检测到本站的隐写水印：</p>
          <p style={{ wordBreak: 'break-all' }}>
            <b>{d.payload}</b>
          </p>
          <p style={{ color: '#888' }}>
            尺寸 {d.width}×{d.height}，重复度 {d.repetition}，擦边 bit {d.uncertain ?? 0}
          </p>
        </div>
      ) : (
        <div>
          <p>没有检测到本站水印。</p>
          <p style={{ color: '#888' }}>
            常见原因：不是本站上传的图；上传时「隐写水印」是关着的；图片被缩放/裁剪过；
            或者站点换过水印密钥。
          </p>
        </div>
      ),
    });
  }

  async function handleDetectFile(file: File) {
    setLoading(true);
    try {
      const res = await detectStegoByFile(file);
      showDetectResult(res, `检测水印：${file.name}`);
    } catch (err) {
      message.error('检测失败！');
    } finally {
      setLoading(false);
    }
  }

  function handleBackfill() {
    Modal.confirm({
      title: '为所有图片生成缩略图？',
      content: '已经有缩略图的会跳过，只处理本地存储的图片；图片多时可能要等一会儿。',
      onOk: async () => {
        setBackfilling(true);
        try {
          const res: any = await backfillThumbnails(false);
          const d = res?.data || {};
          message.success(
            `共 ${d.total ?? 0} 张：新生成 ${d.generated ?? 0}，已存在 ${d.existed ?? 0}，跳过 ${
              d.skipped ?? 0
            }，失败 ${d.failed ?? 0}`,
          );
          fetchData();
        } catch (err) {
          message.error('补缩略图失败！');
        } finally {
          setBackfilling(false);
        }
      },
    });
  }

  const { show } = useContextMenu({
    id: MENU_ID,
  });
  async function deleteImg(sign: string) {
    const target = clickItem?.sign === sign ? clickItem : data.find((i: StaticItem) => i.sign === sign);
    try {
      setLoading(true);
      await deleteImgBySign(sign);
      setLoading(false);
      message.success(
        `删除成功！${target?.storageType == 'picgo' ? '但是 OSS 存储中并未删除哦' : '已彻底删除'}`,
      );
    } catch (err) {
      message.error('删除失败！');
    }
    fetchData();
  }

  /** 替换：走隐藏 input，右键菜单和列表按钮共用一套逻辑 */
  function askReplace(item: StaticItem) {
    replaceTargetRef.current = item;
    replaceInputRef.current?.click();
  }

  function handleReplace(item: StaticItem, file: File) {
    Modal.confirm({
      title: '替换这张图片？',
      width: 540,
      content: (
        <div>
          <p>链接保持不变，文章里的引用会自动指向新图：</p>
          <p style={{ wordBreak: 'break-all', color: '#888' }}>{item.realPath}</p>
          <p>新文件同样会走缩放 / 隐写水印 / 压缩，并重新生成缩略图。原内容不可恢复。</p>
        </div>
      ),
      onOk: async () => {
        setLoading(true);
        try {
          const res: any = await replaceImgBySign(item.sign, file);
          if (res?.statusCode === 200) {
            message.success('替换成功！链接没有变化。');
            fetchData();
          } else {
            message.error(res?.message || '替换失败！');
          }
        } catch (err: any) {
          message.error(err?.message || '替换失败！');
        } finally {
          setLoading(false);
        }
      },
    });
  }
  async function handleItemClick({ event, props, triggerEvent, data }) {
    switch (data) {
      case 'info':
        Modal.info({
          title: '图片信息',
          content: (
            <div>
              <ObjTable obj={mergeMetaInfo(clickItem)} />
            </div>
          ),
        });
        break;
      case 'copy':
        copyImgLink(clickItem.realPath);
        break;
      case 'copyMarkdown':
        copyImgLink(clickItem.realPath, true, undefined, false);
        break;
      case 'copyMarkdownAbsolutely':
        copyImgLink(clickItem.realPath, true, undefined, true);
        break;
      case 'delete':
        Modal.confirm({
          title: '确定删除该图片吗？删除后不可恢复！',
          onOk: () => {
            deleteImg(clickItem.sign);
          },
        });
        break;
      case 'download':
        downloadImg(clickItem.name, clickItem.realPath);
        break;
      case 'detectStego': {
        const res: any = await detectStegoBySign(clickItem.sign);
        showDetectResult(res, `检测水印：${displayImgName(clickItem.name)}`);
        break;
      }
      case 'replace':
        askReplace(clickItem);
        break;
      case 'searchByLink':
        const { data } = await searchArtclesByLink(getImgLink(clickItem.realPath));
        Modal.info({
          title: '被引用文章',

          content: (
            <Table
              pagination={{
                hideOnSinglePage: true,
              }}
              rowKey={'id'}
              dataSource={data || []}
              size="small"
              columns={[
                { title: '文章 ID', dataIndex: 'id', key: 'id' },
                { title: '标题', dataIndex: 'title', key: 'title' },
                {
                  title: '操作',
                  key: 'action',
                  render: (val, record) => {
                    return (
                      <a
                        key={'editable' + record.id}
                        onClick={() => {
                          history.push(`/editor?type=${'article'}&id=${record.id}`);
                        }}
                      >
                        编辑
                      </a>
                    );
                  },
                },
              ]}
            />
          ),
        });
        // console.log(data);
        break;
    }
  }

  function displayMenu(e, item: StaticItem) {
    // put whatever custom logic you need
    // you can even decide to not display the Menu
    setClickItem(item);

    show(e);
  }
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: res } = await getImgs(page, pageSize as number);
      setTotal(res.total || 0);
      setData(res.data);
    } catch (err) {
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setData, page, pageSize, setTotal, setLoading]);
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  const thumbMode = viewMode === 'thumb';
  const listMode = viewMode === 'list';
  const gridCols = GRID[thumbMode ? 'thumb' : 'large'][responsive ? 'mobile' : 'desktop'];

  // 列表视图才需要「引用文章」，一次批量查完这一页，避免每行一个请求
  useEffect(() => {
    if (!listMode || !data.length) {
      setRefs({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res: any = await getImgReferences(data.map((item: StaticItem) => item.realPath));
        if (!cancelled) {
          setRefs(res?.data || {});
        }
      } catch (err) {
        // 引用数只是辅助信息，查不到就算了
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listMode, data]);

  const columns = [
    {
      title: '图片',
      dataIndex: 'realPath',
      width: 84,
      render: (_: any, record: StaticItem) => (
        <Image
          fallback={errorImg}
          src={getThumbLink(record)}
          preview={{ src: getImgLink(record.realPath) }}
          style={{ maxHeight: 48, maxWidth: 64, objectFit: 'contain' }}
        />
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
      render: (_: any, record: StaticItem) => (
        <a href={getImgLink(record.realPath)} target="_blank" rel="noreferrer" title={record.name}>
          {displayImgName(record.name)}
        </a>
      ),
    },
    {
      title: '格式',
      dataIndex: 'fileType',
      width: 72,
      render: (value: string) => (value ? String(value).toUpperCase() : '-'),
    },
    {
      title: '尺寸',
      width: 108,
      render: (_: any, record: StaticItem) => {
        const meta: any = record.meta || {};
        return meta.width ? `${meta.width}×${meta.height}` : '-';
      },
    },
    {
      title: '大小',
      width: 92,
      render: (_: any, record: StaticItem) => (record.meta as any)?.size || '-',
    },
    {
      title: '上传时间',
      dataIndex: 'updatedAt',
      width: 168,
      render: (value: any) => formatDateTime(value),
    },
    {
      title: '引用文章',
      width: 116,
      render: (_: any, record: StaticItem) => {
        const info = refs[record.realPath];
        if (!info) {
          return <span style={{ color: '#bbb' }}>…</span>;
        }
        if (!info.count) {
          return <span style={{ color: '#bbb' }}>未被引用</span>;
        }
        return (
          <Popover
            title={`被 ${info.count} 篇文章引用`}
            content={
              <div style={{ maxWidth: 320 }}>
                {(info.articles || []).map((article: any) => (
                  <div key={article.id} style={{ marginBottom: 4 }}>
                    <a onClick={() => history.push(`/editor?type=article&id=${article.id}`)}>
                      {article.title || `文章 ${article.id}`}
                    </a>
                  </div>
                ))}
                {info.count > (info.articles || []).length && (
                  <div style={{ color: '#888' }}>…等共 {info.count} 篇</div>
                )}
              </div>
            }
          >
            <a>{info.count} 篇</a>
          </Popover>
        );
      },
    },
    {
      title: '操作',
      width: 268,
      render: (_: any, record: StaticItem) => (
        <Space size="small" wrap>
          <a onClick={() => copyImgLink(record.realPath)}>复制链接</a>
          <a onClick={() => copyImgLink(record.realPath, true, undefined, false)}>Markdown</a>
          <a onClick={() => downloadImg(record.name, record.realPath)}>下载</a>
          {showReplaceBtn && <a onClick={() => askReplace(record)}>替换</a>}
          <a
            onClick={async () => {
              const res: any = await detectStegoBySign(record.sign);
              showDetectResult(res, `检测水印：${displayImgName(record.name)}`);
            }}
          >
            检测水印
          </a>
          {showDelBtn && (
            <a
              style={{ color: '#ff4d4f' }}
              onClick={() => {
                Modal.confirm({
                  title: '确定删除该图片吗？删除后不可恢复！',
                  onOk: async () => {
                    await deleteImg(record.sign);
                  },
                });
              }}
            >
              删除
            </a>
          )}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      className="t-0"
      header={{
        title: (
          <TipTitle
            title="图片管理"
            tip="设置页可更改图片存储方式、缩放与水印。对着图片点右键可解锁更多操作哦（含检测隐写水印）"
          />
        ),
      }}
      extra={
        <Space wrap>
          <Radio.Group
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="thumb">小图</Radio.Button>
            <Radio.Button value="large">大图</Radio.Button>
            <Radio.Button value="list">列表</Radio.Button>
          </Radio.Group>
          {showBackfillBtn && (
            <Button loading={backfilling} onClick={handleBackfill}>
              补缩略图
            </Button>
          )}
          <Upload
            showUploadList={false}
            accept="image/*"
            beforeUpload={(file) => {
              handleDetectFile(file as any);
              return false;
            }}
          >
            <Button>检测水印</Button>
          </Upload>
          <CopyUploadBtn
            setLoading={setLoading}
            onError={() => {
              message.error('剪切板无图片！');
            }}
            text="剪切板上传"
            onFinish={(data) => {
              copyImgLink(
                data.src,
                true,
                data.isNew ? '剪切板图片上传成功! ' : '剪切板图片已存在! ',
                false,
              );

              fetchData();
            }}
            url="/api/admin/img/upload?withWaterMark=true"
            accept=".png,.jpg,.jpeg,.webp,.avif,.jiff,.gif"
          />
          <UploadBtn
            setLoading={setLoading}
            muti={true}
            text="上传图片"
            onFinish={(info) => {
              copyImgLink(
                info?.response?.data?.src,
                true,
                info?.response?.data?.isNew ? `${info.name} 上传成功! ` : `${info.name} 已存在! `,
                false,
              );

              fetchData();
            }}
            url="/api/admin/img/upload?withWaterMark=true"
            accept=".png,.jpg,.jpeg,.webp,.avif,.jiff,.gif"
          />
        </Space>
      }
    >
      <Portal>
        <Menu id={MENU_ID}>
          <Item onClick={handleItemClick} data="copy">
            复制链接
          </Item>
          <Item onClick={handleItemClick} data="copyMarkdown">
            复制 Markdown 链接
          </Item>
          <Item onClick={handleItemClick} data="copyMarkdownAbsolutely">
            复制完整 Markdown 链接
          </Item>
          <Separator />
          <Item onClick={handleItemClick} data="download">
            下载
          </Item>
          {showDelBtn && (
            <Item onClick={handleItemClick} data="delete">
              删除
            </Item>
          )}
          <Separator />
          <Item onClick={handleItemClick} data="info">
            信息
          </Item>
          <Item onClick={handleItemClick} data="searchByLink">
            搜索引用文章
          </Item>
          <Item onClick={handleItemClick} data="detectStego">
            检测隐写水印
          </Item>
          {showReplaceBtn && (
            <Item onClick={handleItemClick} data="replace">
              替换图片
            </Item>
          )}
        </Menu>
      </Portal>

      {/* 替换图片用的隐藏 input：右键菜单和列表按钮都触发它 */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          const target = replaceTargetRef.current;
          replaceTargetRef.current = null;
          if (file && target) {
            handleReplace(target, file as any);
          }
        }}
      />

      <RcResizeObserver
        key="resize-observer"
        onResize={(offset) => {
          setResponsive(offset.width < 601);
        }}
      >
        <Spin spinning={loading}>
          {data.length == 0 && !listMode && (
            <Empty description="暂无图片，快上传呀~" style={{ marginTop: 100 }} />
          )}
          {listMode ? (
            <Table
              rowKey={(record: StaticItem) => record.sign + record.realPath}
              dataSource={data}
              columns={columns as any}
              size="small"
              pagination={false}
              locale={{ emptyText: <Empty description="暂无图片，快上传呀~" /> }}
              scroll={{ x: 1000 }}
            />
          ) : (
            <Image.PreviewGroup>
              <div
                style={{
                  display: 'grid',
                  // 小图模式一行放 12 张（手机上 6 张），一屏能看的图片多好几倍
                  gridTemplateColumns: `repeat(${gridCols[0]}, ${gridCols[1]})`,
                  gridAutoRows: 'auto',
                  gridGap: thumbMode ? '6px 6px' : '10px 10px',
                  justifyItems: 'center',
                  alignItems: 'center',
                  minHeight: '400px',
                }}
              >
                {data.map((item: StaticItem) => {
                  return (
                    <div
                      onContextMenu={(e) => {
                        displayMenu(e, item);
                      }}
                      key={item.sign + item.realPath}
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        height: '100%',
                        width: '100%',
                      }}
                    >
                      <Image
                        fallback={errorImg}
                        style={{ maxHeight: thumbMode ? 72 : 200 }}
                        width={'auto'}
                        height={'auto'}
                        // 网格加载缩略图，点开预览才拉原图
                        src={thumbMode ? getThumbLink(item) : `${item.realPath}`}
                        preview={{ src: getImgLink(item.realPath) }}
                      />
                    </div>
                  );
                })}
              </div>
            </Image.PreviewGroup>
          )}
          <Pagination
            style={{ marginTop: 20, textAlign: 'right' }}
            hideOnSinglePage={true}
            current={page as number}
            showSizeChanger={false}
            pageSize={pageSize as number}
            onChange={(p) => {
              if (p != page) {
                (setPage as any)(p);
              }
            }}
            total={total}
            showTotal={(t) => `共 ${t} 张`}
          />
        </Spin>
      </RcResizeObserver>
    </PageContainer>
  );
};

export default ImgPage;
