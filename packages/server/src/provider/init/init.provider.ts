import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
import { WebsiteProvider } from '../website/website.provider';
import { CategoryDocument } from 'src/scheme/category.schema';
import { CustomPageDocument } from 'src/scheme/customPage.schema';
import e from 'express';
/** 「是否已初始化」的缓存时长；0 = 永久（直到进程重启或显式失效） */
function envNonNegativeInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

export const INIT_CACHE_MS = envNonNegativeInt('VANBLOG_INIT_CACHE_MS', 5 * 60 * 1000);

@Injectable()
export class InitProvider {
  logger = new Logger(InitProvider.name);
  private hasInitedCache: { value: boolean; at: number } | null = null;
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
  ) {}

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
