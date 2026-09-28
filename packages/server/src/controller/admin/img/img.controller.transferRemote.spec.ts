import { ImgController } from './img.controller';
import { config } from 'src/config';

describe('ImgController.transferRemote (#434)', () => {
  const originalDemo = config.demo;

  afterEach(() => {
    config.demo = originalDemo;
  });

  function createController() {
    const staticProvider = {
      transferRemoteImages: jest.fn().mockResolvedValue({
        content: '![a](/static/img/a.webp)',
        transferred: [{ from: 'https://cdn.other.com/a.png', to: '/static/img/a.webp' }],
        skipped: [{ url: '/static/img/keep.webp', reason: 'relative' }],
        failed: [],
      }),
    };
    const metaProvider = {
      getSiteInfo: jest.fn().mockResolvedValue({ baseUrl: 'https://blog.example.com/' }),
    };
    const controller = new ImgController(
      staticProvider as any,
      {} as any,
      {} as any,
      {} as any,
      metaProvider as any,
    );
    return { controller, staticProvider, metaProvider };
  }

  it('rewrites the submitted markdown through the static transfer pipeline', async () => {
    const { controller, staticProvider, metaProvider } = createController();
    const result = await controller.transferRemote({
      content: '![a](https://cdn.other.com/a.png)',
      siteHost: 'blog.example.com',
    });

    expect(metaProvider.getSiteInfo).toHaveBeenCalled();
    expect(staticProvider.transferRemoteImages).toHaveBeenCalledWith(
      '![a](https://cdn.other.com/a.png)',
      {
        siteBaseUrl: 'https://blog.example.com/',
        siteHosts: ['blog.example.com'],
      },
    );
    expect(result).toEqual({
      statusCode: 200,
      data: {
        content: '![a](/static/img/a.webp)',
        transferred: [{ from: 'https://cdn.other.com/a.png', to: '/static/img/a.webp' }],
        skipped: [{ url: '/static/img/keep.webp', reason: 'relative' }],
        failed: [],
      },
    });
  });

  it('blocks the transfer on the demo site', async () => {
    config.demo = 'true';
    const { controller, staticProvider } = createController();
    const result = await controller.transferRemote({
      content: '![a](https://cdn.other.com/a.png)',
    });
    // 🔴 期 9 第七批：演示站信封现在由 `codedBody()` 组装 ⇒ 响应体**多出** `code` 字段。
    //    这里**照实把 code 写进期望值**，而不是改成 objectContaining 放松：
    //    严格 toEqual 钉的是形状，而要钉的性质是「401 + 那句中文 + 现在还要带码」；
    //    放松会让「哪天 code 丢了」也静默通过（那正是最不想要的失败模式）。

    expect(result).toEqual({ statusCode: 401, message: '演示站禁止修改此项！', code: 'demoSiteBlocked' });
    expect(staticProvider.transferRemoteImages).not.toHaveBeenCalled();
  });
});
