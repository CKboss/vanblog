import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenProvider } from '../token/token.provider';

@Injectable()
export class TokenGuard implements CanActivate {
  logger = new Logger(TokenGuard.name);
  constructor(private readonly tokenProvider: TokenProvider) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    return await this.validateRequest(request);
  }
  async validateRequest(request: Request) {
    // ⚠️ 凭据**只**从 `token` 这一个 header 取，不许新增第二个来源（cookie / Authorization / query）。
    //    理由在 `provider/token/token.provider.ts` 的 `checkToken` 注释里：它下面那句
    //    `findOne({ token, disabled: false })` 在 token 为 `undefined` 时会被 Mongoose 丢掉该条件，
    //    退化成"库里存在任意一个未吊销 token 就算通过"。`checkToken` 已经在源头挡掉了非字符串/空串，
    //    但**那层防的是"没有凭据"**；如果这里再多一个取值来源，就会出现"某个来源有值、`token` 头没有"
    //    的组合 —— 那时传进 `checkToken` 的到底是哪个值，取决于谁先写，而本仓库已经因为
    //    "undefined 退化成匹配任意一条"出过一次**未认证管理员接管**。
    //    所以这条性质由 `tokenGuardHeaderSource.spec.ts` 钉住：行为级（其它来源不会被当凭据）
    //    + 源码级（剥注释后不许出现那些取值路径）。
    const token = request.headers['token'];
    const ok = await this.tokenProvider.checkToken(token);
    if (!ok) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
