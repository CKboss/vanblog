import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';

import {
  CommentProvider,
  stripDataUriImages,
  COMMENT_LIST_INDEX_KEYS,
  COMMENT_LIST_INDEX_NAME,
  COMMENT_LIST_INDEX_LEDGER_KEY,
} from './provider/comment/comment.provider';
import { PublicCommentController } from './controller/public/comment.controller';
import { __resetAttemptLimitForTest } from './utils/attemptLimit';
import { CommentSetting } from './types/setting.dto';

/**
 * 第四轮安全审计的**修复钉子**（评论那一组）：B2（蜜罐绕过限流）、
 * B8（page 上限 / children 无上限 / 缺复合索引）、B9（二次方正则）、
 * R4-13（expandPostPaths 无投影）。
 *
 * 与 `audit-hardening-round4-security-*.spec.ts` 的分工：那边是审计时的 FINDING
 * 证据与转换后的回归钉子（源码级为主），这边是**行为级**用例 ——
 * 全部进程内、假 Mongo，不连库、不打 :3000。
 * 真库测量（查询耗时、行数增长）在 `test/audit-fixes-comment.e2e-spec.ts`（env 门控）。
 */

jest.mock('src/config/index', () => ({ config: { demo: 'false' } }), { virtual: true });

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

const SETTING: CommentSetting = {
  provider: 'builtin',
  moderation: 'post',
  keywords: ['广告'],
  requireEmail: false,
  pendingOnLink: true,
  maxContentLength: 200,
  rateLimitPer10Min: 100,
};

const req = (ip = '203.0.113.7') =>
  ({ socket: { remoteAddress: ip }, headers: { 'user-agent': 'jest' } } as any);

/** 通用的比较器：支持 {createdAt:1,id:1} / {id:-1} 这类简单排序规格 */
function applySort(rows: any[], spec: Record<string, number> | undefined): any[] {
  if (!spec) return rows;
  const entries = Object.entries(spec);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of entries) {
      const av = a?.[k] instanceof Date ? (a[k] as Date).getTime() : a?.[k];
      const bv = b?.[k] instanceof Date ? (b[k] as Date).getTime() : b?.[k];
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (Number(dir) < 0 ? -1 : 1);
    }
    return 0;
  });
}

function makeFakes(setting: CommentSetting = SETTING) {
  const comments: any[] = [];
  const queryLog: Array<{ filter?: any; projection?: any; sort?: any; skip?: number; limit?: number }> = [];
  let nextId = 1;

  const matches = (c: any, filter: any): boolean => {
    if (!filter) return true;
    if (filter.path !== undefined) {
      const p = filter.path;
      const ok = p && p.$in ? p.$in.includes(c.path) : c.path === p;
      if (!ok) return false;
    }
    if (filter.rootId !== undefined) {
      const r = filter.rootId;
      const ok = r && r.$in ? r.$in.includes(c.rootId || 0) : (c.rootId || 0) === r;
      if (!ok) return false;
    }
    if (filter.status !== undefined) {
      const s = filter.status;
      let ok = true;
      if (typeof s === 'string') ok = c.status === s;
      else if (s?.$ne !== undefined) ok = c.status !== s.$ne;
      else if (Array.isArray(s?.$in)) ok = s.$in.includes(c.status);
      if (!ok) return false;
    }
    if (filter.sourceId?.$in && !filter.sourceId.$in.includes(String(c.sourceId))) return false;
    return true;
  };

  const commentModel: any = {
    find: (filter?: any, projection?: any) => {
      const rec: any = { filter, projection };
      queryLog.push(rec);
      const q: any = {
        sort: (spec: any) => {
          rec.sort = spec;
          return q;
        },
        skip: (n: number) => {
          rec.skip = n;
          return q;
        },
        limit: (n: number) => {
          rec.limit = n;
          return q;
        },
        exec: async () => {
          let rows = comments.filter((c) => matches(c, filter));
          rows = applySort(rows, rec.sort);
          if (rec.skip) rows = rows.slice(rec.skip);
          if (rec.limit !== undefined) rows = rows.slice(0, rec.limit);
          return rows;
        },
        then: (res: any, rej: any) => q.exec().then(res, rej),
      };
      return q;
    },
    findOne: (query: any) => ({ exec: async () => comments.find((c) => c.id === query?.id) || null }),
    create: async (doc: any) => {
      comments.push(doc);
      return doc;
    },
    countDocuments: async (filter: any) => comments.filter((c) => matches(c, filter)).length,
    aggregate: (pipeline: any[]) => ({
      exec: async () => {
        // 只实现 countReplies / countByStatus 两种管道形状
        const match = pipeline?.[0]?.$match;
        if (match?.rootId?.$in) {
          const groups = new Map<number, number>();
          for (const c of comments) {
            if (match.rootId.$in.includes(c.rootId) && (!match.status || c.status === match.status)) {
              groups.set(c.rootId, (groups.get(c.rootId) || 0) + 1);
            }
          }
          return [...groups.entries()].map(([_id, count]) => ({ _id, count }));
        }
        const groups = new Map<string, number>();
        for (const c of comments) groups.set(c.status, (groups.get(c.status) || 0) + 1);
        return [...groups.entries()].map(([_id, count]) => ({ _id, count }));
      },
    }),
    updateOne: async () => ({ modifiedCount: 1 }),
    updateMany: async () => ({ modifiedCount: 1 }),
  };

  const articleModel: any = {
    findOne: () => ({ exec: async () => ({ id: 42, deleted: false, hidden: false, pathname: 'hello' }) }),
    find: () => ({ exec: async () => [] }),
  };
  const metaModel: any = {
    findOne: () => ({ exec: async () => ({ siteInfo: { authorEmail: '' } }) }),
  };
  const settingProvider: any = { getCommentSetting: async () => setting };
  const provider = new CommentProvider(commentModel, articleModel, metaModel, settingProvider);
  return { provider, comments, queryLog, nextId };
}

