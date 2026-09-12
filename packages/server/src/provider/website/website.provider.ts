import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { applyRuntimeCdnPrefix, getWebsiteRoot } from 'src/utils/cdnUrl';
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
  private starting: Promise<any> | null = null;

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
    if (this.ctx) {
      await this.stop();
    }
  }
  async restore(reason: string) {
    this.logger.log(`${reason}`);
    if (this.ctx) this.ctx = null;
    await this.run();
  }
  async stop(noMessage?: boolean) {
    if (this.ctx) {
      this.ctx.unref();
      process.kill(-this.ctx.pid);
      this.ctx = null;
      if (noMessage) return;
      this.logger.log('website 停止成功！');
    }
  }
  async run(): Promise<any> {
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
    // 并发保护：loadEnv() 是 await 的，两次重叠的 restart 会在 `this.ctx == null` 判断之间
    // 各自 spawn 一个 next，两个进程抢 3001 端口
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    const loadEnvs = await this.loadEnv();
    this.lastEnvJson = JSON.stringify(loadEnvs);
    this.logger.log(JSON.stringify(loadEnvs, null, 2));
    if (this.ctx == null) {
      this.ctx = spawn(cmd, args, {
        env: {
          ...process.env,
          ...loadEnvs,
        },
        cwd: websiteRoot,
        detached: true,
        shell: process.platform === 'win32',
      });
      this.ctx.on('message', (message) => {
        this.logger.log(message);
      });
      this.ctx.on('exit', async () => {
        await this.restore('website 进程退出，自动重启');
      });
      this.ctx.stdout.on('data', (data) => {
        const t: string = data.toString();
        this.logger.log(t.substring(0, t.length - 1));
      });
      this.ctx.stderr.on('data', (data) => {
        const t: string = data.toString();

        let showLog = true;
        for (const each of ignoreWebsiteWarnings) {
          if (t.includes(each)) showLog = false;
        }
        if (showLog) {
          this.logger.error(t.substring(0, t.length - 1));
        }
      });
    } else {
      this.logger.log('Website 启动成功！');
    }
  }
}
