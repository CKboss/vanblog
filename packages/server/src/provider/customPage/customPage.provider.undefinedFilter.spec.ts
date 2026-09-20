import { BadRequestException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { CustomPageProvider } from './customPage.provider';
import { assertSafeWriteFilter, isUsableFilterValue } from 'src/utils/queryFilter';

/**
 * Mongoose 会**静默丢掉值为 `undefined` 的查询条件**，于是 `{ path: undefined }` 实际执行的是 `{}`
 * —— 匹配集合里的**任意一条**（`updateOne`/`deleteOne` 取自然顺序第一条）。
 *
 * ⚠️ 这个 fake **必须**复现这一点。仓库里既有的 `customPage.provider.spec.ts` 那个内存 model 对
 * `{}` 查询返回 `null`，所以它**照不出这个缺陷**（在它上面跑，漏洞版代码同样是绿的）——
 * 这正是"测试替身比生产更严格，于是缺陷隐形"的典型。下面 `stripUndefined` + "空条件匹配第一条"
 * 两步合起来才等于 Mongoose 的真实行为。
 */
function stripUndefined(query: any) {
  const out: Record<string, any> = {};
  for (const key of Object.keys(query ?? {})) {
    if ((query as any)[key] !== undefined) {
      out[key] = (query as any)[key];
    }
  }
  return out;
}

function createFaithfulModel(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));
  const findMatching = (rawQuery: any) => {
    const query = stripUndefined(rawQuery);
    const keys = Object.keys(query);
    // 空条件 = 匹配任意一条（Mongo 的真实行为，也是这个缺陷的全部危害所在）
    if (keys.length === 0) {
      return docs[0] || null;
    }
    return (
      docs.find((item) => keys.every((key) => String(item[key]) === String(query[key]))) || null
    );
  };
  return {
    docs,
    /** 记录每次调用真正收到的 filter，供断言"绝不出现空条件/undefined 值" */
    calls: [] as Array<{ op: string; filter: any }>,
    findOne: jest.fn(async (query: any) => findMatching(query)),
    find: jest.fn(async () => docs.map((doc) => ({ ...doc }))),
    create: jest.fn(async (doc: any) => {
      const created = { _id: doc._id || `cp-${docs.length + 1}`, ...doc };
      docs.push(created);
      return created;
    }),
    updateOne: jest.fn(async (query: any, patch: any) => {
      const target = findMatching(query);
      if (!target) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(target, patch);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    deleteOne: jest.fn(async (query: any) => {
      const target = findMatching(query);
      if (!target) {
        return { acknowledged: true, deletedCount: 0 };
      }
      const index = docs.indexOf(target);
      docs.splice(index, 1);
      return { acknowledged: true, deletedCount: 1 };
    }),
  };
}

/** 把 provider 与 fake model 接起来，并顺带记录写操作真正收到的 filter。 */
function wire(initial: any[] = []) {
  const model = createFaithfulModel(initial);
  const recorded: Array<{ op: string; filter: any }> = [];
  for (const op of ['updateOne', 'deleteOne'] as const) {
    const original = model[op] as jest.Mock;
    model[op] = jest.fn(async (filter: any, ...rest: any[]) => {
      recorded.push({ op, filter });
      return original(filter, ...rest);
    }) as any;
  }
  const provider = new CustomPageProvider(model as any);
  return { provider, model, recorded };
}

const TWO_PAGES = [
  { _id: 'cp-1', name: '无辜的一页', path: '/uptime', type: 'file', html: '<p>original</p>' },
  { _id: 'cp-2', name: '另一页', path: '/about', type: 'file', html: '<p>about</p>' },
];

describe('自定义页面：查询条件里的 undefined 不能让它退化成"任意一页"', () => {
  it('PUT 不带 _id 也不带 path ⇒ 400，而且 updateOne 一次都没被调用', async () => {
    const { provider, recorded } = wire(TWO_PAGES);

    // 这就是攻击/误用的形状：body 里只有要写进去的内容，没有任何标识符。
    await expect(
      provider.updateCustomPage({ html: '<script>alert(1)</script>' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(provider.updateCustomPage({} as any)).rejects.toBeInstanceOf(BadRequestException);
    // 空串与 'undefined' 字面量同样不可用（前端把 undefined 拼进 JSON/URL 的常见形状）
    await expect(
      provider.updateCustomPage({ path: '', html: 'x' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      provider.updateCustomPage({ path: '  ', html: 'x' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    // ⚠️ 这条才是本体：不是"抛了错"就算修好了，而是**写操作根本没发生**。
    expect(recorded).toEqual([]);
  });

  it('400 的消息是可照做的（说清要带 _id 或 path）', async () => {
    const { provider } = wire(TWO_PAGES);
    const error = await provider.updateCustomPage({ html: 'x' } as any).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String(error.message)).toContain('_id');
    expect(String(error.message)).toContain('path');
  });

  it('合法形状仍然工作：带 _id（改路由也能命中原来那行）', async () => {
    const { provider, model, recorded } = wire(TWO_PAGES);

    await provider.updateCustomPage({ _id: 'cp-2', name: '新名字', path: '/renamed' } as any);

    expect(model.docs[1]).toMatchObject({ _id: 'cp-2', name: '新名字', path: '/renamed' });
    expect(model.docs[0].html).toBe('<p>original</p>');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].filter).toEqual({ _id: 'cp-2' });
  });

  it('合法形状仍然工作：只带 path（旧客户端/脚本的兜底形状）', async () => {
    const { provider, model, recorded } = wire(TWO_PAGES);

    await provider.updateCustomPage({ path: '/uptime', name: '状态页' } as any);

    expect(model.docs[0]).toMatchObject({ _id: 'cp-1', name: '状态页', html: '<p>original</p>' });
    expect(recorded[0].filter).toEqual({ path: '/uptime' });
  });

  it('写操作收到的 filter 永远非空、且不含值为 undefined 的键', async () => {
    const { provider, recorded } = wire(TWO_PAGES);

    await provider.updateCustomPage({ _id: 'cp-1', html: '<p>ok</p>' } as any);
    await provider.updateCustomPage({ path: '/about', html: '<p>ok</p>' } as any);
    await provider.deleteByPath('/uptime');

    expect(recorded.length).toBeGreaterThanOrEqual(3);
    for (const { filter } of recorded) {
      const keys = Object.keys(filter ?? {});
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => filter[key] === undefined)).toEqual([]);
    }
  });

  it('DELETE 不带 path ⇒ 400，且 deleteOne 一次都没被调用（不删掉无辜的一页）', async () => {
    const { provider, model, recorded } = wire(TWO_PAGES);

    await expect(provider.deleteByPath(undefined as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(provider.deleteByPath('' as any)).rejects.toBeInstanceOf(BadRequestException);

    expect(recorded).toEqual([]);
    expect(model.docs).toHaveLength(2);
    expect(model.docs[0].name).toBe('无辜的一页');
  });

  it('DELETE 带 path 仍然正常删除', async () => {
    const { provider, model } = wire(TWO_PAGES);
    const result = await provider.deleteByPath('/uptime');
    expect(result).toMatchObject({ deletedCount: 1 });
    expect(model.docs.map((doc) => doc.path)).toEqual(['/about']);
  });

  it('读侧失败关闭：path 不可用时返回 null，而不是返回任意一页', async () => {
    const { provider, model } = wire(TWO_PAGES);

    expect(await provider.getCustomPageByPath(undefined as any)).toBeNull();
    expect(await provider.getCustomPageByPath('' as any)).toBeNull();
    expect(model.findOne).not.toHaveBeenCalled();
    // 正常路径不受影响
    expect(await provider.getCustomPageByPath('/about')).toMatchObject({ _id: 'cp-2' });
  });

  it('CREATE 不带 path ⇒ 400（而不是莫名其妙的"已有此路由"403）', async () => {
    const { provider, model } = wire(TWO_PAGES);

    await expect(provider.createCustomPage({ name: '新页' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(model.create).not.toHaveBeenCalled();
    // 既有行为保持：路径冲突仍然是 403
    await expect(
      provider.createCustomPage({ name: '撞车', path: '/about' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('queryFilter：共用判据本身', () => {
  it('认哪些值可用', () => {
    // 可用
    expect(isUsableFilterValue('cp-1')).toBe(true);
    expect(isUsableFilterValue('/uptime')).toBe(true);
    expect(isUsableFilterValue(0)).toBe(true); // 本仓库有 id:0 表示管理员的约定，0 必须算可用
    expect(isUsableFilterValue(7)).toBe(true);
    expect(isUsableFilterValue(false)).toBe(true); // { disabled: false } 是合法条件
    expect(isUsableFilterValue(new Date())).toBe(true);
    expect(isUsableFilterValue({ toHexString: () => 'abc' })).toBe(true); // ObjectId 形状
    // 不可用
    expect(isUsableFilterValue(undefined)).toBe(false);
    expect(isUsableFilterValue(null)).toBe(false);
    expect(isUsableFilterValue('')).toBe(false);
    expect(isUsableFilterValue('   ')).toBe(false);
    expect(isUsableFilterValue('undefined')).toBe(false);
    expect(isUsableFilterValue('NULL')).toBe(false);
    expect(isUsableFilterValue(Number.NaN)).toBe(false);
    expect(isUsableFilterValue({})).toBe(false);
  });

  it('⚠️ 写侧 filter 连 null 一起拒（比"防止条件消失"更严，这是有意的取舍）', () => {
    // `{ field: null }` 在 Mongo 里确实是合法条件（匹配 null **与字段不存在**），所以它不会"消失"；
    // 但写操作的 filter 语义是"定位这一行"，而 null 匹配的是一个**集合** ⇒ 拿它 update/delete
    // 同样会命中意料之外的文档。本仓库所有写侧 filter 都按标识符定位，所以一律拒。
    // ⚠️ 真需要"按 null 查询"的**读**操作不要用 assertSafeWriteFilter（它只管写）。
    expect(isUsableFilterValue(null)).toBe(false);
    expect(() => assertSafeWriteFilter({ deleted: null }, 'x')).toThrow(
      InternalServerErrorException,
    );
    expect(() => assertSafeWriteFilter({ deleted: undefined }, 'x')).toThrow(
      InternalServerErrorException,
    );
    // 布尔 false 与数字 0 必须放行（`{ disabled: false }`、`{ id: 0 }` 都是本仓库的合法条件）
    expect(() => assertSafeWriteFilter({ disabled: false }, 'x')).not.toThrow();
    expect(() => assertSafeWriteFilter({ id: 0 }, 'x')).not.toThrow();
  });

  it('assertSafeWriteFilter 拦住空条件与 undefined 值（这是"将来加第三个分支"的防线）', () => {
    expect(() => assertSafeWriteFilter({}, 'ctx')).toThrow(InternalServerErrorException);
    expect(() => assertSafeWriteFilter({ path: undefined }, 'ctx')).toThrow(
      InternalServerErrorException,
    );
    expect(() => assertSafeWriteFilter({ _id: 'cp-1' }, 'ctx')).not.toThrow();
    // 500 而不是 400：走到这里说明**代码**漏了校验，报成 400 会把它藏进"用户乱传参数"的噪音里
    const error = (() => {
      try {
        assertSafeWriteFilter({}, 'CustomPageProvider.updateCustomPage');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(String((error as any).message)).toContain('CustomPageProvider.updateCustomPage');
  });

  it('负向对照：这把尺子在缺陷版代码上会失手吗（证明断言不是装饰）', () => {
    // 缺陷版的 filter 构造：id 与 path 都缺失时得到 { path: undefined }
    const defectiveFilter = (id: unknown, path: unknown) =>
      id ? { _id: id } : { path };
    expect(defectiveFilter(undefined, undefined)).toEqual({ path: undefined });
    // 它在 faithful model 下会命中第一条 —— 这就是"任意一页"被改写的机制
    const model = createFaithfulModel(TWO_PAGES);
    expect(Object.keys(stripUndefined(defectiveFilter(undefined, undefined)))).toEqual([]);
    // 而 assertSafeWriteFilter 会拦住它
    expect(() =>
      assertSafeWriteFilter(defectiveFilter(undefined, undefined) as any, 'ctx'),
    ).toThrow(InternalServerErrorException);
  });
});
