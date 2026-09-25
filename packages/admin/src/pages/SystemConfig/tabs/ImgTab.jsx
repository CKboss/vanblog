import StaticForm from '@/components/StaticForm';
import WatchMarkForm from '@/components/WaterMarkForm';
import { exportAllImgs, rewriteArticleBaseUrl, scanImgsOfArticles } from '@/services/van-blog/api';
// 「导出全部本地图床内容」用到了 saveExportArchive，但一直没 import：
// 点下去就是 ReferenceError，再被 catch 吞成一句看不懂的报错，压缩包永远下不下来。
import { saveExportArchive } from '@/services/van-blog/downloadArchive';
import { reportRequestError } from '@/services/van-blog/requestError';
import { Alert, Button, Card, Input, message, Modal, Table, Typography } from 'antd';
import { useIntl } from 'umi';
import { useState } from 'react';

export default function () {
  const intl = useIntl();
  const t = (id, defaultMessage, values) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [oldBase, setOldBase] = useState('');
  const [newBase, setNewBase] = useState(
    typeof window !== 'undefined' ? window.location.origin : '',
  );
  return (
    <>
      <Card title={t('sysconf.img.featureCard', '图床功能设置')}>
        <WatchMarkForm />
      </Card>
      <Card title={t('sysconf.img.storageCard', '存储策略设置')} style={{ marginTop: 8 }}>
        <StaticForm />
      </Card>
      <Card title={t('sysconf.img.advancedCard', '高级操作')} style={{ marginTop: 8 }}>
        <Button
          style={{ margin: '20px 0' }}
          onClick={async () => {
            setLoading(true);
            try {
              const { data } = await scanImgsOfArticles();
              message.success(
                t('sysconf.img.scanOk', '扫描成功！共 {total} 项', { total: data?.total || 0 }),
              );
              // data 为空时直接解构会抛 TypeError，被下面的 catch 吞掉就只剩「按钮不转了」
              const { errorLinks } = data || {};
              if (errorLinks && errorLinks.length) {
                Modal.info({
                  title: t('sysconf.img.deadLinks', '失效链接：'),
                  content: (
                    <Table
                      pagination={{
                        showQuickJumper: true,
                        hideOnSinglePage: true,
                      }}
                      rowKey={'link'}
                      dataSource={errorLinks}
                      size="small"
                      columns={[
                        {
                          title: t('sysconf.img.colArticleId', '文章 ID'),
                          dataIndex: 'artcileId',
                          key: 'artcileId',
                        },
                        { title: t('sysconf.img.colTitle', '标题'), dataIndex: 'title', key: 'title' },
                        {
                          title: t('sysconf.img.colLink', '链接'),
                          dataIndex: 'link',
                          key: 'link',
                          render: (val) => {
                            return (
                              <Typography.Text
                                copyable={val.length > 20}
                                style={{
                                  wordBreak: 'break-all',
                                  wordWrap: 'break-word',
                                }}
                              >
                                {val}
                              </Typography.Text>
                            );
                          },
                        },
                      ]}
                    />
                  ),
                });
              }
            } catch (err) {
              // 只 setLoading(false) 等于把失败静默吞掉：用户点了扫描，
              // 按钮转完圈什么也没发生，看不出是接口挂了还是没扫到东西。
              reportRequestError(message, err, t('sysconf.img.scanFailed', '扫描失败！'));
            } finally {
              setLoading(false);
            }
          }}
          type="primary"
          loading={loading}
        >
          {t('sysconf.img.scanBtn', '扫描现有文章图片到图床')}
        </Button>
        <Alert
          type="info"
          message={t(
            'sysconf.img.scanTip',
            'PS: 扫描文章图片会把文章内的所有图片扫描到数据库中，就可以在图床页面看到了。只支持外链。',
          )}
        ></Alert>
        <Button
          style={{ margin: '20px 0' }}
          loading={exporting}
          type="primary"
          onClick={async () => {
            setExporting(true);
            try {
              const { data } = await exportAllImgs();
              // 后端返回的是 { success, path }，以前直接 link.href = data
              // 会变成 "[object Object]"，这个按钮其实一直下不下来东西。
              // 归档现在存在静态目录之外（匿名可读的 /static/export/ 已被封），
              // 必须走带 token 的下载接口。
              const name = data?.path;
              if (!data?.success || !name) {
                message.error(t('sysconf.img.packFailed', '打包失败！'));
                return;
              }
              await saveExportArchive(name, t('sysconf.img.packDone', '图片打包完成，已开始下载'));
            } catch (err) {
              // 空的 catch 会把失败吞掉，用户只看到按钮转圈结束
              message.error(err?.message || t('sysconf.img.exportFailed', '导出失败'));
            } finally {
              setExporting(false);
            }
          }}
        >
          {t('sysconf.img.exportBtn', '导出全部本地图床内容（压缩包）')}
        </Button>
        <Alert
          type="info"
          message={t(
            'sysconf.img.exportTip',
            'PS: 导出全部图片会把本地图床的全部文件打包成一个 zip 压缩包并在完成后弹出下载窗口。',
          )}
        ></Alert>
      </Card>
      <Card title={t('sysconf.img.rewriteCard', '域名变更后改写文章图片链接')} style={{ marginTop: 8 }}>
        <Alert
          type="warning"
          style={{ marginBottom: 16 }}
          message={t(
            'sysconf.img.rewriteWarn',
            '换域名后，文章/草稿里已经写成绝对地址的图片（如 https://旧域名/static/...）不会跟着改。这里只改 Mongo 里的正文链接，不会移动磁盘上的文件，也不会改写你没填写的第三方图床。',
          )}
        />
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}>{t('sysconf.img.oldBase', '旧站点 / 图床地址')}</div>
          <Input
            placeholder="https://old.example.com"
            value={oldBase}
            onChange={(e) => setOldBase(e.target.value)}
            allowClear
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}>{t('sysconf.img.newBase', '新站点 / 图床地址')}</div>
          <Input
            placeholder="https://new.example.com"
            value={newBase}
            onChange={(e) => setNewBase(e.target.value)}
            allowClear
          />
        </div>
        <Button
          type="primary"
          loading={rewriting}
          onClick={() => {
            if (typeof window !== 'undefined' && location.hostname == 'blog-demo.mereith.com') {
              Modal.info({
                title: t('common.demoBlocked', '演示站禁止修改此项！'),
                content: t('sysconf.img.demoBlockedBody', '演示站不允许批量改写文章内容。'),
              });
              return;
            }
            const from = (oldBase || '').trim();
            const to = (newBase || '').trim();
            if (!from || !to) {
              message.warning(t('sysconf.img.fillBoth', '请填写旧地址和新地址'));
              return;
            }
            Modal.confirm({
              title: t('sysconf.img.rewriteConfirm', '确认改写文章和草稿中的链接？'),
              content: t(
                'sysconf.img.rewriteConfirmBody',
                '将把以「{from}」开头的链接改写成「{to}」。建议先在「备份恢复」导出一份数据。相对路径 /static/... 不会改动。',
                { from, to },
              ),
              okText: t('sysconf.img.rewriteOk', '开始改写'),
              okButtonProps: { danger: true },
              onOk: async () => {
                setRewriting(true);
                try {
                  const { data } = await rewriteArticleBaseUrl({
                    oldBase: from,
                    newBase: to,
                  });
                  message.success(
                    t(
                      'sysconf.img.rewriteDone',
                      '改写完成：文章 {articles} 篇，草稿 {drafts} 篇，共 {replacements} 处',
                      {
                        articles: data?.articlesUpdated || 0,
                        drafts: data?.draftsUpdated || 0,
                        replacements: data?.replacements || 0,
                      },
                    ),
                  );
                } finally {
                  setRewriting(false);
                }
              },
            });
          }}
        >
          {t('sysconf.img.rewriteBtn', '改写文章与草稿中的链接')}
        </Button>
        <Alert
          type="info"
          style={{ marginTop: 16 }}
          message={t(
            'sysconf.img.afterRewrite',
            '之后请到「站点配置」把网站 Url 改成新域名，并确认 DNS 已指向本站。新上传的图片会按当前访问域名写入。',
          )}
        />
      </Card>
    </>
  );
}
