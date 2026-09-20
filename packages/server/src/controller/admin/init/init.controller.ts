import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import { InitDto } from 'src/types/init.dto';
import { InitProvider } from 'src/provider/init/init.provider';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { StaticProvider } from 'src/provider/static/static.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { FullBackupProvider } from 'src/provider/backup/fullBackup.provider';
import { WalineProvider } from 'src/provider/waline/waline.provider';
import { WebsiteProvider } from 'src/provider/website/website.provider';
import { ViewStatsProvider } from 'src/provider/stats/viewStats.provider';
import { RESTORE_UPLOAD_OPTIONS } from 'src/utils/restoreUpload';
import { invalidatePublicMetaCache } from 'src/utils/publicMetaCache';
import {
  FULL_BACKUP_ARCHIVE_RE,
  assertRestorableArchive,
  inspectFullBackup,
} from 'src/utils/fullBackup';
import { config } from 'src/config';
import { clearSetupKey } from 'src/provider/init/setupKey';
import { invalidateJwtSecretCache } from 'src/utils/initJwt';

/**
 * 「初始化/初始化页恢复」的单飞互斥量（同步获取的布尔锁，**两条路由共用一把**）。
 *
 * 为什么要它：这两条接口**匿名可达**（只在站点未初始化时开放），而它们做的事
 * 都是"决定这个站点归谁"：`/init` 写管理员与 meta，`/init/restore` 覆盖整个站点
 * （十几个集合 + 整棵静态目录）。没有锁时的竞态：
 *  - 两个并发 `/init` 都通过 `checkHasInited()`（第一个还没写完库）⇒ **两个 id:0
 *    的管理员**，最坏情况是"两方都以为自己拥有这个站点"（有了 setup key 之后
 *    变成"攻击者和站长都以为自己拥有这个站点"）；
 *  - `/init` 与 `/init/restore` 并发 ⇒ 归档恢复与向导初始化互相踩（restore 先写
 *    `<coll>__vanblog_restore` 再 rename，期间 init 又把 users 插了一条）。
 * 所以两条路由抢**同一把**锁：任何一方在跑，另一方直接 409。
 *
 * `FullBackupProvider.restore()` 内部还有一条串行队列，但那道闸在**收到 8GB
 * 上传之后**才生效，这里在处理器最前面就把第二个挡掉。
 *
 * ⚠️ 必须是**同步**获取的布尔锁，不能是"await 之后再把 promise 存进去"：
 * 处理器在落锁之前还要 await `checkHasInited()` / 读清单 / 查成员表，
 * 用 promise 版本的话两个并发请求会双双通过这些检查、双双落锁、双双恢复
 * （AGENTS §7.55 B 记录在案的坑，这里两条路由都照做）。
 *
 * ⚠️ 必须在 finally 里、且**只有真正拿到锁的那一次调用**才能释放（归属检查）：
 * 无条件释放的话，被 409 挡掉的请求会把正在跑那一次的锁顺手放掉，第三个请求
 * 又能进来（同一个 §7.55 B 里被并发用例抓出来过的坑）。
 * 否则一次失败（坏归档、磁盘满）会让接口永久 409，而站点又还没初始化 ⇒
 * 用户既进不了后台也恢复不了，只能重启容器。
 *
 * ⚠️ 2026-09-19 起这里不再是裸布尔量（`let initRestoreRunning`）：布尔量表达不了
 * "**是谁**在跑"，于是"只有持锁者才能释放"只能靠调用点自觉；更要命的是它每进程一份，
 * cluster>1 时根本不互斥。现在下面是一个**持有者令牌**（进程内、同步）叠加一把
 * **DB 级 TTL 锁**（跨进程、权威），见 `utils/dbLock.ts`。
 */

