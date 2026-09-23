import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MAX_BUCKETS,
  __resetAttemptLimitForTest,
  attemptLimitStats,
  consumeAttempt,
  normalizeAttemptKey,
  resetAttempts,
} from './utils/attemptLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 第三轮运行时审计（内存增长 / 静默失败 / 热路径复杂度）的源码级与行为级钉子。
 *
 * 放在这个文件名下面是有原因的：CI 的 `server-test.yml` 用 `--testPathPattern`
 * **白名单**跑 server 单测，`audit-hardening` 是白名单里的一个 token，
 * 所以 `audit-hardening-round3.spec.ts` 会被前缀匹配自动带上；
 * 而 `attemptLimit.spec.ts` / `rateLimit.spec.ts` 至今**不在**白名单里
 * （写在那两个文件里的新用例在 CI 上永远不会跑）。
 */

// __dirname 就是 src/（jest 用 ts-jest 直接跑源码，没有 dist 那一层）
const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/** 断言前剥掉注释：新写的注释里常常引用"以前是怎样的"，不剥会自己匹配自己 */
const code = stripCommentsForAnchor;

describe('attemptLimit：内存必须有界，而且不能"一满就把所有人清零"', () => {
  beforeEach(() => {
    __resetAttemptLimitForTest();
  });

  it('灌进 1.5 倍上限的一次性 key，表大小仍然被封在上限内', () => {
    const spray = Math.floor(MAX_BUCKETS * 1.5);
    for (let i = 0; i < spray; i += 1) {
      // 与 public.controller 的真实 key 同形状：unlock-<ip>-<路径参数>
      consumeAttempt(`unlock-203.0.113.7-${String(i).padStart(80, 'x')}`, {
        max: 20,
        windowMs: 10 * 60 * 1000,
      });
    }
    const stats = attemptLimitStats();
    expect(stats.size).toBeLessThanOrEqual(MAX_BUCKETS);
    expect(stats.size).toBe(MAX_BUCKETS);
    // 淘汰确实发生过（不是"上限根本没生效"这种假绿）
    expect(stats.evicted).toBeGreaterThan(0);
  });

  it('超限走的是淘汰，不是 buckets.clear()：其它客户端的计数器不会被攻击者清零', () => {
    // 一个"正在被限流"的客户端：已经试了 5 次（max=3 ⇒ 已经被挡）
    const victim = 'login-203.0.113.9';
    for (let i = 0; i < 5; i += 1) {
      consumeAttempt(victim, { max: 3, windowMs: 60 * 1000 });
    }
    expect(consumeAttempt(victim, { max: 3, windowMs: 60 * 1000 }).allowed).toBe(false);

    // 攻击者用一次性 key 把表顶爆
    for (let i = 0; i < MAX_BUCKETS + 5000; i += 1) {
      consumeAttempt(`unlock-198.51.100.7-${String(i).padStart(80, 'x')}`, {
        max: 20,
        windowMs: 10 * 60 * 1000,
      });
    }

    // 受害者仍然被挡着：它的桶 count>1，淘汰只挑 count 最小的（洪水桶）
    const blocked = consumeAttempt(victim, { max: 3, windowMs: 60 * 1000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(attemptLimitStats().cleared).toBe(0);
  });

  it('热桶（count>1）在洪水里活下来，冷桶（count=1）先被淘汰', () => {
    for (let i = 0; i < 50; i += 1) {
      consumeAttempt(`comment-203.0.113.${i}`, { max: 30, windowMs: 60 * 1000 });
      consumeAttempt(`comment-203.0.113.${i}`, { max: 30, windowMs: 60 * 1000 });
    }
    for (let i = 0; i < MAX_BUCKETS + 1000; i += 1) {
      consumeAttempt(`unlock-198.51.100.7-${String(i).padStart(80, 'x')}`, {
        max: 20,
        windowMs: 60 * 1000,
      });
    }
    // 50 个"用过两次"的桶一个都没被淘汰：再次 consume 时 count 从 3 继续，
    // 而不是从 1 重新开始（重新开始的话第 1 次必然 allowed，且永远打不满 max）
    for (let i = 0; i < 50; i += 1) {
      const key = `comment-203.0.113.${i}`;
      expect(consumeAttempt(key, { max: 2, windowMs: 60 * 1000 }).allowed).toBe(false);
    }
  });

  it('过期的桶会被惰性清扫掉（不用等同一个 key 再进来）', () => {
    jest.useFakeTimers();
    try {
      const base = new Date('2026-09-16T12:00:00Z');
      jest.setSystemTime(base);
      for (let i = 0; i < 100; i += 1) {
        consumeAttempt(`rl-global-203.0.113.${i % 250}`, { max: 600, windowMs: 1000 });
      }
      const before = attemptLimitStats().size;
      expect(before).toBe(100);
      // 过了窗口、也过了清扫间隔（60s）：下一次插入会先扫一遍
      jest.setSystemTime(new Date(base.getTime() + 61 * 1000));
      consumeAttempt('brand-new-key', { max: 600, windowMs: 60 * 1000 });
      const stats = attemptLimitStats();
      expect(stats.sweptExpired).toBe(100);
      expect(stats.size).toBe(1);
      expect(stats.cleared).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('key 长度有上限：路径参数再长也不会决定每个桶的内存占用', () => {
    const long = `unlock-203.0.113.7-${'x'.repeat(5000)}`;
    expect(normalizeAttemptKey(long).length).toBeLessThanOrEqual(160);
    consumeAttempt(long, { max: 1, windowMs: 60 * 1000 });
    // 前 160 字相同的另一个超长 key 落在同一个桶里（限流是尽力而为，只会更粗不会更松）
    const long2 = `unlock-203.0.113.7-${'x'.repeat(4000)}${'y'.repeat(1000)}`;
    expect(normalizeAttemptKey(long2)).toBe(normalizeAttemptKey(long));
    expect(consumeAttempt(long2, { max: 1, windowMs: 60 * 1000 }).allowed).toBe(false);
    expect(attemptLimitStats().size).toBe(1);
  });

  it('resetAttempts 对超长 key 也生效（走同一套归一化）', () => {
    const long = `unlock-203.0.113.7-${'x'.repeat(5000)}`;
    consumeAttempt(long, { max: 1, windowMs: 60 * 1000 });
    expect(consumeAttempt(long, { max: 1, windowMs: 60 * 1000 }).allowed).toBe(false);
    resetAttempts(long);
    expect(consumeAttempt(long, { max: 1, windowMs: 60 * 1000 }).allowed).toBe(true);
  });

  it('源码里"满了就清空整张表"那条路已经不存在（只剩测试专用的重置）', () => {
    const src = code(read('utils/attemptLimit.ts'));
    const occurrences = src.split('buckets.clear()').length - 1;
    expect(occurrences).toBe(1);
    expect(src.indexOf('buckets.clear()')).toBeGreaterThan(
      src.indexOf('__resetAttemptLimitForTest'),
    );
    // 淘汰必须按 count 挑（按插入顺序淘汰会先踢掉"用得最久、count 最高"的那个桶）
    expect(src).toContain('bucket.count === min');
  });
});

/* ================================================================== *
 * 静默失败：fire-and-forget / 没有 catch / env 数字没校验 / 数量参数没夹
 * ================================================================== */
import axios from 'axios';
import { ISRProvider } from './provider/isr/isr.provider';
import { SiteMapProvider } from './provider/sitemap/sitemap.provider';
import { AnalysisController } from './controller/admin/analysis/analysis.controller';
import { MAX_DATA_NUM, sanitizeDataNum } from './utils/pagination';
import { envPositiveInt } from './utils/envNumber';
import { buildUpsertOps, chunkArray } from './utils/bulkUpsert';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeIsrProvider(opts: { isrSetting?: () => Promise<any> } = {}) {
  const articleProvider = {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  };
  const settingProvider = {
    getISRSetting: opts.isrSetting || jest.fn().mockResolvedValue({ mode: 'onDemand' }),
  };
  const sitemapProvider = {
    getCategoryUrls: jest.fn().mockResolvedValue([]),
    getPageUrls: jest.fn().mockResolvedValue([]),
    getTagUrls: jest.fn().mockResolvedValue([]),
    generateSiteMap: jest.fn(),
  };
  const rssProvider = { generateRssFeed: jest.fn() };
  const provider = new ISRProvider(
    articleProvider as any,
    rssProvider as any,
    sitemapProvider as any,
    settingProvider as any,
  );
  return { provider, articleProvider, settingProvider, sitemapProvider, rssProvider };
}

describe('ISR：activeWithRetry 必须真的 await 到那一轮渲染', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ data: { revalidated: true } } as any);
  });

  it('fn 返回的 promise 被 await（改动前箭头函数漏了 return，await 的是 undefined）', async () => {
    const { provider } = makeIsrProvider();
    let finished = false;
    jest.spyOn(provider as any, 'runStorm').mockImplementation(async () => {
      await sleep(30);
      finished = true;
    });
    await provider.activeWithRetry(() => provider.activeAllFn('保存文章'), '保存文章');
    expect(finished).toBe(true);
  });

  it('那一轮抛错时由 activeWithRetry 打一条带来源的 ERROR，而不是溜成全局 unhandledRejection', async () => {
    const { provider } = makeIsrProvider({
      // activeAllFn 的第一句就是读 ISR 设置：Mongo 抖一下它就 reject，
      // 而这句在 try 之外（改动前没人 await 它，只能靠 main.ts 的全局兜底）
      isrSetting: () => Promise.reject(new Error('mongo 抖动')),
    });
    const error = jest
      .spyOn((provider as any).logger, 'error')
      .mockImplementation(() => undefined);
    const unhandled: any[] = [];
    const onUnhandled = (reason: any) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await provider.activeWithRetry(() => provider.activeAllFn('保存文章 42'), '保存文章 42');
      await sleep(10);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    const text = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('触发全量渲染时出错');
    expect(text).toContain('保存文章 42');
    expect(unhandled).toHaveLength(0);
    error.mockRestore();
  });

  it('补跑那一轮失败时链计数会收回（否则之后每一轮都少追加几次，且日志会误报"已连续追加 3 轮"）', async () => {
    // 三次 getISRSetting：①第一轮 ②渲染期间又进来的那一轮（它会把请求记进 stormQueued）
    // ③补跑的那一轮 —— 让第三次抛错，才是"补跑失败"这个场景。
    // ⚠️ 抛错必须发生在 getISRSetting（try 之外）：runStorm 抛错是被内部 catch 掉的，
    // 那种情况下 activeAllFn 正常 resolve，压根走不到这条路径。
    let calls = 0;
    const { provider } = makeIsrProvider({
      isrSetting: async () => {
        calls += 1;
        if (calls === 3) {
          throw new Error('补跑那一轮读设置时 mongo 挂了');
        }
        return { mode: 'onDemand' };
      },
    });
    jest.spyOn(provider as any, 'runStorm').mockImplementation(async () => {
      // 模拟"渲染期间又有人改数据"：塞一个待补跑的请求
      provider.activeAllFn('又来了').catch(() => undefined);
      await sleep(5);
    });
    jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
    await expect(provider.activeAllFn('第一轮')).rejects.toThrow('mongo 挂了');
    expect((provider as any).stormChain).toBe(0);
    expect((provider as any).stormRunning).toBe(false);
  });

  it('源码里三处 activeWithRetry 的回调都把 promise 交出去了（漏一个就退回"假 await"）', () => {
    const src = code(read('provider/isr/isr.provider.ts'));
    expect(src).toContain('this.activeWithRetry(() => this.activeAllFn(info, activeConfig), info)');
    expect(src).toContain('return this.activeUrl(`/about`, false);');
    expect(src).toContain('return this.activeUrl(`/link`, false);');
    // 花括号里只调用不 return 的老写法不许回来
    expect(src).not.toMatch(/activeWithRetry\(\(\) => \{\s*this\.activeAllFn/);
    // 🔴 2026-09-23 补的下界：上面三条只钉住"这三个已知调用点是对的"，而标题说的是"**三处**…都"。
    //    上面那条否定只针对 activeAllFn 这一个函数名 ⇒ 若新增第 4 个调用点写成
    //    `activeWithRetry(() => { this.someOtherFn(...) })`（不 return），标题承诺的性质就被破坏了，
    //    而此前**没有任何东西会红**。这条计数把"出现新调用点"变成**响的**：它会红，
    //    提醒来人复核新调用点有没有把 promise 交出去（并同步更新这里的计数与上面三条）。
    //    ⚠️ 数的是 `this.activeWithRetry(`（调用点），不含方法定义 `async activeWithRetry(`。
    expect(src.split('this.activeWithRetry(').length - 1).toBe(3);
  });
});

describe('SiteMap：从 setTimeout 里发出去就不管地调，所以必须自己兜错', () => {
  it('生成失败只打一条带来源的 ERROR，不抛给调用方（也不再是无主的 rejection）', async () => {
    const provider = new SiteMapProvider(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(provider, 'getSiteEntries')
      .mockRejectedValue(new Error('mongo 抖动') as never);
    const error = jest
      .spyOn((provider as any).logger, 'error')
      .mockImplementation(() => undefined);
    await expect(provider.generateSiteMapFn('整站恢复')).resolves.toBeUndefined();
    const text = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('生成 SiteMap 失败');
    expect(text).toContain('整站恢复');
    error.mockRestore();
  });

  it('写盘走异步 IO + 临时文件 rename（原地覆盖会让爬虫读到半截 XML）', () => {
    const src = code(read('provider/sitemap/sitemap.provider.ts'));
    expect(src).toContain('await fs.promises.mkdir(sitemapPath');
    expect(src).toContain('await fs.promises.writeFile(tmpPath, sm)');
    expect(src).toContain('await fs.promises.rename(tmpPath');
    expect(src).not.toContain('fs.writeFileSync');
    expect(src).not.toContain('fs.mkdirSync');
    // streamToPromise 必须被 await（老写法是 .then 且不 catch）
    expect(src).toContain('const sm = await done');
    expect(src).not.toMatch(/streamToPromise\(smStream\)\.then\(/);
  });
});

describe('后台仪表盘的 num 参数：夹住，别把 NaN 和大数交给循环', () => {
  const calls: any[][] = [];
  const controller = new AnalysisController({
    getWelcomePageData: async (...args: any[]) => {
      calls.push(args);
      return {};
    },
  } as any);

  beforeEach(() => {
    calls.length = 0;
  });

  it('垃圾值回落默认 5（改动前是 NaN ⇒ getViewerGrid 的循环一次都不跑 ⇒ 200 + 一整屏 0）', async () => {
    await controller.getWelcomePageData('overview', 'abc' as any, 'xyz' as any, '' as any);
    expect(calls[0]).toEqual(['overview', 5, 5, 5]);
  });

  it('超大值被夹到 MAX_DATA_NUM（改动前那个循环会先 push 十亿个日期字符串再把十亿元素的 $in 发给 Mongo）', async () => {
    await controller.getWelcomePageData(
      'overview',
      '999999999' as any,
      '999999999999' as any,
      '30' as any,
    );
    // 注意控制器把 overviewDataNum 放在第一个位置传给 provider
    expect(calls[0]).toEqual(['overview', MAX_DATA_NUM, MAX_DATA_NUM, 30]);
    expect(MAX_DATA_NUM).toBe(3650);
  });

  it('合法值原样通过：0（只看今天）、负数回落、科学计数法也能解析', async () => {
    await controller.getWelcomePageData('viewer', '0' as any, '7' as any, '1e3' as any);
    expect(calls[0]).toEqual(['viewer', 7, 0, 1000]);
    expect(sanitizeDataNum('-3', 5)).toBe(5);
    expect(sanitizeDataNum('30.7', 5)).toBe(30);
    expect(sanitizeDataNum(undefined, 5)).toBe(5);
    expect(sanitizeDataNum(null, 5)).toBe(5);
    expect(sanitizeDataNum({}, 5)).toBe(5);
    expect(sanitizeDataNum('  90  ', 5)).toBe(90);
  });

  it('analysis.controller 里不再有裸的 parseInt(，且走了 sanitizeDataNum（那正是 NaN 与十亿次循环的来源）', () => {
    const src = code(read('controller/admin/analysis/analysis.controller.ts'));
    expect(src).not.toContain('parseInt(');
    expect(src).toContain('sanitizeDataNum(');
  });
});

describe('env 里的数字：非法值回落默认，绝不把 NaN 交出去', () => {
  const withEnv = (name: string, value: string | undefined, fn: () => void) => {
    const old = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      fn();
    } finally {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
  };

  it('envPositiveInt：缺失/空/非数字/NaN/Infinity/≤0 都回落默认，合法值夹到 [min,max]', () => {
    for (const bad of [undefined, '', '   ', 'abc', '30s', 'NaN', 'Infinity', '-Infinity', '0', '-5']) {
      withEnv('VANBLOG_TEST_ENV_NUM', bad, () => {
        expect(envPositiveInt('VANBLOG_TEST_ENV_NUM', 3000)).toBe(3000);
      });
    }
    withEnv('VANBLOG_TEST_ENV_NUM', '5000', () => {
      expect(envPositiveInt('VANBLOG_TEST_ENV_NUM', 3000)).toBe(5000);
    });
    withEnv('VANBLOG_TEST_ENV_NUM', '99999999', () => {
      expect(envPositiveInt('VANBLOG_TEST_ENV_NUM', 3000, 100, 60000)).toBe(60000);
    });
    withEnv('VANBLOG_TEST_ENV_NUM', '1', () => {
      expect(envPositiveInt('VANBLOG_TEST_ENV_NUM', 3000, 100, 60000)).toBe(100);
    });
    withEnv('VANBLOG_TEST_ENV_NUM', '1.9', () => {
      expect(envPositiveInt('VANBLOG_TEST_ENV_NUM', 3000)).toBe(1);
    });
  });

  it('IP 归属地的超时被守住：写错的 env 不会把 axios 变回"没有超时"', async () => {
    // axios 对 `timeout: NaN` 的处理是"当成没设"（NaN 是 falsy），
    // 也就是把这个函数悄悄变回它当初要修的样子（离线时一次登录卡几十秒）
    jest.resetModules();
    process.env.VAN_BLOG_IP_GEO_TIMEOUT = '3s';
    const mod = await import('./provider/log/utils');
    expect(mod.IP_GEO_TIMEOUT_MS).toBe(3000);
    expect(Number.isFinite(mod.IP_GEO_TIMEOUT_MS)).toBe(true);
    delete process.env.VAN_BLOG_IP_GEO_TIMEOUT;
    jest.resetModules();
  });

  it('三处 env 数字都走了带校验的 helper（源码级钉子，剥掉注释再断言）', () => {
    const logUtils = code(read('provider/log/utils.ts'));
    expect(logUtils).toContain("envPositiveInt('VAN_BLOG_IP_GEO_TIMEOUT', 3000");
    expect(logUtils).not.toContain('Number(process.env.VAN_BLOG_IP_GEO_TIMEOUT');

    const pipeline = code(read('provider/pipeline/pipeline.provider.ts'));
    expect(pipeline).toContain("envPositiveInt('VANBLOG_PIPELINE_TIMEOUT_MS', 30000");
    // 这一处是多行调用，函数名与环境变量名不在同一行，所以分开断言
    expect(pipeline).toContain('envPositiveInt(');
    expect(pipeline).toContain("'VANBLOG_DEPS_INSTALL_TIMEOUT_MS'");
    expect(pipeline).not.toContain('Number(process.env.VANBLOG_PIPELINE_TIMEOUT_MS');
    expect(pipeline).not.toContain('Number(process.env.VANBLOG_DEPS_INSTALL_TIMEOUT_MS');
  });
});

describe('visits / viewers 导入批量化（整站 JSON 导入最慢的一步）', () => {
  it('buildUpsertOps：唯一键只进 filter 与 $setOnInsert（同时进 $set 会和 $setOnInsert 撞车）', () => {
    const ops = buildUpsertOps(
      [
        {
          _id: 'abc123',
          __v: 0,
          date: '2026-09-16',
          pathname: '/post/x',
          viewer: 10,
          visited: 5,
          createdAt: new Date('2026-09-16T00:00:00Z'),
        },
      ],
      ['pathname', 'date'],
    );
    expect(ops).toHaveLength(1);
    const op: any = ops[0].updateOne;
    expect(op.upsert).toBe(true);
    expect(op.filter).toEqual({ pathname: '/post/x', date: '2026-09-16' });
    expect(op.update.$set).toEqual({
      viewer: 10,
      visited: 5,
      createdAt: new Date('2026-09-16T00:00:00Z'),
    });
    // _id 只在插入时用（更新时碰 _id 会撞"immutable field"错误，老写法就是这么炸的）
    expect(op.update.$setOnInsert).toEqual({
      pathname: '/post/x',
      date: '2026-09-16',
      _id: 'abc123',
    });
    expect(op.update.$set._id).toBeUndefined();
    expect(op.update.$set.__v).toBeUndefined();
  });

  it('备份里缺 createdAt 时显式补一个（upsert 插入不会自动套 schema 默认值）', () => {
    const ops: any = buildUpsertOps([{ date: '2026-09-16', viewer: 1 }], ['date'])[0];
    expect(ops.updateOne.update.$setOnInsert.createdAt instanceof Date).toBe(true);
    expect(ops.updateOne.update.$set.createdAt).toBeUndefined();
  });

  it('没有可写字段时不发空的 $set（Mongo 会拒绝空更新文档）', () => {
    const ops: any = buildUpsertOps([{ date: '2026-09-16' }], ['date'])[0];
    expect(ops.updateOne.update.$set).toBeUndefined();
    expect(ops.updateOne.update.$setOnInsert).toBeDefined();
  });

  it('chunkArray 按 500 一批切，空数组与非数组都安全', () => {
    expect(chunkArray([], 500)).toEqual([]);
    expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    const many = Array.from({ length: 8770 }, (_, i) => i);
    const chunks = chunkArray(many);
    expect(chunks).toHaveLength(Math.ceil(8770 / 500));
    expect(chunks.reduce((a, c) => a + c.length, 0)).toBe(8770);
    expect(chunkArray(undefined as any)).toEqual([]);
  });

  it('两个 provider 都改成了批量 + 失败回落（真库上的对拍在 test/import-batch.e2e-spec.ts）', () => {
    for (const file of ['provider/visit/visit.provider.ts', 'provider/viewer/viewer.provider.ts']) {
      const src = code(read(file));
      expect(src).toContain('bulkWrite(buildUpsertOps(');
      expect(src).toContain('ordered: true');
      // 回落路径必须还在：一条坏数据不该让整次导入白跑
      expect(src).toContain('importSequentially');
      expect(src).toContain('回落到逐条写入');
    }
  });
});

describe('公开搜索：去重从 O(k²) 降到 O(k)，结果逐项不变', () => {
  // 搜索没有分页，`SEARCH_MAX_RESULTS` 是 200，而四个字段各自过滤一遍再拼接 ⇒
  // k 最多 800；老的 `resData.includes(e)` 是线性扫描 ⇒ 最多 32 万次引用比较。
  const makeSearchProvider = (rows: any[]) => {
    const exec = jest.fn(async () => rows);
    const maxTimeMS = jest.fn(() => ({ exec }));
    const limit = jest.fn(() => ({ maxTimeMS }));
    const find = jest.fn(() => ({ limit }));
    const { ArticleProvider } = require('./provider/article/article.provider');
    // P8 之后 searchByString 的公开路径还会查一次加密分类名单（categoryModal.find），
    // 这里的钉子只关心去重复杂度，给个空名单的假分类模型即可
    const categoryModal = { find: () => ({ exec: async () => [] }) };
    const provider = new ArticleProvider({ find } as any, categoryModal as any, undefined as any, undefined as any);
    return { provider, find, limit, maxTimeMS };
  };

  it('同一篇命中多个字段时只出现一次，顺序仍是 标题 > 正文 > 标签 > 分类', async () => {
    const a: any = { title: 'kafka 入门', content: 'x', category: 'kafka', tags: ['kafka'] };
    const b: any = { title: '别的', content: 'kafka 正文', category: 'c', tags: [] };
    const c: any = { title: '别的2', content: 'y', category: 'z', tags: ['kafka'] };
    const { provider } = makeSearchProvider([a, b, c]);
    const res = await provider.searchByString('kafka', false);
    // a 命中 title/content?/tag/category，b 命中 content，c 命中 tag
    expect(res).toEqual([a, b, c]);
    expect(res[0]).toBe(a);
    expect(new Set(res).size).toBe(res.length);
  });

  it('800 条全命中同一篇文章时也只返回一条（老的 includes 写法在这里是 32 万次比较）', async () => {
    const one: any = { title: 'kafka', content: 'kafka', category: 'kafka', tags: ['kafka'] };
    const rows = Array.from({ length: 200 }, () => one);
    const { provider } = makeSearchProvider(rows);
    const res = await provider.searchByString('kafka', false);
    expect(res).toHaveLength(1);
    expect(res[0]).toBe(one);
  });

  it('字段缺失（老数据 / JSON 导入）不会让公开搜索 500', async () => {
    const rows: any[] = [
      { title: 'kafka' }, // 没有 content / category / tags
      {}, // 什么都没有
      { content: null, tags: 'not-an-array', category: 42, title: 'kafka 2' },
    ];
    const { provider } = makeSearchProvider(rows);
    const res = await provider.searchByString('kafka', false);
    // 🔴 2026-09-23：R4-12（公开搜索投影掉 content）之后这里是 3，不是 2。
    //    这不是"随手改的数字"，而是 R4-12 的**固有行为差异**，来源是：投影掉 content 之后
    //    Node 侧无法再判断"某篇是不是命中在正文"，只能用**集合差**
    //    （content 命中 = rawData 减去 title/tag/category 的命中）⇒
    //    于是"JS 四个字段都匹配不上"的文档会被**保留 = 相信数据库的判定**，
    //    而不再像以前那样被 JS 那一趟**静默丢掉**。夹具第 2 行那个 `{}` 就是这一类的替身。
    //    🔴 真实世界的等价情形：用户搜 `İstanbul`，Mongo 的 `$regex($options:'i')` 认为某篇命中，
    //    而 JS 的 `toLocaleLowerCase` 认为不命中 ⇒ **旧行为把这篇丢掉，用户搜不到本该搜到的东西**。
    //    ⇒ 所以 R4-12 修掉的不只是内存与耗时，还有这个**召回缺陷**（已写进 CHANGELOG）。
    //    ⚠️ 安全性不受影响：deleted / hidden / visiblePublishFilter() / private / 加密分类名单
    //    全部是 DB 侧的 `$and` 条件，投影不改任何一条 ⇒ 被保留的文档本来就已通过全部可见性过滤。
    //    ⚠️ 生产里 Mongo 只返回"在 4 个字段之一命中"的文档，所以那个 `{}` 在真实查询下不会被返回；
    //    本用例要证的"字段缺失不会让公开搜索 500"仍然成立（没有抛异常，三篇都被正常处理）。
    expect(res.length).toBe(3);
  });

  it('article.provider 的公开搜索去重已换成 Set，那个历史形状不再出现（剥掉注释再断言）', () => {
    const src = code(read('provider/article/article.provider.ts'));
    expect(src).not.toContain('resData.includes(e)');
    expect(src).toContain('const seen = new Set<Article>()');
  });
});
