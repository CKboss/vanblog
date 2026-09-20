/**
 * meta 剩下三个写方法（`update` / `updateAbout` / `updateSiteInfo`）：
 * **不许再用空字面量 filter `{}`**，且 `metas` 为空时的降级口径要分别正确。
 *
 * 🔴 `{}` 在写操作上有两种坏形状，两种都**不报错**：
 *   - 集合为空 ⇒ 匹配 **0 条** ⇒ 管理员点"保存"、界面提示成功、**什么都没写进去**；
 *   - 集合不止一条 ⇒ 命中自然顺序里的**任意一条** ⇒ **改错文档**（数据悄悄错了，比崩溃更糟）。
 *
 * ⚠️ 三个方法的降级口径**故意不同**，这是本轮最需要钉住的一件事：
 *   - `updateAbout` / `updateSiteInfo` 是**后台保存入口**，站点必然已初始化 ⇒ 取不到文档就是数据损坏，
 *     抛 **404 + 可照做的下一步**（与同文件另外 6 个写方法同口径）。
 *   - `update` 被启动期的 `updateTotalWords('首次启动')` 与"每次增删改文章"调用，
 *     而**未初始化站点的 metas 本来就是空的** ⇒ 抛错会让每个未初始化站点每次启动都产生一条 ERROR，
 *     把 `./vanblog.sh doctor` 的 24h ERROR 计数淹掉。所以它是 **WARN + 不写 + 返回 null**。
 *   - 两者都**不 upsert**：`update()` 收的是 `Partial<Meta>`，upsert 会造出一份只有部分字段、
 *     没有 `siteInfo` 的残缺文档，于是 `meta.siteInfo.xxx` 那一族空值解引用**重新变成活路径**
 *     （前两轮刚清掉 22 处）。用"造一份残缺文档"换"不报错"，是把可诊断的空换成不可诊断的半真半假。
 *
 * ⚠️ 替身沿用本仓库既有做法：`Object.create(MetaProvider.prototype)`（它有一堆 `@InjectModel`，
 *    不能直接 new），代价是**类属性初始化器不会跑** ⇒ `missingMetaWarnedFor` 是 undefined，
 *    产品代码里用 `??=` 兜住，这里也顺带把"替身确实没有这个字段"当成一条反证钉住。
 */
import { NotFoundException } from '@nestjs/common';
import { MetaProvider } from './meta.provider';

const DOC = {
  _id: 'meta-doc-id-9',
  siteInfo: { siteName: 'old', baseUrl: 'https://old.example/' },
  about: { content: 'old', updatedAt: new Date() },
  totalWordCount: 1,
};