/**
 * 进程内的**第一道**闸门：持有者令牌（不再是裸布尔量）。
 *
 * ⚠️ 为什么不能只有布尔量、又为什么**仍然**需要它：
 *  - 跨进程的权威互斥是 DB 级 TTL 锁（`utils/dbLock.ts`，经 `InitProvider.acquireInitRestoreLock`）。
 *    模块级布尔量是**每进程一份**的：`VANBLOG_CLUSTER_WORKERS>1`（文档化旋钮，多核机上 >1）时
 *    两个并发请求落到不同 worker，两边的布尔量都是 false ⇒ 两个 `/init` 双双通过
 *    `checkHasInited()`，造出两个 `id:0` 管理员（`getUser()` 是 `findOne({id:0})` 且**无排序**，
 *    "谁是管理员"随返回顺序漂移）；两个 `/init/restore` 则互相踩成**半新半旧的库**。
 *    init 桶限流（5 次/10 分钟/IP）只降概率，两个不同来源就够了。这是本轮修的真缺陷。
 *  - 但进程内这道闸门**不能删**：它是**同步**的，能在第一个 await 之前就把同进程的并发挡掉
 *    （§7.55 B：await 之后再落锁，两个请求会双双通过前置检查、双双落锁、双双恢复）。
 *    DB 锁必须 await，单靠它就等于把"同步落锁"这个性质让掉了。两道叠加：
 *    同进程零延迟挡住，跨进程由 Mongo 的单文档原子性裁决。
 *  - 用**令牌**而不是布尔量，是为了让"只有真正拿到锁的那一次调用才能释放"变成可验证的性质
 *    （被 409 挡掉的调用手里是 null，`finally` 里放不掉别人的锁）。
 */
let localInitRestoreOwner: string | null = null;
let localInitRestoreSeq = 0;

/** 同步抢进程内闸门：空闲则返回本次调用的持有者令牌，否则返回 null（不抛，由调用方决定响应） */
function claimLocalInitRestoreLock(): string | null {
  if (localInitRestoreOwner !== null) return null;
  localInitRestoreSeq += 1;
  localInitRestoreOwner = `local-${process.pid}-${localInitRestoreSeq}`;
  return localInitRestoreOwner;
}

/** 只有令牌对得上才释放（归属检查）；被 409 挡掉的调用传 null，什么也不会动 */
function releaseLocalInitRestoreLock(owner: string | null): void {
  if (owner !== null && localInitRestoreOwner === owner) {
    localInitRestoreOwner = null;
  }
}

/** 只给测试用：万一有用例把锁留在"进行中"，用它复位（生产代码不要调） */
export function __resetInitRestoreLockForTest(): void {
  localInitRestoreOwner = null;
}

/** 只给测试/诊断用：**本进程**是否正持有闸门（跨进程那把在 DB 里，要问 InitProvider） */
export function isInitRestoreInFlight(): boolean {
  return localInitRestoreOwner !== null;
}

/** 只给测试用：复位"DB 锁不可用已警告过"标志 */
export function __resetDbLockWarnForTest(): void {
  dbLockUnavailableWarned = false;
}

let dbLockUnavailableWarned = false;

/** finally 里释放 DB 锁的上限：超时只记日志，靠锁自身的 TTL 兜底（见 releaseCrossProcessInitLock） */
const RELEASE_LOCK_TIMEOUT_MS = 5_000;

/**
 * 抢跨进程（DB 级 TTL）锁。三态处理：
 *  - `acquired` → 返回 owner 凭据，调用方必须在 finally 里拿它去释放；
 *  - `busy` → 另一个进程正在初始化/恢复，调用方应当 409；
 *  - `unavailable` → 没有可用的锁后端（桩 InitProvider、连接尚未就绪）。此时**降级**为只用
 *    进程内闸门：单进程部署依然安全；但 cluster>1 就失去跨进程互斥 ⇒ 每进程 WARN 一次点名。
 *    ⚠️ 绝不静默降级 —— 静默失效正是这类锁最危险的坏法（用户以为有互斥）。
 */
