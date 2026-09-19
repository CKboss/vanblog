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
/**
 * 读不到 ISR 设置时，连续失败到第几次打一条 WARN（之后每这么多次再提醒一次）。
 * 对账是 60 秒一轮，所以 10 ≈ 每 10 分钟一条：既不会在 mongo 长时间挂掉时刷屏，
 * 又保证"站点正处于降级发布模式"这件事在日志里看得见。
 */
export const SERVE_HTML_DB_FAILURE_WARN_EVERY = 10;

/**
 * caddy admin API 的调用超时（毫秒）。
 * ⚠️ 绝不能是 0 / 无限：这个文件里 9 处 axios 调用以前**一个 timeout 都没有**，
 * caddy admin（127.0.0.1:2019）卡住时，「HTTPS 自动重定向开关」、listener wrapper 增删、
 * 自动签发域名列表这些操作会**无限等待** —— 用户在后台点了没反应，日志里一个字都没有，
 * 而请求还占着连接。5 秒对本机回环上的 admin API 是极宽裕的（正常是毫秒级）。
 */
export const CADDY_ADMIN_TIMEOUT_MS = 5_000;

/** 诊断信息里给的自查命令：caddy admin 不可达时，站长/运维能照着敲一条确认 */
const CADDY_ADMIN_SELFCHECK = 'curl -s http://127.0.0.1:2019/config/ | head -c 400';

/**
 * 把 caddy admin 调用的失败翻译成**人能照做**的一句话（纯函数，有单测钉住每个分支）。
 * 为什么需要它：这些 catch 里原本只打「开启 https 自动重定向失败」这类没有原因的话，
 * 超时、连接被拒、caddy 返回 500 在日志里长得一模一样，排查只能靠猜。
 */
