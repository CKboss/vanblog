import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';

import { pathPermissionMap, permissionRoutes, publicRoutes } from 'src/types/access/access';

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
      if (user.id == 0) {
        // 超管为 0
        return true;
      } else {
        if (publicRoutes.includes(key)) {
          return true;
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
