import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Meta, MetaDocument } from 'src/scheme/meta.schema';
import { UpdateSiteInfoDto } from 'src/types/site.dto';
import { RewardItem } from 'src/types/reward.dto';
import { SocialItem, SocialType } from 'src/types/social.dto';
import {
  CUSTOM_SOCIAL_TYPE,
  generateSocialId,
  isBuiltinSocialType,
  isCustomSocialType,
  sameSocialItem,
  shouldDeleteSocial,
} from 'src/utils/social';
import { LinkItem } from 'src/types/link.dto';
import { UserProvider } from '../user/user.provider';
import { ArticleProvider } from '../article/article.provider';
import { invalidatePublicMetaCache } from 'src/utils/publicMetaCache';
import { sanitizeArticlesPerPage } from 'src/utils/articlesPerPage';
import { sanitizePageCopy } from 'src/utils/pageCopy';
import { isTrue } from 'src/utils/isTrue';
import { ViewStatsProvider } from '../stats/viewStats.provider';
import { Optional } from '@nestjs/common';
import { MigrationKind, MigrationProvider } from '../migration/migration.provider';

/**
 * 🔒 **允许出现在匿名 `/api/public/meta` 响应里的 `siteInfo` 字段**（白名单投影）。
 *
 * 为什么需要它：公开响应此前是 `{ ...(metaDoc?.siteInfo || {}) }` **全量展开**
 * （`controller/public/public.controller.ts`），而写入侧是
 * `nextSiteInfo = { ...oldSiteInfo, ...updateDto }`（见 `updateSiteInfo`）。两者叠加的结果是：
 * **任何被写进 `siteInfo` 的键，都自动变成匿名可读** —— 新增字段时没有人需要"决定它是否公开"，
 * 默认就是公开。`UpdateSiteInfoDto` 又是 `Partial<SiteInfo> | Partial<updateUserDto>` 的联合，
 * 而 `updateUserDto` 含 `username` / `password`；`updateSiteInfo` 剥掉了 `name` 与 `password`，
 * 但**没有剥 `username`** ⇒ 一次带 `username` 的后台 PUT 就会把管理员用户名写进 `siteInfo`，
 * 然后被公开接口原样吐出去。白名单把这条路彻底堵死（新字段默认**私有**，要公开必须显式加进来）。
 *
 * 已经确认被挡掉、且**应该**被挡掉的：
 * - `allowOpenHiddenPostByUrl`：服务端自己读（`article.provider.ts` 判断隐藏文章能否按 URL 打开），
 *   前台不需要。而它对攻击者是有价值的侦察信息 —— 值为 `'true'` 就等于告诉对方
 *   "枚举文章 id / 路径就能拿到隐藏正文"。实测一份真实生产库里它确实正在被匿名下发。
 * - `username` / `password` / `name`：凭据类，任何情况下都不该出现在匿名响应里。
 *
 * ⚠️ 这份清单是**实测**出来的，不是猜的：`grep -rhoE "siteInfo[\?]?\.(\w+)" packages/website`
 * 得到前台真正读取的 44 个字段；并确认前台**没有**动态访问形状（`siteInfo[...]`、
 * `...siteInfo`、`Object.keys(siteInfo)` 全部零命中，只有一个测试文件展开自己的 fixture），
 * 也没有把 `siteInfo` 整体当参数传递的地方 ⇒ 显式白名单不会让前台静默缺字段。
 * ⚠️ 改动这份清单前请先跑那条 grep：漏一个字段的表现是"前台某个开关/文案静默失效"，
 * 而不是报错，很难被发现。有守卫钉住"清单与前台实际用量一致"。
 */
export const PUBLIC_SITE_INFO_FIELDS = [
  // 站点身份与外观
  'siteName',
  'siteDesc',
  'siteLogo',
  'siteLogoDark',
  'favicon',
  'baseUrl',
  'since',
  'uiStyle',
  'defaultTheme',
  'articlesPerPage',
  'subMenuOffset',
  'headerLeftContent',
  // 作者与关于页
  'author',
  'authorDesc',
  'authorLogo',
  'authorLogoDark',
  'aboutTitle',
  // 开关类（前台行为）
  'enableComment',
  'enableCustomizing',
  'showSubMenu',
  'showRSS',
  'showCopyRight',
  'showAdminButton',
  'showEditButton',
  'showDonateButton',
  'showDonateInAbout',
  'showDonateInfo',
  'showExpirationReminder',
  'defaultExpandAllCategories',
  'openArticleLinksInNewWindow',
  'copyrightAggreement',
  // 友链页文案
  'friendLinkIntro',
  'friendLinkApplyContent',
  // 打赏
  'payAliPay',
  'payAliPayDark',
  'payWechat',
  'payWechatDark',
  // 备案
  'beianNumber',
  'beianUrl',
  'gaBeianNumber',
  'gaBeianUrl',
  'gaBeianLogoUrl',
  // 统计代码（本来就是要在访客浏览器里执行的，属公开信息）
  'gaAnalysisId',
  'baiduAnalysisId',
] as const;

