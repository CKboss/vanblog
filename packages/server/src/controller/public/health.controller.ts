import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { version } from 'src/utils/loadConfig';

/**
 * 健康检查端点：`GET /api/public/health`。
 *
 * 为什么要有它：编排文件里 mongo 一直有 healthcheck，而 **vanblog 服务没有** ——
 * 于是"容器还在跑"被当成了"服务还活着"，而这两件事差得很远（Node 事件循环卡死、
 * mongo 连不上、前台子进程挂了，容器都照样 Up）。有了这个端点，
 * `docker compose` 的 healthcheck / `depends_on: service_healthy` / 编排系统的重启策略
 * 才有依据，运维也能一条 curl 判断"到底是哪一层坏了"。
 *
 * 设计取舍：
 *  - **未初始化也返回 200**（payload 里带 `initialized:false`）。否则全新安装
 *    在走完向导之前会一直被判定为不健康，容器可能被反复重启。
 *    所以它也被加进了 `InitMiddleware` 的 exclude 列表。
 *  - **不能被缓存**（`Cache-Control: no-store`）：健康检查的意义就在于"此刻"，
 *    被 caddy/CDN 缓存住等于没有。
 *  - **mongo 探测要便宜且有缓存**：healthcheck 通常 30 秒一次，但别人也可以拿它打你。
 *    所以 `ping` 结果缓存 5 秒，且带 800ms 超时 —— 一次探测最多每 5 秒真的打到库一次。
 *  - **不用 `AdminGuard`**：这个端点不透露任何业务数据（只有状态、版本、运行时长），
 *    而 healthcheck 必须能在没有凭据的情况下跑。
 */
const MONGO_PROBE_CACHE_MS = 5000;
const MONGO_PROBE_TIMEOUT_MS = 800;

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
  async health(@Res({ passthrough: true }) res: Response) {
    const mongo = await this.probeMongo();
    const readyState = this.connection?.readyState;
    // ⚠️ mongo 探测不到就返回 **503**：镜像里的 HEALTHCHECK 判据是 `statusCode < 500`，
    // 所以"库连不上"必须体现在状态码上，否则健康检查永远是绿的、等于没有。
    // 未初始化**不影响**这里（那种情况仍然 200），全新安装才不会被误判成不健康。
    if (!mongo.up) {
      res.status(503);
    }
    return {
      statusCode: mongo.up ? 200 : 503,
      data: {
        status: mongo.up ? 'ok' : 'degraded',
        version,
        uptimeSeconds: Math.round(process.uptime()),
        // ping 的结果才是权威判据；readyState 只是给排障看的补充信息。
        // ⚠️ mongoose 的语义是 **0=disconnected、1=connected、2=connecting、3=disconnecting**
        // （第一版注释写反了，会把"1"当成断开 —— 这种注释比没有注释更糟）。
        mongo: mongo.up ? 'up' : 'down',
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
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        now: new Date().toISOString(),
      },
    };
  }
}
