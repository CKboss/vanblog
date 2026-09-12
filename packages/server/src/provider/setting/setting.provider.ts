import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  HttpsSetting,
  ISRSetting,
  LayoutSetting,
  LoginSetting,
  MenuSetting,
  StaticSetting,
  VersionSetting,
  WalineSetting,
  defaultStaticSetting,
} from 'src/types/setting.dto';
import { SettingDocument } from 'src/scheme/setting.schema';
import { PicgoProvider } from '../static/picgo.provider';
import { encode } from 'js-base64';
import { defaultMenu, MenuItem } from 'src/types/menu.dto';
import { MetaProvider } from '../meta/meta.provider';
import { parseHtmlToHeadTagArr } from 'src/utils/htmlParser';
import { isForceLoginCommentEnabled } from 'src/utils/walineLogin';
import { parseCompressFormat, resolveCompressFormat } from 'src/utils/imgCompress';
import {
  parseBool,
  parseMaxImageEdge,
  parseThumbWidth,
  resolveMaxImageEdge,
} from 'src/utils/imageOptions';
import { DEFAULT_MAX_IMAGE_EDGE, DEFAULT_THUMB_WIDTH } from 'src/types/setting.dto';
import { makeSalt } from 'src/utils/crypto';
@Injectable()
export class SettingProvider {
  logger = new Logger(SettingProvider.name);
  constructor(
    @InjectModel('Setting')
    private settingModel: Model<SettingDocument>,
    private readonly picgoProvider: PicgoProvider,
    private readonly metaProvider: MetaProvider,
  ) {}
  /**
   * 内部用：归一化后的完整图片设置（**含隐写密钥**，不要直接返回给前端）。
   */
  async readStaticSetting(): Promise<StaticSetting> {
    const res = (await this.settingModel.findOne({ type: 'static' }).exec()) as {
      value: StaticSetting;
    };
    if (!res) {
      await this.settingModel.create({
        type: 'static',
        value: defaultStaticSetting,
      });
      return { ...defaultStaticSetting };
    }
    return this.normalizeStaticSetting({ ...defaultStaticSetting, ...(res?.value || {}) });
  }

  private normalizeStaticSetting(value: any): StaticSetting {
    return {
      ...value,
      compressFormat: resolveCompressFormat(value?.compressFormat),
      enableResize: parseBool(value?.enableResize, defaultStaticSetting.enableResize),
      maxImageEdge: resolveMaxImageEdge(value?.maxImageEdge),
      enableThumb: parseBool(value?.enableThumb, defaultStaticSetting.enableThumb),
      thumbWidth: value?.thumbWidth ? parseThumbWidth(value.thumbWidth) : DEFAULT_THUMB_WIDTH,
      enableStegoWaterMark: parseBool(
        value?.enableStegoWaterMark,
        defaultStaticSetting.enableStegoWaterMark,
      ),
      stegoWaterMarkText: value?.stegoWaterMarkText ? String(value.stegoWaterMarkText) : null,
    };
  }

  /** 对外（后台设置页会拿到）：隐写密钥不外泄。 */
  async getStaticSetting(): Promise<Partial<StaticSetting>> {
    const setting = await this.readStaticSetting();
    const safe: Partial<StaticSetting> = { ...setting };
    delete safe.stegoKey;
    return safe;
  }

