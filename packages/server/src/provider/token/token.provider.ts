import { Injectable, Logger } from '@nestjs/common';

import { TokenDocument } from 'src/scheme/token.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { SettingProvider } from '../setting/setting.provider';

@Injectable()
export class TokenProvider {
  logger = new Logger(TokenProvider.name);
  timer = null;
  constructor(
    @InjectModel('Token') private tokenModel: Model<TokenDocument>,
    private readonly jwtService: JwtService,
    private readonly settingProvider: SettingProvider,
  ) {}

  async getAllAPIToken() {
    this.logger.log(`获取所有 API Token`);
    return await this.tokenModel.find({ userId: 666666, disabled: false }).exec();
  }

  async disableAPIToken(token: string) {
    return await this.tokenModel.updateOne({ token }, { disabled: true });
  }
  async disableAPITokenByName(name: string) {
    return await this.tokenModel.updateOne({ name }, { disabled: true });
  }
  async disableAPITokenById(id: string) {
    return await this.tokenModel.updateOne({ _id: id }, { disabled: true });
  }

  async createAPIToken(name: string) {
    this.logger.log(`创建 API Token`);
    // 原来是 100 年 —— 等于永不过期，泄露一次就长期有效，还没法靠时间自愈。
    // 默认改成 1 年，可用 VANBLOG_API_TOKEN_TTL_DAYS 调（1 天 ~ 100 年）。
    // 已经签发出去的 token 不受影响（各自的 expiresIn 已经写在库里）。
    const ttlDays = Math.min(
      Math.max(Number(process.env.VANBLOG_API_TOKEN_TTL_DAYS) || 365, 1),
      36500,
    );
    const expiresIn = 3600 * 24 * ttlDays;
    const token = this.jwtService.sign(
      {
        sub: 0,
        username: name,
        role: 'admin',
      },
      {
        expiresIn,
      },
    );
    // 默认666666是 api token
    this.tokenModel.create({ userId: 666666, name, token, expiresIn });
    return token;
  }

  async createToken(payload: any) {
    this.logger.debug(`用户 ${payload.username} 登录，创建 Token。`);
    const loginSetting = await this.settingProvider.getLoginSetting();
    const expiresIn = loginSetting?.expiresIn || 3600 * 24 * 7;
    const token = this.jwtService.sign(payload, {
      expiresIn,
    });
    this.tokenModel.create({ userId: payload.sub, token, expiresIn });
    return token;
  }
  async disableToken(token: string) {
    return await this.tokenModel.updateOne({ token }, { disabled: true });
  }
  async disableAll() {
    return await this.tokenModel.updateMany({ disabled: false }, { disabled: true });
  }
  async disableAllAdmin() {
    return await this.tokenModel.updateMany({ disabled: false, userId: 0 }, { disabled: true });
  }
  async disableAllCollaborator() {
    return await this.tokenModel.updateMany(
      { disabled: false, userId: { $ne: 0 } },
      { disabled: true },
    );
  }
  async disableByUserId(id: number) {
    return await this.tokenModel.updateMany({ disabled: false, userId: id }, { disabled: true });
  }
  async checkToken(token: string) {
    // ⚠️ 必须先挡掉"没有 token"：下面那句 findOne({ token, disabled: false }) 在 token 是
    //    undefined 时会被 Mongoose 丢弃该条件 ⇒ 退化成 { disabled: false }，
    //    于是"库里存在任意一个未吊销 token"就等于校验通过。
    //    今天不可利用（AdminGuard 的第一环 JwtStrategy 从同一个 header 取值，缺 token 早就 401 了），
    //    但任何新增的取值路径（cookie / Authorization / query）都会让它变成真绕过 ⇒ 在源头关掉。
    if (typeof token !== 'string' || !token.trim()) {
      return false;
    }
    const result = await this.tokenModel.findOne({ token, disabled: false });
    if (!result) {
      return false;
    }
    return true;
  }
}
