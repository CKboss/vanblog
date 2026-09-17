import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { version } from 'src/utils/loadConfig';

/**
 * 健康检查端点：`GET /api/public/health`。
 *
 * 为什么要有它：编排文件里 mongo 一直有 healthcheck，而 **vanblog 服务没有** ——
 * 于是"容器还在跑"被当成了"服务还活着"，而这两件事差得很远（Node 事件循环卡死、
 * mongo 连不上、前台子进程挂了，容器都照样 Up）。镜像里原来的 HEALTHCHECK 打的是 `/`、
 * 判据是 `statusCode < 500` ⇒ 前台 404、API 全挂、连不上库都算健康。
 * 有了这个端点，`docker compose` 的 healthcheck / `depends_on: service_healthy` /
 * 编排系统的重启策略才有依据，运维也能一条 curl 判断"到底是哪一层坏了"。
 *
 * 设计取舍：
 *  - **未初始化也返回 200**：否则全新安装在走完向导之前会一直被判定为不健康、
 *    可能被反复重启。所以它也被加进了 `InitMiddleware` 的 exclude 列表。
 *    （"是否已初始化"不在这里表达 —— `/api/public/meta` 的 233 信封已经是那个信号。）
 *  - **不能被缓存**（`Cache-Control: no-store`）：健康检查的意义就在于"此刻"，被缓存住等于没有。
 *  - **mongo 探测便宜**：`ping` 带 800ms 超时、结果缓存 5 秒、并发探测合并成一个 ——
 *    healthcheck 通常 30 秒一次，但这个端点是匿名的，别人也能拿它打你。
 *  - **不用 `AdminGuard`**：healthcheck 必须能在没有凭据的情况下跑。
 *  - **mongo ping 不通时返回 503**，这样镜像 HEALTHCHECK 那句 `statusCode < 500` 才有意义。
 *  - ⚠️ **uptime 与内存默认不给匿名调用者**（见 `detailsAllowed`）：它们能推断重启时机与负载。
 *    **版本号则是公开的、不算秘密** —— 它已经渲染在每个前台页面的页脚上，也从 `/api/public/meta`
 *    下发；只在健康端点藏它属于安全表演（第四轮审计的原话），攻击者从页脚就能读到 commit。
 */
const MONGO_PROBE_CACHE_MS = 5000;
const MONGO_PROBE_TIMEOUT_MS = 800;

/**
 * 详细字段（版本 / uptime / 内存）是否可见。
 *
 * ⚠️ **这里故意不用 `utils/rateLimit.ts` 的 `isInternalRequest()`**：那个函数对**回环请求直接返回 true**，
 * 而一体式部署里 caddy 就是从 `127.0.0.1` 拨到 `127.0.0.1:3000` 的 ⇒ 用它当门等于对**每个匿名访客**敞开，
 * 正是限流那一轮踩过的同一个坑（AGENTS §7.55 F）。所以这里只认两件事：
 *   1. 带了正确的 `x-vanblog-internal` 令牌（前后端分离部署用的那个，常量时间比较）；
 *   2. 或者站长显式打开 `VANBLOG_HEALTH_DETAILS=true`（"我就要公开这些信息"）。
 * 默认两者都不满足 ⇒ 匿名调用者只看到状态与 mongo 连通性。
 */
export function detailsAllowed(req: any, env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.VANBLOG_HEALTH_DETAILS || '') === 'true') {
    return true;
  }
  const expected = String(env.VAN_BLOG_INTERNAL_TOKEN || '');
  if (!expected) {
    return false;
  }
  const given = String(req?.headers?.['x-vanblog-internal'] || '');
  if (!given || given.length !== expected.length) {
    return false;
  }
  // 常量时间比较：`===` 会按字节短路，理论上能被计时侧信道逐字猜出来
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

@Controller('api/public')
@ApiTags('PublicHealth')
export class HealthController {
  private mongoCache: { at: number; up: boolean; ms: number } | null = null;
  private mongoProbing: Promise<{ up: boolean; ms: number }> | null = null;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private async probeMongo(): Promise<{ up: boolean; ms: number }> {
    const now = Date.now();
    if (this.mongoCache && now - this.mongoCache.at < MONGO_PROBE_CACHE_MS) {
      return { up: this.mongoCache.up, ms: this.mongoCache.ms };
    }
    // 并发探测合并成一个：healthcheck 与人工 curl 同时打过来时不要各查一次库
    if (!this.mongoProbing) {
      const started = Date.now();
      this.mongoProbing = Promise.race([
        this.connection.db?.admin().ping().then(
          () => ({ up: true, ms: Date.now() - started }),
          () => ({ up: false, ms: Date.now() - started }),
        ) ?? Promise.resolve({ up: false, ms: 0 }),
        new Promise<{ up: boolean; ms: number }>((resolve) =>
          setTimeout(() => resolve({ up: false, ms: Date.now() - started }), MONGO_PROBE_TIMEOUT_MS),
        ),
      ])
        .then((r) => {
          this.mongoCache = { at: Date.now(), ...r };
          return r;
        })
        .finally(() => {
          this.mongoProbing = null;
        });
    }
    return this.mongoProbing;
  }

  @Get('/health')
  @Header('Cache-Control', 'no-store')
  async health(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const mongo = await this.probeMongo();
    const readyState = this.connection?.readyState;
    if (!mongo.up) {
      res.status(503);
    }
    const detailed = detailsAllowed(req);
    return {
      statusCode: mongo.up ? 200 : 503,
      data: {
        // 这几个是健康检查与 `vanblog.sh drill` 真正要读的，且不标识版本/容量 ⇒ 保持公开
        status: mongo.up ? 'ok' : 'degraded',
        mongo: mongo.up ? 'up' : 'down',
        // ⚠️ mongoose 的语义是 **0=disconnected、1=connected、2=connecting、3=disconnecting**
        // （第一版注释写反了，会把 1 当成断开 —— 错误的注释比没有注释更糟）。
        // 所以除了数字还多给一个 mongoStateText，别让运维去背数字含义。
        mongoState: readyState,
        mongoStateText:
          readyState === 1
            ? 'connected'
            : readyState === 2
              ? 'connecting'
              : readyState === 3
                ? 'disconnecting'
                : 'disconnected',
        mongoPingMs: mongo.ms,
        now: new Date().toISOString(),
        // ⚠️ **版本号是公开的，不算秘密**（站长决定）：它已经渲染在每个前台页面的页脚上，
        // 也从 /api/public/meta 下发 —— 只在健康端点藏它属于安全表演，攻击者从页脚就能读到 commit。
        // 真正不该公开的是 uptime 与内存（那两项不在页脚上，能推断重启时机与负载），仍只在 detailed 时出现。
        version,
        // 下面这些只在带内部令牌或显式开了 VANBLOG_HEALTH_DETAILS 时出现
        ...(detailed
          ? {
              uptimeSeconds: Math.round(process.uptime()),
              memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
              heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              details: true,
            }
          : {}),
      },
    };
  }
}
