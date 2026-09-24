import Footer from '@/components/Footer';
import { shouldNotifyNewVersion } from '@/services/van-blog/version';
import { HomeOutlined, LogoutOutlined, ProjectOutlined } from '@ant-design/icons';
import { PageLoading, SettingDrawer } from '@ant-design/pro-layout';
import { message, Modal, notification } from 'antd';
import moment from 'moment';
import { history, Link, SelectLang } from 'umi';
import defaultSettings from '../config/defaultSettings';
import LogoutButton from './components/LogoutButton';
import ThemeButton from './components/ThemeButton';
import { fetchAllMeta } from './services/van-blog/api';
import { checkUrl } from './services/van-blog/checkUrl';
import {
  adaptAdminResponse,
  handleAdminRequestError,
} from './services/van-blog/requestError';
import { beforeSwitchTheme, getInitTheme, mapTheme } from './services/van-blog/theme';
const isDev = process.env.UMI_ENV === 'dev';
const loginPath = '/user/login';
/** 获取用户信息比较慢的时候会展示一个 loading */

export const initialStateConfig = {
  loading: <PageLoading />,
};
/**
 * @see  https://umijs.org/zh-CN/plugins/plugin-initial-state
 * */
export async function getInitialState() {
  const fetchInitData = async (option) => {
    try {
      const msg = await fetchAllMeta(option);
      if (msg.statusCode == 233) {
        history.push('/init');
        return msg.data || {};
      } else if (history.location.pathname == '/init' && msg.statusCode == 200) {
        history.push('/');
      }
      return msg.data;
    } catch (error) {
      // console.log('fet init data error', error);
      history.push(loginPath);
      return {};
    }
  }; // 如果不是登录页面，执行
  let option = {};
  if (
    history.location.pathname == loginPath ||
    history.location.pathname == '/init' ||
    !localStorage.getItem('token')
  ) {
    option.skipErrorHandler = true;
  }
  const initData = await fetchInitData(option);

  const { latestVersion, updatedAt, baseUrl, allowDomains, version } = initData;

  if (baseUrl && !checkUrl(baseUrl)) {
    Modal.warn({
      title: '网站 URL 不合法',
      content: (
        <div>
          <p>
            您在站点设置中填写的“网站 URL”不合法，这将导致一些奇怪的问题（比如生成的 RSS
            订阅源错误等）
          </p>
          <p>网站 URL 需包含完整的协议。</p>
          <p>例如： https://blog.example.com</p>
          <a
            onClick={() => {
              history.push('/site/setting?siteInfoTab=basic');
              return true;
            }}
          >
            前往修改
          </a>
        </div>
      ),
    });
  }
  // 来一个横幅提示。
  // ⚠️ 别改回字符串比较：源码构建的版本号形如 `dev/dsh@1a2b3c4`，
  //    `'dev/dsh@…' >= 'v0.54.0'` 首字符 'd' < 'v' → 每次进后台都弹假警报；
  //    而且字符串比较连 `0.9.0` 与 `0.10.0` 都会判错。见 services/van-blog/version.js。
  if (shouldNotifyNewVersion(version, latestVersion)) {
    {
      const skipVersion = localStorage.getItem('skipVersion');
      if (skipVersion != latestVersion) {
        // 老的
        notification.info({
          duration: 3000,
          message: (
            <div>
              <p style={{ marginBottom: 4 }}>有新版本！</p>
              <p style={{ marginBottom: 4 }}>{`当前版本:\t${version}`}</p>
              <p style={{ marginBottom: 4 }}>{`最新版本:\t${latestVersion}`}</p>
              <p style={{ marginBottom: 4 }}>{`更新时间:\t${moment(updatedAt).format(
                'YYYY-MM-DD HH:mm:ss',
              )}`}</p>
              <p style={{ marginBottom: 4 }}>
                {`更新日志:\t`}
                <a
                  target={'_blank'}
                  // 更新日志看仓库里的 CHANGELOG.md：里面有本分支专门的 🍴 区块，
                  // 上游那份不含本分支的任何改动
                  href="https://github.com/CKboss/vanblog/blob/dev/dsh/CHANGELOG.md"
                  rel="noreferrer"
                >
                  点击查看
                </a>
              </p>
              <p style={{ marginBottom: 4 }}>
                {`更新方法:\t`}
                <a
                  target={'_blank'}
                  href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/guide/update.md"
                  rel="noreferrer"
                >
                  点击查看
                </a>
              </p>
              <p style={{ marginBottom: 4 }}>
                PS： 更新后如后台一直 loading 或出现 Fetch error 请手动清理一下浏览器缓存
              </p>
              <a
                onClick={() => {
                  window.localStorage.setItem('skipVersion', latestVersion);
                  message.success('跳过此版本成功！下次进入后台将不会触发此版本的升级提示');
                  const el = document.querySelector('.ant-notification-notice-close-x');
                  if (el) {
                    el.click();
                  }
                }}
              >
                跳过此版本
              </a>
            </div>
          ),
        });
      }
    }
  }
  // 暗色模式
  const theme = getInitTheme();
  const sysTheme = mapTheme(theme);
  return {
    fetchInitData,
    ...initData,
    settings: { ...defaultSettings, navTheme: sysTheme },
    theme,
  };
} // ProLayout 支持的api https://procomponents.ant.design/components/layout

