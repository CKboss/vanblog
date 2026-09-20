// ⚠️ 这一段必须留在**所有 import 之前**：`utils/getVersion.ts` 的 `VERSION_API_ENABLED` 是
//    **模块加载时**从 env 求值的常量（默认空 = 关闭，且关闭时"一个字节都不发"）。
//    如果不在 import 前设好，`refreshVersionCache()` 会直接短路 ⇒ 缓存永远是空的 ⇒
//    `latestVersion` 回落成当前版本（'dev'），下面那条"后台刷新后给出更新提示"的用例就会红。
//    ⚠️ 这条 spec 过去之所以是绿的，纯粹因为跑它的那个 shell 恰好设了 `VAN_BLOG_VERSION_API`
//    —— 那是**环境依赖的假绿**（换一台机器、换一个 CI 环境就红）。现在把前提写进文件本身。
process.env.VAN_BLOG_VERSION_API = 'https://example.invalid/api';

import axios from 'axios';
import { MetaController } from './meta.controller';
import { refreshVersionCache, resetVersionCache } from 'src/utils/getVersion';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createController() {
  const metaProvider = {
    getAll: jest.fn().mockResolvedValue({
      siteInfo: { baseUrl: 'https://blog.example.com', enableComment: 'true' },
    }),
  };
  return {
    controller: new MetaController(metaProvider as any),
    metaProvider,
  };
}

describe('MetaController.getAllMeta', () => {
  beforeEach(() => {
    resetVersionCache();
    mockedAxios.get.mockReset();
  });

  it('returns immediately when the remote version API never responds (#343)', async () => {
    mockedAxios.get.mockImplementation(() => new Promise(() => undefined));
    const { controller } = createController();

    const started = Date.now();
    const result = await controller.getAllMeta({ user: { name: 'admin' } } as any);
    expect(Date.now() - started).toBeLessThan(200);
    expect(result.statusCode).toBe(200);
    expect(result.data.latestVersion).toBe(result.data.version);
    expect(result.data.baseUrl).toBe('https://blog.example.com');
  });

  it('surfaces the cached update hint after a background refresh', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { data: { version: '0.99.0', updatedAt: '2024-01-01T00:00:00.000Z' } },
    });
    const { controller } = createController();
    await refreshVersionCache();

    const result = await controller.getAllMeta({ user: { name: 'admin' } } as any);
    expect(result.data.latestVersion).toBe('0.99.0');
    expect(result.data.updatedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('old await-on-request-path would stall for the remote delay', async () => {
    let resolveRemote!: (value: unknown) => void;
    const remote = new Promise((resolve) => {
      resolveRemote = resolve;
    });
    mockedAxios.get.mockImplementation(() => remote as Promise<any>);

    let oldPathSettled = false;
    const oldPath = axios.get('https://api.mereith.com/vanblog/version').then(() => {
      oldPathSettled = true;
    });

    await Promise.resolve();
    expect(oldPathSettled).toBe(false);

    resolveRemote({ data: { data: { version: '0.99.0' } } });
    await oldPath;
    expect(oldPathSettled).toBe(true);
  });
});
