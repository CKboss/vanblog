import { PublishTask, PUBLISH_FIRST_TICK_LOOKBACK_MS, PUBLISH_TICK_SLACK_MS } from './publish.task';
import * as publicMetaCache from 'src/utils/publicMetaCache';

/**
 * P5 定时发布 cron：
 *  - 只点名 (windowStart, now] 内到点的文章（窗口自动前移，每篇只点名一次）；
 *  - 到点文章 ≥1 时：失效 publicMeta 缓存 + activeAll(delay=1000)（RSS/sitemap 立刻重建，
 *    delay=1000 是 §7.55 E 钉过的坑：不传的话 RSS 要 3 分钟后才有）；
 *  - 查询失败不炸 cron（catch + ERROR 日志），且窗口不前移（下次重查）。
 */

function createFakeArticleModel(docs: any[]) {
  const captured: any[] = [];
  const matches = (doc: any, filter: any) => {
    const range = filter?.publishAt;
    if (range?.$gt && !(new Date(doc.publishAt) > new Date(range.$gt))) return false;
    if (range?.$lte && !(new Date(doc.publishAt) <= new Date(range.$lte))) return false;
    if (filter?.deleted?.$ne === true && doc.deleted === true) return false;
    return true;
  };
  const model: any = {
    captured,
    failNext: false,
    find: (filter: any, projection?: any) => {
      captured.push(filter);
      const chain: any = {
        sort: () => chain,
        limit: () => chain,
        exec: async () => {
          if (model.failNext) {
            model.failNext = false;
            throw new Error('mongo 抖了');
          }
          return docs.filter((d) => matches(d, filter));
        },
      };
      return chain;
    },
  };
  return model;
}

