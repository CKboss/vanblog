import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { config } from 'src/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InitDto } from 'src/types/init.dto';
import { MetaDocument } from 'src/scheme/meta.schema';
import { UserDocument } from 'src/scheme/user.schema';
import { WalineProvider } from '../waline/waline.provider';
import { SettingProvider } from '../setting/setting.provider';
import { version } from '../../utils/loadConfig';
import { encryptPassword, hashSecret, makeSalt } from 'src/utils/crypto';
import { defaultMenu } from 'src/types/menu.dto';
import { CacheProvider } from '../cache/cache.provider';
import fs from 'fs';
import path from 'path';
import cluster from 'node:cluster';
import { WebsiteProvider } from '../website/website.provider';
import { CategoryDocument } from 'src/scheme/category.schema';
import { CustomPageDocument } from 'src/scheme/customPage.schema';
import {
  MigrationProvider,
  NOOP_MIGRATION_RECORDER,
} from '../migration/migration.provider';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { pickSocketIp } from 'src/provider/log/utils';
import { pickTrustedClientIp } from 'src/utils/trustedProxy';
import {
  SETUP_KEY_REQUIRE_ENV,
  buildSetupKeyBlock,
  clearSetupKey,
  currentSetupKey,
  enforceSetupKey,
  generateSetupKey,
  readSetupKey,
  resolveSetupKeyRemindMinutes,
  resolveSetupKeyRequirement,
  setupKeyFilePath,
} from './setupKey';
import {
  ENV_ADMIN_PASSWORD,
  ENV_ADMIN_PASSWORD_FILE,
  ENV_ADMIN_USER,
  deriveBrowserPassword,
  envBootstrapRequested,
  minimalSiteInfo,
  resolveEnvCredentials,
} from './envBootstrap';
import e from 'express';
/** 「是否已初始化」的缓存时长；0 = 永久（直到进程重启或显式失效） */
function envNonNegativeInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

export const INIT_CACHE_MS = envNonNegativeInt('VANBLOG_INIT_CACHE_MS', 5 * 60 * 1000);

/**
 * 安装记录在迁移台账（migrations 集合）里的 key。
 *
 * 为什么复用台账而不是新建集合：台账已经是"每 key 一行、有界、后台可读
 * （GET /api/admin/migration/list，AdminGuard 且协作者不可见）、outcome=error 必 WARN"
 * 的唯一持久记录面。匿名 `/api/admin/init*` 被抢占时，这一行是站长事后
 * **唯一**能拿到的归因证据（什么时候、走哪条路由、从哪个 IP 初始化的本站），
 * 所以它必须活过日志轮转、且不随日志级别被过滤。
 */
export const INSTALL_LEDGER_KEY = 'install:initialised';

/** recordInstallation 的入参：route 标识"哪条路完成了安装"，req 用于取两种 IP 与 UA */
export interface InstallationRecordInfo {
  route: 'init' | 'init/restore' | 'env-bootstrap';
  /** express 请求（env-bootstrap 没有请求，传 undefined） */
  req?: any;
  /** 仅 /init/restore：站长上传的归档文件名（归因用，最长 200 字） */
  archiveName?: string;
  durationMs?: number;
  at?: Date;
}

