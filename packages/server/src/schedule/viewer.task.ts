import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import cluster from 'node:cluster';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { StatsMaintenanceProvider } from 'src/provider/stats/statsMaintenance.provider';
@Injectable()
export class ViewerTask {
  private readonly logger = new Logger(ViewerTask.name);
  constructor(
    private readonly metaProvider: MetaProvider,
    private readonly viewerProvider: ViewerProvider,
    private readonly statsMaintenance: StatsMaintenanceProvider,
  ) {}

  @Cron('0 0 * * *')
  async handleCron() {
    // 每日结算 + 统计保留期清理都只能跑一次（多进程时由主实例负责，见 utils/clusterRole）
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    const curTime = dayjs();
    const { visited, viewer } = await this.metaProvider.getViewer();
    this.logger.debug(
      `[${curTime.format('YYYY-MM-DD HH:mm:ss')}] visitor: ${visited} \t viewer: ${viewer}`,
    );
    // ⚠️ 这两处都是"发出去就不管"的写入，但**必须挂 catch**：
    // cron 里的 unhandledRejection 只会在日志里留一行全局兜底，谁也看不出是哪一步失败了。
    this.viewerProvider
      .createOrUpdate({
        viewer: viewer,
        visited: visited,
        date: curTime.format('YYYY-MM-DD'),
      })
      .catch((err) => this.logger.error(`写入每日访客快照失败：${err?.message || err}`));
    // 统计表保留期清理挂在**已有的**每日 cron 上（不额外开定时器）。
    // 默认 VANBLOG_VISIT_RETENTION_DAYS=0 = 永不删除，所以不动环境变量的用户什么都不会变。
    this.statsMaintenance
      .pruneStats('每日定时清理')
      .catch((err) => this.logger.error(`清理过期统计数据失败：${err?.message || err}`));
  }
}
