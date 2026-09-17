import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { SettingProvider } from '../setting/setting.provider';

export const CADDY_LISTENER_WRAPPERS_URL =
  'http://127.0.0.1:2019/config/apps/http/servers/srv1/listener_wrappers';

export const HTTP_REDIRECT_WRAPPERS = [{ wrapper: 'http_redirect' }];

/* ---------------------------------------------------------------------------
 * caddy 直服 ISR HTML（VANBLOG_CADDY_SERVE_HTML，默认关）
 *
 * 机制：caddy 模板里有一条 `vanblog-serve-html` 路由（srv0/srv1 各一份，index 2），
 * 按**哨兵文件**决定直服范围，file_server 直接回 `.next/server/pages/**.html`；
 * 文件缺失 / 哨兵缺失 / 带 Next 预览 cookie / 非 GET·HEAD 时全部落回
 * reverse_proxy → Next。本 provider 只负责**创建/删除哨兵文件**（不碰 caddy 的
 * 运行时配置），所以档位切换是"每个请求现查文件"，不需要 reload caddy。
 *
 * 两个档位、两个哨兵：
 * - `VANBLOG_CADDY_SERVE_HTML=true`  → 6 个**固定页**（/、/about、/link、/timeline、
 *   /category、/tag），哨兵 `.vanblog-caddy-serve-html`（第一轮已发布的语义，不变）；
 * - `VANBLOG_CADDY_SERVE_HTML=all`   → 固定页 + 4 个**动态前缀**（/post/* /page/*
 *   /category/* /tag/*），额外要求哨兵 `.vanblog-caddy-serve-html-dynamic`；
 * - 其它任何值（包括垃圾值）→ off —— 解析失败永远落到更安全的一侧，绝不落到更宽的一侧。
 *
 * 动态路由曾被实测否决（2026-09，别把这段历史删了）：308/404/notFound 不落盘、
 * 删除文章后旧 .html 永远留在盘上（Next 14.2.35 file-system-cache 无 unlink）、
 * 加密文章的旧明文要等风暴重写。现在放行 `all` 的前提是 **provider/isr/artifactReaper**
 * 已经补上了缺失的语义：每轮风暴收尾 + 周期对账会把"不再可公开发布"（deleted/hidden/
 * private/加密分类/publishAt 未到）的路径的 .html/.json/.meta 三件套从盘上删掉，
 * 308/404 则靠"文件不存在 → try_files 落空 → 回退反代"天然保持原行为。
 * 为什么要求 ISR 模式是 onDemand：delay 模式的新鲜度**全靠访客流量触发重渲染**
 * （server 的按需触发与每小时 cron 在 delay 模式都被 activeAllFn 拦截），
 * caddy 直服会让流量到不了 Next → 页面冻结在最后一次重渲染。`all` 档同样受这个门槛约束。
 * ------------------------------------------------------------------------- */
export const SERVE_HTML_ENV_FLAG = 'VANBLOG_CADDY_SERVE_HTML';
export const SERVE_HTML_PAGES_DIR_ENV = 'VANBLOG_CADDY_HTML_PAGES_DIR';
export const CADDY_SERVE_HTML_SENTINEL = '.vanblog-caddy-serve-html';
export const CADDY_SERVE_HTML_DYNAMIC_SENTINEL = '.vanblog-caddy-serve-html-dynamic';
/** 一体式镜像里 website(standalone) 的 ISR 产物目录（Dockerfile runner 阶段固定布局） */
export const DEFAULT_WEBSITE_PAGES_DIR = '/app/website/packages/website/.next/server/pages';
/** 哨兵对账周期：后台随时可能把 ISR 模式切到 delay，必须在没有重启的情况下自动摘除 */
export const SERVE_HTML_RECONCILE_MS = 60_000;

/** 直服档位：off=全部反代（默认）；fixed=6 个固定页；all=固定页+动态前缀 */
export type ServeHtmlLevel = 'off' | 'fixed' | 'all';

