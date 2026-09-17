import { readFileSync } from 'fs';
import { BadRequestException } from '@nestjs/common';

import { PipelineController } from './controller/admin/pipeline/pipeline.controller';
import { MetaProvider } from './provider/meta/meta.provider';
import { InitProvider } from './provider/init/init.provider';
import { ISRProvider } from './provider/isr/isr.provider';
import { FullBackupProvider } from './provider/backup/fullBackup.provider';
import { ViewStatsAggregator } from './utils/viewStatsBuffer';
import { InitController } from './controller/admin/init/init.controller';

/**
 * 这一组钉的是「静默失败」类的修复：以前这些位置要么把错误吞成一条没有来源的
 * 全局 unhandledRejection，要么把"失败"和"结果为空"混成同一个响应。
 *
 * 每一条都对应 §7.54 H 段里的一项。
 */

jest.mock('src/utils/fullBackup', () => {
  const actual = jest.requireActual('src/utils/fullBackup');
  return {
    ...actual,
    inspectFullBackup: jest.fn(),
    assertRestorableArchive: jest.fn(),
    restoreFullBackup: jest.fn(async () => ({
      manifest: { createdAt: '2026-09-13T14:09:55.000Z', databases: {} },
      databases: { vanBlog: { collections: 13, documents: 9830 } },
      static: {},
      ms: 10,
      notes: [],
    })),
  };
});

const root = __dirname;
const read = (rel: string) => readFileSync(`${root}/${rel}`, 'utf8');
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('B3 · 流水线 id 不再是裸 parseInt（NaN 与"没有这条"必须分得开）', () => {
  const makeController = () => {
    const provider = {
      getPipelineById: jest.fn(async (id: number) => ({ id, name: 'x' })),
      deletePipelineById: jest.fn(async (id: number) => ({ id, modifiedCount: 1 })),
      triggerById: jest.fn(async () => ({ status: 'success' })),
      updatePipelineById: jest.fn(async () => ({})),
    };
    return { controller: new PipelineController(provider as any), provider };
  };

  it('合法 id 照常通过（含负数与前导空格，与 parseInt 的宽容度一致）', async () => {
    const { controller, provider } = makeController();
    await controller.getPipelineById('12');
    expect(provider.getPipelineById).toHaveBeenCalledWith(12);
    await controller.getPipelineById(' 7 ');
    expect(provider.getPipelineById).toHaveBeenCalledWith(7);
  });

  it.each(['abc', '', '  ', '12abc', 'NaN', 'Infinity', '1e3', '0x10', '12.5', '9'.repeat(30)])(
    '非法 id %p ⇒ 400（改动前是 {statusCode:200,data:null} 或静默 no-op 的删除）',
    async (bad) => {
      const { controller, provider } = makeController();
      await expect(controller.getPipelineById(bad)).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.getPipelineById(bad)).rejects.toThrow(/流水线 id 不合法/);
      expect(provider.getPipelineById).not.toHaveBeenCalled();
      // 删除同样不许变成静默 no-op
      await expect(controller.deletePipelineById(bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.deletePipelineById).not.toHaveBeenCalled();
    },
  );

  it('源码里不再有裸的 parseInt(idString)', () => {
    const src = code(read('controller/admin/pipeline/pipeline.controller.ts'));
    expect(src).not.toContain('parseInt(idString)');
    expect(src.split('parsePipelineId(idString)').length - 1).toBe(4);
  });
});

