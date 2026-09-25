import CollaboratorModal, { getPermissionLabel } from '@/components/CollaboratorModal';
import Tags from '@/components/Tags';
import { deleteCollaborator, getAllCollaborators, updateUser } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { accountPasswordMinRule } from '@/services/van-blog/passwordPolicy';
import { ProForm, ProFormText } from '@ant-design/pro-form';
import { ProTable } from '@ant-design/pro-table';
import { Button, Card, message, Modal, Space } from 'antd';
import { useRef } from 'react';
import { history, useIntl, useModel } from 'umi';

export default function () {
  const { initialState, setInitialState } = useModel('@@initialState');
  const actionRef = useRef();
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）⇒
  //    `columns` 从模块级常量搬进组件内部（与 Token.tsx / Customizing.jsx / app.jsx 的 links 同一条约束）。
  // ⚠️ 本文件没有把 t 放进任何 useCallback/useEffect 的依赖数组；将来若要放，
  //    🔴 必须先把 t 用 useCallback([intl]) 包起来（否则无限渲染/请求循环，见手册 §7.144 A、§7.145 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const columns = [
    { dataIndex: 'id', title: 'ID' },
    { dataIndex: 'name', title: t('common.colUsername', '用户名') },
    { dataIndex: 'nickname', title: t('common.colNickname', '昵称') },
    {
      dataIndex: 'permissions',
      title: t('common.colPermissions', '权限'),
      render: (data) => {
        return (
          <Tags
            // 🔴 这里的 map 参数原本叫 `t` —— 与翻译器**同名会遮蔽**（§7.144 F 同一个坑）⇒ 改名 perm。
            //    ⚠️ 权限标签本身仍是中文：它来自 `getPermissionLabel()`（CollaboratorModal 那个文件的口径），
            //    属于**那一批**的工作量，不在本批范围里（否则同一份权限名会有两处口径）。
            tags={data.map((perm) => {
              return getPermissionLabel(perm);
            })}
          />
        );
      },
    },
    {
      title: t('common.colOption', '操作'),
      render: (text, record, _, action) => [
        <CollaboratorModal
          initialValues={record}
          id={record.id}
          key="edit"
          onFinish={() => {
            action?.reload();
            message.success(t('sysconf.user.collaboratorUpdated', '修改协作者成功！'));
          }}
          trigger={<a>{t('common.edit', '修改')}</a>}
        />,
        <a
          key="delete"
          style={{ marginLeft: 8 }}
          onClick={() => {
            Modal.confirm({
              // 🔴 `common.deleteConfirmTitle` 是从 `sysconf.token.deleteConfirmTitle` **提升**上来的：
              //    「删除确认」这个弹窗标题在 Token 页与用户页是同一个性质 ⇒ 一个 key（不留同值两处）
              title: t('common.deleteConfirmTitle', '删除确认'),
              content: t('sysconf.user.collaboratorDeleteConfirm', '是否确认删除该协作者？'),
              onOk: async () => {
                await deleteCollaborator(record.id);
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
      <Card title={t('sysconf.user.cardTitle', '用户设置')}>
        <ProForm
          grid={true}
          layout={'horizontal'}
          labelCol={{ span: 6 }}
          request={async (params) => {
            return {
              name: initialState?.user?.name || '',
              password: initialState?.user?.password || '',
            };
          }}
          syncToInitialValues={true}
          onFinish={async (data) => {
            await updateUser({
              name: data.name,
              password: encryptPwd(data.name, data.password),
            });
            window.localStorage.removeItem('token');
            setInitialState((s) => ({ ...s, user: undefined }));
            history.push('/');
            message.success(t('sysconf.user.updateOk', '更新用户成功！请重新登录！'));
          }}
        >
          <ProFormText
            width="lg"
            name="name"
            required={true}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            label={t('sysconf.user.usernameLabel', '登录用户名')}
            placeholder={t('sysconf.user.usernamePlaceholder', '请输入登录用户名')}
          />
          {/* <ProFormText
            width="lg"
            name="nickname"
            required={true}
            rules={[{ required: true, message: '这是必填项' }]}
            label="昵称"
            placeholder={'请输入昵称（显示的名字）'}
          ></ProFormText> */}
          <ProFormText.Password
            width="lg"
            name="password"
            required={true}
            // ⚠️ 这条 `min` 是「改管理员口令」路径上 ≥10 的**唯一**强制点：提交时 encryptPwd
            //    会把口令派生成恒 64 位十六进制摘要，服务端看到的长度与原始口令无关（sha256 不可逆）。
            //    上面 request 里的 `password: initialState?.user?.password || ''` 恒为空串 ——
            //    服务端 /api/admin/meta 回传的 user 就是 JWT payload（username/sub/type/nickname/permissions），
            //    **不含 password**，所以这个框总是空的、每次保存都必须重新输入（既有行为，未改动）。
            // ⚠️ 下面 rules 里那条"口令最短长度"规则的提示文案是**共享常量**（被 passwordPolicy.test.js
            //    与 MIN_ACCOUNT_PASSWORD_LENGTH 一起钉着）⇒ 🔴 本批不动它，它的翻译属于那个共享模块的批次。
            // 🔴 这条注释**刻意不逐字写出那个工厂函数的调用形状**：它曾经写出过，结果把
            //    "四个后台口令表单都接上了规则"那条守卫**骗绿**了（守卫已修成先剥注释；详见手册 §7.146）。
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }, accountPasswordMinRule()]}
            autocomplete="new-password"
            label={t('sysconf.user.passwordLabel', '登录密码')}
            placeholder={t('sysconf.user.passwordPlaceholder', '请输入登录密码')}
          />
        </ProForm>
      </Card>
      <Card
        title={t('sysconf.user.collaboratorCard', '协作者')}
        style={{ marginTop: 8 }}
        className="card-body-full"
        extra={
          <Space>
            <CollaboratorModal
              onFinish={() => {
                message.success(t('sysconf.user.collaboratorCreated', '新建协作者成功！'));
                actionRef.current?.reload();
              }}
              trigger={<Button type="primary">{t('common.create', '新建')}</Button>}
            />
            <Button
              onClick={() => {
                Modal.info({
                  title: t('sysconf.user.helpTitle', '协作者功能'),
                  content: (
                    <div>
                      <p>
                        <span>{t('sysconf.user.helpP1', '您可以添加一些具有指定权限的协作者用户。')}</span>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          // 上游这个地址已经 404
                          href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/collaborator.md"
                        >
                          {t('init.wizard.helpDoc', '帮助文档')}
                        </a>
                      </p>
                      <p>
                        {t(
                          'sysconf.user.helpP2',
                          '协作者默认具有文章、草稿、图片的查看/上传权限，其余权限需要您显式指定。',
                        )}
                      </p>
                      <p>
                        {t(
                          'sysconf.user.helpP3',
                          '协作者登录后将看到被精简的后台页面（除非此协作者具备所有权限），同时无权限的接口将抛错。',
                        )}
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
            let { data } = await getAllCollaborators();
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
