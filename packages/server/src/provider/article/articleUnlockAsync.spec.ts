import * as cryptoUtils from 'src/utils/crypto';
import { hashAccessPasswordAsync } from 'src/utils/crypto';
import { ArticleProvider } from './article.provider';

/**
 * 匿名文章解锁路径的**行为级**守卫。
 *
 * 为什么必须是行为级：这条路径上曾经出过两类事故，光看源码都发现不了 ——
 *  1. 「标记了加密但没设密码」时旧实现直接返回全文（未鉴权正文泄露）；
 *  2. 本轮把校验改成异步时，如果调用点漏了 `await`，`!Promise` 恒为 false ⇒
 *     **任何密码都能解开任何加密文章**，而且不报错、不打日志。
 * 所以这里断言的是"错密码拿不到正文 / 对密码拿到正文"这个可观测结果，
 * 并用 spy 计数证明走的是**异步**变体（同步版在解锁路径上零调用）。
 */

function makeProvider(article: any, opts?: { category?: any; siteInfo?: any }) {
  const provider: any = Object.create(ArticleProvider.prototype);
  provider.logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
  provider.getByIdOrPathname = jest.fn(async () => article);
  provider.metaProvider = {
    getSiteInfo: jest.fn(async () => opts?.siteInfo ?? { allowOpenHiddenPostByUrl: 'false' }),
  };
  provider.categoryModal = { findOne: jest.fn(async () => opts?.category ?? null) };
  return provider;
}

function makeArticle(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    title: '加密文章',
    content: '这是正文，只有解锁后才该出现',
    private: true,
    hidden: false,
    publishAt: new Date('2020-01-01T00:00:00Z'),
    password: '',
    ...overrides,
  };
}

describe('匿名解锁：错密码拿不到正文，对密码才拿得到', () => {
  let asyncSpy: jest.SpyInstance;
  let syncSpy: jest.SpyInstance;
  let hashed: string;

  beforeAll(async () => {
    hashed = await hashAccessPasswordAsync('reader-key');
  });

  beforeEach(() => {
    asyncSpy = jest.spyOn(cryptoUtils, 'verifyAccessPasswordAsync');
    syncSpy = jest.spyOn(cryptoUtils, 'verifyAccessPassword');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('密码正确 ⇒ 返回全文，且响应里不含密码字段', async () => {
    const provider = makeProvider(makeArticle({ password: hashed }));
    const result = await provider.getByIdWithPassword(1, 'reader-key');
    expect(result).not.toBeNull();
    expect(result.content).toContain('只有解锁后才该出现');
    // 密码（哈希）绝不能随正文下发
    expect(result.password).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('scrypt$');
  });

  it('密码错误 ⇒ 返回 null（拿不到正文）', async () => {
    const provider = makeProvider(makeArticle({ password: hashed }));
    expect(await provider.getByIdWithPassword(1, 'wrong-key')).toBeNull();
    expect(await provider.getByIdWithPassword(1, '')).toBeNull();
    expect(await provider.getByIdWithPassword(1, 'Reader-key')).toBeNull();
  });

  it('🔴 事故形状回归：加密但密码为空时，绝不"随便填个密码就放行"', async () => {
    // 旧实现这里直接返回全文（未鉴权正文泄露）。空目标 + 任意输入必须仍然拒绝。
    const provider = makeProvider(makeArticle({ private: true, password: '' }));
    expect(await provider.getByIdWithPassword(1, 'anything')).toBeNull();
    expect(await provider.getByIdWithPassword(1, '')).toBeNull();
  });

  it('历史明文密码仍然能解锁（迁移期兼容），但空对空不放行', async () => {
    const provider = makeProvider(makeArticle({ password: 'legacy-plain' }));
    expect((await provider.getByIdWithPassword(1, 'legacy-plain')).content).toContain('正文');
    expect(await provider.getByIdWithPassword(1, 'legacy-plaiN')).toBeNull();
  });

  it('未加密文章：给了密码就直接返回全文（不做校验，GET 本来也给全文）', async () => {
    const provider = makeProvider(makeArticle({ private: false, password: '' }));
    const result = await provider.getByIdWithPassword(1, 'whatever');
    expect(result).not.toBeNull();
    expect(result.content).toContain('正文');
  });

  it('空密码一律返回 null（这一判定在 isPrivate 之前，所以未加密文章也一样）', async () => {
    // 记录真实语义：POST 解锁口"没带密码"= 还没尝试解锁，由调用方决定怎么响应；
    // 它**不是**"未加密就放行"。我第一版把这条预期写反了，改过来并钉住。
    const provider = makeProvider(makeArticle({ private: false, password: '' }));
    expect(await provider.getByIdWithPassword(1, '')).toBeNull();
    const provider2 = makeProvider(makeArticle({ private: true, password: hashed }));
    expect(await provider2.getByIdWithPassword(1, '')).toBeNull();
  });

  it('加密分类的密码同样生效（分类私有 ⇒ 用分类密码）', async () => {
    const categoryHash = await hashAccessPasswordAsync('category-key');
    const provider = makeProvider(makeArticle({ private: false, password: hashed }), {
      category: { private: true, password: categoryHash },
    });
    // 文章自己的密码不对 ⇒ 拒绝（必须用分类密码）
    expect(await provider.getByIdWithPassword(1, 'reader-key')).toBeNull();
    expect((await provider.getByIdWithPassword(1, 'category-key')).content).toContain('正文');
  });

  it('隐藏文章在 allowOpenHiddenPostByUrl=false 时按 404 处理（连"存在"都不确认）', async () => {
    const provider = makeProvider(makeArticle({ hidden: true, password: hashed }));
    await expect(provider.getByIdWithPassword(1, 'reader-key')).rejects.toThrow(/隐藏文章/);
  });

  it('🔴 走的是**异步**变体：解锁路径上同步 verifyAccessPassword 零调用', async () => {
    const provider = makeProvider(makeArticle({ password: hashed }));
    await provider.getByIdWithPassword(1, 'reader-key');
    await provider.getByIdWithPassword(1, 'wrong-key');
    expect(asyncSpy).toHaveBeenCalledTimes(2);
    // 同步版一次都不许出现：它每次阻塞事件循环约 63ms，而这是匿名可达路径
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('空转反证：把 await 去掉后上面那条"错密码返回 null"会失败（证明判据有区分力）', async () => {
    // 模拟"漏 await"的后果：`!Promise` 恒为 false ⇒ 判定通过 ⇒ 任何密码都拿到正文。
    // 这里不改生产代码，而是直接把同一个表达式按事故形状算一遍，证明它确实会放行。
    const notAwaited: any = cryptoUtils.verifyAccessPasswordAsync(hashed, 'totally-wrong');
    expect(!notAwaited).toBe(false); // ← 事故形状：判定"通过"了
    expect(await notAwaited).toBe(false); // ← 正确形状：判定"拒绝"
    // 也就是说：await 的有无，直接决定这条路径是"拒绝"还是"任意密码放行"
  });
});
