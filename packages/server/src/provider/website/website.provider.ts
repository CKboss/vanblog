import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { applyRuntimeCdnPrefix, getWebsiteRoot } from 'src/utils/cdnUrl';
import { ensureRevalidateSecret, REVALIDATE_SECRET_ENV } from 'src/utils/revalidateSecret';
import { envPositiveInt } from 'src/utils/envNumber';
import { MetaProvider } from '../meta/meta.provider';
import { SettingProvider } from '../setting/setting.provider';

const ignoreWebsiteWarnings = [
  'Experimental features are not covered by semver',
  'You have enabled experimental feature',
  'Invalid next.config.js options',
  'The value at .experimental has an',
  '(node:62) ExperimentalWarning',
  'null',
];

@Injectable()
export class WebsiteProvider {
  // constructor() {}
  ctx: ChildProcess = null;
  logger = new Logger(WebsiteProvider.name);
  constructor(
    private metaProvider: MetaProvider,
    private settingProvider: SettingProvider,
  ) {}
  async init() {
    this.run();
  }
  async loadEnv() {
    const meta = await this.metaProvider.getAll();
    const isrConfig = await this.settingProvider.getISRSetting();
    const isrEnv =
      isrConfig.mode == 'delay'
        ? {
            VAN_BLOG_REVALIDATE: 'true',
            VAN_BLOG_REVALIDATE_TIME: isrConfig.delay,
          }
        : {
            VAN_BLOG_REVALIDATE: 'false',
          };
    if (!meta?.siteInfo) return { ...isrEnv };
    const siteinfo = meta.siteInfo;
    const socials = meta.socials;
    const urls = [];
    const addEach = (u: string) => {
      if (!u) return null;
      try {
        const url = new URL(u);
        if (url?.host) {
          if (!urls.includes(url?.host)) {
            urls.push(url?.host);
          }
        }
      } catch (err) {
        return null;
      }
    };
    addEach(siteinfo?.baseUrl);
    addEach(siteinfo?.siteLogo);
    addEach(siteinfo?.authorLogo);
    addEach(siteinfo?.authorLogoDark);
    addEach(siteinfo?.payAliPay);
    addEach(siteinfo?.payAliPayDark);
    addEach(siteinfo?.payWechat);
    addEach(siteinfo?.payWechatDark);
    const wechatItem = socials.find((s) => s.type == 'wechat');
    if (wechatItem) {
      addEach(wechatItem?.value);
    }
    const wechatDarkItem = socials.find((s) => s.type == 'wechat-dark');
    if (wechatDarkItem) {
      addEach(wechatDarkItem?.value);
    }
    return { VAN_BLOG_ALLOW_DOMAINS: urls.join(','), ...isrEnv };
  }
  /** 上一次真正用于启动前台进程的环境变量（用来判断有没有必要重启）。 */
  private lastEnvJson = '';
  /**
   * 启动互斥量。
   * ⚠️ 这个字段以前**从来没有被赋过值**（死代码）：`run()` 里只有
   * `if (this.starting) await this.starting`，而没人写过 `this.starting = ...`，
   * 于是两次重叠的 restart 会各自 spawn 一个 next，两个进程抢 3001 端口。
   */
  private starting: Promise<any> | null = null;
  /**
   * 主动停止时不要再自动重启。
   * ⚠️ waline 那边一直有这个标志，website 没有 —— 于是优雅停机时
   * `stop()` 杀掉的子进程，会被它自己的 `exit` 钩子重新拉起来，
   * 而且因为 spawn 是 `detached: true`，这个"复活"的前台进程会脱离进程组活下来：
   * server 已经退了，3001 上还有一个 next 在接客（多实例部署下还会继续触发 ISR 之类的活）。
   */
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * 🔴 慢速重试（self-healing）状态。
   *
   * 缺陷（改动前）：`scheduleRestart()` 在 `restartAttempts >= 5` 时直接 `return`，
   * 而 `restartAttempts` 只在两处归零 —— 手动 `restart()`（调用方全是人触发的：
   * 初始化、恢复整站备份、改 ISR 设置）与"子进程稳定跑过 60 秒"（此时已经没有子进程了）。
   * ⇒ **一次瞬态原因导致的崩溃风暴之后（端口被残留进程占住、磁盘临时满、mongo 短暂不可达），
   * 前台会永久不再自动拉起，即使那个瞬态原因早已消失**，需要人工干预。
   * 此时页面是 502 而不是"发旧内容"：`utils/degradedHold.ts` 明写降级驻留保不住页面，
   * 唯一现成的兜底是 `VANBLOG_CADDY_SERVE_HTML`，而它默认关闭。
   *
   * ⚠️ 为什么选"长间隔的无限退避"而不是"距上次尝试超过 M 分钟就把计数清零"：
   * 后者**单独用是不能自愈的** —— 放弃之后 `scheduleRestart()` 不再设定时器，
   * 而没有子进程就不会再有 `exit` 事件，于是**没有任何东西会再调用 `scheduleRestart()`**，
   * 那个"超过 M 分钟"的判断永远不会被求值。要让它可以被求值就必须保留一个定时器 ⇒
   * 那正好就是本方案。计数清零这件事已由既有的"稳定跑过 60 秒"判据负责
   * （慢速重试一旦拉起成功并活过 60 秒，快速退避阶梯就完整恢复）。
   *
   * 🔴 间隔不能为 0：那会变成紧密重启风暴（烧 CPU、刷日志，每次重试还要查两次库），
   * 比永久放弃更糟。`envPositiveInt` 保证缺失/空串/非数字/NaN/Infinity/≤0 一律落默认值，
   * 并把合法值夹在 [1 分钟, 1 小时]，所以**任何输入都产生不出 0 间隔**。
   */
  private inSlowRetry = false;
  private slowRetries = 0;

