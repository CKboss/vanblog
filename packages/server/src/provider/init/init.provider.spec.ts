import { HttpException } from '@nestjs/common';
import { InitProvider } from './init.provider';
import { InitController } from 'src/controller/admin/init/init.controller';

/**
 * `checkHasInited()` 挂在 InitMiddleware 上 —— **每一个** API 请求都要跑一次。
 * 以前每次都 `userModel.findOne({})`：一次数据库往返，还把整份用户文档（含密码哈希）
 * 读进内存再丢掉。这里钉住"缓存生效、只投影 _id、初始化流程语义不变"。
 */

function createUserModel(docs: any[] = []) {
  const calls: Array<{ filter: any; projection: any }> = [];
  const model: any = {
    findOne: jest.fn((filter: any, projection: any) => ({
      lean: () => ({
        exec: async () => {
          calls.push({ filter, projection });
          const found = docs.length ? { ...docs[0] } : null;
          if (!found) return null;
          // 模拟投影：只把请求到的字段给出去
          if (!projection) return found;
          const out: any = {};
          for (const key of Object.keys(projection)) {
            if (key in found) out[key] = found[key];
          }
          return out;
        },
      }),
    })),
    create: jest.fn(async (doc: any) => {
      docs.push(doc);
      return doc;
    }),
  };
  return { model, calls, docs };
}

function createProvider(docs: any[] = []) {
  const { model, calls } = createUserModel(docs);
  const provider = Object.create(InitProvider.prototype) as InitProvider;
  (provider as any).userModel = model;
  return { provider, calls, model };
}

