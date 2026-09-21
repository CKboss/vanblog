import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';

import {
  bootstrapRoutes,
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
        // ① 引导层：**零权限协作者也必须能调**的极小集（协作者下拉框、后台外壳的 meta、login/logout）。
        // ⚠️ 必须排在下面那张高危前缀表**之前**：`get-/api/admin/collaborator/list` 落在
        //    `/api/admin/collaborator` 前缀下，而后台的协作者下拉框靠它。
        // 🔴 这一层刻意做到极小（4 条）：往这里加键 = 给零权限协作者开能力，见 access.ts 的逐条理由。
        if (bootstrapRoutes.includes(key)) {
          return true;
        }
        // ⚠️ 凭据类 / 高危路由只认超管，**`'all'` 权限也不例外**。
        // 必须放在**引导层**之后（理由见上）。
        // 🔴 2026-09-22：免权限档 `publicRoutes` 已从这里移到下面 `permissions.length == 0` 那道拒绝**之后**
        //    —— 以前它排在这张表之前、也排在那道拒绝之前，于是**零权限协作者能命中全部 24 条**，
        //    包括能读到全站正文的 `get-/api/admin/article/:id` 与能一次打包带走正文+图片的
        //    `post-/api/admin/export/markdown`。免权限档那 20 条**没有一条**落在高危前缀下（已逐条核实），
        //    所以把它移到这张表之后既安全又更保守。
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
        // 🔴 2026-09-22 顺带修掉一个 fail-open：原来是 `!permissions || permissions.length == 0`，
        //    而**字符串也有 `.length` 也有 `.includes`** ⇒ `permissions: 'all'` 会一路走到下面的
        //    `permissions.includes('all')` 并**放行**（实测确认）。守卫是安全边界，不该依赖上游归一化：
        //    `pickPermissions` 只在**写入**时收口成数组，而 `jwt.strategy.ts` 是把库里的
        //    `user.permissions` **原样**塞进 user 的，历史数据的形状并不保证（该文件注释记载过
        //    DTO 单复数与 schema 字段名写错的历史 bug）。⇒ 改成显式 `Array.isArray`，"看不懂就关门"。
        if (!Array.isArray(permissions) || permissions.length == 0) {
          // 🔴 协作者功能首版 `ebc85431` 的原始契约："没勾权限就什么都不能干"。
          //    免权限档以前排在这一句**之前**，所以这道门形同虚设 —— 现在它真的关上了。
          return false;
        } else {
          // ② 免权限档：只读列表、图片/附件上传、导出、回收站与历史版本等。
          // 🔴 走到这里说明**至少勾了一项权限**，所以这一档对"有权限的协作者"行为与改前逐条相同（零回归）。
          if (publicRoutes.includes(key)) {
            return true;
          }
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
