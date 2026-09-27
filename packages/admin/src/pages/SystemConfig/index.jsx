import { useTab } from '@/services/van-blog/useTab';
import { useIntl } from 'umi';
import { PageContainer } from '@ant-design/pro-layout';
import thinstyle from '../Welcome/index.less';
import Advance from './tabs/Advance';
import Backup from './tabs/Backup';
import Caddy from './tabs/Caddy';
import Customizing from './tabs/Customizing';
import ImgTab from './tabs/ImgTab';
import Migrate from './tabs/migrate';
import SiteInfo from './tabs/SiteInfo';
import Theme from './tabs/Theme';
import User from './tabs/User';
import WalineTab from './tabs/WalineTab';
import Token from './tabs/Token';
export default function () {
  // 🔴 期 6 第八批：页签标签接上 i18n。
  //    ⚠️ 这里原来有一段注释说这组标签**刻意尚未**接入 i18n，理由是它们与 `analysisFields.js` /
  //    `walineEmailFields.js` 里给用户看的后台导航路径常量、以及文档站**三处互相引用**。
  //    🔴 站长裁定 B（§7.169）已解锁 ⇒ 这一批把三处**一起做**（两个导航路径常量也改成了注入式翻译器），
  //    所以不会出现界面英文而导航路径仍中文的不一致。⚠️ 文档站仍保持中文（那条裁定不变）。
  //    ⚠️ `themeTab` 与 `adminCopySync` 两个测试钉的是 **identity 视图**（中文常量）⇒ 不受影响。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const tabMap = {
    siteInfo: <SiteInfo />,
    theme: <Theme />,
    customizing: <Customizing />,
    backup: <Backup />,
    user: <User />,
    img: <ImgTab />,
    waline: <WalineTab />,
    caddy: <Caddy />,
    advance: <Advance />,
    migrate: <Migrate />,
    token: <Token />,
  };
  const [tab, setTab] = useTab('siteInfo', 'tab');

  /* 🔴 下面 tabList 里这一组页签标签**刻意尚未**接入 i18n，不是漏翻。
   * 原因：这些标签名被三处独立陈述 —— 本文件的页签清单、`src/utils/analysisFields.js`
   * 与 `src/utils/walineEmailFields.js` 里给用户看的「后台导航路径」常量、以及文档站；
   * 而 `themeTab` 与 `adminCopySync` 两个测试把「后台标签 ↔ 文档措辞」钉在一起。
   * 前置条件：站长尚未就「文档 i18n」裁定 ⇒ 只翻这一侧会造成
   * 「界面英文、导航路径与文档仍是中文」的可见不一致，并弄红上述两个测试。
   * 裁定与三个选项的取舍见 AGENTS.md（🔴 那是**父代理裁定**，站长尚未就文档 i18n 表态）。
   * ⚠️ 本注释刻意不逐字引用任何页签标签的字面量形状：`themeTab` 与 `adminCopySync`
   * 正是用那种形状做 indexOf/正则匹配的（本仓库已三次栽在「注释里写了别处要搜索的字面量」）。 */
  return (
    <PageContainer
      title={null}
      extra={null}
      header={{ title: null, extra: null, ghost: true }}
      className={thinstyle.thinheader}
      tabActiveKey={tab}
      tabList={[
        {
          tab: t('sysconf.tabSiteInfo', '站点配置'),
          key: 'siteInfo',
        },
        {
          tab: t('sysconf.tabTheme', '主题'),
          key: 'theme',
        },
        {
          tab: t('sysconf.tabCustomizing', '定制化'),
          key: 'customizing',
        },
        {
          tab: t('sysconf.tabUser', '用户设置'),
          key: 'user',
        },
        {
          tab: t('sysconf.tabImg', '图床设置'),
          key: 'img',
        },
        {
          tab: t('sysconf.tabWaline', '评论设置'),
          key: 'waline',
        },
        {
          tab: t('sysconf.tabBackup', '备份恢复'),
          key: 'backup',
        },
        {
          tab: t('sysconf.tabToken', 'Token 管理'),
          key: 'token',
        },
        {
          tab: 'HTTPS',
          key: 'caddy',
        },
        {
          tab: t('sysconf.tabAdvance', '高级设置'),
          key: 'advance',
        },
        {
          tab: t('sysconf.tabMigrate', '迁移助手'),
          key: 'migrate',
        },
      ]}
      onTabChange={setTab}
    >
      {tabMap[tab]}
    </PageContainer>
  );
}
