import { createCollaborator, updateCollaborator } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { accountPasswordMinRule } from '@/services/van-blog/passwordPolicy';
import { ModalForm, ProFormSelect, ProFormText } from '@ant-design/pro-form';

// TODO: Extract this
const PERMISSION_OPTIONS = [
  {
    label: '创建-文章',
    value: 'article:create',
  },

  {
    label: '修改-文章',
    value: 'article:update',
  },
  {
    label: '删除-文章',
    value: 'article:delete',
  },
  {
    label: '发布-草稿',
    value: 'draft:publish',
  },
  {
    label: '创建-草稿',
    value: 'draft:create',
  },
  {
    label: '修改-草稿',
    value: 'draft:update',
  },
  {
    label: '删除-草稿',
    value: 'draft:delete',
  },
  {
    label: '删除-图片',
    value: 'img:delete',
  },
  {
    label: '替换-图片',
    value: 'img:replace',
  },
  {
    label: '删除-附件',
    value: 'file:delete',
  },
  {
    label: '所有权限',
    value: 'all',
  },
];
export const getPermissionLabel = (permissionId: string): string | undefined =>
  PERMISSION_OPTIONS.find(({ value }) => {
    return value == permissionId;
  })?.label;

// TODO: Add Types
export default ({ onFinish, id, trigger, initialValues }) => (
  <ModalForm
    title={id ? '修改协作者' : '新建协作者'}
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
      label="用户名"
      placeholder="请输协作者用户名"
      tooltip="协作者用来登录的用户名"
      rules={[{ required: true, message: '这是必填项' }]}
    />
    <ProFormText
      width="md"
      required
      id="nickname"
      name="nickname"
      label="昵称"
      placeholder="请输协作者昵称"
      tooltip="协作者显示的名字"
      rules={[{ required: true, message: '这是必填项' }]}
    />
    <ProFormText.Password
      width="md"
      required
      id="password"
      name="password"
      label="密码"
      placeholder="请输协作者密码"
      tooltip="协作者登录的密码"
      // ⚠️ 这条 `min` 是协作者口令 ≥10 的**唯一**强制点（提交时 encryptPwd 会把它派生成
      //    恒 64 位摘要，服务端看到的长度与原始口令无关，判不了强度）。
      //    新建与修改两条提交路径共用这一个字段，所以两处都受约束。
      rules={[{ required: true, message: '这是必填项' }, accountPasswordMinRule()]}
    />
    <ProFormSelect
      width="md"
      required
      rules={[{ required: true, message: '这是必填项' }]}
      name="permissions"
      label="权限"
      placeholder={'请选择协作者具有的权限'}
      tooltip="协作者具有的权限"
      fieldProps={{
        mode: 'multiple',
        options: PERMISSION_OPTIONS,
      }}
    />
  </ModalForm>
);
