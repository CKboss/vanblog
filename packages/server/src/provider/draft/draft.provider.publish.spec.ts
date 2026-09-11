import { DraftProvider } from './draft.provider';

function createDraftModelStub(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));
  const findMatching = (query: any) =>
    docs.find((item) => {
      if (query?.id != null && item.id !== query.id) {
        return false;
      }
      if (query?.deleted === false && item.deleted) {
        return false;
      }
      return true;
    }) || null;

  return {
    docs,
    findOne: jest.fn((query: any) => ({ exec: async () => findMatching(query) })),
    updateOne: jest.fn((query: any, patch: any) => ({
      exec: async () => {
        const target = findMatching(query);
        if (!target) {
          return { modifiedCount: 0 };
        }
        Object.assign(target, patch);
        return { modifiedCount: 1 };
      },
    })),
  };
}

function createProvider(model: any) {
  const created: any[] = [];
  const articleProvider = {
    create: jest.fn(async (dto: any) => {
      created.push(dto);
      return { ...dto, id: 99 };
    }),
  };
  const provider = new DraftProvider(model, articleProvider as any);
  return { provider, articleProvider, created };
}

const LONG_BODY = '正文'.repeat(150); // 300 字，超过前台 200 字的自动摘要预算

describe('DraftProvider.publish without a <!-- more --> marker', () => {
  it('publishes instead of rejecting, and keeps the content untouched', async () => {
    const model = createDraftModelStub([
      {
        id: 3,
        title: '没有 more 的草稿',
        content: LONG_BODY,
        tags: ['随笔'],
        category: '博客',
        author: 'JiangOil',
        deleted: false,
      },
    ]);
    const { provider, articleProvider, created } = createProvider(model);

    const res: any = await provider.publish(3, { hidden: false, pathname: 'my-slug' });

    // 前台会自动截取前 200 字作为摘要，所以这里不再要求作者手写标记
    expect(articleProvider.create).toHaveBeenCalledTimes(1);
    expect(created[0]).toMatchObject({
      title: '没有 more 的草稿',
      category: '博客',
      author: 'JiangOil',
      pathname: 'my-slug',
      hidden: false,
    });
    expect(created[0].content).toBe(LONG_BODY);
    expect(res.id).toBe(99);
    // 发布后草稿被软删除
    expect(model.docs[0].deleted).toBe(true);
  });

  it('still publishes a draft that does contain the marker', async () => {
    const model = createDraftModelStub([
      {
        id: 4,
        title: '带 more 的草稿',
        content: `摘要部分\n\n<!-- more -->\n\n${LONG_BODY}`,
        tags: [],
        category: '博客',
        deleted: false,
      },
    ]);
    const { provider, created } = createProvider(model);

    await provider.publish(4, {});

    expect(created[0].content).toContain('<!-- more -->');
    expect(model.docs[0].deleted).toBe(true);
  });
});
