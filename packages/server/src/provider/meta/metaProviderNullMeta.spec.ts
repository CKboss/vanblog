/**
 * `metas` 集合为空时，全站最热的匿名公开读不许 500。
 *
 * ## 为什么需要这个 spec（两层盲区，都是"替身钉住了假设而不是现实"）
 * `MetaProvider.getAll()` 是 `metaModel.findOne().exec()` —— **无 filter 的 findOne 在集合为空时返回 null**
 * （Mongoose 的真实行为）。而：
 *  1. 既有的 `meta.provider.spec.ts` 用的内存 model 是 `findOne: () => ({ exec: async () => state })`，
 *     `state` 恒为一个对象 ⇒ **它永远不可能返回 null**，于是"meta 为 null"这条分支在测试里不存在；
 *  2. 既有的 `public.controller.spec.ts` 直接把 `getTotalWords` 打桩成 `mockResolvedValue(100)`
 *     ⇒ 把唯一会崩的那个调用**桩掉了**。
 * 两层加起来，`(await this.getAll()).totalWordCount` 这个裸解引用在测试里完全隐形。
 * 这与本仓库已发生过的两次同族事故一模一样（Mongoose 替身对 `{}` 返回 null；
 * `fakeReq` 恒带 `socket.remoteAddress`）。
 *
 * ## 后果为什么是"整站前台死掉"而不是"后台某处报错"
 * `getTotalWords()` 被 `controller/public/public.controller.ts` 的 `buildPublicMeta()` 放在 `Promise.all` 里，
 * 而 `/api/public/meta` 是**匿名可达、全站最热的一次读**（前台每个页面渲染都要调）。
 * `Promise.all` 里任何一个 reject ⇒ 整个接口 500 ⇒ 前台整站打不开，日志里只有一个 TypeError。
 * 同文件 `:386-390` 记载过**完全同一形状**的真机事故：`getMenuSetting()` 返回 null 时裸解构
 * 让"全站最热的公开读变成 500、前台整个死掉"，是真机 drill 撞到的（那处已用 `menuRes ?? {}` 修掉）。
 *
 * ## 可达性
 * `metas` 为空而站点"已初始化"：恢复一份手工做的/部分归档（有 users 没有 metas）、或库损坏。
 * 不是理论形状 —— 上面那次事故就是同一条路径。
 */
import * as fs from 'fs';
import * as path from 'path';
import { MetaProvider } from './meta.provider';
import { PublicController } from '../../controller/public/public.controller';
import { stripCommentsForAnchor } from '../../test-utils/anchorCode';

/**
 * 忠实复现 Mongoose 的内存 model：**集合为空时 `findOne()`（无 filter）返回 null**。
 * ⚠️ 这正是既有替身缺的那一半。
 */
function createMetaModel(doc: any | null) {
  return {
    findOne: jest.fn(() => ({ exec: async () => doc })),
    updateOne: jest.fn(async () => ({ acknowledged: true, modifiedCount: 1 })),
  };
}

function createMetaProvider(doc: any | null) {
  const model = createMetaModel(doc);
  // 构造参数：metaModel、userProvider、articleProvider、viewStats（后三个本 spec 用不到）
  const provider = new MetaProvider(model as any, {} as any, {} as any, {} as any);
  return { provider, model };
}

