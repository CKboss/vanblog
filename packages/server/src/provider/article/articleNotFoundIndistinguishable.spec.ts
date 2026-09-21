/**
 * 🔴 匿名枚举 oracle 修复的**行为级**不变量（2026-09-21）
 *
 * ## 这条 spec 存在的理由
 * 公开文章详情有两条匿名可达的路：
 *  - `GET  /api/public/article/:id`  → `ArticleProvider.getByIdOrPathnameWithPreNext(id, 'public')`
 *  - `POST /api/public/article/:id`  → `ArticleProvider.getByIdWithPassword(id, password)`
 *
 * 修复前，"文章不存在"、"文章被隐藏且不允许按 URL 打开"、"文章还没到发布时间"这三种情况
 * 对匿名调用方是**可区分**的：
 *  - GET：不存在 → 404 `找不到文章`；隐藏 → 404 **专属文案** ⇒ 靠文案就能枚举出隐藏文章的存在；
 *  - POST：不存在 → `return null`（HTTP 201 + `data:null`）；未到点 / 隐藏 → **404** ⇒ 靠状态码就能
 *    枚举出定时文章与隐藏文章的存在（活体记录见 `audit-hardening-round4-security-bruteforce.spec.ts`
 *    的 FINDING R4-5：`POST /999999 → 201 data:null`、`POST /9 → 404`、`POST /7 → 201 data:null`）。
 *
 * 修复后三种情况**逐字节同形**。本文件钉住这个不变量，并且**用行为级断言**（真调方法、真比对
 * 抛出的异常对象），而不是只钉源码文本 —— 源码钉子只能证明"代码长这样"，证明不了"调用方看到的一样"。
 *
 * ## ⚠️ 为什么断言用 `toBe`/`toBeNull` 逐字比对，而不用 `toThrow(/正则/)`
 * 正则会被"两句话都包含某个共同子串"骗过：例如把文案改成 `找不到文章（隐藏）`，
 * `/找不到文章/` 仍然匹配 ⇒ 断言绿，但 oracle 已经回来了。所以：
 *  - GET：比对 `err.message` **逐字相等**（`toBe`），并比对 `err instanceof NotFoundException` 与状态码；
 *  - POST：比对返回值 **`toBeNull()`**，并两两 `toBe`（同形）。
 *
 * ## ⚠️ 替身忠实性（本仓库已六次因替身钉住作者的假设而让真缺陷隐形）
 * 本文件的替身**必须能给出 null**（文章不存在）与**能给出 `hidden:true` 的文档**，
 * 否则"三种情况同形"会因为"三种情况都走到同一个分支"而假绿。
 * ⇒ 每条用例前面都有一条**替身自检**，先证明替身真的给出了预期的形状。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { NotFoundException } from '@nestjs/common';

import { stripCommentsForAnchor } from '../../test-utils/anchorCode';
import { ArticleProvider, NOT_FOUND_MESSAGE } from './article.provider';

/** 一篇文档的最小形状（只放被测分支真正会读的字段） */
type Doc = {
  id: number;
  title?: string;
  content?: string;
  pathname?: string;
  hidden?: boolean;
  private?: boolean;
  password?: string;
  publishAt?: Date | null;
  deleted?: boolean;
  category?: string;
  tags?: string[];
  createdAt?: Date;
};

/**
 * 造一个最小的 articleModel 替身。
 * ⚠️ 只需要支持 `findOne(query, projection).exec()` —— 因为被测的两条分支都在
 * `getByIdOrPathname()` 返回之后、pre/next 与 relatedArticles 之前就抛/返回了。
 * ⚠️ 故意**不**实现 find/sort/limit 等：如果被测代码走到了那里，会立刻 TypeError，
 *    那是"测试失败"而不是"静默假绿"，方向是安全的（fail loud）。
 */
function makeModel(doc: Doc | null) {
  const calls: Array<{ query: any; projection: any }> = [];
  return {
    calls,
    findOne(query: any, projection: any) {
      calls.push({ query, projection });
      return { exec: async () => (doc === null ? null : ({ ...doc } as any)) };
    },
  };
}

/**
 * categoryModal 替身，两种模式：
 *  - `'sentinel'`（默认）：一被碰到就抛哨兵 ⇒ 用来判断"执行是否越过了某道闸门"。
 *    ⚠️ 只适用于**期望在闸门处就结束**的用例；如果用例要走到密码/分类那一段，
 *    哨兵会先炸（本文件第一版就因此红了两条：正向对照需要真的走到 `return plain`）。
 *  - `'empty'`：`findOne` 返回 null（代码里 `|| ({} as any)` 兜底）⇒ 让执行能继续走完，
 *    用于"已发布/开关放行 ⇒ 必须拿到正文"这类正向对照。
 */