async function acquireCrossProcessInitLock(
  initProvider: InitProvider,
  logger: Logger,
): Promise<{ owner: string | null; busy: boolean }> {
  const acquire = (initProvider as any)?.acquireInitRestoreLock;
  if (typeof acquire !== 'function') {
    if (!dbLockUnavailableWarned) {
      dbLockUnavailableWarned = true;
      logger.warn(
        'InitProvider 缺少 acquireInitRestoreLock（非标准构造路径，仅测试桩会走到）：本次只用进程内闸门，' +
          'cluster 多 worker 下不具备跨进程互斥',
      );
    }
    return { owner: null, busy: false };
  }
  const outcome = await acquire.call(initProvider);
  if (outcome?.kind === 'acquired') {
    return { owner: String(outcome.handle?.owner ?? ''), busy: false };
  }
  if (outcome?.kind === 'busy') return { owner: null, busy: true };
  if (!dbLockUnavailableWarned) {
    dbLockUnavailableWarned = true;
    logger.warn(
      `初始化/恢复的跨进程锁不可用（${String(outcome?.reason ?? '未知原因')}）：降级为只用进程内闸门。` +
        '单进程部署不受影响；VANBLOG_CLUSTER_WORKERS>1 时两个 worker 可能同时初始化/恢复。',
    );
  }
  return { owner: null, busy: false };
}

/**
 * 释放跨进程锁。**只删自己那把**（owner 由 acquire 返回，释放时在 DB 侧校验）。
 * ⚠️ 释放失败既不能掩盖原始异常、也不能让接口 500：DB 锁带 TTL，最坏情况是别人要等到过期
 * （默认 30 分钟，`VANBLOG_INIT_LOCK_TTL_MINUTES` 可调），所以这里只记日志。
 */
async function releaseCrossProcessInitLock(
  initProvider: InitProvider,
  owner: string | null,
  logger: Logger,
): Promise<void> {
  if (!owner) return;
  const release = (initProvider as any)?.releaseInitRestoreLock;
  if (typeof release !== 'function') return;
  try {
    // ⚠️ 必须带超时：这个调用在 **finally** 里，mongo 无响应时若一直等，
    //    响应会被拖住、而且进程内闸门也放不掉（后续请求全部 409）。
    //    DB 锁本身带 TTL，超时放不掉只是"别人要等到过期"，不会永久卡死。
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve(release.call(initProvider, owner)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('release timeout')), RELEASE_LOCK_TIMEOUT_MS);
        // ⚠️ unref：否则这个定时器会让事件循环多挂 5 秒（进程退不掉、jest 报 open handle）
        if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } catch (err: any) {
    logger.error(
      `释放初始化/恢复锁失败（锁会在 TTL 到期后自动可被接管）：${String(err?.message ?? err)}`,
    );
  }
}

/**
 * setup key 闸门。**默认开启**：`VANBLOG_INIT_REQUIRE_SETUP_KEY` 未设置 = 开，
 * 显式 `false/0/no/off` 才关（关闭时两条路由的行为与旧版**逐字节一致**：
 * 不读文件、不比较、响应不加任何字段 —— 这条由 e2e 钉住）。
 * 400/500 的 wire 契约（`setupKeyRequired`/`reason`/`setupKeyUnavailable`、指路
 * 文案、常量时间比较、密钥绝不回显）全部收敛在 setupKey.ts 的 `enforceSetupKey`。
 *
 * ⚠️ 调用为什么走 `initProvider.assertSetupKeyAllowed?.()` 而不是直接 import
 * 模块函数：仓库里有多个用**桩 InitProvider** 直接 `new InitController(...)` 的
 * 既有源码级测试（audit-hardening-round3-initrestore / round3-silent —— 不归本轮
 * 所有、不许改），它们的桩没有这个方法；默认翻成"开"之后，模块级闸门会把这些
 * 用例全部打成 500。`?.()` 让桩构造路径跳过闸门并**每进程 WARN 一次**点名
 * （绝不静默）。生产 Nest DI 注入的永远是真 InitProvider，方法必然存在，
 * cluster worker 也一样（worker 内存没有密钥时校验回落读主实例写下的文件，
 * **不会**跳过）—— 两侧都有源码钉子：控制器必须调 assertSetupKeyAllowed，
 * InitProvider.prototype 必须有该方法（见 init.setupkey.spec.ts）。
 */
