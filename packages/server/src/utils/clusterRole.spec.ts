import {
  CLUSTER_ENV,
  configuredWorkerCount,
  isPrimaryInstance,
  MAX_CLUSTER_WORKERS,
  resolveClusterWorkers,
  scaleLimit,
} from './clusterRole';

/**
 * 多进程守卫的纯逻辑：worker 数解析、"我是不是主实例"、以及**按进程摊薄**的限流预算。
 * 默认（不设 VANBLOG_CLUSTER_WORKERS）必须处处等价于今天的单进程行为。
 */

describe('resolveClusterWorkers', () => {
  it('缺省 / 空串 / null 都是 1（= 今天的行为）', () => {
    expect(resolveClusterWorkers(undefined, 8)).toBe(1);
    expect(resolveClusterWorkers(null, 8)).toBe(1);
    expect(resolveClusterWorkers('', 8)).toBe(1);
    expect(resolveClusterWorkers('   ', 8)).toBe(1);
  });

  it('正整数照用，小数向下取整', () => {
    expect(resolveClusterWorkers('4', 8)).toBe(4);
    expect(resolveClusterWorkers(2, 8)).toBe(2);
    expect(resolveClusterWorkers('2.9', 8)).toBe(2);
  });

  it('0 / 负数 / 非法值一律回落到 1（绝不能 fork 出 0 个或 NaN 个 worker）', () => {
    expect(resolveClusterWorkers('0', 8)).toBe(1);
    expect(resolveClusterWorkers('-3', 8)).toBe(1);
    expect(resolveClusterWorkers('abc', 8)).toBe(1);
    expect(resolveClusterWorkers(NaN, 8)).toBe(1);
    expect(resolveClusterWorkers({}, 8)).toBe(1);
  });

  it('max / cpus / auto 按核数开，并且有硬上限', () => {
    expect(resolveClusterWorkers('max', 4)).toBe(4);
    expect(resolveClusterWorkers('CPUS', 6)).toBe(6);
    expect(resolveClusterWorkers('auto', 1)).toBe(1);
    expect(resolveClusterWorkers('max', 128)).toBe(MAX_CLUSTER_WORKERS);
  });

  it('超过硬上限会被夹住；核数拿不到时按 1 算', () => {
    expect(resolveClusterWorkers('999', 8)).toBe(MAX_CLUSTER_WORKERS);
    expect(resolveClusterWorkers('max', 0)).toBe(1);
    expect(resolveClusterWorkers('max', NaN)).toBe(1);
  });

  it('configuredWorkerCount 读的就是 VANBLOG_CLUSTER_WORKERS', () => {
    expect(configuredWorkerCount({})).toBe(1);
    expect(configuredWorkerCount({ [CLUSTER_ENV]: '3' } as any)).toBe(3);
    expect(configuredWorkerCount({ [CLUSTER_ENV]: 'nope' } as any)).toBe(1);
  });
});

describe('isPrimaryInstance', () => {
  it('非 cluster 启动（今天的常态）时是 true —— 守卫等于不存在', () => {
    expect(isPrimaryInstance()).toBe(true);
    expect(isPrimaryInstance({ isPrimary: true, isWorker: false })).toBe(true);
    expect(isPrimaryInstance({})).toBe(true);
  });

  it('cluster 的 worker 是 false', () => {
    expect(isPrimaryInstance({ isPrimary: false, isWorker: true })).toBe(false);
  });

  it('老版本 Node 的 isMaster 也认', () => {
    expect(isPrimaryInstance({ isMaster: true } as any)).toBe(true);
    expect(isPrimaryInstance({ isMaster: false, isWorker: true } as any)).toBe(false);
  });
});

describe('scaleLimit：每进程的限流预算', () => {
  it('单进程时值不变（除数 1）', () => {
    expect(scaleLimit(600, 1)).toBe(600);
    expect(scaleLimit(30, 1)).toBe(30);
    expect(scaleLimit(5, 0)).toBe(5);
    expect(scaleLimit(5, NaN)).toBe(5);
    expect(scaleLimit(5, -2)).toBe(5);
  });

  it('N 个 worker 时每份预算是 1/N（全局阈值仍然约等于配置值）', () => {
    expect(scaleLimit(600, 4)).toBe(150);
    expect(scaleLimit(6000, 4)).toBe(1500);
    expect(scaleLimit(30, 3)).toBe(10);
  });

  it('小阈值不会被摊成 0（否则限流器会把所有人挡在外面）', () => {
    expect(scaleLimit(1, 8)).toBe(1);
    expect(scaleLimit(3, 8)).toBe(1);
    expect(scaleLimit(5, 4)).toBe(1);
  });

  it('偏差方向是"更严"：N 份摊薄后的总和不超过原值', () => {
    for (const base of [1, 3, 5, 20, 30, 50, 600, 6000]) {
      for (const workers of [2, 3, 4, 7, 8, 16]) {
        expect(scaleLimit(base, workers) * workers).toBeLessThanOrEqual(
          Math.max(base, workers),
        );
      }
    }
  });

  it('不传 worker 数时从环境变量取', () => {
    process.env[CLUSTER_ENV] = '4';
    try {
      expect(scaleLimit(600)).toBe(150);
    } finally {
      delete process.env[CLUSTER_ENV];
    }
    expect(scaleLimit(600)).toBe(600);
  });
});