describe('PublishTask.publishDue', () => {
  const t0 = new Date('2026-09-17T12:00:00Z');

  function createTask(docs: any[]) {
    const model = createFakeArticleModel(docs);
    const activeAll = jest.fn();
    const task = new PublishTask(model, { activeAll } as any);
    jest.spyOn((task as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((task as any).logger, 'error').mockImplementation(() => undefined);
    return { task, model, activeAll };
  }

  it('首次 tick 回看 120s：窗口内到点的文章被点名 + ISR + 缓存失效', async () => {
    const invalidate = jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache');
    const { task, model, activeAll } = createTask([
      { id: 1, title: '刚到点', pathname: 'a', publishAt: new Date(t0.getTime() - 30_000), deleted: false },
      { id: 2, title: '还没到点', pathname: 'b', publishAt: new Date(t0.getTime() + 60_000), deleted: false },
      { id: 3, title: '太早以前到点', pathname: 'c', publishAt: new Date(t0.getTime() - PUBLISH_FIRST_TICK_LOOKBACK_MS - 60_000), deleted: false },
      { id: 4, title: '到点但已删', pathname: 'd', publishAt: new Date(t0.getTime() - 30_000), deleted: true },
    ]);
    const due = await task.publishDue(t0);
    expect(due.map((d) => d.id)).toEqual([1]);
    // 窗口形状：$gt = now - 120s，$lte = now
    const filter = model.captured[0];
    expect(filter.publishAt.$lte).toEqual(t0);
    expect(filter.publishAt.$gt).toEqual(new Date(t0.getTime() - PUBLISH_FIRST_TICK_LOOKBACK_MS));
    expect(filter.deleted).toEqual({ $ne: true });
    expect(invalidate).toHaveBeenCalled();
    expect(activeAll).toHaveBeenCalledTimes(1);
    expect(activeAll.mock.calls[0][1]).toBe(1000); // ⚠️ delay 必须是 1000（RSS/sitemap 即时重建）
    expect(String(activeAll.mock.calls[0][0])).toContain('ids: 1');
    invalidate.mockRestore();
  });

  it('第二次 tick：窗口从 lastRunAt-5s 开始，已点名的文章不再重复点名', async () => {
    const invalidate = jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache');
    const doc = { id: 7, title: 'x', pathname: 'x', publishAt: new Date(t0.getTime() - 10_000), deleted: false };
    const { task, model, activeAll } = createTask([doc]);
    expect((await task.publishDue(t0)).map((d) => d.id)).toEqual([7]);

    const t1 = new Date(t0.getTime() + 60_000);
    const second = await task.publishDue(t1);
    expect(second).toEqual([]); // 上一轮已经点过名
    expect(activeAll).toHaveBeenCalledTimes(1); // 没有新到点的 → 不再触发渲染
    // 窗口起点 = lastRunAt - slack
    expect(model.captured[1].publishAt.$gt).toEqual(new Date(t0.getTime() - PUBLISH_TICK_SLACK_MS));
    expect(model.captured[1].publishAt.$lte).toEqual(t1);
    invalidate.mockRestore();
  });

  it('没有到点文章：不触发 ISR、不动缓存', async () => {
    const invalidate = jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache');
    const { task, activeAll } = createTask([
      { id: 9, title: 'future', pathname: 'f', publishAt: new Date(t0.getTime() + 3600_000), deleted: false },
    ]);
    expect(await task.publishDue(t0)).toEqual([]);
    expect(activeAll).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });

  it('查询失败：handleCron 不抛（ERROR 留痕）且窗口不前移，下一次能重查', async () => {
    const { task, model } = createTask([
      { id: 1, title: 'a', pathname: 'a', publishAt: new Date(t0.getTime() - 1000), deleted: false },
    ]);
    model.failNext = true;
    await expect(task.handleCron()).resolves.toBeUndefined(); // catch 住了，不炸 cron
    expect((task as any).logger.error).toHaveBeenCalled();
    // 失败后 lastRunAt 未被设置/前移：下一次仍是首查窗口，文章还在就能补点名
    const due = await task.publishDue(t0);
    expect(due.map((d) => d.id)).toEqual([1]);
  });
});

describe('PublishTask 源码钉子', () => {
  it('cron 只由主实例跑（沿用 isPrimaryInstance(cluster) 约定）', async () => {
    const src = require('fs').readFileSync(require.resolve('./publish.task.ts'), 'utf8');
    expect(src).toContain('isPrimaryInstance(cluster)');
    expect(src).toContain("@Cron('0 * * * * *')");
  });
});

describe('PublishTask @Cron 注册（@nestjs/schedule 5 + cron 3.x）', () => {
  // 与 cronRegistration.spec 同一个理由：调度器升级最坏的失败方式是**静默不注册**
  // （应用照常启动、接口全 200，只有定时发布从此不再发生），所以直接问 SchedulerRegistry 要证据。
  it('每分钟一条、已 start、fireOnTick 打到查询', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');
    const { getModelToken } = await import('@nestjs/mongoose');
    const { ISRProvider } = await import('src/provider/isr/isr.provider');
    const exec = jest.fn(async () => []);
    const model = { find: () => ({ sort: () => ({ limit: () => ({ exec }) }) }) };
    const activeAll = jest.fn();
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        PublishTask,
        { provide: getModelToken('Article'), useValue: model },
        { provide: ISRProvider, useValue: { activeAll } },
      ],
    }).compile();
    await moduleRef.init();
    try {
      const registry = moduleRef.get(SchedulerRegistry);
      const mine = Array.from(registry.getCronJobs().values()).filter(
        (j: any) => String(j.cronTime?.source) === '0 * * * * *',
      );
      expect(mine.length).toBe(1);
      expect((mine[0] as any).running).toBe(true);
      (mine[0] as any).fireOnTick();
      await new Promise((r) => setTimeout(r, 0));
      expect(exec).toHaveBeenCalled(); // tick 真的打到了查询（表达式 → 方法体的绑定没断）
    } finally {
      await moduleRef.close();
    }
  }, 30000);
});
