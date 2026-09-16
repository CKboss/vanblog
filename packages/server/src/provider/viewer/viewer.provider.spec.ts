import dayjs from 'dayjs';
import { ViewerProvider } from './viewer.provider';

/**
 * `getViewerGrid` 的 N+1 修复：num+1 次串行 findOne → 一次 `$in` 查询。
 *
 * 响应形状是后台趋势图直接消费的（total 升序、缺失天整条跳过、each 是相邻
 * **存在**天的差值、今天没数据时拿昨天顶上），所以这里不是"看着差不多"就行：
 * 把**旧算法逐字抄一份**当参照实现，用同一批种子数据分别喂两个实现，
 * 输出必须 deep-equal；同时钉住查询次数（旧 = num+1 次 findOne，新 = 1 次 find）。
 */

type Row = { date: string; viewer: number; visited: number };

/** 旧实现（改动前的 getViewerGrid 逐字拷贝，只把数据来源换成注入的 findOne） */
async function legacyGetViewerGrid(findOne: (date: string) => Promise<Row | null>, num: number) {
  const curDate = dayjs();
  const gridTotal: any[] = [];
  const tmpArr: any[] = [];
  const today = { viewer: 0, visited: 0 };
  const lastDay = { viewer: 0, visited: 0 };
  for (let i = num; i >= 0; i--) {
    const last = curDate.add(-1 * i, 'day').format('YYYY-MM-DD');
    const lastDayData = await findOne(last);
    if (i == 0) {
      if (lastDayData) {
        today.viewer = lastDayData.viewer;
        today.visited = lastDayData.visited;
      }
    }
    if (i == 1) {
      if (lastDayData) {
        lastDay.viewer = lastDayData.viewer;
        lastDay.visited = lastDayData.visited;
      }
      if (today.viewer == 0) {
        today.viewer = lastDayData?.viewer || 0;
        today.visited = lastDayData?.visited || 0;
      }
    }
    if (lastDayData) {
      tmpArr.push({ date: last, visited: lastDayData.visited, viewer: lastDayData.viewer });
      if (i != num + 1) {
        gridTotal.push({ date: last, visited: lastDayData.visited, viewer: lastDayData.viewer });
      }
    }
  }
  const gridEachDay: any[] = [];
  let pre = tmpArr[0];
  for (let i = 1; i < tmpArr.length; i++) {
    const curObj = tmpArr[i];
    if (curObj) {
      if (pre) {
        gridEachDay.push({
          date: curObj.date,
          visited: curObj.visited - pre.visited,
          viewer: curObj.viewer - pre.viewer,
        });
      } else {
        gridEachDay.push({ date: curObj.date, visited: curObj.visited, viewer: curObj.viewer });
      }
    }
    pre = curObj;
  }
  return {
    grid: { total: gridTotal, each: gridEachDay },
    add: { viewer: today.viewer - lastDay.viewer, visited: today.visited - lastDay.visited },
    now: { viewer: today.viewer, visited: today.visited },
  };
}

function createFakeViewerModel(docs: Row[]) {
  const calls = { findOne: 0, find: 0, lastIn: null as string[] | null, sorted: false };
  const byDate = new Map(docs.map((d) => [d.date, d]));
  const model: any = {
    findOne: (filter: any) => ({
      exec: async () => {
        calls.findOne += 1;
        return byDate.get(filter?.date) ?? null;
      },
    }),
    find: (filter: any) => {
      calls.find += 1;
      const dates: string[] = filter?.date?.$in ?? [];
      calls.lastIn = dates;
      const rows = docs
        .filter((d) => dates.includes(d.date))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        sort: (spec: any) => {
          if (spec && spec.date === 1) calls.sorted = true;
          return { exec: async () => rows };
        },
      };
    },
  };
  return { model, calls };
}

/** 相对"今天"的第 -offset 天 */
const day = (offset: number) => dayjs().add(offset, 'day').format('YYYY-MM-DD');

