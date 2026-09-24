import Footer from '@/components/Footer';
import { login } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { notifyLoginSuccess } from '@/services/van-blog/requestError';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormCheckbox, ProFormText } from '@ant-design/pro-form';
import { message } from 'antd';
import { history, SelectLang, useModel } from 'umi';
import styles from './index.less';

const Login = () => {
  const type = 'account';
  const { initialState, setInitialState } = useModel('@@initialState');

  const handleSubmit = async (values) => {
    try {
      // 登录
      const msg = await login({ ...values, type });

      if (msg.statusCode === 200) {
        notifyLoginSuccess(message);
        const token = msg.data.token;
        const user = {
          name: msg.data.user.name,
          id: msg.data.user.id,
        };
        window.localStorage.setItem('token', token);
        await setInitialState((s) => ({
          ...s,
          token: token,
          user: user,
        }));
        // 获取一下 init 的数据。
        const meta = await initialState?.fetchInitData();
        await setInitialState((s) => ({
          ...s,
          token: token,
          user: user,
          ...meta,
        }));
        /** 此方法会跳转到 redirect 参数所在的位置 */
        if (!history) return;
        const { query } = history.location;
        const { redirect } = query;
        history.push(redirect || '/');
        return;
      }
    } catch (error) {}
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {/* 🔴 `/user` 整棵子树是 `layout: false`（见 config/routes.js），拿不到后台头部
            那个切换器；而登录页是站长/读者看到的**第一屏**，且文案默认是中文 ⇒
            英文用户在登录之前就没法切换语言。所以在页内自己放一个，右对齐。
            ⚠️ 复用 umi `plugin-locale` 导出的 SelectLang，语言自称（简体中文/繁體中文/
            English）来自它内置的 defaultLangUConfigMap ⇒ 不在本仓库硬编码第二遍。 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <SelectLang />
        </div>
        <LoginForm
          className={styles.loginForm}
          logo={<img alt="logo" src="/logo.svg" />}
          title="VanBlog"
          subTitle={'VanBlog 博客管理后台'}
          initialValues={{
            autoLogin: true,
          }}
          onFinish={async (values) => {
            const { username, password } = values;
            await handleSubmit({
              username,
              password: encryptPwd(username, password),
            });
          }}
        >
          {type === 'account' && (
            <>
              <ProFormText
                name="username"
                autoComplete="off"
                fieldProps={{
                  size: 'large',
                  prefix: <UserOutlined className={styles.prefixIcon} />,
                }}
                placeholder={'用户名'}
                rules={[
                  {
                    required: true,
                    message: '用户名是必填项！',
                  },
                ]}
              />
              <ProFormText.Password
                name="password"
                autoComplete="off"
                fieldProps={{
                  size: 'large',
                  prefix: <LockOutlined className={styles.prefixIcon} />,
                }}
                placeholder={'密码'}
                rules={[
                  {
                    required: true,
                    message: '密码是必填项！',
                  },
                ]}
              />
            </>
          )}
          <div
            style={{
              marginBottom: 24,
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <ProFormCheckbox noStyle name="autoLogin">
              自动登录
            </ProFormCheckbox>
            <a
              onClick={() => {
                history.push('/user/restore');
              }}
            >
              忘记密码
            </a>
          </div>
        </LoginForm>
      </div>
      <Footer />
    </div>
  );
};

export default Login;