// ---------------------------------------------------------------------------
// B2 / R4-6：蜜罐评论也消耗限流预算（限流必须在任何写库之前）
// ---------------------------------------------------------------------------

describe('FIX B2/R4-6：蜜罐评论在写库之前先过三道限流', () => {
  beforeEach(() => __resetAttemptLimitForTest());
  afterAll(() => __resetAttemptLimitForTest());

  it('源码顺序钉子：ip 解析与三把桶都在蜜罐判定之前，蜜罐分支仍然写 status:spam', () => {
    const src = read('./provider/comment/comment.provider.ts');
    const iContent = src.indexOf('const content = this.assertContent(dto?.content, setting.maxContentLength);');
    const iIp = src.indexOf('const ip = bruteForceClientIp(req);');
    const iLimit = src.indexOf('consumeAttempt(`comment-${ip}`');
    const iDaily = src.indexOf('consumeAttempt(`comment-day-${ip}`');
    const iDup = src.indexOf('const dedupeKey = `comment-dup-${ip}-');
    const iHoneypot = src.indexOf("if (typeof dto?.hp === 'string' && dto.hp.trim() !== '')");
    const iSpamInsert = src.indexOf('const spam = await this.insert({');
    for (const [name, i] of Object.entries({ iContent, iIp, iLimit, iDaily, iDup, iHoneypot, iSpamInsert })) {
      expect([name, i]).toEqual([name, expect.any(Number)]);
      expect(i).toBeGreaterThan(-1);
    }
    // 字段校验 → 限流三把桶 → 蜜罐判定 → 写库
    expect(iIp).toBeGreaterThan(iContent);
    expect(iLimit).toBeGreaterThan(iIp);
    expect(iDaily).toBeGreaterThan(iLimit);
    expect(iDup).toBeGreaterThan(iDaily);
    expect(iHoneypot).toBeGreaterThan(iDup);
    expect(iSpamInsert).toBeGreaterThan(iHoneypot);
    // 蜜罐分支的语义没变：仍然入库为 spam、对外仍然只说「待审」
    const iReturn = src.indexOf('return { comment: this.toPublic(spam)', iHoneypot);
    expect(iReturn).toBeGreaterThan(iSpamInsert);
    const hpBlock = src.slice(iHoneypot, iReturn + 120);
    expect(hpBlock).toMatch(/status: 'spam'/);
    expect(hpBlock).toMatch(/return \{ comment: this\.toPublic\(spam\), pending: true, reason: undefined \};/);
  });

  it('行为钉子：rateLimitPer10Min=3 时第 4 条蜜罐评论被 400 挡住，库里只有 3 条 spam', async () => {
    const f = makeFakes({ ...SETTING, rateLimitPer10Min: 3 });
    const ip = '203.0.113.60';
    for (let i = 0; i < 3; i += 1) {
      const res = await f.provider.create(
        { path: '/post/1', nick: 'bot', content: `spam-content-${i}`, hp: 'x' },
        req(ip),
      );
      // 对外形状不变：仍然「待审」，不暴露蜜罐判定
      expect(res.pending).toBe(true);
      expect(res.reason).toBeUndefined();
    }
    await expect(
      f.provider.create({ path: '/post/1', nick: 'bot', content: 'spam-content-3', hp: 'x' }, req(ip)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.provider.create({ path: '/post/1', nick: 'bot', content: 'spam-content-4', hp: 'x' }, req(ip)),
    ).rejects.toThrow(/评论太频繁/);
    // DB 真值：修复前这里是「要多少条有多少条」，现在被自己的桶挡住
    expect(f.comments).toHaveLength(3);
    expect(f.comments.every((c) => c.status === 'spam')).toBe(true);
  });

  it('行为钉子：每日 50 条的上限同样管住蜜罐（第 51 条被拒）', async () => {
    const f = makeFakes({ ...SETTING, rateLimitPer10Min: 1000 });
    const ip = '203.0.113.61';
    for (let i = 0; i < 50; i += 1) {
      await f.provider.create({ path: '/post/1', nick: 'bot', content: `daily-spam-${i}`, hp: 'x' }, req(ip));
    }
    expect(f.comments).toHaveLength(50);
    await expect(
      f.provider.create({ path: '/post/1', nick: 'bot', content: 'daily-spam-50', hp: 'x' }, req(ip)),
    ).rejects.toThrow(/今天评论太多了/);
    expect(f.comments).toHaveLength(50); // 一条都没多写
  });

  it('行为钉子：同内容 5 分钟去重也管住蜜罐（修复前蜜罐路径根本走不到这把桶）', async () => {
    const f = makeFakes();
    const ip = '203.0.113.62';
    await f.provider.create({ path: '/post/1', nick: 'bot', content: 'repeat-spam', hp: 'x' }, req(ip));
    await expect(
      f.provider.create({ path: '/post/1', nick: 'bot', content: 'repeat-spam', hp: 'x' }, req(ip)),
    ).rejects.toThrow(/一样的评论/);
    expect(f.comments).toHaveLength(1);
  });

  it('蜜罐与正常评论共用同一把桶：bot 刷爆之后，同 IP 的正常评论也被挡（这是有意的）', async () => {
    const f = makeFakes({ ...SETTING, rateLimitPer10Min: 2 });
    const ip = '203.0.113.63';
    await f.provider.create({ path: '/post/1', nick: 'bot', content: 'spam-a', hp: 'x' }, req(ip));
    await f.provider.create({ path: '/post/1', nick: 'bot', content: 'spam-b', hp: 'x' }, req(ip));
    await expect(
      f.provider.create({ path: '/post/1', nick: 'human', content: '正常内容' }, req(ip)),
    ).rejects.toThrow(/评论太频繁/);
    // 诚实路径自己的限额没有被改动：另一个 IP 照常能发
    const other = await f.provider.create({ path: '/post/1', nick: 'human', content: '正常内容' }, req('203.0.113.64'));
    expect(other.comment.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// B8：page 上限 500、children 带 .limit()、复合索引进台账
// ---------------------------------------------------------------------------

describe('FIX B8：评论列表的规模悬崖被收住', () => {
  it('控制器把 page 夹到 500（以前 10000 ⇒ 匿名可构造 skip≈499,950）', async () => {
    const captured: any[] = [];
    const fakeProvider: any = {
      listByPath: async (opt: any) => {
        captured.push(opt);
        return { total: 0, page: opt.page, pageSize: opt.pageSize, data: [] };
      },
    };
    const controller = new PublicCommentController(fakeProvider, {} as any);
    await controller.list('/post/1', { page: '99999', pageSize: '100' });
    expect(captured[0]).toMatchObject({ page: 500, pageSize: 50 });
    await controller.list('/post/1', { page: '500' });
    expect(captured[1].page).toBe(500);
    await controller.list('/post/1', { page: '7', pageSize: '20' });
    expect(captured[2]).toMatchObject({ page: 7, pageSize: 20 });
    await controller.list('/post/1', { page: '0' });
    expect(captured[3].page).toBe(1);
    await controller.list('/post/1', { page: 'abc' });
    expect(captured[4].page).toBe(1);
    // 最深 skip = (500-1) × 50 = 24,950 条根评论 —— 前台 20/页时等于 1 万条评论，
    // 远超任何真实文章的规模，而攻击者再也构造不出 50 万的 skip
    expect((500 - 1) * 50).toBe(24950);
  });

  it('children 查询带 .limit(100 × 本页根评论数)，响应切片与 replyCount 语义不变', async () => {
    const f = makeFakes();
    const base = new Date('2026-09-01T00:00:00Z').getTime();
    // 根评论 A 有 250 条回复（全部更早），根评论 B 有 5 条回复（更晚）
    f.comments.push(
      { id: 1, path: '/post/1', rootId: 0, status: 'approved', nick: 'A', content: 'root-a', createdAt: new Date(base) },
      { id: 2, path: '/post/1', rootId: 0, status: 'approved', nick: 'B', content: 'root-b', createdAt: new Date(base + 60_000) },
    );
    let id = 3;
    for (let i = 0; i < 250; i += 1) {
      f.comments.push({
        id: id++, path: '/post/1', rootId: 1, parentId: 1, status: 'approved',
        nick: `r${i}`, content: `reply-${i}`, createdAt: new Date(base + 1000 + i),
      });
    }
    for (let i = 0; i < 5; i += 1) {
      f.comments.push({
        id: id++, path: '/post/1', rootId: 2, parentId: 2, status: 'approved',
        nick: `b${i}`, content: `b-reply-${i}`, createdAt: new Date(base + 70_000 + i),
      });
    }
    const res = await f.provider.listByPath({ path: '/post/1', page: 1, pageSize: 20 });
    // children 查询确实带了 limit = 100 × 2 个根评论
    const childrenQuery = f.queryLog.find((q) => q.filter?.rootId?.$in);
    expect(childrenQuery).toBeDefined();
    expect(childrenQuery!.limit).toBe(200);
    // 全局窗口被 A 的 250 条里的前 200 条吃满 ⇒ B 的回复显示 0 条，
    // 但 replyCount 仍然精确（来自 countReplies 聚合）—— 这是有意的取舍
    const a = res.data.find((c) => c.id === 1)!;
    const b = res.data.find((c) => c.id === 2)!;
    expect(a.children).toHaveLength(100); // 每条根评论的响应切片仍是 100
    expect(a.replyCount).toBe(250);
    expect(b.children).toHaveLength(0);
    expect(b.replyCount).toBe(5);
    // 修复前：children find 没有 limit ⇒ 250 条全部抓回来再在内存里分组
  });

  it('正常规模下 children 的 limit 不改变任何输出（blast radius 为零）', async () => {
    const f = makeFakes();
    const base = new Date('2026-09-01T00:00:00Z').getTime();
    f.comments.push(
      { id: 1, path: '/post/1', rootId: 0, status: 'approved', nick: 'A', content: 'root', createdAt: new Date(base) },
      { id: 2, path: '/post/1', rootId: 1, parentId: 1, status: 'approved', nick: 'r', content: 'reply', createdAt: new Date(base + 1000) },
      { id: 3, path: '/post/1', rootId: 0, status: 'pending', nick: 'x', content: 'no', createdAt: new Date(base + 2000) },
    );
    const res = await f.provider.listByPath({ path: '/post/1' });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].children).toHaveLength(1);
    expect(res.data[0].replyCount).toBe(1);
    const childrenQuery = f.queryLog.find((q) => q.filter?.rootId?.$in);
    expect(childrenQuery!.limit).toBe(100); // 1 个根评论 × 100
  });
});

function makeIndexFakes(existingIndexes: any[] = []) {
  const calls: string[] = [];
  const indexes = [...existingIndexes];
  const collection: any = {
    indexes: async () => {
      calls.push('indexes');
      return indexes.map((i) => ({ ...i }));
    },
    createIndex: async (keys: any, opts: any = {}) => {
      calls.push(`createIndex:${opts.name}`);
      indexes.push({ key: keys, name: opts.name });
      return opts.name;
    },
  };
  const ledger: any[] = [];
  const migration: any = {
    record: async (entry: any) => {
      ledger.push({ op: 'record', ...entry });
    },
    recordSkipped: async (spec: any, detail?: any) => {
      ledger.push({ op: 'skipped', ...spec, detail });
    },
  };
  const commentModel: any = { collection };
  const provider = new CommentProvider(
    commentModel,
    {} as any,
    {} as any,
    { getCommentSetting: async () => SETTING } as any,
    migration,
  );
  return { provider, calls, ledger, indexes };
}

describe('FIX B8：comments 复合索引（path, rootId, status, createdAt）', () => {
  it('键与名字常量就是查询形状：等值前缀在前、排序列（createdAt,id 双键）在后', () => {
    // ⚠️ id 必须在索引里：两条列表查询都按 {createdAt, id} 排序，少了 id 就仍有内存 SORT
    // 且要 FETCH 全部匹配文档取排序键（真库证据见 test/audit-fixes-comment.e2e-spec.ts）
    expect(COMMENT_LIST_INDEX_KEYS).toEqual({ path: 1, rootId: 1, status: 1, createdAt: 1, id: 1 });
    expect(COMMENT_LIST_INDEX_NAME).toBe('path_1_rootId_1_status_1_createdAt_1_id_1');
    expect(COMMENT_LIST_INDEX_LEDGER_KEY).toBe('index:comments.path_rootId_status_createdAt_id');
  });

  it('不存在时创建 + 台账记 ok；同键已存在时只花一次 listIndexes + 台账记 skipped（幂等）', async () => {
    const fresh = makeIndexFakes();
    const res = await fresh.provider.ensureListIndex('测试');
    expect(res).toMatchObject({ created: true, exists: false });
    expect(fresh.calls).toEqual(['indexes', `createIndex:${COMMENT_LIST_INDEX_NAME}`]);
    expect(fresh.ledger).toHaveLength(1);
    expect(fresh.ledger[0]).toMatchObject({
      op: 'record',
      key: COMMENT_LIST_INDEX_LEDGER_KEY,
      kind: 'index',
      outcome: 'ok',
    });

    const existing = makeIndexFakes([{ v: 2, key: { ...COMMENT_LIST_INDEX_KEYS }, name: COMMENT_LIST_INDEX_NAME }]);
    const res2 = await existing.provider.ensureListIndex('测试');
    expect(res2).toMatchObject({ created: false, exists: true });
    expect(existing.calls).toEqual(['indexes']); // 绝不再 createIndex
    expect(existing.ledger[0]).toMatchObject({ op: 'skipped', key: COMMENT_LIST_INDEX_LEDGER_KEY, kind: 'index' });

    // 同一进程里重复调用被 indexDone 挡住（启动钩子只跑一次的约定）
    const before = existing.calls.length;
    await existing.provider.ensureListIndex('第二次');
    expect(existing.calls).toHaveLength(before);
  });

  it('createIndex 失败：台账记 error、不抛、且允许下一次重试', async () => {
    const f = makeIndexFakes();
    (f.provider as any).commentModel.collection.createIndex = async () => {
      f.calls.push('createIndex:throw');
      throw new Error('E11000 duplicate key');
    };
    const res = await f.provider.ensureListIndex('测试');
    expect(res.created).toBe(false);
    expect(res.error).toContain('E11000');
    expect(f.ledger[0]).toMatchObject({
      op: 'record',
      key: COMMENT_LIST_INDEX_LEDGER_KEY,
      kind: 'index',
      outcome: 'error',
    });
    // 失败之后 indexDone 被复位：修复环境后还能再跑
    (f.provider as any).commentModel.collection.createIndex = async (_k: any, o: any) => {
      f.calls.push(`createIndex:${o.name}`);
      return o.name;
    };
    const retry = await f.provider.ensureListIndex('重试');
    expect(retry.created).toBe(true);
  });

  it('onApplicationBootstrap 是同步返回 + fire-and-forget，且只有主实例执行（沿用 statsMaintenance 约定）', async () => {
    const f = makeIndexFakes();
    expect(f.provider.onApplicationBootstrap()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls).toContain(`createIndex:${COMMENT_LIST_INDEX_NAME}`);
    const src = read('./provider/comment/comment.provider.ts');
    expect(src).toMatch(/if \(!isPrimaryInstance\(cluster\)\) \{\s*\n\s*return;\s*\n\s*\}/);
    expect(src).toMatch(/void this\.ensureListIndex\('启动'\)\.catch\(/);
  });
});

// ---------------------------------------------------------------------------
// R4-13：expandPostPaths 只取两个字段
// ---------------------------------------------------------------------------

describe('FIX R4-13：expandPostPaths 的 find 带 {id:1,pathname:1,_id:0} 投影', () => {
  it('投影参数就是 xit 里写的那一行，且展开语义逐字节不变', async () => {
    const f = makeFakes();
    let capturedFilter: any = null;
    let capturedProjection: any = 'NOT_PASSED';
    (f.provider as any).articleModel = {
      findOne: () => ({ exec: async () => ({ id: 7, deleted: false, hidden: false }) }),
      find: (filter: any, projection: any) => ({
        exec: async () => {
          capturedFilter = filter;
          capturedProjection = projection;
          return [{ id: 7, pathname: 'zen-me-ba-shou-ji' }];
        },
      }),
    };
    const expanded = await (f.provider as any).expandPostPaths(['/post/7', '/post/zen-me-ba-shou-ji', '/link']);
    expect(capturedProjection).toEqual({ id: 1, pathname: 1, _id: 0 });
    expect(capturedFilter).toEqual({
      $or: [{ id: { $in: [7] } }, { pathname: { $in: ['zen-me-ba-shou-ji'] } }],
    });
    expect(expanded.get('/post/7')).toEqual(
      expect.arrayContaining(['/post/7', '/post/zen-me-ba-shou-ji']),
    );
    expect(expanded.get('/link')).toEqual(['/link']);
    // 源码钉子：投影直接写在 find 的第二个参数上（与 xit 的最小补丁一致）
    const src = read('./provider/comment/comment.provider.ts');
    expect(src).toMatch(/\.find\(\{ \$or: or \}, \{ id: 1, pathname: 1, _id: 0 \}\)/);
  });
});

// ---------------------------------------------------------------------------
// B9：stripDataUriImages 的线性扫描器与旧正则逐字节等价
// ---------------------------------------------------------------------------

describe('FIX B9：stripDataUriImages 与旧正则逐字节等价，且对二次方输入是线性的', () => {
  /** 改动前的实现，逐字冻结在这里当参照物（§7.55 H 的两层证据模式） */
  const oldStrip = (text: string): string =>
    String(text ?? '').replace(
      new RegExp('!\\[([^\\]]*)\\]\\(\\s*<?data:[^)>]*>?(?:\\s+(?:"[^"]*"|\'[^\']*\'))?\\s*\\)', 'gi'),
      (_m: string, alt: string) => {
        const label = String(alt ?? '').trim();
        return label || '图片';
      },
    );

  /** 既有钉子（comment.provider.spec.ts）里的全部输入，一个都不能变 */
  const pinned = [
    '前 ![截图](data:image/png;base64,AAAA) 后',
    '![alt](data:image/gif;base64,BBB "标题")',
    '![](data:image/png;base64,CCC)',
    '普通 ![图](https://x.example/a.png) 不动',
    `看 ![](data:image/png;base64,${'A'.repeat(300)})`,
  ];

  /** 手写的边界向量：每一条都对应旧正则回溯树上的一个分支 */
  const edges = [
    // 基本形状
    '![a](data:x)',
    '![a](DATA:X)',
    '![a](DaTa:X)',
    '![a]( data:x )',
    '![a](\t\ndata:x\n\t )',
    '![a](<data:x>)',
    '![a](<data:x)',
    '![a]( data:x >)',
    '![a](data:x>)',
    '![a](data:x> )',
    '![a](data:x>  )',
    // title 的三种引号形状与内容里的 ) 和 >
    '![a](data:x "t")',
    "![a](data:x 't')",
    '![a](data:x "a ) b")',
    '![a](data:x "a > b")',
    '![a](data:x> "t" )',
    '![a](data:x>\t"t"\t)',
    '![a](data:x "t" y)',
    '![a](data:x "t)',
    '![a](data:x "未闭合)',
    // 失败形状（旧正则在这里二次方回溯）
    '![a](data:',
    `![a](data:${' '.repeat(500)}`,
    `![a](data:x> ${' '.repeat(500)}`,
    `![a](data:${' '.repeat(500)}"`,
    '![a](data:x>y)',
    '![a](data:x>y>z)',
    '![a](<data:x y)',
    // alt 的边界
    '![](data:x)',
    '![   ](data:x)',
    '![a![b](data:x)',
    '![a]](data:x)',
    '![a](data:x',
    '![a(data:x)',
    '![](data:)',
    '![a](data:x))尾巴',
    // 多个匹配与文本交错
    '前![a](data:1)中![](data:2 "t")后',
    '!![a](data:x)',
    'x![a](data:1)![b](data:2)y',
    '![a](https://x/y.png) 不动 ![b](data:z) 动',
    // 非 data: 的普通图片（绝不能动）
    '![图](/static/img/a.webp)',
    '![图](https://x.example/a.png "标题")',
    // 空白字符家族（\s 的完整集合抽测）
    '![a](\u00a0data:x\u00a0)',
    '![a](\u2028data:x\u2029)',
    '![a](\ufeffdata:x\ufeff)',
    // 中文 alt
    '![截图 2024](data:image/png;base64,AAAA)',
    '![  带空格的 alt  ](data:x)',
  ];

  /** 种子随机 fuzz（mulberry32）：从"语法碎片"字母表拼 4000 个串对拍 */
  const fuzz = (() => {
    let seed = 0xdeadbeef;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const tokens = [
      '![', '](', 'data:', 'DATA:', 'dAtA:', '<', '>', '"', "'", ' ', '\t', '\n',
      ')', '(', 'x', 'A', ']', '!', '图片', 'é', '%', '\u00a0', 'a](data:x)',
    ];
    const out: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const n = 1 + Math.floor(rnd() * 24);
      let s = '';
      for (let j = 0; j < n; j += 1) s += tokens[Math.floor(rnd() * tokens.length)];
      out.push(s);
    }
    return out;
  })();

  it('对拍：既有钉子 + 边界向量 + 4000 个随机向量，输出逐字节相同', () => {
    let transformed = 0;
    for (const input of [...pinned, ...edges, ...fuzz]) {
      const before = oldStrip(input);
      const after = stripDataUriImages(input);
      // 失败时只打印第一个不一致的输入（别学 §7.55 I 那个 2.6MB diff 的坑）
      expect([input.slice(0, 120), after]).toEqual([input.slice(0, 120), before]);
      if (before !== input) transformed += 1;
    }
    // 反空转：对拍集里确实有大量"会被折叠"的输入，否则等价断言可能是空的
    expect(transformed).toBeGreaterThan(200);
  });

  it('既有钉子的输出值本身（防止"两边一起错"）', () => {
    expect(stripDataUriImages(pinned[0])).toBe('前 截图 后');
    expect(stripDataUriImages(pinned[1])).toBe('alt');
    expect(stripDataUriImages(pinned[2])).toBe('图片');
    expect(stripDataUriImages(pinned[3])).toBe(pinned[3]);
  });

  // 🔴 2026-09-24 重写：原判据是 `expect(t80 / Math.max(t20, 0.05)).toBeLessThan(8)`，
  // 输入 20k/80k。它长期在 CI 上假红（本机也曾实测到 8.302，超阈值 3.8%）。
  // 🔴 根因不是"阈值太紧"，而是**纯比值这个形状本身不稳**：
  //   ① 两个测量各自含固定开销（函数调用、字符串分配、GC），比值在小输入下被这些常量主导；
  //   ② `Math.max(t20, 0.05)` 那个 0.05ms 地板在快机器上会把分母钉死、**人为抬高比值**
  //      （20k 的扫描可以低于 0.05ms）；
  //   ③ 🔴 冷/暖与 GC 让两次测量不同步 —— 本机同一次运行里 20k 冷测 0.763ms、暖测 0.2245ms，
  //      **差 3.4 倍**，而 `Math.min` 只压低单侧、不能保证两侧同步。
  // 🔴 修法（三处，每一处都有 2026-09-24 本机标定实测依据）：
  //   (a) **输入放大并改成 8× 比例（200k → 1.6M）** —— 时间远高于任何测量地板，
  //       而且 8× 比例让"线性 vs 二次方"的判别力最大化：线性给 ×8，二次方给 ×64。
  //       ⚠️ 原来用 4× 比例时判别力不足（线性 ×4、二次方 ×16，阈值只能放中间，
  //       加上常量项后二次方只超出 1.27 倍 ⇒ 噪声就能翻盘）。
  //   (b) **纯比值换成仿射界** `t_large < 16 * t_small + 2` —— 这才是正确的形状：
  //       线性 ⇒ t(n) ≈ a·n + b，所以 t(8n) ≈ 8·t(n) − 7b ≤ 8·t(n)；二次方 ⇒ t(8n) ≈ 64·t(n)。
  //       阈值 16 = 线性期望的 2 倍、二次方期望的 1/4 ⇒ **安全侧 2 倍余量、危险侧 4 倍余量**。
  //   (c) **保留一条绝对界**（< 2000ms），它与仿射界**各自独立**都能抓住二次方实现。
  // 🔴 标定实测（2026-09-24，本机，`min` of 3，暖机后）：
  //   线性（真实实现）：t(200k)=2.254ms、t(1.6M)=17.975ms ⇒ 比值 **7.97**；
  //     仿射界 16×2.254+2 = **38.07ms** vs 实测 17.98ms ⇒ **余量 2.12×**；
  //     8 轮复测比值稳定在 **7.921–8.027**，实测恒为 18.0ms。
  //   二次方替身（`substring(i).indexOf(不存在的串)`）：t(200k)=27.5ms、t(1.6M)=3137ms ⇒ 比值 **114**；
  //     仿射界 442ms vs 实测 3137ms ⇒ **超出 7.09×，决定性变红**；绝对界 2000ms 也同时抓住它。
  // 🔴 变异对照已实测承重（见 §7.132）：收紧系数 ⇒ 红；换二次方替身 ⇒ 红；语义空操作 ⇒ 绿。
  //   ⚠️ 做"换回二次方"这条变异时踩到一个坑并记进手册：**`s.slice(i).length` 会被 V8 优化成
  //   `s.length - i` 而不真的分配字符串 ⇒ 那个"二次方替身"实测比值只有 4.08，其实是线性的**，
  //   于是变异成了语义空操作、NOT_RED 差点被误读成"判据不守线性"。🔴 **变异体本身必须先实测验证。**
  // ⚠️ 历史记录保留：旧的**正则**实现在 **80k** 空白输入上实测 **32s**
  //   （源码注释里的完整阶梯：5k→125ms、10k→495ms、20k→2.0s、40k→8.0s、80k→32s，每翻倍 ×4）。
  it('二次方输入现在是线性的：1.6M 空白 < 2000ms，且 t(8n) 不超过 16·t(n)+2（旧正则实现在 80k 上实测 32s）', () => {
    const SMALL = 200_000;
    const LARGE = 1_600_000; // = SMALL × 8 ⇒ 线性给 ×8，二次方给 ×64
    const mk = (n: number) => `![a](data:${' '.repeat(n)}`;
    const time = (s: string) => {
      const t0 = process.hrtime.bigint();
      stripDataUriImages(s);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const minOf3 = (n: number) => {
      const s = mk(n);
      return Math.min(time(s), time(s), time(s));
    };
    time(mk(SMALL)); // 预热，避免把 JIT 编译算进第一次测量
    const tSmall = minOf3(SMALL);
    const tLarge = minOf3(LARGE);
    // eslint-disable-next-line no-console
    console.log(
      `[B9] stripDataUriImages 二次方输入：200k=${tSmall.toFixed(2)}ms 1.6M=${tLarge.toFixed(2)}ms 比值=${(
        tLarge / tSmall
      ).toFixed(2)}`,
    );
    // 🔴 fail-loud 的尺子自检：计时器必须真的测到了非零耗时，否则下面的仿射界会退化成恒真。
    expect(tSmall).toBeGreaterThan(0);
    expect(tLarge).toBeGreaterThan(0);
    // 绝对界：本机实测 17.98ms；CI runner 慢 20 倍也才 360ms。
    // 🔴 二次方实现在 1.6M 上实测 3137ms ⇒ 这一条自己就能抓住它（与仿射界互相独立）。
    expect(tLarge).toBeLessThan(2000);
    // 🔴 仿射界（承重的那一条）：线性 ⇒ t(8n) ≤ 8·t(n)；给到 16 倍 + 2ms 常量余量。
    expect(tLarge).toBeLessThan(16 * tSmall + 2);
  });

  it('没有 data: 的长文走快速路径（一次字面量探测，不进扫描器）', () => {
    const long = 'x'.repeat(200_000) + ' ![a](https://x/y.png)';
    const t0 = process.hrtime.bigint();
    expect(stripDataUriImages(long)).toBe(long);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(100);
    // 源码钉子：预检在扫描器之前
    const src = read('./provider/comment/comment.provider.ts');
    expect(src).toMatch(/if \(!DATA_URI_PROBE\.test\(input\)\) \{\s*\n\s*return input;/);
  });

  it('「重复锚点 + 结尾一个 >」这种连旧正则都是 O(N²) 的输入：工作预算内大声抛错，绝不挂死', () => {
    // 每个锚点的 P 扫描都要跑到串尾那个 `>` ⇒ 总工作量 O(N²)。
    // 新实现按 ~20× 输入长度的预算在几毫秒内抛 BadRequestException ——
    // 唯一调用方 importFromWaline 对每行都有 try/catch：该行被跳过、原因进 errors[]，
    // 导入继续（大声失败，绝不静默、也绝不把事件循环挂上几个小时）。
    const evil = '![a](data:'.repeat(30_000) + '>'; // 240 KB
    const t0 = process.hrtime.bigint();
    expect(() => stripDataUriImages(evil)).toThrow(/data: 图片引用/);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[B9] 重复锚点病态输入（240KB）：${ms.toFixed(1)}ms 内抛错`);
    expect(ms).toBeLessThan(5000);
  });

  it('串尾连 `)`/`>` 都没有的重复锚点输入是线性的（短路：后续锚点必然失败）', () => {
    const evil = '![a](data:'.repeat(30_000); // 没有任何 `)` 或 `>`
    const t0 = process.hrtime.bigint();
    expect(stripDataUriImages(evil)).toBe(evil); // 与旧正则同结论（只是旧的要跑几个小时）
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // eslint-disable-next-line no-console
    console.log(`[B9] 无右括号重复锚点（240KB）：${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });

  it('1MB 的**合法**内容（500 张真 data: 图片）不触发预算，全部折叠', () => {
    const one = `![截图${'x'.repeat(1900)}](data:image/png;base64,${'A'.repeat(100)})`; // ~2KB
    const big = Array.from({ length: 500 }, (_, i) => `第${i}张 ${one}`).join('\n');
    expect(big.length).toBeGreaterThan(1_000_000);
    const out = stripDataUriImages(big); // 不抛
    expect(out).not.toContain('data:image/png');
    expect(out).toContain('第499张');
    // 折叠后每一张都变成它的 alt
    expect((out.match(/截图/g) || []).length).toBe(500);
  });
});
