import { NestFactory } from '@nestjs/core';
import {
  backupFirstSegmentUnderStatic,
  isGuardedStaticPath,
} from 'src/utils/staticGuard';
import { envInt, rateLimitMiddleware, securityHeadersMiddleware } from './utils/rateLimit';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { MetaProvider } from './provider/meta/meta.provider';

import { NestExpressApplication } from '@nestjs/platform-express';
import { config as globalConfig } from './config/index';
import { checkOrCreate } from './utils/checkFolder';
import * as path from 'path';
import { ISRProvider } from './provider/isr/isr.provider';
import { WalineProvider } from './provider/waline/waline.provider';
import { InitProvider } from './provider/init/init.provider';
import { json } from 'express';
import { UserProvider } from './provider/user/user.provider';
import { SettingProvider } from './provider/setting/setting.provider';
import { WebsiteProvider } from './provider/website/website.provider';
import { initJwt } from './utils/initJwt';
import { ViewStatsProvider } from './provider/stats/viewStats.provider';
import { MigrationKind, MigrationProvider } from './provider/migration/migration.provider';
import { ArticleProvider } from './provider/article/article.provider';
import cluster from 'node:cluster';
import os from 'node:os';
import { isPrimaryInstance, resolveClusterWorkers, CLUSTER_ENV } from './utils/clusterRole';
import { startClusterPrimary } from './utils/clusterBootstrap';
import { DEFAULT_SERVER_PORT, getListenTarget } from './utils/listenHost';
import { sanitizeRequestPayloads, SanitizeBodyPipe } from './utils/sanitizeRequest';
import {
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT_LARGE,
  LARGE_JSON_BODY_PREFIXES,
  resolveBodyLimit,
} from './utils/bodyLimit';
import { applyStaticAssetHeaders } from './utils/imgCompress';
import { ATTACHMENT_FOLDER } from './utils/attachment';
import { THUMB_FOLDER } from './types/setting.dto';

/**
 * `uncaughtException` 的退出硬上限（毫秒）。见 bootstrap() 里那条处理器的注释。
 */
const FATAL_EXIT_HARD_LIMIT_MS = 3000;

/**
 * 致命退出前的清理钩子。
 *
 * ⚠️ 为什么要用一个可变的模块级钩子，而不是直接在处理器里调 `gracefulShutdown`：
 * `uncaughtException` 的注册发生在 bootstrap() 的**最前面**（越早注册越好，否则启动阶段的
 * 异常没人接），而 `gracefulShutdown` 是后面才定义的 `const` 箭头函数 —— 在那之前引用它会踩 TDZ。
 * 钩子在 `gracefulShutdown` 定义好之后赋值；如果异常发生在赋值之前（启动阶段），
 * 处理器就走"没有钩子"的分支，直接 exit(1) —— 那时候也还没有浏览统计需要 flush。
 */
let fatalShutdownHook: ((reason: string) => Promise<void>) | null = null;