let stubGateWarned = false;
function runSetupKeyGate(initProvider: InitProvider, supplied: unknown, logger: Logger): void {
  if (typeof initProvider?.assertSetupKeyAllowed === 'function') {
    initProvider.assertSetupKeyAllowed(supplied);
    return;
  }
  if (!stubGateWarned) {
    stubGateWarned = true;
    logger.warn(
      'InitProvider 缺少 assertSetupKeyAllowed（非标准构造路径，仅测试桩会走到）：本次跳过初始化密钥校验',
    );
  }
}

/** 只给测试用：复位"已警告过"标志（生产代码不要调） */
export function __resetSetupKeyGateWarnForTest(): void {
  stubGateWarned = false;
}

@ApiTags('init')
@ApiToken
@Controller('/api/admin')
export class InitController {
  private readonly logger = new Logger(InitController.name);
  constructor(
    private readonly initProvider: InitProvider,
    private readonly staticProvider: StaticProvider,
    private readonly isrProvider: ISRProvider,
    private readonly fullBackupProvider: FullBackupProvider,
    private readonly walineProvider: WalineProvider,
    private readonly websiteProvider: WebsiteProvider,
    private readonly viewStatsProvider: ViewStatsProvider,
  ) {}

  @Post('/init')
  async initSystem(
    @Body() initDto: InitDto,
    // setup key：JSON body 顶层的可选字段（flag 关闭时完全不看，行为与今天一致）
    @Body('setupKey') setupKey?: string,
    @Req() req?: any,
  ) {
    // ⚠️ 锁必须先于**任何 await** 同步拿到；只有拿到锁的这次调用才能在 finally 里放
    // ⚠️ 进程内闸门必须**先于任何 await**同步拿到（见文件头）；跨进程的 DB 锁紧随其后，
    //    并且落在 `checkHasInited()` **之前** —— 这样"两个进程都读到未初始化"的窗口被彻底关掉。
    const localOwner = claimLocalInitRestoreLock();
    const claimedLock = localOwner !== null;
    let dbLockOwner: string | null = null;
    try {
      if (localOwner === null) {
        throw new HttpException(
          '已经有一个初始化/恢复正在进行，请等它结束（若那一次成功了，刷新页面即可）',
          409,
        );
      }
      const cross = await acquireCrossProcessInitLock(this.initProvider, this.logger);
      if (cross.busy) {
        throw new HttpException(
          '已经有一个初始化/恢复正在进行（由另一个进程持有锁），请等它结束（若那一次成功了，刷新页面即可）',
          409,
        );
      }
      dbLockOwner = cross.owner;

      const hasInit = await this.initProvider.checkHasInited();
      if (hasInit) {
        throw new HttpException('已初始化', 500);
      }
      runSetupKeyGate(this.initProvider, setupKey, this.logger);
      const started = Date.now();
      await this.initProvider.init(initDto);
      // 安装记录（迁移台账 + WARN）：让"这个站点是谁、何时、从哪个 IP 初始化的"
      // 事后可查。⚠️ 用 ?.() 调用：既有用桩 InitProvider 的测试没有这个方法，
      // 而台账缺失时 recordInstallation 内部也只会回落到 NOOP，绝不影响初始化结果。
      await this.initProvider.recordInstallation?.({
        route: 'init',
        req,
        durationMs: Date.now() - started,
      });
      this.isrProvider.activeAll('初始化触发增量渲染！', undefined, {
        forceActice: true,
      });
      return {
        statusCode: 200,
        message: '初始化成功!',
      };
    } finally {
      // 先放跨进程的 DB 锁（只删自己那把），再放进程内闸门；两次都带归属检查 ——
      // 被 409 挡掉的调用手里是 null，什么也放不掉（否则正在跑那一次的锁会被顺手放掉，
      // 第三个请求又能进来；这条正是 round3 的并发用例抓出来过的坑）。
      await releaseCrossProcessInitLock(this.initProvider, dbLockOwner, this.logger);
      if (claimedLock) {
        releaseLocalInitRestoreLock(localOwner);
      }
    }
  }

