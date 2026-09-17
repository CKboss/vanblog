import { ArticleController } from './article.controller';

function createController() {
  const articleProvider = {
    getByOption: jest.fn().mockResolvedValue({ articles: [], total: 0 }),
  };
  const controller = new ArticleController(
    articleProvider as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, articleProvider };
}

describe('ArticleController.getByOption (#400)', () => {
  it('passes a normal page through to the provider', async () => {
    const { controller, articleProvider } = createController();
    await controller.getByOption(2 as any, 10 as any);
    expect(articleProvider.getByOption).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 10 }),
      false,
    );
  });

  it('does not forward NaN / negative / overflow page as a Mongo skip', async () => {
    const hostilePages = [
      undefined,
      NaN,
      'NaN',
      '',
      'abc',
      -1,
      0,
      '-9223372036854775808',
      Infinity,
      Number.MAX_VALUE,
    ];
    for (const page of hostilePages) {
      const { controller, articleProvider } = createController();
      await controller.getByOption(page as any, 10 as any);
      const option = articleProvider.getByOption.mock.calls[0][0];
      const skip = (option.page - 1) * option.pageSize;
      expect(Number.isFinite(option.page)).toBe(true);
      expect(option.page).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(option.pageSize)).toBe(true);
      expect(option.pageSize).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(skip)).toBe(true);
      expect(skip).toBeGreaterThanOrEqual(0);
    }
  });

  it('replaces an invalid pageSize so skip stays non-negative', async () => {
    const { controller, articleProvider } = createController();
    await controller.getByOption(1 as any, 'not-a-size' as any);
    const option = articleProvider.getByOption.mock.calls[0][0];
    expect(option.pageSize).toBeGreaterThanOrEqual(1);
    expect((option.page - 1) * option.pageSize).toBe(0);
  });
});

describe('ArticleController.create pathname (#383)', () => {
  it('forwards the same optional pathname as create-article', async () => {
    const articleProvider = {
      create: jest.fn().mockResolvedValue({ id: 42, pathname: 'cb933e30' }),
    };
    const isrProvider = { activeAll: jest.fn() };
    const pipelineProvider = { dispatchEvent: jest.fn().mockResolvedValue([]) };
    const controller = new ArticleController(
      articleProvider as any,
      isrProvider as any,
      pipelineProvider as any,
      {} as any,
      {} as any,
    );

    const result = await controller.create({ user: { nickname: 'admin' } }, {
      title: 'Hexo 迁移',
      category: '测试',
      pathname: 'cb933e30',
      content: 'body',
    } as any);

    expect(articleProvider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Hexo 迁移',
        category: '测试',
        pathname: 'cb933e30',
        author: 'admin',
      }),
    );
    expect(result).toEqual({ statusCode: 200, data: { id: 42, pathname: 'cb933e30' } });
  });
});

