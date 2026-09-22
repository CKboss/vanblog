import { Controller, Get, Header, Optional, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { version } from 'src/utils/loadConfig';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import cluster from 'node:cluster';
import type { WebsiteProvider } from 'src/provider/website/website.provider';

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
 * 🔴 前台存活字段（`website`）的宽限窗口。
 *
 * 为什么要有它：前台子进程在**正常运维中也会短暂消失** —— `restart()` 会 `stop()` 杀掉整个进程组再拉起
 * （保存站点信息、改 ISR 设置、恢复备份都会走这条路），期间 `ctx` 是 null；启动初期 `run()` 还没跑完时同样是 null。
 * 如果"`ctx` 为 null"就直接判 `down`，那么**每次保存站点信息都会让健康端点抖一下**，
 * 而任何把它接到告警或（将来的）状态码上的人都会看到假故障 —— 抖动比盲区更糟，因为它训练运维忽略告警。
 *
 * 60 秒的取值：`website.provider.ts` 的快速退避阶梯最长一档是 30 秒，而"稳定跑过 60 秒"正是它
 * 判定"这次不算崩溃循环"的既有门槛 ⇒ **与产品自己的语义对齐**，不另发明一个数字。
 *
 * ⚠️ 代价（如实写明）：前台**真的**永久坏死时，这个字段最长会先报 60 秒的 `starting` 才转 `down`。
 * 这是有意的取舍 —— 容器级探测（Dockerfile / compose 的 HEALTHCHECK）**本来就另外直接探 3001**，
 * 所以那 60 秒里容器层仍然看得见坏死；本字段补的是**外部监控与 k8s 单一 livenessProbe** 那两个盲区。
 */
const WEBSITE_ABSENT_GRACE_MS = 60 * 1000;

/**
 * 前台存活状态的取值与其含义。
 *
 * 🔴 **这个字段是公开的，不在 `detailsAllowed()` 门后** —— 与 uptime/内存不同：
 * 匿名攻击者本来就能直接打 `/` 看出前台是不是 502，health 端点告诉他这件事**没有增加任何能力**；
 * 而 uptime 与内存能推断**重启时机与负载**，那才是需要门的东西。
 * 把"前台是否存活"关进门后就等于没修 —— 容器 HEALTHCHECK 与 k8s livenessProbe 都是**匿名**打这个端点的。
 */
export type WebsiteHealth = 'up' | 'starting' | 'down' | 'disabled' | 'unknown';
/**
 * ⚠️ `disabled` 与 `unknown` 的区别（消费方必须分清，否则会误判）：
 *  - **`disabled`** = 这个站点**按设计**不由 server 拉起前台子进程（`VANBLOG_DISABLE_WEBSITE=true`）；
 *  - **`unknown`** = **本进程无从判断** —— 拿不到 `WebsiteProvider`，或本进程是 cluster 里的非 leader worker
 *    （前台子进程只由 leader spawn，其余 worker 的 `ctx` 永远是 null）。
 * 🔴 多 worker 部署下这个字段会**随请求落到哪个 worker 而在 `up` 与 `unknown` 之间变化**，
 * 这是诚实的（只有 leader 真的知道），消费方应当把 `unknown` 当作"没有信息"而不是"故障"。
 */

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
  /** 第一次观察到"前台子进程不在"的时刻；看到子进程就清空（见 `WEBSITE_ABSENT_GRACE_MS`）。 */
  private websiteAbsentSince: number | null = null;

  /**
   * ⚠️ **`@Optional()`**：拿不到 `WebsiteProvider` 时（例如单元测试直接 `new HealthController(conn)`）
   * 退化成 `'unknown'` 而不是抛错 —— 🔴 **健康端点绝不能因为一个新增字段而 500**，
   * 那会把"前台状态未知"放大成"整个站点不健康"。
   */
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly website?: WebsiteProvider,
  ) {}

  /**
   * 🔴 前台存活判据。**只读 `WebsiteProvider` 的公开字段 `ctx`**，不发任何网络请求。
   *
   * ⚠️ 为什么不去探 3001：那会在这个**匿名端点**上发起一次网络调用，而本文件的注释明写
   * "这个端点是匿名的，别人也能拿它打你" ⇒ 必须像 mongo 探测那样配超时+缓存+并发合并才安全。
   * 而 `WebsiteProvider` **本来就知道**子进程在不在（`ctx`），问它是零成本的，也没有新的放大面。
   *
   * ⚠️ 两个"按设计就没有前台"的情形必须与"前台坏了"区分开，否则会把正常部署报成故障：
   *   - `VANBLOG_DISABLE_WEBSITE=true`（无前台模式）；
   *   - **cluster worker**：子进程只由主实例 spawn（`website.provider.ts` 的 `doRun()` 里有
   *     `isPrimaryInstance` 早退，注释写明"每个 worker 都 spawn 一个 next 会抢 3001 端口"）
   *     ⇒ worker 上 `ctx` **永远**是 null。而健康端点可能由任意 worker 应答，
   *     所以 worker 必须报 `disabled`（"不由本进程拥有"）而**不是** `down` —— 否则多 worker 部署下
   *     这个字段会随"哪次请求落到哪个 worker"而抖动，比盲区更糟。
   */
  private websiteState(now: number = Date.now()): WebsiteHealth {
    if (String(process.env['VANBLOG_DISABLE_WEBSITE'] || '') === 'true') {
      return 'disabled';
    }
    if (!isPrimaryInstance(cluster)) {
      // 🔴 **必须是 `unknown` 而不是 `disabled`**：这两件事在语义上完全不同，混在一起会让外部监控误判。
      //    - `disabled` = "**这个站点按设计就没有前台子进程**"（`VANBLOG_DISABLE_WEBSITE=true`，
      //      例如前后端分离部署、或 dev 环境里前台由 `next dev` 单独跑）；
      //    - `unknown` = "**本进程无从判断**"。
      //    而 `isPrimaryInstance()` 靠的是 `VANBLOG_CLUSTER_ROLE`（不是 `cluster.isPrimary`，
      //    原因见 `utils/clusterRole.ts` 的长注释：集群模式下主进程里没有 Nest 应用，
      //    所以 `cluster.isPrimary` 在所有 Nest 进程里都是 false）⇒ 集群里**恰好一个 worker 是 leader**、
      //    只有它 spawn 前台子进程，其余 worker 的 `ctx` **永远**是 null。
      //    🔴 如果 worker 报 `disabled`，那么"请求落到哪个 worker"就会决定监控看到
      //    "站点没有前台"还是"前台正常" ⇒ 这是**假信号**，比盲区更糟（它会训练运维忽略这个字段）。
      //    报 `unknown` 才是诚实的：它明确告诉消费方"换一个进程问，或者去看容器层那个直接探 3001 的 HEALTHCHECK"。
      return 'unknown';
    }
    const ctx = (this.website as any)?.ctx ?? null;
    if (!this.website) {
      return 'unknown';
    }
    if (ctx) {
      this.websiteAbsentSince = null;
      return 'up';
    }
    if (this.websiteAbsentSince === null) {
      this.websiteAbsentSince = now;
    }
    if (now - this.websiteAbsentSince < WEBSITE_ABSENT_GRACE_MS) {
      return 'starting';
    }
    return 'down';
  }

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
        // 🔴 **公开字段**（不在 detailed 门后，理由见 `WebsiteHealth` 的注释）：
        //    此前本端点对前台渲染进程**零感知**（判定只有 `mongo.up ? 'ok' : 'degraded'`）⇒
        //    前台永久坏死时，用它做监控的外部系统一直看到 `ok`，而 k8s 的 livenessProbe
        //    一个容器只能有一个 ⇒ 它探的就是这个端点 ⇒ **pod 永远不会被重启，用户只看到 502**。
        //    容器层的 HEALTHCHECK 早就另外直接探 3001 了，所以这补的是**外部监控与 k8s** 那两个盲区。
        // ⚠️ `status` 与 `statusCode` **刻意不变**（仍然只反映 mongo）：把它们也改成反映前台是
        //    **破坏性变更**，而现有消费方会产生**错误输出**而不只是不同的输出 ——
        //    `vanblog.sh doctor` 把 503 硬编码解读成"server 活着但 **mongo 连不上**"并建议
        //    `restore --offline-full`（前台坏死时这是错误诊断，会把人引去恢复备份）；
        //    `vanblog-drill.sh` 用 `code == 200` 当"服务就绪"判据（前台比 mongo 起得慢时演练会等到超时并记 fail）；
        //    `main.ts` 的启动就绪注释明写"判据与 /api/public/health 完全一致"。
        //    那三处都不在本轮改动范围内 ⇒ 先只加字段，状态码的变更要与它们同一次做。
        website: this.websiteState(),
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
