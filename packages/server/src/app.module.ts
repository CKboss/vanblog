import { rateLimitMiddleware, securityHeadersMiddleware } from './utils/rateLimit';
import {
  makeRequestIdMiddleware,
  resolveAccessLogFlag,
  resolveSlowRequestMs,
} from './utils/requestId';
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MongooseModule } from '@nestjs/mongoose';
import { config } from './config/index';
import { Article, ArticleSchema } from './scheme/article.schema';
import { Draft, DraftSchema } from './scheme/draft.schema';
import { Meta, MetaSchema } from './scheme/meta.schema';
import { ArticleProvider } from './provider/article/article.provider';
import { CategoryProvider } from './provider/category/category.provider';
import { DraftProvider } from './provider/draft/draft.provider';
import { MetaProvider } from './provider/meta/meta.provider';
import { TagProvider } from './provider/tag/tag.provider';
import { PublicController } from './controller/public/public.controller';
import { AboutMetaController } from './controller/admin/about/about.meta.controller';
import { LinkMetaController } from './controller/admin/link/link.meta.controller';
import { RewardMetaController } from './controller/admin/reward/reward.meta.controller';
import { SiteMetaController } from './controller/admin/site/site.meta.controller';
import { SocialMetaController } from './controller/admin/social/social.meta.controller';
import { TagController } from './controller/admin/tag/tag.controller';
import { ArticleController } from './controller/admin/article/article.controller';
import { DraftController } from './controller/admin/draft/draft.controller';
import { CategoryController } from './controller/admin/category/category.controller';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './controller/admin/auth/auth.controller';
import { UserProvider } from './provider/user/user.provider';
import { AuthProvider } from './provider/auth/auth.provider';
import { User, UserSchema } from './scheme/user.schema';
import { LocalStrategy } from './provider/auth/local.strategy';
import { JwtStrategy } from './provider/auth/jwt.strategy';
import { InitController } from './controller/admin/init/init.controller';
import { InitProvider } from './provider/init/init.provider';
import { InitMiddleware } from './provider/auth/init.middleware';
import { NoStoreCacheMiddleware } from './provider/cache/no-store.middleware';
import { BackupController } from './controller/admin/backup/backup.controller';
import { ThemeProvider } from './provider/theme/theme.provider';
import { ThemeController } from './controller/admin/theme/theme.controller';
import { PublicThemeController } from './controller/public/theme.controller';
import { FullBackupProvider } from './provider/backup/fullBackup.provider';
import { MarkdownExportProvider } from './provider/export/markdownExport.provider';
import { ExportController } from './controller/admin/export/export.controller';
import { MenuMetaController } from './controller/admin/menu/menu.meta.controller';
import { ScheduleModule } from '@nestjs/schedule';
import { Viewer, ViewerSchema } from './scheme/viewer.schema';
import { ViewerProvider } from './provider/viewer/viewer.provider';
import { Visit, VisitSchema } from './scheme/visit.schema';
import { VisitProvider } from './provider/visit/visit.provider';
import { MetaController } from './controller/admin/meta/meta.controller';
import { AnalysisController } from './controller/admin/analysis/analysis.controller';
import { AnalysisProvider } from './provider/analysis/analysis.provider';
import { Setting, SettingSchema } from './scheme/setting.schema';
import { Static, StaticSchema } from './scheme/static.schema';
import { SettingProvider } from './provider/setting/setting.provider';
import { StaticProvider } from './provider/static/static.provider';
import { ImgController } from './controller/admin/img/img.controller';
import { FileController } from './controller/admin/file/file.controller';
import { LocalProvider } from './provider/static/local.provider';
import { SettingController } from './controller/admin/setting/setting.controller';
import { PicgoProvider } from './provider/static/picgo.provider';
import { ViewerTask } from './schedule/viewer.task';
import { CaddyController } from './controller/admin/caddy/caddy.controller';
import { CaddyProvider } from './provider/caddy/caddy.provider';
import { LogProvider } from './provider/log/log.provider';
import { LogController } from './controller/admin/log/log.controller';
import { ISRProvider } from './provider/isr/isr.provider';
import { WalineProvider } from './provider/waline/waline.provider';
import { CacheProvider } from './provider/cache/cache.provider';
import { LoginGuard } from './provider/auth/login.guard';
import { AccessGuard } from './provider/access/access.guard';
import { CollaboratorController } from './controller/admin/collaborator/collaborator.controller';
import { ISRController } from './controller/admin/isr/isr.controller';
import { ISRTask } from './schedule/isr.task';
import { CustomPage, CustomPageSchema } from './scheme/customPage.schema';
import { CustomPageProvider } from './provider/customPage/customPage.provider';
import { CustomPageController } from './controller/admin/customPage/customPage.controller';
import { RssProvider } from './provider/rss/rss.provider';
import { MarkdownProvider } from './provider/markdown/markdown.provider';
import { SiteMapProvider } from './provider/sitemap/sitemap.provider';
import { TokenProvider } from './provider/token/token.provider';
import { Token, TokenSchema } from './scheme/token.schema';
import { TokenGuard } from './provider/auth/token.guard';
import { WebsiteProvider } from './provider/website/website.provider';
import { Category, CategorySchema } from './scheme/category.schema';
import {
  PublicCustomPageController,
  PublicOldCustomPageRedirectController,
} from './controller/customPage/customPage.controller';
import { Pipeline, PipelineSchema } from './scheme/pipeline.schema';
import { NativeComment, NativeCommentSchema } from './scheme/comment.schema';
import { CommentProvider } from './provider/comment/comment.provider';
import { PublicCommentController } from './controller/public/comment.controller';
import { CommentController } from './controller/admin/comment/comment.controller';
import { RobotsController } from './controller/public/robots.controller';
import { PipelineProvider } from './provider/pipeline/pipeline.provider';
import { PipelineController } from './controller/admin/pipeline/pipeline.controller';
import { TokenController } from './controller/admin/token/token.controller';
import { initJwt } from './utils/initJwt';
import { ViewStatsProvider } from './provider/stats/viewStats.provider';
import { configuredWorkerCount, scaleLimit } from './utils/clusterRole';
import { StatsMaintenanceProvider } from './provider/stats/statsMaintenance.provider';

