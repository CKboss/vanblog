import { useTab } from '@/services/van-blog/useTab';
import { useIntl } from 'umi';
import { PageContainer } from '@ant-design/pro-layout';
import thinstyle from '../Welcome/index.less';
import Login from './tabs/Login';
import Pipeline from './tabs/Pipeline';
import System from './tabs/System';
export default function () {
  const tabMap = {
    login: <Login />,
    pipeline: <Pipeline />,
    system: <System />,
  };
  const [tab, setTab] = useTab('system', 'tab');
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件没有把 t 放进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);

  return (
    <PageContainer
      title={null}
      extra={null}
      header={{ title: null, extra: null, ghost: true }}
      className={thinstyle.thinheader}
      tabActiveKey={tab}
      tabList={[
        {
          // 🔴 这三个页签标签与下面三个子表里的 headerTitle 是**同一个东西**（同一种日志的名字）
          //    ⇒ 共用 `log.system` / `log.pipeline` / `log.login` 三个 key，不做同值的第二处口径。
          tab: t('log.system', '系统日志'),
          key: 'system',
        },
        {
          tab: t('log.pipeline', '流水线日志'),
          key: 'pipeline',
        },
        {
          tab: t('log.login', '登录日志'),
          key: 'login',
        },
      ]}
      onTabChange={setTab}
    >
      {tabMap[tab]}
    </PageContainer>
  );
}