/**
 * 纯解析函数（有单测钉住每个分支）：只认 'true' 与 'all' 两个字面量，
 * 其它一切（undefined/'false'/'TRUE'/'1'/垃圾串/非字符串）→ 'off'。
 * ⚠️ 解析失败必须落到更安全的 off，绝不"宽容地"落到更宽的 all。
 */
export function resolveServeHtmlLevel(flagRaw: unknown): ServeHtmlLevel {
  if (flagRaw === 'all') {
    return 'all';
  }
  if (flagRaw === 'true') {
    return 'fixed';
  }
  return 'off';
}

/**
 * 纯决策函数（第一轮的名字保留，语义扩展：'all' 也算开）：
 * 只有显式 `true`/`all` **且** ISR 模式显式为 `onDemand` 才开启。
 * 模式未知 / 读不到设置（Mongo 抖动）一律视为关 —— 宁可用旧行为，不可冻结站点。
 */
export function shouldServeHtmlFromCaddy(flagRaw: unknown, isrMode: unknown): boolean {
  return resolveServeHtmlLevel(flagRaw) !== 'off' && isrMode === 'onDemand';
}

/** 档位 + ISR 模式一起收敛成"实际生效档位"（哨兵写哪个由它决定） */
export function effectiveServeHtmlLevel(flagRaw: unknown, isrMode: unknown): ServeHtmlLevel {
  if (isrMode !== 'onDemand') {
    return 'off';
  }
  return resolveServeHtmlLevel(flagRaw);
}

@Injectable()
export class CaddyProvider implements OnModuleDestroy {
  subjects: string[] = [];
  logger = new Logger(CaddyProvider.name);
  private serveHtmlTimer: ReturnType<typeof setInterval> | null = null;
  /** null=还没对过账；只在档位**变化**时打日志，避免每分钟刷屏 */
  private serveHtmlState: ServeHtmlLevel | null = null;
  constructor(private readonly settingProvider: SettingProvider) {
    this.init();
  }
  async init() {
    // this.subjects = await getDefaultSubjects();
    // this.logger.log(`默认 subjects:`, this.subjects);
    // await this.updateSubjects(this.subjects);
    // 哨兵对账不依赖 https 设置：放在最前面，setRedirect 抛错也不会把它挡掉
    this.startServeHtmlReconcile();
    const configInDB = await this.settingProvider.getHttpsSetting();
    let txt = '初始化 caddy 配置完成！';
    if (configInDB?.redirect) {
      await this.setRedirect(true);
      txt = txt + 'https 自动重定向已开启';
    } else {
      await this.setRedirect(false);
      txt = 'https 自动重定向已关闭';
    }

    this.logger.log(txt);
  }