  /**
   * 初始化向导上传 logo / favicon。
   *
   * ⚠️ **这是三条 init 接口里唯一不要求初始化密钥的一条**，而且是**故意的**，理由与代价都写清楚：
   *  - 为什么不能加闸门：向导的上传组件（admin 的 `UrlFormItem`，`isInit` 时打这条接口）
   *    **手里没有密钥** —— 密钥输入框要等提交 `/init` 被 400 拒绝之后才出现（页面加载时故意不探测，
   *    免得烧掉 `/api/admin/init*` 的 5 次/10 分钟预算）。给这条加 `runSetupKeyGate` 会让
   *    "先传个 logo 再填表"的正常流程直接失败，除非同时改后台交互时序。
   *  - 因此暴露面是：站点未初始化期间，匿名可以往图床传图片。爆炸半径被三层限制住 ——
   *    只在 `checkHasInited()` 为假时开放（下面第一行就查，且 `InitMiddleware` 之外还自查一次）、
   *    init 桶限流 5 次/10 分钟/IP（`utils/rateLimit.ts` 按前缀覆盖 `/api/admin/init`）、
   *    以及 `staticProvider.upload` 自身的类型/大小校验。**不能**用它接管站点。
   *  - 想彻底关掉这个窗口只有一个办法：零接触初始化（`VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`/`_FILE`），
   *    那样站点在开始监听之前就已初始化，这条接口永远返回「已初始化」。
   *  如果哪天决定给它加闸门，记得同步改 admin 的上传时序，并更新 `docs/reference/api.md` 与
   *  `docs/advanced/security.md` 里"三条 init 接口都要密钥"的说法（现在写的是两条要、这条不要）。
   */
  @Post('/init/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImg(@UploadedFile() file: any, @Query('favicon') favicon: string) {
    const hasInit = await this.initProvider.checkHasInited();
    if (hasInit) {
      throw new HttpException('已初始化', 500);
    }
    let isFavicon = false;
    if (favicon && favicon == 'true') {
      isFavicon = true;
    }
    const res = await this.staticProvider.upload(file, 'img', isFavicon);
    return {
      statusCode: 200,
      data: res,
    };
  }