@Injectable()
export class InitProvider implements OnModuleInit, OnModuleDestroy {
  logger = new Logger(InitProvider.name);
  private hasInitedCache: { value: boolean; at: number } | null = null;
  /**
   * 未初始化期间的"重印初始化密钥"定时器（主实例独有；`unref()`，
   * onModuleDestroy 里 clearInterval —— 与 ISR 周期对账 / 备份巡检同一套约定：
   * 定时器绝不能把进程吊着不让退出）。
   */
  private setupKeyReminderTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 缓存好的密钥日志块。密钥在进程生命周期内不变（重启才重新生成），
   * 所以每 10 分钟一次的重印就是同一次 `logger.warn(缓存串)`，零拼接分配；
   * 唯一的重建时机是密钥被重新生成（文件+内存都丢了的那条自愈路径）。
   */
  private cachedSetupKeyBlock: string | null = null;
  constructor(
    @InjectModel('Meta') private metaModel: Model<MetaDocument>,
    @InjectModel('User') private userModel: Model<UserDocument>,
    @InjectModel('Category') private categoryModal: Model<CategoryDocument>,
    @InjectModel('CustomPage')
    private customPageModal: Model<CustomPageDocument>,
    private readonly walineProvider: WalineProvider,
    private readonly settingProvider: SettingProvider,
    private readonly cacheProvider: CacheProvider,
    private readonly websiteProvider: WebsiteProvider,
    // ⚠️ 第 9 个参数、@Optional()、TypeScript 可选：仓库里有多处**直接
    // `new InitProvider(8 个桩)`** 的既有测试（audit-hardening-round3-silent、
    // test/init-restore.e2e-spec），少传参数时回落到 NOOP_MIGRATION_RECORDER
    // （migration.provider 专门为这种场景导出的空实现），行为与"没有台账"一致。
    @Optional() private readonly migrationProvider?: MigrationProvider,
  ) {}

  private get migrations(): Pick<
    MigrationProvider,
    'record' | 'recordSkipped' | 'run' | 'list' | 'warnAboutErrors'
  > {
    return this.migrationProvider || NOOP_MIGRATION_RECORDER;
  }

  /**
   * 启动步骤（Nest 生命周期自动调用，**不需要动 main.ts**）：
   *  1. env 自动初始化（VANBLOG_ADMIN_USER + VANBLOG_ADMIN_PASSWORD/_FILE）：
   *     全新站点在监听第一个 HTTP 请求**之前**就完成初始化，未初始化窗口根本不存在
   *     —— 这时下面的密钥步骤什么都不生成、什么都不打印（站点已初始化）；
   *  2. setup key 生命周期：站点仍未初始化 ⇒ 生成密钥 + WARN 打印**视觉块**，
   *     并排上周期重印（VANBLOG_SETUP_KEY_REMIND_MINUTES，默认 10 分钟）；
   *     已初始化 ⇒ 清掉遗留文件、停掉定时器。
   *
   * 只在主实例跑（isPrimaryInstance(cluster) 约定，与 main.ts 里 initRestoreKey()/
   * 启动清洗同一套语义）：cluster worker 不生成密钥，校验时回落读共享文件
   * （见 setupKey.ts 的 readSetupKey）。
   */
  async onModuleInit(): Promise<void> {
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    try {
      await this.bootstrapFromEnv();
    } catch (err) {
      // 绝不因为自动初始化的意外错误把整个启动带崩（站点还能走向导），但必须大声
      this.logger.error(
        `环境变量自动初始化出现意外错误（站点保持未初始化）：${(err as Error)?.message || err}`,
      );
    }
    try {
      await this.refreshSetupKey();
    } catch (err) {
      this.logger.error(`初始化密钥启动检查失败：${(err as Error)?.message || err}`);
    }
  }

