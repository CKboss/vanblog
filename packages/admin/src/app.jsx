import Footer from '@/components/Footer';
import { shouldNotifyNewVersion } from '@/services/van-blog/version';
import { HomeOutlined, LogoutOutlined, ProjectOutlined } from '@ant-design/icons';
import { PageLoading, SettingDrawer } from '@ant-design/pro-layout';
import { message, Modal, notification } from 'antd';
import moment from 'moment';
import { getDirection, getIntl, getLocale, history, Link, SelectLang, useIntl } from 'umi';
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

/**
 * 🔴 把当前语言同步到 `<html lang>` 与 `<html dir>`。
 *
 * ## 为什么需要它
 * umi 的 `@umijs/plugin-locale` **不会**碰 `document.documentElement`（实测：它的生成物里
 * `documentElement` 出现 0 次）⇒ 切到 English 之后 `<html lang>` 仍是 `zh-CN`。后果是具体的：
 *   - 屏幕阅读器会用**中文发音规则**读英文界面；
 *   - 浏览器的"要不要翻译此页"提示会判断错；
 *   - 🔴 将来加 RTL 语言时 `dir` 不会跟着变，整个布局会错。
 *
 * ## 🔴 为什么用 umi 自己的 `getDirection()` 而不是自己列 RTL 语言
 * `plugin-locale/localeExports.ts` 已经导出了 `getDirection()`，它的实现是
 * `['he','ar','fa','ku'].some(前缀匹配) ? 'rtl' : 'ltr'`，并且经 `umiExports.ts` 的
 * `export * from '../plugin-locale/localeExports'` 可以从 `'umi'` 直接导入。
 * ⇒ 🔴 **复用它 = 不引入第二份"哪些语言是 RTL"的口径**（那正是本仓库反复吃过亏的形状）。
 * ⚠️ 注意 `SelectLang` 的 `|| { lang: key, label: key }` 回落分支意味着：**谁只要新增一个 `ar.ts`
 *    语言包，切换器就会立刻提供阿拉伯语** —— 那时 `dir` 会自动变成 `rtl`，但**整套布局从未按 RTL 验证过**。
 *    所以"新增 RTL 语言"是一次需要专门验证的改动，不是"加个语言包"那么轻。
 *
 * ## 🔴 为什么在这里调用（而不是在 `links` 数组那种模块加载期的位置）
 * `getLocale()` 内部会走 `plugin.applyPlugins(...)`，**依赖 umi 插件运行时已初始化** ⇒
 * 不能在模块加载期调用（`export const layout = {...}` 那个普通对象就是加载期求值的，上一轮已踩过）。
 * 这里定义成函数、在 `getInitialState()` 与 `layout` 工厂里调用，两者都是**运行时钩子**，
 * 一定在插件运行时之后执行。
 * 🔴 **两处都调**是因为覆盖面不同：`getInitialState()` 对**所有路由**生效（含 `layout: false` 的
 * 登录页与安装页），而 `layout` 工厂只对走 ProLayout 的路由生效 ⇒ 只放后者会漏掉登录页。
 * 幂等：重复调用只是把同一个值再写一次。
 */
const syncDocumentLocale = () => {
  if (typeof document === 'undefined' || !document.documentElement) return;
  try {
    const lang = getLocale();
    if (lang) document.documentElement.setAttribute('lang', lang);
    // 🔴 dir 用 umi 的 getDirection()（它已经处理了 RTL 语言清单）
    const dir = typeof getDirection === 'function' ? getDirection() : 'ltr';
    document.documentElement.setAttribute('dir', dir || 'ltr');
  } catch (e) {
    // 🔴 这是纯装饰性的副作用，绝不能因为它失败而让整个应用起不来。
    //    但也不要完全静默：留一条 warn 便于排障（本仓库的日志一直是排障的主要线索）。
    // 🔴 这条 warn 刻意用 ASCII 而不是中文：它是**开发者控制台**消息、不是用户界面文案，
    //    而本文件已被 i18nHardcodedRatchet 的"裸中文预算"钉住（预算 18）。
    //    实测：写成中文会让预算变成 19 并当场弄红棘轮 —— 那正是棘轮想要的行为
    //    （它在被写出来的同一轮就抓住了作者自己新加的硬编码中文）。
    // eslint-disable-next-line no-console
    console.warn('[i18n] failed to sync <html lang>/<html dir>:', e && e.message);
  }
};

