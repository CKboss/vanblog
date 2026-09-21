import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '@nestjs/passport';
import request from 'supertest';
import { SiteMetaController } from '../src/controller/admin/site/site.meta.controller';
import { AccessGuard } from '../src/provider/access/access.guard';
import { TokenGuard } from '../src/provider/auth/token.guard';
import { ISRProvider } from '../src/provider/isr/isr.provider';
import { MetaProvider } from '../src/provider/meta/meta.provider';
import { PipelineProvider } from '../src/provider/pipeline/pipeline.provider';
import { WalineProvider } from '../src/provider/waline/waline.provider';
import { WebsiteProvider } from '../src/provider/website/website.provider';
import { DEFAULT_FRIEND_LINK_INTRO, resolvePageCopy } from '../src/utils/pageCopy';

/**
 * End-to-end of issue #373: friend-link / about page copy is stored on
 * site settings and empty values fall back to the previous hardcoded text.
 */
function createMemoryMetaModel() {
  // ⚠️ `_id` 必须有：2026-09-20 起 MetaProvider 的写路径先过 `requireMetaDocument()`
  //    （8fc1ae18/7139563d，空 filter 写库加固），meta 文档缺 `_id` 会抛 NotFoundException
  //    ⇒ updateSiteInfo 等写接口在测试里变成 404。产品行为是有意的，是替身没跟上。
  const state: any = {
    _id: 'e2e-meta-doc',
    siteInfo: { siteName: 'demo', baseUrl: 'https://blog.example.com' },
  };
  return {
    state,
    findOne: jest.fn(() => ({
      exec: async () => state,
    })),
    updateOne: jest.fn(async (_query: any, patch: any) => {
      Object.assign(state, patch);
      return { acknowledged: true, modifiedCount: 1 };
    }),
  };
}

async function createApp() {
  const model = createMemoryMetaModel();
  // MetaProvider 只有 4 个构造参数 (metaModel, userProvider, articleProvider, viewStats)，
  // 这里以前传了 5 个（TS2554）；而 viewStats 不能是空对象 —— update() 会调
  // viewStats.invalidateBase()。这个 e2e 既不在默认 jest 里也不在 tsc 的 include 里，
  // 所以烂了很久没人发现。
  const metaProvider = new MetaProvider(model as any, {} as any, {} as any, {
    invalidateBase: () => undefined,
  } as any);
  const allow = { canActivate: () => true };
  const moduleRef = await Test.createTestingModule({
    controllers: [SiteMetaController],
    providers: [
      { provide: MetaProvider, useValue: metaProvider },
      { provide: ISRProvider, useValue: { activeAll: jest.fn() } },
      // ⚠️ restart()/dispatchEvent() 必须返回 Promise：controller 里是
      // `this.walineProvider.restart(...).catch(...)`（后来加的"发出去就不管但必须挂 catch"），
      // 桩返回 undefined 会让 update 直接 500（TypeError: reading 'catch'）。
      { provide: WalineProvider, useValue: { restart: jest.fn(async () => undefined) } },
      { provide: WebsiteProvider, useValue: { restart: jest.fn(async () => undefined) } },
      { provide: PipelineProvider, useValue: { dispatchEvent: jest.fn(async () => undefined) } },
    ],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useValue(allow)
    .overrideGuard(TokenGuard)
    .useValue(allow)
    .overrideGuard(AccessGuard)
    .useValue(allow)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, metaProvider, model };
}

describe('site page copy (e2e #373)', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  it('persists custom friend-link and about copy through admin site settings', async () => {
    const created = await createApp();
    app = created.app;
    const server = app.getHttpServer();

    const updated = await request(server).put('/api/admin/meta/site').send({
      siteName: 'demo',
      friendLinkIntro: '这些是朋友们的站点：',
      friendLinkApplyContent: '请先留言。名称：{{siteName}}',
      aboutTitle: 'About this blog',
    });
    expect(updated.body.statusCode).toBe(200);

    const stored = await request(server).get('/api/admin/meta/site');
    expect(stored.body.statusCode).toBe(200);
    expect(stored.body.data.friendLinkIntro).toBe('这些是朋友们的站点：');
    expect(stored.body.data.friendLinkApplyContent).toBe('请先留言。名称：{{siteName}}');
    expect(stored.body.data.aboutTitle).toBe('About this blog');
  });

  it('empty copy falls back to the previous hardcoded friend-link intro', async () => {
    const created = await createApp();
    app = created.app;
    const server = app.getHttpServer();

    await request(server).put('/api/admin/meta/site').send({
      siteName: 'demo',
      friendLinkIntro: '',
      friendLinkApplyContent: '  ',
      aboutTitle: '',
    });
    const stored = await request(server).get('/api/admin/meta/site');
    expect(stored.body.data.friendLinkIntro).toBe('');
    expect(resolvePageCopy(stored.body.data.friendLinkIntro, DEFAULT_FRIEND_LINK_INTRO)).toBe(
      DEFAULT_FRIEND_LINK_INTRO,
    );
    expect(resolvePageCopy(stored.body.data.aboutTitle, '关于我')).toBe('关于我');
  });
});