  /**
   * 在**初始化页**直接上传整站备份并恢复：全新安装不必再手填站点信息/账号，
   * 一份备份就把整站（数据库 + 图床 + 主题 + 自定义页面）搬过来。
   *
   * 与其它 init 接口一样匿名可达（`InitController` 整个不挂 AdminGuard），
   * 但**只在站点还没初始化时**开放，并且：
   *  - 处理器里再查一次 `checkHasInited()`（不只依赖中间件/守卫）；
   *  - 单飞互斥（见文件头），并发第二个直接 409；
   *  - 写库之前先把归档验一遍：文件名白名单 → 能读出 manifest → 成员名不含
   *    绝对路径/`..`（这条接口匿名可达，不能只靠 tar 自己拒绝穿越成员：
   *    本机是 GNU tar 会拒，容器里是 busybox tar，行为不该靠猜）；
   *  - 无论成功失败，multer 落盘的临时归档都在 finally 里删掉；
   *  - 恢复完把进程内的缓存全部作废（init 缓存、浏览统计基数、公开 meta 缓存），
   *    并补做"全新站点没做过"的启动动作：拉起 waline（main.ts 只在已初始化时才起它）、
   *    重启前台（让 VAN_BLOG_ALLOW_DOMAINS / ISR 设置按恢复后的库重算）、触发全量渲染。
   *
   * 失败时站点处于什么状态：所有校验都在**写库之前**，所以坏归档不会留下任何数据；
   * 万一是恢复进行到一半失败（磁盘满 / mongod 挂了），`restoreFullBackup` 是
   * "先写 `<coll>__vanblog_restore` 临时集合、再逐集合 rename" 的做法，
   * 失败的集合保持原样（此时库里仍然没有 users ⇒ 站点**仍然是未初始化状态**，
   * 可以再试一次或改走初始化向导），不会出现"半恢复却被当成已初始化"。
   */
  @Post('/init/restore')
  @UseInterceptors(FileInterceptor('file', RESTORE_UPLOAD_OPTIONS))
  async restoreFromInitPage(
    @UploadedFile() file: any,
    // setup key：multipart 的**文本字段**（multer 会把它放进 req.body；
    // RESTORE_UPLOAD_OPTIONS 的 fields 限额是 8，file + setupKey 远没到）
    @Body('setupKey') setupKey?: string,
    @Req() req?: any,
    // 加密归档的口令。**只能**走 multipart 的文本字段（body），不接受 query：
    // query 会原样进 caddy 的访问日志，而口令进日志等于没加密。
    // ⚠️ RESTORE_UPLOAD_OPTIONS 的 fields 限额是 8，file + setupKey + backupPassphrase 才 3 个。
    // ⚠️ 这个值不许进任何 logger 调用（下面的日志只提"是否加密"，不提口令）。
    // ⚠️ **刻意放在参数表最后**：这个方法在测试里是被**按位置**调用的
    //    （`restoreFromInitPage(file, setupKey, req)`），插在中间会让既有调用把 `req`
    //    喂进口令位、把 `undefined` 喂进 req 位 —— 不报错，只是行为悄悄变了。
    @Body('backupPassphrase') backupPassphrase?: string,
  ) {
    const uploadedPath = file?.path;
    const archivePassphrase =
      typeof backupPassphrase === 'string' && backupPassphrase.length > 0 ? backupPassphrase : null;
    // ⚠️ 只有**真正拿到锁的那一次调用**才能在 finally 里释放它。
    // 无条件 `initRestoreRunning = false` 的话，第二个被 409 挡掉的请求会把
    // 正在跑的那一次的锁顺手放掉，于是第三个请求又能进来 —— 两次恢复就真的叠在一起了
    // （这条正是被 src/audit-hardening-round3-initrestore.spec.ts 的并发用例抓出来的）。
    // 进程内闸门同步拿；跨进程 DB 锁在下面紧接着拿（见文件头）
    const localOwner = claimLocalInitRestoreLock();
    const claimedLock = localOwner !== null;
    let dbLockOwner: string | null = null;
    try {
      if (config.demo && config.demo == 'true') {
        // 演示站：什么也没做就返回。⚠️ 这里**不需要**显式释放闸门 —— return 在 try 里，
        // finally 会带归属检查地放掉（此时 dbLockOwner 还是 null，跨进程那把也没拿）。
        return { statusCode: 401, message: '演示站禁止修改此项！' };
      }
      if (localOwner === null) {
        throw new HttpException(
          '已经有一个恢复正在进行，请等它结束（完成后刷新页面即可进入后台）',
          409,
        );
      }
      const cross = await acquireCrossProcessInitLock(this.initProvider, this.logger);
      if (cross.busy) {
        throw new HttpException(
          '已经有一个恢复正在进行（由另一个进程持有锁），请等它结束（完成后刷新页面即可进入后台）',
          409,
        );
      }
      dbLockOwner = cross.owner;
      // "已初始化"的拒绝要在其它校验之前：这条接口匿名可达，
      // 对一个已经跑着的站点不该透露任何处理细节（与 /init/upload 的顺序一致）
      if (await this.initProvider.checkHasInited()) {
        throw new HttpException(
          '站点已经初始化过了：这条接口只对全新站点开放，请登录后到「备份与恢复」里恢复',
          403,
        );
      }
      // setup key 闸门（默认开启；显式 VANBLOG_INIT_REQUIRE_SETUP_KEY=false
      // 时是一个纯布尔判断 + return，行为与旧版逐字节一致）。
      // 放在"已初始化 403"之后：对已初始化站点仍然一个字都不多说。
      runSetupKeyGate(this.initProvider, setupKey, this.logger);
      if (!uploadedPath) {
        throw new BadRequestException('请上传整站备份文件（multipart 字段名 file）');
      }

      const originalName = String(file?.originalname || '');
      if (!FULL_BACKUP_ARCHIVE_RE.test(originalName)) {
        throw new BadRequestException(
          `文件名不像是本功能导出的整站备份（应形如 vanblog-full-20260913-140955.tar.zst），收到：${
            originalName.slice(0, 120) || '(空)'
          }`,
        );
      }
      const manifest = await inspectFullBackup(
        uploadedPath,
        this.fullBackupProvider.backupDir(),
        archivePassphrase,
      );
      if (!manifest) {
        throw new BadRequestException(
          '读不出这个备份的清单：文件损坏/不完整，或不是本功能导出的整站备份',
        );
      }
      // ⚠️ 体积/剩余空间闸门要在**解密之后**才能数成员，所以口令必须传进去；
      //    拿不到口令时这里就会给出「这份归档是加密的 + 两条可照做的办法」，
      //    而不是等到解包一半才失败（那时磁盘上已经有一份半截的明文了）。
      const members = await assertRestorableArchive(uploadedPath, { passphrase: archivePassphrase });
      this.logger.log(
        `初始化页恢复整站备份：${originalName}（清单 ${manifest.createdAt}，成员 ${members} 个）`,
      );

      const task = (async () => {
        const result = await this.fullBackupProvider.restore(uploadedPath, true, archivePassphrase);

        // 进程内缓存全部作废：这些值在"未初始化"期间可能已经被读过并缓存了
        this.initProvider.invalidateInitCache();
        // ⚠️ **JWT 密钥缓存也必须作废**：恢复把 `settings{type:'jwt'}` 整体换成了归档里那份
        //    （密钥可能被"回滚"成归档导出时的值，轮换记录 `previous` 也一并被覆盖）。
        //    而 initJwt 是记忆化的，不作废的话本进程会继续用恢复前的密钥签发 ——
        //    当下看不出问题，**下次重启**从库里读到归档那份，这批令牌就全部失效了
        //    （一次"重启后才爆发"的事故）。作废之后下一次签发/验签会重新读库。
        invalidateJwtSecretCache();
        this.viewStatsProvider.invalidateBase();
        invalidatePublicMetaCache();

        // 安装记录（迁移台账 key=install:initialised + WARN 一条）：恢复这条路
        // 同样要回答"这个站点是谁、何时、从哪个 IP、用哪份归档初始化的"。
        // ⚠️ ?.() 调用：既有用桩 InitProvider 的测试没有这个方法（台账缺失时
        // 方法内部也会回落 NOOP），绝不影响恢复结果本身。
        await this.initProvider.recordInstallation?.({
          route: 'init/restore',
          req,
          archiveName: originalName,
          durationMs: result.ms,
        });

        // 全新站点的 waline 从来没被拉起过（main.ts 只在 checkHasInited() 为真时 init），
        // 而评论系统的开关/配置现在来自归档 ⇒ 这里补一次；失败只影响评论，不该让恢复报错
        try {
          await this.walineProvider.init();
        } catch (err) {
          this.logger.warn(`恢复后启动评论服务失败：${(err as Error)?.message || err}`);
        }
        // 前台的环境变量（图床域名白名单、ISR 模式）依赖恢复后的库，重启一次让它重算
        try {
          await this.websiteProvider.restart('初始化页恢复整站备份');
        } catch (err) {
          this.logger.warn(`恢复后重启前台失败：${(err as Error)?.message || err}`);
        }
        // ⚠️ 第二个参数（delay）**必须给**：`activeAll` 会把它转交给
        // `rssProvider.generateRssFeed(info, delay)` 与 `sitemapProvider.generateSiteMap(info, delay)`，
        // 那两个函数是 `setTimeout(..., delay || 3*60*1000)` / `delay || 60*1000` ——
        // 不传就是"RSS 3 分钟后、sitemap 1 分钟后"才写文件，而且**任何**后续 activeAll 都会
        // 把这两个定时器重置。容器里实测过后果：刚恢复完 `/app/static/rss/` 是空的、
        // `GET /feed.xml` **404**；sitemap 之所以有内容只是因为整点 cron 恰好跑过。
        // `main.ts` 启动时传的就是 1000，这里对齐（1 秒后两个文件都会写出来）。
        // forceActice：恢复出来的 ISR 设置可能是 delay 模式，但此刻必须渲染一遍，
        // 否则前台会一直是空的（与 /api/admin/init 的做法一致）。
        this.isrProvider.activeAll('初始化页恢复整站备份触发全量渲染！', 1000, {
          forceActice: true,
        });

        const initialized = await this.initProvider.checkHasInited();
        // ⚠️ 只有归档真带了 users（站点就此初始化完成）才清 setup.key：
        // initialized:false 时站点仍未初始化，接下来的向导**仍然需要**这把密钥，
        // 删了等于把站长锁在自己的全新安装外面（下次重启才会重新生成）。
        if (initialized) {
          clearSetupKey();
        }
        const counts = countCollections(manifest);
        return {
          statusCode: 200,
          data: {
            restoredAt: new Date().toISOString(),
            seconds: Number((result.ms / 1000).toFixed(1)),
            databases: result.databases,
            static: result.static,
            backupCreatedAt: manifest.createdAt,
            notes: result.notes,
            // 前台可以直接展示的数字（取自归档清单，也就是这次恢复进来的条数）
            counts,
            adminUserFromArchive: counts.users > 0,
            initialized,
            // P3（100% 保真）：静态目录被修剪掉多少"归档里没有的文件"、
            // 以及哪些表是归档里没有的（留着不删 = 站点处于混合状态，必须能被看见）
            prunedStatic: (result.pruned || []).map((item) => ({
              folder: item.folder,
              removedFiles: item.removedFiles,
              removedDirs: item.removedDirs,
              names: item.names,
            })),
            absentCollections: result.absentCollections || [],
            needsRestartForPipelineDeps: Boolean(result.needsRestartForPipelineDeps),
          },
        };
      })();
      return await task;
    } finally {
      // 先放跨进程的 DB 锁（只删自己那把），再放进程内闸门；两次都带归属检查 ——
      // 被 409 挡掉的调用手里是 null，什么也放不掉（否则正在跑那一次的锁会被顺手放掉，
      // 第三个请求又能进来；这条正是 round3 的并发用例抓出来过的坑）。
      await releaseCrossProcessInitLock(this.initProvider, dbLockOwner, this.logger);
      if (claimedLock) {
        releaseLocalInitRestoreLock(localOwner);
      }
      // multer 已经把归档（可能几百 MB）落到 <backupPath>/upload-tmp/ 了：
      // 校验失败、恢复失败、成功，都要删掉，否则每试一次就泄漏一份
      if (uploadedPath) {
        try {
          fs.rmSync(uploadedPath, { force: true });
        } catch (err) {
          this.logger.warn(
            `删除上传的备份临时文件失败（${uploadedPath}）：${(err as Error)?.message || err}`,
          );
        }
      }
    }
  }
}

/** 从归档清单里取出各集合的条数（清单里的集合名就是库里的小写集合名） */
function countCollections(manifest: {
  databases?: Record<string, { collections?: Record<string, { count?: number }> }>;
}): {
  articles: number;
  statics: number;
  users: number;
  visits: number;
  viewers: number;
  settings: number;
  total: number;
} {
  const all: Record<string, number> = {};
  for (const db of Object.keys(manifest?.databases || {})) {
    const collections = manifest.databases?.[db]?.collections || {};
    for (const name of Object.keys(collections)) {
      all[name] = Number(collections[name]?.count || 0);
    }
  }
  const total = Object.keys(all).reduce((sum, name) => sum + all[name], 0);
  return {
    articles: all['articles'] || 0,
    statics: all['statics'] || 0,
    users: all['users'] || 0,
    visits: all['visits'] || 0,
    viewers: all['viewers'] || 0,
    settings: all['settings'] || 0,
    total,
  };
}
