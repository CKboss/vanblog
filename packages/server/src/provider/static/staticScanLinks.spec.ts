/**
 * 「扫描文章图片」（`POST /api/admin/img/scan`）的**资源边界**钉子。
 *
 * 修之前的形状：串行地对每个链接 `await getImgInfoByLink(link)`，而它会**真去下载**那张图
 * （单张上限 50 MB、超时 15 s，失败还会用 `encodeURI` 再试一次 ⇒ 一个死链最多 30 s），
 * 并且**没有任何上限**；循环里还有一句 `console.log(link, dto)`，每个链接打一行。
 * 于是"一篇塞了几千个外链的文章"就能让一个请求跑上几小时、把 stdout 刷爆。
 *
 * ⚠️ 可达性（已核实，决定严重度）：`post-/api/admin/img/scan` 既不在 `publicRoutes`
 * 也不在 `pathPermissionMap`，而 `/api/admin/img` 不在 `SUPER_ADMIN_ONLY_ROUTE_PREFIXES`
 * ⇒ `access.guard.ts` 的 `permissions.includes('all')` 分支会放行，**勾了「所有权限」的
 * 协作者可以调**。所以它必须按"低权限账号也能触发的重活"设防。
 *
 * 这一组钉住：①并发有上界；②不重不漏；③链接撞上限时如实报告（`truncatedLinks` + WARN）；
 * ④单个链接抛错不拖垮整轮；⑤返回形状向后兼容（`total` / `errorLinks` / `artcileId` 拼写）；
 * ⑥每链接一条的 `console.log` 不许回来。
 */
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/** 造一个只暴露本路径所需成员的 StaticProvider 实例（不走 Nest 构造，避免拉一堆依赖）。 */
async function buildProvider(opts: {
  links: Array<{ articleId: number; title: string; link: string }>;
  failLinks?: string[];
  concurrency?: number;
}) {
  const mod = await import('./static.provider');
  const provider = Object.create(mod.StaticProvider.prototype);

  let inFlight = 0;
  let maxInFlight = 0;
  const fetched: string[] = [];
  const created: any[] = [];
  const warns: string[] = [];
  const logs: string[] = [];

  (provider as any).logger = {
    log: (m: string) => logs.push(String(m)),
    warn: (m: string) => warns.push(String(m)),
    error: (m: string) => warns.push(String(m)),
  };
  // 文章侧：直接给出摊平前的形状（真正的分批由 articleImageLinksScan.spec.ts 钉）
  (provider as any).articleProvder = {
    scanAllImageLinks: async () => {
      const byArticle = new Map<number, { title: string; links: string[] }>();
      for (const t of opts.links) {
        const e = byArticle.get(t.articleId) ?? { title: t.title, links: [] };
        e.links.push(t.link);
        byArticle.set(t.articleId, e);
      }
      return {
        items: Array.from(byArticle.entries(), ([articleId, v]) => ({
          articleId,
          title: v.title,
          links: v.links,
        })),
        scannedArticles: byArticle.size,
        scannedLinks: opts.links.length,
        contentBytes: 0,
        truncated: false,
        articleCap: 5000,
      };
    },
  };
  // 每个链接的"下载"：可观测并发度，并可按名单抛错
  (provider as any).getImgInfoByLink = async (link: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    fetched.push(link);
    try {
      await new Promise((r) => setTimeout(r, 5));
      if (opts.failLinks?.includes(link)) {
        throw new Error('下载失败（模拟）');
      }
      if (link.includes('dead')) return null;
      return { sign: `sign-${link}`, realPath: link, name: link.split('/').pop() };
    } finally {
      inFlight -= 1;
    }
  };
  (provider as any).getOneBySign = async () => null; // 一律"库里还没有"⇒ 都会走 createInDB
  (provider as any).createInDB = async (dto: any) => {
    created.push(dto);
  };

  return { provider, warns, logs, fetched, created, getMaxInFlight: () => maxInFlight };
}

function makeLinks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    articleId: (i % 3) + 1,
    title: `文章 ${(i % 3) + 1}`,
    link: `https://cdn.example.com/img-${i}.png`,
  }));
}