/** 白名单集合（O(1) 查询）；`readonly string[]` 便于测试遍历 */
const PUBLIC_SITE_INFO_FIELD_SET: ReadonlySet<string> = new Set<string>(PUBLIC_SITE_INFO_FIELDS);

/**
 * 已经 WARN 过的"未在白名单里的字段"，每进程每字段只提醒一次。
 * 公开 meta 有 5 秒缓存但仍是热路径，逐次打印会把日志冲掉（而日志本身在攻击期间是稀缺资源）。
 */
const warnedNonPublicSiteInfoFields = new Set<string>();

/**
 * 模块级 logger：投影是**纯函数**（拿不到 provider 实例的 logger），但"新加了字段却忘了
 * 决定它是否公开"这件事必须仍然留下痕迹 —— 而且要在**真正对外的路径**上留下（控制器直接
 * 调纯函数，不经过 provider 方法），所以自带一个。名字带 `.publicSiteInfo` 便于过滤。
 */
const publicSiteInfoLogger = new Logger('MetaProvider.publicSiteInfo');

/**
 * 🔒 把一份 `siteInfo` 投影成"**允许匿名下发**"的字段集合。
 *
 * **纯函数**：不读库、不发请求、不改入参（返回新对象）。所以调用方可以拿**已经查出来的**
 * 文档直接用，不会为了投影多一次 DB 往返（公开 meta 的 handler 里 `getAll()` 已经查过了，
 * 再查一次会把 single-flight 的收益抵消掉）。
 *
 * 它同时负责**净化**（`articlesPerPage` 夹取、三段页面文案净化、`uiStyle` 回落 apple），
 * 与 `getSiteInfo()` 里的净化逐项一致 ⇒ "公开响应"与"后台看到的值"同源，不会漂移；
 * ⚠️ 调用方替换掉原来的 `{ ...siteInfo, articlesPerPage: sanitizeArticlesPerPage(…) }` 之后
 * **不需要**再单独调 `sanitizeArticlesPerPage`（这里已经做了，重复调只会多一次夹取）。
 *
 * 为什么是白名单而不是黑名单：写入侧是 `nextSiteInfo = { ...oldSiteInfo, ...updateDto }`，
 * 也就是**任何被写进 siteInfo 的键都会自动出现在公开响应里**。黑名单意味着"新增字段默认公开"，
 * 而没有人会在新加字段时想起这件事。白名单把默认反过来：**新字段默认私有**，要公开必须显式
 * 加进 `PUBLIC_SITE_INFO_FIELDS`（有一条 grep 守卫持续核对它与前台实际用量一致）。
 *
 * @param siteInfo 原始 siteInfo（mongoose 文档 / `toObject()` 产物 / 普通对象都可以）
 * @returns 投影后的**新对象**；入参不是对象时原样返回（`undefined`/`null` 照旧 ⇒
 *          `{ ...projectPublicSiteInfo(x) }` 与修复前的展开形状一致）
 */
