import { HealthController } from './health.controller';

/**
 * 🔴 `/api/public/health` 的 `website` 字段：**公开**反映前台渲染进程是否存活。
 *
 * 修的缺陷：此前本端点的判定只有 `mongo.up ? 'ok' : 'degraded'`，**对前台子进程零感知**
 * （`grep -c "website|3001"` 在这个文件里曾是 0）⇒ 前台永久坏死时，
 * **用它做监控的外部系统一直看到 `ok`**；而 k8s 的 `livenessProbe` 一个容器只能有一个、
 * 它探的就是这个端点 ⇒ **pod 永远不会被重启，用户只看到 502**。
 * 容器层的 HEALTHCHECK 早就另外直接探 3001 了（`Dockerfile` 与 compose 模板都是两个探测合并），
 * 所以这个字段补的是**外部监控与 k8s 单一探针**那两个盲区。
 *
 * ⚠️ 本文件刻意**不**断言 `statusCode` 会因前台坏死而变 503 —— 那是**破坏性变更**，
 * 而三个现有消费方会产生**错误输出**（`vanblog.sh doctor` 把 503 硬编码解读成"mongo 连不上"并建议恢复备份；
 * `vanblog-drill.sh` 用 `code == 200` 当"服务就绪"；`main.ts` 的启动就绪注释声称判据与本端点一致）。
 * 🔴 下面有一条断言专门钉住"状态码仍然只反映 mongo"，这样将来有人改它时会先读到这三处依赖。
 */

