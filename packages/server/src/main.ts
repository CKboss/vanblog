import { NestFactory } from '@nestjs/core';
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
import { applyStaticAssetHeaders } from './utils/imgCompress';
import { ATTACHMENT_FOLDER } from './utils/attachment';
import { THUMB_FOLDER } from './types/setting.dto';

async function bootstrap() {
  const jwtSecret = await initJwt();
  global.jwtSecret = jwtSecret;
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(json({ limit: '50mb' }));

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
      req.path.startsWith('/static/export/backups/') ||
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
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, document);
  const { port, host } = getListenTarget(DEFAULT_SERVER_PORT, globalConfig.serverHost);
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
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
    process.on('SIGINT', async () => {
      await walineProvider.stop();
      await websiteProvider.stop();
      console.log('检测到关闭信号，优雅退出！');
      process.exit();
    });
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
