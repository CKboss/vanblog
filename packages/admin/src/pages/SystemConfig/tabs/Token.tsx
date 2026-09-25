import { createApiToken, getAllApiTokens, deleteApiToken } from '@/services/van-blog/api';
import { ModalForm, ProFormText } from '@ant-design/pro-form';
import { ProTable } from '@ant-design/pro-table';
import { Button, Card, message, Modal, Space, Typography } from 'antd';

import { useRef } from 'react';
import { history, useIntl } from 'umi';

export default function () {
  const actionRef = useRef();
  // 🔴 语言选择必须在**渲染期**：`columns` 原本是模块级常量（模块加载期就求值，那时 umi 插件运行时
  //    还没初始化，`getLocale()`/`useIntl()` 会拿到 undefined）⇒ 搬进组件内部
  //    （与 `Customizing.jsx` 的 helpMap、`app.jsx` 的 links 数组同一条约束）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const columns = [
    { dataIndex: '_id', title: 'ID' },
    { dataIndex: 'name', title: t('common.colName', '名称') },
    {
      dataIndex: 'token',
      title: t('common.colContent', '内容'),
      render: (token) => {
        return (
          <Typography.Text style={{ maxWidth: 250 }} ellipsis={true} copyable={true}>
            {token}
          </Typography.Text>
        );
      },
    },
    {
      title: t('common.colOption', '操作'),
      render: (text, record, _, action) => [
        <a
          key="delete"
          style={{ marginLeft: 8 }}
          onClick={() => {
            Modal.confirm({
              // 🔴 用 common.deleteConfirmTitle（从 sysconf.token.deleteConfirmTitle 提升）：用户页也要用它
              title: t('common.deleteConfirmTitle', '删除确认'),
              content: t('sysconf.token.deleteConfirmBody', '是否确认删除该 Token？'),
              onOk: async () => {
                await deleteApiToken(record._id);
                action?.reload();
                message.success(t('common.deleteSuccess', '删除成功！'));
              },
            });
          }}
        >
          {t('common.delete', '删除')}
        </a>,
      ],
    },
  ];
  return (
    <>
      <Card
        title={t('sysconf.token.title', 'Token 管理')}
        style={{ marginTop: 8 }}
        className="card-body-full"
        extra={
          <Space>
            <ModalForm
              title={t('sysconf.token.createTitle', '新建 API Token')}
              trigger={<Button type="primary"> {t('common.create', '新建')}</Button>}
              onFinish={async (vals) => {
                await createApiToken(vals);
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText label={t('common.colName', '名称')} name="name" />
            </ModalForm>
            <Button
              onClick={() => {
                // ⚠️ /swagger 现在默认关闭；先探一下再开，避免弹出一个 404 标签页
                fetch('/swagger-json', { method: 'GET' })
                  .then((r) => {
                    if (r.ok) {
                      window.open('/swagger', '_blank');
                      return;
                    }
                    message.warning(
                      t(
                        'sysconf.token.swaggerOffWithDocs',
                        '实时 API 文档（swagger）默认关闭：设 VANBLOG_SWAGGER=true 并重启后可用。已为你打开仓库里的 API 文档。',
                      ),
                    );
                    window.open(
                      'https://github.com/CKboss/vanblog/blob/dev/dsh/docs/reference/api.md',
                      '_blank',
                    );
                  })
                  .catch(() => {
                    message.warning(
                      t(
                        'sysconf.token.swaggerOff',
                        '实时 API 文档（swagger）默认关闭：设 VANBLOG_SWAGGER=true 并重启后可用。',
                      ),
                    );
                  });
              }}
            >
              {t('sysconf.token.apiDocs', 'API 文档')}
            </Button>
            <Button
              onClick={() => {
                Modal.info({
                  title: t('sysconf.token.helpTitle', 'Token 管理功能介绍'),
                  content: (
                    <div>
                      <p>{t('sysconf.token.helpP1', '创建的 Api Token 可以用来调用 VanBlog 的 API')}</p>
                      <p>{t('sysconf.token.helpP2', '结合 API 文档，您可以做到很多有意思的事情。')}</p>
                      <p>
                        {t(
                          'sysconf.token.helpP3',
                          'API 文档现在比较水，会慢慢完善的，未来会有 API Playgroud，敬请期待。',
                        )}
                      </p>
                      <p>
                        {t(
                          'sysconf.token.helpP4',
                          'PS：暂时没必要通过 API 开发自己的前台，后面会出主题功能（完善的文档和开发指南，不限制技术栈），届时再开发会更好。',
                        )}
                      </p>
                      <p>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/token.md"
                        >
                          {t('sysconf.token.relatedDocs', '相关文档')}
                        </a>
                      </p>
                    </div>
                  ),
                });
              }}
            >
              {t('common.help', '帮助')}
            </Button>
          </Space>
        }
      >
        <ProTable
          rowKey="id"
          columns={columns}
          dateFormatter="string"
          actionRef={actionRef}
          search={false}
          options={false}
          pagination={{
            showQuickJumper: true,
            hideOnSinglePage: true,
            simple: true,
          }}
          request={async (params = {}) => {
            let { data } = await getAllApiTokens();
            return {
              data,
              // success 请返回 true，
              // 不然 table 会停止解析数据，即使有数据
              success: true,
              // 不传会使用 data 的长度，如果是分页一定要传
              total: data.length,
            };
          }}
        />
      </Card>
    </>
  );
}