export function projectPublicSiteInfo(siteInfo: any): Record<string, any> {
  // ⚠️ **永远返回对象**。修复前的控制器形状是
  //    `{ ...(metaDoc?.siteInfo || {}), articlesPerPage: sanitizeArticlesPerPage(...) }`
  //    —— `articlesPerPage` 是在**展开之外**单独补的，所以即使 `siteInfo` 整个缺失它也一定存在
  //    且被夹取成默认值。若这里对非对象入参"原样返回 undefined"，`{ ...undefined }` 得到 `{}`，
  //    那个键就**消失了**，前台分页与站点设置脱钩（`public.controller.spec.ts` #207 钉的就是它）。
  const source: Record<string, any> =
    siteInfo && typeof siteInfo === 'object'
      ? typeof siteInfo.toObject === 'function'
        ? siteInfo.toObject()
        : siteInfo
      : {};
  const projected: Record<string, any> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!PUBLIC_SITE_INFO_FIELD_SET.has(key)) {
      withheld.push(key);
      if (!warnedNonPublicSiteInfoFields.has(key)) {
        warnedNonPublicSiteInfoFields.add(key);
        publicSiteInfoLogger.warn(
          `siteInfo 字段「${key}」不在公开白名单里，已从匿名 /api/public/meta 响应中剔除。` +
            `如果前台确实需要它，请把它加进 meta.provider.ts 的 PUBLIC_SITE_INFO_FIELDS` +
            `（并同步"清单与前台实际用量一致"那条守卫）；如果它是内部/凭据类字段，` +
            `那这条 WARN 就是它没有被误公开的证据。`,
        );
      }
      continue;
    }
    // **原样透传**：不补默认值、不改类型、不做二次净化。这三件事都是刻意的，
    // 因为每一件都会破坏既有契约（我第一版三件全踩了，被调用点的契约测试抓出来）：
    //  1. 不补默认值 —— 修复前是原样展开，"库里没有 ⇒ 响应里没有"。给 `uiStyle` 补 `'apple'`
    //     会让"从未设过皮肤"的站点突然开始预加载 apple 字体（前台是 `uiStyle === "apple"` 判定）；
    //     给三段页面文案补 `''` 会破坏 #373 的契约（"未设置时必须缺失，前台才能回落到自己的
    //     默认文案"）—— `?? 默认` 与 `'x' in siteInfo` 这两种写法都救不回空串。
    //  2. 不做二次净化 —— 这三段文案在**写入侧**就已经净化过（`updateSiteInfo` 逐个调
    //     `sanitizePageCopy` 之后才落库），读出来再净化一次没有安全收益，只会引入
    //     "后台看到的值与公开下发的值不一致"这种新漂移。
    //  3. 保留显式空串 —— 库里存的就是 `''` 时原样传出：`''` 是站长的显式选择，
    //     与"从未设置"是两件事，不能互相转换。
    projected[key] = value;
  }
  // 唯一一个"库里没有也必须存在"的键 —— 这是修复前就有的契约，不是本轮新增的默认值
  projected.articlesPerPage = sanitizeArticlesPerPage(source.articlesPerPage);
  if (withheld.length > 0) {
    // 只在 DEBUG 级别说明这次剔除了哪些，避免攻击期间刷日志
    publicSiteInfoLogger.debug(
      `公开 siteInfo 投影剔除了 ${withheld.length} 个字段：${withheld.join(', ')}`,
    );
  }
  return projected;
}

@Injectable()
export class MetaProvider {
  logger = new Logger(MetaProvider.name);
  timer = null;
  constructor(
    @InjectModel('Meta')
    private metaModel: Model<MetaDocument>,
    private readonly userProvider: UserProvider,
    @Inject(forwardRef(() => ArticleProvider))
    private readonly articleProvider: ArticleProvider,
    private readonly viewStats: ViewStatsProvider,
    /**
     * 迁移台账（可选注入：单测/量具直接 `new MetaProvider(...)` 时不传）。
     * 只有**启动时**那一次总字数重算会记账（main.ts 传 opts.migration），
     * 日常增删改文章触发的重算不记 —— 那不是迁移，记进去只会把台账刷爆。
     */
    @Optional() private readonly migrationProvider?: MigrationProvider,
  ) {}

