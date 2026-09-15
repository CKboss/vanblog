/**
 * `initJwt` 在启动时会被调用两次（main.ts 一次、app.module 的 JwtModule 工厂一次）。
 * 以前两次各建一个 MongoClient 且都不 close：漏一个连接池 + 一套 SDAM 心跳定时器。
 * 这里把"只连一次、并且一定关掉"钉住。
 */

const connectMock = jest.fn();
const closeMock = jest.fn();
const findOneMock = jest.fn();
const findOneAndUpdateMock = jest.fn();

/** 假 settings 集合：findOneAndUpdate 带 upsert + $setOnInsert 的语义 */
let settingsDocs: any[] = [];

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: connectMock,
    close: closeMock,
    db: () => ({
      collection: () => ({
        findOne: findOneMock,
        findOneAndUpdate: findOneAndUpdateMock,
      }),
    }),
  })),
}));

jest.mock('src/config', () => ({
  loadMongoUrl: jest.fn(async () => 'mongodb://127.0.0.1:27017/vanBlog'),
}));

const loadInitJwt = () => {
  let mod: typeof import('./initJwt') | undefined;
  jest.isolateModules(() => {
    mod = require('./initJwt');
  });
  return mod!;
};

describe('initJwt', () => {
  /** driver 5.x 的 findOneAndUpdate 回 `{value: doc}`，6.x 直接回 doc —— 两种都要认 */
  const wrap = (doc: any) => (useLegacyShape ? { value: doc } : doc);
  let useLegacyShape = true;

  const seedExisting = (secret = 'existing-secret') => {
    settingsDocs = [{ type: 'jwt', value: { secret } }];
    findOneAndUpdateMock.mockImplementation(async () => wrap(settingsDocs[0]));
    findOneMock.mockImplementation(async () => settingsDocs[0] || null);
  };

  const emptyCollection = () => {
    settingsDocs = [];
    findOneAndUpdateMock.mockImplementation(async (filter: any, update: any) => {
      let doc = settingsDocs.find((d) => d.type === filter.type);
      if (!doc && update?.$setOnInsert) {
        doc = { ...update.$setOnInsert };
        settingsDocs.push(doc);
      }
      return wrap(doc || null);
    });
    findOneMock.mockImplementation(async () => settingsDocs[0] || null);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useLegacyShape = true;
    connectMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
    settingsDocs = [];
  });

  it('两次调用只连一次库，且连接被关掉', async () => {
    seedExisting();
    const { initJwt } = loadInitJwt();

    const first = await initJwt();
    const second = await initJwt();

    expect(first).toBe('existing-secret');
    expect(second).toBe('existing-secret');
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('并发调用（两处 await 同时发出）也只连一次', async () => {
    seedExisting('s');
    const { initJwt } = loadInitJwt();
    const [a, b] = await Promise.all([initJwt(), initJwt()]);
    expect(a).toBe(b);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('库里没有 jwt 设置时用一次原子 upsert 生成（不是先查再插），连接照样关掉', async () => {
    emptyCollection();
    const { initJwt } = loadInitJwt();
    const secret = await initJwt();
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(10);
    expect(findOneAndUpdateMock).toHaveBeenCalledTimes(1);
    const [filter, update, options] = findOneAndUpdateMock.mock.calls[0];
    expect(filter).toEqual({ type: 'jwt' });
    // 关键：只有 $setOnInsert，没有 $set —— 已经存在时一个字都不改
    expect(Object.keys(update)).toEqual(['$setOnInsert']);
    expect(update.$setOnInsert.value.secret).toBe(secret);
    expect(options).toMatchObject({ upsert: true, returnDocument: 'after' });
    expect(settingsDocs).toHaveLength(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('driver 直接返回文档（不是 {value}）也认', async () => {
    useLegacyShape = false;
    emptyCollection();
    const { initJwt } = loadInitJwt();
    const secret = await initJwt();
    expect(secret).toBe(settingsDocs[0].value.secret);
  });

  it('两个进程同时首次启动：撞唯一索引（E11000）时读回对方的 secret，不会各用一个', async () => {
    const otherSecret = 'secret-from-the-other-process';
    settingsDocs = [];
    findOneAndUpdateMock.mockImplementationOnce(async () => {
      const err: any = new Error('E11000 duplicate key error collection: vanBlog.settings');
      err.code = 11000;
      throw err;
    });
    // 撞车之后再读，读到的就是对方插进去的那一行
    findOneMock.mockImplementation(async () => ({ type: 'jwt', value: { secret: otherSecret } }));
    const { initJwt } = loadInitJwt();
    await expect(initJwt()).resolves.toBe(otherSecret);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('查询失败时也要关连接，并且下一次调用还能重试（不钉死在同一个 rejected promise 上）', async () => {
    findOneAndUpdateMock.mockRejectedValueOnce(new Error('boom'));
    const { initJwt } = loadInitJwt();
    await expect(initJwt()).rejects.toThrow('boom');
    expect(closeMock).toHaveBeenCalledTimes(1);

    seedExisting('retry-ok');
    await expect(initJwt()).resolves.toBe('retry-ok');
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it('close 自己失败不会把成功结果变成异常', async () => {
    seedExisting('ok');
    closeMock.mockRejectedValue(new Error('close failed'));
    const { initJwt } = loadInitJwt();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(initJwt()).resolves.toBe('ok');
    log.mockRestore();
  });
});
