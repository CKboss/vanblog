import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { MigrationProvider } from 'src/provider/migration/migration.provider';
import { ApiToken } from 'src/provider/swagger/token';

/**
 * 迁移/数据清洗台账（只读）。
 *
 * 回答运维问题："这个实例到底对它的数据做过什么修复？成功没有？什么时候？"
 * 故意**不在 publicRoutes 里**：台账含代码版本与内部维护细节，只给管理员看。
 */
@ApiTags('migration')
@ApiToken
@UseGuards(...AdminGuard)
@Controller('/api/admin/migration')
export class MigrationController {
  constructor(private readonly migrationProvider: MigrationProvider) {}

  /** 全部台账，按最近运行时间倒序。响应信封与其它后台接口一致。 */
  @Get('list')
  async list() {
    const rows = await this.migrationProvider.list();
    return {
      statusCode: 200,
      data: rows.map((row: any) => {
        const doc = typeof row.toObject === 'function' ? row.toObject() : row;
        return {
          key: doc.key,
          kind: doc.kind,
          ranAt: doc.ranAt,
          durationMs: doc.durationMs,
          outcome: doc.outcome,
          detail: doc.detail,
          codeVersion: doc.codeVersion,
          runs: doc.runs,
          firstRanAt: doc.firstRanAt,
          lastError: doc.lastError || '',
          lastErrorAt: doc.lastErrorAt,
        };
      }),
    };
  }
}