/** 获取用户信息比较慢的时候会展示一个 loading */

export const initialStateConfig = {
  loading: <PageLoading />,
};
/**
 * @see  https://umijs.org/zh-CN/plugins/plugin-initial-state
 * */
export async function getInitialState() {
  // 🔴 第一句就同步 <html lang>/<html dir>：这里对所有路由生效（含 layout:false 的登录页与安装页）
  syncDocumentLocale();
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

// 🔴 侧边栏底部这三个文字必须在**组件里**翻译，不能在 `links` 数组里直接调：
//    `links` 位于 `export const layout = {...}` 这个**普通对象**里、在模块加载期就求值，
//    所以 ① 在那里调 `useIntl()` 会违反 hooks 规则（它不是 React 组件）；
//    ② 在模块加载期调 `getIntl(getLocale())` 也有时序风险 —— `getLocale()` 内部会走
//       `plugin.applyPlugins(...)`，依赖 umi 插件运行时已初始化。
//    用三个微型组件把翻译推迟到渲染期，同时**保留 `t('id', '默认文案')` 的字面量形状**，
//    这样 tests/unit/localePackParity.test.js 的 parseTCalls 仍能扫到它们，
//    并钉住「defaultMessage 与 zh-CN 语言包逐字相同」这条唯一口径。
//    ⚠️ 语言切换走 setLocale(lang, true) 的整页 reload，所以渲染期取值总是最新的。
function MainSiteLabel() {
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return <span>{t('common.mainSite', '主站')}</span>;
}

function AboutLabel() {
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return <span>{t('common.about', '关于')}</span>;
}

function LogoutLabel() {
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return <span>{t('common.logout', '登出')}</span>;
}

export const layout = ({ initialState, setInitialState }) => {
  handleSizeChange();
  // 🔴 与 handleSizeChange 并列：这里覆盖走 ProLayout 的路由（getInitialState 已覆盖全部路由，
  //    重复调用是幂等的；两处都放是为了"哪条路径先渲染都不会漏"）
  syncDocumentLocale();
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
        <MainSiteLabel />
      </a>,
      <Link key="AboutLink" to={'/about'}>
        <ProjectOutlined />
        <AboutLabel />
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
            <LogoutLabel />
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
/**
 * 🔴 造一个"服务端错误码 → 当前语言文案"的翻译器（期 9：服务端错误码框架）。
 *
 * ## 为什么是**注入**而不是在 `requestError.js` 里直接 import umi
 * 那个模块是**纯 JS**、会被 `node --test` 直接 `require()` ⇒ 拿不到 umi 插件运行时
 * （与 `InitPage/setupKeyCore.js`、`restoreCore.js` 同一条约束，见手册"纯 JS 模块用注入式翻译器"）。
 *
 * ## 🔴 为什么在**调用期**取 intl（而不是模块加载期）
 * `getLocale()`/`getIntl()` 内部走 `plugin.applyPlugins(...)`，模块加载期调用会拿到 undefined
 * （与 `links` 数组同一条约束）。`request` 这个导出对象本身在加载期求值，
 * 但 `adaptor`/`errorHandler` 的**函数体**是在请求发生时才跑 ⇒ 在函数体里造翻译器是安全的，
 * 而且 🔴 **每次请求都重造**，所以切语言之后的下一次报错就用新语言（不需要监听语言变化事件）。
 *
 * ## 🔴 失败方向：拿不到 intl 就返回 undefined
 * 那时 `requestError` 会**原样回落服务端的中文 message** —— 也就是今天的行为。
 * 👉 这是刻意选的"更安全的那一侧"：翻译不可用时退回旧行为，绝不能让错误提示变成裸 key 或空字符串
 * （用户在"操作失败"的那一刻最需要看懂那句话）。
 */
const makeServerErrorTranslator = () => {
  try {
    const intl = getIntl(getLocale());
    if (!intl || typeof intl.formatMessage !== 'function') return undefined;
    return (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  } catch (e) {
    return undefined;
  }
};

export const request = {
  errorConfig: {
    adaptor: (resData) => {
      return adaptAdminResponse(resData, {
        pathname: history?.location?.pathname,
        t: makeServerErrorTranslator(),
      });
    },
  },
  errorHandler: (error) => {
    handleAdminRequestError(error, {
      message,
      pathname: history?.location?.pathname,
      t: makeServerErrorTranslator(),
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
