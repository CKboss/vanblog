import { publishDraft } from '@/services/van-blog/api';
import { passwordHelp, passwordPlaceholder, buildAccessPasswordPatch } from '@/services/van-blog/accessPassword';
import { Modal } from 'antd';
import { ModalForm, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { message } from 'antd';
import PathnameField from '../PathnameField';
import { useIntl } from 'umi';
export default function (props) {
  const { title, id, trigger, action, onFinish } = props;
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      <ModalForm
        title={t('draft.publishTitle', '发布草稿: {title}', { title })}
        key="publishModal"
        trigger={trigger}
        width={450}
        autoFocusFirstInput
        submitTimeout={3000}
        onFinish={async (values) => {
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({
              title: t('common.demoBlockedCreate', '演示站禁止新建文章！'),
              content: t(
                'common.demoBlockedReason',
                '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
              ),
            });
            return;
          }
          // 发布 = 新建文章：选了「加密」却没填密码会造出一篇谁也打不开的文章
          // （服务端存空密码，解锁口对"标记加密但没密码"一律拒绝），而密码不可找回。
          const access = buildAccessPasswordPatch(
            {
              password: values?.pc,
              hasPassword: false,
              isCreate: true,
              isPrivate: values?.private,
            },
            t,
          );
          if (access.error) {
            message.error(access.error);
            return false;
          }
          await publishDraft(id, {
            ...values,
            password: values.pc,
            top: values.Ctop,
          });
          // 发布成功后草稿会被软删除进回收站（既有语义）：toast 里说清是「归档」，
          // 免得用户以为草稿丢了，或以为从回收站恢复草稿能撤销这次发布。
          message.success(
            t(
              'draft.publishOk',
              '发布成功！原草稿已自动移入草稿回收站（恢复它不会影响这篇已发布的文章）。',
            ),
          );
          if (action && action.reload) {
            action.reload();
          }
          if (props.onFinish) {
            props.onFinish();
          }
          return true;
        }}
        layout="horizontal"
        labelCol={{ span: 6 }}
      >
        <ProFormSelect
          width="md"
          name="private"
          id="private"
          label={t('common.encrypted', '是否加密')}
          placeholder={t('common.encrypted', '是否加密')}
          request={async () => {
            return [
              {
                label: t('common.no', '否'),
                value: false,
              },
              {
                label: t('common.yes', '是'),
                value: true,
              },
            ];
          }}
        />
        <ProFormText
          label={t('common.topPriority', '置顶优先级')}
          width="md"
          id="top"
          name="Ctop"
          placeholder={t(
            'common.topPriorityPlaceholder',
            '留空或0表示不置顶，其余数字越大表示优先级越高',
          )}
          autocomplete="new-password"
          fieldProps={{
            autocomplete: 'new-password',
          }}
        />
        <PathnameField />
        <ProFormText.Password
          label={t('common.password', '密码')}
          width="md"
          autocomplete="new-password"
          id="password"
          name="pc"
          placeholder={passwordPlaceholder({ isCreate: true }, t)}
          formItemProps={{ extra: passwordHelp({ isCreate: true }, t) }}
          dependencies={['private']}
          fieldProps={{
            autocomplete: 'new-password',
          }}
        />
        <ProFormSelect
          width="md"
          name="hidden"
          id="hidden"
          label={t('common.hiddenField', '是否隐藏')}
          placeholder={t('common.hiddenField', '是否隐藏')}
          request={async () => {
            return [
              {
                label: t('common.no', '否'),
                value: false,
              },
              {
                label: t('common.yes', '是'),
                value: true,
              },
            ];
          }}
        />
        <ProFormText
          width="md"
          id="copyright"
          name="copyright"
          label={t('common.copyright', '版权声明')}
          tooltip={t(
            'common.copyrightTooltip',
            '设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示',
          )}
          placeholder={t('common.copyrightPlaceholder', '设置后会替换掉文章底部默认的版权')}
        />
      </ModalForm>
    </>
  );
}
