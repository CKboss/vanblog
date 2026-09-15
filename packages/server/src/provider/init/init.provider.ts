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
@Injectable()
export class InitProvider {
  logger = new Logger(InitProvider.name);
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
      // 全新安装默认用**内置评论**（不依赖 waline 子进程）；
      // 老站点升级时没有这条设置，SettingProvider 会回落到 waline，评论数据不受影响。
      await this.settingProvider.updateCommentSetting({ provider: 'builtin' });
      await this.settingProvider.updateMenuSetting({ data: defaultMenu });
      // 运行 waline
      this.walineProvider.init();
      // 重启前台
      this.websiteProvider.restart('初始化');
      return '初始化成功!';
    } catch (err) {
      throw new BadRequestException('初始化失败');
    }
  }

  async checkHasInited() {
    const user = await this.userModel.findOne({}).exec();
    if (!user) {
      return false;
    }
    return true;
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

  async washStaticSetting() {
    // 新版加入了图床自动压缩功能，默认开启，需要洗一下。
    const staticSetting = await this.settingProvider.getStaticSetting();
    console.log(staticSetting);
    if (staticSetting && staticSetting.enableWebp === undefined) {
      this.logger.log('新版本自动开启图床压缩功能');
      await this.settingProvider.updateStaticSetting({
        enableWebp: true,
      });
    }
  }

  async washCustomPage() {
    // 老版本的 custom 表没带 type，洗一下加上
    const all = await this.customPageModal.find({
      type: {
        $exists: false,
      },
    });
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
      }
    }
  }

  async washCategory() {
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
    }
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
