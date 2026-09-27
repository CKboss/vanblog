import { createCollaborator, updateCollaborator } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { accountPasswordMinRule } from '@/services/van-blog/passwordPolicy';
import { ModalForm, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { useIntl } from 'umi';

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。模块级常量/纯函数拿不到 hook
 * ⇒ 由调用方在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**。
 * ⚠️ 下面大写常量是 **identity 视图**（给单测与还没接 i18n 的调用方用）；
 *    🔴 `value` 那一份是**线路字面量**（发给服务端的权限 id），任何语言下都不许动。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type InjectedT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;



// TODO: Extract this
const permissionOptions = (t: InjectedT = IDENTITY_T) => [
  {
    label: t('collab.permArticleCreate', '创建-文章'),
    value: 'article:create',
  },

  {
    label: t('collab.permArticleUpdate', '修改-文章'),
    value: 'article:update',
  },
  {
    label: t('collab.permArticleDelete', '删除-文章'),
    value: 'article:delete',
  },
  {
    label: t('collab.permDraftPublish', '发布-草稿'),
    value: 'draft:publish',
  },
  {
    label: t('collab.permDraftCreate', '创建-草稿'),
    value: 'draft:create',
  },
  {
    label: t('collab.permDraftUpdate', '修改-草稿'),
    value: 'draft:update',
  },
  {
    label: t('collab.permDraftDelete', '删除-草稿'),
    value: 'draft:delete',
  },
  {
    label: t('collab.permImgDelete', '删除-图片'),
    value: 'img:delete',
  },
  {
    label: t('collab.permImgReplace', '替换-图片'),
    value: 'img:replace',
  },
  {
    label: t('collab.permFileDelete', '删除-附件'),
    value: 'file:delete',
  },
  {
    label: t('collab.permAll', '所有权限'),
    value: 'all',
  },
];

/** identity 视图 */
const PERMISSION_OPTIONS = permissionOptions();
// 🔴 t 是**尾参**（调用点判据按"最后一个实参是不是 t"看）；不传 ⇒ 与改造前逐字相同。
export const getPermissionLabel = (
  permissionId: string,
  t: InjectedT = IDENTITY_T,
): string | undefined =>
  permissionOptions(t).find(({ value }) => {
    return value == permissionId;
  })?.label;

// TODO: Add Types
export default ({ onFinish, id, trigger, initialValues }) => {
  // 🔴 期 6 第十二批：接上 i18n（语言选择必须在渲染期）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
  <ModalForm
    title={id ? t('collab.editTitle', '修改协作者') : t('collab.createTitle', '新建协作者')}
    trigger={trigger}
    width={450}
    autoFocusFirstInput
    submitTimeout={3000}
    initialValues={initialValues || undefined}
    onFinish={async (values) => {
      if (id) {
        await updateCollaborator({
          id,
          ...values,
          password: encryptPwd(values.name, values.password),
        });
      } else {
        await createCollaborator({
          ...values,
          password: encryptPwd(values.name, values.password),
        });
      }

      if (onFinish) {
        onFinish();
      }

      return true;
    }}
    layout="horizontal"
    labelCol={{ span: 6 }}
    // wrapperCol: { span: 14 },
  >
    <ProFormText
      width="md"
      required
      id="name"
      name="name"
      label={t('login.usernamePlaceholder', '用户名')}
      placeholder={t('collab.namePlaceholder', '请输协作者用户名')}
      tooltip={t('collab.nameTooltip', '协作者用来登录的用户名')}
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
    />
    <ProFormText
      width="md"
      required
      id="nickname"
      name="nickname"
      label={t('common.colNickname', '昵称')}
      placeholder={t('collab.nicknamePlaceholder', '请输协作者昵称')}
      tooltip={t('collab.nicknameTooltip', '协作者显示的名字')}
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
    />
    <ProFormText.Password
      width="md"
      required
      id="password"
      name="password"
      label={t('login.passwordPlaceholder', '密码')}
      placeholder={t('collab.passwordPlaceholder', '请输协作者密码')}
      tooltip={t('collab.passwordTooltip', '协作者登录的密码')}
      // ⚠️ 这条 `min` 是协作者口令 ≥10 的**唯一**强制点（提交时 encryptPwd 会把它派生成
      //    恒 64 位摘要，服务端看到的长度与原始口令无关，判不了强度）。
      //    新建与修改两条提交路径共用这一个字段，所以两处都受约束。
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }, accountPasswordMinRule(t)]}
    />
    <ProFormSelect
      width="md"
      required
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
      name="permissions"
      label={t('common.colPermissions', '权限')}
      placeholder={t('collab.permissionsPlaceholder', '请选择协作者具有的权限')}
      tooltip={t('collab.permissionsTooltip', '协作者具有的权限')}
      fieldProps={{
        mode: 'multiple',
        // 🔴 必须调**函数版**并传 t：读 identity 常量 `PERMISSION_OPTIONS` 的话这 11 个权限标签永远是中文
        //    （localePackParity 有一条判据专门盯这件事，本轮就是它报出来的）。
        options: permissionOptions(t),
      }}
    />
  </ModalForm>
  );
};
