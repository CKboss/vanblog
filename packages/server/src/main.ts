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
import { DEFAULT_SERVER_PORT, getListenTarget } from './utils/listenHost';
import { sanitizeRequestPayloads } from './utils/sanitizeRequest';
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

  app.use(json({ limit: '50mb' }));

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
  initProvider.initVersion();
  initProvider.initRestoreKey();
  if (await initProvider.checkHasInited()) {
    // 新版本自动启动图床压缩功能
    await initProvider.washStaticSetting();
    // 老版本自定义数据洗一下
    await initProvider.washCustomPage();
    // 老版本的分类数据洗一下
    await initProvider.washCategory();
    const userProvider = app.get(UserProvider);
    // 老版本没加盐的用户数据洗一下。
    userProvider.washUserWithSalt();
    const settingProvider = app.get(SettingProvider);
    // 老版本菜单数据洗一下。
    settingProvider.washDefaultMenu();
    const metaProvider = app.get(MetaProvider);
    metaProvider.updateTotalWords('首次启动');
    const walineProvider = app.get(WalineProvider);
    walineProvider.init();
    // ⚠️ 必须同时接 SIGTERM：`docker stop`（以及 compose down / 更新 / 升级）发的都是 SIGTERM，
    // 以前只接了 SIGINT，于是每次停容器都是"等满 10 秒宽限期再 SIGKILL"，
    // 正在写的整站备份 / 导出归档 / 恢复上传会被硬生生截断（留下没有 sidecar 清单的半截归档）。
    // start.js 现在会把收到的信号转发成 SIGTERM，所以这里必须真的处理它。
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log(`检测到 ${signal}，优雅退出！`);
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
    // 触发增量渲染生成静态页面，防止升级后内容为空
    const isrProvider = app.get(ISRProvider);
    isrProvider.activeAll('首次启动触发全量渲染！', 1000, {
      forceActice: true,
    });
  }
  setTimeout(() => {
    console.log(host ? `应用已启动，端口: ${port}，监听: ${host}` : `应用已启动，端口: ${port}`);
    console.log('API 端点地址: http://<domain>/api');
    console.log('swagger 地址: http://<domain>/swagger');
    console.log('项目主页: https://vanblog.mereith.com');
    console.log('开源地址: https://github.mereith/mereithhh/van-blog');
  }, 3000);
}
bootstrap();
