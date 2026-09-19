import { PublishTask, PUBLISH_TICK_LIMIT, PUBLISH_TICK_SLACK_MS } from './publish.task';
import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import * as publicMetaCache from 'src/utils/publicMetaCache';

/**
 * 定时发布 cron 的**窗口推进**语义，特别是"一个窗口里到点的文章超过单次上限"时。
 *
 * ## 这里钉住的缺陷
 *
 * 以前不管查回来多少条，`lastRunAt` 都被推到 `now`。而查询是
 * `.sort({ publishAt: 1 }).limit(500)` —— 于是一个窗口里到点超过 500 篇时
 * （批量导入后统一排期、迁移时把 publishAt 都写在同一分钟、或者站点很大而 cron 停过一轮），
 * **第 501 篇之后会被永久跳过**：它们的 publishAt 已经落在窗口左边，
 * 之后任何窗口都不再包含它们 ⇒ 不点名、也不触发这一轮的增量渲染，
 * 要等下一个整点的全量 ISR 才补上。文章本身仍然可见（查询层按 `publishAt <= now` 过滤），
 * 所以用户看到的是"文章能打开，但首页/分类/标签页里没有它"，最长 1 小时 —— 而日志里一个字都没有。
 *
 * ## 修法
 *
 * 截断时窗口只推进到**最后一篇已处理文章的 publishAt**，并且下一轮**不减 slack**
 * （`$gt` 是严格大于 ⇒ 正好从下一篇接着处理，既不遗漏也不重复点名）；同时 WARN 说清
 * 还剩多少、什么时候接着处理、可见性不受影响。
 *
 * ⚠️ 顺带记录一个**被否决**的审查建议：把首次 tick 的回看窗口改成"持久化的上次 tick 时间"。
 * 停机期间到点的文章，可见性由查询层负责、页面重渲染由启动时的全量 storm 负责
 * （`main.ts` 的 `activeAll(..., { forceActice: true })` → `runStorm` 渲染 post/page/category/tag，
 * `activeAll` 另外重建 RSS 与 sitemap），所以那个"最长 1 小时"的说法不成立；
 * 而持久化游标放在 `settings` 里会被**整站恢复**带回来（归档是全库导出），
 * 每次恢复后都会把几百篇早已发布的文章当成"刚刚到点"点名一遍。详见 publish.task.ts 顶部注释。
 */

/** 与既有 publish.task.spec.ts 的假 model 不同：这个**真的执行 sort 与 limit**，否则测不到截断 */
function createLimitAwareModel(docs: any[]) {
  const captured: any[] = [];
  const model: any = {
    captured,
    find: (filter: any) => {
      captured.push(filter);
      let sortKey: string | null = null;
      let limitN = Infinity;
      const chain: any = {
        sort: (spec: any) => {
          sortKey = Object.keys(spec || {})[0] || null;
          return chain;
        },
        limit: (n: number) => {
          limitN = n;
          return chain;
        },
        exec: async () => {
          const range = filter?.publishAt;
          let rows = docs.filter((d) => {
            if (range?.$gt && !(new Date(d.publishAt) > new Date(range.$gt))) return false;
            if (range?.$lte && !(new Date(d.publishAt) <= new Date(range.$lte))) return false;
            if (filter?.deleted?.$ne === true && d.deleted === true) return false;
            return true;
          });
          if (sortKey) {
            const key = sortKey;
            rows = [...rows].sort(
              (a, b) => new Date(a[key]).getTime() - new Date(b[key]).getTime(),
            );
          }
          return rows.slice(0, limitN);
        },
      };
      return chain;
    },
  };
  return model;
}

function makeDocs(count: number, base: number, stepMs = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `文章 ${i + 1}`,
    pathname: `p-${i + 1}`,
    publishAt: new Date(base + i * stepMs),
    deleted: false,
  }));
}

