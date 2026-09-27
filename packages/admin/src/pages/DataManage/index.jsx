import { useTab } from '@/services/van-blog/useTab';
import { useIntl } from 'umi';
import { PageContainer } from '@ant-design/pro-layout';
import thinstyle from '../Welcome/index.less';
import Category from './tabs/Category';
import Donate from './tabs/Donate';
import Link from './tabs/Link';
import Menu from './tabs/Menu';
import Social from './tabs/Social';
import Tag from './tabs/Tag';
export default function () {
  // 🔴 期 6 第九批：接上 i18n（语言选择必须在**渲染期**，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);

  const tabMap = {
    category: <Category />,
    tag: <Tag />,
    donateInfo: <Donate />,
    links: <Link />,
    socials: <Social />,
    menuConfig: <Menu />,
  };
  const [tab, setTab] = useTab('category', 'tab');

  return (
    <PageContainer
      title={null}
      extra={null}
      header={{ title: null, extra: null, ghost: true }}
      className={thinstyle.thinheader}
      tabActiveKey={tab}
      tabList={[
        {
          tab: t('dataManage.tabCategory', '分类管理'),
          key: 'category',
        },
        {
          tab: t('dataManage.tabTag', '标签管理'),
          key: 'tag',
        },
        {
          tab: t('dataManage.tabMenu', '导航配置'),
          key: 'menuConfig',
        },
        {
          tab: t('dataManage.tabDonate', '捐赠管理'),
          key: 'donateInfo',
        },
        {
          tab: t('dataManage.tabLink', '友情链接'),
          key: 'links',
        },
        {
          tab: t('dataManage.tabSocial', '社交媒体'),
          key: 'socials',
        },
      ]}
      onTabChange={setTab}
    >
      {tabMap[tab]}
    </PageContainer>
  );
}