describe('ViewerProvider.getViewerGrid：一次 $in 查询替代 N+1', () => {
  beforeEach(() => {
    // 固定系统时间，避免测试恰好跨过午夜时两套实现的"今天"不一致
    jest.useFakeTimers().setSystemTime(new Date('2026-09-16T04:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function compare(rows: Row[], num: number) {
    const fake = createFakeViewerModel(rows);
    const provider = new ViewerProvider(fake.model);
    const [actual, expected] = await Promise.all([
      provider.getViewerGrid(num),
      legacyGetViewerGrid((date) => fake.model.findOne({ date }).exec(), num),
    ]);
    expect(actual).toEqual(expected);
    return { actual, fake };
  }

  const full = (n: number): Row[] =>
    Array.from({ length: n + 1 }, (_, k) => ({
      date: day(k - n),
      viewer: 100 + k * 7 + (k % 3),
      visited: 300 + k * 11,
    }));

  it('连续 6 天全有数据：输出与旧算法逐字段一致；查询从 31 次 findOne 降到 1 次 find', async () => {
    const rows = full(30);
    const { actual, fake } = await compare(rows, 30);
    expect(fake.calls.find).toBe(1);
    expect(fake.calls.findOne).toBe(31); // 全部来自参照实现（旧算法逐天 31 次）
    expect(fake.calls.sorted).toBe(true);
    expect(actual.grid.total).toHaveLength(31);
    expect(actual.grid.each).toHaveLength(30);
    // total 升序、最后一天是今天
    expect(actual.grid.total[0].date).toBe(day(-30));
    expect(actual.grid.total[30].date).toBe(day(0));
  });

  it('缺失天：整条跳过，each 是相邻存在天的差值（旧语义原样保留）', async () => {
    const rows: Row[] = [
      { date: day(-5), viewer: 10, visited: 40 },
      { date: day(-3), viewer: 18, visited: 55 },
      { date: day(-1), viewer: 25, visited: 61 },
      { date: day(0), viewer: 29, visited: 66 },
    ];
    const { actual } = await compare(rows, 5);
    expect(actual.grid.total.map((d: any) => d.date)).toEqual([day(-5), day(-3), day(-1), day(0)]);
    // each 对 (-5→-3)、(-3→-1)、(-1→今天) 做差
    expect(actual.grid.each).toEqual([
      { date: day(-3), visited: 15, viewer: 8 },
      { date: day(-1), visited: 6, viewer: 7 },
      { date: day(0), visited: 5, viewer: 4 },
    ]);
    expect(actual.now).toEqual({ viewer: 29, visited: 66 });
    expect(actual.add).toEqual({ viewer: 4, visited: 5 });
  });

  it('今天没数据：today 拿昨天的顶上，add 全是 0（旧语义）', async () => {
    const rows: Row[] = [
      { date: day(-2), viewer: 5, visited: 20 },
      { date: day(-1), viewer: 9, visited: 24 },
    ];
    const { actual } = await compare(rows, 5);
    expect(actual.now).toEqual({ viewer: 9, visited: 24 });
    expect(actual.add).toEqual({ viewer: 0, visited: 0 });
    expect(actual.grid.total.map((d: any) => d.date)).toEqual([day(-2), day(-1)]);
  });

  it('今天有数据但 viewer=0：i==0 的覆盖发生在 i==1 的兜底之后（旧的执行顺序原样保留）', async () => {
    const rows: Row[] = [
      { date: day(-1), viewer: 9, visited: 24 },
      { date: day(0), viewer: 0, visited: 24 },
    ];
    const { actual } = await compare(rows, 5);
    expect(actual.now).toEqual({ viewer: 0, visited: 24 });
    expect(actual.add).toEqual({ viewer: -9, visited: 0 });
  });

  it('昨天今天都没数据：全 0', async () => {
    const rows: Row[] = [{ date: day(-4), viewer: 3, visited: 8 }];
    const { actual } = await compare(rows, 5);
    expect(actual.now).toEqual({ viewer: 0, visited: 0 });
    expect(actual.add).toEqual({ viewer: 0, visited: 0 });
  });

  it('num=0 / NaN / 负数：与旧算法一致（空 grid、全 0）', async () => {
    const rows = full(3);
    for (const num of [0, NaN, -3]) {
      // num=0 时今天有数据，now 是今天的值；NaN/负数时循环一次都不跑
      await compare(rows, num);
    }
    const zero = await compare(rows, 0);
    expect(zero.actual.grid.total).toHaveLength(1);
    const nan = await compare(rows, NaN);
    expect(nan.actual.grid.total).toEqual([]);
    expect(nan.fake.calls.find).toBe(0); // 空日期列表连查询都不发
  });

  it('$in 的日期列表就是旧循环会逐天查的那一串（升序、num+1 个）', async () => {
    const fake = createFakeViewerModel(full(5));
    const provider = new ViewerProvider(fake.model);
    await provider.getViewerGrid(5);
    expect(fake.calls.lastIn).toEqual([day(-5), day(-4), day(-3), day(-2), day(-1), day(0)]);
  });

  it('provider 自己一次 findOne 都不发（N+1 已消失）', async () => {
    const fake = createFakeViewerModel(full(5));
    const provider = new ViewerProvider(fake.model);
    await provider.getViewerGrid(5);
    expect(fake.calls.findOne).toBe(0);
    expect(fake.calls.find).toBe(1);
  });

  it('findByDate 保留（仍是公开方法，行为不变）', async () => {
    const rows = full(2);
    const fake = createFakeViewerModel(rows);
    const provider = new ViewerProvider(fake.model);
    await expect(provider.findByDate(day(-1))).resolves.toEqual(rows[1]);
    await expect(provider.findByDate('1999-01-01')).resolves.toBeNull();
  });
});
