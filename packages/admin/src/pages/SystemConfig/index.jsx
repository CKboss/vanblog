import { useTab } from '@/services/van-blog/useTab';
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
          tab: '站点配置',
          key: 'siteInfo',
        },
        {
          tab: '主题',
          key: 'theme',
        },
        {
          tab: '定制化',
          key: 'customizing',
        },
        {
          tab: '用户设置',
          key: 'user',
        },
        {
          tab: '图床设置',
          key: 'img',
        },
        {
          tab: '评论设置',
          key: 'waline',
        },
        {
          tab: '备份恢复',
          key: 'backup',
        },
        {
          tab: 'Token 管理',
          key: 'token',
        },
        {
          tab: 'HTTPS',
          key: 'caddy',
        },
        {
          tab: '高级设置',
          key: 'advance',
        },
        {
          tab: '迁移助手',
          key: 'migrate',
        },
      ]}
      onTabChange={setTab}
    >
      {tabMap[tab]}
    </PageContainer>
  );
}