describe('scanLinksOfArticles：有界并发、诚实截断与错误隔离', () => {
  // ⚠️ 预热：static.provider 会拉进 sharp / safeFetch 等重依赖，**首次 import 约 4 秒**，
  //    会把第一个用例顶到 jest 默认 5 s 超时上（现象是"失败但没有断言消息"）。
  //    放到 beforeAll 里加载，单个用例就只剩真实工作量。
  beforeAll(async () => {
    await import('./static.provider');
  }, 60000);

  it('20 个链接全部处理，且不重不漏', async () => {
    const links = makeLinks(20);
    const { provider, fetched, created } = await buildProvider({ links });

    const res = await provider.scanLinksOfArticles();

    expect(res.total).toBe(20);
    expect(res.processed).toBe(20);
    expect(fetched).toHaveLength(20);
    expect(new Set(fetched).size).toBe(20); // 不重
    expect(created).toHaveLength(20); // 每个都补进了图床
    expect(res.truncatedLinks).toBe(false);
  }, 30000);

  it('并发有上界：在飞数量从不超过 VANBLOG_IMG_SCAN_CONCURRENCY', async () => {
    jest.resetModules();
    process.env.VANBLOG_IMG_SCAN_CONCURRENCY = '3';
    try {
      const { provider, getMaxInFlight } = await buildProvider({ links: makeLinks(30) });
      const res = await provider.scanLinksOfArticles();
      expect(res.processed).toBe(30);
      expect(getMaxInFlight()).toBeLessThanOrEqual(3);
      // ⚠️ 也必须**真的并发了**（否则等于没改，还是串行）：串行时最大在飞数是 1
      expect(getMaxInFlight()).toBeGreaterThan(1);
    } finally {
      delete process.env.VANBLOG_IMG_SCAN_CONCURRENCY;
      jest.resetModules();
    }
  });

  it('空转反证：把并发设成 1 时，同一把尺子量出的最大在飞数必须是 1（串行）', async () => {
    jest.resetModules();
    process.env.VANBLOG_IMG_SCAN_CONCURRENCY = '1';
    try {
      const { provider, getMaxInFlight } = await buildProvider({ links: makeLinks(12) });
      await provider.scanLinksOfArticles();
      expect(getMaxInFlight()).toBe(1);
    } finally {
      delete process.env.VANBLOG_IMG_SCAN_CONCURRENCY;
      jest.resetModules();
    }
  });

  it('链接数撞上限 ⇒ truncatedLinks=true、只处理上限那么多、并且打 WARN', async () => {
    jest.resetModules();
    process.env.VANBLOG_IMG_SCAN_MAX_LINKS = '5';
    try {
      const { provider, warns, fetched } = await buildProvider({ links: makeLinks(12) });
      const res = await provider.scanLinksOfArticles();

      expect(res.total).toBe(12); // total 仍是"发现总数"，语义不变
      expect(res.processed).toBe(5);
      expect(fetched).toHaveLength(5);
      expect(res.truncatedLinks).toBe(true);
      expect(res.linkCap).toBe(5);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('未处理完全部链接');
      expect(warns[0]).toContain('不完整');
    } finally {
      delete process.env.VANBLOG_IMG_SCAN_MAX_LINKS;
      jest.resetModules();
    }
  });

  it('抓不到的链接（返回 null）进 errorLinks，且**保留既有的 artcileId 拼写**', async () => {
    const links = [
      ...makeLinks(2),
      { articleId: 9, title: '有死链的文章', link: 'https://cdn.example.com/dead-1.png' },
    ];
    const { provider } = await buildProvider({ links });

    const res = await provider.scanLinksOfArticles();

    expect(res.total).toBe(3);
    expect(res.errorLinks).toHaveLength(1);
    expect(Object.keys(res.errorLinks[0]).sort()).toEqual(['artcileId', 'link', 'title']);
    expect(res.errorLinks[0].artcileId).toBe(9);
    expect(res.created).toBe(2); // 3 个链接里 1 个是死链 ⇒ 另外 2 个补进了图床
    expect(res.errorLinks[0].link).toContain('dead-1.png');
  });

  it('单个链接抛错不会让整轮失败：记成失效链接并继续', async () => {
    const links = makeLinks(6);
    const { provider, warns, created } = await buildProvider({
      links,
      failLinks: [links[2].link],
    });

    const res = await provider.scanLinksOfArticles();

    expect(res.processed).toBe(6); // 全都处理过了
    expect(res.errorLinks).toHaveLength(1);
    expect(res.errorLinks[0].link).toBe(links[2].link);
    expect(created).toHaveLength(5); // 其余 5 个照常入库
    expect(warns.some((w) => w.includes('处理链接失败'))).toBe(true);
  });

  it('空站（没有任何链接）⇒ 全 0，不抛异常、不起 worker', async () => {
    const { provider } = await buildProvider({ links: [] });
    const res = await provider.scanLinksOfArticles();
    expect(res.total).toBe(0);
    expect(res.processed).toBe(0);
    expect(res.errorLinks).toEqual([]);
    expect(res.concurrency).toBe(1); // Math.max(1, min(c, 0)) ⇒ 至少 1，但不会真跑
  });

  it('每链接一条的 console.log 不许回来（剥注释后判定）', () => {
    const src = stripCommentsForAnchor(
      readFileSync(resolvePath(__dirname, 'static.provider.ts'), 'utf8'),
    );
    const body = src.slice(src.indexOf('async scanLinksOfArticles()'));
    const methodBody = body.slice(0, body.indexOf('\n  async exportAllImg'));
    expect(methodBody.length).toBeGreaterThan(200); // 防止切空导致假绿
    expect(methodBody).not.toContain('console.log');
    // 空转反证：这把尺子量在旧形状上必须命中
    expect(
      stripCommentsForAnchor('const x = 1; console.log(link, dto);').includes('console.log'),
    ).toBe(true);
  });
});
