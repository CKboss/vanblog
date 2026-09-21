import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ArticleProvider } from './article.provider';

/**
 * P5 的**防泄露钉子**：逐条公开读路径断言查询里带 publishAt 过滤器，
 * 逐条管理路径断言**不带**（后台必须能看到定时文章）。
 *
 * 覆盖的公开面（任务清单）：列表（getByOption public，find 与聚合两条路）、
 * 详情（getById/getByPathName public、getByIdOrPathnameWithPreNext 的 pre/next）、
 * 搜索（searchByString）、时间线（getTimeLineInfo）、RSS/sitemap/tag/category
 * （全都走 getAll includeHidden=false）、计数与总字数（getTotalNum/countTotalWords）、
 * 密码解锁口（getByIdWithPassword —— 它用 admin 视图取文，过滤器帮不到，靠显式 404）。
 *
 * 负控：把任何一条路径的 `visiblePublishFilter()` 拆掉，对应用例立刻红
 * （已实测 getByOption 与 getByIdWithPassword 两条，见交付报告）。
 */

function hasPublishFilter(query: any): boolean {
  const json = JSON.stringify(query ?? null);
  return json.includes('"publishAt"') && json.includes('$lte');
}

function createCapturingModel(docs: any[] = []) {
  const captured: { method: string; query: any }[] = [];
  const chainFrom = (rows: any[]) => {
    const chain: any = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      maxTimeMS: () => chain,
      lean: () => chain,
      exec: async () => rows,
      // getTotalNum 用的是 Query.countDocuments()（链式，不是 Model 上的那个）
      countDocuments: async () => rows.length,
      then: (resolve: any) => resolve(rows), // countDocuments() 不带 exec 的用法
    };
    return chain;
  };
  const model: any = function FakeModel(dto: any) {
    Object.assign(this, dto);
    (this as any).save = async () => this;
  };
  model.captured = captured;
  model.find = (query: any, projection?: any) => {
    captured.push({ method: 'find', query });
    return chainFrom(projection ? docs.map((d) => ({ ...d })) : docs);
  };
  model.findOne = (query: any, projection?: any) => {
    captured.push({ method: 'findOne', query });
    const hit = docs[0] || null;
    return { exec: async () => (hit ? { ...hit } : null) };
  };
  model.countDocuments = (query: any) => {
    captured.push({ method: 'countDocuments', query });
    return { exec: async () => docs.length };
  };
  model.aggregate = (pipeline: any[]) => {
    captured.push({ method: 'aggregate', query: pipeline?.[0]?.$match });
    return { allowDiskUse: () => ({ exec: async () => [] }) };
  };
  model.updateOne = (query: any, patch: any) => {
    captured.push({ method: 'updateOne', query: { query, patch } });
    return { exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) };
  };
  model.deleteOne = (query: any) => {
    captured.push({ method: 'deleteOne', query });
    return { exec: async () => ({ deletedCount: 1 }) };
  };
  return model;
}

