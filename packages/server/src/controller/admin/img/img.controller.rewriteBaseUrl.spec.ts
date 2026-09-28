import { ImgController } from './img.controller';
import { config } from 'src/config';

describe('ImgController.rewriteBaseUrl (#475)', () => {
  const originalDemo = config.demo;

  afterEach(() => {
    config.demo = originalDemo;
  });

  function createController() {
    const articleProvider = {
      rewriteBaseUrl: jest.fn().mockResolvedValue({ updated: 2, replacements: 5 }),
    };
    const draftProvider = {
      rewriteBaseUrl: jest.fn().mockResolvedValue({ updated: 1, replacements: 2 }),
    };
    const isrProvider = { activeAll: jest.fn() };
    const controller = new ImgController(
      {} as any,
      articleProvider as any,
      draftProvider as any,
      isrProvider as any,
      {} as any,
    );
    return { controller, articleProvider, draftProvider, isrProvider };
  }

  it('rewrites articles and drafts then triggers ISR when articles changed', async () => {
    const { controller, articleProvider, draftProvider, isrProvider } = createController();
    const result = await controller.rewriteBaseUrl({
      oldBase: 'https://old.example.com/',
      newBase: 'https://new.example.com',
    });

    expect(articleProvider.rewriteBaseUrl).toHaveBeenCalledWith(
      'https://old.example.com/',
      'https://new.example.com',
    );
    expect(draftProvider.rewriteBaseUrl).toHaveBeenCalledWith(
      'https://old.example.com/',
      'https://new.example.com',
    );
    expect(isrProvider.activeAll).toHaveBeenCalledWith('域名改写触发增量渲染！');
    expect(result).toEqual({
      statusCode: 200,
      data: { articlesUpdated: 2, draftsUpdated: 1, replacements: 7 },
    });
  });

  it('does not trigger ISR when no published article was updated', async () => {
    const { controller, articleProvider, isrProvider } = createController();
    articleProvider.rewriteBaseUrl.mockResolvedValue({ updated: 0, replacements: 0 });
    const result = await controller.rewriteBaseUrl({
      oldBase: 'https://old.example.com',
      newBase: 'https://new.example.com',
    });
    expect(isrProvider.activeAll).not.toHaveBeenCalled();
    // 🔴 期 9 第七批：演示站那一支现在返回 `codedBody(...)`，它的类型是**精确的**
    //    `{ statusCode; message; code; params? }` ⇒ 与方法成功支的 `{ statusCode, data }` 组成联合后，
    //    TS 不再允许直接 `.data`（联合类型只能访问**所有**成员都有的属性）。
    //    ⚠️ 这是**好**的方向（返回体形状被精确钉住了），所以这里在测试侧断言处显式 `as any`，
    //    而不是把 `codedBody` 的返回类型放宽成带索引签名（那会让所有调用点都失去形状检查）。

    expect((result as any).data).toEqual({ articlesUpdated: 0, draftsUpdated: 1, replacements: 2 });
  });

  it('blocks the rewrite on the demo site', async () => {
    config.demo = 'true';
    const { controller, articleProvider, isrProvider } = createController();
    const result = await controller.rewriteBaseUrl({
      oldBase: 'https://old.example.com',
      newBase: 'https://new.example.com',
    });
    // 🔴 期 9 第七批：演示站信封现在由 `codedBody()` 组装 ⇒ 响应体**多出** `code` 字段。
    //    这里**照实把 code 写进期望值**，而不是改成 objectContaining 放松：
    //    严格 toEqual 钉的是形状，而要钉的性质是「401 + 那句中文 + 现在还要带码」；
    //    放松会让「哪天 code 丢了」也静默通过（那正是最不想要的失败模式）。

    expect(result).toEqual({ statusCode: 401, message: '演示站禁止修改此项！', code: 'demoSiteBlocked' });
    expect(articleProvider.rewriteBaseUrl).not.toHaveBeenCalled();
    expect(isrProvider.activeAll).not.toHaveBeenCalled();
  });
});
