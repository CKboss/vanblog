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
    expect(res).toEqual({ statusCode: 401, message: '演示站禁止修改此项！' });
    expect(upload).not.toHaveBeenCalled();
  });
});