/** 环境变量转数字：非法/缺失就用默认值（连接参数写错成 NaN 会让驱动直接抛） */
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUrl, {
      // autoIndex 必须留着：这个项目没有迁移工具，索引全靠启动时同步
      // （本轮新加的 visits 复合索引、articles 的三个统计索引就是靠它建起来的）。
      autoIndex: true,
      // ⚠️ 以前什么都不配，全用驱动默认值：
      //   - serverSelectionTimeoutMS 默认 30s → mongod 重启时每个请求都要干等 30 秒才失败；
      //   - socketTimeoutMS 默认 0（**永不超时**）→ 网络黑洞（宿主挂起/VPN 断）时，
      //     已借出的连接会一直卡着，连接池 100 个socket 全部占满 = 整站假死，只能等 TCP 自己放弃。
      // 默认值都留了余量，避免误伤长任务（整站备份/恢复、大集合导出）；可用环境变量再调。
      serverSelectionTimeoutMS: num(process.env.VANBLOG_MONGO_SERVER_SELECTION_TIMEOUT_MS, 10000),
      connectTimeoutMS: num(process.env.VANBLOG_MONGO_CONNECT_TIMEOUT_MS, 10000),
      socketTimeoutMS: num(process.env.VANBLOG_MONGO_SOCKET_TIMEOUT_MS, 120000),
      // ⚠️ 连接池是**每进程**的：多进程部署时 N 个 worker × 100 条连接会把 mongod 的连接数
      // 顶上去（而 mongod 低于 64000 fd 就会告警）。这里按 worker 数摊薄，
      // 让"整站对 mongod 的连接总数"仍然约等于配置值；单进程时除数是 1，行为不变。
      maxPoolSize: Math.max(
        10,
        scaleLimit(num(process.env.VANBLOG_MONGO_MAX_POOL_SIZE, 100), configuredWorkerCount()),
      ),
      retryWrites: true,
      retryReads: true,
    }),
    MongooseModule.forFeature([
      { name: Article.name, schema: ArticleSchema },
      { name: Draft.name, schema: DraftSchema },
      { name: Meta.name, schema: MetaSchema },
      { name: User.name, schema: UserSchema },
      { name: Viewer.name, schema: ViewerSchema },
      { name: Visit.name, schema: VisitSchema },
      { name: Setting.name, schema: SettingSchema },
      { name: Static.name, schema: StaticSchema },
      { name: CustomPage.name, schema: CustomPageSchema },
      { name: Token.name, schema: TokenSchema },
      { name: Category.name, schema: CategorySchema },
      { name: Pipeline.name, schema: PipelineSchema },
      { name: NativeComment.name, schema: NativeCommentSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: async () => {
        return {
          secret: await initJwt(),
          signOptions: {
            expiresIn: 3600 * 24 * 7,
          },
        };
      },
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    AppController,
    PublicController,
    PublicThemeController,
    ThemeController,
    AboutMetaController,
    LinkMetaController,
    RewardMetaController,
    SiteMetaController,
    SocialMetaController,
    TagController,
    ArticleController,
    DraftController,
    CategoryController,
    AuthController,
    InitController,
    MenuMetaController,
    BackupController,
    ExportController,
    MetaController,
    AnalysisController,
    SettingController,
    ImgController,
    FileController,
    CaddyController,
    LogController,
    CollaboratorController,
    ISRController,
    CustomPageController,
    PublicCustomPageController,
    PublicOldCustomPageRedirectController,
    PipelineController,
    TokenController,
    PublicCommentController,
    CommentController,
    RobotsController
  ],
  providers: [
    AppService,
    ThemeProvider,
    FullBackupProvider,
    MarkdownExportProvider,
    ArticleProvider,
    CategoryProvider,
    MetaProvider,
    DraftProvider,
    PicgoProvider,
    VisitProvider,
    ViewStatsProvider,
    StatsMaintenanceProvider,
    TagProvider,
    UserProvider,
    AuthProvider,
    LocalStrategy,
    ViewerProvider,
    JwtStrategy,
    InitProvider,
    AnalysisProvider,
    SettingProvider,
    StaticProvider,
    LocalProvider,
    ViewerTask,
    CaddyProvider,
    LogProvider,
    ISRProvider,
    WalineProvider,
    CacheProvider,
    LoginGuard,
    AccessGuard,
    ISRTask,
    CustomPageProvider,
    RssProvider,
    MarkdownProvider,
    SiteMapProvider,
    TokenProvider,
    TokenGuard,
    WebsiteProvider,
    PipelineProvider,
    CommentProvider
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // request-id + 慢请求 / 5xx /（可选）访问日志：挂在**最前面**，
    // 之后所有中间件（安全头、限流）产生的响应都带着同一个 id，
    // 用户报障时报出响应头里的 x-request-id 就能在日志里定位到那一行
    consumer
      .apply(
        makeRequestIdMiddleware({
          slowMs: resolveSlowRequestMs(),
          accessLog: resolveAccessLogFlag(),
        }),
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
    // 安全响应头 + 全局兜底限流（容器内部回环调用放行）
    consumer
      .apply(securityHeadersMiddleware, rateLimitMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
    consumer.apply(NoStoreCacheMiddleware).forRoutes({
      path: '*',
      method: RequestMethod.ALL,
    });
    consumer
      .apply(InitMiddleware)
      .exclude(
        { path: '/api/admin/img/upload', method: RequestMethod.POST },
        { path: '/api/admin/init/upload', method: RequestMethod.POST },
        // 初始化页直接上传整站备份恢复：站点**还没初始化**时必须能用，
        // 而 InitMiddleware 对未初始化的站点一律回 `{statusCode:233,'未初始化!'}`。
        // 安全性由控制器自己保证（处理器内 checkHasInited + 单飞互斥 + 归档校验）。
        { path: '/api/admin/init/restore', method: RequestMethod.POST },
        { path: '/api/admin/caddy/ask', method: RequestMethod.GET },
      )
      .forRoutes({
        path: '*',
        method: RequestMethod.ALL,
      });
  }
}