async function bootstrap() {
  const jwtSecret = await initJwt();
  global.jwtSecret = jwtSecret;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Node 20 默认「有未处理的 rejection 就退出进程」。这个项目里有不少
  // fire-and-forget 的写库调用（每次页面浏览的计数、菜单清洗、sitemap 生成…），
  // 一次 Mongo 抖动就能把整个 server 带走，而且日志里什么线索都没有。
  // 这里兜底记录，不让单个漏掉的 catch 变成宕机。
  process.on('unhandledRejection', (reason: any) => {
    // eslint-disable-next-line no-console
    console.error(
      `[unhandledRejection] ${reason?.stack || reason?.message || JSON.stringify(reason)}`,
    );
  });
  // ⚠️ uncaughtException 必须**退出**（非 0），不能只记日志。
  //
  // 以前这里只 `console.error`，理由是"别让单个漏掉的 catch 变成宕机"。那个理由对
  // `unhandledRejection` 成立（这个仓库确实有大量 fire-and-forget 写库，一次 Mongo 抖动
  // 不该带走整个 server），但对 `uncaughtException` **不成立**：Node 官方文档明确说
  // 此时进程处于未定义状态，继续跑是不安全的。
  //
  // 更实际的是它把 `scripts/start.js` 刚修掉的那个事故又放回来了：start.js 的重写目的
  // 正是"子进程退出 ⇒ 容器退出 ⇒ restart 策略介入"（见它的头注释与 :88-99），
  // 而只记不退意味着容器一直 Up、健康检查一直 200、`restart: always` 永不触发，
  // 站点却可能已经半死 —— 日志里只有一行没有上下文的 uncaughtException。
  // 本轮就有一个真实来源：备份的 NDJSON 写流缺 error 监听，ENOSPC 时错误正是以
  // "EventEmitter 'error' 无监听者"的形式落到这里（那条已单独修好）。
  //
  // cluster 模式下退出同样是**正确**行为，不会与主进程的重启逻辑打架：
  // worker 退出 → 主进程按 `utils/clusterBootstrap.ts` 的崩溃窗口计数重拉；
  // 短时间内崩太多次（maxFastCrashes）→ 主进程自己 exit(1) → 容器重启。
  // 也就是说"坏掉的 worker 被换掉"正是那套逻辑设计出来要做的事；
  // 继续带着未定义状态服务请求才是与它冲突的那个选择。
  process.on('uncaughtException', (error: Error) => {
    // eslint-disable-next-line no-console
    console.error(
      `[FATAL][uncaughtException] ${error?.stack || error?.message || error}\n` +
        `进程将退出（非 0）以便容器重启策略接管：出现未捕获异常后进程状态已不可信，继续服务请求不安全。`,
    );
    // 硬上限：优雅退出自己也可能挂住（例如 flush 卡在已经坏掉的 Mongo 连接上），
    // 到点直接 exit(1)。3 秒是"够 flush 一次浏览统计、又不会让容器等太久"的折中；
    // 与 `VAN_BLOG_SHUTDOWN_TIMEOUT_MS`（默认 8000，由 scripts/start.js:38 读取）同类的取舍，但这里要更短 ——
  // ⚠️ 别把它与 cluster 主进程等 worker 的宽限期搞混：那是 utils/clusterBootstrap.ts 的
  //    `hooks.shutdownTimeoutMs ?? 10000`，**没有**对应环境变量。两者是不同层的超时：
  //    start.js 等的是容器里的子进程，cluster 主进程等的是 worker 进程。
  //    （这里以前把变量名写成 VANBLOG_SHUTDOWN_TIMEOUT_MS，漏了 VAN_ 前缀 —— 有个代理照着这个
  //    错拼写去 grep，得出「该变量不存在」的结论并写进了文档。**错拼写的注释会繁殖。**）
    // 已经是异常状态了，不值得等满正常停机的宽限。
    const hardExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('[FATAL] 优雅退出超时，强制 exit(1)');
      process.exit(1);
    }, FATAL_EXIT_HARD_LIMIT_MS);
    Promise.resolve()
      .then(() => (fatalShutdownHook ? fatalShutdownHook('uncaughtException') : undefined))
      .catch((err: any) => {
        // eslint-disable-next-line no-console
        console.error(`[FATAL] 退出前的清理失败：${err?.message || err}`);
      })
      .then(() => {
        clearTimeout(hardExit);
        process.exit(1);
      });
  });

  // JSON body 限额：全局默认只有 1mb（登录/评论/访客计数这些匿名接口不再敞着 50MB），
  // 只有后台的"内容类"前缀（文章/草稿/自定义页面/管线，全部在 AdminGuard 后面）
  // 单独挂 50mb 的解析器。multipart 上传（图片/附件/备份恢复/JSON 导入）不经过
  // express.json，限额在 utils/uploadLimits.ts。细节与环境变量见 utils/bodyLimit.ts。
  const jsonLimit = resolveBodyLimit(process.env.VANBLOG_JSON_BODY_LIMIT, DEFAULT_JSON_BODY_LIMIT);
  const jsonLimitLarge = resolveBodyLimit(
    process.env.VANBLOG_JSON_BODY_LIMIT_LARGE,
    DEFAULT_JSON_BODY_LIMIT_LARGE,
  );
  const largeJsonParser = json({ limit: jsonLimitLarge });
  for (const prefix of LARGE_JSON_BODY_PREFIXES) {
    app.use(prefix, largeJsonParser);
  }
  // 已经解析过的 body（req._body=true）会被 body-parser 直接跳过：每个请求最多解析一次
  app.use(json({ limit: jsonLimit }));

  // 所有路由之前先净化 query/params/body：删掉 `$` 开头的 Mongo 操作符键与原型污染键，
  // 否则公开接口上 `?category[$ne]=x` 这类查询对象会被直接塞进 Mongo 过滤器。
  app.use(sanitizeRequestPayloads);
  // ⚠️ 上面那趟中间件**够不着 multipart 的文本字段**：multer 是方法级拦截器
  // （`@UseInterceptors(FileInterceptor('file'))`），它在中间件之后才把表单字段写进 req.body。
  // 全局管道跑在拦截器之后、处理器之前（Nest 顺序：中间件 → 守卫 → 拦截器前置 → 管道 → 处理器），
  // 是唯一能统一兜住这一半的位置。对已净化的 JSON body 再跑一遍是幂等的。
  // 覆盖面与残留缺口（`@Request()` 直接读 req.body 的写法）见 utils/sanitizeRequest.ts 的
  // SanitizeBodyPipe 注释，并有 sanitizeRequest.multipart.spec.ts 的源码级守卫钉着。
  app.useGlobalPipes(new SanitizeBodyPipe());

  // 整站备份里含数据库内容（密码哈希、jwt 密钥等），不能像图片那样匿名可下载。
  // 备份默认放在 staticPath 之外（config.backupPath），这里是兜底：万一被配到静态目录里，
  // 或者旧版本留在 <static>/export/backups/ 下的归档，都不给匿名访问；下载走鉴权接口。
  // ⚠️ 判定必须走 `utils/staticGuard`：`req.path` 是**未解码、未归一化**的原始路径，
  // 而 serve-static 在打开文件前会解码并归一化 —— 直接用 startsWith 比较字面前缀，
  // 会被 `%65xport`、`export%2f`、`./export`、`//export`、`%2e/export` 等写法绕过，
  // 实测能匿名拿到 `<static>/export/` 里的旧导出归档，以及 `<static>/tmp/` 里
  // 整站恢复的暂存 NDJSON（含密码哈希与 jwt 密钥）。详见 staticGuard.ts 的注释。
  const backupSegment = backupFirstSegmentUnderStatic(
    globalConfig.staticPath,
    globalConfig.backupPath,
  );
  app.use((req, res, next) => {
    if (
      // 导出归档（图片/附件/JSON）以前都在 <static>/export/，匿名可读且文件名只有日期，
      // 现在搬到 backupPath 下并改成鉴权下载；这条是旧文件的兜底。
      // tmp / upload-tmp 是上传与导出/恢复的临时目录，里面可能就是整站备份。
      isGuardedStaticPath(req.path, backupSegment)
    ) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          statusCode: 403,
          message: '整站备份只能通过后台的鉴权接口下载（/api/admin/backup/full/download）',
        }),
      );
      return;
    }
    next();
  });

  // ⚠️⚠️ 这一段必须留在 `useStaticAssets` / `SwaggerModule.setup` **之前**。
  //
  // 原因（第四轮审计实测出来的，不是推理）：`useStaticAssets()` 与 `SwaggerModule.setup()`
  // 都在 `app.listen()` 之前调用，而 Nest 只在 `init()`（由 `listen()` 触发）里才安装
  // `app.module.ts` 的那串中间件（request-id → securityHeaders+rateLimit → no-store → init）。
  // 所以真实的 Express 栈顺序是：
  //   [json][sanitize][static403][express.static /static][/rss][/sitemap][swagger] … [request-id][securityHeaders][rateLimit][no-store][init][router]
  // 静态与 swagger 的响应在限流器**之前**就结束了 ⇒
  //   1) `rateLimit.ts` 里那个 `rl-static-<ip>` 桶（`VANBLOG_STATIC_LIMIT_PER_MIN`，默认 6000/分钟）
  //      **永远执行不到，是死代码**；
  //   2) `/static/**`（除 `/static/img/*.{webp,png,…}` 由 caddy 直服外，附件/主题/自定义页面都反代到 Node）
  //      **完全没有限流**，而镜像里的 caddy 2.11.4 又没有任何限流模块 ⇒ 这是本机最便宜的带宽耗尽向量；
  //   3) `/swagger` 与 `/swagger-json`（59.3 KB）也没有限流；
  //   4) 静态与 swagger 的响应都拿不到 X-Frame-Options / Referrer-Policy / Permissions-Policy / nosniff。
  //
  // 实测（一次性实例，把三档限流都设成 5，每个请求都带 X-Forwarded-For 以避开回环豁免）：
  //   12 × /api/public/meta      → 200 200 200 200 200 429 429 …   （Nest 路由确实被限）
  //   12 × /static/img/probe.txt → 200 × 12                        （静态完全不受限）
  //   12 × /swagger-json         → 200 × 12
  //   12 × /robots.txt           → 429 × 12                        （同一个全局桶已满）
  //
  // ⚠️ 不会重复计数：这些路径根本到不了 Nest 那份中间件（响应在这里就结束了）。
  // ⚠️ 也不影响 SSR/ISR/waline 的内部回环请求：它们从回环来且不带转发头，
  //    `isLoopbackRequest` 会整档豁免（这是有意的，否则前台渲染会自己把自己限流）。
  const PRE_NEST_LIMITED_PREFIXES = ['/static/', '/rss/', '/sitemap/', '/swagger'];
  const matchesPreNestPrefix = (rawPath: string): boolean => {
    // 与 staticGuard 同样的口径：原始路径可能是百分号编码的，解码后再比一次，
    // 免得有人用 `%2Fstatic%2F…` 之类的写法从限流器旁边溜过去（静态层是会解码的）。
    const candidates = [rawPath];
    try {
      const decoded = decodeURIComponent(rawPath);
      if (decoded !== rawPath) {
        candidates.push(decoded);
      }
    } catch {
      // 解不开就只按字面判定
    }
    return candidates.some((p) => PRE_NEST_LIMITED_PREFIXES.some((prefix) => p.startsWith(prefix)));
  };
  app.disable('x-powered-by'); // 少送一个指纹；Express 默认在每个响应上带 X-Powered-By
  app.use((req, res, next) => {
    if (!matchesPreNestPrefix(req.path)) {
      return next();
    }
    securityHeadersMiddleware(req, res, () => rateLimitMiddleware(req, res, next));
  });

  app.useStaticAssets(globalConfig.staticPath, {
    prefix: '/static/',
    setHeaders: applyStaticAssetHeaders,
  });

  // 查看文件夹是否存在 并创建.
  checkOrCreate(globalConfig.codeRunnerPath);
  checkOrCreate(globalConfig.staticPath);
  checkOrCreate(path.join(globalConfig.staticPath, 'img'));
  // 图片管理列表用的缩略图
  checkOrCreate(path.join(globalConfig.staticPath, 'img', THUMB_FOLDER));
  // 附件管理（任意文件）
  checkOrCreate(path.join(globalConfig.staticPath, ATTACHMENT_FOLDER));
  checkOrCreate(path.join(globalConfig.staticPath, 'tmp'));
  checkOrCreate(path.join(globalConfig.staticPath, 'export'));

  // 自定义页面
  checkOrCreate(path.join(globalConfig.staticPath, 'customPage'));

  // rss
  checkOrCreate(path.join(globalConfig.staticPath, 'rss'));
  app.useStaticAssets(path.join(globalConfig.staticPath, 'rss'), {
    prefix: '/rss/',
  });

  // sitemap
  checkOrCreate(path.join(globalConfig.staticPath, 'sitemap'));
  app.useStaticAssets(path.join(globalConfig.staticPath, 'sitemap'), {
    prefix: '/sitemap/',
  });

  const config = new DocumentBuilder()
    .setTitle('VanBlog API Reference')
    .setDescription('API Token 请在后台设置页面获取，请添加到请求头的 token 字段中进行鉴权。')
    .setVersion('1.0')
    .build();
  // Swagger 默认仍然开着（保持既有行为），但它等于把整个后台 API 面摊给未登录用户，
  // ⚠️ **默认关**（站长决定）。以前默认开，理由是后台「关于」与「Token」两个页面深链到 /swagger；
  // 那两处已改成指向仓库里的 API 文档并说明如何打开实时 swagger，所以那个理由不成立了。
  // 关掉的收益：少一个匿名可达、且此前**完全不受限流**的 59KB 响应（第四轮审计 B1），
  // 也少一份把全部后台路由与登录接口请求形状直接摊给扫描器的地图。
  // ⚠️ 这里以前写着具体条数（111），而实际是 149 条挂 AdminGuard 的路由方法
  //    （35 个 controller 文件 / 180 个路由方法，2026-09-18 逐个装饰器数出来的）。
  //    条数每加一个接口就变，写在这里只会腐 ⇒ 不写数字。要现数：
  //    grep -rc "@\\(Get\\|Post\\|Put\\|Patch\\|Delete\\)" packages/server/src/controller/
  // 需要时显式打开：VANBLOG_SWAGGER=true（只认字面 true，打错的值不会静默打开）。
  if (process.env.VANBLOG_SWAGGER === 'true') {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('swagger', app, document);
  }
  const { port, host } = getListenTarget(DEFAULT_SERVER_PORT, globalConfig.serverHost);
  // ⚠️ **必须显式传 backlog**：Node 的默认值只有 **511**，而 caddy 反代到 Node 时是
  //    "一个并发请求一条上游连接"（模板里 `max_idle_conns_per_host` 只有 32，空闲池留不住
  //    那么多连接），于是瞬时高并发下 SYN 队列直接溢出、SYN 被内核丢弃，caddy 侧表现为
  //    `dial tcp 127.0.0.1:3000: i/o timeout` → **502**。
  //    实测（2026-09-20，C10K：先建 10000 条连接保持，再同时发 `/api/public/meta`）：
  //      改前 200=6437 / **502=3563**，且容器 netns 的 `TcpExtListenOverflows` = **3745**
  //      （与 502 数量吻合）；同一次压测里 caddy **直服**的静态图片是 10000/10000 全 200
  //      ⇒ 瓶颈不在 TCP accept 能力或 fd（容器内 `Max open files` 是 1048576），
  //         而在 Node 这一层的 accept 队列深度。
  //    内核会把实际 backlog 夹到 `min(backlog, net.core.somaxconn)`（本机 4096），所以
  //    想要更深还要同时抬 somaxconn —— 这点写进文档，不要在代码里假装能超过内核上限。
  const listenBacklog = envInt('VANBLOG_LISTEN_BACKLOG', 4096, 1, 65535);
  // Nest 的 `.d.ts` 只声明了 `listen(port)` 与 `listen(port, hostname)`，但实现是
  // `listen(port, ...args)` 透传到 `httpAdapter.listen(port, ...args, cb)` ⇒ 运行时支持
  // backlog（Express → `http.Server.listen(port, host, backlog, cb)`）。这里用局部类型断言，
  // 而不是绕过 Nest 直接 `getHttpServer().listen()`：后者会丢掉 Nest 的 init/flushLogs/错误处理。
  const listenWithBacklog = app.listen as unknown as (
    port: number | string,
    host: string | undefined,
    backlog: number,
  ) => Promise<unknown>;
  await listenWithBacklog(port, host, listenBacklog);

  // ⚠️ 上游 keep-alive 的超时**必须长于反代的空闲超时**，否则会出现经典的竞态：
  // caddy 把一条空闲连接留在池里（本仓库的模板配的是 60s），而 Node 默认
  // `keepAliveTimeout` 只有 **5 秒** —— 5 秒后 Node 主动关连接，caddy 却可能刚好
  // 在这一刻把请求写上去，结果就是偶发的 ECONNRESET / 502，而且只在"流量有间歇"时出现，
  // 极难复现。这里设成 65s（比 caddy 的 60s 长），headersTimeout 再大 1s
  // （Node 要求 headersTimeout > keepAliveTimeout，否则慢客户端能占着连接不放）。
  const keepAliveTimeout = envInt('VANBLOG_KEEP_ALIVE_TIMEOUT_MS', 65000, 1000, 600000);
  const httpServer = app.getHttpServer();
  if (httpServer) {
    httpServer.keepAliveTimeout = keepAliveTimeout;
    httpServer.headersTimeout = keepAliveTimeout + 1000;
    // Node 18+ 的默认值是 300s；显式写出来，免得哪天默认值变了没人注意
    httpServer.requestTimeout = envInt('VANBLOG_REQUEST_TIMEOUT_MS', 300000, 5000, 3600000);
  }

  const websiteProvider = app.get(WebsiteProvider);

  websiteProvider.init();

  const initProvider = app.get(InitProvider);
  const walineProvider = app.get(WalineProvider);
  // ⚠️ 多进程（VANBLOG_CLUSTER_WORKERS>1）时，下面这些**只能跑一次**的东西必须由主实例来做：
  // 写版本号、生成 restore.key、各种数据清洗、拉起 waline 子进程、触发首轮 ISR/RSS/sitemap。
  // 单进程时 `cluster.isPrimary === true`，这个判断永远为真，行为与以前完全一致。
  const primary = isPrimaryInstance(cluster);
  if (primary) {
    initProvider.initVersion();
    initProvider.initRestoreKey();
  }
  if (await initProvider.checkHasInited()) {
    if (!primary) {
      console.log('cluster worker：跳过启动期的数据清洗与子进程拉起（由主实例负责）');
    }
    // 迁移台账（migrations 集合）：每次启动清洗都记一条 {key,kind,ranAt,durationMs,outcome,detail}，
    // 让"这个实例对数据做过什么修复"可查（后台 GET /api/admin/migration/list）。
    // ⚠️ 台账只是**可观测性**：幂等清洗与索引维护照旧每次启动都跑，绝不按台账跳过。
    // ⚠️ app.get 用 try/catch：MigrationProvider 还没注册进 app.module 的过渡期里，
    //    清洗照跑、只是不记账，绝不能让启动本身挂掉。
    let migrations: MigrationProvider | undefined;
    try {
      migrations = app.get(MigrationProvider);
    } catch {
      migrations = undefined;
    }
    /** 台账在就包一层 run()（计时+记账），不在就原样跑；错误语义与今天完全一致（原样上抛）。 */
    const wash = <T>(
      key: string,
      kind: MigrationKind,
      task: () => Promise<T>,
      detail?: (result: T) => unknown,
    ): Promise<T> => {
      if (migrations) {
        return migrations.run({ key, kind }, task, detail ? { detail } : undefined);
      }
      return task();
    };
    // 新版本自动启动图床压缩功能
    if (primary)
      await wash('wash:staticSetting', 'wash', () => initProvider.washStaticSetting(), (r) => r);
    // 老版本自定义数据洗一下
    if (primary)
      await wash('wash:customPageType', 'wash', () => initProvider.washCustomPage(), (r) => r);
    // 老版本的分类数据洗一下
    if (primary)
      await wash('wash:categoryFromMeta', 'wash', () => initProvider.washCategory(), (r) => r);
    // 上游遗留的 siteInfo.authDesc → authorDesc（写的一侧用错过键名，读的一侧一直是 authorDesc）。
    // 幂等：搬完就把死键 $unset，所以第二次启动匹配不到任何文档；也绝不覆盖站长填过的 authorDesc。
    if (primary)
      await wash('wash:authorDesc', 'wash', () => initProvider.washAuthorDesc(), (r) => r);
    // P6 文章字数副本回填（readingMinutes/回收站/相关文章都靠它）。
    // provider 自己往台账记 `backfill:articleWordCount`，所以这里不再包 wash()（会记重）。
    // fire-and-forget：大站上要扫一遍正文，不该阻塞启动；失败由台账 WARN + 这里的 catch 留痕。
    if (primary) {
      const articleProvider = app.get(ArticleProvider);
      articleProvider.backfillWordCounts().catch((err) =>
        console.error(`回填文章字数副本失败：${(err as Error)?.message || err}`),
      );
    }
    const userProvider = app.get(UserProvider);
    // 老版本没加盐的用户数据洗一下。
    // ⚠️ 保持 fire-and-forget（今天就没有 await，不能拖慢启动）；失败由台账 WARN + 这里的 catch 兜住，
    //    不再依赖全局 unhandledRejection 兜底日志。
    if (primary)
      void wash('wash:userSalt', 'wash', () => userProvider.washUserWithSalt(), (r) => r).catch(
        (err) => console.error(`清洗未加盐用户失败：${(err as Error)?.message || err}`),
      );
    // 文章 / 分类的访问密码：把历史**明文**洗成 scrypt 哈希（幂等，第二次跑 washed=0）。
    // fire-and-forget：scrypt 是同步的，几十条就是一两秒，不该阻塞启动；
    // 洗到一半挂了也只是"一部分还是明文"，而那部分照样能解锁
    // （verifyAccessPassword 两种格式都认，一律常量时间比较）。
    // ⚠️ 它同时洗 articles 与 categories 两个集合（ArticleProvider 已经注入了 Category 模型），
    // 且**故意不自己记台账** —— 由这里的 wash() 包装器统一记，与 washUserWithSalt 一致。
    if (primary)
      void wash(
        'wash:accessPasswords',
        'wash',
        // ⚠️ 就地 app.get：上面那个 `const articleProvider` 在更窄的块作用域里，
        // 这里引用不到（TS2552）。放进 lambda 里也更合适 —— wash 本来就是稍后才跑的。
        () => app.get(ArticleProvider).washAccessPasswords(),
        (r) => r,
      ).catch((err) =>
        console.error(`清洗明文访问密码失败：${(err as Error)?.message || err}`),
      );
    const settingProvider = app.get(SettingProvider);
    // 老版本菜单数据洗一下。（同上：保持 fire-and-forget）
    if (primary)
      void wash('wash:defaultMenu', 'wash', () => settingProvider.washDefaultMenu(), (r) => r).catch(
        (err) => console.error(`清洗菜单数据失败：${(err as Error)?.message || err}`),
      );
    const metaProvider = app.get(MetaProvider);
    // 总字数重算（30s 防抖后执行）：只有启动这一次记台账（每次增删改文章也调它，
    // 但那不是"迁移"，记进去只会把台账刷爆）。
    if (primary)
      metaProvider.updateTotalWords('首次启动', {
        migration: migrations ? { key: 'recompute:totalWords', kind: 'recompute' } : undefined,
      });
    if (primary) walineProvider.init();
    // 触发增量渲染生成静态页面，防止升级后内容为空
    // ⚠️ 只有主实例做：一轮全量渲染是 ~130 次串行重渲染 + 重新生成 RSS/sitemap（写同一批文件），
    // 每个 worker 都来一遍等于把这份活乘以核数
    if (primary) {
      const isrProvider = app.get(ISRProvider);
      isrProvider.activeAll('首次启动触发全量渲染！', 1000, {
        forceActice: true,
      });
    }
    // 启动 1 分钟后把台账里所有 outcome==='error' 的条目汇总 WARN 一遍：
    // fire-and-forget 的清洗（统计表维护、流水线脚本落盘）到那时基本都记完账了，
    // 单条失败在 record() 时也已经各自 WARN 过 —— 这里是"点名汇总"，绝不静默。
    if (primary && migrations) {
      const ledger = migrations;
      setTimeout(() => {
        ledger.warnAboutErrors('启动后迁移台账检查').catch((err) =>
          console.error(`读取迁移台账失败：${(err as Error)?.message || err}`),
        );
      }, 60 * 1000);
    }
  }

  // ⚠️ 信号处理**必须在 checkHasInited() 这个 if 外面**：
  //  - cluster 的 worker 收不到终端信号，是主进程转发过来的 SIGTERM，未初始化的实例也一样要能退；
  //  - 以前它在 if 里面，于是"还没初始化的站点"收到 SIGTERM 什么都不做，
  //    docker 要等满宽限期再 SIGKILL；
  //  - worker 更要靠它把攒在内存里的浏览统计写掉（ViewStatsProvider）。
  // ⚠️ 必须同时接 SIGTERM：`docker stop`（以及 compose down / 更新 / 升级）发的都是 SIGTERM，
  // 以前只接了 SIGINT，于是每次停容器都是"等满 10 秒宽限期再 SIGKILL"，
  // 正在写的整站备份 / 导出归档 / 恢复上传会被硬生生截断（留下没有 sidecar 清单的半截归档）。
  // start.js 现在会把收到的信号转发成 SIGTERM，所以这里必须真的处理它。
  let shuttingDown = false;
  // 三个信号都接：SIGINT（Ctrl-C）、SIGTERM（docker stop / watch 重启）、SIGHUP（终端断开）
  // ⚠️ exitCode 参数是给 uncaughtException 用的：信号停机是**正常**退出（0），
  //    致命异常退出必须是**非 0**，否则编排系统（docker/k8s）会把它当成干净退出，
  //    既不告警也不按失败重启 —— 而实际上进程是带着未定义状态被我们主动杀掉的。
  const gracefulShutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`检测到 ${signal}，优雅退出！`);
    // ⚠️ 必须**在关库之前**把还没落库的浏览计数写掉：这些计数是攒在进程内存里的
    // （见 provider/stats/viewStats.provider.ts），SIGTERM 时不 flush 就等于白丢一段访问量。
    // ViewStatsProvider 自己也实现了 onApplicationShutdown 兜底，这里是保证顺序的那一次。
    try {
      const viewStats = app.get(ViewStatsProvider);
      viewStats.stopTimer();
      const summary = await viewStats.flush(`优雅退出(${signal})`);
      // 总是打印（哪怕这一轮没有待写入的）：停机时"计数到底有没有落库"必须能在日志里查到，
      // 否则真丢了访问量也看不出是哪一步没做
      console.log(
        `浏览统计落库：${summary.events} 次浏览 / ${summary.ops} 次 Mongo 命令（${signal}）`,
      );
    } catch (err) {
      console.error(`写入待落库的浏览统计失败：${(err as Error)?.message}`);
    }
    // 每个 stop 都要单独兜住：一个失败不该让另一个跳过，更不该让进程卡住不退出
    try {
      await walineProvider.stop();
    } catch (err) {
      console.error(`停止 waline 失败：${(err as Error)?.message}`);
    }
    try {
      await websiteProvider.stop();
    } catch (err) {
      console.error(`停止前台进程失败：${(err as Error)?.message}`);
    }
    try {
      await app.close();
    } catch (err) {
      console.error(`关闭 HTTP 服务失败：${(err as Error)?.message}`);
    }
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => void gracefulShutdown('SIGHUP'));
  // 致命异常复用同一条清理链（flush 浏览统计 → 停 waline/前台 → 关 HTTP），但退出码是 1。
  // 赋值必须在 gracefulShutdown 定义之后 —— 见文件顶部 fatalShutdownHook 的注释。
  fatalShutdownHook = (reason: string) => gracefulShutdown(reason, 1);

  setTimeout(() => {
    console.log(host ? `应用已启动，端口: ${port}，监听: ${host}` : `应用已启动，端口: ${port}`);
    console.log('API 端点地址: http://<domain>/api');
    console.log('swagger 地址: http://<domain>/swagger');
    console.log('项目主页: https://vanblog.mereith.com');
    console.log('开源地址: https://github.mereith/mereithhh/van-blog');
  }, 3000);
}
/**
 * 多进程开关：`VANBLOG_CLUSTER_WORKERS`（默认 **1** = 今天的单进程行为）。
 *
 * 单进程 Node 是动态请求的实测天花板（AGENTS §7.44：一万条连接拿 caddy 直服的静态图片
 * 0.8 秒全部 200，同样一万条连接打反代到 Node 的动态接口，30 秒只完成 1600 个）。
 * cluster 能把动态吞吐乘以核数，但代价是**内存也乘以核数**（每个 worker 一份完整的
 * Nest 应用 + mongoose 连接池 + Next 的 ISR 缓存），所以默认关着，由部署者按机器决定。
 *
 * 打开之后由主实例独占的东西（`isPrimaryInstance()` 守卫）：
 * 每小时 ISR cron、每日 viewer 结算与统计清理、启动期数据清洗、restore.key、
 * waline / website 两个子进程、首轮全量渲染。
 * 按 worker 数摊薄的东西：内存限流与登录防爆破阈值（`scaleLimit`）、mongoose 连接池上限。
 * 仍然每进程一份、但**语义正确**的东西：浏览统计缓冲（都是原子 $inc）、publicMetaCache。
 */
const clusterWorkers = resolveClusterWorkers(process.env[CLUSTER_ENV], os.cpus().length);

async function startPrimary() {
  // ⚠️ jwt 密钥必须由主进程先解析好再 fork：全新安装时 N 个 worker 同时跑
  // "没有就生成一个"，即便有原子 upsert 兜着，也让它们全部走"读已存在的"这条分支更稳。
  global.jwtSecret = await initJwt();
  // eslint-disable-next-line no-console
  console.log(
    `[cluster] 主进程启动 ${clusterWorkers} 个 worker（${CLUSTER_ENV}=${clusterWorkers}）`,
  );
  startClusterPrimary(clusterWorkers, cluster as any, {
    // eslint-disable-next-line no-console
    log: (message) => console.log(`[cluster] ${message}`),
    // eslint-disable-next-line no-console
    error: (message) => console.error(`[cluster] ${message}`),
  });
}

if (clusterWorkers > 1 && cluster.isPrimary) {
  startPrimary().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[cluster] 主进程启动失败：${(err as Error)?.message || err}`);
    process.exit(1);
  });
} else {
  bootstrap();
}
