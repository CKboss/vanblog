import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InitProvider } from '../init/init.provider';
import { normalizeRateLimitPath } from '../../utils/rateLimit';

@Injectable()
export class InitMiddleware implements NestMiddleware {
  constructor(private readonly initProvider: InitProvider) {}
  async use(req: Request, res: Response, next: NextFunction) {
    // 🔴 2026-09-22：比较前先归一化（此前是 `req.path == '/api/admin/init'`，
    //    **请求侧 + 大小写敏感 + 松散精确相等**）。Express 默认大小写不敏感且尾斜杠可选，
    //    所以 `/api/admin/init/`、`/API/admin/init` 都会被路由送到同一个处理器，
    //    却匹配不上这个字面量 ⇒ 走 `else` 分支。
    //    ⚠️ **这一处的失败方向与安全那四处相反**：不匹配 ⇒ **跳过豁免**（未初始化时返回 233 提示），
    //    而不是"跳过防护" ⇒ 🔴 **这不是安全洞，是内部一致性/可用性修复**。
    //    ⚠️ 现实可达性也已核实为低：第一方客户端发的 URL（`services/van-blog/api.js:91`、
    //    `InitPage/restoreCore.js:17`、`UrlFormItem/index.tsx:37`）**全部是精确小写、不带尾斜杠**。
    //    🔴 复用 `normalizeRateLimitPath` 而**不是**就地另写一份：它是中间件层唯一的路径归一化口径
    //    （`utils/requestId.ts` 也复用它），口径漂移正是本仓库反复吃亏的形状。
    //    ⚠️ **它刻意不解码百分号** —— 这一处的下游是 Express 路由，而路由用未解码的 `req.path`；
    //    解码会让判定比路由更宽。（🔴 口径取决于下游是谁：`staticGuard` 必须解码、
    //    本处与 `rateLimit` 必须不解码、`AccessGuard` 必须不小写化。）
    if (normalizeRateLimitPath(req.path) === '/api/admin/init') {
      next();
    } else {
      const hasInit = await this.initProvider.checkHasInited();
      if (hasInit) {
        next();
      } else {
        res.json({
          statusCode: 233,
          message: '未初始化!',
          data: {
            allowDomains: process.env.VAN_BLOG_ALLOW_DOMAINS || '',
          },
        });
      }
    }
  }
}