  async updateTotalWords(
    reason: string,
    opts?: { migration?: { key: string; kind: MigrationKind } },
  ) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      // ⚠️ 这个 async 回调以前**没有 try/catch**，而它是被 fire-and-forget 调用的
      // （文章新建/更新/删除/导入、以及启动时）：30 秒后 Mongo 抖一下，
      // `countTotalWords()` 或 `update()` 一 reject 就是一条**没有上下文**的全局
      // unhandledRejection，而字数缓存会一直停在旧值上，直到下一次增删改文章 ——
      // 后台首页那个"总字数"就这么静默错下去，日志里看不出是这件事失败了。
      const started = Date.now();
      try {
        const total = await this.articleProvider.countTotalWords();
        await this.update({ totalWordCount: total });
        this.logger.log(`${reason}触发更新字数缓存：当前文章总字数: ${total}`);
        if (opts?.migration) {
          // record() 永不抛错（写台账失败只 WARN），不用再包 try
          await this.migrationProvider?.record({
            ...opts.migration,
            outcome: 'ok',
            durationMs: Date.now() - started,
            detail: { reason, total },
          });
        }
      } catch (err) {
        this.logger.error(
          `更新字数缓存失败（来源：${reason}）：${(err as Error)?.message || err}` +
            '——总字数会停在上一次的值，直到下一次增删改文章',
        );
        if (opts?.migration) {
          await this.migrationProvider?.record({
            ...opts.migration,
            outcome: 'error',
            durationMs: Date.now() - started,
            detail: `${reason}：${(err as Error)?.message || err}`,
          });
        }
      }
    }, 1000 * 30);
  }

  /**
   * 站点累计访问量。
   *
   * ⚠️ 不能直接读 `metas`：浏览计数现在是**攒一批再写**的（见 ViewStatsProvider），
   * 库里那一份最多落后一个 flush 周期。这里返回「库里的值 + 还没落库的增量」，
   * 也就是此刻真实的累计值 —— 与改动前（每次都先写库再读）对外表现一致。
   * 顺带把 `findOne()` 全文档换成了只取两个数字的投影查询。
   */
  async getViewer() {
    const { viewer, visited } = await this.viewStats.projection();
    return { visited, viewer };
  }

  /**
   * 记一次页面浏览。
   *
   * 改动前这里是「一次浏览 = 8 次 Mongo 命令 / 4 次写」（实测，见 ViewStatsProvider 的注释）：
   * metas 自增、文章自增（先按别名 findOne、按数字 id 再 findOne、然后 updateOne）、
   * 当天 viewers 快照（findOne + updateOne）、当天 visits（findAndModify，
   * 当天第一次还要多一次 getLastData + insert）。
   * 现在全部交给 ViewStatsProvider 在进程内合并，一轮 flush 固定 4 次命令。
   *
   * 返回值仍然是 `{visited, viewer}`（键顺序也别动：公开接口的响应体是逐字节对比过的）。
   */
  async addViewer(isNew: boolean, pathname: string, isNewByPath: boolean) {
    const projected = await this.viewStats.record({
      pathname,
      isNewVisitor: isTrue(isNew),
      isNewForPath: isTrue(isNewByPath),
    });
    return { visited: projected.visited, viewer: projected.viewer };
  }

  async getAll() {
    return this.metaModel.findOne().exec();
  }

  async getSocialTypes() {
    return [
      {
        label: '哔哩哔哩',
        value: 'bilibili',
      },
      {
        label: '邮箱',
        value: 'email',
      },
      {
        label: 'GitHub',
        value: 'github',
      },
      {
        label: 'Gitee',
        value: 'gitee',
      },
      {
        label: '微信',
        value: 'wechat',
      },
      {
        label: '微信（暗色模式）',
        value: 'wechat-dark',
      },
      {
        label: '自定义',
        value: CUSTOM_SOCIAL_TYPE,
      },
    ];
  }
  async getTotalWords() {
    return (await this.getAll()).totalWordCount || 0;
  }

  async update(updateMetaDto: Partial<Meta>) {
    // 公开 meta 接口有 5 秒进程内缓存，写完主动失效，免得后台改完要等 TTL 才看得见
    invalidatePublicMetaCache();
    // 整站恢复走的就是这条路：metas 的累计访问量被整份替换掉了，
    // 浏览统计投影用的基数必须作废，否则恢复后的访问量会带着恢复前的旧基数
    this.viewStats.invalidateBase();
    return this.metaModel.updateOne({}, updateMetaDto);
  }
  async getAbout() {
    return (await this.getAll())?.about;
  }
  async getSiteInfo() {
    const raw = (await this.getAll())?.siteInfo as any;
    if (!raw) {
      return raw;
    }
    const siteInfo = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    return {
      ...siteInfo,
      articlesPerPage: sanitizeArticlesPerPage(siteInfo.articlesPerPage),
      friendLinkIntro: sanitizePageCopy(siteInfo.friendLinkIntro, ''),
      friendLinkApplyContent: sanitizePageCopy(siteInfo.friendLinkApplyContent, ''),
      aboutTitle: sanitizePageCopy(siteInfo.aboutTitle, ''),
      // 主题 id：`default` / `apple` 是内置的，**其它值是后台上传的自定义主题 id，必须原样保留**。
      // ⚠️ 以前这里写的是 `=== 'default' ? 'default' : 'apple'`，把非 default 的值一律压成 apple ——
      // 自定义主题一启用就会被吃掉（前台读的是 getAll() 的原始值所以看着正常，
      // 但后台表单、以及任何走 getSiteInfo() 的地方都会显示成 Apple 风格，让人以为没存上）。
      // 老站点没这个字段时仍然默认 apple。
      uiStyle: String(siteInfo.uiStyle ?? '').trim() || 'apple',
    };
  }

  /**
   * 🔒 **匿名公开接口专用**的 `siteInfo` 投影：只下发 `PUBLIC_SITE_INFO_FIELDS` 里的字段。
   *
   * 与 `getSiteInfo()` 的区别（这一点必须说清，否则会有人以为可以互换）：
   * - `getSiteInfo()` 是**内部/后台**访问器：20 多处调用方（后台设置表单、caddy、jwt、
   *   sitemap、robots、waline、文章解锁判定…）都需要完整字段，**不能**收口；
   * - 本方法是**响应边界**：给 `controller/public/public.controller.ts` 组装匿名响应用，
   *   多一个字段就是多一分匿名信息泄露。
   *
   * 值仍然复用 `getSiteInfo()` 的净化结果（`articlesPerPage` 夹取、几段页面文案净化、
   * `uiStyle` 回落 apple），所以公开响应里的值与后台看到的值**同源**，不会出现
   * "后台显示 A、前台拿到 B" 的漂移。
   *
   * ⚠️ 对未在白名单里的字段打一次 WARN（每进程每字段一次）：目的不是报错，而是让
   * "新加了一个 siteInfo 字段但忘了决定它是否公开"这件事**在日志里留下痕迹**。
   * 默认行为是**不下发**（私有优先）—— 要公开就显式加进白名单，并同步那条 grep 守卫。
   */
  async getPublicSiteInfo(): Promise<Record<string, any>> {
    // ⚠️ 取**原始** siteInfo（`getAll()`），不走 `getSiteInfo()`：后者会给 uiStyle 补 'apple'、
    //    给三段文案补净化值，那是**内部/后台**访问器的口径；公开路径修复前是原样展开，
    //    两条路径必须逐字一致，否则"控制器直接用纯函数"与"走 provider 方法"会给出不同结果。
    //    白名单与 articlesPerPage 的夹取只有 `projectPublicSiteInfo` 一份真相。
    return projectPublicSiteInfo((await this.getAll())?.siteInfo);
  }

  async getArticlesPerPage() {
    const siteInfo = await this.getSiteInfo();
    return sanitizeArticlesPerPage(siteInfo?.articlesPerPage);
  }
  async getRewards() {
    return (await this.getAll())?.rewards;
  }
  async getSocials() {
    return (await this.getAll())?.socials;
  }
  async getLinks() {
    return (await this.getAll())?.links;
  }

  async updateAbout(newContent: string) {
    return this.metaModel.updateOne(
      {},
      {
        about: {
          updatedAt: new Date(),
          content: newContent,
        },
      },
    );
  }

  async updateSiteInfo(updateSiteInfoDto: UpdateSiteInfoDto) {
    invalidatePublicMetaCache();
    // @ts-ignore eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // ⚠️ `username` 也必须剥掉：`UpdateSiteInfoDto` 是 `Partial<SiteInfo> | Partial<updateUserDto>`，
    //    而 `updateUserDto` = `{ username, password }`。旧实现只剥了 `name` 与 `password`，
    //    于是一次带 `username` 的 PUT 会把管理员用户名写进 `metas.siteInfo`，再被公开 meta
    //    全量展开出去（匿名可读）。改口令走的是 `/api/admin/auth`，这里不需要透传任何凭据字段。
    //    读侧另有 `getPublicSiteInfo()` 的白名单兜底 —— 两侧都堵，任一侧被绕过都还有另一侧。
    const { name, password, username, ...updateDto } = updateSiteInfoDto;
    const oldSiteInfo = await this.getSiteInfo();
    const nextSiteInfo = { ...oldSiteInfo, ...updateDto } as any;
    nextSiteInfo.articlesPerPage = sanitizeArticlesPerPage(nextSiteInfo.articlesPerPage);
    nextSiteInfo.friendLinkIntro = sanitizePageCopy(
      (updateDto as any).friendLinkIntro,
      oldSiteInfo?.friendLinkIntro,
    );
    nextSiteInfo.friendLinkApplyContent = sanitizePageCopy(
      (updateDto as any).friendLinkApplyContent,
      oldSiteInfo?.friendLinkApplyContent,
    );
    nextSiteInfo.aboutTitle = sanitizePageCopy((updateDto as any).aboutTitle, oldSiteInfo?.aboutTitle);
    return this.metaModel.updateOne({}, { siteInfo: nextSiteInfo });
  }

  async addOrUpdateReward(addReward: Partial<RewardItem>) {
    const meta = await this.getAll();
    const toAdd: RewardItem = {
      updatedAt: new Date(),
      value: addReward.value,
      name: addReward.name,
    };
    const newRewards = [];
    let pushed = false;

    meta.rewards.forEach((r) => {
      if (r.name === toAdd.name) {
        pushed = true;
        newRewards.push(toAdd);
      } else {
        newRewards.push(r);
      }
    });
    if (!pushed) {
      newRewards.push(toAdd);
    }

    return this.metaModel.updateOne({}, { rewards: newRewards });
  }

  async deleteReward(name: string) {
    const meta = await this.getAll();
    const newRewards = [];
    meta.rewards.forEach((r) => {
      if (r.name !== name) {
        newRewards.push(r);
      }
    });
    return this.metaModel.updateOne({}, { rewards: newRewards });
  }

  async deleteSocial(type: SocialType) {
    const meta = await this.getAll();
    const newSocials = (meta.socials || []).filter((r) => !shouldDeleteSocial(r, type));
    return this.metaModel.updateOne({}, { socials: newSocials });
  }

  async addOrUpdateSocial(addSocial: Partial<SocialItem>) {
    const meta = await this.getAll();
    const toAdd = this.normalizeSocialItem(addSocial);
    const newSocials = [];
    let pushed = false;
    (meta.socials || []).forEach((r) => {
      if (sameSocialItem(r, toAdd)) {
        pushed = true;
        newSocials.push(toAdd);
      } else {
        newSocials.push(r);
      }
    });
    if (!pushed) {
      newSocials.push(toAdd);
    }

    return this.metaModel.updateOne({}, { socials: newSocials });
  }

  normalizeSocialItem(addSocial: Partial<SocialItem>): SocialItem {
    const rawType = String(addSocial.type || '').trim();
    const value = addSocial.value == null ? '' : String(addSocial.value);
    const label = typeof addSocial.label === 'string' ? addSocial.label.trim() : undefined;
    const icon = typeof addSocial.icon === 'string' ? addSocial.icon.trim() : undefined;
    const updatedAt = new Date();

    if (isBuiltinSocialType(rawType)) {
      return {
        updatedAt,
        value,
        type: rawType,
      };
    }

    const id =
      (typeof addSocial.id === 'string' && addSocial.id.trim()) ||
      (isCustomSocialType(rawType) && rawType !== CUSTOM_SOCIAL_TYPE ? rawType : '') ||
      generateSocialId();

    return {
      updatedAt,
      value,
      type: CUSTOM_SOCIAL_TYPE,
      id,
      ...(label ? { label } : {}),
      ...(icon ? { icon } : {}),
    };
  }
  async addOrUpdateLink(addLinkDto: Partial<LinkItem> & { oldName?: string }) {
    const meta = await this.getAll();
    const toAdd: LinkItem = {
      updatedAt: new Date(),
      url: addLinkDto.url,
      name: addLinkDto.name,
      desc: addLinkDto.desc,
      logo: addLinkDto.logo,
    };
    const lookupName = addLinkDto.oldName || addLinkDto.name;
    const newLinks = [];
    let pushed = false;

    (meta.links || []).forEach((r) => {
      if (r.name === lookupName) {
        pushed = true;
        newLinks.push(toAdd);
      } else {
        newLinks.push(r);
      }
    });
    if (!pushed) {
      newLinks.push(toAdd);
    }

    return this.metaModel.updateOne({}, { links: newLinks });
  }

  async deleteLink(name: string) {
    const meta = await this.getAll();
    const newLinks = [];
    (meta.links || []).forEach((r) => {
      if (r.name !== name) {
        newLinks.push(r);
      }
    });
    return this.metaModel.updateOne({}, { links: newLinks });
  }
}
