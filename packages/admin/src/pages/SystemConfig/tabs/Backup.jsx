import {
  deleteFullBackup,
  downloadFullBackup,
  downloadFullBackupSignature,
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
import { useIntl } from 'umi';

/**
 * 🔴 这四个压缩器标签原来是**模块级常量**（`const FORMAT_LABELS = {…}`）。
 * 常量在**模块加载期**求值，而翻译器 `t` 来自组件里的 `useIntl()` ⇒ 加载期根本不存在
 * （第一版就是被批量改写工具直接包了 `t(...)`，结果整个 chunk 抛 ReferenceError、**页面白屏**）。
 * ⇒ 按本项目既有做法改成**函数版**（收尾参 `t = IDENTITY_T`）：不传 t 时输出与改造前逐字相同。
 * ⚠️ `IDENTITY_T` 声明在本文件更下面（`const` 有 TDZ），但这里只在**调用时**才取它 ⇒ 安全。
 */
const formatLabels = (t = IDENTITY_T) => ({
  auto: t('backup.compressorAuto', '自动（挑本机最强的）'),
  zstd: t('backup.compressorZstd', 'zstd -19 --long（最小且快，推荐）'),
  xz: t('backup.compressorXz', 'xz -9e（体积接近，慢好几倍）'),
  gzip: t('backup.compressorGzip', 'gzip -9（最兼容，体积略大）'),
});

function tokenHeader() {
  return { token: window.localStorage.getItem('token') || 'null' };
}

function isDemoSite() {
  return location.hostname == 'blog-demo.mereith.com';
}

/**
 * 🔴 多语言：这是**模块级**函数（组件外），拿不到 hook ⇒ 收尾参 `t = IDENTITY_T`（注入式翻译器）。
 * 🔴 不传 t ⇒ 输出与改造前逐字相同。三个调用点都在组件里 ⇒ 都传了 t。
 * 🔴 原来是"三段模板字符串拼起来" ⇒ 收成**一条带三个 ICU 占位符**的整句（英文语序与复数都不同，
 *   拼接必出接缝：§7.152 B / §7.156 B / §7.160 C / §7.162 A / §7.166 D / §7.168 A 已八次）。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

function summarizeTotals(totals, t = IDENTITY_T) {
  if (!totals) {
    return '-';
  }
  return t('backup.totalsSummary', '{documents} 条数据 / {files} 个文件 / {collections} 张表', {
    documents: totals.documents ?? 0,
    files: totals.files ?? 0,
    collections: totals.collections ?? 0,
  });
}

export default function (props) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件的 t **没有**进任何 hook 的依赖数组（useState/useEffect 的依赖是数据与 props）；
  //    🔴 谁要往里加 t，必须先用 useCallback([intl]) 包成稳定引用（§7.144 A），否则无限重渲染。
  // ⚠️ `message.*` / `Modal.*` 渲染进**脱离 React 树的独立根**（§7.151）⇒ 传算好的字符串，不要塞组件。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
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
    // exportAll 带 skipErrorHandler，全局不会弹提示，而这里以前直接 await 且不 catch：
    // 导出失败时异常一路抛出去，setLoading(false) 执行不到 → 页面卡在 Spin 上。
    // 和下面几个整站备份的处理保持一致（try / catch / finally）。
    try {
      const data = await exportAll();
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      // 🔴 下载文件名：实测全仓库只有这一处出现 `备份-`（服务端与恢复流程都**不匹配**这个名字）
      //    ⇒ 它只是浏览器保存名，跟着语言走是安全的（不是 §7.162 A 那类"服务端产物文件名"线路契约）
      link.download = t('backup.dataFileName', '备份-{date}.json', { date: moment().format('YYYY-MM-DD') });
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      message.error(t('backup.exportFailed', '导出失败！'));
    } finally {
      setLoading(false);
    }
  };

  const handleFullExport = async () => {
    if (isDemoSite()) {
      Modal.info({ title: t('backup.demoBlockedEdit', '演示站禁止修改此项！') });
      return;
    }
    setExporting(true);
    try {
      const res = await exportFullBackup(format);
      const data = res?.data;
      if (!data) {
        message.error(res?.message || t('backup.exportFailed', '导出失败！'));
        return;
      }
      Modal.success({
        title: t('backup.fullBackupDoneTitle', '整站备份已生成'),
        width: 620,
        content: (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label={t('backup.descFile', '文件')}>{data.name}</Descriptions.Item>
            <Descriptions.Item label={t('backup.descSize', '体积')}>
              {data.size}
              {t('backup.sizePrefix', '（压缩前 ')}
              {(data.totals?.staticBytes / 1024 / 1024).toFixed(1)}
              {t('backup.sizeSuffix', ' MB 静态文件）')}
            </Descriptions.Item>
            <Descriptions.Item label={t('backup.descCompressor', '压缩')}>{data.compressor}</Descriptions.Item>
            <Descriptions.Item label={t('backup.descSeconds', '耗时')}>
              {t('backup.secondsValue', '{seconds} 秒', { seconds: data.seconds })}
            </Descriptions.Item>
            <Descriptions.Item label={t('backup.descTotals', '内容')}>{summarizeTotals(data.totals, t)}</Descriptions.Item>
            <Descriptions.Item label={t('backup.descDatabases', '数据库')}>
              {Object.entries(data.databases || {})
                .map(([name, count]) => t('backup.dbEntry', '{name}（{count} 张表）', { name, count }))
                .join('，')}
            </Descriptions.Item>
          </Descriptions>
        ),
      });
      loadList();
    } catch (err) {
      message.error(err?.message || t('backup.exportFailed', '导出失败！'));
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
      message.error(t('backup.downloadFailed', '下载失败！'));
    } finally {
      setLoading(false);
    }
  };

  /**
   * 下载归档旁边的 `.sig`。
   *
   * 🔴 404 必须解释成"**这份归档从没被签过**"，而不是通用的"下载失败"：两者的处置完全相反
   *    —— 前者是"这份副本证明不了真实性，以后备份时配签名密钥"，
   *    后者是"网络/权限出问题了，重试"。把 404 说成失败会让站长在灾难现场重试到天亮。
   */
  const handleDownloadSignature = async (name) => {
    try {
      const text = await downloadFullBackupSignature(name);
      const body = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
      const blob = new Blob([body], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // ⚠️ 名字必须是 `<归档名>.sig`：验签器按"归档路径 + .sig"找 sidecar，
      //    下载下来改了名就验不了（服务端签名的载荷里**不含**文件名，所以内容本身不受影响）。
      link.download = `${name}.sig`;
      link.click();
      URL.revokeObjectURL(url);
      message.success(
        t('backup.sigDownloaded', '已下载 .sig：请把它和归档放进**同一个**异地副本；公钥的权威副本要**离线**保存（密码管理器/打印/另一台机器）'),
      );
    } catch (err) {
      const status = err?.response?.status ?? err?.data?.statusCode ?? err?.statusCode;
      if (status === 404) {
        message.warning(
          t(
            'backup.sigNeverSigned',
            '这份归档从没被签过（旁边没有 .sig）：不是下载失败。要证明副本没被换过，请在「签名密钥」里生成密钥后再备份',
          ),
          6,
        );
        return;
      }
      message.error(err?.message || t('backup.downloadSigFailed', '下载 .sig 失败！'));
    }
  };

  const handleInspect = async (name) => {
    try {
      const res = await inspectFullBackup(name);
      const manifest = res?.data;
      if (!manifest) {
        message.error(t('backup.inspectNoManifest', '读不出这个备份的清单！'));
        return;
      }
      Modal.info({
        title: t('backup.manifestTitle', '备份清单：{name}', { name }),
        width: 680,
        content: (
          <div style={{ marginTop: 12 }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('backup.descCreatedAt', '生成时间')}>
                {moment(manifest.createdAt).format('YYYY-MM-DD HH:mm:ss')}
              </Descriptions.Item>
              <Descriptions.Item label={t('backup.descCompressorMethod', '压缩方式')}>{manifest.compressor}</Descriptions.Item>
              <Descriptions.Item label={t('backup.descTotal', '合计')}>{summarizeTotals(manifest.totals, t)}</Descriptions.Item>
            </Descriptions>
            {Object.entries(manifest.databases || {}).map(([dbName, info]) => (
              <div key={dbName} style={{ marginTop: 12 }}>
                <b>{t('backup.dbNamePrefix', '数据库 {name}', { name: dbName })}</b>
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
                <b>{t('backup.staticTitle', '静态文件')}</b>
                <div style={{ marginTop: 4 }}>
                  {Object.entries(manifest.static).map(([folder, item]) => (
                    <Tag key={folder} style={{ marginBottom: 4 }}>
                      {t('backup.staticEntry', '{folder}: {files} 个 / {mb} MB', {
                        folder,
                        files: item.files,
                        mb: (item.bytes / 1024 / 1024).toFixed(1),
                      })}
                    </Tag>
                  ))}
                </div>
              </div>
            )}
          </div>
        ),
      });
    } catch (err) {
      message.error(err?.message || t('backup.inspectFailed', '读取清单失败！'));
    }
  };

  const handleRestore = (name) => {
    if (isDemoSite()) {
      Modal.info({ title: t('backup.demoBlockedEdit', '演示站禁止修改此项！') });
      return;
    }
    Modal.confirm({
      title: t('backup.restoreConfirmTitle', '确定用这个备份覆盖当前站点吗？'),
      width: 560,
      okText: t('backup.restoreConfirmOk', '我确定，恢复'),
      okButtonProps: { danger: true },
      content: (
        <div>
          <p>
            {t('backup.overwritePrefix', '将用 ')}
            <b>{name}</b>
            {t('backup.overwriteSuffix', ' 覆盖：')}
          </p>
          <ul style={{ paddingLeft: 20 }}>
            <li>{t('backup.overwriteDatabases', '数据库全部集合（文章、草稿、分类、标签、图床记录、设置、访问统计…）')}</li>
            {/* 🔴 这里与"包含 …"那句里的**同一个中文**是两个语境：此处是**列表项**（英文首字母大写），
                那里是句子中间的**内联成分**（英文小写、还带 the）。共用一个 key 会让其中一处读起来不对
                ⇒ 拆成两个 key（`backup.overwriteWaline` / `backup.includesWaline`），中文两份完全相同。 */}
            <li>{t('backup.overwriteWaline', 'waline 评论库')}</li>
            <li>{t('backup.overwriteStatic', '本地静态文件（图床图片与缩略图、附件、自定义页面）')}</li>
          </ul>
          <p style={{ color: '#ff4d4f' }}>{t('backup.overwriteWarning', '当前数据会被替换且不可撤销，建议先导出一份现在的备份。')}</p>
          <p style={{ color: '#888' }}>{t('backup.restoreRelogin', '恢复完成后需要重新登录（登录态与 jwt 密钥都来自备份）。')}</p>
        </div>
      ),
      onOk: async () => {
        setRestoring(true);
        try {
          const res = await restoreFullBackup(name);
          const data = res?.data;
          if (!data) {
            message.error(res?.message || t('backup.restoreFailedToast', '恢复失败！'));
            return;
          }
          Modal.success({
            title: t('backup.restoreDoneTitle', '恢复完成'),
            width: 560,
            content: (
              <div>
                <p>
                  {t('backup.restoreDoneSummary', '耗时 {seconds} 秒，备份生成于 {createdAt}', {
                    seconds: data.seconds,
                    createdAt: moment(data.backupCreatedAt).format('YYYY-MM-DD HH:mm:ss'),
                  })}
                </p>
                {Object.entries(data.databases || {}).map(([dbName, item]) => (
                  <p key={dbName}>
                    {t('backup.restoreDbLine', '{name}：{collections} 张表 / {documents} 条', {
                      name: dbName,
                      collections: item.collections,
                      documents: item.documents,
                    })}
                  </p>
                ))}
                {Object.entries(data.static || {}).map(([folder, item]) => (
                  <p key={folder}>
                    {t('backup.restoreStaticLine', '静态文件 {folder}：{files} 个', {
                      folder,
                      files: item.files,
                    })}
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
          message.error(err?.message || t('backup.restoreFailedToast', '恢复失败！'));
        } finally {
          setRestoring(false);
        }
      },
    });
  };

  const handleDelete = async (name) => {
    try {
      await deleteFullBackup(name);
      message.success(t('backup.deletedToast', '已删除'));
      loadList();
    } catch (err) {
      message.error(err?.message || t('backup.deleteFailed', '删除失败！'));
    }
  };

  const columns = [
    {
      title: t('backup.colName', '备份文件'),
      dataIndex: 'name',
      ellipsis: true,
      render: (name) => <span title={name}>{name}</span>,
    },
    { title: t('backup.descSize', '体积'), dataIndex: 'size', width: 100 },
    {
      title: t('backup.colFormat', '格式'),
      dataIndex: 'format',
      width: 80,
      render: (value) => (value ? <Tag color="blue">{value}</Tag> : '-'),
    },
    {
      title: t('backup.descTotals', '内容'),
      dataIndex: 'totals',
      width: 220,
      render: (totals) => summarizeTotals(totals, t),
    },
    {
      title: t('backup.descCreatedAt', '生成时间'),
      dataIndex: 'createdAt',
      width: 170,
      render: (value) => (value ? moment(value).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
    {
      title: t('common.colOption', '操作'),
      width: 300,
      render: (_, record) => (
        <Space size="small">
          <a onClick={() => handleDownload(record.name)}>{t('backup.actDownload', '下载')}</a>
          <a onClick={() => handleDownloadSignature(record.name)} title={t('backup.downloadSigBtn', '下载 .sig（离线签名）')}>{t('backup.actSignature', '签名')}</a>
          <a onClick={() => handleInspect(record.name)}>{t('backup.actManifest', '清单')}</a>
          <a onClick={() => handleRestore(record.name)} style={{ color: '#fa8c16' }}>{t('backup.actRestore', '恢复')}</a>
          <Popconfirm title={t('backup.deleteConfirmTitle', '删除这个备份文件？')} onConfirm={() => handleDelete(record.name)}>
            <a style={{ color: '#ff4d4f' }}>{t('common.delete', '删除')}</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card title={t('backup.fullSectionTitle', '整站备份与恢复')} style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('backup.fullSectionHint', '一个压缩包 = 整个博客')}
          description={
            <div>{t('backup.includesPrefix', '包含')} <b>{t('backup.includesDatabases', '数据库全部集合')}</b>{t('backup.includesDatabasesDetail', '（文章、草稿、分类、标签、图床记录、设置、访问统计）、')}<b>{t('backup.includesWaline', 'waline 评论库')}</b>{t('backup.includesAnd', '，以及')} <b>{t('backup.includesStatic', '本地静态文件')}</b>{t('backup.includesStaticDetail', '（图床图片与缩略图、附件、自定义页面）。 拿这一个文件就能在新机器上把博客整体恢复出来。')}<br />{t('backup.compressorNote', '压缩格式默认自动挑本机最强的（一般是 zstd -19）；图片本身已经是 WebP，所以整体压缩率主要取决于数据库部分。 归档存在服务器的备份目录里（')}<b>{t('backup.archiveNoteBold', '不在静态目录，匿名下载不到')}</b>{t('backup.archiveNoteSuffix', '），下载走后台鉴权接口。')}</div>
          }
        />
        <Spin spinning={exporting || restoring || loading}>
          <Space wrap style={{ marginBottom: 16 }}>
            <span>{t('backup.formatLabel', '压缩格式：')}</span>
            <Select
              value={format}
              style={{ width: 260 }}
              onChange={setFormat}
              options={['auto', 'zstd', 'xz', 'gzip']
                .filter((item) => item === 'auto' || available.includes(item))
                .map((item) => ({ value: item, label: formatLabels(t)[item] || item }))}
            />
            <Button type="primary" loading={exporting} onClick={handleFullExport}>{t('backup.exportFullBtn', '导出整站备份')}</Button>
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
                      title: t('backup.restoreDoneTitle', '恢复完成'),
                      content: (
                        <div>
                          <p>
                            {t('backup.restoreSecondsOnly', '耗时 {seconds} 秒。', { seconds: body.data?.seconds })}
                          </p>
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
                      title: t('backup.restoreFailedTitle', '恢复失败'),
                      content: body?.message || t('backup.restoreIncomplete', '上传成功但恢复没有完成，请看服务端日志。'),
                    });
                  }
                } else if (info.file.status === 'error') {
                  message.error(t('backup.uploadFailedFull', '{name} 上传失败！', { name: info.file.name }));
                }
              }}
            >
              <Button>{t('backup.uploadRestoreBtn', '上传备份并恢复')}</Button>
            </Upload>
            <Button onClick={loadList}>{t('backup.refreshBtn', '刷新列表')}</Button>
          </Space>
          <Table
            rowKey="name"
            size="small"
            dataSource={list}
            columns={columns}
            pagination={{ hideOnSinglePage: true, pageSize: 10, showQuickJumper: true }}
            locale={{ emptyText: t('backup.fullEmpty', '还没有整站备份，点上面的「导出整站备份」生成一个') }}
          />
        </Spin>
      </Card>

      <Card title={t('backup.dataSectionTitle', '数据备份（仅数据库记录，JSON）')}>
        <Alert
          type="warning"
          message={t('backup.dataSectionNote', '注意：导入不会覆盖当前后台登录账号。这种 JSON 导入导出「不包含图片、附件和评论本身」，只含图片记录以便检索。要连文件一起备份，请用上面的「整站备份」。')}
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
                      title: t('backup.demoBlockedEdit', '演示站禁止修改此项！'),
                      content: t('backup.demoBlockedReason', '因为有个人在演示站首页放黄色信息，所以关了这个权限了。'),
                    });
                    return;
                  }
                  message.success(
                    t('backup.uploadOkRefresh', '{name} 上传成功! 稍后刷新就生效了!', { name: info.file.name }),
                  );
                  setLoading(false);
                } else if (info.file.status === 'error') {
                  message.error(t('common.uploadFailedWithName', '{name} 上传失败!', { name: info.file.name }));
                  setLoading(false);
                }
              }}
            >
              <Button>{t('backup.importAllBtn', '导入全部数据')}</Button>
            </Upload>
            <Button type="primary" onClick={handleOutPut}>{t('backup.exportAllBtn', '导出全部数据')}</Button>
          </Space>
        </Spin>
      </Card>
    </>
  );
}