describe('InitProvider.checkHasInited：每个请求都要跑的那一次查询', () => {
  it('第一次查库，之后走缓存（TTL 内不再查）', async () => {
    const { provider, calls } = createProvider([{ _id: 'x', password: 'scrypt:...' }]);
    expect(await provider.checkHasInited()).toBe(true);
    expect(await provider.checkHasInited()).toBe(true);
    expect(await provider.checkHasInited()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('只投影 _id：密码哈希不再被读进内存', async () => {
    const { provider, calls } = createProvider([{ _id: 'x', password: 'scrypt:secret-hash' }]);
    await provider.checkHasInited();
    expect(calls[0].filter).toEqual({});
    expect(calls[0].projection).toEqual({ _id: 1 });
    expect(calls[0].projection.password).toBeUndefined();
  });

  it('没有用户时返回 false，而且 false 不进缓存（多实例下别的进程刚初始化完要能立刻看到）', async () => {
    const { provider, calls, model } = createProvider([]);
    expect(await provider.checkHasInited()).toBe(false);
    expect(await provider.checkHasInited()).toBe(false);
    expect(calls).toHaveLength(2);
    expect(model.findOne).toHaveBeenCalledTimes(2);
    // 模拟"刚刚初始化完成"：init() 会直接把缓存置成 true
    (provider as any).hasInitedCache = { value: true, at: Date.now() };
    expect(await provider.checkHasInited()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('invalidateInitCache() 之后会重新查库（手工动过 users 集合时的自愈路径）', async () => {
    const { provider, calls } = createProvider([{ _id: 'x' }]);
    await provider.checkHasInited();
    provider.invalidateInitCache();
    await provider.checkHasInited();
    expect(calls).toHaveLength(2);
  });

  it('缓存有 TTL：过期之后重新查库（VANBLOG_INIT_CACHE_MS）', async () => {
    process.env.VANBLOG_INIT_CACHE_MS = '60';
    let mod: typeof import('./init.provider') | undefined;
    jest.isolateModules(() => {
      mod = require('./init.provider');
    });
    expect(mod!.INIT_CACHE_MS).toBe(60);
    const { model, calls } = createUserModel([{ _id: 'x' }]);
    const provider = Object.create(mod!.InitProvider.prototype) as InitProvider;
    (provider as any).userModel = model;
    expect(await provider.checkHasInited()).toBe(true);
    expect(await provider.checkHasInited()).toBe(true);
    expect(calls).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 90));
    expect(await provider.checkHasInited()).toBe(true);
    expect(calls).toHaveLength(2);
    delete process.env.VANBLOG_INIT_CACHE_MS;
  });

  it('非法的 TTL 回落到默认 5 分钟（不能把 NaN 交给比较运算）', () => {
    process.env.VANBLOG_INIT_CACHE_MS = 'abc';
    let mod: typeof import('./init.provider') | undefined;
    jest.isolateModules(() => {
      mod = require('./init.provider');
    });
    expect(mod!.INIT_CACHE_MS).toBe(300000);
    delete process.env.VANBLOG_INIT_CACHE_MS;
  });
});

describe('init() 之后 /api/admin/init 必须继续拒绝', () => {
  const stubDeps = () => ({
    metaModel: { create: jest.fn(async () => ({})) } as any,
    userModel: { create: jest.fn(async () => ({})) } as any,
    categoryModal: {} as any,
    customPageModal: {} as any,
    walineProvider: { init: jest.fn() } as any,
    settingProvider: {
      updateCommentSetting: jest.fn(async () => undefined),
      updateMenuSetting: jest.fn(async () => undefined),
    } as any,
    cacheProvider: { set: jest.fn(async () => undefined) } as any,
    websiteProvider: { restart: jest.fn() } as any,
  });

  it('init() 会把缓存置成 true，之后 checkHasInited() 不再查库也返回 true', async () => {
    const deps = stubDeps();
    const provider = new InitProvider(
      deps.metaModel,
      deps.userModel,
      deps.categoryModal,
      deps.customPageModal,
      deps.walineProvider,
      deps.settingProvider,
      deps.cacheProvider,
      deps.websiteProvider,
    );
    // 初始化前：库里没有用户
    (deps.userModel as any).findOne = jest.fn(() => ({
      lean: () => ({ exec: async () => null }),
    }));
    expect(await provider.checkHasInited()).toBe(false);

    await provider.init({
      user: { username: 'admin', password: 'a-strong-password' } as any,
      siteInfo: { siteName: 'test', baseUrl: 'http://127.0.0.1:3001' } as any,
    } as any);

    // init() 已经把缓存写成 true：这里不再依赖 findOne
    (deps.userModel as any).findOne = jest.fn(() => {
      throw new Error('不该再查库');
    });
    expect(await provider.checkHasInited()).toBe(true);
  });

  it('已初始化时 POST /api/admin/init 抛 500「已初始化」', async () => {
    const initProvider = {
      checkHasInited: jest.fn(async () => true),
      init: jest.fn(),
    } as any;
    const controller = new InitController(initProvider, {} as any, { activeAll: jest.fn() } as any);
    await expect(controller.initSystem({} as any)).rejects.toBeInstanceOf(HttpException);
    await expect(controller.initSystem({} as any)).rejects.toThrow('已初始化');
    expect(initProvider.init).not.toHaveBeenCalled();
  });

  it('未初始化时 POST /api/admin/init 正常执行', async () => {
    const initProvider = {
      checkHasInited: jest.fn(async () => false),
      init: jest.fn(async () => 'ok'),
    } as any;
    const controller = new InitController(initProvider, {} as any, { activeAll: jest.fn() } as any);
    const res = await controller.initSystem({} as any);
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });
    expect(initProvider.init).toHaveBeenCalledTimes(1);
  });

  it('已初始化时 /api/admin/init/upload 也拒绝（不能借上传接口写文件）', async () => {
    const initProvider = { checkHasInited: jest.fn(async () => true) } as any;
    const controller = new InitController(initProvider, { upload: jest.fn() } as any, {} as any);
    await expect(controller.uploadImg({} as any, 'false')).rejects.toThrow('已初始化');
  });
});
