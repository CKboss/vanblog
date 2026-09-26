import Footer from '@/components/Footer';
import { login } from '@/services/van-blog/api';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { notifyLoginSuccess } from '@/services/van-blog/requestError';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormCheckbox, ProFormText } from '@ant-design/pro-form';
import { message } from 'antd';
import { history, SelectLang, useIntl, useModel } from 'umi';
import styles from './index.less';

const Login = () => {
  const type = 'account';
  const { initialState, setInitialState } = useModel('@@initialState');
  const intl = useIntl();
  // 🔴 与 InitPage/index.tsx 里第一期的 t() 保持**同一个形状**（id + defaultMessage），
  //    这样 defaultMessage 与 zh-CN 语言包逐字相同的约定只有一处口径，
  //    并由 localePackParity 守卫钉住（它断言两者逐字相等）。
  const t = (id, defaultMessage, values) =>
    intl.formatMessage({ id, defaultMessage }, values);

  const handleSubmit = async (values) => {
    try {
      // 登录
      const msg = await login({ ...values, type });

      if (msg.statusCode === 200) {
        // 🔴 显式传译文：`notifyLoginSuccess` 的默认值是 identity 视图（永远中文），
        //    而这条 toast 是**登录成功那一刻**用户唯一看到的一句话（§7.163 A 那类"静默不跟随语言"）
        notifyLoginSuccess(message, t('request.loginSuccess', '登录成功！'));
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
          {/* 🔴 可发现性修复：SelectLang 渲染的是 antd Dropdown 的**纯图标触发器**，
              实测它的 aria-label / title / 文本**全为空**（浏览器抓到的真实 HTML：
              <span class="ant-dropdown-trigger" style="…"><i class="anticon"><svg …/>），
              ⇒ 站长连着两次都没认出来它是语言切换器。
              ⚠️ 这里用**静态双语** title/aria-label 而不是 t()：这一层要同时服务
              「还没切语言的人」，而切成某一种语言后单语提示对另一批人就失效了。
              🔴 并且刻意不写任何语言自称（简体中文/繁體中文/English）——
              那是 SelectLang 内置 defaultLangUConfigMap 的职责，
              localePackParity 守卫钉住「语言自称不许在本仓库硬编码第二遍」。
              ⚠️ 不要再包一层 antd Tooltip：SelectLang 自己就是 Dropdown，两个触发器会打架。 */}
          <span
            role="group"
            title={'语言 · Language'}
            aria-label={'语言 · Language'}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <SelectLang />
          </span>
        </div>
        <LoginForm
          className={styles.loginForm}
          logo={<img alt="logo" src="/logo.svg" />}
          title="VanBlog"
          subTitle={t('login.subTitle', 'VanBlog 博客管理后台')}
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
                placeholder={t('login.usernamePlaceholder', '用户名')}
                rules={[
                  {
                    required: true,
                    message: t('login.usernameRequired', '用户名是必填项！'),
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
                placeholder={t('login.passwordPlaceholder', '密码')}
                rules={[
                  {
                    required: true,
                    message: t('login.passwordRequired', '密码是必填项！'),
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
              {t('login.autoLogin', '自动登录')}
            </ProFormCheckbox>
            <a
              onClick={() => {
                history.push('/user/restore');
              }}
            >
              {t('login.forgotPassword', '忘记密码')}
            </a>
          </div>
        </LoginForm>
      </div>
      <Footer />
    </div>
  );
};

export default Login;
