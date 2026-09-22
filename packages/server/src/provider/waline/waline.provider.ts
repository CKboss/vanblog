import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { envPositiveInt } from 'src/utils/envNumber';
import { config } from 'src/config';
import { WalineSetting } from 'src/types/setting.dto';
import { makeSalt } from 'src/utils/crypto';
import { isForceLoginCommentEnabled } from 'src/utils/walineLogin';
import {
  buildWalineEnvFromOtherConfig,
  stringifyWalineEnvValue,
  toWalineProcessEnv,
} from 'src/utils/walineExtra';
import { buildWalineMongoEnv } from 'src/utils/walineMongo';
import { MetaProvider } from '../meta/meta.provider';
import { SettingProvider } from '../setting/setting.provider';
@Injectable()
export class WalineProvider {
  // constructor() {}
  ctx: ChildProcess = null;
  logger = new Logger(WalineProvider.name);
  env = {};
  constructor(
    private metaProvider: MetaProvider,
    private readonly settingProvider: SettingProvider,
  ) {}

  mapConfig2Env(config: WalineSetting): Record<string, any> {
    const walineEnvMapping = {
      'smtp.port': 'SMTP_PORT',
      'smtp.host': 'SMTP_HOST',
      'smtp.user': 'SMTP_USER',
      'sender.name': 'SENDER_NAME',
      'sender.email': 'SENDER_EMAIL',
      'smtp.password': 'SMTP_PASS',
      authorEmail: 'AUTHOR_EMAIL',
      webhook: 'WEBHOOK',
      forceLoginComment: 'LOGIN',
    };
    const result = {};
    if (!config) {
      return result;
    }
    for (const key of Object.keys(config)) {
      if (key == 'forceLoginComment') {
        continue;
      } else if (key == 'otherConfig') {
        Object.assign(result, buildWalineEnvFromOtherConfig(config.otherConfig));
      } else {
        const rKey = walineEnvMapping[key];
        if (rKey) {
          const asString = stringifyWalineEnvValue(config[key]);
          if (asString !== undefined) {
            result[rKey] = asString;
          }
        }
      }
    }
    // Apply last so Ant Design string "true" and otherConfig LOGIN cannot skip/override the toggle.
    if (isForceLoginCommentEnabled(config.forceLoginComment)) {
      result['LOGIN'] = 'force';
    }
    if (!config['smtp.enabled']) {
      const r2 = {};
      for (const [k, v] of Object.entries(result)) {
        if (
          ![
            'SMTP_PASS',
            'SMTP_USER',
            'SMTP_HOST',
            'SMTP_PORT',
            'SENDER_NAME',
            'SENDER_EMAIL',
          ].includes(k)
        ) {
          r2[k] = v;
        }
      }
      return toWalineProcessEnv(r2);
    }
    return toWalineProcessEnv(result);
  }
  async loadEnv() {
    const mongoEnv = buildWalineMongoEnv(config.mongoUrl, config.walineDB);
    const siteInfo = await this.metaProvider.getSiteInfo();
    const otherEnv = {
      SITE_NAME: siteInfo?.siteName || undefined,
      SITE_URL: siteInfo?.baseUrl || undefined,
      JWT_TOKEN: global.jwtSecret || makeSalt(),
    };
    const walineConfig = await this.settingProvider.getWalineSetting();
    const walineConfigEnv = this.mapConfig2Env(walineConfig);
    this.env = {
      ...mongoEnv,
      ...otherEnv,
      ...walineConfigEnv,
    };
    // 不能整份打印：this.env 里有 MONGO_PASSWORD、JWT_TOKEN（就是本站的 jwt 签名密钥）、
    // SMTP_PASS、WEBHOOK。日志一旦被人拿到（docker logs / 挂载的日志目录 / 日志采集），
    // 等于交出数据库口令和签发管理员 token 的密钥。这里只打印键名和非敏感值。
    const SECRET_ENV_KEYS = [
      'MONGO_PASSWORD',
      'MONGO_URI',
      'JWT_TOKEN',
      'SMTP_PASS',
      'SMTP_USER',
      'WEBHOOK',
      'LOGIN',
    ];
    const safeEnv = Object.keys(this.env || {}).reduce((acc, key) => {
      acc[key] = SECRET_ENV_KEYS.includes(key) ? '[REDACTED]' : this.env[key];
      return acc;
    }, {} as Record<string, unknown>);
    this.logger.log(`waline 配置： ${JSON.stringify(safeEnv, null, 2)}`);
  }
  async init() {
    this.run();
  }
  async restart(reason: string) {
    // waline 的环境变量只来自站点名/站点地址与评论设置，改别的站点信息不必重启评论服务
    const before = JSON.stringify(this.env || {});
    await this.loadEnv();
    const after = JSON.stringify(this.env || {});
    if (this.ctx && before === after) {
      this.logger.log(`${reason}：waline 环境变量未变化，跳过重启`);
      return;
    }
    this.logger.log(`${reason}重启 waline`);
    // 🔴 手动重启是文档里写明的补救手段（"在后台重新保存一次评论设置"），
    //    所以它必须把退避状态整个清掉 —— 否则计数仍 >=5 时，下一次崩溃会**直接进慢速段**
    //    （5 分钟一次），补救完的第一次故障恢复得比应有的慢得多。
    //    与 `website.provider.ts` 的 `restart()` 同口径（那边也是三个状态一起清）。
    this.restartAttempts = 0;
    this.inSlowRetry = false;
    this.slowRetries = 0;
    if (this.ctx) {
      await this.stop();
    }
    await this.run();
  }
  /** 主动停止时不要再自动重启 */
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * 🔴 慢速重试（self-healing）状态 —— 与 `website.provider.ts` 同族同口径。
   *
   * 缺陷（改动前）：`scheduleRestart()` 在 `restartAttempts >= 5` 时打一条 ERROR 就 `return`，
   * 而 `restartAttempts` 只在两处归零 —— 手动 `restart()`（后台重新保存评论设置）与
   * "子进程稳定跑过 60 秒"（此时已经没有子进程了）。
   * ⇒ **一次瞬态原因导致的崩溃风暴之后（8360 端口被残留进程占住、磁盘临时满、mongo 短暂不可达），
   * waline 会永久不再自动拉起，即使那个瞬态原因早已消失**，而 server 还活着 ⇒
   * `restart: always` 永远不触发，用户只会看到"评论发不出去"（`/comment*`、`/ui` 一直 502），
   * 直到有人重启容器或在后台重存一次评论设置。
   * ⚠️ 这段代码上面的 exit 钩子注释本来就写着"这里对齐 website 的行为" ——
   * 而 website 那一边后来补上了慢速重试（`VANBLOG_WEBSITE_SLOW_RETRY_MS`），这边没跟上 ⇒
   * 🔴 **"对齐"是会被时间侵蚀的：一处补了自愈、另一处没补，两边就又不一致了。**
   *
   * ⚠️ 为什么选"长间隔的无限退避"而不是"距上次尝试超过 M 分钟就把计数清零"：
   * 后者**单独用是不能自愈的** —— 放弃之后 `scheduleRestart()` 不再设定时器，
   * 而没有子进程就不会再有 `exit` 事件，于是**没有任何东西会再调用 `scheduleRestart()`**，
   * 那个"超过 M 分钟"的判断永远不会被求值。要让它可以被求值就必须保留一个定时器 ⇒ 那正好就是本方案。
   * 计数清零这件事由既有的"稳定跑过 60 秒"判据负责（慢速重试一旦拉起成功并活过 60 秒，
   * 快速退避阶梯就完整恢复）。
   *
   * 🔴 间隔不能为 0：那会变成紧密重启风暴（烧 CPU、刷日志，每次重试还要查库拼环境变量），
   * 比永久放弃更糟。`envPositiveInt` 保证缺失/空串/非数字/NaN/Infinity/≤0 一律落默认值，
   * 并把合法值夹在 [1 分钟, 1 小时]，所以**任何输入都产生不出 0 间隔**。
   */
  private inSlowRetry = false;
  private slowRetries = 0;

