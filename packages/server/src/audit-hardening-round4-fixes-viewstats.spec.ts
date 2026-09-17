import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ViewStatsAggregator,
  resolveMaxNewPathsPerDay,
  DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY,
  VIEW_MAX_NEW_PATHS_PER_DAY_ENV,
} from './utils/viewStatsBuffer';
import { RETENTION_DEFAULTS } from './provider/stats/statsMaintenance.provider';

/**
 * 第四轮安全审计修复钉子（浏览统计那一组）：B3 ——
 *  (a) visits/viewers 的保留期默认从「永不删除」改成 **365 天**
 *      （⚠️ 默认行为变更：只删按天的行，站点级累计与文章累计阅读量不受影响；
 *        显式 `VANBLOG_VISIT_RETENTION_DAYS=0` 是逃生口）；
 *  (b) `ViewStatsAggregator` 给「**每天新建多少个路径键**」封顶
 *      （`VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY`，默认 5000，0 = 不限）：
 *      匿名 `POST /api/public/viewer` 用编造路径灌 visits 的永久增长被封住，
 *      取舍与 §7.55 G-2 完全一致 —— 站点级与每日累计一条不丢，
 *      丢的只是攻击者编造路径的按天明细，且计入 dropped、由 provider
 *      每轮 flush 最多一条 WARN（带增量与累计），绝不静默。
 *
 * 进程内纯逻辑断言；真库的行数增长/清理测量在 test/audit-fixes-comment.e2e-spec.ts。
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

const ENV = VIEW_MAX_NEW_PATHS_PER_DAY_ENV;
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

const ev = (
  pathname: string,
  opts: { isNewVisitor?: boolean; isNewForPath?: boolean; date?: string } = {},
) => ({
  pathname,
  isNewVisitor: !!opts.isNewVisitor,
  isNewForPath: !!opts.isNewForPath,
  date: opts.date || '2026-09-17',
});

describe('FIX B3(a)：保留期默认 365 天（默认行为变更）', () => {
  it('RETENTION_DEFAULTS 翻新，minKeepDays=30 的兜底没动', () => {
    expect(RETENTION_DEFAULTS).toEqual({ retentionDays: 365, minKeepDays: 30 });
  });

  it('源码钉子：env 读取形状不变、注释里写明这是默认行为变更、显式 0 是逃生口', () => {
    const src = read('./provider/stats/statsMaintenance.provider.ts');
    // anonymous-writes 的 FINDING 钉子钉住的读取形状原样保留（只是默认值变了）
    expect(src).toMatch(/'VANBLOG_VISIT_RETENTION_DAYS',\s*\n\s*RETENTION_DEFAULTS\.retentionDays/);
    expect(src).toMatch(/export const RETENTION_DEFAULTS = \{ retentionDays: 365, minKeepDays: 30 \};/);
    expect(src).toContain('默认行为变更');
    expect(src).toContain('VANBLOG_VISIT_RETENTION_DAYS=0');
  });

  it('pruneStats/planRetention 的实现一个字节都没动（本修复只翻默认值）', () => {
    const src = read('./provider/stats/statsMaintenance.provider.ts');
    // pruneStats 仍然：plan.enabled=false 时记台账 skipped 并返回 0；enabled 时 deleteMany + 台账 ok
    expect(src).toMatch(/const plan: RetentionPlan = planRetention\(/);
    expect(src).toMatch(/this\.visitModel\.deleteMany\(plan\.filter as any\)/);
    expect(src).toMatch(/key: LEDGER_KEYS\.pruneStats,\s*\n\s*kind: 'prune',\s*\n\s*outcome: 'ok',/);
    // 纯函数侧：minKeepDays 兜底与「date 为 null/缺失的行不被顺手删掉」的过滤器形状都在 utils 里，
    // 由 utils/statsMaintenance.spec.ts 与 test/stats-maintenance.e2e-spec.ts（真 mongod）钉住
    expect(read('./utils/statsMaintenance.ts')).toMatch(
      /const effectiveDays = Math\.max\(retentionDays, minKeepDays\);/,
    );
  });
});

describe('FIX B3(b)：每日新路径键上限（VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY）', () => {
  it('resolveMaxNewPathsPerDay：非法值回落默认 5000，显式 0 = 不限，空串按未设置处理', () => {
    expect(DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY).toBe(5000);
    expect(resolveMaxNewPathsPerDay(undefined)).toBe(5000);
    expect(resolveMaxNewPathsPerDay('abc')).toBe(5000);
    expect(resolveMaxNewPathsPerDay('')).toBe(5000); // fail-open 的方向必须是默认封顶，不是不限
    expect(resolveMaxNewPathsPerDay('-5')).toBe(5000);
    expect(resolveMaxNewPathsPerDay(Infinity)).toBe(5000);
    expect(resolveMaxNewPathsPerDay('0')).toBe(0);
    expect(resolveMaxNewPathsPerDay(0)).toBe(0);
    expect(resolveMaxNewPathsPerDay('7.9')).toBe(7);
  });

  it('默认（env 未设）就是 5000：第 5001 个新路径不再建行，但站点级与每日累计一条不丢', () => {
    const a = new ViewStatsAggregator();
    const N = 5100;
    for (let i = 0; i < N; i += 1) {
      a.add(ev(`/fake-page-number-${i}`, { isNewVisitor: true, isNewForPath: true }));
    }
    const batch = a.take();
    expect(batch.days[0].paths.size).toBe(5000); // ← 磁盘侧被封住：只建 5000 行
    expect(a.dropped.pathEntries).toBe(100);
    expect(a.dropped.newPathEntries).toBe(100);
    // 站点级累计（metas 的 $inc）与每日累计（viewers 快照的不变量）分毫不差
    expect(batch.site).toEqual({ viewer: N, visited: N });
    expect(batch.days[0].site).toEqual({ viewer: N, visited: N });
    expect(batch.events).toBe(N);
  });

  it('env 覆盖：=10 就只建 10 行；=0 回到旧行为（不限）；显式选项优先于 env', () => {
    process.env[ENV] = '10';
    const small = new ViewStatsAggregator();
    for (let i = 0; i < 25; i += 1) small.add(ev(`/p-${i}`));
    expect(small.take().days[0].paths.size).toBe(10);
    expect(small.dropped.pathEntries).toBe(15);

    process.env[ENV] = '0';
    const unlimited = new ViewStatsAggregator();
    for (let i = 0; i < 25; i += 1) unlimited.add(ev(`/p-${i}`));
    expect(unlimited.take().days[0].paths.size).toBe(25);
    expect(unlimited.dropped.pathEntries).toBe(0);

    process.env[ENV] = '10';
    const overridden = new ViewStatsAggregator({ maxNewPathsPerDay: 0 });
    for (let i = 0; i < 25; i += 1) overridden.add(ev(`/p-${i}`));
    expect(overridden.take().days[0].paths.size).toBe(25);
  });

  it('跨 take() 记账：同一天里已建过行的路径再来**不消耗预算**（上限封的是"新建行数"）', () => {
    const a = new ViewStatsAggregator({ maxNewPathsPerDay: 2 });
    a.add(ev('/p1'));
    a.add(ev('/p2'));
    const first = a.take();
    expect(first.days[0].paths.size).toBe(2);
    // 模拟 flush 成功后同一天又来浏览：/p1 的行已经建过，只是 $inc
    a.add(ev('/p1'));
    a.add(ev('/p2'));
    const second = a.take();
    expect(second.days[0].paths.size).toBe(2); // 都放行，没有消耗预算
    expect(a.dropped.pathEntries).toBe(0);
    // 第 3 个新路径才触发上限
    a.add(ev('/p3'));
    expect(a.take().days[0].paths.size).toBe(0);
    expect(a.dropped.pathEntries).toBe(1);
    expect(a.dropped.newPathEntries).toBe(1);
    // 站点级累计始终精确
    expect(a.pendingSite()).toEqual({ viewer: 0, visited: 0 });
  });

  it('按天分预算：跨零点后新的一天重新装满；各天 site 之和 === batch.site 的不变量保持', () => {
    const a = new ViewStatsAggregator({ maxNewPathsPerDay: 2 });
    a.add(ev('/d1-a', { date: '2026-09-16' }));
    a.add(ev('/d1-b', { date: '2026-09-16' }));
    a.add(ev('/d1-c', { date: '2026-09-16' })); // 丢
    a.add(ev('/d2-a', { date: '2026-09-17' }));
    a.add(ev('/d2-b', { date: '2026-09-17' }));
    a.add(ev('/d2-c', { date: '2026-09-17' })); // 丢
    const batch = a.take();
    expect(batch.days.map((d) => d.date)).toEqual(['2026-09-16', '2026-09-17']);
    expect(batch.days[0].paths.size).toBe(2);
    expect(batch.days[1].paths.size).toBe(2);
    expect(batch.days[0].site.viewer).toBe(3); // 被丢路径的浏览仍然计入当天累计
    expect(batch.days[1].site.viewer).toBe(3);
    expect(batch.site.viewer).toBe(6);
    expect(batch.days.reduce((s, d) => s + d.site.viewer, 0)).toBe(batch.site.viewer);
    expect(a.dropped.pathEntries).toBe(2);
  });

  it('seen 表有界：只保留最近 2 个日期（内存上界 = 2 × cap × 路径长）', () => {
    const a = new ViewStatsAggregator({ maxNewPathsPerDay: 5 });
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']) {
      for (let i = 0; i < 5; i += 1) a.add(ev(`/${date}-${i}`, { date }));
    }
    const seen = (a as any).seenPaths as Map<string, Set<string>>;
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(seen.has('2026-09-17')).toBe(true);
    expect(seen.has('2026-09-16')).toBe(true);
    expect(seen.has('2026-09-14')).toBe(false);
  });

  it('merge() 退回不消耗也不触发每日上限（已收下的计数绝不静默丢）', () => {
    const a = new ViewStatsAggregator({ maxNewPathsPerDay: 2 });
    a.add(ev('/p1'));
    a.add(ev('/p2'));
    a.add(ev('/p3')); // 被每日上限丢掉
    expect(a.dropped.pathEntries).toBe(1);
    const batch = a.take();
    // 模拟写库失败整批退回（provider 的真实形状：events 记 0）
    a.merge({ ...batch, events: 0 });
    expect(a.dropped.pathEntries).toBe(1); // merge 没有额外丢任何东西
    expect(a.retainedKeys()).toBe(2);
    expect(a.pendingSite()).toEqual({ viewer: 3, visited: 0 });
    const again = a.take();
    expect(again.days[0].paths.size).toBe(2);
    expect(again.days[0].paths.has('/p1')).toBe(true);
    expect(again.days[0].paths.has('/p2')).toBe(true);
  });

  it('文章键不受每日路径上限管（编造的 /post/x 不会建行，内存侧由 maxRetainedKeys 封）', () => {
    const a = new ViewStatsAggregator({ maxNewPathsPerDay: 1 });
    a.add(ev('/post/aaa'));
    a.add(ev('/post/bbb'));
    const batch = a.take();
    expect(batch.articles.size).toBe(2); // flushArticles 是 updateOne：匹配不到就什么都不写
    expect(batch.days[0].paths.size).toBe(1); // visits 行才是存储风险，被封住的是它
    expect(a.dropped.pathEntries).toBe(1);
    expect(a.dropped.newPathEntries).toBe(1);
  });

  it('与 maxRetainedKeys 互不干扰：两把上限可以同时生效', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 10, maxNewPathsPerDay: 50 });
    for (let i = 0; i < 100; i += 1) a.add(ev(`/p-${i}`));
    expect(a.retainedKeys()).toBeLessThanOrEqual(10); // 内存侧
    expect(a.dropped.pathEntries).toBeGreaterThanOrEqual(90); // 50 被每日上限丢 + ≥40 被内存上限丢
    expect(a.dropped.newPathEntries).toBe(50);
    expect(a.pendingSite().viewer).toBe(100); // 站点级永不丢
  });

  it('护栏本身有量（§7.55 G-2 的教训）：20 万次 add（混合重复+新路径）在 5 秒内完成', () => {
    const a = new ViewStatsAggregator(); // 默认 5000
    const t0 = Date.now();
    for (let i = 0; i < 200_000; i += 1) {
      // 90% 重复（真实站点的形状），10% 新路径（攻击形状）
      const pathname = i % 10 === 0 ? `/new-${i}` : `/hot-${i % 2000}`;
      a.add(ev(pathname));
    }
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[B3b] 20 万次 add（每日上限生效中）：${ms} ms`);
    expect(ms).toBeLessThan(5000);
    expect(a.pendingSite().viewer).toBe(200_000);
  });

  it('绝不静默：新的丢弃计入 provider 既有的每轮 flush 一条 WARN 的机制', () => {
    // dropped.pathEntries 是 provider reportDropped() 读的那两个计数之一（只读钉子，
    // viewStats.provider.ts 不在本轮改动范围）：新路径丢弃会走同一条 WARN，
    // 带增量与累计；细分计数 newPathEntries 供排障区分是哪把上限在丢。
    const src = read('./provider/stats/viewStats.provider.ts');
    expect(src).toMatch(/const dropped = this\.aggregator\.dropped;/);
    expect(src).toMatch(/dropped\.pathEntries - this\.lastReportedDropped\.pathEntries/);
    expect(src).toMatch(/this\.logger\.warn\(/);
    const buf = read('./utils/viewStatsBuffer.ts');
    expect(buf).toMatch(/newPathEntries: number;/);
  });
});