describe('B10 · updateTotalWords 的定时回调必须自己兜错', () => {
  function makeMetaProvider(countTotalWords: jest.Mock) {
    const metaModel = { updateOne: jest.fn(async () => ({ modifiedCount: 1 })) };
    const provider = new MetaProvider(
      metaModel as any,
      undefined as any,
      { countTotalWords } as any,
      { invalidateBase: jest.fn() } as any,
    );
    return provider;
  }

  it('Mongo 抖动时打一条**带来源**的 ERROR，而不是溜成没有上下文的 unhandledRejection', async () => {
    jest.useFakeTimers();
    try {
      const provider = makeMetaProvider(jest.fn(async () => {
        throw new Error('mongo 抖动');
      }));
      const error = jest
        .spyOn((provider as any).logger, 'error')
        .mockImplementation(() => undefined);
      const unhandled: any[] = [];
      const onUnhandled = (r: any) => unhandled.push(r);
      process.on('unhandledRejection', onUnhandled);
      provider.updateTotalWords('删除文章');
      await (jest as any).advanceTimersByTimeAsync(30 * 1000);
      process.removeListener('unhandledRejection', onUnhandled);
      const text = error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('更新字数缓存失败');
      expect(text).toContain('删除文章'); // 来源必须在日志里，否则查不到是哪次操作
      expect(unhandled).toHaveLength(0);
      error.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it('成功路径不变：仍然写库并打印总字数', async () => {
    jest.useFakeTimers();
    try {
      const provider = makeMetaProvider(jest.fn(async () => 41508));
      const log = jest.spyOn((provider as any).logger, 'log').mockImplementation(() => undefined);
      provider.updateTotalWords('首次启动');
      await (jest as any).advanceTimersByTimeAsync(30 * 1000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('41508'));
      log.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('B10 · 其余两处 fire-and-forget 也带上了 catch', () => {
  it('init.provider 里的 walineProvider.init() 失败不会变成无主 rejection', async () => {
    const waline = { init: jest.fn(async () => { throw new Error('评论服务起不来'); }) };
    const provider = new InitProvider(
      { create: jest.fn() } as any,
      { create: jest.fn() } as any,
      {} as any,
      {} as any,
      waline as any,
      {
        updateCommentSetting: jest.fn(async () => undefined),
        updateMenuSetting: jest.fn(async () => undefined),
      } as any,
      { set: jest.fn() } as any,
      { restart: jest.fn(async () => undefined) } as any,
    );
    const error = jest
      .spyOn((provider as any).logger, 'error')
      .mockImplementation(() => undefined);
    const unhandled: any[] = [];
    const onUnhandled = (r: any) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    await provider.init({ user: { username: 'a', password: 'b' }, siteInfo: {} } as any);
    await sleep(10);
    process.removeListener('unhandledRejection', onUnhandled);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('初始化后启动评论服务失败'));
    expect(unhandled).toHaveLength(0);
    error.mockRestore();
  });

  it('article.controller 的每一处事后事件都挂了 catch，且日志里带文章 id（源码级钉子）', () => {
    const src = code(read('controller/admin/article/article.controller.ts'));
    // P3/P4 之后 afterUpdateArticle 共 4 处：update / create / 回收站 restore / 历史版本 restore；
    // deleteArticle 仍是 1 处。不变量没变：**每一处** dispatchEvent 的数量 == 带来源 catch 日志的数量。
    expect(src.split(".dispatchEvent('afterUpdateArticle'").length - 1).toBe(4);
    expect(src.split(".dispatchEvent('deleteArticle'").length - 1).toBe(1);
    // 每处都必须紧跟 .catch，且日志带来源
    expect(src.split('流水线事件 afterUpdateArticle 分发失败').length - 1).toBe(4);
    expect(src.split('流水线事件 deleteArticle 分发失败').length - 1).toBe(1);
    expect(src).not.toMatch(/dispatchEvent\([^)]*\);\s*\n\s*return \{/);
  });

  it('isr.activeArticleById 的 activePath(page) 有 catch，并注明当前不可达', async () => {
    const sitemapProvider = {
      getCategoryUrls: jest.fn(async () => []),
      // 读库失败：改动前这既不 await 也不 catch ⇒ 一条没有来源的 unhandledRejection
      getPageUrls: jest.fn(async () => { throw new Error('mongo 抖动'); }),
      getTagUrls: jest.fn(async () => []),
      generateSiteMap: jest.fn(),
    };
    const articleProvider = {
      getAll: jest.fn(async () => []),
      getByIdOrPathnameWithPreNext: jest.fn(async () => ({
        article: { id: 1, pathname: 'a', tags: [], category: 'c' },
        pre: null,
        next: null,
      })),
    };
    const provider = new ISRProvider(
      articleProvider as any,
      { generateRssFeed: jest.fn() } as any,
      sitemapProvider as any,
      { getISRSetting: jest.fn(async () => ({ mode: 'onDemand' })) } as any,
    );
    const error = jest
      .spyOn((provider as any).logger, 'error')
      .mockImplementation(() => undefined);
    const unhandled: any[] = [];
    const onUnhandled = (r: any) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    await provider.activeArticleById(1, 'update');
    await sleep(20);
    process.removeListener('unhandledRejection', onUnhandled);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('触发全部 page 页增量渲染失败'));
    expect(unhandled).toHaveLength(0);
    error.mockRestore();

    const src = read('provider/isr/isr.provider.ts');
    expect(src).toContain('当前不可达');
  });
});

describe('恢复之后 RSS 与 sitemap 必须真的被写出来（容器实测：/feed.xml 404）', () => {
  function makeIsr() {
    const rss = { generateRssFeed: jest.fn() };
    const sitemap = { generateSiteMap: jest.fn() };
    const provider = new ISRProvider(
      { getAll: jest.fn(async () => []), getById: jest.fn(async () => null) } as any,
      rss as any,
      {
        ...sitemap,
        getCategoryUrls: jest.fn(async () => []),
        getPageUrls: jest.fn(async () => []),
        getTagUrls: jest.fn(async () => []),
      } as any,
      { getISRSetting: jest.fn(async () => ({ mode: 'onDemand' })) } as any,
    );
    return { provider, rss, sitemap };
  }

  it('activeAll 的第二个参数就是两个生成器的防抖时长：传 1000 ⇒ 1 秒后就写', async () => {
    jest.useFakeTimers();
    try {
      process.env.VANBLOG_DISABLE_WEBSITE = 'true';
      const { provider, rss, sitemap } = makeIsr();
      provider.activeAll('整站恢复触发全量渲染！', 1000);
      await (jest as any).advanceTimersByTimeAsync(1000);
      expect(rss.generateRssFeed).toHaveBeenCalledWith('整站恢复触发全量渲染！', 1000);
      expect(sitemap.generateSiteMap).toHaveBeenCalledWith('整站恢复触发全量渲染！', 1000);
    } finally {
      delete process.env.VANBLOG_DISABLE_WEBSITE;
      jest.useRealTimers();
    }
  });

  it('不传 delay 时 RSS 要等 3 分钟、sitemap 等 1 分钟 —— 这就是容器里 /feed.xml 404 的原因', async () => {
    jest.useFakeTimers();
    try {
      process.env.VANBLOG_DISABLE_WEBSITE = 'true';
      const { provider, rss, sitemap } = makeIsr();
      provider.activeAll('整站恢复触发全量渲染！');
      await (jest as any).advanceTimersByTimeAsync(1000);
      expect(rss.generateRssFeed).toHaveBeenCalledWith('整站恢复触发全量渲染！', undefined);
      // 60 秒后 sitemap 写了，RSS 还没写
      await (jest as any).advanceTimersByTimeAsync(60 * 1000);
      expect(sitemap.generateSiteMap).toHaveBeenCalled();
      // 再过 2 分钟 RSS 才写
      await (jest as any).advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(rss.generateRssFeed).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.VANBLOG_DISABLE_WEBSITE;
      jest.useRealTimers();
    }
  });

  it('两条恢复路由都传了 delay=1000（源码级钉子：漏掉就是"恢复完 3 分钟内 /feed.xml 404"）', () => {
    const backup = code(read('controller/admin/backup/backup.controller.ts'));
    expect(backup).toContain("this.isrProvider.activeAll('整站恢复触发全量渲染！', 1000)");
    const init = code(read('controller/admin/init/init.controller.ts'));
    expect(init).toContain("this.isrProvider.activeAll('初始化页恢复整站备份触发全量渲染！', 1000,");
  });
});

describe('needsRestartForPipelineDeps：恢复响应里必须带这个布尔值', () => {
  const fakeConnection = (pipelineCount: number | Error) =>
    ({
      getClient: () => ({}),
      name: 'vanBlog',
      useDb: () => ({
        collection: () => ({
          countDocuments: async () => {
            if (pipelineCount instanceof Error) throw pipelineCount;
            return pipelineCount;
          },
        }),
      }),
    } as any);

  it('库里有流水线 ⇒ true（全新机器上没有 codeRunner/node_modules，第三方 require 要等重启）', async () => {
    const provider = new FullBackupProvider(fakeConnection(1));
    const res: any = await provider.restore('/fake/x.tar.zst', true);
    expect(res.needsRestartForPipelineDeps).toBe(true);
    expect(res.databases.vanBlog.documents).toBe(9830);
  });

  it('库里没有流水线 ⇒ false（不该无谓地叫用户重启）', async () => {
    const provider = new FullBackupProvider(fakeConnection(0));
    const res: any = await provider.restore('/fake/x.tar.zst', true);
    expect(res.needsRestartForPipelineDeps).toBe(false);
  });

  it('读不出来 ⇒ false + WARN，绝不让它影响恢复结果', async () => {
    const provider = new FullBackupProvider(fakeConnection(new Error('mongo 抖动')));
    const warn = jest
      .spyOn((provider as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const res: any = await provider.restore('/fake/x.tar.zst', true);
    expect(res.needsRestartForPipelineDeps).toBe(false);
    expect(res.databases.vanBlog.documents).toBe(9830);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('needsRestartForPipelineDeps 按 false 处理'));
    warn.mockRestore();
  });

  it('两条路由的 data 里都透出这个字段（前台不必解析中文 notes）', () => {
    for (const file of [
      'controller/admin/backup/backup.controller.ts',
      'controller/admin/init/init.controller.ts',
    ]) {
      const src = code(read(file));
      expect(src).toContain('needsRestartForPipelineDeps: Boolean(result.needsRestartForPipelineDeps)');
    }
  });

  it('init 路由的成功信封里确实带着它', async () => {
    const restore = jest.fn(async () => ({
      ms: 10,
      databases: {},
      static: {},
      manifest: { createdAt: 'x', databases: { vanBlog: { collections: { users: { count: 1 } } } } },
      notes: [],
      needsRestartForPipelineDeps: true,
    }));
    const controller = new InitController(
      { checkHasInited: jest.fn(async () => false), invalidateInitCache: jest.fn() } as any,
      {} as any,
      { activeAll: jest.fn() } as any,
      { backupDir: () => '/tmp', restore } as any,
      { init: jest.fn(async () => undefined) } as any,
      { restart: jest.fn(async () => undefined) } as any,
      { invalidateBase: jest.fn() } as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fb = require('src/utils/fullBackup');
    (fb.inspectFullBackup as jest.Mock).mockResolvedValue({
      createdAt: 'x',
      databases: { vanBlog: { collections: { users: { count: 1 } } } },
    });
    (fb.assertRestorableArchive as jest.Mock).mockResolvedValue(5);
    const res: any = await controller.restoreFromInitPage({
      path: '/tmp/does-not-matter',
      originalname: 'vanblog-full-20260913-140955.tar.zst',
    } as any);
    expect(res.statusCode).toBe(200);
    expect(res.data.needsRestartForPipelineDeps).toBe(true);
  });
});

describe('B7 · 日志卫生（空 catch 与 console.log 会把失败藏起来）', () => {
  it('caddy 的 clearLog 不再是空 catch', () => {
    const src = code(read('provider/caddy/caddy.provider.ts'));
    expect(src).not.toMatch(/catch \(err\) \{\s*\}/);
    expect(src).toContain('清空 caddy.log 失败');
  });

  it('markdown 高亮失败走 logger 而不是 console.log（后台日志页才看得到）', () => {
    const src = code(read('provider/markdown/markdown.provider.ts'));
    expect(src).not.toContain('console.log(e)');
    expect(src).toContain('代码高亮失败');
  });

  it('图床导出不再用 console.log 记录成功/失败', () => {
    const src = code(read('provider/static/local.provider.ts'));
    expect(src).not.toContain('console.log(r)');
    expect(src).not.toContain('console.log(err)');
    expect(src).toContain('导出图床压缩包失败');
  });

  it('rss.provider 里那句死代码没了', () => {
    const src = code(read('provider/rss/rss.provider.ts'));
    expect(src).not.toMatch(/^\s*walineSetting\?\.authorEmail;\s*$/m);
  });
});

describe('B9 · 超过上限时的淘汰不能拖慢热路径', () => {
  it('50000 次浏览 + 上限 1000：仍然在上限内，且耗时与不设上限同一量级', () => {
    const N = 50000;
    const capped = new ViewStatsAggregator({ maxRetainedKeys: 1000 });
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      capped.add({ pathname: `/post/p-${i}`, isNewVisitor: false, isNewForPath: false, date: '2026-09-16' });
    }
    const cappedMs = Date.now() - t0;

    const unlimited = new ViewStatsAggregator();
    const t1 = Date.now();
    for (let i = 0; i < N; i += 1) {
      unlimited.add({ pathname: `/post/p-${i}`, isNewVisitor: false, isNewForPath: false, date: '2026-09-16' });
    }
    const unlimitedMs = Date.now() - t1;

    expect(capped.retainedKeys()).toBeLessThanOrEqual(1000);
    expect(capped.countRetainedKeys()).toBe(capped.retainedKeys());
    expect(capped.pendingSite().viewer).toBe(N); // 站点级累计一条不丢
    // 第一版每次 add 都物化 + 排序日期数组、并 Array.from 整份键表 ⇒ 40 万次 add 要 138 秒。
    // 阈值给得很宽（负载高的机器上也会过），但足以抓住"又变成 O(表大小)/次"的回归。
    // eslint-disable-next-line no-console
    console.log(
      `[enforceCap] ${N} 次 add：设上限 ${cappedMs} ms vs 不设上限 ${unlimitedMs} ms（比值 ${(
        cappedMs / Math.max(1, unlimitedMs)
      ).toFixed(1)}×）`,
    );
    expect(cappedMs).toBeLessThan(5000);
    expect(cappedMs).toBeLessThan(Math.max(2000, unlimitedMs * 8));
  });

  it('跨两天时仍然先丢最老的那天（快速路径不能改掉淘汰顺序）', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 10 });
    for (let i = 0; i < 10; i += 1) {
      a.add({ pathname: `/old-${i}`, isNewVisitor: false, isNewForPath: false, date: '2026-09-15' });
    }
    for (let i = 0; i < 10; i += 1) {
      a.add({ pathname: `/new-${i}`, isNewVisitor: false, isNewForPath: false, date: '2026-09-16' });
    }
    const batch = a.take();
    const oldDay = batch.days.find((d) => d.date === '2026-09-15');
    const newDay = batch.days.find((d) => d.date === '2026-09-16');
    expect(newDay?.paths.size).toBe(10);
    expect(oldDay?.paths.size).toBe(0);
    expect(oldDay?.site.viewer).toBe(10);
    expect(batch.days.reduce((s, d) => s + d.site.viewer, 0)).toBe(batch.site.viewer);
  });
});

describe('B4 · 两个改统计口径的死方法已删除', () => {
  it('article.provider 里不再有 washViewerInfo*（零调用方 + N+1 + 直接改统计口径）', () => {
    const src = code(read('provider/article/article.provider.ts'));
    expect(src).not.toContain('washViewerInfoByVisitProvider');
    expect(src).not.toContain('washViewerInfoToVisitProvider');
    // 说明为什么删（免得下一个人再写一个回来）
    expect(read('provider/article/article.provider.ts')).toContain('零调用方');
  });
});