function build(doc: any) {
  const calls: Array<{ filter: any; patch: any }> = [];
  const warns: string[] = [];
  const model = {
    // ⚠️ 与真实 Mongoose 一致：findOne() 返回 thenable（带 exec），集合为空时 exec 出 null
    findOne: () => ({ exec: async () => doc }),
    updateOne: async (filter: any, patch: any) => {
      calls.push({ filter, patch });
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
  };
  const errors: string[] = [];
  const provider = Object.create(MetaProvider.prototype) as MetaProvider;
  (provider as any).metaModel = model;
  (provider as any).logger = {
    log: () => undefined,
    warn: (m: string) => warns.push(String(m)),
    error: (m: string) => errors.push(String(m)),
  };
  // update() 会调 viewStats.invalidateBase()；这里只需要它存在且不炸
  let invalidateBaseCalls = 0;
  (provider as any).viewStats = { invalidateBase: () => (invalidateBaseCalls += 1) };
  return {
    provider,
    calls,
    warns,
    errors,
    model,
    get invalidateBaseCalls() {
      return invalidateBaseCalls;
    },
  };
}

describe('meta 的三个写方法：空字面量 filter 已清除，降级口径分别正确', () => {
  it('⚠️ 替身自检 A：findOne().exec() 在"集合为空"时真的 resolve 成 null（否则下面全是空转）', async () => {
    const { model } = build(null);
    await expect(model.findOne().exec()).resolves.toBeNull();
  });

  it('⚠️ 替身自检 B：Object.create 出来的实例确实没有类属性（所以产品侧的 ??= 是必需的）', () => {
    const { provider } = build(DOC);
    expect((provider as any).missingMetaWarnedFor).toBeUndefined();
  });

  it('🔴 updateAbout：metas 为空 ⇒ 抛 404，且 updateOne **一次都没被调用**', async () => {
    const { provider, calls } = build(null);
    await expect((provider as any).updateAbout('new content')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // 断言的不是"抛了"，而是"**没写库**"：抛错但同时写了一半才是最难查的形状
    expect(calls).toHaveLength(0);
  });

  it('🔴 updateSiteInfo：metas 为空 ⇒ 抛 404，且 updateOne **一次都没被调用**', async () => {
    const { provider, calls } = build(null);
    await expect(
      (provider as any).updateSiteInfo({ siteName: 'new' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
  });

  it('404 的文案是可照做的：点名 metas 为空、并指向 doctor 与 restore --offline-full', async () => {
    const { provider } = build(null);
    const msg = await (provider as any).updateAbout('x').catch((e: Error) => e.message);
    expect(msg).toContain('metas 集合为空');
    expect(msg).toContain('doctor');
    expect(msg).toContain('restore --offline-full');
    expect(msg).toContain('MetaProvider.updateAbout');
  });

  it('🔴 update：metas 为空 ⇒ **不抛错**、返回 null、不写库，并记一条 WARN', async () => {
    const { provider, calls, warns, errors } = build(null);
    const ret = await (provider as any).update({ totalWordCount: 42 });
    expect(ret).toBeNull();
    expect(calls).toHaveLength(0);
    expect(warns).toHaveLength(1);
    // WARN 必须说清"没有写入任何数据"，否则又是静默
    expect(warns[0]).toContain('没有写入任何数据');
    expect(warns[0]).toContain('MetaProvider.update');
    // ⚠️ 级别判据：未初始化是**合法状态**，所以是 WARN 而不是 ERROR（ERROR 会污染 doctor 的 24h 计数）
    expect(errors).toHaveLength(0);
  });

  it('🔴 update 的 WARN 每进程只记一次（它会被"每次增删改文章"间接触发，不去重就是日志洪水）', async () => {
    const { provider, warns } = build(null);
    await (provider as any).update({ totalWordCount: 1 });
    await (provider as any).update({ totalWordCount: 2 });
    await (provider as any).update({ totalWordCount: 3 });
    expect(warns).toHaveLength(1);
  });

  it('⚠️ update 为空时**不 upsert**：不会造出一份残缺的 meta 文档', async () => {
    // upsert 会让 getAll() 从"返回 null"变成"返回一份只有计数字段、没有 siteInfo 的文档"，
    // 于是读侧 `meta.siteInfo.xxx` 那一族空值解引用重新变成活路径。
    const { provider, calls } = build(null);
    await (provider as any).update({ totalWordCount: 7 });
    expect(calls).toHaveLength(0);
    // 反证：这条断言的尺子有效 —— 有文档时 updateOne 确实会被调用（见下一条用例）
  });

  it('三个方法在**有文档**时都按 `_id` 精确写（filter 恰好一个键、就是那份文档的 _id）', async () => {
    for (const [name, run] of [
      ['update', (p: any) => p.update({ totalWordCount: 42 })],
      ['updateAbout', (p: any) => p.updateAbout('new content')],
      ['updateSiteInfo', (p: any) => p.updateSiteInfo({ siteName: 'new' })],
    ] as Array<[string, (p: any) => Promise<unknown>]>) {
      const { provider, calls } = build({ ...DOC });
      await run(provider);
      expect(calls).toHaveLength(1);
      const filter = calls[0].filter;
      // 🔴 这两条一起才钉住"不再是 {}"：键数为 1 且那一个键就是 _id
      expect(Object.keys(filter)).toHaveLength(1);
      expect(filter).toEqual({ _id: DOC._id });
      expect(calls[0].filter).not.toEqual({});
    }
  });

  it('updateSiteInfo 合并写入时仍然剥掉凭据字段（本轮改动不许回退这条既有性质）', async () => {
    const { provider, calls } = build({ ...DOC, siteInfo: { ...DOC.siteInfo } });
    await (provider as any).updateSiteInfo({
      siteName: 'new',
      username: 'someone',
      password: 'browser-derived',
      name: 'admin',
    } as any);
    const written = calls[0].patch.siteInfo;
    expect(written.siteName).toBe('new');
    for (const forbidden of ['username', 'password', 'name']) {
      expect(Object.prototype.hasOwnProperty.call(written, forbidden)).toBe(false);
    }
  });

  it('update 仍然先失效公开 meta 缓存与浏览统计基数（既有副作用不许丢）', async () => {
    // ⚠️ 不能 `const { invalidateBaseCalls } = build(…)`：那是个 getter，
    //    解构会在**调用之前**就把值快照成 0（我第一版就这么写的，于是恒红）。
    const built = build({ ...DOC });
    expect(built.invalidateBaseCalls).toBe(0); // 调用前确实是 0（尺子有效）
    await (built.provider as any).update({ totalWordCount: 3 });
    expect(built.invalidateBaseCalls).toBe(1);
  });
});
