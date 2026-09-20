import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { selectJwtVerifyKey } from 'src/utils/initJwt';
import { MetaProvider } from '../meta/meta.provider';
import { UserProvider } from '../user/user.provider';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly userProvider: UserProvider,
    private readonly metaProvider: MetaProvider,
  ) {
    super({
      // 获取请求header token值
      jwtFromRequest: ExtractJwt.fromHeader('token'),
      // ⚠️ 以前是 `secretOrKey: global.jwtSecret` —— 那是**构造时**取的一个字符串，
      //    于是密钥轮换之后本进程会一直用旧密钥验签（而旧密钥在宽限期结束后就作废了，
      //    这里根本不知道）。改成 provider 形式，每个请求现挑：
      //    按 token 头里的 `kid` 在"当前密钥"与"宽限期内的上一个密钥"之间选，
      //    没有 `kid` 的旧 token 走兼容分支（见 selectJwtVerifyKey 的注释）。
      secretOrKeyProvider: (_request: any, rawJwtToken: any, done: (err: Error | null, secret?: string) => void) => {
        try {
          const secret = selectJwtVerifyKey(rawJwtToken);
          if (!secret) {
            // 站点还没初始化 / 密钥还没装载：给 401，不给 500（jsonwebtoken 拿到空密钥会抛）
            done(new UnauthorizedException('服务端还没有可用的 JWT 密钥（站点可能尚未初始化）'));
            return;
          }
          done(null, secret);
        } catch (err) {
          // selectJwtVerifyKey 设计上不抛；真抛了也必须是 401 而不是把进程带崩
          done(new UnauthorizedException(`无法选择验签密钥：${(err as Error)?.message || err}`));
        }
      },
    });
  }

  async validate(payload: any): Promise<any> {
    //payload：jwt-passport认证jwt通过后解码的结果
    // 权限需要在库里查最新的，不然用老的 token 解码获得权限还是可以用。
    const moreDto = { ...payload };
    if (payload.sub != 0) {
      const user = await this.userProvider.getCollaboratorById(payload.sub);
      if (!user) {
        // 协作者已被删除但 token 还在有效期内：以前这里会读 user.permissions 直接 500
        throw new UnauthorizedException('该协作者已不存在');
      }
      moreDto.permissions = user.permissions;
      moreDto.nickname = user.nickname;
    } else {
      const user = await this.userProvider.getUser();
      if (!user) {
        // 库里没有 id:0 的管理员：恢复出一份坏库/空库、users 集合被清空，或历史上"两条 id:0"
        // 竞态的残留被清掉。这个 token 已经没有任何账号与之对应。
        // ⚠️ 必须是 401 而不是 500：以前这里直接读 `user.nickname` 抛 TypeError ⇒
        //    鉴权路径变成 500，调用方会以为"服务端坏了"而重试，而真相是"你的凭据不再有效"。
        //    这条路径**每个带 token 的请求都会走**，所以坏库会让整个后台变成一片 500。
        throw new UnauthorizedException(
          '管理员账号不存在（库里没有 id=0 的用户）：站点数据可能已损坏，或被恢复成了一份空/坏的备份',
        );
      }
      const siteInfo = await this.metaProvider.getSiteInfo();
      // ⚠️ getSiteInfo() 在 metas 里没有 siteInfo 时返回的是 undefined（它 `return raw`），
      //    所以 `siteInfo.author` 是第二处空值解引用 —— 与 user 那条同一行，一起修。
      const authorName = siteInfo?.author;
      moreDto.nickname = authorName || user.nickname;
    }
    return { name: payload.username, id: payload.sub, ...moreDto };
  }
}
