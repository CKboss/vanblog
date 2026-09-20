/**
 * 公开文章列表的**放大闸门**与公开只读接口的**缓存头**守卫。
 *
 * 这两条都是"极端网络环境下能不能扛住"的问题，而不是功能问题：
 * - 列表默认（`toListView` 缺省）返回**每篇完整正文**，`pageSize` 上限 100 ⇒ 一个约 60 字节的
 *   匿名请求能换回约等于整库正文的响应。带宽是攻击下最先耗尽、最难恢复的资源，而按 IP 限流
 *   对僵尸网络无效 ⇒ 必须在应用层压单次放大倍数。
 * - 公开只读响应加 `s-maxage` + `stale-while-revalidate`，站长挂任意 CDN 就能把这类流量吸收在
 *   边缘 —— 这是唯一能横向扩展的防线。
 *
 * ⚠️ 断言全部是**行为级**：真的调用处理器，从假的 `articleProvider.getByOption` 里把
 * **实际生效的分页参数**抓出来看，而不是 grep 源码里有没有那个常量。
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { FULL_CONTENT_MAX_PAGE_SIZE, PublicController } from './public.controller';
import { invalidatePublicMetaCache } from 'src/utils/publicMetaCache';
import { MAX_PAGE_SIZE } from 'src/utils/pagination';

/** 造一个只有必要方法的假 provider 集合，并捕获传给 `getByOption` 的实参。 */
function createHarness() {
  invalidatePublicMetaCache();
  const captured: any[] = [];
  const articleProvider = {
    getByOption: jest.fn().mockImplementation(async (option: any) => {
      captured.push(option);
      return { articles: [], total: 0 };
    }),
    getTotalNum: jest.fn().mockResolvedValue(0),
  };
  const categoryProvider = {
    getAllCategories: jest.fn().mockResolvedValue([]),
    getPublicCategoryNames: jest.fn().mockResolvedValue([]),
    getCategoriesWithArticle: jest.fn().mockResolvedValue({}),
  };
  const tagProvider = { getAllTags: jest.fn().mockResolvedValue([]) };
  const metaProvider = {
    getAll: jest.fn().mockResolvedValue({ siteInfo: {}, _doc: { siteInfo: {} } }),
    getArticlesPerPage: jest.fn().mockResolvedValue(10),
    getTotalWords: jest.fn().mockResolvedValue(0),
  };
  const visitProvider = { getLatestVisits: jest.fn().mockResolvedValue([]) };
  const settingProvider = {
    getMenuSetting: jest.fn().mockResolvedValue({ data: [] }),
    getLayoutSetting: jest.fn().mockResolvedValue(null),
    encodeLayoutSetting: jest.fn().mockReturnValue(null),
  };
  const customPageProvider = { getPublicCustomPages: jest.fn().mockResolvedValue([]) };

  const controller = new PublicController(
    articleProvider as any,
    categoryProvider as any,
    tagProvider as any,
    metaProvider as any,
    visitProvider as any,
    settingProvider as any,
    customPageProvider as any,
  );
  return { controller, captured };
}

/** 匿名访客形状的 req：非回环套接字、无内部令牌头。 */
const anonymousReq = () =>
  ({ socket: { remoteAddress: '203.0.113.7' }, headers: { host: 'blog.example' } } as any);

/** 内部调用形状：回环直连且**无**转发头（`isLoopbackRequest` 的判据）。 */
const internalReq = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any);