  /**
   * env 自动初始化（细节与契约见 ./envBootstrap.ts 顶部注释）。
   * 返回值供测试断言；所有失败都**大声**（ERROR），绝不静默跳过。
   */
  async bootstrapFromEnv(): Promise<{ done: boolean; ignored?: boolean; rejected?: string }> {
    if (!envBootstrapRequested()) {
      return { done: false };
    }
    if (await this.checkHasInited()) {
      this.logger.log(
        `站点已初始化：忽略 ${ENV_ADMIN_USER} / ${ENV_ADMIN_PASSWORD} / ${ENV_ADMIN_PASSWORD_FILE}` +
          `（环境变量自动初始化只对全新站点生效；要改管理员密码请登录后到后台「账号设置」）`,
      );
      return { done: false, ignored: true };
    }
    const resolved = resolveEnvCredentials();
    if (!resolved.ok || !resolved.creds) {
      const why = resolved.error || '凭据解析失败';
      this.logger.error(
        `环境变量自动初始化被拒绝：${why}。站点保持【未初始化】—— ` +
          `匿名初始化接口（POST /api/admin/init、/api/admin/init/restore）仍然开放，` +
          `存在被抢先初始化的风险：请修正环境变量后重启，或立即用初始化向导完成安装。（密码本身不会进日志）`,
      );
      return { done: false, rejected: why };
    }
    const { username, password, passwordSource } = resolved.creds;
    const started = Date.now();
    try {
      await this.init({
        user: {
          username,
          // ⚠️ 必须存浏览器派生值（与向导提交的形状一致），否则登录永远对不上
          password: deriveBrowserPassword(username, password),
          nickname: username,
        },
        siteInfo: minimalSiteInfo(username),
      } as InitDto);
    } catch (err) {
      this.logger.error(
        `环境变量自动初始化失败（站点仍未初始化，匿名初始化接口仍开放）：${
          (err as Error)?.message || err
        }`,
      );
      return { done: false, rejected: String((err as Error)?.message || err) };
    }
    this.logger.warn(
      `⚠️ 本站已由环境变量自动初始化（密码来源：${
        passwordSource === 'file' ? ENV_ADMIN_PASSWORD_FILE : ENV_ADMIN_PASSWORD
      }）：管理员账号「${username}」，站点从未暴露在未初始化状态。` +
        `若这不是你本人的部署意图，请立即检查环境变量来源并修改密码！`,
    );
    await this.recordInstallation({
      route: 'env-bootstrap',
      durationMs: Date.now() - started,
    });
    return { done: true };
  }

  /**
   * 控制器侧的 setup key 闸门（两条 init 路由在处理前调用）。
   *
   * ⚠️ 为什么走 provider 而不是控制器直接 import 模块函数：仓库里有多个用**桩
   * InitProvider** 直接 `new InitController(...)` 的既有源码级测试
   * （audit-hardening-round3-initrestore / round3-silent），它们的桩没有这个方法，
   * 控制器用 `?.()` 调用 + 一次性 WARN（见 init.controller.ts 的 runSetupKeyGate）。
   * 生产 DI 注入的永远是真 InitProvider（方法必然存在，两侧都有源码钉子），
   * 所以这个形状在生产里是**fail-closed** 的：cluster worker 也一样走这里，
   * worker 内存没有密钥时 verifySetupKey 回落读主实例写下的文件。
   */
  assertSetupKeyAllowed(supplied: unknown): void {
    enforceSetupKey(supplied);
  }

  /**
   * setup key 的启动生命周期：
   *  - 站点**未初始化** ⇒ 无条件生成新密钥（每次启动重新生成，镜像 restore.key）
   *    并 WARN 打印视觉块 —— 不再以开关为条件：站长要求"每次检查到未安装都在
   *    terminal 里显示密钥"，而密钥块自己会说清楚当前是否**要求**携带
   *    （VANBLOG_INIT_REQUIRE_SETUP_KEY 显式关闭时块里写明是逃生口）；
   *    随后排上周期重印（默认 10 分钟，0 = 只印一次）。
   *  - 站点**已初始化** ⇒ 清掉遗留文件（挂载日志卷里不留"看着像活密钥"的
   *    0600 文件）、停掉定时器。
   * @param logDir 仅测试用（生产走 config.log，与 restore.key 同目录）
   */
  async refreshSetupKey(
    logDir?: string,
  ): Promise<{ generated: boolean; clearedStale: boolean; reminderMinutes: number }> {
    const initialised = await this.checkHasInited();
    if (!initialised) {
      const { key, filePath, written } = generateSetupKey(logDir);
      if (!written) {
        // 与 restore.key 同一容错：文件写不出去（挂载盘权限）不该拦死启动，
        // 但密钥就只剩日志这一个渠道了，必须点名
        this.logger.error(
          `写入初始化密钥到 ${filePath} 失败（日志目录不可写？）：密钥只存在于日志里`,
        );
      }
      this.cachedSetupKeyBlock = null; // 新密钥 ⇒ 重建块
      this.printSetupKeyBlock(logDir, key);
      const reminderMinutes = resolveSetupKeyRemindMinutes();
      this.startSetupKeyReminders(reminderMinutes, logDir);
      return { generated: true, clearedStale: false, reminderMinutes };
    }
    // 已初始化：停提醒、清遗留文件
    this.stopSetupKeyReminders();
    const filePath = setupKeyFilePath(logDir);
    let existed = false;
    try {
      existed = fs.existsSync(filePath);
    } catch {
      existed = false;
    }
    clearSetupKey(logDir);
    this.cachedSetupKeyBlock = null; // 块里含旧密钥：初始化之后不留引用
    const clearedStale = existed;
    if (clearedStale) {
      this.logger.log(
        `已删除遗留的 ${filePath}（站点已初始化：该密钥不再授予任何东西）`,
      );
    }
    return { generated: false, clearedStale, reminderMinutes: 0 };
  }

