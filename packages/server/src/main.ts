import { NestFactory } from '@nestjs/core';
import { envInt } from './utils/rateLimit';
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
import { sanitizeRequestPayloads } from './utils/sanitizeRequest';
import {
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT_LARGE,
  LARGE_JSON_BODY_PREFIXES,
  resolveBodyLimit,
} from './utils/bodyLimit';
import { applyStaticAssetHeaders } from './utils/imgCompress';
import { ATTACHMENT_FOLDER } from './utils/attachment';
import { THUMB_FOLDER } from './types/setting.dto';

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
  process.on('uncaughtException', (error: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[uncaughtException] ${error?.stack || error?.message || error}`);
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

  // 整站备份里含数据库内容（密码哈希、jwt 密钥等），不能像图片那样匿名可下载。
  // 备份默认放在 staticPath 之外（config.backupPath），这里是兜底：万一被配到静态目录里，
  // 或者旧版本留在 <static>/export/backups/ 下的归档，都不给匿名访问；下载走鉴权接口。
  const staticRoot = path.resolve(globalConfig.staticPath);
  const backupRoot = path.resolve(globalConfig.backupPath);
  const backupUnderStatic =
    backupRoot.startsWith(staticRoot + path.sep)
      ? '/static/' + path.relative(staticRoot, backupRoot).split(path.sep).join('/') + '/'
      : null;
  app.use((req, res, next) => {
    if (
      // 导出归档（图片/附件/JSON）以前都在这里，匿名可读且文件名只有日期，
      // 现在已经搬到 backupPath 下并改成鉴权下载；这条是旧文件的兜底
      req.path.startsWith('/static/export/') ||
      // 上传/导出的临时目录：里面可能是整站备份，匿名一律不给
      req.path.startsWith('/static/tmp/') ||
      req.path.startsWith('/static/upload-tmp/') ||
      (backupUnderStatic && req.path.startsWith(backupUnderStatic))
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
  // 生产环境建议关掉：VANBLOG_SWAGGER=false
  if (process.env.VANBLOG_SWAGGER !== 'false') {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('swagger', app, document);
  }
  const { port, host } = getListenTarget(DEFAULT_SERVER_PORT, globalConfig.serverHost);
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }

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
  const gracefulShutdown = async (signal: string) => {
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
    process.exit(0);
  };
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => void gracefulShutdown('SIGHUP'));

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
