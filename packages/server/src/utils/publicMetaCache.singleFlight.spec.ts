/**
 * `/api/public/meta` 的**单飞（single-flight）**守卫。
 *
 * 为什么值得专门钉住：裸 TTL 缓存有一个**周期性必然发生**的故障形状 —— TTL 到期瞬间所有在飞
 * 请求同时未命中，各自去跑那 7 个 Mongo 查询。1 万并发 ⇒ 瞬时 7 万个操作挤在 `maxPoolSize`
 * 默认 100 的池上，而池**没有配 `waitQueueTimeoutMS`**（排队是无限等）⇒ 表现为延迟雪崩与上游
 * 502，而不是快速失败。C10K 实测正是这个形状：caddy 直服的静态路径 10000/10000 全成功，
 * 而 meta 第二轮只有 5033/10000。
 *
 * ⚠️ 这里的断言全部是**行为级**（用计数假的 loader 数"底层取数发生了几次"），
 * 不是"源码里出现了 single-flight 字样"—— 后者是空断言：import 一行就能让它通过，
 * 把调用包进 `if (false && …)` 也照样通过（本仓库已有两条守卫因此空转过）。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  PUBLIC_META_CACHE_MS,
  invalidatePublicMetaCache,
  isPublicMetaInFlight,
  readPublicMetaCache,
  readPublicMetaWithSingleFlight,
  writePublicMetaCache,
} from 'src/utils/publicMetaCache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个"可控完成时机 + 调用计数"的 loader，用来数底层取数到底发生了几次。 */
function countingLoader<T>(value: T, delayMs = 5) {
  const fn = jest.fn(async (): Promise<T> => {
    if (delayMs > 0) await sleep(delayMs);
    return value;
  });
  return fn;
}