export function describeCaddyAdminFailure(err: unknown): string {
  const e = (err ?? {}) as {
    code?: string;
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  const raw = typeof e.message === 'string' && e.message ? e.message : String(err);
  let kind: string;
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    kind = `caddy admin API 在 ${CADDY_ADMIN_TIMEOUT_MS}ms 内没有响应（超时）`;
  } else if (e.code === 'ECONNREFUSED') {
    kind = '连不上 caddy admin API（连接被拒）—— caddy 可能没起来或还没监听 2019';
  } else if (typeof e.response?.status === 'number') {
    kind = `caddy admin API 返回 ${e.response.status}`;
  } else {
    kind = 'caddy admin API 调用失败';
  }
  return `${kind}：${raw}。自查：${CADDY_ADMIN_SELFCHECK}`;
}

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
 * ⚠️ 这个函数本身对"模式未知"返回 false 是对的（不知道模式就直服，可能把 delay 模式的站点冻结），
 * 但**不要把"读库失败"喂给它**：对账逻辑在 reconcileServeHtml() 里，读不到设置时走的是
 * "保持上一次已知档位、绝不删哨兵"那条路，而不是降级成 off。
 * 理由写在 reconcileServeHtml() 的 catch 里（数据库挂掉时删哨兵 = 亲手关掉自己唯一的静态兜底）。
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
  /**
   * 连续读不到 ISR 设置的次数（成功读到就清零）。
   * 存在的唯一目的是**别每分钟刷一条 WARN**：对账是 60s 一轮，mongo 挂一小时就是 60 条同样的话，
   * 真正有用的信息会被冲掉（而日志本来就有 20MB×3 的轮转上限，攻击期间更容易被冲走）。
   */
  private serveHtmlDbFailures = 0;
  constructor(private readonly settingProvider: SettingProvider) {
    /* 构造函数不能是 async，所以 init() 只能 fire-and-forget —— 但**必须自己 catch**。
     * 以前是裸的 `this.init()`：一旦 getHttpsSetting() 抛错（启动时 mongo 还没就绪是常态），
     * 就是一个 unhandledRejection。而本仓库的 unhandledRejection **只记日志不退进程**
     * （见 main.ts，理由是有大量 fire-and-forget 写库），所以后果不是崩溃，而是
     * 「启动时重放 HTTPS 重定向设置」这件事**静默没做** —— caddy 里保持的是它自己上次的状态，
     * 与数据库里的设置不一致，而日志里连一条错误都没有。 */
    this.init().catch((err) => {
      this.logger.error(
        `启动时重放 caddy 设置失败（HTTPS 自动重定向可能停留在 caddy 里的旧状态，` +
          `与数据库设置不一致；恢复后到「系统设置 → HTTPS」重新开关一次即可）：${
            (err as Error)?.message || err
          }`,
      );
    });
  }
  async init() {
    // this.subjects = await getDefaultSubjects();
    // this.logger.log(`默认 subjects:`, this.subjects);
    // await this.updateSubjects(this.subjects);
    // 哨兵对账不依赖 https 设置：放在最前面，setRedirect 抛错也不会把它挡掉
    this.startServeHtmlReconcile();
    let configInDB: Awaited<ReturnType<SettingProvider['getHttpsSetting']>>;
    try {
      configInDB = await this.settingProvider.getHttpsSetting();
    } catch (err) {
      /* 读不到设置 ⇒ **不动 caddy**（不知道期望状态时乱改比不改更糟），并且大声说清
       * "本次启动没有重放这个设置"。⚠️ 这条路径以前会把异常抛给构造函数里那个没人 catch 的
       * Promise，表现是静默不生效。 */
      this.logger.error(
        `读取 HTTPS 重定向设置失败，本次启动**没有**重放它（caddy 保持自己当前的状态；` +
          `数据库恢复后到「系统设置 → HTTPS」重新开关一次即可）：${(err as Error)?.message || err}`,
      );
      return;
    }
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
    const flagLevel = resolveServeHtmlLevel(flag);
    let want: ServeHtmlLevel = 'off';
    if (flagLevel !== 'off') {
      try {
        const isr = await this.settingProvider.getISRSetting();
        want = effectiveServeHtmlLevel(flag, isr?.mode);
        if (this.serveHtmlDbFailures > 0) {
          this.logger.log(
            `caddy 直服 HTML 对账已恢复：重新读到 ISR 设置（此前连续 ${this.serveHtmlDbFailures} 次读不到），当前档位 ${want}`,
          );
          this.serveHtmlDbFailures = 0;
        }
      } catch (err) {
        /* 🔴 这里以前是 `want = 'off'`，注释写着"读不到设置 = 关"。
         * 那个方向是**反的**，而且反在最要命的时刻：
         *   mongo 挂掉/OOM/磁盘满/serverSelectionTimeoutMS(10s) 超时
         *     ⇒ 最多 SERVE_HTML_RECONCILE_MS(60s) 内 want 变 off
         *     ⇒ 下面 :161-162 的 `fs.unlinkSync(sentinel)` 把哨兵**删掉**
         *     ⇒ caddyTemplate.json 里 `vanblog-serve-html` 那条 route 的哨兵匹配失败
         *     ⇒ caddy 直服 HTML 整条路由失效
         *     ⇒ 页面请求落到兜底 reverse_proxy → Next(3001) → server(3000) → 查已死的 mongo
         *     ⇒ **全站 5xx**，而磁盘上明明躺着渲染好的 HTML，caddy 本来可以零依赖直发。
         * 也就是说：数据库一挂，系统会**主动关掉自己唯一的静态兜底**。对一个要在攻击下
         * 持续发布内容的站点，这是 fail-closed 用错了方向 —— 正确的语义是
         * "数据库挂了也要能把已生成的内容发出去"（降级发布，而不是全站不可用）。
         *
         * 现在的规则：
         *  - 读不到设置 ⇒ **保持上一次已知档位**，绝不删哨兵；
         *  - 只有"成功读到设置、且设置确实是 off/delay"才允许摘除哨兵；
         *  - 从没成功对过账（serveHtmlState === null，例如启动时 mongo 就不可达）⇒
         *    保持 off，因为此时**臆造**一个档位等于在不知道 ISR 模式的情况下直服，
         *    而 delay 模式下直服会把内容冻结（那才是这个门槛存在的理由）；60s 后会重试。
         *  - ⚠️ 但 env 开关（flagLevel === 'off'）这条**运维回滚路径不受影响**：
         *    它是本地环境变量、不依赖数据库，所以"去掉 VANBLOG_CADDY_SERVE_HTML 再对账"
         *    在 mongo 挂掉时依然能立刻摘除哨兵。回滚手段绝不能跟着数据库一起失效。 */
        this.serveHtmlDbFailures += 1;
        const previous = this.serveHtmlState;
        want = previous !== null && previous !== 'off' ? previous : 'off';
        this.warnServeHtmlSettingsUnavailable(err, want, previous);
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

  /**
   * 读不到 ISR 设置时的日志策略：第 1 次立刻 WARN（这是"进入降级发布模式"的时刻，必须看得见），
   * 之后每 SERVE_HTML_DB_FAILURE_WARN_EVERY 次再提醒一次，其余降到 debug。
   * ⚠️ 消息里必须说清"哨兵**没有**被删、静态直服仍在"，否则运维会以为站点已经切回反代。
   */
  private warnServeHtmlSettingsUnavailable(
    err: unknown,
    kept: ServeHtmlLevel,
    previous: ServeHtmlLevel | null,
  ) {
    const n = this.serveHtmlDbFailures;
    const reason = (err as Error)?.message || String(err);
    const keptText =
      kept === 'off'
        ? previous === null
          ? '此前从未成功对过账，所以**没有**可保持的档位，本轮按 off 处理（不臆造档位：' +
            '不知道 ISR 模式时直服可能把内容冻结，那正是这个门槛存在的理由）；数据库恢复后 ' +
            `${SERVE_HTML_RECONCILE_MS / 1000}s 内会自动重试`
          : '上一次已知档位就是 off，保持不变'
        : `**保持**上一次已知档位 ${kept}，哨兵文件未删除 —— 站点处于「降级发布模式」：` +
          '数据库不可达期间，caddy 仍然直发已渲染好的 HTML，读者能看到最后一次成功渲染的内容';
    const msg =
      `读不到 ISR 设置（连续第 ${n} 次），caddy 直服 HTML 对账按「不改变现状」处理：${keptText}。` +
      `原因：${reason}`;
    if (n === 1 || n % SERVE_HTML_DB_FAILURE_WARN_EVERY === 0) {
      this.logger.warn(msg);
    } else {
      this.logger.debug(msg);
    }
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
        await axios.delete(CADDY_LISTENER_WRAPPERS_URL, { timeout: CADDY_ADMIN_TIMEOUT_MS });
      } catch (err) {
        if (!this.isNotFound(err)) {
          // 404 = 本来就没有 wrapper（等于已经关了），不算失败；其余都要说清原因
          this.logger.error(`关闭 https 自动重定向失败：${describeCaddyAdminFailure(err)}`);
          return false;
        }
      }
      try {
        if (await this.hasHttpRedirectWrapper()) {
          this.logger.error('关闭 https 自动重定向失败');
          return false;
        }
      } catch (err) {
        this.logger.error(`关闭 https 自动重定向失败：${describeCaddyAdminFailure(err)}`);
        return false;
      }
      this.logger.log('https 自动重定向已关闭');
      return '关闭成功！';
    }

    try {
      await this.replaceListenerWrappers(HTTP_REDIRECT_WRAPPERS);
      if (!(await this.hasHttpRedirectWrapper())) {
        // 不是异常，是"写进去了但复查没看到" —— 这种情况尤其要说清，否则无从下手
        this.logger.error(
          '开启 https 自动重定向失败：wrapper 已写入但复查没找到 http_redirect' +
            `（caddy 配置可能被别的进程改过）。自查：${CADDY_ADMIN_SELFCHECK}`,
        );
        return false;
      }
      this.logger.log('https 自动重定向已开启');
      return '开启成功！';
    } catch (err) {
      this.logger.error(`开启 https 自动重定向失败：${describeCaddyAdminFailure(err)}`);
      return false;
    }
  }

  async getSubjects() {
    try {
      const res = await axios.get(
        'http://127.0.0.1:2019/config/apps/tls/automation/policies/subjects',
        { timeout: CADDY_ADMIN_TIMEOUT_MS },
      );
      return res?.data;
    } catch (err) {
      this.logger.error(
        `更新 subjects 失败，通过 IP 进行 https 访问可能受限：${describeCaddyAdminFailure(err)}`,
      );
    }
  }
  async getAutomaticDomains() {
    try {
      const res = await axios.get('http://127.0.0.1:2019/config/apps/tls/certificates/automate', {
        timeout: CADDY_ADMIN_TIMEOUT_MS,
      });
      return res?.data;
    } catch (err) {
      // 以前是 console.log(err)：不进 logger ⇒ 没有时间戳/级别/上下文，生产日志里等于看不见
      this.logger.error(`读取自动签发域名列表失败：${describeCaddyAdminFailure(err)}`);
    }
  }

  async updateSubjects(domains: string[]) {
    try {
      const res = await axios.patch(
        'http://127.0.0.1:2019/config/apps/tls/automation/policies/0/subjects',
        domains,
        { timeout: CADDY_ADMIN_TIMEOUT_MS },
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
        { timeout: CADDY_ADMIN_TIMEOUT_MS },
      );
      if (res.status == 200) {
        return true;
      }
      this.logger.error(
        `更新自动签发域名列表失败：caddy admin API 返回 ${res?.status}（期望 200）`,
      );
    } catch (err) {
      this.logger.error(`更新自动签发域名列表失败：${describeCaddyAdminFailure(err)}`);
    }
    return false;
  }
  async getConfig() {
    try {
      const res = await axios.get('http://127.0.0.1:2019/config', { timeout: CADDY_ADMIN_TIMEOUT_MS });
      return res?.data;
    } catch (err) {
      this.logger.error(`读取 caddy 当前配置失败：${describeCaddyAdminFailure(err)}`);
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
      await axios.patch(CADDY_LISTENER_WRAPPERS_URL, wrappers, { timeout: CADDY_ADMIN_TIMEOUT_MS });
    } catch (err) {
      if (!this.isNotFound(err)) {
        throw err;
      }
      await axios.put(CADDY_LISTENER_WRAPPERS_URL, wrappers, { timeout: CADDY_ADMIN_TIMEOUT_MS });
    }
  }

  private async hasHttpRedirectWrapper(): Promise<boolean> {
    try {
      const res = await axios.get(CADDY_LISTENER_WRAPPERS_URL, { timeout: CADDY_ADMIN_TIMEOUT_MS });
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
