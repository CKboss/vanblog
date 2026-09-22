import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isSuperAdminUser } from 'src/types/access/access';
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
    // ⚠️ 分支判定必须与 AccessGuard 用**同一把尺子**：`isSuperAdminUser({ id: payload.sub })`，
    //    不是 `payload.sub != 0`，也不是自己再写一个 `payload.sub === 0`。三条理由：
    //    1. `!= 0` 是**松散**比较，而 JS 里 `undefined != 0` 与 `null != 0` **都是 true**
    //       ⇒ payload 缺 `sub` 时会掉进协作者分支（下面那条 401 就是为它加的）；
    //    2. 自己写 `=== 0` 会与下游分歧：`isSuperAdminUser` 还认**字面字符串** `"0"`，
    //       于是 `sub:"0"` 在这里走协作者分支、到 AccessGuard 却被判成超管 —— 两处身份判定
    //       不一致本身就是缺陷（而且这种不一致只会以"某条路由莫名放行/莫名 403"的形式暴露）；
    //    3. 身份判定只应有一份实现（`types/access/access.ts`），抄一份就会漂。
    if (isSuperAdminUser({ id: payload?.sub })) {
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
    } else {
      // 🔴 进协作者分支之前**必须**先确认 `sub` 是个整数。这是本仓库"Mongoose 丢掉值为
      //    `undefined` 的查询条件"这一族的**第 6 例**（前 5 例：`checkToken` 未认证管理员接管、
      //    `updateCollaborator` 改任意协作者口令、`updateCustomPage` 改任意公开页面、
      //    `deleteByPath` 删任意一页并连带删磁盘目录、`category.deleteOne({ name })`）。
      //    链条：`getCollaboratorById(id)` 是 `findOne({ id, type: 'collaborator' })`，
      //    `id` 为 undefined 时该条件被丢弃 ⇒ 退化成 `{ type: 'collaborator' }` ⇒ 返回**自然顺序里
      //    任意一个协作者** ⇒ 本次请求的身份变成 `id: undefined` + `name: payload.username` +
      //    **那个人的 permissions**。若他恰好是 `['all']`，AccessGuard 会放行除超管专属前缀外的一切。
      //    ⚠️ 可达性如实说：**不是远程可利用**。需要一张本站签发、payload 里没有 `sub`、且 `tokens`
      //    集合里有记录的令牌；而签发侧是 `sub: user.id`，所以只有"用户文档缺 `id` 字段"才会签出
      //    这种令牌（`jsonwebtoken` 会省略值为 undefined 的声明）：恢复出字段不全的归档、手工改库、
      //    或历史上"两条 id:0"竞态的清理残留。真实性质是"**坏库 ⇒ 权限错乱**"，
      //    与上面那条"坏库 ⇒ 明确 401"是同一条路径上的姊妹缺陷。
      const sub = payload?.sub;
      if (typeof sub !== 'number' || !Number.isInteger(sub)) {
        throw new UnauthorizedException(
          '令牌缺少有效的用户标识（sub 不是整数）：站点数据可能已损坏，或该令牌由旧版本签发。请重新登录以获取新令牌',
        );
      }
      const user = await this.userProvider.getCollaboratorById(sub);
      if (!user) {
        // 协作者已被删除但 token 还在有效期内：以前这里会读 user.permissions 直接 500
        throw new UnauthorizedException('该协作者已不存在');
      }
      moreDto.permissions = user.permissions;
      moreDto.nickname = user.nickname;
    }
    // 🔴 2026-09-22：**权威身份字段必须在展开之后赋值**（此前是 `{ name, id, ...moreDto }`）。
    //    `moreDto` 来自 `{ ...payload }`，所以 payload 里若含 `id` 或 `name`，旧顺序会让它**覆盖**
    //    这两个权威值；而下游 `AccessGuard` 判超管认 `user.id === 0` 或字面字符串 `"0"`
    //    ⇒ **一张 payload 带 `id: 0` 的令牌就会被判成超管**。
    //    ⚠️ 已穷举核实**当前不可利用**：全仓只有两处真的签 JWT（`token.provider.ts:61` 的
    //    `{ sub, username, role }` 与 `:83` 的 `createToken`，其唯一调用方 `auth.provider.ts:33`
    //    传 `{ username, sub, type, nickname, permissions }`），**都不含 `id`/`name`** ⇒
    //    本次改动**行为逐字节不变**。修它是为了把"未来某条新签发路径放了 `id`"
    //    从**静默提权成超管**变成**不可能**（守卫见 `jwtStrategyIdentityFields.spec.ts`）。
    //    ⚠️ 协作者分支**故意**往 `moreDto` 里放的 `permissions` 与 `nickname` 不在下面两个
    //    权威字段里，所以**仍然照常生效**（有断言钉住）。
    return { ...moreDto, name: payload.username, id: payload.sub };
  }
}