  /**
   * 隐写水印密钥：第一次用到时生成并落库（和 jwt secret 一个套路）。
   * 换密钥之后旧图里的水印就读不出来了，所以只生成一次。
   */
  async getStegoKey(): Promise<string> {
    const setting = await this.readStaticSetting();
    if (setting?.stegoKey) {
      return setting.stegoKey;
    }
    const key = makeSalt();
    await this.updateStaticSetting({ stegoKey: key });
    this.logger.log('已生成隐写水印密钥（stegoKey）');
    return key;
  }
  async getVersionSetting(): Promise<any> {
    const res = await this.settingModel.findOne({ type: 'version' }).exec();
    if (res) {
      return res?.value;
    }
    return null;
  }
  async getISRSetting(): Promise<any> {
    const res = await this.settingModel.findOne({ type: 'isr' }).exec();
    if (res) {
      return res?.value;
    } else {
      await this.settingModel.create({
        type: 'isr',
        value: {
          mode: 'onDemand',
        },
      });
      return {
        mode: 'onDemand',
      };
    }
  }
  async updateISRSetting(dto: ISRSetting) {
    const oldValue = await this.getISRSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'isr',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'isr' }, { value: newValue });
    return res;
  }
  async getMenuSetting(): Promise<any> {
    const res = await this.settingModel.findOne({ type: 'menu' }).exec();
    if (res) {
      return res?.value;
    }
    return null;
  }
  async updateMenuSetting(dto: MenuSetting) {
    const oldValue = await this.getMenuSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'menu',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'menu' }, { value: newValue });
    return res;
  }
  async importSetting(setting: any) {
    for (const [k, v] of Object.entries(setting)) {
      if (k == 'static') {
        await this.importStaticSetting(v as any);
      }
    }
  }
  async importStaticSetting(dto: StaticSetting) {
    await this.updateStaticSetting(dto);
  }
  async getHttpsSetting(): Promise<HttpsSetting> {
    const res = await this.settingModel.findOne({ type: 'https' }).exec();
    if (res) {
      return (res?.value as any) || { redirect: false };
    }
    return null;
  }
  async getLayoutSetting(): Promise<LayoutSetting> {
    const res = await this.settingModel.findOne({ type: 'layout' }).exec();
    if (res) {
      return res?.value as any;
    }
    return null;
  }
  async getLoginSetting(): Promise<LoginSetting> {
    const res = await this.settingModel.findOne({ type: 'login' }).exec();
    if (res) {
      return (
        (res?.value as any) || {
          enableMaxLoginRetry: false,
          maxRetryTimes: 3,
          durationSeconds: 60,
          expiresIn: 3600 * 24 * 7,
        }
      );
    }
    return null;
  }
  encodeLayoutSetting(dto: LayoutSetting) {
    if (!dto) {
      return null;
    }
    const res: any = {};
    for (const key of Object.keys(dto)) {
      if (key == 'head') {
        res[key] = parseHtmlToHeadTagArr(dto[key]);
      } else {
        res[key] = encode(dto[key]);
      }
    }
    return res;
  }
  toPlainWalineSetting(value: any): WalineSetting {
    const raw = value && typeof value.toObject === 'function' ? value.toObject() : value;
    const plain = raw && typeof raw === 'object' ? { ...raw } : {};
    return {
      email: process.env.EMAIL || undefined,
      'smtp.enabled': false,
      ...plain,
      forceLoginComment: isForceLoginCommentEnabled(plain?.forceLoginComment),
    } as WalineSetting;
  }

  async getWalineSetting(): Promise<WalineSetting> {
    const res = await this.settingModel.findOne({ type: 'waline' }).exec();
    if (res) {
      return this.toPlainWalineSetting(res?.value);
    }
    return null;
  }
  async updateLoginSetting(dto: LoginSetting) {
    const oldValue = await this.getLoginSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'login',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'login' }, { value: newValue });
    return res;
  }
  async updateVersionSetting(dto: VersionSetting) {
    const oldValue = await this.getVersionSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'version',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'version' }, { value: newValue });
    return res;
  }

  async updateWalineSetting(dto: WalineSetting) {
    const oldValue = await this.getWalineSetting();
    const forceLoginComment =
      dto && Object.prototype.hasOwnProperty.call(dto, 'forceLoginComment')
        ? isForceLoginCommentEnabled(dto.forceLoginComment)
        : isForceLoginCommentEnabled(oldValue?.forceLoginComment);
    const newValue = { ...oldValue, ...dto, forceLoginComment };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'waline',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'waline' }, { value: newValue });
    return res;
  }
  async updateLayoutSetting(dto: LayoutSetting) {
    const oldValue = await this.getLayoutSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'layout',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'layout' }, { value: newValue });
    return res;
  }
  async updateHttpsSetting(dto: HttpsSetting) {
    const oldValue = await this.getHttpsSetting();
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'https',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'https' }, { value: newValue });
    return res;
  }
  async updateStaticSetting(dto: Partial<StaticSetting>) {
    // 用 readStaticSetting：里面的 stegoKey 必须在合并时保留，
    // 否则每次保存设置都会把密钥冲掉，旧图的水印就再也读不出来了。
    const oldValue = await this.readStaticSetting();
    if (Object.prototype.hasOwnProperty.call(dto, 'compressFormat')) {
      dto.compressFormat = parseCompressFormat(dto.compressFormat);
    }
    const has = (key: string) => Object.prototype.hasOwnProperty.call(dto, key);
    if (has('enableResize')) {
      dto.enableResize = parseBool(dto.enableResize, true);
    }
    if (has('maxImageEdge')) {
      dto.maxImageEdge =
        dto.maxImageEdge === null || dto.maxImageEdge === ('' as any)
          ? DEFAULT_MAX_IMAGE_EDGE
          : parseMaxImageEdge(dto.maxImageEdge);
    }
    if (has('enableThumb')) {
      dto.enableThumb = parseBool(dto.enableThumb, true);
    }
    if (has('thumbWidth')) {
      dto.thumbWidth = parseThumbWidth(dto.thumbWidth);
    }
    if (has('enableStegoWaterMark')) {
      dto.enableStegoWaterMark = parseBool(dto.enableStegoWaterMark, true);
    }
    if (has('stegoWaterMarkText')) {
      dto.stegoWaterMarkText = dto.stegoWaterMarkText
        ? String(dto.stegoWaterMarkText).trim().slice(0, 200)
        : null;
    }
    const newValue = { ...oldValue, ...dto };
    if (!oldValue) {
      return await this.settingModel.create({
        type: 'static',
        value: newValue,
      });
    }
    const res = await this.settingModel.updateOne({ type: 'static' }, { value: newValue });

    await this.picgoProvider.initDriver();
    return res;
  }
  async washDefaultMenu() {
    const r = await this.settingModel.findOne({ type: 'menu' });
    if (!r) {
      // 没有的话需要清洗
      const toInsert: MenuItem[] = defaultMenu;
      const meta = await this.metaProvider.getAll();
      const oldMenus = meta.menus;
      const d = Date.now();
      oldMenus.forEach((item: any, index: number) => {
        toInsert.push({
          id: d + index,
          level: 0,
          name: item.name,
          value: item.value,
        });
      });
      await this.updateMenuSetting({ data: toInsert });
      this.logger.log('清洗老 menu 数据成功！');
    }
  }
}