  /** 启动哨兵对账循环（幂等：重复调用不会叠出第二个 timer） */
  startServeHtmlReconcile() {
    if (this.serveHtmlTimer) {
      return;
    }
    this.reconcileServeHtml().catch((err) => {
      this.logger.error(`caddy 直服 HTML 对账失败：${(err as Error)?.message || err}`);
    });
    this.serveHtmlTimer = setInterval(() => {
      this.reconcileServeHtml().catch((err) => {
        this.logger.error(`caddy 直服 HTML 对账失败：${(err as Error)?.message || err}`);
      });
    }, SERVE_HTML_RECONCILE_MS);
    // 别让一个对账 timer 吊住进程退出（jest / 优雅停机）
    this.serveHtmlTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.serveHtmlTimer) {
      clearInterval(this.serveHtmlTimer);
      this.serveHtmlTimer = null;
    }
  }

  /**
   * 按「env 档位 + ISR 模式」把哨兵文件放到/撤出 website 的 pages 目录。
   * 两个哨兵 = 两个档位（fixed 只写主哨兵；all 两个都写），所以降级 all→fixed→off
   * 都是"删一个文件"的事，caddy 每个请求现查，不需要 reload。
   * 目录不存在（dev 机、website 单独部署、VANBLOG_DISABLE_WEBSITE）时静默跳过：
   * 模板里那条路由因为哨兵永远缺失而不生效，站点行为 = 今天。
   */
  async reconcileServeHtml(): Promise<ServeHtmlLevel> {
    const flag = process.env[SERVE_HTML_ENV_FLAG];
    let want: ServeHtmlLevel = 'off';
    if (resolveServeHtmlLevel(flag) !== 'off') {
      try {
        const isr = await this.settingProvider.getISRSetting();
        want = effectiveServeHtmlLevel(flag, isr?.mode);
      } catch {
        want = 'off'; // 读不到设置 = 关（见 shouldServeHtmlFromCaddy 注释）
      }
    }
    const dir = process.env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR;
    const sentinel = path.join(dir, CADDY_SERVE_HTML_SENTINEL);
    const dynamicSentinel = path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL);
    let achieved: ServeHtmlLevel = want;
    try {
      const stamp = `${SERVE_HTML_ENV_FLAG}=${String(flag)} + ISR onDemand; managed by CaddyProvider at ${new Date().toISOString()}\n`;
      if (want !== 'off') {
        fs.writeFileSync(sentinel, `level=${want}; ${stamp}`);
      } else if (fs.existsSync(sentinel)) {
        fs.unlinkSync(sentinel);
      }
      if (want === 'all') {
        fs.writeFileSync(dynamicSentinel, `level=all; ${stamp}`);
      } else if (fs.existsSync(dynamicSentinel)) {
        fs.unlinkSync(dynamicSentinel);
      }
    } catch (err) {
      // 目录不存在/只读：路由保持失效，站点走旧路径 —— 不是致命错误，但开了开关的人
      // 应该能在日志里看到"为什么没生效"，所以 want 时升级到 warn（每次状态变化一条）
      const msg = `caddy 直服 HTML 哨兵同步失败（忽略，按关闭处理）：${
        (err as Error)?.message || err
      }`;
      if (want !== 'off' && this.serveHtmlState === 'off') {
        this.logger.warn(msg);
      } else {
        this.logger.debug(msg);
      }
      if (want !== 'off') {
        // 写不进去就等于没开：状态按 off 记，下次成功时才会再打"已启用"。
        // 顺手把可能写了一半的哨兵撤掉（半套状态 = 固定页开了动态页没开，虽然无害但难排查）
        achieved = 'off';
        for (const f of [sentinel, dynamicSentinel]) {
          try {
            if (fs.existsSync(f)) {
              fs.unlinkSync(f);
            }
          } catch {
            // 撤不掉也就算了：下一轮对账继续尝试
          }
        }
      }
    }
    if (achieved !== this.serveHtmlState) {
      if (achieved !== 'off') {
        this.logger.log(
          `caddy 直服 ISR HTML 已启用（档位 ${achieved}：${
            achieved === 'all' ? '6 个固定页 + /post/* /page/* /category/* /tag/*' : '仅 6 个固定页'
          }）。回滚：去掉 ${SERVE_HTML_ENV_FLAG} 后重启，最多 ${
            SERVE_HTML_RECONCILE_MS / 1000
          }s 自动摘除`,
        );
      } else if (this.serveHtmlState !== null && this.serveHtmlState !== 'off') {
        this.logger.log(
          `caddy 直服 ISR HTML 已关闭（${SERVE_HTML_ENV_FLAG} 不是 true/all，或 ISR 模式不是 onDemand）`,
        );
      }
      this.serveHtmlState = achieved;
    }
    return achieved;
  }

  clearLog() {
    try {
      fs.writeFileSync('/var/log/caddy.log', '');
    } catch (err) {
      // 以前是空的 `catch (err) {}`：清不掉日志（文件不存在、只读挂载、权限）与
      // "清成功了"在外部看完全一样。这件事本身无关紧要，但空 catch 会掩盖真问题，
      // 所以至少留一行（debug 级，别刷屏）。
      this.logger.debug(`清空 caddy.log 失败（忽略）：${(err as Error)?.message || err}`);
    }
  }
  async addSubject(domain: string) {
    if (!this.subjects.includes(domain)) {
      this.subjects.push(domain);
      await this.updateSubjects(this.subjects);
    }
  }

  async setRedirect(redirect: boolean) {
    if (!redirect) {
      try {
        await axios.delete(CADDY_LISTENER_WRAPPERS_URL);
      } catch (err) {
        if (!this.isNotFound(err)) {
          this.logger.error('关闭 https 自动重定向失败');
          return false;
        }
      }
      try {
        if (await this.hasHttpRedirectWrapper()) {
          this.logger.error('关闭 https 自动重定向失败');
          return false;
        }
      } catch (err) {
        this.logger.error('关闭 https 自动重定向失败');
        return false;
      }
      this.logger.log('https 自动重定向已关闭');
      return '关闭成功！';
    }

    try {
      await this.replaceListenerWrappers(HTTP_REDIRECT_WRAPPERS);
      if (!(await this.hasHttpRedirectWrapper())) {
        this.logger.error('开启 https 自动重定向失败');
        return false;
      }
      this.logger.log('https 自动重定向已开启');
      return '开启成功！';
    } catch (err) {
      this.logger.error('开启 https 自动重定向失败');
      return false;
    }
  }

  async getSubjects() {
    try {
      const res = await axios.get(
        'http://127.0.0.1:2019/config/apps/tls/automation/policies/subjects',
      );
      return res?.data;
    } catch (err) {
      // console.log(err);
      this.logger.error('更新 subjects 失败，通过 IP 进行 https 访问可能受限');
    }
  }
  async getAutomaticDomains() {
    try {
      const res = await axios.get('http://127.0.0.1:2019/config/apps/tls/certificates/automate');
      return res?.data;
    } catch (err) {
      console.log(err);
    }
  }

  async updateSubjects(domains: string[]) {
    try {
      const res = await axios.patch(
        'http://127.0.0.1:2019/config/apps/tls/automation/policies/0/subjects',
        domains,
      );
      if (res.status == 200) {
        return true;
      }
    } catch (err) {
      console.log(err?.data?.error || err);
    }
    return false;
  }
  async applyHttpsChange(domains: string[]) {
    return await this.updateHttpsDomains([...domains, ...this.subjects]);
  }

  async updateHttpsDomains(domains: string[]) {
    try {
      const res = await axios.patch(
        'http://127.0.0.1:2019/config/apps/tls/certificates/automate',
        domains,
      );
      if (res.status == 200) {
        return true;
      }
    } catch (err) {
      console.log(err);
    }
    return false;
  }
  async getConfig() {
    try {
      const res = await axios.get('http://127.0.0.1:2019/config');
      return res?.data;
    } catch (err) {
      console.log(err);
    }
  }
  async getLog() {
    try {
      const data = fs.readFileSync('/var/log/caddy.log', { encoding: 'utf-8' });
      return data.toString();
    } catch (err) {
      return '';
    }
  }

  /**
   * Caddy 2019 API: POST appends to an existing array (and would nest a whole
   * array payload as one element). PATCH replaces the field when it exists;
   * PUT creates it when missing. Enable must replace, not append.
   */
  private async replaceListenerWrappers(wrappers: Array<{ wrapper: string }>) {
    try {
      await axios.patch(CADDY_LISTENER_WRAPPERS_URL, wrappers);
    } catch (err) {
      if (!this.isNotFound(err)) {
        throw err;
      }
      await axios.put(CADDY_LISTENER_WRAPPERS_URL, wrappers);
    }
  }

  private async hasHttpRedirectWrapper(): Promise<boolean> {
    try {
      const res = await axios.get(CADDY_LISTENER_WRAPPERS_URL);
      return this.wrappersIncludeHttpRedirect(res?.data);
    } catch (err) {
      if (this.isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  private wrappersIncludeHttpRedirect(wrappers: unknown): boolean {
    if (!Array.isArray(wrappers)) {
      return false;
    }
    return wrappers.some((item) => {
      if (item === 'http_redirect') {
        return true;
      }
      return Boolean(
        item &&
          typeof item === 'object' &&
          (item as { wrapper?: string }).wrapper === 'http_redirect',
      );
    });
  }

  private isNotFound(err: unknown): boolean {
    return (
      Boolean(err) &&
      typeof err === 'object' &&
      (err as { response?: { status?: number } }).response?.status === 404
    );
  }
}