describe('公开文章列表的放大闸门', () => {
  it('🔴 匿名 + 默认（含全文）+ pageSize=100 ⇒ 被夹到 FULL_CONTENT_MAX_PAGE_SIZE', async () => {
    const { controller, captured } = createHarness();
    await controller.getByOption(anonymousReq(), 1, 100 as any, undefined as any, false as any, false as any, false as any, undefined, undefined, undefined, undefined);

    expect(captured).toHaveLength(1);
    expect(captured[0].pageSize).toBe(FULL_CONTENT_MAX_PAGE_SIZE);
    // 闸门必须真的比默认上限小，否则这条断言只是把现状钉住而已。
    expect(FULL_CONTENT_MAX_PAGE_SIZE).toBeLessThan(MAX_PAGE_SIZE);
  });

  it('前台列表（toListView=true）不受影响，仍走 MAX_PAGE_SIZE', async () => {
    const { controller, captured } = createHarness();
    await controller.getByOption(anonymousReq(), 1, 100 as any, 'true' as any, false as any, false as any, false as any, undefined, undefined, undefined, undefined);

    expect(captured[0].pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('⚠️ `?toListView=false`（字符串）按 provider 的真值口径算**列表视图**，所以不夹', async () => {
    // `article.provider.ts` 是 `if (option.toListView)` 的真值判断，字符串 "false" 为真 ⇒
    // 那种请求实际只返回列表（不含全文）。闸门必须与它同口径，否则会去夹不该夹的请求。
    const { controller, captured } = createHarness();
    await controller.getByOption(anonymousReq(), 1, 100 as any, 'false' as any, false as any, false as any, false as any, undefined, undefined, undefined, undefined);

    expect(captured[0].pageSize).toBe(MAX_PAGE_SIZE);
    expect(captured[0].toListView).toBe('false');
  });

  it('本站内部调用（回环直连）完全不受闸门影响，pageSize=-1 仍然表示"全部"', async () => {
    const { controller, captured } = createHarness();
    await controller.getByOption(internalReq(), 1, -1 as any, undefined as any, false as any, false as any, false as any, undefined, undefined, undefined, undefined);

    expect(captured[0].pageSize).toBe(-1);
  });

  it('匿名 + 小 pageSize 时照常放行（闸门只压放大倍数，不影响正常翻页）', async () => {
    const { controller, captured } = createHarness();
    await controller.getByOption(anonymousReq(), 2, 5 as any, undefined as any, false as any, false as any, false as any, undefined, undefined, undefined, undefined);

    expect(captured[0].pageSize).toBe(5);
    expect(captured[0].page).toBe(2);
  });

  it('负向对照：把闸门拿掉（maxPageSize 恒为 undefined）时，上面第一条必须红', async () => {
    // 直接复算"没有闸门"的分页结果，证明第一条断言量的是闸门而不是别的东西。
    const { sanitizePagination } = require('src/utils/pagination');
    const withoutGate = sanitizePagination(1, 100, { allowUnlimited: false, defaultPageSize: 10 });
    expect(withoutGate.pageSize).toBe(MAX_PAGE_SIZE);
    expect(withoutGate.pageSize).not.toBe(FULL_CONTENT_MAX_PAGE_SIZE);
  });
});

describe('公开 meta 的 siteInfo 必须走白名单投影（控制器侧锚点）', () => {
  // ⚠️ 这条锚点是"投影修复"唯一的剩余缺口：`projectPublicSiteInfo` 的 16 条守卫都打在
  //    **纯函数**上（那是 meta.provider 的所有者能碰的范围）。如果哪天有人把控制器换回
  //    `{ ...metaDoc.siteInfo }`，那些守卫**全都还是绿的**（函数仍然存在、仍然正确，只是没人用了），
  //    而"新增字段默认公开"的洞会静默回来 —— 它已经真实泄露过一次管理员用户名的路径。
  const SRC = stripCommentsForAnchor(
    readFileSync(resolve(__dirname, './public.controller.ts'), 'utf-8'),
  );

  it('剥注释器真的剥了（防空转）', () => {
    const raw = readFileSync(resolve(__dirname, './public.controller.ts'), 'utf-8');
    // 注释里必然写着被禁的旧形状（解释为什么不能全量展开），剥掉之后必须消失。
    expect(raw).toMatch(/metaDoc\.siteInfo/);
    expect(SRC).not.toMatch(/metaDoc\.siteInfo/);
  });

  it('siteInfo 来自 projectPublicSiteInfo 的调用（断言调用形状，不是"符号出现过"）', () => {
    // ⚠️ 只断言"文件里出现了 projectPublicSiteInfo"是空断言：import 行就能让它通过。
    //    这里钉的是**调用形状**：展开运算符里包着这个函数的调用。
    expect(SRC).toMatch(/\{\s*\.\.\.projectPublicSiteInfo\(\s*metaDoc\?\.siteInfo\s*\)\s*\}/);
  });

  it('不再有"把整个 siteInfo 铺开"的形状', () => {
    expect(SRC).not.toMatch(/\.\.\.\(\s*metaDoc\?\.siteInfo/);
    expect(SRC).not.toMatch(/\.\.\.siteInfo\b/);
  });

  it('负向对照：旧形状必须能被上面两条抓到', () => {
    const oldShape = 'const siteInfo = { ...(metaDoc?.siteInfo || {}) };';
    const newShape = 'const siteInfo = { ...projectPublicSiteInfo(metaDoc?.siteInfo) };';
    const callsProjection = (src: string) =>
      /\{\s*\.\.\.projectPublicSiteInfo\(/.test(src);
    const spreadsWhole = (src: string) => /\.\.\.\(\s*metaDoc\?\.siteInfo/.test(src);

    expect(callsProjection(newShape)).toBe(true);
    expect(spreadsWhole(newShape)).toBe(false);
    // ← 旧形状必须判为"没走投影"且"全量铺开"，否则上面的断言就是装饰。
    expect(callsProjection(oldShape)).toBe(false);
    expect(spreadsWhole(oldShape)).toBe(true);
  });
});

describe('公开只读接口的缓存头', () => {
  const HEADER_METADATA = '__headers__';

  function headerOf(method: string): string | undefined {
    const meta = Reflect.getMetadata(HEADER_METADATA, (PublicController.prototype as any)[method]);
    const list: any[] = Array.isArray(meta) ? meta : [];
    const hit = list.find((h) => String(h?.name).toLowerCase() === 'cache-control');
    return hit ? String(hit.value) : undefined;
  }

  it('反证：这个元数据键确实是 Nest 用来下发响应头的（否则整组断言都是空转）', () => {
    // 用一个临时的 @Header 装饰器验证键名：如果 Nest 换了键名，这里会先失败，
    // 而不是让下面的断言静默变成"永远 undefined"。
    const { Header } = require('@nestjs/common');
    class Probe {
      @Header('X-Probe', 'v')
      handler() {
        return null;
      }
    }
    const meta = Reflect.getMetadata(HEADER_METADATA, Probe.prototype.handler);
    expect(Array.isArray(meta)).toBe(true);
    expect(meta.some((h: any) => h.name === 'X-Probe' && h.value === 'v')).toBe(true);
  });

  it('meta 与文章列表都带 public + s-maxage + stale-while-revalidate', () => {
    for (const method of ['getBuildMeta', 'getByOption']) {
      const value = headerOf(method);
      expect({ method, value }).toEqual({
        method,
        value: 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400',
      });
    }
  });

  it('🔴 带缓存头的方法**恰好 2 个**：多一个就说明有人给敏感接口开了共享缓存', () => {
    // 文章详情/解锁、评论、以及任何 /api/admin/* 都绝不能被 CDN 存住
    // （含访问密码保护的内容一旦进了共享缓存就是越权泄露）。
    const decorated = Object.getOwnPropertyNames(PublicController.prototype).filter(
      (name) => name !== 'constructor' && headerOf(name) !== undefined,
    );
    expect(decorated.sort()).toEqual(['getBuildMeta', 'getByOption']);
  });
});
