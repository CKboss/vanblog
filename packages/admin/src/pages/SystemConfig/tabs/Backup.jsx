import {
  deleteFullBackup,
  downloadFullBackup,
  exportAll,
  exportFullBackup,
  getFullBackupFormats,
  inspectFullBackup,
  listFullBackups,
  restoreFullBackup,
} from '@/services/van-blog/api';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Upload,
} from 'antd';
import moment from 'moment';
import { useEffect, useState } from 'react';

const FORMAT_LABELS = {
  auto: '自动（挑本机最强的）',
  zstd: 'zstd -19 --long（最小且快，推荐）',
  xz: 'xz -9e（体积接近，慢好几倍）',
  gzip: 'gzip -9（最兼容，体积略大）',
};

function tokenHeader() {
  return { token: window.localStorage.getItem('token') || 'null' };
}

function isDemoSite() {
  return location.hostname == 'blog-demo.mereith.com';
}

function summarizeTotals(totals) {
  if (!totals) {
    return '-';
  }
  return `${totals.documents ?? 0} 条数据 / ${totals.files ?? 0} 个文件 / ${
    totals.collections ?? 0
  } 张表`;
}

export default function (props) {
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [format, setFormat] = useState('auto');
  const [available, setAvailable] = useState([]);
  const [list, setList] = useState([]);

  const loadList = async () => {
    try {
      const res = await listFullBackups();
      setList(res?.data || []);
    } catch (err) {
      // 列表拉不到不影响别的功能
    }
  };

  useEffect(() => {
    getFullBackupFormats()
      .then((res) => setAvailable(res?.data?.available || []))
      .catch(() => setAvailable([]));
    loadList();
  }, []);

  const handleOutPut = async () => {
    setLoading(true);
    const data = await exportAll();
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `备份-${moment().format('YYYY-MM-DD')}.json`;
    link.click();
    setLoading(false);
  };

  const handleFullExport = async () => {
    if (isDemoSite()) {
      Modal.info({ title: '演示站禁止修改此项！' });
      return;
    }
    setExporting(true);
    try {
      const res = await exportFullBackup(format);
      const data = res?.data;
      if (!data) {
        message.error(res?.message || '导出失败！');
        return;
      }
      Modal.success({
        title: '整站备份已生成',
        width: 620,
        content: (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label="文件">{data.name}</Descriptions.Item>
            <Descriptions.Item label="体积">
              {data.size}（压缩前 {(data.totals?.staticBytes / 1024 / 1024).toFixed(1)} MB 静态文件）
            </Descriptions.Item>
            <Descriptions.Item label="压缩">{data.compressor}</Descriptions.Item>
            <Descriptions.Item label="耗时">{data.seconds} 秒</Descriptions.Item>
            <Descriptions.Item label="内容">{summarizeTotals(data.totals)}</Descriptions.Item>
            <Descriptions.Item label="数据库">
              {Object.entries(data.databases || {})
                .map(([name, count]) => `${name}（${count} 张表）`)
                .join('，')}
            </Descriptions.Item>
          </Descriptions>
        ),
      });
      loadList();
    } catch (err) {
      message.error(err?.message || '导出失败！');
    } finally {
      setExporting(false);
    }
  };

  const handleDownload = async (name) => {
    setLoading(true);
    try {
      const blob = await downloadFullBackup(name);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error('下载失败！');
    } finally {
      setLoading(false);
    }
  };

  const handleInspect = async (name) => {
    try {
      const res = await inspectFullBackup(name);
      const manifest = res?.data;
      if (!manifest) {
        message.error('读不出这个备份的清单！');
        return;
      }
      Modal.info({
        title: `备份清单：${name}`,
        width: 680,
        content: (
          <div style={{ marginTop: 12 }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="生成时间">
                {moment(manifest.createdAt).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              <Descriptions.Item label="压缩方式">{manifest.compressor}</Descriptions.Item>
              <Descriptions.Item label="合计">{summarizeTotals(manifest.totals)}</Descriptions.Item>
            </Descriptions>
            {Object.entries(manifest.databases || {}).map(([dbName, info]) => (
              <div key={dbName} style={{ marginTop: 12 }}>
                <b>数据库 {dbName}</b>
                <div style={{ marginTop: 4 }}>
                  {Object.entries(info.collections || {}).map(([coll, item]) => (
                    <Tag key={coll} style={{ marginBottom: 4 }}>
                      {coll}: {item.count}
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
            {Object.keys(manifest.static || {}).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <b>静态文件</b>
                <div style={{ marginTop: 4 }}>
                  {Object.entries(manifest.static).map(([folder, item]) => (
                    <Tag key={folder} style={{ marginBottom: 4 }}>
                      {folder}: {item.files} 个 / {(item.bytes / 1024 / 1024).toFixed(1)} MB
                    </Tag>
                  ))}
                </div>
              </div>
            )}
          </div>
        ),
      });
    } catch (err) {
      message.error(err?.message || '读取清单失败！');
    }
  };

  const handleRestore = (name) => {
    if (isDemoSite()) {
      Modal.info({ title: '演示站禁止修改此项！' });
      return;
    }
    Modal.confirm({
      title: '确定用这个备份覆盖当前站点吗？',
      width: 560,
      okText: '我确定，恢复',
      okButtonProps: { danger: true },
      content: (
        <div>
          <p>
            将用 <b>{name}</b> 覆盖：
          </p>
          <ul style={{ paddingLeft: 20 }}>
            <li>数据库全部集合（文章、草稿、分类、标签、图床记录、设置、访问统计…）</li>
            <li>waline 评论库</li>
            <li>本地静态文件（图床图片与缩略图、附件、自定义页面）</li>
          </ul>
          <p style={{ color: '#ff4d4f' }}>当前数据会被替换且不可撤销，建议先导出一份现在的备份。</p>
          <p style={{ color: '#888' }}>恢复完成后需要重新登录（登录态与 jwt 密钥都来自备份）。</p>
        </div>
      ),
      onOk: async () => {
        setRestoring(true);
        try {
          const res = await restoreFullBackup(name);
          const data = res?.data;
          if (!data) {
            message.error(res?.message || '恢复失败！');
            return;
          }
          Modal.success({
            title: '恢复完成',
            width: 560,
            content: (
              <div>
                <p>耗时 {data.seconds} 秒，备份生成于 {moment(data.backupCreatedAt).format('YYYY-MM-DD HH:mm:ss')}</p>
                {Object.entries(data.databases || {}).map(([dbName, item]) => (
                  <p key={dbName}>
                    {dbName}：{item.collections} 张表 / {item.documents} 条
                  </p>
                ))}
                {Object.entries(data.static || {}).map(([folder, item]) => (
                  <p key={folder}>
                    静态文件 {folder}：{item.files} 个
                  </p>
                ))}
                <ul style={{ paddingLeft: 20, color: '#888' }}>
                  {(data.notes || []).map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ),
          });
          loadList();
        } catch (err) {
          message.error(err?.message || '恢复失败！');
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  const handleDelete = async (name) => {
    try {
      await deleteFullBackup(name);
      message.success('已删除');
      loadList();
    } catch (err) {
      message.error(err?.message || '删除失败！');
    }
  };

  const columns = [
    {
      title: '备份文件',
      dataIndex: 'name',
      ellipsis: true,
      render: (name) => <span title={name}>{name}</span>,
    },
    { title: '体积', dataIndex: 'size', width: 100 },
    {
      title: '格式',
      dataIndex: 'format',
      width: 80,
      render: (value) => (value ? <Tag color="blue">{value}</Tag> : '-'),
    },
    {
      title: '内容',
      dataIndex: 'totals',
      width: 220,
      render: (totals) => summarizeTotals(totals),
    },
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value) => (value ? moment(value).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '操作',
      width: 250,
      render: (_, record) => (
        <Space size="small">
          <a onClick={() => handleDownload(record.name)}>下载</a>
          <a onClick={() => handleInspect(record.name)}>清单</a>
          <a onClick={() => handleRestore(record.name)} style={{ color: '#fa8c16' }}>
            恢复
          </a>
          <Popconfirm title="删除这个备份文件？" onConfirm={() => handleDelete(record.name)}>
            <a style={{ color: '#ff4d4f' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card title="整站备份与恢复" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="一个压缩包 = 整个博客"
          description={
            <div>
              包含 <b>数据库全部集合</b>（文章、草稿、分类、标签、图床记录、设置、访问统计）、
              <b>waline 评论库</b>，以及 <b>本地静态文件</b>（图床图片与缩略图、附件、自定义页面）。
              拿这一个文件就能在新机器上把博客整体恢复出来。
              <br />
              压缩格式默认自动挑本机最强的（一般是 zstd -19）；图片本身已经是 WebP，所以整体压缩率主要取决于数据库部分。
              归档存在服务器的备份目录里（<b>不在静态目录，匿名下载不到</b>），下载走后台鉴权接口。
            </div>
          }
        />
        <Spin spinning={exporting || restoring || loading}>
          <Space wrap style={{ marginBottom: 16 }}>
            <span>压缩格式：</span>
            <Select
              value={format}
              style={{ width: 260 }}
              onChange={setFormat}
              options={['auto', 'zstd', 'xz', 'gzip']
                .filter((item) => item === 'auto' || available.includes(item))
                .map((item) => ({ value: item, label: FORMAT_LABELS[item] || item }))}
            />
            <Button type="primary" loading={exporting} onClick={handleFullExport}>
              导出整站备份
            </Button>
            <Upload
              showUploadList={false}
              name="file"
              accept=".zst,.xz,.gz,.tgz,.tar"
              action="/api/admin/backup/full/restore"
              data={{ confirm: 'true' }}
              headers={tokenHeader()}
              onChange={(info) => {
                if (info.file.status === 'uploading') {
                  setRestoring(true);
                  return;
                }
                setRestoring(false);
                if (info.file.status === 'done') {
                  const body = info.file.response;
                  if (body?.statusCode === 200) {
                    Modal.success({
                      title: '恢复完成',
                      content: (
                        <div>
                          <p>耗时 {body.data?.seconds} 秒。</p>
                          <ul style={{ paddingLeft: 20, color: '#888' }}>
                            {(body.data?.notes || []).map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                          </ul>
                        </div>
                      ),
                    });
                    loadList();
                  } else {
                    Modal.error({
                      title: '恢复失败',
                      content: body?.message || '上传成功但恢复没有完成，请看服务端日志。',
                    });
                  }
                } else if (info.file.status === 'error') {
                  message.error(`${info.file.name} 上传失败！`);
                }
              }}
            >
              <Button>上传备份并恢复</Button>
            </Upload>
            <Button onClick={loadList}>刷新列表</Button>
          </Space>
          <Table
            rowKey="name"
            size="small"
            dataSource={list}
            columns={columns}
            pagination={{ hideOnSinglePage: true, pageSize: 10 }}
            locale={{ emptyText: '还没有整站备份，点上面的「导出整站备份」生成一个' }}
          />
        </Spin>
      </Card>

      <Card title="数据备份（仅数据库记录，JSON）">
        <Alert
          type="warning"
          message="注意：导入不会覆盖当前后台登录账号。这种 JSON 导入导出**不包含图片、附件和评论本身**，只含图片记录以便检索。要连文件一起备份，请用上面的「整站备份」。"
          style={{ marginBottom: 20 }}
        />
        <Spin spinning={loading}>
          <Space size="large">
            <Upload
              showUploadList={false}
              name="file"
              accept=".json"
              action="/api/admin/backup/import"
              headers={tokenHeader()}
              onChange={(info) => {
                setLoading(true);
                if (info.file.status === 'done') {
                  if (isDemoSite()) {
                    Modal.info({
                      title: '演示站禁止修改此项！',
                      content: '因为有个人在演示站首页放黄色信息，所以关了这个权限了。',
                    });
                    return;
                  }
                  message.success(`${info.file.name} 上传成功! 稍后刷新就生效了!`);
                  setLoading(false);
                } else if (info.file.status === 'error') {
                  message.error(`${info.file.name} 上传失败!`);
                  setLoading(false);
                }
              }}
            >
              <Button>导入全部数据</Button>
            </Upload>
            <Button type="primary" onClick={handleOutPut}>
              导出全部数据
            </Button>
          </Space>
        </Spin>
      </Card>
    </>
  );
}