  /**
   * 每次调用都读 env（不是模块级常量），这样改了环境变量并重启就能生效，也便于测试。
   * ⚠️ **刻意不与 website 共用同一个变量名**：两者的严重度与节奏可能不同
   * （前台坏死 = 整站 502，waline 坏死 = 只有评论不可用），站长应当能分别调。
   * 默认值与 clamp 范围**故意与 website 一致**（5 分钟、[1 分钟, 1 小时]）：
   * 两个值的取舍理由相同（"瞬态原因通常几分钟内消失，而一小时以上的间隔等于放弃自愈"），
   * 而默认值一致也让人不必记两套数字。
   */
  private slowRetryMs(): number {
    return envPositiveInt('VANBLOG_WALINE_SLOW_RETRY_MS', 5 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
  }

  private scheduleRestart() {
    if (this.stopping) {
      return;
    }
    let delay: number;
    if (this.restartAttempts >= 5) {
      delay = this.slowRetryMs();
      if (!this.inSlowRetry) {
        this.inSlowRetry = true;
        // ⚠️ 只在**进入**慢速段时记一条 ERROR：评论系统确实坏了，这条必须落地
        // （`./vanblog.sh doctor` 统计近 24h 的 ERROR/FATAL）。
        // 之后每次慢速重试不再重复记 ERROR —— 持续坏死这个状态仍然会有 ERROR 信号，
        // 来源是 exit 钩子里那条 warn 与下面 run() 失败那条，所以不会丢信号，
        // 也不会让 doctor 的计数被一个稳态问题每 5 分钟刷一次。
        this.logger.error(
          'Waline 已连续退出 5 次，停止快速退避（阶梯已用尽）。请在后台重新保存一次评论设置，或重启容器；' +
            '如果不需要 waline，把评论系统切到「内置」即可。' +
            `此后每 ${Math.round(delay / 1000)} 秒仍会自动重试一次，以便瞬态原因消失后自愈` +
            '（间隔可用 VANBLOG_WALINE_SLOW_RETRY_MS 调整，范围 1 分钟到 1 小时）。',
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
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping || this.ctx) {
        return;
      }
      this.logger.log(
        this.inSlowRetry
          ? `慢速重试第 ${this.slowRetries} 次拉起 Waline（每 ${Math.round(delay / 1000)} 秒一次）`
          : `第 ${this.restartAttempts} 次尝试重新拉起 Waline（${delay}ms 后）`,
      );
      try {
        await this.run();
      } catch (err) {
        this.logger.error(`重新拉起 Waline 失败：${(err as Error)?.message}`);
        this.scheduleRestart();
      }
    }, delay);
    // 🔴 **必须 unref**：慢速段的间隔最长可到 1 小时，而本 provider **没有 `onModuleDestroy`**
    //    （唯一清这个定时器的地方是 `stop()`）。一个未 unref 的长定时器会**吊住 Node 事件循环**，
    //    让进程在没有任何其它工作时也不退出 ⇒ 优雅停机被拖到超时、`docker stop` 变成 SIGKILL。
    //    `website.provider.ts` 早就有这一行；这边以前最长只有 30 秒所以不明显，
    //    间隔拉长之后它就成了真问题。
    this.restartTimer.unref?.();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.ctx) {
      return;
    }
    const child = this.ctx;
    this.ctx = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-child.pid, signal);
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
        if (!settled) {
          kill('SIGKILL');
        }
        setTimeout(finish, 200);
      }, 2000);
    });
    this.logger.log('waline 停止成功！');
  }
  async run(): Promise<any> {
    // ⚠️ 子进程只能有一份：多进程部署时每个 worker 都 spawn 一个 waline 会抢 8360 端口
    if (!isPrimaryInstance(cluster)) {
      this.logger.log('cluster worker：跳过启动 waline（由主实例负责）');
      return;
    }
    // 重新拉起（自动重启或后台改了评论设置）时要允许后续再次自动重启
    this.stopping = false;
    // 评论系统不是 waline（内置评论或已关闭）时不必拉起这个子进程：
    // 省一个常驻 node 进程和 8360 端口，也避免退出钩子把它反复拉起来。
    try {
      const commentSetting = await this.settingProvider.getCommentSetting();
      if (commentSetting?.provider !== 'waline') {
        this.logger.log(`评论系统为 ${commentSetting?.provider}，跳过启动 waline`);
        return;
      }
    } catch (err) {
      this.logger.warn(`读取评论设置失败，按 waline 处理：${(err as Error)?.message || err}`);
    }
    await this.loadEnv();
    const base = '../waline/node_modules/@waline/vercel/vanilla.js';
    if (this.ctx == null) {
      this.ctx = spawn('node', [base], {
        env: {
          ...process.env,
          ...toWalineProcessEnv(this.env as Record<string, unknown>),
        },
        cwd: process.cwd(),
        detached: true,
      });
      this.ctx.on('message', (message) => {
        this.logger.log(message);
      });
      const startedAt = Date.now();
      this.ctx.on('exit', (code: number | null, signal: string | null) => {
        this.ctx = null;
        this.logger.warn(`Waline 进程退出（code=${code} signal=${signal}）`);
        // ⚠️ 以前这里只打一行日志就完事了：waline 一旦被 OOM 杀掉或启动时连不上库，
        // /comment*、/ui 就会一直 502，而 server 还活着 → restart:always 永远不触发，
        // 用户只会看到"评论发不出去"，直到重启容器。前台进程（website.provider）
        // 是一直有自动重启的，这里对齐它的行为，但加上退避与次数上限，避免崩溃循环刷日志。
        if (Date.now() - startedAt > 60 * 1000) {
          // 稳定跑过一分钟才算"正常运行后退出"，重置计数
          // 🔴 三个状态要一起清（与 `website.provider.ts` 同口径）：只清 `restartAttempts`
          //    会让 `inSlowRetry` 一直是 true ⇒ 下一次崩溃**不再记那条 ERROR**（它只在"进入"慢速段时记），
          //    于是"评论系统又坏了一次"这个信号会永久丢失，而 `slowRetries` 也会无意义地一直涨。
          this.restartAttempts = 0;
          this.inSlowRetry = false;
          this.slowRetries = 0;
        }
        this.scheduleRestart();
      });
      this.ctx.stdout.on('data', (data) => {
        const t = data.toString();
        if (!t.includes('Cannot find module')) {
          this.logger.log(t.substring(0, t.length - 1));
        }
      });
      this.ctx.stderr.on('data', (data) => {
        const t = data.toString();
        this.logger.error(t.substring(0, t.length - 1));
      });
    } else {
      await this.stop();
      await this.run();
    }
    this.logger.log('Waline 启动成功！');
  }
}