const handleSizeChange = () => {
  const headerPoint = 768;
  const show = window.innerWidth > headerPoint ? false : true;
  if (show) {
    const el = document.querySelector('header.ant-layout-header');
    if (el) {
      el.style.display = 'block';
    }
    // console.log('show');
  } else {
    const el = document.querySelector('header.ant-layout-header');
    if (el) {
      el.style.display = 'none';
    }
    // console.log('hidden');
  }
};

window.onresize = handleSizeChange;

export const layout = ({ initialState, setInitialState }) => {
  handleSizeChange();
  return {
    rightContentRender: () => {
      return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* 🔴 必须在这里显式渲染 <SelectLang />：本文件导出的运行时 `layout` 配置里
              一旦提供了 `rightContentRender`，它就会**整体覆盖** plugin-layout 生成的
              右侧内容 —— 而 `@umijs/plugin-locale` 注册后那个"自动出现在头部"的语言
              切换器，正是由 plugin-layout 的
              `genRenderRightContent({ locale: api.hasPlugins([...]) })` 放进去的。
              ⇒ 所以"启用 locale 插件头部就会自动出现切换器"这个推断在本仓库**不成立**：
              组件确实被编译进了产物，但从来没有被渲染。
              ⚠️ 判据是"产物里搜得到切换器要显示的文字"（注意 terser 会把非 ASCII
              转义成 \uXXXX，必须按转义形式搜），而不是"某个生成文件存在"。 */}
          {/* 🔴 可发现性修复：这一处同样只是纯图标（无 title/aria-label/文本），
              站长在后台头部连着两次都没认出来。
              ⚠️ 这里**不能用 t()/useIntl**：rightContentRender 是普通函数、不是 React
              组件，在里面调 hook 会违反 hooks 规则 ⇒ 用静态双语 title。
              🔴 并且 <SelectLang /> 必须**独占一行且行首只有空白**，因为
              localePackParity 守卫用 /^\s*<SelectLang\s*\/>/m 在 rightContentRender
              的作用域里断言它被渲染。 */}
          <span
            role="group"
            title={'语言 · Language'}
            aria-label={'语言 · Language'}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <SelectLang />
          </span>
          <ThemeButton showText={false} />
          <LogoutButton
            key="logoutRightContent"
            trigger={
              <a>
                <LogoutOutlined />
                <span style={{ marginLeft: 6 }}>登出</span>
              </a>
            }
          />
        </div>
      );
    },
    // disableContentMargin: true,
    footerRender: () => {
      // const { location } = history;
      // const disableArr = ['/editor', '/site/comment'];
      // if (disableArr.includes(location.pathname)) {
      //   return false;
      // }
      // 目前 footer 只有发 console.log 一个功能了。
      return <Footer />;
    },
    onPageChange: () => {
      const { location } = history; // 如果没有登录，重定向到 login
      if (location.pathname === '/init' && !initialState?.user) {
        return;
      }
      if (!initialState?.user && ![loginPath, '/user/restore'].includes(location.pathname)) {
        history.push(loginPath);
      }
      if (location.pathname == loginPath && Boolean(initialState?.user)) {
        history.push('/');
      }
    },
    links: [
      <a key="mainSiste" rel="noreferrer" target="_blank" href={'/'}>
        <HomeOutlined />
        <span>主站</span>
      </a>,
      <Link key="AboutLink" to={'/about'}>
        <ProjectOutlined />
        <span>关于</span>
      </Link>,
      // 🔴 这里必须再放一个语言切换器：本文件上方的 `handleSizeChange()` 在
      // `window.innerWidth > 768` 时把 `header.ant-layout-header` 直接设成 `display: none`
      // ⇒ **桌面端整个后台头部是隐藏的**，所以 rightContentRender 里的切换器 / 主题 / 登出
      //    在桌面端一个都看不见（实测：1600px 视口下 header 与语言控件都是 0×0，
      //    700px 视口下 header 700×48、语言控件 42×42 可见）。
      // 侧边栏的 links 区是桌面端唯一常驻可见的操作区 —— 主题按钮与登出本来就已经在这里
      // 各重复了一份，所以语言切换器也照同一个模式放一份。
      // ⚠️ 这**不是冗余**：两处对应两种视口（≤768px 走头部，>768px 走侧边栏）。
      // 🔴 由 tests/unit/localePackParity.test.js 钉住"links 数组里必须有 SelectLang"，删掉会红。
      <SelectLang key="langSider" />,
      <ThemeButton key="themeBtn" showText={true} />,
      <LogoutButton
        key="logoutSider"
        trigger={
          <a>
            <LogoutOutlined />
            <span>登出</span>
          </a>
        }
      />,
    ],

    // 自定义 403 页面
    // unAccessible: <div>unAccessible</div>,
    // 增加一个 loading 的状态
    childrenRender: (children, props) => {
      // if (initialState?.loading) return <PageLoading />;
      return (
        <>
          {children}
          {
            <SettingDrawer
              disableUrlParams
              enableDarkTheme
              // colorList={false}
              settings={initialState?.settings}
              // themeOnly={true}
              onSettingChange={(settings) => {
                const user = initialState?.user;
                const isCollaborator = user?.type && user?.type == 'collaborator';
                if (isCollaborator) {
                  settings.title = '协作模式';
                }
                if (settings.navTheme != initialState?.settings?.navTheme) {
                  // 切换了主题
                  beforeSwitchTheme(settings.navTheme);
                }
                setInitialState((preInitialState) => ({
                  ...preInitialState,
                  settings,
                }));
              }}
            />
          }
        </>
      );
    },
    ...initialState?.settings,
  };
};
export const request = {
  errorConfig: {
    adaptor: (resData) => {
      return adaptAdminResponse(resData, {
        pathname: history?.location?.pathname,
      });
    },
  },
  errorHandler: (error) => {
    handleAdminRequestError(error, {
      message,
      pathname: history?.location?.pathname,
    });
  },
  requestInterceptors: [
    (url, options) => {
      return {
        url: url,
        options: {
          ...options,
          interceptors: true,
          headers: {
            token: (() => {
              return window.localStorage.getItem('token') || 'null';
            })(),
          },
        },
      };
    },
  ],
  // responseInterceptors: [
  //   response => {
  //     if (response.statusCode === 233) {
  //       console.log("go to init!")
  //       // window.location.pathname = '/init'
  //       history.push('/init')
  //       return response
  //     } else {
  //       return response
  //     }

  //   }
  // ]
};
