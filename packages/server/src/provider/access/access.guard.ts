import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';

import {
  isSuperAdminOnlyRoute,
  isSuperAdminUser,
  pathPermissionMap,
  permissionRoutes,
  publicRoutes,
} from 'src/types/access/access';

@Injectable()
export class AccessGuard implements CanActivate {
  logger = new Logger(AccessGuard.name);
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    return await this.validateRequest(request);
  }
  async validateRequest(request: any) {
    try {
      const path = request.route.path;
      const method = Object.keys(request.route.methods)[0];
      const key = `${method}-${path}`;
      const user = request.user;
      // console.log(key, user);
      if (!user) {
        // 这个守卫只在 AdminGuard 链里跑（AuthGuard('jwt') → TokenGuard → AccessGuard），
        // 走到这里说明拿不到已认证用户，必须**拒绝**（以前是 return true，等于失败开门）。
        return false;
      }
      if (isSuperAdminUser(user)) {
        // 超管为 0。⚠️ 用 isSuperAdminUser() 而不是 `user.id == 0`：松散比较下
        // `'' == 0` 与 `[] == 0` 都成立，而 id 来自 jwt 的 `sub`（经过 JSON 往返）。
        return true;
      } else {
        if (publicRoutes.includes(key)) {
          return true;
        }
        // ⚠️ 凭据类 / 高危路由只认超管，**`'all'` 权限也不例外**。
        // 必须放在 publicRoutes 之后：`get-/api/admin/collaborator/list` 在 publicRoutes 里，
        // 协作者的后台要靠它渲染下拉框，而它正好落在 `/api/admin/collaborator` 前缀下。
        if (isSuperAdminOnlyRoute(path)) {
          // 以前这里是 `if (permissions.includes('all')) return true;` —— 后台那个
          // 「所有权限」勾选项因此等价于超管：能改管理员口令、能签超管 API Token、
          // 能下载含 jwt 密钥的整站备份、能通过流水线在容器里执行代码。
          // 详见 types/access/access.ts 里 SUPER_ADMIN_ONLY_ROUTE_PREFIXES 的逐条理由。
          this.logger.warn(
            `已拒绝：${key} 只允许超管（user.id === 0）访问，` +
              `当前身份是协作者（id=${user?.id}，权限=${JSON.stringify(user?.permissions ?? [])}）。` +
              `「所有权限」不再包含凭据、备份、流水线、协作者、系统设置与反代/证书这些高危能力。`,
          );
          return false;
        }
        // 其他都为协作者
        const { permissions } = user || {};
        if (!permissions || permissions.length == 0) {
          return false;
        } else {
          if (permissions.includes('all')) {
            return true;
          } else {
            // 看看是不是带权限的路由
            if (permissionRoutes.includes(key)) {
              const p = pathPermissionMap[key];

              return permissions.includes(p);
            } else {
              return false;
            }
          }
        }
      }
    } catch (err) {
      // 判定过程出错时也要关门：404 路由本来就不会命中任何控制器方法
      this.logger.warn(`权限判定异常，已拒绝：${err?.message || err}`);
      return false;
    }
  }
}