  /**
   * 打印密钥块（WARN）。**永不抛错**：日志管道出任何问题都不该把启动/定时器带崩。
   * 块内容在第一次构建后缓存（密钥在进程生命周期内不变），重印零拼接。
   */
  private printSetupKeyBlock(logDir?: string, keyOverride?: string): void {
    try {
      if (!this.cachedSetupKeyBlock) {
        const key = keyOverride || currentSetupKey() || readSetupKey(logDir) || '';
        const rawFlag = process.env[SETUP_KEY_REQUIRE_ENV];
        const requirement = resolveSetupKeyRequirement(rawFlag);
        this.cachedSetupKeyBlock = buildSetupKeyBlock({
          key,
          filePath: setupKeyFilePath(logDir),
          required: requirement.enabled,
          recognized: requirement.recognized,
          rawFlag: String(rawFlag ?? ''),
        });
      }
      this.logger.warn(this.cachedSetupKeyBlock);
    } catch (err) {
      try {
        this.logger.error(`打印初始化密钥块失败：${(err as Error)?.message || err}`);
      } catch {
        // 日志系统整个坏掉：吞掉，绝不向启动路径/定时器抛
      }
    }
  }

  /**
   * 排上周期重印（仅主实例；`0` = 只印启动那一次）。
   * 约定与 ISR 周期对账 / 备份巡检一致：`unref()` + onModuleDestroy 清理 +
   * 回调内部 catch（一次失败下一轮照常重试）。
   */
  private startSetupKeyReminders(minutes: number, logDir?: string): void {
    this.stopSetupKeyReminders();
    if (!(minutes > 0) || !isPrimaryInstance(cluster)) {
      return;
    }
    const timer = setInterval(() => {
      this.remindSetupKeyTick(logDir).catch((err) => {
        this.logger.error(
          `初始化密钥周期提醒异常（下一轮照常重试）：${(err as Error)?.message || err}`,
        );
      });
    }, minutes * 60 * 1000);
    // 提醒绝不能把进程吊着不让退出（优雅停机 / jest）
    timer.unref?.();
    this.setupKeyReminderTimer = timer;
  }

  private stopSetupKeyReminders(): void {
    if (this.setupKeyReminderTimer) {
      clearInterval(this.setupKeyReminderTimer);
      this.setupKeyReminderTimer = null;
    }
  }

  /**
   * 一次周期检查：已初始化 ⇒ **永久停表**（不再打印）；仍未初始化 ⇒ 重印密钥块。
   * 密钥文件与内存都被人为清掉时自愈：重新生成一把并重建缓存块（"generate if needed"）。
   */
  async remindSetupKeyTick(
    logDir?: string,
  ): Promise<{ printed: boolean; stopped: boolean; regenerated: boolean }> {
    if (await this.checkHasInited()) {
      this.stopSetupKeyReminders();
      return { printed: false, stopped: true, regenerated: false };
    }
    let regenerated = false;
    if (!currentSetupKey()) {
      if (!readSetupKey(logDir)) {
        generateSetupKey(logDir);
        regenerated = true;
      }
      this.cachedSetupKeyBlock = null; // 内存/文件与缓存可能已经脱节，重建
    }
    this.printSetupKeyBlock(logDir);
    return { printed: true, stopped: false, regenerated };
  }