describe('ArticleController.create/update cover (#288)', () => {
  it('forwards optional cover on create and update', async () => {
    const articleProvider = {
      create: jest.fn().mockResolvedValue({ id: 288, cover: '/static/img/hero.webp' }),
      getById: jest.fn().mockResolvedValue({ id: 288, pathname: 'cover-test' }),
      updateById: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const isrProvider = { activeAll: jest.fn() };
    const pipelineProvider = { dispatchEvent: jest.fn().mockResolvedValue([]) };
    const controller = new ArticleController(
      articleProvider as any,
      isrProvider as any,
      pipelineProvider as any,
      {} as any,
      {} as any,
    );

    await controller.create({ user: { nickname: 'admin' } }, {
      title: '题头图',
      category: '测试',
      cover: '/static/img/hero.webp',
    } as any);
    expect(articleProvider.create).toHaveBeenCalledWith(
      expect.objectContaining({ cover: '/static/img/hero.webp' }),
    );

    await controller.update(288 as any, { cover: '' } as any);
    expect(articleProvider.updateById).toHaveBeenCalledWith(288, expect.objectContaining({ cover: '' }));
  });
});


// ---------------------------------------------------------------------------
// 访问密码：流水线脱敏之后，调用方的密码意图必须**透传**回来（G5 的另一半）
//
// 事件 payload 已经不带 password 了（见 provider/pipeline/pipeline.provider.secrets.spec.ts），
// 所以脚本改写 DTO 后返回的 output 里也不会有它；而控制器是 `updateDto = lastOutput`
// **整体替换**的。不透传就会静默丢掉用户刚输入的新密码（"留空 = 不修改"），
// 用户看到"保存成功"，密码却根本没变。
// ---------------------------------------------------------------------------

describe('ArticleController：流水线改写 DTO 后仍保住调用方的密码意图', () => {
  function createStack(beforeOutput: any) {
    const articleProvider = {
      create: jest.fn().mockResolvedValue({ id: 7, pathname: 'p' }),
      getById: jest.fn().mockResolvedValue({ id: 7, pathname: 'p' }),
      updateById: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const isrProvider = { activeAll: jest.fn() };
    const pipelineProvider = {
      dispatchEvent: jest.fn(async (event: string) =>
        event === 'beforeUpdateArticle' && beforeOutput !== undefined
          ? [{ status: 'success', output: beforeOutput, logs: [] }]
          : [],
      ),
    };
    const controller = new ArticleController(
      articleProvider as any,
      isrProvider as any,
      pipelineProvider as any,
      {} as any,
      {} as any,
    );
    return { controller, articleProvider, pipelineProvider };
  }

  it('update：脚本返回的 output 没有 password ⇒ 用调用方的原值（新密码不会静默丢失）', async () => {
    const stack = createStack({ title: '脚本改过的标题' });
    await stack.controller.update(7 as any, {
      title: '原标题',
      password: 'user-typed-pw',
      private: true,
    } as any);
    const patch = stack.articleProvider.updateById.mock.calls[0][1];
    expect(patch.title).toBe('脚本改过的标题'); // 脚本的改写仍然生效
    expect(patch.password).toBe('user-typed-pw'); // 密码意图被透传回来
    // ⚠️ 只透传**顶层的 password / clearPassword 两个键**，别的字段一律以脚本 output 为准
    // （整体替换是既有语义，这次不动它）：脚本没回 private，那就没有 private。
    expect('private' in patch).toBe(false);
  });

  it('update：脚本自己给了 clearPassword ⇒ 不覆盖它；两个键都送到 provider（由它 400）', async () => {
    // 脚本说"清掉"，用户说"设成这个"——两种意图都不该被静默丢弃，所以两个键都保留、
    // 一起交给 provider；`resolveAccessPasswordWrite` 会对这个组合抛 BadRequest
    // （响亮失败，不猜。那条 400 的钉子在 utils/accessPassword.spec.ts 与
    //  provider/article/article.provider.accessPassword.spec.ts 里，这里的 provider 是 mock）。
    const stack = createStack({ clearPassword: true });
    await stack.controller.update(7 as any, { password: 'user-typed-pw' } as any);
    const patch = stack.articleProvider.updateById.mock.calls[0][1];
    expect(patch.clearPassword).toBe(true);
    expect(patch.password).toBe('user-typed-pw');
  });

  it('update：脚本只给 clearPassword、调用方没填密码 ⇒ 清除照做', async () => {
    const stack = createStack({ clearPassword: true });
    await stack.controller.update(7 as any, { title: 't' } as any);
    const patch = stack.articleProvider.updateById.mock.calls[0][1];
    expect(patch.clearPassword).toBe(true);
    expect('password' in patch).toBe(false);
  });

  it('update：没有流水线（output 为空数组）⇒ DTO 原样传下去', async () => {
    const stack = createStack(undefined);
    await stack.controller.update(7 as any, { password: 'pw' } as any);
    expect(stack.articleProvider.updateById.mock.calls[0][1].password).toBe('pw');
  });

  it('create：同样透传（新建时填的密码不会被脚本改写吃掉）', async () => {
    const stack = createStack({ title: '脚本改过的标题', category: '随笔' });
    await stack.controller.create({ user: { nickname: 'admin' } } as any, {
      title: '原标题',
      category: '随笔',
      password: 'brand-new-pw',
      private: true,
    } as any);
    const dto = stack.articleProvider.create.mock.calls[0][0];
    expect(dto.title).toBe('脚本改过的标题');
    expect(dto.password).toBe('brand-new-pw');
  });

  it('质量赋值防护不受影响：deleted/viewer/visited/id/deletedAt/wordCount 仍然被删掉', async () => {
    const stack = createStack({ title: 'x' });
    await stack.controller.update(7 as any, {
      title: 't',
      deleted: true,
      viewer: 999,
      visited: 999,
      id: 999,
      deletedAt: new Date(),
      wordCount: 999,
    } as any);
    const patch = stack.articleProvider.updateById.mock.calls[0][1];
    for (const field of ['deleted', 'viewer', 'visited', 'id', 'deletedAt', 'wordCount']) {
      expect(field in patch).toBe(false);
    }
  });
});
