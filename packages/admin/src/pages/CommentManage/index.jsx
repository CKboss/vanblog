import { getCommentSetting } from '@/services/van-blog/api';
import { useIntl } from 'umi';
import { reportRequestError } from '@/services/van-blog/requestError';
import { PageContainer } from '@ant-design/pro-layout';
import { Button, message, Modal, Result, Space, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { history, useModel } from 'umi';
import TipTitle from '../../components/TipTitle';
import BuiltinComments from './BuiltinComments';

/**
 * 评论管理页：先读 /api/admin/setting/comment，再按 provider 分三个分支——
 * - waline ：维持原来的内嵌 Waline 后台（iframe），一行没动；
 * - builtin：VanBlog 自己的评论管理面板（BuiltinComments）；
 * - off    ：评论已关闭的占位页，按钮跳到「系统设置 → 评论设置」。
 * 以前这个页面只有 Waline 一种形态，设置接口失败时也不能白屏，所以加载失败给重试入口。
 */
export default function () {
  // 🔴 期 6 第十批：接上 i18n（语言选择必须在渲染期，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  // 🔴 t 用 useCallback([intl]) 包成**稳定引用**：本文件的 useCallback 依赖数组里要放 t
  //    （hook 的回调体用了 t 就必须声明它，否则切语言后仍是旧译文 —— §7.144 B），
  //    而不稳定的 t 会让依赖数组每轮都变 ⇒ 重复请求/无限重渲染（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );


  const { initialState } = useModel('@@initialState');
  const [loading, setLoading] = useState(true);
  const [settingLoading, setSettingLoading] = useState(true);
  const [setting, setSetting] = useState(null);
  const { current } = useRef({ hasInit: false });
  const src = useMemo(() => {
    if (initialState?.version && initialState?.version == 'dev') {
      // dev 下后台跑在 3002 且没有 /ui 代理，必须直连 server 拉起的 waline（同机 8360）。
      // 以前这里写死了一台机器的内网 IP：换机器 / 换网段评论管理页就是一片空白，
      // 而且等于把私有地址提交进了仓库。改成按当前访问的主机名拼，端口仍是 waline 默认的 8360。
      const { protocol, hostname } = window.location;
      return `${protocol}//${hostname}:8360/ui`;
    } else {
      return '/ui/';
    }
  }, [initialState]);
  const showTips = () => {
    Modal.info({
      title: t('comment.helpCardTitle', '使用说明'),
      content: (
        <div>
          <p>
            {/* 🔴 "文字 + 链接 + 文字" ⇒ prefix/suffix 两个 key（react-intl 3.x 没有富文本占位符）。
                ⚠️ `{' '}` 是 JSX 里的**字面空格** ⇒ 英文值两端就**不要**再带空格（否则双空格：§7.171 B / §7.172 A）。 */}
            {t('comment.walineEmbedPrefix', 'Vanblog 内嵌了')}{' '}
            <a target={'_blank'} rel="noreferrer" href="https://waline.js.org/">
              Waline
            </a>{' '}
            {t('comment.walineEmbedSuffix', '作为评论系统。')}
          </p>
          <p>{t('comment.walineAdminNote', '本管理页面也是内嵌的 Waline 后台管理页面。')}</p>
          <p>{t('comment.walineFirstUserNote', '首次使用请先注册，首个注册的用户将默认成为管理员。')}</p>
          <p>
            {/* 🔴 这一整句写成**一个字符串表达式**，有两个理由：
                ① JSX 文本里的**裸 `>`** Babel 能忍、`tsc` 会报 **TS1382**，而 🔴 语法错误会让 tsc
                   **跳过整个程序的语义诊断**（实测：4 条 TS1382 在场时，既有的 26 条类型错误一条都不报）
                   ⇒ 一处裸 `>` 就能让 admin 的类型门禁整体假绿（详见手册 §7.149 A）；
                ② 拆成 `站点管理{'->'}系统设置…` 会把**一句话变成 5 个 JSX 文本节点**：
                   🔴 裸中文计数因此从 1 条变 5 条（剩余工作量口径被自己灌水），
                   而且 🔴 **文本节点与表达式之间的换行会被 JSX 吃掉** ⇒ 渲染出来少一个空格
                   （"关闭请前往站点管理" 而不是 "关闭请前往 站点管理"）—— 这是实测发现的**渲染变化**，不是理论。
                ⚠️ 这句属**跨面导航路径词汇**（与 ANALYSIS_ADMIN_PATH 同族）。
                🔴 期 6 第十批：它指向的页签标签**已经接了 i18n**（期 6 第八批）⇒ 现在按当初的约定翻成**一个** key，
                英文里的路径用与页签一致的措辞（Site management -> System settings -> Site info -> Advanced -> …）。 */}
            {t(
              'comment.psWhereToDisable',
              'PS: 评论功能默认开启，关闭请前往 站点管理->系统设置->站点配置->高级设置->是否开启评论系统',
            )}
          </p>
          <p>
            <a
              target={'_blank'}
              rel="noreferrer"
              // 上游这个地址已经 404；本分支的评论文档同时覆盖内置评论与 Waline
              href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/comment.md"
            >{t('init.wizard.helpDoc', '帮助文档')}</a>
          </p>
        </div>
      ),
    });
  };

  const fetchSetting = useCallback(async () => {
    setSettingLoading(true);
    try {
      const { data } = await getCommentSetting();
      setSetting(data || null);
    } catch (err) {
      // 全局 errorHandler 已弹过服务端原因；这里兜底并留 null，渲染重试入口而不是误判成「已关闭」
      reportRequestError(message, err, t('sysconf.comment.readFailed', '读取评论设置失败！'));
      setSetting(null);
    } finally {
      setSettingLoading(false);
    }
    // 🔴 依赖数组必须带 t（回调体里用了它：那条兜底提示）⇒ 否则切语言后仍是旧译文（§7.144 B）
  }, [t]);

  useEffect(() => {
    fetchSetting();
  }, [fetchSetting]);

  const provider = setting?.provider;

  // 「首次使用」提示只在 Waline 分支弹：内容是 Waline 专属的（注册管理员等），
  // 对内置评论 / 已关闭毫无意义，弹出来只会挡住真正的管理界面。
  useEffect(() => {
    if (provider !== 'waline') {
      return;
    }
    if (!current.hasInit) {
      current.hasInit = true;
      if (!localStorage.getItem('CommentTipped')) {
        localStorage.setItem('CommentTipped', true);
        showTips();
      }
    }
  }, [provider, current]);

  const goSetting = () => {
    history.push(`/site/setting?tab=waline`);
  };

  if (settingLoading) {
    return (
      <PageContainer title={null} header={{ title: null, ghost: true }}>
        <div style={{ padding: '120px 0', textAlign: 'center' }}>
          <Spin spinning />
        </div>
      </PageContainer>
    );
  }

  if (!setting) {
    return (
      <PageContainer title={null} header={{ title: null, ghost: true }}>
        <Result
          status="warning"
          title={t('comment.readSettingsFailed', '读取评论设置失败')}
          subTitle={t('comment.readSettingsFailedDetail', '没能拿到评论系统配置（网络异常或登录已失效），请重试。')}
          extra={
            <Button type="primary" onClick={fetchSetting}>{t('common.retry', '重试')}</Button>
          }
        />
      </PageContainer>
    );
  }

  // provider === 'waline'：以下是原有的内嵌 Waline 管理页，保持原样
  if (provider === 'waline') {
    return (
      <PageContainer
        className="editor-full"
        style={{ overflow: 'hidden' }}
        title={null}
        extra={
          <Space>
            <Button
              type="primary"
              onClick={() => {
                history.push(`/site/setting?tab=waline`);
              }}
            >{t('init.restore.count.settings', '设置')}</Button>
            <Button onClick={showTips}>{t('common.help', '帮助')}</Button>
          </Space>
        }
        header={{
          title: (
            <TipTitle
              title={t('menu.site.comment', '评论管理')}
              tip={t('comment.walineCardHint', '基于内嵌的 Waline，首个注册的用户即为管理员。未来会用自己的实现替代 Waline')}
            />
          ),
        }}
      >
        <Spin spinning={loading}>
          <iframe
            onLoad={() => {
              setLoading(false);
            }}
            title={t('comment.walineAdminBtn', 'waline 后台')}
            src={src}
            width="100%"
            height={'100%'}
          ></iframe>
        </Spin>
      </PageContainer>
    );
  }

  // provider === 'builtin'：内置评论的管理面板
  if (provider === 'builtin') {
    return (
      <PageContainer
        title={null}
        extra={
          <Space>
            <Button type="primary" onClick={goSetting}>{t('init.restore.count.settings', '设置')}</Button>
            <Button onClick={() => fetchSetting()}>{t('recycle.refresh', '刷新')}</Button>
          </Space>
        }
        header={{
          title: (
            <TipTitle
              title={t('menu.site.comment', '评论管理')}
              tip={t('comment.builtinCardHint', 'VanBlog 内置评论系统：访客无需注册即可发表，在这里审核、编辑与删除。与 Waline 的评论数据互不相通')}
            />
          ),
        }}
      >
        <BuiltinComments />
      </PageContainer>
    );
  }

  // provider === 'off'（含意外值兜底）：评论功能已关闭
  return (
    <PageContainer title={null} header={{ title: null, ghost: true }}>
      <Result
        status="info"
        title={t('comment.systemOffTitle', '评论系统已关闭')}
        subTitle={t('comment.systemOffContent', '前台目前不展示任何评论入口，历史评论也不再显示。可在「系统设置 → 评论设置」里切换到内置评论或 Waline。')}
        extra={
          <Button type="primary" onClick={goSetting}>{t('comment.goToSettings', '前往设置')}</Button>
        }
      />
    </PageContainer>
  );
}
