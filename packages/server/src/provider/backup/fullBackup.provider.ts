import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'src/config';
import {
  BackupListEntry,
  FullBackupResult,
  RestoreResult,
  createFullBackup,
  inspectFullBackup,
  listFullBackups,
  restoreFullBackup,
} from 'src/utils/fullBackup';
import { FullBackupManifest } from 'src/utils/backupCodec';

/**
 * 整站备份 / 恢复。
 *
 * 复用 mongoose 已经建好的连接（`connection.getClient()`），不再单独连一次 Mongo；
 * 备份范围 = 主库（默认 `vanBlog`）+ 评论库（`waline`）+ `<static>/{img,file,customPage}`。
 */
@Injectable()
export class FullBackupProvider {
  logger = new Logger(FullBackupProvider.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get client(): any {
    return this.connection.getClient();
  }

  private get dbName(): string {
    return this.connection.name || 'vanBlog';
  }

  backupDir(): string {
    return config.backupPath;
  }

  /** 只认备份目录里的 `vanblog-full-*` 文件，挡住 `../` 之类的路径穿越。 */
  resolveArchive(name: string): string {
    const base = path.basename(String(name || ''));
    if (!base || !base.startsWith('vanblog-full-')) {
      throw new BadRequestException('备份文件名不合法！');
    }
    const full = path.resolve(this.backupDir(), base);
    const root = path.resolve(this.backupDir());
    if (!full.startsWith(root + path.sep)) {
      throw new BadRequestException('备份文件名不合法！');
    }
    if (!fs.existsSync(full)) {
      throw new BadRequestException('找不到这个备份文件！');
    }
    return full;
  }

  async export(format?: string): Promise<FullBackupResult> {
    const result = await createFullBackup({
      client: this.client,
      staticPath: config.staticPath,
      dbName: this.dbName,
      walineDbName: config.walineDB,
      format: format || 'auto',
      outDir: this.backupDir(),
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    this.logger.log(
      `整站备份完成：${result.name}（${result.sizeText}，${result.format}，耗时 ${(
        result.ms / 1000
      ).toFixed(1)}s）`,
    );
    return result;
  }

  list(): BackupListEntry[] {
    return listFullBackups(this.backupDir());
  }

  async inspect(name: string): Promise<FullBackupManifest | null> {
    const archivePath = this.resolveArchive(name);
    return inspectFullBackup(archivePath, this.backupDir());
  }

  async restore(archivePath: string, withStatic = true): Promise<RestoreResult> {
    const result = await restoreFullBackup({
      client: this.client,
      staticPath: config.staticPath,
      archivePath,
      withStatic,
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    this.logger.log(
      `整站恢复完成：${Object.entries(result.databases)
        .map(([db, item]) => `${db} ${item.collections} 表/${item.documents} 条`)
        .join('，')}，耗时 ${(result.ms / 1000).toFixed(1)}s`,
    );
    return result;
  }
}