  /** 每次调用都读 env（不是模块级常量），这样改了环境变量并重启就能生效，也便于测试。 */
  private slowRetryMs(): number {
    return envPositiveInt('VANBLOG_WEBSITE_SLOW_RETRY_MS', 5 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
  }

  async restart(reason: string) {
    // 保存**任何**站点信息都会走到这里，而 stop() 会杀掉整个进程组、再由 exit 钩子重新拉起 next，
    // 期间公网是打不开的（几秒钟）。但真正需要重启的只有影响 loadEnv() 的字段
    // （图床域名白名单 VAN_BLOG_ALLOW_DOMAINS、ISR 设置），改个站点描述完全不必停站。
    let nextEnvJson = '';
    try {
      nextEnvJson = JSON.stringify(await this.loadEnv());
    } catch {
      nextEnvJson = '';
    }
    if (this.ctx && nextEnvJson && nextEnvJson === this.lastEnvJson) {
      this.logger.log(`${reason}：前台环境变量未变化，跳过重启`);
      return;
    }
    this.logger.log(`${reason}重启 website`);
    // 后台明确要求的重启：把崩溃退避计数清零，别让它被之前的崩溃次数挡住
    this.restartAttempts = 0;
    // 慢速重试状态也一起清：人工介入之后应当从干净的快速阶梯重新开始，
    // 而且"进入慢速段"那条 ERROR 也要能再记一次（它只在状态转换时记）
    this.inSlowRetry = false;
    this.slowRetries = 0;
    if (this.ctx) {
      await this.stop();
    }
    // ⚠️ 必须显式 run：stop() 现在会置 stopping=true，exit 钩子不会再自动拉起
    try {
      await this.run();
    } catch (err) {
      // 调用方（更新站点信息 / 更新 ISR 设置 / 初始化）都是"发出去就不管"地调 restart()，
      // 这里必须自己兜住：否则前台就停在"已经杀掉、没起来"的状态，
      // 而外面只会看到一条全局 unhandledRejection 日志
      this.logger.error(
        `${reason}重启 website 失败：${(err as Error)?.message || err}，将按退避重试`,
      );
      this.scheduleRestart();
    }
  }
  async restore(reason: string) {
    this.logger.log(`${reason}`);
    if (this.ctx) this.ctx = null;
    this.stopping = false;
    await this.run();
  }
  async stop(noMessage?: boolean) {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.ctx;
    this.ctx = null;
    if (!child) {
      return;
    }
    child.unref?.();
    // 等它真的退出（2 秒不退就 SIGKILL）：以前 kill 完立刻返回，
    // 优雅停机那边紧接着 app.close() + process.exit(0)，
    // 子进程可能还没来得及死就变成孤儿进程继续占着 3001
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      const kill = (signal: NodeJS.Signals) => {
        try {
          // detached + 进程组：要杀的是整组（next 会 fork 出 worker）
          process.kill(-child.pid as number, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            finish();
          }
        }
      };
      kill('SIGTERM');
      setTimeout(() => {
        if (!settled) kill('SIGKILL');
        setTimeout(finish, 200);
      }, 2000).unref?.();
    });
    if (!noMessage) {
      this.logger.log('website 停止成功！');
    }
  }
  async run(): Promise<any> {
    // 真正的启动互斥：重叠调用（restart 与 exit 钩子撞在一起）只会 spawn 一次
    if (this.starting) {
      return this.starting;
    }
    const task = this.doRun();
    this.starting = task;
    try {
      return await task;
    } finally {
      if (this.starting === task) {
        this.starting = null;
      }
    }
  }

  /**
   * 崩溃后的退避重启：先是**有界快速阶梯**（对齐 waline 的做法：最多连续 5 次，间隔 2s/4s/…最多 30s），
   * 阶梯用尽后进入 🔴 **慢速重试**（默认每 5 分钟一次，永不彻底放弃）。
   *
   * ⚠️ 两段各自的职责不要混：快速阶梯负责"崩溃风暴时不要烧 CPU、不要刷日志"，
   * 慢速重试负责"瞬态原因消失之后能自愈"。改动前只有前半段，后半段是永久放弃（见字段注释）。
   * 🔴 慢速重试**不会**让快速阶梯失效：`restartAttempts` 在慢速段不再自增，
   * 而"稳定跑过 60 秒"那条既有判据仍会把它清零 ⇒ 一次成功的慢速重试之后，阶梯完整恢复。
   */
  private scheduleRestart() {
    if (this.stopping) {
      return;
    }
    let delay: number;
    if (this.restartAttempts >= 5) {
      delay = this.slowRetryMs();
      if (!this.inSlowRetry) {
        this.inSlowRetry = true;
        // ⚠️ 只在**进入**慢速段时记一条 ERROR：站点确实坏了，这条必须落地
        // （`./vanblog.sh doctor` 统计近 24h 的 ERROR/FATAL）。
        // 之后每次慢速重试不再重复记 ERROR —— 持续坏死这个状态仍然会有 ERROR 信号，
        // 来源是 exit 钩子里"异常退出记 ERROR"与下面 run() 失败那条，所以不会丢信号，
        // 也不会让 doctor 的计数被一个稳态问题每 5 分钟刷一次。
        this.logger.error(
          'website 已连续退出 5 次，停止自动重启（快速退避阶梯已用尽）。请检查前台构建产物与 3001 端口占用，' +
            '或在后台改一次站点信息触发重启。' +
            `此后每 ${Math.round(delay / 1000)} 秒仍会自动重试一次，以便瞬态原因消失后自愈` +
            '（间隔可用 VANBLOG_WEBSITE_SLOW_RETRY_MS 调整，范围 1 分钟到 1 小时）。',
        );
      }
      this.slowRetries += 1;
    } else {
      this.restartAttempts += 1;
      delay = Math.min(30000, 2000 * this.restartAttempts);
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.ctx) {
        return;
      }
      this.logger.log(
        this.inSlowRetry
          ? `慢速重试第 ${this.slowRetries} 次拉起 website（每 ${Math.round(delay / 1000)} 秒一次）`
          : `第 ${this.restartAttempts} 次尝试重新拉起 website（${delay}ms 后）`,
      );
      this.run().catch((err) => {
        this.logger.error(`重新拉起 website 失败：${(err as Error)?.message || err}`);
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private async doRun(): Promise<any> {
    // ⚠️ 前台子进程只能有一份：每个 worker 都 spawn 一个 next 会抢 3001 端口
    if (!isPrimaryInstance(cluster)) {
      this.logger.log('cluster worker：跳过启动 website（由主实例负责）');
      return;
    }
    // 重新拉起（自动重启或后台改了设置）时要允许后续再次自动重启
    this.stopping = false;
    if (process.env['VANBLOG_DISABLE_WEBSITE'] === 'true') {
      this.logger.log('无 website 模式');
      return;
    }
    let cmd = 'pnpm';
    let args = ['dev'];
    const websiteRoot = getWebsiteRoot();
    if (process.env.NODE_ENV == 'production') {
      cmd = 'node';
      args = ['./packages/website/server.js'];
      const cdn = applyRuntimeCdnPrefix(websiteRoot, process.env.VAN_BLOG_CDN_URL);
      if (cdn.assetPrefix) {
        this.logger.log(
          `已应用 VAN_BLOG_CDN_URL=${cdn.assetPrefix}（config=${cdn.patchedConfig}, html=${cdn.rewrittenHtml}）`,
        );
      }
    }
    const loadEnvs = await this.loadEnv();
    this.lastEnvJson = JSON.stringify(loadEnvs);
    this.logger.log(JSON.stringify(loadEnvs, null, 2));
    // loadEnv() 是 await 的：回来之后必须再看一眼，可能已经有别的调用把进程起起来了
    if (this.ctx == null) {
      // 🔴 server 与前台子进程必须用**同一把** revalidate 密钥，否则前台会把 server 触发的
      //    每一次重渲染都判成 401/403（一体式镜像的默认配置下曾经就是这样，见
      //    utils/revalidateSecret.ts 的头注释：Next 自己会给每个请求补 x-forwarded-for，
      //    所以"没配密钥 ⇒ 只放行回环直连"那条判据在 Next 下**永远不成立**）。
      //    ⚠️ 运维显式配了就用运维的；没配才生成一把进程内的，并通过 env 交给子进程。
      //    ⚠️ 空串表示"拿不到密钥"（例如只读文件系统），此时**不注入**这个键，
      //       让前台保持它自己的失败关闭语义，而不是塞一个空值把判定搅乱。
      const revalidateSecret = ensureRevalidateSecret({
        log: { warn: (message: string) => this.logger.warn(message) },
      });
      const child = spawn(cmd, args, {
        env: {
          ...process.env,
          ...loadEnvs,
          // 放在 ...loadEnvs 之后：loadEnv() 不产出这个键（已核实），但顺序上仍要保证
          // 不被任何后展开的对象覆盖 —— 覆盖的症状是"两边密钥不一致"，很难查。
          ...(revalidateSecret ? { [REVALIDATE_SECRET_ENV]: revalidateSecret } : {}),
          // ⚠️ Next 13 的 standalone server 用 HOSTNAME 决定监听地址，而容器里 HOSTNAME
          // 就是容器 ID（例如 97c3c6689770）→ 它只绑到那个网卡 IP，
          // caddy 反代 127.0.0.1:3001 直接 **502**，前台整站打不开（后台和 /api 却正常，
          // 因为它们走的是 server 的 3000）。必须显式绑 0.0.0.0（Next 官方 Docker 示例也是这么写的）。
          // 放在 ...loadEnvs 之后，保证不会被别的东西覆盖；确有需要可用 VANBLOG_WEBSITE_HOST 指定。
          HOSTNAME: process.env.VANBLOG_WEBSITE_HOST || '0.0.0.0',
        },
        cwd: websiteRoot,
        detached: true,
        shell: process.platform === 'win32',
      });
      this.ctx = child;
      child.on('message', (message) => {
        this.logger.log(message);
      });
      const startedAt = Date.now();
      child.on('exit', (code: number | null, signal: string | null) => {
        // ⚠️ 只认"当前这个子进程"的退出事件。
        // restart() 会先 stop()（把 ctx 置空）再 run()（换成新进程），
        // 旧进程的 exit 是**异步**到的；以前无条件 restore() → 把 ctx 置空 → 再 spawn 一个，
        // 于是新旧两个 next 抢 3001，或者在优雅停机时把刚杀掉的进程复活成孤儿。
        if (this.ctx !== child) {
          return;
        }
        this.ctx = null;
        if (this.stopping) {
          this.logger.log('website 是主动停掉的，不再自动重启');
          return;
        }
        // ⚠️ 异常退出（非 0 退出码或被信号打死）记 **ERROR**，正常退出记 WARN。
        //    这是"容器 Up 但前台坏死"的**唯一**线索：下面那段 stderr 转发本轮已从 ERROR
        //    降为 WARN（stderr 是诊断流，不是错误流），所以崩溃这件事必须在这里以 ERROR 落地，
        //    否则 `./vanblog.sh doctor` 的"近 24h ERROR/FATAL 计数"就再也看不到前台崩溃了。
        const abnormal = code !== 0 || signal !== null;
        const exitText = `website 进程退出（code=${code} signal=${signal}），准备自动重启`;
        if (abnormal) {
          this.logger.error(exitText);
        } else {
          this.logger.warn(exitText);
        }
        if (Date.now() - startedAt > 60 * 1000) {
          // 稳定跑过一分钟才算"正常运行后退出"，重置退避计数
          this.restartAttempts = 0;
          // 🔴 慢速重试的状态也在这里复位：一次成功的慢速重试（拉起后活过 60 秒）
          // 说明前台已经恢复正常，此后应当重新拥有完整的快速退避阶梯，
          // 并且下一次真的进入慢速段时那条 ERROR 要能再记一次。
          this.inSlowRetry = false;
          this.slowRetries = 0;
        }
        this.scheduleRestart();
      });
      child.stdout?.on('data', (data) => {
        const t: string = data.toString();
        this.logger.log(t.substring(0, t.length - 1));
      });
      child.stderr?.on('data', (data) => {
        const t: string = data.toString();

        let showLog = true;
        for (const each of ignoreWebsiteWarnings) {
          if (t.includes(each)) showLog = false;
        }
        if (showLog) {
          // ⚠️ 这里是 **WARN，不是 ERROR**（本轮改动）。
          //
          // 改动前前台子进程的 stderr 被一律转成 `logger.error`，而 stderr 是**诊断流**、
          // 不是错误流。后果是实测到的：`packages/website/pages/api/revalidate.ts` 里那条
          // 用 `console.warn` 打的提示（"未设置 VAN_BLOG_REVALIDATE_SECRET"，注释里明写
          // 这是**默认状态而不是异常**）在 server 日志里变成了 `ERROR [WebsiteProvider] …`；
          // Next 自己的任何 warning（bundle 体积建议、deprecation）同样会变成 ERROR。
          // 于是本轮刚给 `./vanblog.sh doctor` 加的"统计近 24h 日志里的 ERROR/FATAL"这一项体检，
          // 在**每一个一体式部署**上都会报异常 —— 而真正的错误反而被这些噪音淹没。
          //
          // ⚠️ 降级不会丢失"前台真的坏了"这个信号，因为崩溃判定**不看 stderr**：
          //    它走的是上面的 `child.on('exit')`（异常退出记 ERROR），加上
          //    `scheduleRestart()` 里"重拉失败"与"达到最大重启次数"两处 `logger.error`。
          //    已核实这三处都保持 ERROR 级别，没有一起降级。
          this.logger.warn(t.substring(0, t.length - 1));
        }
      });
    } else {
      this.logger.log('Website 已经在运行，跳过重复启动');
    }
  }
}
