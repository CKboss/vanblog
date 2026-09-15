import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import cluster from 'node:cluster';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { isPrimaryInstance } from 'src/utils/clusterRole';
@Injectable()
export class ISRTask {
  constructor(private readonly isrProvider: ISRProvider) {}

  @Cron('0 0 */1 * * *')
  async handleCron() {
    // ⚠️ 只能跑一次：一轮全量 ISR 是 ~130 次串行重渲染（还会重新生成 RSS 与 sitemap，
    // 写的是同一批文件）。多进程部署时如果每个 worker 都跑，等于把这份活乘以核数，
    // 而且 ISR 的 in-flight 互斥量是**进程内**变量，跨进程根本拦不住重复渲染。
    // 单进程时 cluster.isPrimary === true，这个判断永远为真。
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    // 每到整点小时，手动触发一次 ISR。
    // 这样可以预防某些情况下，服务端渲染了默认黑色主题，可是客户端是白天导致的闪屏问题。
    this.isrProvider.activeAll('定时触发 ISR');
  }
}
