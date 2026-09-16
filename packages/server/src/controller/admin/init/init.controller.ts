import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  Query,
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

/**
 * 「初始化页恢复整站备份」的单飞互斥量（同步获取的布尔锁）。
 *
 * 为什么要它：这条接口**匿名可达**（只在站点未初始化时开放），而它做的事是
 * 覆盖整个站点（十几个集合 + 整棵静态目录）。`FullBackupProvider.restore()` 内部
 * 已经有一条串行队列（并发恢复会互相 deleteMany 同一个 `<coll>__vanblog_restore`
 * 临时集合，把集合静默截断），但那道闸在**收到 8GB 上传之后**才生效 ——
 * 两个并发请求都会先把归档落盘、都通过 `checkHasInited()`（第一个还没写完库），
 * 于是两次恢复叠在一起。这里在处理器最前面就把第二个挡掉（409）。
 *
 * ⚠️ 必须是**同步**获取的布尔锁，不能是"await 之后再把 promise 存进去"：
 * 处理器在落锁之前还要 await `checkHasInited()` / 读清单 / 查成员表，
 * 用 promise 版本的话两个并发请求会双双通过这些检查、双双落锁、双双恢复。
 *
 * ⚠️ 必须在 finally 里释放：否则一次失败（坏归档、磁盘满）会让这条接口永久 409，
 * 而站点又还没初始化 ⇒ 用户既进不了后台也恢复不了，只能重启容器。
 */
let initRestoreRunning = false;

/** 只给测试用：万一有用例把锁留在"进行中"，用它复位（生产代码不要调） */
export function __resetInitRestoreLockForTest(): void {
  initRestoreRunning = false;
}

export function isInitRestoreInFlight(): boolean {
  return initRestoreRunning;
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
  async initSystem(@Body() initDto: InitDto) {
    const hasInit = await this.initProvider.checkHasInited();
    if (hasInit) {
      throw new HttpException('已初始化', 500);
    }
    await this.initProvider.init(initDto);
    this.isrProvider.activeAll('初始化触发增量渲染！', undefined, {
      forceActice: true,
    });
    return {
      statusCode: 200,
      message: '初始化成功!',
    };
  }

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
  async restoreFromInitPage(@UploadedFile() file: any) {
    const uploadedPath = file?.path;
    // ⚠️ 只有**真正拿到锁的那一次调用**才能在 finally 里释放它。
    // 无条件 `initRestoreRunning = false` 的话，第二个被 409 挡掉的请求会把
    // 正在跑的那一次的锁顺手放掉，于是第三个请求又能进来 —— 两次恢复就真的叠在一起了
    // （这条正是被 src/audit-hardening-round3-initrestore.spec.ts 的并发用例抓出来的）。
    let claimedLock = false;
    try {
      if (config.demo && config.demo == 'true') {
        return { statusCode: 401, message: '演示站禁止修改此项！' };
      }
      // 单飞锁必须**先于任何 await**拿到（见文件头说明）
      if (initRestoreRunning) {
        throw new HttpException(
          '已经有一个恢复正在进行，请等它结束（完成后刷新页面即可进入后台）',
          409,
        );
      }
      initRestoreRunning = true;
      claimedLock = true;
      // "已初始化"的拒绝要在其它校验之前：这条接口匿名可达，
      // 对一个已经跑着的站点不该透露任何处理细节（与 /init/upload 的顺序一致）
      if (await this.initProvider.checkHasInited()) {
        throw new HttpException(
          '站点已经初始化过了：这条接口只对全新站点开放，请登录后到「备份与恢复」里恢复',
          403,
        );
      }
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
      );
      if (!manifest) {
        throw new BadRequestException(
          '读不出这个备份的清单：文件损坏/不完整，或不是本功能导出的整站备份',
        );
      }
      const members = await assertRestorableArchive(uploadedPath);
      this.logger.log(
        `初始化页恢复整站备份：${originalName}（清单 ${manifest.createdAt}，成员 ${members} 个）`,
      );

      const task = (async () => {
        const result = await this.fullBackupProvider.restore(uploadedPath, true);

        // 进程内缓存全部作废：这些值在"未初始化"期间可能已经被读过并缓存了
        this.initProvider.invalidateInitCache();
        this.viewStatsProvider.invalidateBase();
        invalidatePublicMetaCache();

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
            needsRestartForPipelineDeps: Boolean(result.needsRestartForPipelineDeps),
          },
        };
      })();
      return await task;
    } finally {
      if (claimedLock) {
        initRestoreRunning = false;
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
