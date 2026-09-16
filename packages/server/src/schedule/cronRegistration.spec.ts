import { SchedulerRegistry, ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { ISRTask } from './isr.task';
import { ViewerTask } from './viewer.task';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { StatsMaintenanceProvider } from 'src/provider/stats/statsMaintenance.provider';

/**
 * 两个 @Cron 任务在 **@nestjs/schedule 5 + cron 3.x** 下是否真的注册上、真的启动、
 * 真的能触发到方法体。
 *
 * 为什么要钉这个：@nestjs/schedule 的大版本号跟着 Nest 走（2 → 5 跨了三个），
 * 内部换过调度实现（cron 2.x → 3.x，`new CronJob()` → `CronJob.from()`）。
 * 这类升级最坏的失败方式是**静默的**：装饰器元数据没被 explorer 认出来，
 * 任务一个都不注册，应用照常启动、接口全 200，只有"每小时 ISR"和"每日访客结算"
 * 从此不再发生 —— 没有任何日志会告诉你。所以这里直接问 SchedulerRegistry 要证据，
 * 并且用 `fireOnTick()` 真的跑一次 tick，确认打到了对应的方法体。
 *
 * ⚠️ 不要断言 job 的**名字**：@Cron 不给 name 时 schedule 5 用 `crypto.randomUUID()`
 *    生成（实测形如 `ab53514f-ec84-...`，每次跑都不一样）。这里改用
 *    "cron 表达式 → 触发一次 → 看哪个 provider 被调到"来绑定任务身份，比名字更强。
 *
 * ⚠️ 不连数据库、不起 HTTP：两个 Task 的依赖全部用桩，`moduleRef.init()` 只触发
 * 生命周期钩子（SchedulerOrchestrator 在 onApplicationBootstrap 里 mountCron）。
 */
const ISR_CRON = '0 0 */1 * * *';
const VIEWER_CRON = '0 0 * * *';

describe('@Cron 注册（@nestjs/schedule 5 + cron 3.x）', () => {
  let moduleRef: TestingModule;
  let registry: SchedulerRegistry;
  const activeAll = jest.fn();
  const getViewer = jest.fn(async () => ({ visited: 7, viewer: 3 }));
  const createOrUpdate = jest.fn(async () => undefined);
  const pruneStats = jest.fn(async () => undefined);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ISRTask,
        ViewerTask,
        { provide: ISRProvider, useValue: { activeAll } },
        { provide: MetaProvider, useValue: { getViewer } },
        { provide: ViewerProvider, useValue: { createOrUpdate } },
        { provide: StatsMaintenanceProvider, useValue: { pruneStats } },
      ],
    }).compile();
    await moduleRef.init();
    registry = moduleRef.get(SchedulerRegistry);
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  const jobsOf = () => Array.from(registry.getCronJobs().entries());
  const jobBySource = (source: string) => {
    const found = jobsOf().filter(([, job]) => String((job as any).cronTime?.source) === source);
    expect(found.length).toBe(1);
    return found[0][1] as any;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('恰好注册了 2 个 cron 任务，表达式就是源码里写的那两个', () => {
    expect(registry.getCronJobs().size).toBe(2);
    expect(jobsOf().map(([, job]) => String((job as any).cronTime.source)).sort()).toEqual(
      [ISR_CRON, VIEWER_CRON].sort(),
    );
  });

  it('两个任务都已经 start（不是注册了却没跑）', () => {
    expect(jobBySource(ISR_CRON).running).toBe(true);
    expect(jobBySource(VIEWER_CRON).running).toBe(true);
  });

  it('每小时 ISR 的下次触发是「整点、间隔 1 小时」', () => {
    const next = jobBySource(ISR_CRON).nextDates(4).map((d: any) => d.toJSDate());
    for (const d of next) {
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
    }
    for (let i = 1; i < next.length; i++) {
      expect(next[i].getTime() - next[i - 1].getTime()).toBe(60 * 60 * 1000);
    }
  });

  it('每日结算的下次触发是「每天 00:00、间隔 24 小时」', () => {
    const next = jobBySource(VIEWER_CRON).nextDates(3).map((d: any) => d.toJSDate());
    for (const d of next) {
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
    }
    for (let i = 1; i < next.length; i++) {
      expect(next[i].getTime() - next[i - 1].getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('tick 打到 ISRTask.handleCron（表达式 → 方法体的绑定没断）', async () => {
    activeAll.mockClear();
    jobBySource(ISR_CRON).fireOnTick();
    await flush();
    expect(activeAll).toHaveBeenCalledWith('定时触发 ISR');
  });

  it('tick 打到 ViewerTask.handleCron（每日结算那条链会真的跑）', async () => {
    getViewer.mockClear();
    createOrUpdate.mockClear();
    pruneStats.mockClear();
    jobBySource(VIEWER_CRON).fireOnTick();
    await flush();
    await flush();
    expect(getViewer).toHaveBeenCalledTimes(1);
    // handleCron 里这两个是 fire-and-forget，但必须被调到（否则每日快照与保留期清理就没了）
    expect(createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ visited: 7, viewer: 3, date: expect.any(String) }),
    );
    expect(pruneStats).toHaveBeenCalledWith('每日定时清理');
  });
});
