import { restore } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { accountPasswordMinRule } from '@/services/van-blog/passwordPolicy';
import ProCard from '@ant-design/pro-card';
import ProForm, { ProFormText } from '@ant-design/pro-form';
import { Alert, message } from 'antd';
import { history, SelectLang } from 'umi';
export default function () {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        backgroundImage: `url('/background.svg')`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: '100%',
        backgroundColor: '#f0f2f5',
        justifyContent: 'center',
      }}
    >
      {/* 🔴 与登录页同理：`/user/restore` 也在 `layout: false` 子树里（config/routes.js），
          拿不到后台头部的切换器；忘记密码时同样需要在登录之前就能切换语言。
          ⚠️ 绝对定位，避免扰动这层 `display:flex; justifyContent:center` 的布局。 */}
      <div style={{ position: 'absolute', top: 16, right: 24 }}>
        {/* 🔴 同 Login：SelectLang 是纯图标触发器（无 title/aria-label/文本），
            加一层静态双语提示让它可被辨识；不写语言自称（守卫钉住）。 */}
        <span
          role="group"
          title={'语言 · Language'}
          aria-label={'语言 · Language'}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <SelectLang />
        </span>
      </div>
      <ProCard
        title="忘记密码"
        bordered
        style={{ maxWidth: '700px', marginTop: '200px', maxHeight: '470px' }}
      >
        <Alert
          type="info"
          style={{ marginBottom: 12 }}
          message={
            <p style={{ marginBottom: 0 }}>
              VanBlog
              会在每次启动时在日志中打印随机的恢复密钥，同时也会将其写入到您挂载的日志目录中的
              restore.key 文件中。
            </p>
          }
        ></Alert>
        <ProForm
          onFinish={async (values) => {
            await restore({
              ...values,
              password: encryptPwd(values.name, values.password),
            });
            message.success('重置成功！恢复密钥将重新生成！');
            history.push('/user/login');
          }}
        >
          <ProFormText.Password name="key" label="请输入恢复密钥" />
          <ProFormText name="name" label="请输入新用户名" />
          {/* ⚠️ 「忘记密码」是整条口令策略里最关键的一处：拿着恢复密钥的人在这里**重设管理员口令**。
              如果这里放行弱口令，前面所有表单的 ≥10 都白做了（攻击者只要拿到一次恢复密钥，
              就能把管理员口令换成 1 个字符）。所以 required 与 min 都要有 —— 这个表单原本
              **一条规则都没有**，空值也能提交，只会被服务端 400 挡回来，用户看到的是一句
              与服务端措辞不同的报错。
              服务端同样判不了强度：提交前 encryptPwd 已把它派生成恒 64 位摘要。 */}
          <ProFormText.Password
            name="password"
            label="请输入新密码"
            rules={[{ required: true, message: '这是必填项' }, accountPasswordMinRule()]}
          />
        </ProForm>
      </ProCard>
    </div>
  );
}