  onModuleDestroy(): void {
    this.stopSetupKeyReminders();
  }

  /**
   * 把"本站是怎样被初始化的"写进迁移台账并 WARN 一条（一次安装只发生一次）。
   *
   * detail 的 JSON 形状（契约，报表/后台都按它读）：
   *   {at, route, socketIp, trustedClientIp, userAgent, archiveName?}
   *
   * ⚠️ socketIp 与 trustedClientIp **分开存**：出厂拓扑里 caddy 在同一容器、
   * 从回环拨过来 ⇒ socketIp 对所有请求都是 127.0.0.1，只有 trustedClientIp
   * （utils/trustedProxy.ts，默认 auto：对端是回环/私网时采信 XFF 最右一项）
   * 才可能指认安装者；裸部署（无反代）时反过来只有 socketIp 是实的。
   * 归因记录用 pickTrustedClientIp 而不是 bruteForceClientIp：后者是给防爆破
   * 计数用的（还受 VANBLOG_BRUTE_FORCE_IP_SOURCE 影响），这里只是可观测性。
   *
   * ⚠️ 永不抛错（migrations.record 自己吞掉写失败并 WARN）：安装已经成功了，
   * 台账写不进去不该反过来把成功变成失败。
   */
  async recordInstallation(info: InstallationRecordInfo): Promise<void> {
    const at = info.at || new Date();
    const rawUa = info.req?.headers?.['user-agent'];
    const detail: Record<string, unknown> = {
      at: at.toISOString(),
      route: info.route,
      socketIp: info.req ? pickSocketIp(info.req) || null : null,
      trustedClientIp: info.req ? pickTrustedClientIp(info.req) || null : null,
      userAgent: typeof rawUa === 'string' && rawUa ? rawUa.slice(0, 300) : null,
    };
    if (info.archiveName) {
      detail.archiveName = String(info.archiveName).slice(0, 200);
    }
    await this.migrations.record({
      key: INSTALL_LEDGER_KEY,
      kind: 'install',
      outcome: 'ok',
      durationMs: Math.max(0, Number(info.durationMs) || 0),
      detail,
      ranAt: at,
    });
    // WARN（不是 INFO）：这是一次安装才一条的事件，必须活过"隐藏 routine 噪音"的日志级别
    this.logger.warn(
      `本站已完成初始化（安装记录已写入迁移台账 key=${INSTALL_LEDGER_KEY}，后台「迁移台账」/ GET /api/admin/migration/list 可查）：${JSON.stringify(
        detail,
      )}`,
    );
  }