describe('publicMetaCache 的单飞', () => {
  beforeEach(() => {
    invalidatePublicMetaCache();
  });

  it('默认 TTL 是 5 秒（改动它等于改动全站最热读的缓存窗口，要显式确认）', () => {
    expect(PUBLIC_META_CACHE_MS).toBe(5000);
  });

  it('🔴 1 万个并发调用只产生 **1 次**底层取数（这就是修复本身）', async () => {
    const loader = countingLoader({ v: 'payload' }, 20);

    const N = 10000;
    const results = await Promise.all(
      Array.from({ length: N }, () => readPublicMetaWithSingleFlight(loader)),
    );

    // ⚠️ 核心断言：不是"结果对"，而是"底层只跑了一次"。
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(N);
    // 所有等待者拿到的是同一份数据（同一个对象引用，说明不是各跑一遍再恰好相等）。
    expect(results.every((r) => r === results[0])).toBe(true);
    expect(results[0]).toEqual({ v: 'payload' });
  });

  it('负向对照：把单飞退化成"每次都调 loader"时，上面那条必须能抓到', async () => {
    // 直接实现一个"没有单飞"的版本（等价于修复前的裸 TTL 缓存），证明断言真的在量并发合并，
    // 而不是碰巧只调用了一次（例如因为缓存已热）。
    const loader = countingLoader({ v: 'x' }, 20);
    const noSingleFlight = async () => {
      const hit = readPublicMetaCache();
      if (hit) return hit;
      const payload = await loader();
      writePublicMetaCache(payload);
      return payload;
    };

    await Promise.all(Array.from({ length: 500 }, () => noSingleFlight()));

    // 裸 TTL 缓存在过期瞬间会各自取数 ⇒ 调用次数远大于 1（这里 500 个并发全部未命中）。
    expect(loader.mock.calls.length).toBeGreaterThan(1);
  });

  it('缓存热的时候连 loader 都不构造调用（命中路径零成本）', async () => {
    const loader = countingLoader({ v: 'warm' }, 1);
    await readPublicMetaWithSingleFlight(loader);
    expect(loader).toHaveBeenCalledTimes(1);

    await Promise.all(Array.from({ length: 100 }, () => readPublicMetaWithSingleFlight(loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(readPublicMetaCache()).toEqual({ v: 'warm' });
  });

  it('取数**失败**时：不把 rejected Promise 留在缓存里，下一个请求能重试', async () => {
    let attempts = 0;
    const flaky = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('mongo 抖了一下');
      return { v: 'ok' };
    });

    await expect(readPublicMetaWithSingleFlight(flaky)).rejects.toThrow('mongo 抖了一下');
    // ⚠️ 关键：失败之后在飞状态必须被清掉。否则一次 DB 抖动会把失败结果钉住整个 TTL，
    //    把"抖一下"放大成"5 秒内全站 500"。
    expect(isPublicMetaInFlight()).toBe(false);
    expect(readPublicMetaCache()).toBeNull();

    await expect(readPublicMetaWithSingleFlight(flaky)).resolves.toEqual({ v: 'ok' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('并发期间取数失败：所有等待者都拿到同一个错误，且失败**不写缓存**', async () => {
    const boom = jest.fn(async () => {
      await sleep(10);
      throw new Error('池耗尽');
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 200 }, () => readPublicMetaWithSingleFlight(boom)),
    );

    expect(boom).toHaveBeenCalledTimes(1); // 仍然是单飞：200 个请求只打了一次库
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(readPublicMetaCache()).toBeNull(); // 失败不留脏缓存
    expect(isPublicMetaInFlight()).toBe(false);
  });

  it('在飞期间被 invalidate：那次结果**不写缓存**，但仍然返回给等待者', async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((r) => {
      release = r;
    });
    const loader = jest.fn(async () => {
      await gate;
      return { v: 'stale' };
    });

    const first = readPublicMetaWithSingleFlight(loader);
    // 后台改了站点信息 ⇒ invalidate。此时 loader 还在飞，它读到的是**改动之前**的数据。
    invalidatePublicMetaCache();
    release({});

    // 等待者仍然拿到数据（它们已经在等了，给一份略旧的数据好过给一个错误）。
    await expect(first).resolves.toEqual({ v: 'stale' });
    // ⚠️ 但绝不能把它写进缓存 —— 否则旧数据会再活一个 TTL，用户看到改之前的站点信息。
    expect(readPublicMetaCache()).toBeNull();

    // 下一次调用会重新取数（拿到新值）。
    const loader2 = countingLoader({ v: 'fresh' }, 1);
    await expect(readPublicMetaWithSingleFlight(loader2)).resolves.toEqual({ v: 'fresh' });
    expect(readPublicMetaCache()).toEqual({ v: 'fresh' });
  });

  it('关闭缓存（TTL=0）时**不做单飞**，语义与从前完全一致', async () => {
    // PUBLIC_META_CACHE_MS 在模块加载时读 env，所以要隔离模块重新加载。
    const OLD = process.env.VANBLOG_PUBLIC_META_CACHE_MS;
    process.env.VANBLOG_PUBLIC_META_CACHE_MS = '0';
    let mod: typeof import('src/utils/publicMetaCache');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('src/utils/publicMetaCache');
    });
    try {
      expect(mod!.PUBLIC_META_CACHE_MS).toBe(0);
      const loader = countingLoader({ v: 'direct' }, 5);

      // 关缓存 = "每次都读库"，这是关掉它的人想要的语义，不能被单飞改变。
      await Promise.all(Array.from({ length: 20 }, () => mod!.readPublicMetaWithSingleFlight(loader)));
      expect(loader.mock.calls.length).toBe(20);
      expect(mod!.readPublicMetaCache()).toBeNull();
      expect(mod!.writePublicMetaCache({ v: 'x' }) === undefined).toBe(true);
      expect(mod!.readPublicMetaCache()).toBeNull(); // 写入被忽略
    } finally {
      if (OLD === undefined) delete process.env.VANBLOG_PUBLIC_META_CACHE_MS;
      else process.env.VANBLOG_PUBLIC_META_CACHE_MS = OLD;
    }
  });
});

describe('控制器必须走单飞包装（源码级锚点）', () => {
  const SRC = stripCommentsForAnchor(
    readFileSync(resolve(__dirname, '../controller/public/public.controller.ts'), 'utf-8'),
  );

  it('剥注释器真的剥了（防空转：本仓库已踩 8 次"断言匹配到解释性注释"）', () => {
    const raw = readFileSync(
      resolve(__dirname, '../controller/public/public.controller.ts'),
      'utf-8',
    );
    // ⚠️ 反证必须挑一个**只在注释里出现**的 token，否则证明不了剥注释器做过事。
    // `waitQueueTimeoutMS` 只存在于解释"为什么单飞是必需"的那段注释里（代码里没有这个配置）。
    expect(raw).toMatch(/waitQueueTimeoutMS/);
    expect(SRC).not.toMatch(/waitQueueTimeoutMS/);
  });

  it('meta 处理器通过 readPublicMetaWithSingleFlight 调用取数函数', () => {
    // ⚠️ 断言**调用形状**，不是"符号出现过"：必须是真的把取数函数作为回调传进去。
    expect(SRC).toMatch(/return\s+readPublicMetaWithSingleFlight<[^>]*>\(\s*\(\)\s*=>\s*this\.buildPublicMeta\(\)\s*\)/);
  });

  it('取数函数不再自己写缓存，也不再有"命中就早返回"的裸缓存分支', () => {
    expect(SRC).not.toMatch(/writePublicMetaCache\s*\(/);
    expect(SRC).not.toMatch(/readPublicMetaCache\s*\(/);
  });
});
