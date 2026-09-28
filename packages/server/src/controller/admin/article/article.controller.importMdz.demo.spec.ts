// 演示站禁改：与其余写接口同一形状（401 + message，不抛异常）。
// 单独一个文件是因为 config 需要整文件级 mock 成 demo='true'。
jest.mock('src/config', () => ({ config: { demo: 'true' } }));

import { ArticleController } from './article.controller';

describe('import-mdz 在演示站', () => {
  it('直接 401，不碰文件、不碰图床', async () => {
    const upload = jest.fn();
    const controller = new ArticleController(
      {} as any,
      {} as any,
      {} as any,
      { upload } as any,
      { getSiteInfo: jest.fn() } as any,
    );
    const res = await controller.importMdz(
      { buffer: Buffer.from('PK\u0003\u0004xxxx') } as any,
      { user: {} } as any,
    );
    // 🔴 期 9 第七批：演示站信封现在由 `codedBody()` 组装 ⇒ 响应体**多出** `code` 字段。
    //    这里**照实把 code 写进期望值**，而不是改成 objectContaining 放松：
    //    严格 toEqual 钉的是形状，而要钉的性质是「401 + 那句中文 + 现在还要带码」；
    //    放松会让「哪天 code 丢了」也静默通过（那正是最不想要的失败模式）。

    expect(res).toEqual({ statusCode: 401, message: '演示站禁止修改此项！', code: 'demoSiteBlocked' });
    expect(upload).not.toHaveBeenCalled();
  });
});