describe('PublishTask：单次上限截断时的窗口推进', () => {
  const t0 = new Date('2026-09-19T12:00:00Z').getTime();

  function createTask(docs: any[]) {
    const model = createLimitAwareModel(docs);
    const activeAll = jest.fn();
    const task = new PublishTask(model, { activeAll } as any);
    const warn = jest.spyOn((task as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((task as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((task as any).logger, 'error').mockImplementation(() => undefined);
    return { task, model, activeAll, warn };
  }

  it('到点数超过上限：只处理最早的一批，并 WARN 说清剩下的怎么办', async () => {
    jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache').mockImplementation(() => undefined);
    // ⚠️ 600 篇必须全落在**首次 tick 的 120s 回看窗口**内，否则"到点数"根本不到上限：
    //    步长 150ms × 600 = 90s，起点 t0-119s ⇒ 全部在 (t0-120s, t0] 里。
    const docs = makeDocs(PUBLISH_TICK_LIMIT + 100, t0 - 119_000, 150);
    const { task, warn, activeAll } = createTask(docs);
    const due = await task.publishDue(new Date(t0));
    expect(due).toHaveLength(PUBLISH_TICK_LIMIT);
    // 升序处理 ⇒ 点名的是最早的 500 篇（id 1..500）
    expect(due[0].id).toBe(1);
    expect(due[due.length - 1].id).toBe(PUBLISH_TICK_LIMIT);
    expect(warn).toHaveBeenCalled();
    const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain(String(PUBLISH_TICK_LIMIT));
    expect(warnText).toContain('下一次 tick');
    // 可见性不受影响这句话必须说清楚，否则运维会以为文章没发出去
    expect(warnText).toContain('可见性不受影响');
    expect(activeAll).toHaveBeenCalledTimes(1);
  });

  it('下一轮从"最后一篇已处理文章的 publishAt"接着走：剩下的 100 篇被处理，且一篇都不重复', async () => {
    jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache').mockImplementation(() => undefined);
    const docs = makeDocs(PUBLISH_TICK_LIMIT + 100, t0 - 119_000, 150);
    const { task } = createTask(docs);
    const first = await task.publishDue(new Date(t0));
    const second = await task.publishDue(new Date(t0 + 60_000));

    expect(second).toHaveLength(100);
    expect(second[0].id).toBe(PUBLISH_TICK_LIMIT + 1);
    expect(second[99].id).toBe(PUBLISH_TICK_LIMIT + 100);
    // ⚠️ 关键：不重复点名（截断后窗口起点不减 slack，$gt 严格大于）
    const firstIds = new Set(first.map((a) => a.id));
    expect(second.some((a) => firstIds.has(a.id))).toBe(false);
  });

  it('反证：截断后窗口起点**不带** slack（带了就会把已处理的那几篇再点名一次）', async () => {
    jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache').mockImplementation(() => undefined);
    // 让前 500 篇的 publishAt 挤在 5 秒内，slack 一旦生效就会重复命中
    const docs = makeDocs(PUBLISH_TICK_LIMIT + 3, t0 - 4_000, 1);
    const { task, model } = createTask(docs);
    await task.publishDue(new Date(t0));
    await task.publishDue(new Date(t0 + 60_000));
    const secondFilter = model.captured[1];
    const lastHandled = docs[PUBLISH_TICK_LIMIT - 1].publishAt as Date;
    // 起点必须**正好等于**最后一篇已处理文章的 publishAt，而不是它减去 5 秒
    expect(new Date(secondFilter.publishAt.$gt).getTime()).toBe(lastHandled.getTime());
    expect(new Date(secondFilter.publishAt.$gt).getTime()).not.toBe(
      lastHandled.getTime() - PUBLISH_TICK_SLACK_MS,
    );
  });

  it('没有截断时行为不变：窗口推到 now，下一轮起点带 5s slack', async () => {
    jest.spyOn(publicMetaCache, 'invalidatePublicMetaCache').mockImplementation(() => undefined);
    const docs = makeDocs(3, t0 - 30_000);
    const { task, model, warn } = createTask(docs);
    const now = new Date(t0);
    await task.publishDue(now);
    await task.publishDue(new Date(t0 + 60_000));
    expect(warn).not.toHaveBeenCalled();
    const secondFilter = model.captured[1];
    expect(new Date(secondFilter.publishAt.$gt).getTime()).toBe(now.getTime() - PUBLISH_TICK_SLACK_MS);
  });

  it('源码级钉子：limit 用常量、截断分支存在、旧的写死 500 不在了', () => {
    const src = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, 'publish.task.ts'), 'utf-8'),
    );
    expect(src).toMatch(/export const PUBLISH_TICK_LIMIT = 500;/);
    expect(src).toMatch(/\.limit\(PUBLISH_TICK_LIMIT\)/);
    expect(src).toMatch(/const truncated = \(rows \|\| \[\]\)\.length >= PUBLISH_TICK_LIMIT;/);
    // ⚠️ 断言**形状**而不是"出现了 truncated 这个词"：只有 if 分支里真的用了
    //    最后一篇的 publishAt，截断才不会漏文章。
    expect(src).toMatch(
      /if \(truncated && due\.length\) \{\s*this\.lastRunAt = due\[due\.length - 1\]\.publishAt;/,
    );
    expect(src).toMatch(/this\.lastRunTruncated = truncated;/);
    expect(src).toMatch(/this\.lastRunTruncated \? 0 : PUBLISH_TICK_SLACK_MS/);
    // 旧写法：写死的 limit(500) 与"无条件把窗口推到 now"
    expect(src).not.toMatch(/\.limit\(500\)/);
  });

  it('空转反证：上面那条"不存在"的正则确实能命中旧写法', () => {
    const oldShape = `.sort({ publishAt: 1 })\n      .limit(500)\n      .exec();`;
    expect(oldShape).toMatch(/\.limit\(500\)/);
    // 并且旧写法**不会**命中新的截断分支正则（说明那条断言不是恒真）
    expect(oldShape).not.toMatch(/const truncated = \(rows \|\| \[\]\)\.length >= PUBLISH_TICK_LIMIT;/);
  });
});