  async init(initDto: InitDto) {
    const { user, siteInfo } = initDto;
    let toUpdateDto = siteInfo;
    if (!siteInfo.since) {
      toUpdateDto = { ...siteInfo, since: new Date() };
    }
    try {
      const salt = makeSalt();
      await this.userModel.create({
        id: 0,
        name: user.username,
        // scrypt：与登录校验一致（verifyUserPassword 认新格式）
        password: hashSecret(user.password),
        mickname: user?.nickname || user.username,
        type: 'admin',
        salt,
      });
      await this.metaModel.create({
        siteInfo: toUpdateDto,
        links: [],
        socials: [],
        rewards: [],
        about: {
          updatedAt: new Date(),
          content: '',
        },
        categories: [],
      });
      // 刚建好管理员：立刻把"已初始化"写进缓存，
      // 否则最长要等一个 TTL 才会生效，期间 /api/admin/init 还能被再调一次
      this.hasInitedCache = { value: true, at: Date.now() };
      // 任何一条路（向导 / env 自动引导）初始化成功 ⇒ setup.key 的使命结束：
      // 删文件 + 清内存 + 停掉周期重印 + 丢掉含旧密钥的缓存块。它从此不再授予
      // 任何东西（两条 init 路由对已初始化站点直接 403/500），而日志目录是挂载卷、
      // 还会被整站备份打包 —— 不留一个 0600 的"看着像活密钥"的文件。
      // 永不抛错，不影响初始化结果。
      clearSetupKey();
      this.stopSetupKeyReminders();
      this.cachedSetupKeyBlock = null;
      // 全新安装默认用**内置评论**（不依赖 waline 子进程）；
      // 老站点升级时没有这条设置，SettingProvider 会回落到 waline，评论数据不受影响。
      await this.settingProvider.updateCommentSetting({ provider: 'builtin' });
      await this.settingProvider.updateMenuSetting({ data: defaultMenu });
      // 运行 waline（不 await：初始化接口不该被子进程启动拖住），但必须 catch ——
      // `run()` 里有 DB 读（评论设置），reject 就是一条没有来源的 unhandledRejection
      this.walineProvider.init().catch((err) =>
        this.logger.error(`初始化后启动评论服务失败：${(err as Error)?.message || err}`),
      );
      // 重启前台
      this.websiteProvider.restart('初始化');
      return '初始化成功!';
    } catch (err) {
      // 对外的语义一字不变（400「初始化失败」），但**原因必须进日志**：
      // 以前这里把原始错误整个吞掉，env 自动引导失败时运维连"是数据库连不上
      // 还是字段校验没过"都无从知道 —— 静默失败是本仓库记录在案的头号陷阱。
      this.logger.error(`初始化失败：${(err as Error)?.message || err}`);
      throw new BadRequestException('初始化失败');
    }
  }

  /**
   * 站点初始化过了吗？
   *
   * 这个方法挂在 **InitMiddleware** 上，也就是**每一个 API 请求**都要跑一次
   * （`/api/admin/init` 与几个被 exclude 的路由除外）。以前每次都
   * `userModel.findOne({})` —— 一次数据库往返，而且把**整份用户文档连密码哈希一起**
   * 读进内存再丢掉。
   *
   * 现在两件事都改了：
   *  1. 只投影 `_id`（判断"有没有用户"不需要密码哈希）；
   *  2. 结果缓存 `VANBLOG_INIT_CACHE_MS`（默认 5 分钟）。缓存对 true/false 都生效，
   *     而"初始化完成"这一刻由 `init()` 直接把缓存置成 true，所以刚初始化完不会读到旧值；
   *     `/api/admin/init` 也就仍然会在已初始化时拒绝（见 init.controller）。
   *
   * 为什么带 TTL 而不是永久缓存：这个结论只可能被**绕过 API 的改动**推翻
   * （手工删库、整站恢复）。API 层面管理员账号是删不掉的
   * （`UserProvider.deleteCollaborator` 的过滤条件是 `type: 'collaborator'`），
   * 所以正常路径下缓存永远不会错；给个 TTL 只是让"有人手工动了库"这种情况能自愈。
   * 设成 0 表示永久缓存（直到进程重启）。
   */
  async checkHasInited() {
    const cached = this.hasInitedCache;
    if (cached && (INIT_CACHE_MS <= 0 || Date.now() - cached.at < INIT_CACHE_MS)) {
      return cached.value;
    }
    const user = await this.userModel.findOne({}, { _id: 1 }).lean().exec();
    const value = !!user;
    // ⚠️ 只缓存 **true**：false 缓存下来会让多实例部署下"别的进程刚完成初始化"这件事
    // 最长延迟一个 TTL 才被看到（那期间所有请求都回「未初始化」）。
    // 未初始化的站点本来也没有流量，这一次查询省不掉也无所谓。
    if (value) {
      this.hasInitedCache = { value: true, at: Date.now() };
    }
    return value;
  }

