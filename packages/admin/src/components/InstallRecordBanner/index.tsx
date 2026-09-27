import { useIntl } from 'umi';

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。下面的 `routeText()` 是模块级工厂，
 * 拿不到 hook ⇒ 由组件在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type InjectedT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;
import { useEffect, useState } from 'react';
import { Alert } from 'antd';
import { request } from 'umi';

/**
 * 安装归因横幅：把"这个站点是什么时候、被谁、从哪条路径初始化的"摆在后台首页第一屏。
 *
 * 为什么需要它：`POST /api/admin/init` 与 `/init/restore` 是**匿名**的，只靠"库里有没有用户"把关。
 * 抢占一个未初始化的实例只需要**一个请求**（限流只约束重试，而 IPv6 /64 让重试也免费），
 * 而在此之前站点**没有任何检测**：`initSystem` 什么都不记，事件日志只记登录不记安装，
 * 站长的第一个信号是"我自己的密码不对了"。
 * 现在安装的一刻会往迁移台账写一条 `install:initialised`（含时间、路由、套接字 IP、
 * 可信客户端 IP、UA、归档名）并 WARN 一条；这个组件把它显示出来。
 *
 * ⚠️ 它是**归因**，不是防护 —— 真要关掉窗口得用 `VANBLOG_ADMIN_USER`/`_PASSWORD(_FILE)`
 * 让容器启动时就完成初始化，或用 `VANBLOG_INIT_REQUIRE_SETUP_KEY=true` 要求安装密钥。
 *
 * 老站点（升级上来的）台账里没有这一行 ⇒ 渲染 null，不显示任何噪音。
 */
interface InstallDetail {
  at?: string;
  route?: string;
  socketIp?: string;
  trustedClientIp?: string;
  userAgent?: string;
  archiveName?: string;
}

// 🔴 期 6 第十二批：模块级常量 ⇒ 函数版（尾参 t）；identity 视图留给还没接 i18n 的调用方。
const routeText = (t: InjectedT = IDENTITY_T): Record<string, string> => ({
  init: t('install.routeInit', '初始化向导'),
  'init/restore': t('install.routeRestore', '上传整站备份恢复'),
  'env-bootstrap': t('install.routeEnvBootstrap', '容器启动时的环境变量自动初始化'),
});

/** identity 视图 */
const ROUTE_TEXT: Record<string, string> = routeText();

export default function InstallRecordBanner() {
  // 🔴 期 6 第十二批：接上 i18n（语言选择必须在渲染期）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [detail, setDetail] = useState<InstallDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: any = await request('/api/admin/migration/list', { method: 'GET' });
        const rows = res?.data || res || [];
        const row = Array.isArray(rows)
          ? rows.find((r: any) => r && r.key === 'install:initialised')
          : null;
        if (!row || cancelled) return;
        const parsed: InstallDetail = JSON.parse(row.detail || '{}');
        // detail 解析不出来就什么都不显示：横幅是辅助信息，不该因为一条脏数据报错
        if (parsed && typeof parsed === 'object') setDetail(parsed);
      } catch {
        // 台账端点不可用（老版本 server / 协作者权限不足）⇒ 静默不显示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!detail) return null;
  const source = detail.trustedClientIp || detail.socketIp || t('install.unknownSource', '未知');
  const rt = routeText(t);
  return (
    <Alert
      type="warning"
      showIcon
      closable
      style={{ marginBottom: 12 }}
      message={t('install.recordTitle', '本站的初始化记录')}
      description={
        // 🔴 原来是"JSX 文本 + 4 个条件插值"拼出来的一整句 ⇒ 收成**一条** ICU 整句（{at}/{route}/{source}/
        //    {socket}/{ua}/{archive}），条件部分由调用处算好空串传进去。
        //    这样英文语序可以整句重排，不会出现"文字 + 表达式"的接缝（§7.152 B / §7.171 B / §7.176 A）。
        <span data-install-record>
          {t(
            'install.recordDescription',
            '本站于 {at} 通过 {route} 完成初始化，来源 {source}{socket}，UA {ua}{archive}。如果这不是你本人操作的，请立即修改管理员密码并检查站点内容。',
            {
              at: detail.at || t('install.unknownTime', '未知时间'),
              // 🔴 那对直角引号「」原来是**源码里硬编码**的（不在语言包里）⇒ 英文下会渲染出全角引号
              //    （活体 en-US 抓到：`via 「Setup wizard」`，反向判据"零全角标点"当场红）。
              //    ⇒ 引号也进语言包：中文用「」、英文用直双引号（ICU 只把单引号当转义符，双引号安全）。
              route: rt[detail.route || '']
                ? t('install.routeWrap', '「{name}」', { name: rt[detail.route || ''] })
                : detail.route || t('install.unknownRoute', '未知路径'),
              source,
              socket:
                detail.socketIp && detail.socketIp !== source
                  ? t('install.socketSuffix', '（套接字 {ip}）', { ip: detail.socketIp })
                  : '',
              ua: detail.userAgent || t('install.unknownUa', '未知'),
              archive: detail.archiveName
                ? t('install.archiveSuffix', '，归档 {name}', { name: detail.archiveName })
                : '',
            },
          )}
        </span>
      }
    />
  );
}
