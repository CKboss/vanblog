import { Injectable, Logger } from '@nestjs/common';
import { StaticType, StoragePath } from 'src/types/setting.dto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'src/config';
import { fallbackTypeFromName, safeImageSize } from 'src/utils/imageMeta';
import { formatBytes } from 'src/utils/size';
import { PicGo } from 'picgo';
import { ImgMeta } from 'src/types/img';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SettingDocument } from 'src/scheme/setting.schema';
import {
  isPicgoPluginsAllowed,
  normalizePluginList,
  picgoPluginsBlockedReason,
} from 'src/utils/picgoPlugins';

/**
 * 安装是**异步**进行的（真的在跑 npm install，不能拖住「保存设置」这个接口），
 * 所以结果里不带 picgo 的安装产出：成功/失败都写在日志里。
 */
export interface InstallPluginsResult {
  /** false 表示被环境开关拦下来了（默认就是拦下来） */
  allowed: boolean;
  /** 规范化之后的插件名列表 */
  requested: string[];
  /** 被拦下时的解释（会进日志，也会返回给调用方） */
  reason?: string;
}
@Injectable()
export class PicgoProvider {
  picgo: PicGo;
  logger = new Logger(PicgoProvider.name);
  constructor(
    @InjectModel('Setting')
    private settingModel: Model<SettingDocument>,
  ) {
    this.picgo = new PicGo();
    // 构造函数里不能 await：挂个 catch，否则读设置失败就是一条没人认领的 unhandledRejection
    this.initDriver().catch((err) => {
      this.logger.error(`初始化图床驱动失败：${(err as Error)?.message || err}`);
    });
  }
  async getSetting(): Promise<any> {
    const res = await this.settingModel.findOne({ type: 'static' }).exec();
    if (res) {
      return res?.value || { storageType: 'local', picgoConfig: null };
    }
    return null;
  }
  async initDriver() {
    const staticSetting = await this.getSetting();
    const picgoConfig = staticSetting?.picgoConfig;
    const plugins = staticSetting?.picgoPlugins;
    // ⚠️ 顺序不能变：先把 uploader 配置塞给 picgo（上传路径靠它），插件是可选的附加项
    if (picgoConfig) {
      this.picgo.setConfig(picgoConfig);
    }
    if (plugins) {
      const result = await this.installPlugins(plugins.split(','));
      if (!result.allowed) {
        this.logger.warn(result.reason);
      }
    }
  }

  /**
   * 安装后台配置的 picgo 插件 —— **默认被环境开关拦住**。
   *
   * 原因与取舍见 `utils/picgoPlugins.ts`：picgo 1.5.6 拖进来的 `git-clone@0.1.0`
   * 是命令注入、`decompress` 是解压路径穿越，两个都**没有修复版本**，
   * 而插件名来自后台设置 ⇒「拿到后台会话 → 容器内 root」。
   * 确认接受风险的部署可以设 `VANBLOG_ALLOW_PICGO_PLUGINS=true` 打开。
   *
   * 这里返回结果而不是抛异常：`initDriver()` 会在**每次保存图床设置**时被调用，
   * 抛出去会让"保存设置"整件事失败（用户可能只是想改压缩开关），
   * 所以拦下来时只记一条明确的日志 + 把原因返回给调用方。
   */
  async installPlugins(plugins: string[]): Promise<InstallPluginsResult> {
    const requested = normalizePluginList(plugins);
    if (!requested.length) {
      return { allowed: true, requested };
    }
    if (!isPicgoPluginsAllowed()) {
      return {
        allowed: false,
        requested,
        reason: picgoPluginsBlockedReason(requested),
      };
    }
    this.logger.log(`尝试安装 picgo 插件：${requested.join(', ')}`);
    // ⚠️ 这里**故意不 await**：`initDriver()` 挂在「保存图床设置」这条同步返回的接口上，
    // 而插件安装是真的在跑 npm install（几十秒到几分钟）。等它结束再返回，
    // 后台点一下"保存"就会一直转圈直到网关超时 —— 那是比"日志晚一点"严重得多的体验问题。
    // 结果通过日志给出；失败也只影响插件本身，不影响图床上传。
    void Promise.resolve(this.picgo.pluginHandler.install(requested))
      .then((result) => {
        if (result?.success) {
          this.logger.log(`picgo 安装插件成功！${result.body}`);
        } else {
          this.logger.error(`picgo 插件安装失败！${result?.body}`);
        }
      })
      .catch((err) => {
        this.logger.error(`picgo 插件安装抛异常：${(err as Error)?.message || err}`);
      });
    return { allowed: true, requested };
  }
  async saveFile(fileName: string, buffer: Buffer, type: StaticType) {
    const result = safeImageSize(buffer, fallbackTypeFromName(fileName));
    const byteLength = buffer.byteLength;

    const meta: ImgMeta = { ...result, size: formatBytes(byteLength) };
    // 搞一个临时的
    const srcPath = path.join(config.staticPath, 'tmp', fileName);
    fs.writeFileSync(srcPath, buffer);
    let realPath = undefined;
    try {
      const res = await this.picgo.upload([srcPath]);
      realPath = res[0].imgUrl;
    } catch (err) {
      throw err;
    } finally {
      try {
        fs.rmSync(srcPath);
      } catch (err) {
        // console.log(err);
      }
    }
    return {
      meta,
      realPath,
    };
  }
  async deleteFile(fileName: string, type: StaticType) {
    const storagePath = StoragePath[type] || StoragePath['img'];
    const srcPath = path.join(config.staticPath, storagePath, fileName);
    fs.rmSync(srcPath);
  }
}
