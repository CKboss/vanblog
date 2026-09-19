import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 版本检查**默认必须关闭**，且关闭时**一个字节都不能发出去**。
 *
 * 为什么这是一条安全属性而不是偏好：旧默认值是上游作者的
 * `https://api.mereith.com/vanblog/version`，而 `getCachedVersionFromServer()` 还被放在
 * `controller/admin/meta/meta.controller.ts` 的**构造函数**里（DI 阶段就触发）⇒ **每次启动都会
 * 回连一个与本部署无关的第三方**，带出去的是本站的出口 IP 和"这里有人在运营一个 VanBlog"这个事实。
 * 在敌意网络里，这两条信息可以被用来关联与定位运营者。而且它对本 fork 毫无用处：上游返回的是
 * `0.54.0` 这类号，本项目是 `v2026.9.2@23f2e9c` 形状，比较结果只会产生"有新版本"的假警报。
 *
 * ⚠️ 断言"不发请求"必须用 **mock 计数**（行为级），不能只断言常量为空 —— 常量非空但没人用、
 *    或有人绕过常量直接 axios，源码级断言都看不出来。
 */

/** 每个用例都要在**设置好 env 之后**重新加载模块：常量是在 import 时求值的。 */
function loadModule(envValue: string | undefined) {
  jest.resetModules();
  if (envValue === undefined) delete process.env.VAN_BLOG_VERSION_API;
  else process.env.VAN_BLOG_VERSION_API = envValue;
  const axiosMod = require('axios');
  const get = jest.spyOn(axiosMod.default ?? axiosMod, 'get');
  get.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./getVersion');
  return { mod, get };
}

describe('版本检查的上游地址', () => {
  afterEach(() => {
    delete process.env.VAN_BLOG_VERSION_API;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('默认（未设置）就是关闭，且 URL 为空串', () => {
    const { mod } = loadModule(undefined);
    expect(mod.VERSION_API_ENABLED).toBe(false);
    expect(mod.VERSION_API_URL).toBe('');
  });

  it('关闭时 fetch 与 getCached 都返回 null，并且**完全没有调用 axios**', async () => {
    const { mod, get } = loadModule(undefined);
    await expect(mod.fetchVersionFromServer()).resolves.toBeNull();
    expect(mod.getCachedVersionFromServer()).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'off', 'OFF', 'false', 'False', 'none', 'disabled', '0'])(
    '这些值都当"关闭"处理（%j），不会拿去做 DNS 解析',
    async (value) => {
      const { mod, get } = loadModule(value);
      expect(mod.VERSION_API_ENABLED).toBe(false);
      expect(mod.VERSION_API_URL).toBe('');
      await expect(mod.fetchVersionFromServer()).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('显式配置一个地址时才启用，并且用的就是那个地址', async () => {
    const { mod, get } = loadModule('https://example.invalid/vanblog/version');
    expect(mod.VERSION_API_ENABLED).toBe(true);
    expect(mod.VERSION_API_URL).toBe('https://example.invalid/vanblog/version');
    get.mockRejectedValueOnce(new Error('network down'));
    await expect(mod.fetchVersionFromServer()).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('https://example.invalid/vanblog/version');
  });

  it('首尾空白会被 trim（避免把 " https://x " 当成非法值或直接拼进请求）', () => {
    const { mod } = loadModule('  https://example.invalid/v  ');
    expect(mod.VERSION_API_URL).toBe('https://example.invalid/v');
  });
});

describe('默认值本身（源码级，剥注释后断言）', () => {
  const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, 'getVersion.ts'), 'utf-8'));

  it('默认值不再是上游作者的域名', () => {
    // ⚠️ 必须在剥注释后断言：解释"为什么改掉"的注释里必然写着那个域名，
    //    不剥注释就会永远红（本仓库已踩 8 次这个坑）。
    expect(SRC).not.toContain('api.mereith.com');
    // 空转反证：同一把尺子在**未剥注释**的原文上必须能命中，否则说明尺子本身失效。
    expect(readFileSync(resolve(__dirname, 'getVersion.ts'), 'utf-8')).toContain('api.mereith.com');
  });

  it('关闭判定用一个显式的 token 集合，而不是"只要非空就启用"', () => {
    expect(SRC).toMatch(/DISABLED_TOKENS\s*=\s*new Set\(/);
    expect(SRC).toMatch(/VERSION_API_ENABLED\s*=\s*!DISABLED_TOKENS\.has\(/);
  });

  it('两个取数入口都在 axios 之前短路（不是一个改了另一个漏了）', () => {
    const guards = SRC.match(/if \(!VERSION_API_URL\) \{\s*return null;/g) ?? [];
    expect(guards.length).toBe(2);
  });
});
