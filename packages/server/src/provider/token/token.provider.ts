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
    // ⚠️ 必须 await：旧实现是 fire-and-forget，于是"签发 token"与"吊销所有 token"之间
    //    存在竞态 —— 见 disableAll() 上的说明。签发失败时也必须让调用方知道（返回一个
    //    没落库的 token 等于发给用户一张下次重启就失效的凭证，因为 TokenGuard 要查库）。
    await this.tokenModel.create({ userId: 666666, name, token, expiresIn });
    return token;
  }

  async createToken(payload: any) {
    this.logger.debug(`用户 ${payload.username} 登录，创建 Token。`);
    const loginSetting = await this.settingProvider.getLoginSetting();
    const expiresIn = loginSetting?.expiresIn || 3600 * 24 * 7;
    const token = this.jwtService.sign(payload, {
      expiresIn,
    });
    // ⚠️ 同样必须 await：登录响应本来就要等 token，await 不增加用户可感知延迟，
    //    而不 await 会让"登录后立刻改密码"这种顺序操作出现吊销漏网（见 disableAll）。
    await this.tokenModel.create({ userId: payload.sub, token, expiresIn });
    return token;
  }
  async disableToken(token: string) {
    return await this.tokenModel.updateOne({ token }, { disabled: true });
  }
  /**
   * 吊销**所有**未吊销的 token。
   *
   * ⚠️ 范围要说清楚，因为这个方法名看起来只涉及"登录会话"：
   * 它按 `{ disabled: false }` 全表更新，所以**API Token 也一起被吊销** ——
   * API Token 的 `userId` 是 666666（见 createAPIToken），既不是 0 也不属于任何协作者。
   * 调用点（改管理员口令、走「忘记密码」恢复）之所以要这个行为，正是因为改完凭据后
   * 旧的 API Token 也必须失效，否则"改密码"根本挡不住已经泄露的长期凭证。
   *
   * ⚠️ 调用方必须 **await** 它。旧实现是 `setTimeout(() => disableAll(), 1000)`
   * （注释写"在前端清理 localStore 之后"），这带来两个真实后果：
   *   1) 与 create 竞态：登录时那条 `create` 没有 await，若它晚于 disableAll 落库，
   *      这个新 token 就**不会**被吊销 —— 旧的全失效了，它却还活着；
   *   2) 进程在这一秒内退出（重启、OOM、部署）⇒ 吊销**完全不发生**，而且没有任何日志。
   * 前端并不需要这 1 秒：它拿到 200 之后自己清 localStorage，服务端何时吊销与它无关；
   * 吊销在响应之前完成只会更安全（响应返回时旧凭证已经确定失效）。
   */
  async disableAll() {
    return await this.tokenModel.updateMany({ disabled: false }, { disabled: true });
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