jest.mock('src/utils/clusterRole', () => ({
  isPrimaryInstance: jest.fn(() => true),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const clusterRole = require('src/utils/clusterRole') as { isPrimaryInstance: jest.Mock };

/** 造一个"连接正常"的 mongo 替身：ping 立刻成功。 */
function okConn(): any {
  return {
    readyState: 1,
    db: { admin: () => ({ ping: () => Promise.resolve({ ok: 1 }) }) },
  };
}

function resStub(): any {
  return {
    statusCode: 200,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
  };
}

/** 前台替身：🔴 **只暴露产品真正读的那个字段（`ctx`）**，不多给也不给错形状。 */
function websiteStub(hasChild: boolean): any {
  return { ctx: hasChild ? { pid: 4242, kill: () => true } : null };
}

describe('health 的 website 字段：前台存活是公开信息', () => {
  beforeEach(() => {
    clusterRole.isPrimaryInstance.mockReturnValue(true);
    delete process.env.VANBLOG_DISABLE_WEBSITE;
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T00:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
    clusterRole.isPrimaryInstance.mockReturnValue(true);
  });

  it('前台子进程在 ⇒ website=up', async () => {
    const c = new HealthController(okConn(), websiteStub(true));
    const out: any = await c.health({} as any, resStub());
    expect(out.data.website).toBe('up');
  });

  it('🔴 字段在**公开层**：不带内部令牌、也没开 VANBLOG_HEALTH_DETAILS 时仍然出现', async () => {
    const c = new HealthController(okConn(), websiteStub(true));
    const out: any = await c.health({ headers: {} } as any, resStub());
    // 反空转：这一趟确实**没有**拿到详细字段（否则"公开"这个断言就没有意义）
    expect(out.data.details).toBeUndefined();
    expect(out.data.uptimeSeconds).toBeUndefined();
    expect(out.data.memoryRssMb).toBeUndefined();
    // 🔴 而 website 字段必须在
    expect(out.data.website).toBe('up');
    expect(Object.keys(out.data)).toContain('website');
  });

  it('🔴 源码守卫：website 字段必须写在 detailed 展开**之外**（否则盲区会回来）', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, 'health.controller.ts'), 'utf8');
    // 只取 health() 方法体，避免被文件里别处的字面量干扰
    const at = src.indexOf('async health(');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at);
    const websiteAt = body.indexOf('website: this.websiteState()');
    const detailedAt = body.indexOf('...(detailed');
    expect(websiteAt).toBeGreaterThan(0);
    expect(detailedAt).toBeGreaterThan(0);
    // 🔴 关键：字段出现在 detailed 展开**之前**，即它是无条件返回的
    expect(websiteAt).toBeLessThan(detailedAt);
  });

  it('前台不在但未超过宽限窗口 ⇒ starting（正常重启期间不该报 down）', async () => {
    const stub = websiteStub(false);
    const c = new HealthController(okConn(), stub);
    const out: any = await c.health({} as any, resStub());
    expect(out.data.website).toBe('starting');
    // 59 秒后仍然是 starting
    jest.advanceTimersByTime(59 * 1000);
    const out2: any = await c.health({} as any, resStub());
    expect(out2.data.website).toBe('starting');
  });

  it('🔴 超过宽限窗口（60 秒）⇒ down，而窗口一过就稳定报 down（不会来回抖）', async () => {
    const c = new HealthController(okConn(), websiteStub(false));
    await c.health({} as any, resStub());
    jest.advanceTimersByTime(60 * 1000);
    const out: any = await c.health({} as any, resStub());
    expect(out.data.website).toBe('down');
    // 再连续问三次都是 down（不是"偶尔 down"）
    for (let i = 0; i < 3; i += 1) {
      jest.advanceTimersByTime(1000);
      const again: any = await c.health({} as any, resStub());
      expect(again.data.website).toBe('down');
    }
  });

  it('🔴 前台回来后宽限窗口**重置**：下一次短暂消失不会立刻报 down', async () => {
    const stub = websiteStub(false);
    const c = new HealthController(okConn(), stub);
    await c.health({} as any, resStub()); // absentSince 记下
    jest.advanceTimersByTime(30 * 1000);
    stub.ctx = { pid: 1, kill: () => true }; // 前台回来了
    const up: any = await c.health({} as any, resStub());
    expect(up.data.website).toBe('up');
    stub.ctx = null; // 又消失（例如保存站点信息触发重启）
    const again: any = await c.health({} as any, resStub());
    // 🔴 必须是 starting 而不是 down —— 否则"每次保存站点信息都抖一次告警"
    expect(again.data.website).toBe('starting');
  });

  it('VANBLOG_DISABLE_WEBSITE=true ⇒ disabled（无前台模式不是故障）', async () => {
    process.env.VANBLOG_DISABLE_WEBSITE = 'true';
    const c = new HealthController(okConn(), websiteStub(false));
    jest.advanceTimersByTime(10 * 60 * 1000);
    const out: any = await c.health({} as any, resStub());
    expect(out.data.website).toBe('disabled');
  });

  it('🔴 cluster 非 leader worker ⇒ **unknown** 而不是 disabled/down（三者语义必须可区分）', async () => {
    clusterRole.isPrimaryInstance.mockReturnValue(false);
    const c = new HealthController(okConn(), websiteStub(false));
    jest.advanceTimersByTime(10 * 60 * 1000);
    const out: any = await c.health({} as any, resStub());
    // 🔴 不能是 'down'：前台可能正被 leader 好好跑着，报 down 是假故障
    expect(out.data.website).not.toBe('down');
    // 🔴 也不能是 'disabled'：那意味着"这个站按设计没有前台"，而事实是"本进程无从判断"
    expect(out.data.website).not.toBe('disabled');
    expect(out.data.website).toBe('unknown');
  });

  it('🔴 disabled 只属于"按设计没有前台"这一种情形（VANBLOG_DISABLE_WEBSITE=true）', async () => {
    process.env.VANBLOG_DISABLE_WEBSITE = 'true';
    const c = new HealthController(okConn(), websiteStub(true));
    const out: any = await c.health({} as any, resStub());
    // 即使 ctx 存在也报 disabled：本进程被明确告知不要管前台
    expect(out.data.website).toBe('disabled');
  });

  it('拿不到 WebsiteProvider ⇒ unknown，🔴 而且端点绝不能因此 500', async () => {
    const c = new HealthController(okConn());
    const res = resStub();
    const out: any = await c.health({} as any, res);
    expect(out.data.website).toBe('unknown');
    expect(out.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
  });

  it('provider 存在但形状不对（ctx 字段缺失）⇒ 不抛错，按"不在"处理', async () => {
    const c = new HealthController(okConn(), {} as any);
    const out: any = await c.health({} as any, resStub());
    expect(['starting', 'down', 'unknown']).toContain(out.data.website);
  });

  it('🔴 状态码与 status 仍然**只**反映 mongo（前台坏死不改它们）—— 这是刻意的非破坏性取舍', async () => {
    const c = new HealthController(okConn(), websiteStub(false));
    const res = resStub();
    // ⚠️ 必须先问一次再推进时钟：宽限窗口是从"**本端点第一次观察到前台不在**"开始算的，
    //    而不是从"前台真的死掉"开始算 —— 端点在第一次被问之前无从知道它已经死了多久。
    //    🔴 这是一个真实的语义事实（不是测试的权宜）：若前台在第一次探测之前就已坏死，
    //    监控方会先看到一个 `starting`、60 秒后才转 `down`。
    await c.health({} as any, res);
    jest.advanceTimersByTime(10 * 60 * 1000); // 前台确实 down 了
    const out: any = await c.health({} as any, res);
    expect(out.data.website).toBe('down');
    // ⚠️ 下面四条钉住的是"还没有做那半个破坏性变更"这件事本身。
    //    🔴 如果将来要改，必须同一次改 `vanblog.sh doctor`（它把 503 解读成 mongo 连不上并建议恢复备份）、
    //    `vanblog-drill.sh`（它用 code==200 当"服务就绪"）与 `main.ts` 那句"判据与本端点完全一致"的注释。
    expect(out.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
    expect(out.data.status).toBe('ok');
    expect(out.data.mongo).toBe('up');
  });

  it('mongo 挂而前台正常 ⇒ degraded + 503，且 website 仍然是 up（两个维度互不掩盖）', async () => {
    const badConn: any = {
      readyState: 0,
      db: { admin: () => ({ ping: () => Promise.reject(new Error('连不上')) }) },
    };
    const c = new HealthController(badConn, websiteStub(true));
    const res = resStub();
    const out: any = await c.health({} as any, res);
    expect(out.data.mongo).toBe('down');
    expect(out.data.status).toBe('degraded');
    expect(out.statusCode).toBe(503);
    expect(res.statusCode).toBe(503);
    expect(out.data.website).toBe('up');
  });

  it('反空转：取值集合就是文档里那五个，多一个少一个都算契约变了', async () => {
    const seen = new Set<string>();
    const c1 = new HealthController(okConn(), websiteStub(true));
    seen.add((await c1.health({} as any, resStub())).data.website);

    jest.useRealTimers();
    const c2 = new HealthController(okConn(), websiteStub(false));
    seen.add((await c2.health({} as any, resStub())).data.website);
    // 直接推进内部时钟跨过宽限窗口
    (c2 as any).websiteAbsentSince = Date.now() - 10 * 60 * 1000;
    seen.add((await c2.health({} as any, resStub())).data.website);
    jest.useFakeTimers();

    process.env.VANBLOG_DISABLE_WEBSITE = 'true';
    const c3 = new HealthController(okConn(), websiteStub(false));
    seen.add((await c3.health({} as any, resStub())).data.website);
    delete process.env.VANBLOG_DISABLE_WEBSITE;

    clusterRole.isPrimaryInstance.mockReturnValue(false);
    const c4 = new HealthController(okConn(), websiteStub(false));
    seen.add((await c4.health({} as any, resStub())).data.website);
    clusterRole.isPrimaryInstance.mockReturnValue(true);

    const c5 = new HealthController(okConn());
    seen.add((await c5.health({} as any, resStub())).data.website);

    expect([...seen].sort()).toEqual(['disabled', 'down', 'starting', 'unknown', 'up']);
  });
});