  /** 让"是否已初始化"的缓存立刻失效（手工动过 users 集合时用） */
  invalidateInitCache() {
    this.hasInitedCache = null;
  }
  async initRestoreKey() {
    const key = makeSalt();
    await this.cacheProvider.set('restoreKey', key);
    // ⚠️ 以前写死 '/var/log/'：容器里正好有这个目录所以看不出来，
    //    但本机/裸机部署（日志目录由 config.log 决定）就一直写失败，
    //    密钥只存在于 stdout 日志里 —— 而「忘记密码」流程指着这个文件。
    const logDir = config.log || '/var/log';
    const filePath = path.join(logDir, 'restore.key');
    try {
      // mode 0o600：这个文件是「忘记密码」的恢复密钥，而 /var/log 是**挂载到宿主机**的卷，
      // 默认 0644 意味着宿主机上任何用户都能读到它，而且它还会被 vanblog.sh backup 一起打包。
      fs.writeFileSync(filePath, key, { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600); // 文件已存在时 writeFileSync 的 mode 不生效
      } catch {
        // 权限改不动（比如挂载盘不支持）不该让整个启动失败
      }
    } catch (err) {
      this.logger.error('写入恢复密钥到文件失败！');
    }
    this.logger.warn(
      `忘记密码恢复密钥为： ${key}\n 注意此密钥也会同时写入到日志目录中的 restore.key 文件中，每次重启 vanblog 或老密钥被使用时都会重新生成此密钥`,
    );
  }

  /** @returns 是否真的改了设置（供迁移台账记 detail） */
  async washStaticSetting(): Promise<{ changed: boolean }> {
    // 新版加入了图床自动压缩功能，默认开启，需要洗一下。
    // ⚠️ 这里以前有一句 `console.log(staticSetting)`（调试遗留）：每次启动都把整份
    // 图床设置（含可能的对象存储密钥字段）打进 stdout，已删。
    const staticSetting = await this.settingProvider.getStaticSetting();
    if (staticSetting && staticSetting.enableWebp === undefined) {
      this.logger.log('新版本自动开启图床压缩功能');
      await this.settingProvider.updateStaticSetting({
        enableWebp: true,
      });
      return { changed: true };
    }
    return { changed: false };
  }

  /** @returns 清洗了多少条老数据（供迁移台账记 detail） */
  async washCustomPage(): Promise<{ washed: number }> {
    // 老版本的 custom 表没带 type，洗一下加上
    const all = await this.customPageModal.find({
      type: {
        $exists: false,
      },
    });
    let washed = 0;
    if (all && all.length) {
      for (const each of all) {
        this.logger.log(`清洗老版本自定义页面数据：${each.name}`);
        await this.customPageModal.updateOne(
          {
            _id: each._id,
          },
          {
            type: 'file',
          },
        );
        washed += 1;
      }
    }
    return { washed };
  }

  /** @returns 从 meta.categories 建了多少条分类（供迁移台账记 detail） */
  async washCategory(): Promise<{ created: number }> {
    //! 因为新增了 category 的表，所以需要清洗数据。
    // 条件： meta.category 有数据，但 category 表为空。
    const meta = await this.metaModel.findOne();
    const categoryInMeta = meta?.categories || [];
    const data = await this.categoryModal.find({});
    if (!data.length && !!categoryInMeta.length) {
      this.logger.warn('版本升级，自动清洗分类数据！');
      let i = 1;
      for (const c of categoryInMeta) {
        await this.categoryModal.create({
          id: i,
          name: c,
          type: 'category',
          private: false,
          password: '',
        });
        i = i + 1;
      }
      this.logger.warn(`清洗完成！共 ${i} 条！`);
      return { created: i - 1 };
    }
    return { created: 0 };
  }
  async initVersion() {
    if (!version || version == 'dev') {
      this.logger.debug('开发版本');
      return;
    }
    try {
      const versionSetting = await this.settingProvider.getVersionSetting();
      if (!versionSetting || !versionSetting?.version) {
        // 没有版本信息，加进去
        await this.settingProvider.updateVersionSetting({
          version: version,
        });
      } else {
        // TODO 后面这里会判断版本执行一些版本迁移的数据清洗脚本
        await this.settingProvider.updateVersionSetting({
          version,
        });
      }
    } catch (err) {
      this.logger.error(`初始化版本信息失败: ${JSON.stringify(err, null, 2)}`);
    }
  }
}
