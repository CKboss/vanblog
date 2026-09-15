import {
  activateTheme,
  deleteTheme,
  getThemeCss,
  listThemes,
  THEME_UPLOAD_ACTION,
  themeTokenHeader,
} from '@/services/van-blog/skinTheme';
import { Alert, Button, Card, Input, message, Modal, Popconfirm, Space, Table, Tag, Typography, Upload } from 'antd';
import moment from 'moment';
import { useEffect, useState } from 'react';

const { Paragraph, Text, Link } = Typography;

/**
 * 主题（前台皮肤）管理。
 *
 * 主题就是**一份 CSS**：前台把主题 id 写到 <html data-ui="..."> 上，
 * 主题里的规则挂在 [data-ui="<id>"] 下面，所以多个主题可以共存、随时切换、互不污染。
 * 内置的 default / apple 打包在前台产物里；上传的主题存在图床目录的 themes/ 下，
 * 由 /api/public/theme.css 提供给前台（带 ETag，切了主题刷新就生效，不用重新构建）。
 */
export default function ThemeTab() {
  const [loading, setLoading] = useState(false);
  const [themes, setThemes] = useState([]);
  const [active, setActive] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', description: '', author: '', version: '' });
  const [cssOpen, setCssOpen] = useState(false);
  const [cssText, setCssText] = useState('');
  const [cssTitle, setCssTitle] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await listThemes();
      if (res?.statusCode === 200) {
        setThemes(res.data?.themes || []);
        setActive(res.data?.active || '');
      } else {
        message.error(res?.message || '读取主题列表失败');
      }
    } catch (e) {
      message.error(`读取主题列表失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleActivate = async (id) => {
    try {
      const res = await activateTheme(id);
      if (res?.statusCode === 200) {
        message.success(`已切换到「${id}」，前台刷新后即可看到（首次会触发一轮全量渲染）`);
        setActive(id);
      } else {
        message.error(res?.message || '切换失败');
      }
    } catch (e) {
      message.error(`切换失败：${e?.message || e}`);
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await deleteTheme(id);
      if (res?.statusCode === 200) {
        message.success('已删除');
        load();
      } else {
        message.error(res?.message || '删除失败');
      }
    } catch (e) {
      message.error(`删除失败：${e?.message || e}`);
    }
  };

  const handleViewCss = async (record) => {
    if (record.source === 'builtin') {
      Modal.info({
        title: `内置主题「${record.name}」`,
        width: 640,
        content: (
          <Paragraph>
            内置主题的样式打包在前台产物里（<Text code>packages/website/styles/apple.css</Text>），
            没有单独的 CSS 文件可以下载。想改它就改仓库里那份文件；想做自己的皮肤，
            上传一份 CSS 即可（id 用 <Text code>[data-ui=&quot;你的id&quot;]</Text> 收窄作用域）。
          </Paragraph>
        ),
      });
      return;
    }
    try {
      const res = await getThemeCss(record.id);
      if (res?.statusCode !== 200) {
        // 后端用 NotFoundException 时 umi 会抛错，但也可能返回信封里的错误，两边都兜住
        message.error(res?.message || '读取 CSS 失败');
        return;
      }
      setCssTitle(`${res.data?.name || record.name}（${record.id}）`);
      setCssText(res.data?.css ?? '');
      setCssOpen(true);
    } catch (e) {
      // umi 的 BizError/HttpError 都只有 message，直接把后端的话带出来，别只显示 "BizError"
      const detail = e?.data?.message || e?.message || String(e);
      message.error(`读取 CSS 失败：${detail}`);
    }
  };

  const columns = [
    {
      title: '主题',
      dataIndex: 'name',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space>
            <Text strong>{r.name}</Text>
            <Text type="secondary" copyable={{ text: r.id }}>
              {r.id}
            </Text>
            {r.source === 'builtin' ? <Tag color="blue">内置</Tag> : <Tag color="green">上传</Tag>}
            {active === r.id ? <Tag color="gold">使用中</Tag> : null}
          </Space>
          {r.description ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.description}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '版本 / 作者',
      dataIndex: 'version',
      width: 160,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Text>{r.version || '-'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.author || '-'}
          </Text>
        </Space>
      ),
    },
    {
      title: '大小 / 更新时间',
      dataIndex: 'updatedAt',
      width: 190,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Text>{r.size ? `${(r.size / 1024).toFixed(1)} KB` : '-'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.updatedAt ? moment(r.updatedAt).format('YYYY-MM-DD HH:mm') : '-'}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            type={active === r.id ? 'default' : 'primary'}
            disabled={active === r.id}
            onClick={() => handleActivate(r.id)}
          >
            {active === r.id ? '使用中' : '启用'}
          </Button>
          <Button size="small" onClick={() => handleViewCss(r)}>
            查看 CSS
          </Button>
          {r.source === 'upload' ? (
            <Popconfirm
              title={`删除主题「${r.name}」？`}
              description={active === r.id ? '正在使用中，先切换到别的主题' : '会同时删掉它的 CSS 文件'}
              disabled={active === r.id}
              onConfirm={() => handleDelete(r.id)}
            >
              <Button size="small" danger disabled={active === r.id}>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="主题"
      extra={
        <Space>
          <Button onClick={load}>刷新</Button>
          <Button type="primary" onClick={() => setUploadOpen(true)}>
            上传主题（.css）
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="主题就是一份 CSS"
        description={
          <div>
            前台会把主题 id 写到 <Text code>&lt;html data-ui="主题id"&gt;</Text> 上，
            所以你的样式都写在 <Text code>[data-ui=&quot;主题id&quot;] 选择器 {`{ … }`}</Text> 里面就能只在这个主题下生效，
            切回别的主题不会残留。上传后点「启用」，前台刷新即可看到（不需要重新构建、不需要重启容器）。
            写法与示例见{' '}
            <Link href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/theme.md" target="_blank">
              主题开发文档
            </Link>
            。
          </div>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={themes}
        pagination={false}
      />

      <Modal
        title="上传主题"
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        footer={null}
        width={620}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="上传的 CSS 会注入到前台每一个页面"
          description="只能写样式：含 javascript:、expression()、<script> 之类的会被拒绝；上限 512KB。远程 @import（比如引字体）允许，但会把访客 IP 交给第三方。"
        />
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Input
            addonBefore="主题 id"
            placeholder="留空则用文件名，例如 my-theme（小写字母/数字/-/_，2-40 位）"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
          <Input
            addonBefore="名称"
            placeholder="显示在列表里，例如「我的暗色主题」"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            addonBefore="描述"
            placeholder="可选"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <Space style={{ width: '100%' }}>
            <Input
              addonBefore="作者"
              placeholder="可选"
              value={form.author}
              onChange={(e) => setForm({ ...form, author: e.target.value })}
            />
            <Input
              addonBefore="版本"
              placeholder="可选，例如 1.0.0"
              value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })}
            />
          </Space>
          <Upload
            name="file"
            accept=".css,text/css"
            action={THEME_UPLOAD_ACTION}
            headers={themeTokenHeader()}
            data={{
              id: form.id,
              name: form.name,
              description: form.description,
              author: form.author,
              version: form.version,
            }}
            showUploadList={false}
            onChange={(info) => {
              if (info.file.status === 'uploading') {
                setUploading(true);
                return;
              }
              setUploading(false);
              const body = info.file.response;
              if (info.file.status === 'done' && body?.statusCode === 200) {
                const warnings = body?.data?.warnings || [];
                message.success(`主题「${body.data.theme.id}」上传成功`);
                if (warnings.length) {
                  Modal.warning({
                    title: '上传成功，但有几点提醒',
                    width: 620,
                    content: (
                      <ul style={{ paddingLeft: 18 }}>
                        {warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    ),
                  });
                }
                setUploadOpen(false);
                setForm({ id: '', name: '', description: '', author: '', version: '' });
                load();
              } else if (info.file.status === 'error' || body) {
                message.error(body?.message || `上传失败：${info.file.status}`);
              }
            }}
          >
            <Button type="primary" loading={uploading}>
              选择 .css 文件并上传
            </Button>
          </Upload>
          <Text type="secondary" style={{ fontSize: 12 }}>
            同一个 id 再次上传就是覆盖（文件名带内容 hash，所以访客不会拿到旧缓存）。
          </Text>
        </Space>
      </Modal>

      <Modal
        title={`CSS：${cssTitle}`}
        open={cssOpen}
        onCancel={() => setCssOpen(false)}
        width={860}
        footer={[
          <Button key="copy" onClick={() => navigator.clipboard?.writeText(cssText)}>
            复制
          </Button>,
          <Button key="close" type="primary" onClick={() => setCssOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <Input.TextArea value={cssText} autoSize={{ minRows: 12, maxRows: 28 }} readOnly />
      </Modal>
    </Card>
  );
}
