import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { CategoryProvider } from 'src/provider/category/category.provider';
import { DraftProvider } from 'src/provider/draft/draft.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { TagProvider } from 'src/provider/tag/tag.provider';
import { UserProvider } from 'src/provider/user/user.provider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dayjs from 'dayjs';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { removeID } from 'src/utils/removeId';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { StaticProvider } from 'src/provider/static/static.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { config } from 'src/config';
import { ApiToken } from 'src/provider/swagger/token';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { collectCategoriesFromBackup, toExportCategory } from 'src/utils/backupCategories';

/**
 * 恢复用的上传选项：备份可能有几百 MB，**必须落盘**（默认的内存存储会把它整个读进内存，
 * 而且 `file.path` 为空）。装饰器在类实例化之前求值，所以这里用模块级常量。
 */
const RESTORE_UPLOAD_OPTIONS = {
  storage: diskStorage({
    destination: (_req: any, _file: any, cb: (err: Error | null, dir?: string) => void) => {
      try {
        const dir = path.join(config.staticPath, 'tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err as Error);
      }
    },
    filename: (_req: any, file: any, cb: (err: Error | null, name?: string) => void) => {
      const matched = String(file?.originalname || '').match(/\.(tar\.(zst|xz|gz)|tgz)$/i);
      cb(
        null,
        `restore-upload-${Date.now()}-${Math.round(Math.random() * 1e6)}${
          matched ? matched[0] : '.tar'
        }`,
      );
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
};
import { FullBackupProvider } from 'src/provider/backup/fullBackup.provider';
import { availableFormats, pickSpec } from 'src/utils/fullBackup';
import { checkTrue } from 'src/utils/checkTrue';

@ApiTags('backup')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/backup')
export class BackupController {
  private readonly logger = new Logger(BackupController.name);
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly categoryProvider: CategoryProvider,
    private readonly tagProvider: TagProvider,
    private readonly metaProvider: MetaProvider,
    private readonly draftProvider: DraftProvider,
    private readonly userProvider: UserProvider,
    private readonly viewerProvider: ViewerProvider,
    private readonly visitProvider: VisitProvider,
    private readonly settingProvider: SettingProvider,
    private readonly staticProvider: StaticProvider,
    private readonly isrProvider: ISRProvider,
    private readonly fullBackupProvider: FullBackupProvider,
  ) {}

  @Get('export')
  async getAll(@Res() res: Response) {
    const articles = await this.articleProvider.getAll('admin', true);
    const categoryDocs = await this.categoryProvider.getAllCategories(true);
    const categories = (categoryDocs || []).map((item) => toExportCategory(item));
    const tags = await this.tagProvider.getAllTags(true);
    const meta = await this.metaProvider.getAll();
    const drafts = await this.draftProvider.getAll();
    const user = await this.userProvider.getUser();
    // 访客记录
    const viewer = await this.viewerProvider.getAll();
    const visit = await this.visitProvider.getAll();
    // 设置表
    const staticSetting = await this.settingProvider.getStaticSetting();
    const staticItems = await this.staticProvider.exportAll();
    const data = {
      articles,
      tags,
      meta,
      drafts,
      categories,
      user,
      viewer,
      visit,
      static: staticItems,
      setting: { static: staticSetting },
    };
    // 临时文件放系统 tmp 目录：以前写在进程 cwd（packages/server/temp.json），
    // 而且只有出错时才删，成功下载就把整站数据留在了代码目录里。
    const tmpFile = path.join(os.tmpdir(), `vanblog-backup-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    res.download(tmpFile, 'vanblog-backup.json', (err) => {
      if (err) {
        this.logger.error(err.stack);
      } else {
        this.logger.log('success', 'download');
      }
      fs.rmSync(tmpFile, { force: true });
    });
  }

  // ---------------------------------------------------------------------------
  // 整站备份：数据库（含 waline 评论库）+ 本地静态文件 -> 一个高压缩归档，可整体恢复
  // ---------------------------------------------------------------------------

  /** 本机可用的压缩格式（zstd > xz > gzip，按可用性排序）。 */
  @Get('full/formats')
  async fullFormats() {
    const formats = availableFormats();
    return {
      statusCode: 200,
      data: {
        available: formats,
        default: pickSpec('auto')?.format || null,
        note: 'zstd -19 --long 体积最小且最快；没有 zstd 时用 xz -9e；都没有就退回 gzip -9',
      },
    };
  }

  @Post('full/export')
  async exportFull(@Body() body: { format?: string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const result = await this.fullBackupProvider.export(body?.format);
    return {
      statusCode: 200,
      data: {
        name: result.name,
        // 归档不在静态目录下，只能走这个鉴权接口下载
        downloadUrl: `/api/admin/backup/full/download?name=${encodeURIComponent(result.name)}`,
        bytes: result.bytes,
        size: result.sizeText,
        format: result.format,
        compressor: result.compressor,
        seconds: Number((result.ms / 1000).toFixed(1)),
        totals: result.manifest.totals,
        databases: Object.fromEntries(
          Object.entries(result.manifest.databases).map(([name, item]) => [
            name,
            Object.keys(item.collections).length,
          ]),
        ),
        static: result.manifest.static,
      },
    };
  }

  @Get('full/list')
  async listFull() {
    const items = this.fullBackupProvider.list();
    return {
      statusCode: 200,
      data: items.map((item) => ({
        name: item.name,
        bytes: item.bytes,
        size: item.sizeText,
        format: item.format,
        createdAt: item.createdAt,
        downloadUrl: `/api/admin/backup/full/download?name=${encodeURIComponent(item.name)}`,
        totals: item.manifest?.totals || null,
      })),
    };
  }

  @Post('full/inspect')
  async inspectFull(@Body() body: { name?: string }) {
    const manifest = await this.fullBackupProvider.inspect(body?.name || '');
    if (!manifest) {
      throw new BadRequestException('读不出这个备份的清单：文件损坏，或不是本功能导出的整站备份');
    }
    return { statusCode: 200, data: manifest };
  }

  /**
   * 从整站备份恢复：`name` 用服务器上已有的备份，或直接上传一个备份文件。
   * 会覆盖当前数据库与静态文件，所以必须显式带 `confirm=true`。
   */
  @Post('full/restore')
  @UseInterceptors(FileInterceptor('file', RESTORE_UPLOAD_OPTIONS))
  async restoreFull(
    @UploadedFile() file: any,
    @Body() body: { name?: string; confirm?: string; withStatic?: string },
  ) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    if (!checkTrue(body?.confirm)) {
      throw new BadRequestException('恢复会覆盖当前全部数据，请带 confirm=true 再调用一次');
    }
    let archivePath = file?.path;
    let uploaded = Boolean(file?.path);
    if (!archivePath) {
      if (!body?.name) {
        throw new BadRequestException('请指定要恢复的备份（name），或直接上传备份文件');
      }
      archivePath = this.fullBackupProvider.resolveArchive(body.name);
    }
    try {
      const result = await this.fullBackupProvider.restore(
        archivePath,
        body?.withStatic === undefined ? true : checkTrue(body.withStatic),
      );
      this.isrProvider.activeAll('整站恢复触发全量渲染！');
      return {
        statusCode: 200,
        data: {
          restoredAt: new Date().toISOString(),
          seconds: Number((result.ms / 1000).toFixed(1)),
          databases: result.databases,
          static: result.static,
          backupCreatedAt: result.manifest.createdAt,
          notes: result.notes,
          uploaded,
        },
      };
    } finally {
      if (uploaded && archivePath) {
        fs.rmSync(archivePath, { force: true });
      }
    }
  }

  /** 删掉一个备份归档（含 sidecar 清单）。 */
  @Post('full/delete')
  async deleteFull(@Body() body: { name?: string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const archivePath = this.fullBackupProvider.resolveArchive(body?.name || '');
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(`${archivePath}.manifest.json`, { force: true });
    return { statusCode: 200, data: '已删除' };
  }

  /** 鉴权下载：归档不在静态目录下（含数据库内容），只能走这个接口。 */
  @Get('full/download')
  async downloadFull(@Query('name') name: string, @Res() res: Response) {
    const archivePath = this.fullBackupProvider.resolveArchive(name);
    res.download(archivePath, path.basename(archivePath), (err) => {
      if (err) {
        this.logger.error(err.stack);
      }
    });
  }

  @Post('/import')
  @UseInterceptors(FileInterceptor('file'))
  async importAll(@UploadedFile() file: Express.Multer.File) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const json = file.buffer.toString();
    const data = JSON.parse(json);
    const { meta, setting, categories } = data;
    let { articles, drafts, viewer, visit, static: staticItems } = data;
    // 去掉 id
    articles = removeID(articles);
    drafts = removeID(drafts);
    viewer = removeID(viewer);
    visit = removeID(visit);
    if (staticItems) {
      staticItems = removeID(staticItems);
    }
    if (setting && setting.static) {
      setting.static = { ...setting.static, _id: undefined, __v: undefined };
    }
    if (meta) {
      delete meta._id;
    }

    const toImportCategories = collectCategoriesFromBackup({
      categories,
      articles,
      drafts,
      meta,
    });
    await this.categoryProvider.importCategories(toImportCategories);
    if (toImportCategories.length && meta) {
      meta.categories = toImportCategories.map((item) => item.name);
    }

    await this.articleProvider.importArticles(articles);
    await this.draftProvider.importDrafts(drafts);
    // 新机器必须先初始化后台账号才能打开导入页。覆盖 user 会把刚配好的登录顶掉，
    // 甚至把备份里已哈希的密码再哈希一次，两边账号都登不进去。账号改走设置页。
    if (data.user) {
      this.logger.log('导入备份时保留当前后台账号，未覆盖用户数据');
    }
    await this.metaProvider.update(meta);
    await this.settingProvider.importSetting(setting);
    await this.staticProvider.importItems(staticItems);
    if (visit) {
      await this.visitProvider.import(visit);
    }
    if (viewer) {
      await this.viewerProvider.import(viewer);
    }
    this.isrProvider.activeAll('导入备份触发增量渲染！');
    return {
      statusCode: 200,
      data: '导入成功！',
    };
  }
}