describe('MetaProvider.getTotalWords 在 metas 为空时', () => {
  it('替身自检：空集合时 getAll() 真的返回 null（否则下面几条全是空转）', async () => {
    const { provider } = createMetaProvider(null);
    // ⚠️ 这条不是产品性质，是**尺子有效性反证**：如果哪天有人把这个替身"修好"成返回 {}，
    //    这条会红，提醒他"你刚把唯一能触发缺陷的形状弄没了"。
    await expect(provider.getAll()).resolves.toBeNull();
  });

  it('🔴 不抛 TypeError，降级为 0', async () => {
    const { provider } = createMetaProvider(null);
    await expect(provider.getTotalWords()).resolves.toBe(0);
  });

  it('正对照：有 meta 文档时返回真实字数（证明上面那条 0 不是恒真）', async () => {
    const { provider } = createMetaProvider({ totalWordCount: 41508 });
    await expect(provider.getTotalWords()).resolves.toBe(41508);
  });

  it('字段缺失（有文档但没有 totalWordCount）也返回 0，与既有 `|| 0` 口径一致', async () => {
    const { provider } = createMetaProvider({});
    await expect(provider.getTotalWords()).resolves.toBe(0);
  });

  it('totalWordCount 为 0 时仍返回 0（不会被 `|| 0` 之外的分支改变）', async () => {
    const { provider } = createMetaProvider({ totalWordCount: 0 });
    await expect(provider.getTotalWords()).resolves.toBe(0);
  });
});

describe('匿名公开读 /api/public/meta 在 metas 为空时', () => {
  /**
   * 🔴 这一组是**端到端**的：用**真的 MetaProvider**（配空集合 model）塞进**真的 PublicController**，
   * 而不是把 getTotalWords 打桩 —— 打桩正是既有 spec 让缺陷隐形的原因。
   */
  function createPublicControllerWithEmptyMetas() {
    const { provider: metaProvider } = createMetaProvider(null);
    const controller = new PublicController(
      { getTotalNum: jest.fn().mockResolvedValue(0) } as any, // articleProvider
      { getPublicCategoryNames: jest.fn().mockResolvedValue([]) } as any, // categoryProvider
      { getAllTags: jest.fn().mockResolvedValue([]) } as any, // tagProvider
      metaProvider as any, // ← 真 provider，不是桩
      {} as any, // visitProvider
      {
        // ⚠️ getMenuSetting 返回 null 是**既有真实行为**（setting.provider.ts:134-140），
        //    controller 里已用 `menuRes ?? {}` 防护；这里如实喂 null，顺带覆盖那条。
        getMenuSetting: jest.fn().mockResolvedValue(null),
        getLayoutSetting: jest.fn().mockResolvedValue(null),
        encodeLayoutSetting: jest.fn().mockReturnValue({}),
      } as any,
      {} as any, // customPageProvider
    );
    return controller;
  }

  it('buildPublicMeta 不 reject（改前这里会抛 TypeError ⇒ 接口 500 ⇒ 前台整站打不开）', async () => {
    const controller = createPublicControllerWithEmptyMetas();
    // ⚠️ 直接调私有的取数函数，绕开 single-flight 缓存：本组要验的是"取数与组装"，
    //    而 5 秒进程内缓存会让相邻用例互相污染。
    const res = await (controller as any).buildPublicMeta();
    // 返回形状是 `{ statusCode: 200, data: { …, totalWordCount, … } }`（public.controller.ts:409-425）
    expect(res.statusCode).toBe(200);
    expect(res.data.totalWordCount).toBe(0);
    // ⚠️ 顺带钉住同一批 Promise.all 里那条**既有**防护仍然有效：getMenuSetting 返回 null 时
    //    `menus` 必须是 undefined 而不是抛错（那处用 `menuRes ?? {}` 修过，见 :386-393 的事故记载）。
    expect(res.data.menus).toBeUndefined();
  });

  it('🔴 跨文件可达性：public.controller 确实在 Promise.all 里调用了 getTotalWords', () => {
    // 钉住"这个 provider 方法真的在匿名公开读的路径上"，否则上面那组测的就不是同一个东西。
    const src = stripCommentsForAnchor(
      fs.readFileSync(
        path.join(__dirname, '../../controller/public/public.controller.ts'),
        'utf8',
      ),
    );
    expect(src).toContain('this.metaProvider.getTotalWords()');
    expect(src).toMatch(/Promise\.all\(\[[\s\S]{0,600}getTotalWords\(\)/);
    // ⚠️ 并且它必须是 `/api/public/` 这个匿名前缀下的 controller（没有 @UseGuards）
    expect(src).toContain("@Controller('/api/public/')");
  });
});
