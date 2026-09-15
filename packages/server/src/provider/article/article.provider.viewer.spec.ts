import { ArticleProvider } from './article.provider';

/**
 * 阅读量计数与「畸形别名」的行为。
 *
 * 两个真实缺陷：
 *  1) `updateViewerByPathname` / `updateViewer` 以前是「读出来 +1，再写回绝对值」，
 *     两个人同时看同一篇文章时后写的会覆盖先写的 —— 阅读量**永久少计**。
 *     visit / meta 两个 provider 早就改成原子 $inc 了，文章这边漏了。
 *  2) `getByPathName` 里直接 `decodeURIComponent(pathname)`，`%25` 就能让公开接口 500。
 */
function createStub(docs: any[]) {
  const calls: Array<{ filter: any; update: any }> = [];
  const model: any = {
    findOne: jest.fn((query: any) => {
      const found = docs.find((d) => {
        if (query.pathname !== undefined && d.pathname !== query.pathname) return false;
        if (query.id !== undefined && d.id !== query.id) return false;
        return true;
      });
      return { exec: jest.fn().mockResolvedValue(found ? { ...found } : null) };
    }),
    updateOne: jest.fn((filter: any, update: any) => {
      calls.push({ filter, update });
      return { exec: jest.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }) };
    }),
  };
  return { model, calls };
}

const makeProvider = (model: any) =>
  new ArticleProvider(model, {} as any, { updateTotalWords: jest.fn() } as any, {} as any);

describe('阅读量计数必须是原子的', () => {
  it('updateViewerByPathname 用 $inc，不写回绝对值', async () => {
    const { model, calls } = createStub([
      { id: 7, pathname: 'hello', viewer: 100, visited: 5 },
    ]);
    const provider = makeProvider(model);
    await provider.updateViewerByPathname('hello', true);
    expect(calls).toHaveLength(1);
    const upd = calls[0].update;
    expect(upd.$inc).toEqual({ viewer: 1, visited: 1 });
    expect(upd.$set?.lastVisitedTime).toBeInstanceOf(Date);
    // 绝对值写回就是并发丢计数的根源，必须消失
    expect(upd.viewer).toBeUndefined();
    expect(upd.visited).toBeUndefined();
  });

  it('不是新访客时只加 viewer，不加 visited', async () => {
    const { model, calls } = createStub([{ id: 7, pathname: 'hello', viewer: 3, visited: 3 }]);
    await makeProvider(model).updateViewerByPathname('hello', false);
    expect(calls[0].update.$inc).toEqual({ viewer: 1 });
  });

  it('updateViewer(id) 同样是原子 $inc', async () => {
    const { model, calls } = createStub([{ id: 9, pathname: 'x', viewer: 1, visited: 1 }]);
    await makeProvider(model).updateViewer(9, true);
    expect(calls).toHaveLength(1);
    expect(calls[0].update.$inc).toEqual({ viewer: 1, visited: 1 });
    expect(calls[0].filter).toEqual({ id: 9 });
  });

  it('文章不存在时什么都不写', async () => {
    const { model, calls } = createStub([]);
    await makeProvider(model).updateViewerByPathname('nope', true);
    expect(calls).toHaveLength(0);
  });
});

describe('畸形别名不能让公开接口 500', () => {
  it.each(['%', '%zz', '%E0%A4%A', '%%'])('getByPathName(%j) 不抛异常', async (bad) => {
    const { model } = createStub([{ id: 1, pathname: 'real' }]);
    const provider = makeProvider(model);
    await expect(provider.getByPathName(bad, 'list')).resolves.not.toThrow();
  });

  it('正常别名仍然查得到', async () => {
    const { model } = createStub([{ id: 1, pathname: 'real' }]);
    const found = await makeProvider(model).getByPathName('real', 'list');
    expect(found?.id).toBe(1);
  });

  it('编码后的别名会被解码后再查（%E4%B8%AD%E6%96%87 → 中文）', async () => {
    const { model } = createStub([{ id: 2, pathname: '中文' }]);
    const found = await makeProvider(model).getByPathName('%E4%B8%AD%E6%96%87', 'list');
    expect(found?.id).toBe(2);
  });
});
