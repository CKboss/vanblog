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

const ROUTE_TEXT: Record<string, string> = {
  init: '初始化向导',
  'init/restore': '上传整站备份恢复',
  'env-bootstrap': '容器启动时的环境变量自动初始化',
};

export default function InstallRecordBanner() {
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
  const source = detail.trustedClientIp || detail.socketIp || '未知';
  return (
    <Alert
      type="warning"
      showIcon
      closable
      style={{ marginBottom: 12 }}
      message="本站的初始化记录"
      description={
        <span data-install-record>
          本站于 {detail.at || '未知时间'} 通过
          {ROUTE_TEXT[detail.route || ''] ? `「${ROUTE_TEXT[detail.route || '']}」` : detail.route || '未知路径'}
          完成初始化，来源 {source}
          {detail.socketIp && detail.socketIp !== source ? `（套接字 ${detail.socketIp}）` : ''}
          ，UA {detail.userAgent || '未知'}
          {detail.archiveName ? `，归档 ${detail.archiveName}` : ''}。
          如果这不是你本人操作的，请立即修改管理员密码并检查站点内容。
        </span>
      }
    />
  );
}