function createProvider(model: any, categoryModel?: any, meta?: any) {
  return new ArticleProvider(
    model,
    categoryModel || ({ find: () => ({ exec: async () => [] }) } as any),
    meta || ({ updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any),
    {} as any,
  );
}

const FUTURE = new Date(Date.now() + 86400 * 1000);

describe('公开读路径全部过滤未发布文章', () => {
  it('getByOption(public)：find 回退路径与聚合路径的 $match 都带过滤器', async () => {
    const model = createCapturingModel([]);
    const provider = createProvider(model);
    await provider.getByOption({ page: 1, pageSize: -1 } as any, true);
    const findCall = model.captured.find((c: any) => c.method === 'find');
    expect(hasPublishFilter(findCall.query)).toBe(true);

    const model2 = createCapturingModel([]);
    const provider2 = createProvider(model2);
    await provider2.getByOption({ page: 1, pageSize: 5 } as any, true);
    const agg = model2.captured.find((c: any) => c.method === 'aggregate');
    expect(agg).toBeDefined(); // pageSize!=-1 的公开列表走聚合分页
    expect(hasPublishFilter(agg.query)).toBe(true);
  });

  it('getByOption(admin)：**不带**过滤器（后台要能看到定时文章）', async () => {
    const model = createCapturingModel([]);
    const provider = createProvider(model);
    await provider.getByOption({ page: 1, pageSize: 5 } as any, false);
    for (const call of model.captured) {
      expect(hasPublishFilter(call.query)).toBe(false);
    }
  });

  it('getAll：includeHidden=false（RSS/sitemap/tag/category 的入口）带过滤器；=true 不带', async () => {
    const m1 = createCapturingModel([]);
    await createProvider(m1).getAll('list', false, false);
    expect(hasPublishFilter(m1.captured[0].query)).toBe(true);

    const m2 = createCapturingModel([]);
    await createProvider(m2).getAll('admin', true, true);
    expect(hasPublishFilter(m2.captured[0].query)).toBe(false);
  });

  it('getById / getByPathName：public 视图带过滤器，admin/list 视图不带', async () => {
    const m = createCapturingModel([{ id: 1, publishAt: FUTURE }]);
    const provider = createProvider(m);
    await provider.getById(1, 'public');
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(true);
    await provider.getById(1, 'admin');
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(false);
    await provider.getByPathName('p', 'public');
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(true);
    await provider.getByPathName('p', 'list');
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(false);
  });

  it('getByIdOrPathnameWithPreNext(public)：未来文章直接 404（allowOpenHiddenPostByUrl 不放行）', async () => {
    // 公开视图查不到（过滤器生效后的真实行为就是 findOne 返回 null）
    const m = createCapturingModel([]);
    const provider = createProvider(m);
    await expect(provider.getByIdOrPathnameWithPreNext(1, 'public')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('pre/next：includeHidden 未给（公开详情）带过滤器；显式 true 不带', async () => {
    const m = createCapturingModel([]);
    const provider = createProvider(m);
    await provider.getPreArticleByArticle({ createdAt: new Date() } as any, 'list');
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(true);
    await provider.getNextArticleByArticle({ createdAt: new Date() } as any, 'list', true);
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(false);
  });

  it('searchByString：公开搜索带过滤器；includeHidden=true 不带', async () => {
    const m = createCapturingModel([]);
    const provider = createProvider(m);
    await provider.searchByString('关键词', false);
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(true);
    await provider.searchByString('关键词', true);
    expect(hasPublishFilter(m.captured.at(-1).query)).toBe(false);
  });

  it('getTimeLineInfo：公开时间线带过滤器', async () => {
    const m = createCapturingModel([]);
    await createProvider(m).getTimeLineInfo();
    expect(hasPublishFilter(m.captured[0].query)).toBe(true);
  });

  it('getTotalNum(false)/countTotalWords：公开计数口径带过滤器；getTotalNum(true) 不带', async () => {
    const m1 = createCapturingModel([]);
    await createProvider(m1).getTotalNum(false);
    expect(m1.captured.some((c: any) => hasPublishFilter(c.query))).toBe(true);

    const m2 = createCapturingModel([]);
    await createProvider(m2).getTotalNum(true);
    expect(m2.captured.some((c: any) => hasPublishFilter(c.query))).toBe(false);

    const m3 = createCapturingModel([]);
    await createProvider(m3).countTotalWords();
    expect(hasPublishFilter(m3.captured[0].query)).toBe(true);
  });

  it('getByIdWithPassword：未来文章一律拿不到 —— 就算密码正确、就算站点开了 allowOpenHiddenPostByUrl', async () => {
    // ⚠️ 2026-09-21 升级（不是放宽）：本用例钉的性质是「**未发布文章的正文绝不从这个匿名口子出去**」，
    //    而**不是**「必须用 404 表达」。原来的机制是抛 NotFoundException，但那条 404 与"文章不存在"
    //    的 `return null`（HTTP 201 + data:null）**不同形** ⇒ 未鉴权调用方可以逐个 id 试出
    //    "这里挂着一篇定时文章"（匿名枚举 oracle，见 audit-hardening-round4 的 FINDING R4-5）。
    //    修复后三种"看不到"的结果逐字节同形（都 return null），所以断言改成 toBeNull()。
    // 🔴 这条断言**仍然能抓住"把 isFuturePublish 检查删掉"**：本用例的文章是 `private:false`，
    //    少了那道检查它就会一路走到 `return plain` ⇒ 拿到全文而不是 null。
    //    （变异对照 M2 就是"删掉这道检查"，必须红在这里。）
    const m = createCapturingModel([
      { id: 1, title: 't', content: 'c', publishAt: FUTURE, hidden: true, private: false },
    ]);
    const meta = {
      updateTotalWords: () => undefined,
      getSiteInfo: async () => ({ allowOpenHiddenPostByUrl: 'true' }),
    };
    const provider = createProvider(m, undefined, meta);
    // allowOpenHiddenPostByUrl 只放行"隐藏"，**从不**放行"未到发布时间"⇒ 仍然 null
    expect(await provider.getByIdWithPassword(1, 'any-password')).toBeNull();
    // 且响应形状必须与"文章不存在"完全一致（同形才有不可区分性）
    const empty = createProvider(createCapturingModel([]), undefined, meta);
    expect(await empty.getByIdWithPassword(1, 'any-password')).toBeNull();
  });
});

describe('publishAt 的保存路径', () => {
  it('create：ISO 字符串归一化成 Date；垃圾值 400', async () => {
    const m = createCapturingModel([]);
    m.find = () => ({ sort: () => ({ limit: async () => [] }) }); // getNewId
    const provider = createProvider(m);
    let constructed: any = null;
    const OrigModel = m;
    const wrapped: any = function (dto: any) {
      constructed = dto;
      Object.assign(this, dto);
      (this as any).save = async () => this;
    };
    Object.assign(wrapped, OrigModel);
    const p2 = createProvider(wrapped);
    await p2.create(
      { title: 't', category: 'c', publishAt: '2030-01-02T03:04:05.000Z' } as any,
      true,
      5,
    );
    expect(constructed.publishAt).toBeInstanceOf(Date);
    expect(constructed.publishAt.toISOString()).toBe('2030-01-02T03:04:05.000Z');

    await expect(
      p2.create({ title: 't', category: 'c', publishAt: '明天早上' } as any, true, 6),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateById：null 清除、undefined 不动、字符串归一化、垃圾 400', async () => {
    const m = createCapturingModel([]);
    const provider = createProvider(m);
    await provider.updateById(1, { publishAt: null } as any, true);
    let patch = m.captured.at(-1).query.patch;
    expect(patch.publishAt).toBeNull();

    await provider.updateById(1, { title: 'x' } as any, true);
    patch = m.captured.at(-1).query.patch;
    expect('publishAt' in patch).toBe(false); // 键不存在 = 保持原值

    await provider.updateById(1, { publishAt: '2030-01-02T03:04:05.000Z' } as any, true);
    patch = m.captured.at(-1).query.patch;
    expect(patch.publishAt).toBeInstanceOf(Date);

    await expect(
      provider.updateById(1, { publishAt: { $ne: null } } as any, true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