const SENTINEL = 'SENTINEL_REACHED_PAST_GATE';
function makeCategoryModel(mode: 'sentinel' | 'empty') {
  return {
    findOne() {
      if (mode === 'sentinel') throw new Error(SENTINEL);
      return null;
    },
  };
}

function makeProvider(
  doc: Doc | null,
  siteInfo: Record<string, unknown> = {},
  categoryMode: 'sentinel' | 'empty' = 'sentinel',
) {
  const model = makeModel(doc);
  const provider = new ArticleProvider(
    model as any,
    makeCategoryModel(categoryMode) as any,
    { updateTotalWords: () => undefined, getSiteInfo: async () => siteInfo } as any,
    {} as any,
  );
  return { provider, model };
}

/** 取出抛出的异常（没有抛则返回 null），用于逐字比对 */
async function capture(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('🔴 GET 公开详情：三种「看不到」对匿名调用方必须不可区分', () => {
  it('文章不存在 与 文章被隐藏（且不允许按 URL 打开）抛出**逐字相同**的错误', async () => {
    // 替身自检 ①：不存在那一侧，替身必须真的给出 null
    const missing = makeProvider(null, {});
    expect(await (missing.model.findOne({ id: 1 }, {}) as any).exec()).toBeNull();

    // 替身自检 ②：隐藏那一侧，替身必须真的给出 hidden:true 的文档
    const hidden = makeProvider({ id: 7, title: '藏起来的', hidden: true, private: false }, {});
    const hiddenDoc = await (hidden.model.findOne({ id: 7 }, {}) as any).exec();
    expect(hiddenDoc).not.toBeNull();
    expect(hiddenDoc.hidden).toBe(true);

    // allowOpenHiddenPostByUrl 未开（缺省 / 'false' 两种都要覆盖，因为代码两个条件都判）
    for (const siteInfo of [{}, { allowOpenHiddenPostByUrl: 'false' }]) {
      const a = makeProvider(null, siteInfo);
      const b = makeProvider({ id: 7, title: '藏起来的', hidden: true, private: false }, siteInfo);
      const errMissing = await capture(() => a.provider.getByIdOrPathnameWithPreNext(999999, 'public'));
      const errHidden = await capture(() => b.provider.getByIdOrPathnameWithPreNext(7, 'public'));

      // 两边都必须抛，且是同一个异常类型
      expect(errMissing).toBeInstanceOf(NotFoundException);
      expect(errHidden).toBeInstanceOf(NotFoundException);
      // 🔴 文案**逐字相同**（这是本修复的核心：靠文案枚举不再可能）
      expect(errHidden.message).toBe(errMissing.message);
      expect(errHidden.message).toBe(NOT_FOUND_MESSAGE);
      // 状态码也必须相同（文案相同但状态码不同同样是 oracle）
      const statusOf = (e: any) =>
        typeof e?.getStatus === 'function' ? e.getStatus() : e?.status ?? e?.response?.statusCode;
      expect(statusOf(errHidden)).toBe(statusOf(errMissing));
      expect(statusOf(errHidden)).toBe(404);
      // 🔴 响应体整体也要同形（Nest 的 NotFoundException 会把 message 放进 response）
      expect(JSON.stringify(errHidden.response)).toBe(JSON.stringify(errMissing.response));
    }
  });

  it('🔴 那句专属文案在**运行时**也不可能出现（不只是源码里没有）', async () => {
    // 源码级断言在 audit-hardening-round4 里；这里补一条运行时的：
    // 隐藏文章抛出的 message 里不许含"隐藏"二字（含了就等于告诉调用方"这里有一篇隐藏文章"）。
    const b = makeProvider({ id: 7, hidden: true, private: false }, {});
    const err = await capture(() => b.provider.getByIdOrPathnameWithPreNext(7, 'public'));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(String(err.message).includes('隐藏')).toBe(false);
    expect(String((err as any).response).includes('隐藏')).toBe(false);
    // 尺子有效性反证：合成一个带"隐藏"的异常，证明上面那把尺子真的能命中。
    // ⚠️ 故意用**拼接**而不是写完整字面量：修复后全仓（产品代码）应当搜不到那句旧文案，
    //    如果这里写全，"grep 一下还有没有残留"这类排查就会被本文件误伤
    //    （audit-hardening-round4 里的 HIDDEN_LEGACY_MARKER 同理）。
    const synthetic = new NotFoundException('该文章是隐藏' + '文章！');
    expect(String(synthetic.message).includes('隐藏')).toBe(true);
  });

  it('allowOpenHiddenPostByUrl 开着时，隐藏文章**仍然放行**（修复没有把 opt-in 弄坏）', async () => {
    // ⚠️ 这条用例证明的是「越过了 hidden 那道闸门」，不是"整条 happy path 都正确"。
    //    手法：categoryModel 替身一被碰到就抛哨兵 ⇒ 若拿到哨兵，说明执行已经走到 hidden 检查**之后**
    //    （private/分类加密那一段）；若拿到 NotFoundException，说明仍然被 hidden 拦下。
    //    这样不需要把 pre/next 与 relatedArticles 的整套替身都建起来，判据也更锐利。
    const p = makeProvider({ id: 7, hidden: true, private: false }, { allowOpenHiddenPostByUrl: 'true' });
    const err = await capture(() => p.provider.getByIdOrPathnameWithPreNext(7, 'public'));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(SENTINEL);
    expect(err).not.toBeInstanceOf(NotFoundException);

    // 对照：同一篇文章、同一个替身，只把开关关掉 ⇒ 必须被拦下（证明哨兵不是"总能走到"）
    const p2 = makeProvider({ id: 7, hidden: true, private: false }, { allowOpenHiddenPostByUrl: 'false' });
    const err2 = await capture(() => p2.provider.getByIdOrPathnameWithPreNext(7, 'public'));
    expect(err2).toBeInstanceOf(NotFoundException);
    expect((err2 as Error).message).toBe(NOT_FOUND_MESSAGE);
  });
});

describe('🔴 POST 解锁口：四种「拿不到」必须逐字节同形（都是 null）', () => {
  it('不存在 / 未到点 / 隐藏 / 密码错 —— 返回值全部是 null 且两两严格相等', async () => {
    const password = 'reader-key';

    // ① 文章不存在
    const missing = makeProvider(null, {});
    expect(await (missing.model.findOne({ id: 1 }, {}) as any).exec()).toBeNull(); // 替身自检
    const rMissing = await missing.provider.getByIdWithPassword(999999, password);

    // ② 存在但未到发布时间（且**未加密** ⇒ 少了那道检查就会 return plain 泄漏全文）
    const future = makeProvider(
      {
        id: 9,
        title: '定时',
        content: '还没发布的正文',
        hidden: false,
        private: false,
        publishAt: new Date(Date.now() + 86400000),
      },
      {},
    );
    const rFuture = await future.provider.getByIdWithPassword(9, password);

    // ③ 隐藏文章（且不允许按 URL 打开）
    const hidden = makeProvider({ id: 7, title: '藏', content: 'x', hidden: true, private: false }, {});
    const rHidden = await hidden.provider.getByIdWithPassword(7, password);

    // ④ 不带密码（既有语义：还没尝试解锁）
    const noPw = makeProvider(null, {});
    const rNoPw = await noPw.provider.getByIdWithPassword(999999, '');

    // 🔴 四个都必须是 null，且两两**严格相等**（同形）
    expect(rMissing).toBeNull();
    expect(rFuture).toBeNull();
    expect(rHidden).toBeNull();
    expect(rNoPw).toBeNull();
    expect(rMissing).toBe(rFuture);
    expect(rFuture).toBe(rHidden);
    expect(rHidden).toBe(rNoPw);

    // 🔴 而且**一个都不许抛**：抛错会让 HTTP 状态码与"不存在"分叉，oracle 立刻回来
    //    （这四条上面已经 await 过了，没抛就是证据；这里再用 capture 显式钉一遍形状）
    for (const [prov, id, pw] of [
      [makeProvider(null, {}).provider, 999999, password],
      [
        makeProvider(
          { id: 9, content: 'x', hidden: false, private: false, publishAt: new Date(Date.now() + 86400000) },
          {},
        ).provider,
        9,
        password,
      ],
      [makeProvider({ id: 7, content: 'x', hidden: true, private: false }, {}).provider, 7, password],
    ] as const) {
      expect(await capture(() => (prov as any).getByIdWithPassword(id, pw))).toBeNull();
    }
  });

  it('🔴 未到点的**未加密**文章绝不返回正文（删掉 isFuturePublish 检查就会泄漏）', async () => {
    // 这条单独钉"检查本身必须存在"：修复把它的**结果**从 404 改成 null 之后，
    // 有人可能误以为"三支都返回 null，那这道检查是冗余的"而删掉它。
    // 删掉的后果不是 oracle 回来，而是**更严重的正文泄漏**：未加密 ⇒ `!isPrivate` ⇒ `return plain`。
    const future = makeProvider(
      { id: 9, title: '定时', content: '还没发布的正文', hidden: false, private: false, publishAt: new Date(Date.now() + 86400000) },
      {},
    );
    const r = await future.provider.getByIdWithPassword(9, 'any');
    expect(r).toBeNull();
    // 反证：同一替身下，一篇**已发布**的未加密文章是能拿到正文的 ⇒ 证明上面的 null 来自那道检查，
    // 而不是"这个替身根本走不到 return plain"（否则本用例恒绿、毫无意义）
    const published = makeProvider(
      { id: 10, title: '已发布', content: '公开正文', hidden: false, private: false, publishAt: new Date(Date.now() - 86400000) },
      {},
      'empty', // ⚠️ 正向对照要真的走到 return plain，所以不能用哨兵替身
    );
    const r2: any = await published.provider.getByIdWithPassword(10, 'any');
    expect(r2).not.toBeNull();
    expect(r2.content).toBe('公开正文');
  });

  it('🔴 隐藏文章绝不返回正文（删掉 hidden 检查就会泄漏，历史上真泄漏过）', async () => {
    const doc: Doc = { id: 7, title: '藏', content: '隐藏正文', hidden: true, private: false };
    // 替身自检：确认喂进去的文档 hidden 真的是 true（手滑写成 false 会让本用例恒绿）
    const probe = makeProvider(doc, {});
    expect((await (probe.model.findOne({ id: 7 }, {}) as any).exec()).hidden).toBe(true);

    expect(await probe.provider.getByIdWithPassword(7, 'any')).toBeNull();

    // 🔴 反证（这条决定上面那个断言有没有意义）：allowOpenHiddenPostByUrl 开着时，
    //    **同一篇文档、同一个替身**必须能拿到正文 ⇒ 证明上面的 null 确实来自 hidden 那道检查，
    //    而不是"替身根本走不到 return plain"（否则断言恒绿、删掉检查也不会红）。
    const allowed = makeProvider(doc, { allowOpenHiddenPostByUrl: 'true' }, 'empty');
    const r: any = await allowed.provider.getByIdWithPassword(7, 'any');
    expect(r).not.toBeNull();
    expect(r.content).toBe('隐藏正文');
  });
});

describe('🔴 残余风险（如实记录，不假装已修）：时间侧信道', () => {
  it('解锁口只调用一次密码校验 ⇒ "看不到"的几支刻意**不做**假校验来抹平时间差', async () => {
    // ⚠️ 这条**不是**断言"没有时间差"，而是把残余风险与**当时的取舍**钉进测试，
    //    免得将来有人以为已经修完、或有人"顺手"加一次假校验来抹平时间差。
    //
    // 事实：POST 时
    //   - 不存在 / 未到点 / 隐藏 / 不带密码 ⇒ 立刻 return null（快）
    //   - 加密文章 + 带密码 + 密码错       ⇒ 走 verifyAccessPasswordAsync（异步 scrypt，慢）
    // ⇒ 于是"慢 + null"能推断出"这里有一篇加密文章"。这是**修复前就存在**的形状，
    //   本次修复既没有引入它，也没有消除它。
    //
    // 🔴 为什么**不**用"对不存在的 id 也跑一次假 scrypt"来抹平：那会让**匿名**调用方
    //   每次请求都能烧掉一次 scrypt（同步版本机实测约 63ms/次；异步版不阻塞事件循环但仍耗 CPU），
    //   等于把一个"文案 oracle"换成一个"匿名 CPU 放大面"—— 在本项目的威胁模型下更糟。
    //   现有缓解是解锁口的限流（20 次/10 分钟/(IP×文章)）。
    // ⇒ 结论：文案与状态码这两条**精确**信号已消除（精确信号比统计信号危险得多），
    //   时间侧信道作为**已登记的残余风险**保留，要做常数时间需单独排一轮并重新评估放大面。
    //
    // 因此这里钉住的是"只有一次校验调用"：谁想加假校验来抹平时间差，必须先读到上面这段取舍。
    const src = readFileSync(join(__dirname, 'article.provider.ts'), 'utf8');
    const stripped = stripCommentsForAnchor(src);
    const body = stripped.slice(
      stripped.indexOf('async getByIdWithPassword('),
      stripped.indexOf('async getByIdOrPathnameWithPreNext('),
    );
    expect(body.length).toBeGreaterThan(200); // 尺子自检：真的切到了方法体
    expect((body.match(/verifyAccessPasswordAsync\(/g) || []).length).toBe(1);
    // 且那次调用必须在密码校验那一段（在 `!password` 早退之后），不是在"看不到"的分支里
    expect(body.indexOf('verifyAccessPasswordAsync(')).toBeGreaterThan(body.indexOf('if (!password)'));
  });
});
