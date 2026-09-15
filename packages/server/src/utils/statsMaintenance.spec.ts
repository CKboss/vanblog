import dayjs from 'dayjs';
import { mergeVisitGroup, planRetention, RETENTION_FLOOR, VisitLike } from './statsMaintenance';

/**
 * `visits` 重复行合并 + 统计保留期的**边界**测试。
 *
 * 两个都是纯函数，所以边界可以逐个钉死：
 *  - 合并为什么取 max 而不是求和（visits 存的是累计值，求和会把阅读量翻倍）；
 *  - 保留期为什么"含今天"、为什么设成 1 天也删不掉最近 30 天、为什么默认 0 就一行都不删。
 */

const row = (over: Partial<VisitLike> = {}): VisitLike => ({
  _id: 'a',
  date: '2026-02-28',
  pathname: '/',
  viewer: 1,
  visited: 1,
  lastVisitedTime: new Date('2026-02-28T00:00:00.000Z'),
  createdAt: new Date('2026-02-28T00:00:00.000Z'),
  ...over,
});

describe('mergeVisitGroup：重复行怎么合并', () => {
  it('本机真实的那一对重复行（2270 / 2266）合并成 2270，不是 4536', () => {
    // 这两行是线上实测到的：createdAt 相差 9 毫秒，正是并发首访的指纹
    const docs = [
      row({
        _id: 'older',
        viewer: 2266,
        visited: 898,
        lastVisitedTime: new Date('2026-02-28T01:12:06.538Z'),
        createdAt: new Date('2026-02-28T01:12:06.538Z'),
      }),
      row({
        _id: 'newer',
        viewer: 2270,
        visited: 898,
        lastVisitedTime: new Date('2026-02-28T15:42:24.345Z'),
        createdAt: new Date('2026-02-28T01:12:06.529Z'),
      }),
    ];
    const merged = mergeVisitGroup(docs)!;
    expect(merged.patch.viewer).toBe(2270);
    expect(merged.patch.visited).toBe(898);
    // keeper = lastVisitedTime 最新的那一行
    expect(merged.keeperId).toBe('newer');
    expect(merged.dropIds).toEqual(['older']);
    expect(merged.patch.lastVisitedTime).toEqual(new Date('2026-02-28T15:42:24.345Z'));
    // createdAt 取最早的（这一行"什么时候开始记的"不该因为合并而变晚）
    expect(merged.patch.createdAt).toEqual(new Date('2026-02-28T01:12:06.529Z'));
    // 这一对里 keeper（lastVisitedTime 最新的那行）本身就带着最大值 => 只需要删掉多余那行，
    // 连一次 updateOne 都不必发
    expect(merged.changed).toBe(false);
  });

  it('viewer 与 visited 各自独立取 max（两行各自拿到了一部分自增）', () => {
    const merged = mergeVisitGroup([
      row({ _id: 'x', viewer: 624, visited: 221 }),
      row({ _id: 'y', viewer: 623, visited: 222 }),
    ])!;
    expect(merged.patch).toMatchObject({ viewer: 624, visited: 222 });
  });

  it('合并是幂等的：拿合并结果再合并一次，值不变', () => {
    const docs = [
      row({ _id: 'x', viewer: 10, visited: 3 }),
      row({ _id: 'y', viewer: 7, visited: 5 }),
    ];
    const first = mergeVisitGroup(docs)!;
    const again = mergeVisitGroup([
      { ...docs[0], viewer: first.patch.viewer, visited: first.patch.visited },
    ])!;
    expect(again.patch.viewer).toBe(first.patch.viewer);
    expect(again.patch.visited).toBe(first.patch.visited);
    expect(again.dropIds).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it('多进程各自独立跑也会选中同一个 keeper（排序有确定的 tie-break）', () => {
    const same = {
      viewer: 5,
      visited: 5,
      lastVisitedTime: new Date('2026-02-28T00:00:00.000Z'),
      createdAt: new Date('2026-02-28T00:00:00.000Z'),
    };
    const a = mergeVisitGroup([row({ _id: 'aaa', ...same }), row({ _id: 'bbb', ...same })])!;
    const b = mergeVisitGroup([row({ _id: 'bbb', ...same }), row({ _id: 'aaa', ...same })])!;
    expect(a.keeperId).toBe(b.keeperId);
    expect(a.keeperId).toBe('bbb');
  });

  it('只有一行 / 空数组都不该动数据', () => {
    const single = mergeVisitGroup([row()])!;
    expect(single.dropIds).toEqual([]);
    expect(single.changed).toBe(false);
    expect(mergeVisitGroup([])).toBeNull();
    expect(mergeVisitGroup(undefined as any)).toBeNull();
  });

  it('字段缺失按 0 算，lastVisitedTime 是字符串也能比', () => {
    const merged = mergeVisitGroup([
      { _id: 'x', date: '2026-01-01', pathname: '/' },
      { _id: 'y', date: '2026-01-01', pathname: '/', viewer: 4, lastVisitedTime: '2026-01-02T00:00:00Z' },
    ])!;
    expect(merged.patch.viewer).toBe(4);
    expect(merged.patch.visited).toBe(0);
    expect(merged.keeperId).toBe('y');
  });

  it('keeper 已经带着合并后的值时 changed=false（重跑不会白发一次 updateOne）', () => {
    const merged = mergeVisitGroup([
      row({ _id: 'x', viewer: 10, visited: 3, lastVisitedTime: new Date('2026-02-28T05:00:00Z') }),
      row({ _id: 'y', viewer: 4, visited: 1, lastVisitedTime: new Date('2026-02-28T01:00:00Z') }),
    ])!;
    expect(merged.keeperId).toBe('x');
    expect(merged.changed).toBe(false);
  });

  it('keeper 不是最大值持有者时 changed=true（这一行必须被写回）', () => {
    const merged = mergeVisitGroup([
      row({ _id: 'x', viewer: 4, visited: 1, lastVisitedTime: new Date('2026-02-28T05:00:00Z') }),
      row({ _id: 'y', viewer: 10, visited: 3, lastVisitedTime: new Date('2026-02-28T01:00:00Z') }),
    ])!;
    expect(merged.keeperId).toBe('x');
    expect(merged.patch.viewer).toBe(10);
    expect(merged.changed).toBe(true);
  });
});

describe('planRetention：删哪些天', () => {
  const NOW = new Date('2026-09-16T12:00:00+08:00');
  const DEFAULTS = { retentionDays: 0, minKeepDays: 30 };

  it('默认 0 = 一行都不删（不给用户偷偷改行为）', () => {
    const plan = planRetention({ retentionDays: 0, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.enabled).toBe(false);
    expect(plan.filter).toBeNull();
    expect(plan.cutoff).toBeNull();
  });

  it('保留期含今天：90 天 => cutoff 是今天往前数第 90 天', () => {
    const plan = planRetention({ retentionDays: 90, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.enabled).toBe(true);
    expect(plan.effectiveDays).toBe(90);
    expect(plan.cutoff).toBe('2026-06-19');
    // 边界本身：cutoff 当天要留下，前一天要删掉
    expect(dayjs('2026-06-19').isBefore(dayjs(plan.cutoff!), 'day')).toBe(false);
    expect(dayjs('2026-06-18').isBefore(dayjs(plan.cutoff!), 'day')).toBe(true);
    expect(plan.filter).toEqual({ date: { $gte: RETENTION_FLOOR, $lt: '2026-06-19' } });
  });

  it('保留期比"最少保留天数"短时，以最少保留天数为准', () => {
    const plan = planRetention({ retentionDays: 7, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.effectiveDays).toBe(30);
    expect(plan.cutoff).toBe('2026-08-18');
  });

  it('保留期设成 1 天也删不掉最近 30 天', () => {
    const plan = planRetention({ retentionDays: 1, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.effectiveDays).toBe(30);
    expect(plan.cutoff).toBe('2026-08-18');
  });

  it('保留期长于最少天数时按保留期来', () => {
    const plan = planRetention({ retentionDays: 365, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.effectiveDays).toBe(365);
    expect(plan.cutoff).toBe('2025-09-17');
  });

  it('非法值（NaN / 负数 / 小数 / 缺省）回落到默认，绝不把 NaN 交给 Mongo', () => {
    for (const bad of [NaN, -5, undefined, null, 'abc' as any]) {
      const plan = planRetention(
        { retentionDays: bad as any, minKeepDays: bad as any, now: NOW },
        DEFAULTS,
      );
      expect(plan.enabled).toBe(false);
      expect(plan.filter).toBeNull();
    }
    const fractional = planRetention(
      { retentionDays: 10.9, minKeepDays: 30, now: NOW },
      DEFAULTS,
    );
    expect(fractional.effectiveDays).toBe(30);
    expect(Number.isFinite(dayjs(fractional.cutoff!).valueOf())).toBe(true);
  });

  it('minKeepDays 至少是 1（设成 0 也不会把今天的行删掉）', () => {
    const plan = planRetention({ retentionDays: 1, minKeepDays: 0, now: NOW }, DEFAULTS);
    expect(plan.effectiveDays).toBe(1);
    expect(plan.cutoff).toBe('2026-09-16');
    // 今天这一行不满足 date < cutoff，所以不会被删
    expect(dayjs('2026-09-16').isBefore(dayjs(plan.cutoff!), 'day')).toBe(false);
  });

  it('过滤条件带字符串下界：date 缺失/为 null 的行不会被顺手删掉', () => {
    const plan = planRetention({ retentionDays: 30, minKeepDays: 30, now: NOW }, DEFAULTS);
    expect(plan.filter).toEqual({ date: { $gte: '0000-00-00', $lt: plan.cutoff } });
    // BSON 里 null 排在所有字符串前面，只写 $lt 会把 date 缺失的行一起删掉
    expect(RETENTION_FLOOR).toBe('0000-00-00');
  });
});
