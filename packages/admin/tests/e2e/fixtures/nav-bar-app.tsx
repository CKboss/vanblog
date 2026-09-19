import { render } from 'react-dom';
import NavBar from '../../../../website/components/NavBar';
import { ThemeContext } from '../../../../website/utils/themeContext';

const params = new URLSearchParams(window.location.search);
const siteName = params.get('name') || 'Van';

// ⚠️ 下面这个 <NavBar> 以前还传了 `showFriends="false"`：那个设置是**死的** ——
// NavBar / NavBarMobile 只在 props 接口里声明它、JSX 从来不读，所以设成 false 前台毫无变化，
// 而后台也没有任何控件能设它。已连同 DTO / getLayoutProps / Layout 一起整条删除。
// 隐藏友链走后台「数据管理 → 导航配置」删掉那一项即可：NavBar 的导航项本来就是从
// `props.menus` 渲染的（这与 showRSS 不同 —— RSS 入口是硬编码元素，所以它需要自己的开关）。
// 钉子见 packages/server/src/deadSettingShowFriends.spec.ts。
// ⚠️ 这段说明**不要**挪回 JSX 的属性之间：`{/* … */}` 只在 children 位置合法，
//    放在属性位置 esbuild 会直接报 `Expected "..." but found "}"` 并让整个夹具构建失败。
const App = () => (
  <ThemeContext.Provider
    value={{
      theme: 'auto-light',
      setTheme: () => {},
    }}
  >
    <NavBar
      logo=""
      logoDark=""
      categories={[]}
      setOpen={() => {}}
      isOpen={false}
      siteName={siteName}
      menus={[{ id: 1, name: '首页', value: '/', level: 0 }]}
      showSubMenu="false"
      showAdminButton="false"
      showRSS="false"
      headerLeftContent="siteName"
      defaultTheme="light"
      subMenuOffset={0}
      openArticleLinksInNewWindow={false}
    />
  </ThemeContext.Provider>
);

const target = document.getElementById('app');
if (!target) {
  throw new Error('Missing #app');
}

render(<App />, target);
