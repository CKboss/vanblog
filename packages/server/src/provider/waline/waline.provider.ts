import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
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
    if (this.ctx) {
      await this.stop();
    }
    await this.run();
  }
  /** 主动停止时不要再自动重启 */
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  private scheduleRestart() {
    if (this.stopping) {
      return;
    }
    if (this.restartAttempts >= 5) {
      this.logger.error(
        'Waline 已连续退出 5 次，停止自动重启。请在后台重新保存一次评论设置，或重启容器；' +
          '如果不需要 waline，把评论系统切到「内置」即可。',
      );
      return;
    }
    this.restartAttempts += 1;
    const delay = Math.min(30000, 2000 * this.restartAttempts);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping || this.ctx) {
        return;
      }
      this.logger.log(`第 ${this.restartAttempts} 次尝试重新拉起 Waline（${delay}ms 后）`);
      try {
        await this.run();
      } catch (err) {
        this.logger.error(`重新拉起 Waline 失败：${(err as Error)?.message}`);
        this.scheduleRestart();
      }
    }, delay);
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
          this.restartAttempts = 0;
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
