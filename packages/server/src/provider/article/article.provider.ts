/** 搜索类查询的时间上限：正文全文 $regex 扫描很贵，超时就放弃，别把库拖死。 */
const SEARCH_MAX_TIME_MS = 5000;
/** 单次搜索最多返回多少条（见 searchByString 里的说明） */
const SEARCH_MAX_RESULTS = 200;

import { pickCoverFromContent } from 'src/utils/coverFromContent';
import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { safeDecodeURIComponent } from 'src/utils/safeDecode';
import {
  articleDefaultsStage,
  orderPublicArticles,
  topSortSpec,
} from 'src/utils/publicArticleOrder';
import { verifyAccessPasswordAsync } from 'src/utils/crypto';
import {
  hashAccessPasswordIdempotentAsync,
  isScryptHash,
  needsPasswordUpgrade,
  redactAccessSecretList,
  resolveAccessPasswordWriteAsync,
} from 'src/utils/accessPassword';
import {
  Logger,
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ArticleExcerptFields,
  CreateArticleDto,
  SearchArticleOption,
  UpdateArticleDto,
} from 'src/types/article.dto';
import { Article, ArticleDocument } from 'src/scheme/article.schema';
import { parseImgLinksOfMarkdown } from 'src/utils/parseImgOfMarkdown';
import { wordCount } from 'src/utils/wordCount';
import { parseNumericId, tryParseNumericId } from 'src/utils/numericId';
import { sanitizePagination, UNLIMITED_PAGE_SIZE } from 'src/utils/pagination';
import { slugCandidates, titleToSlug } from 'src/utils/slug';
import { assertUsablePathname, normalizePathname } from 'src/utils/articlePathname';
import { isFuturePublish, normalizePublishAt, visiblePublishFilter } from 'src/utils/publishAt';
import { readingMinutesFromContent, readingMinutesFromUnits } from 'src/utils/readingTime';
import {
  prepareRewriteBases,
  rewriteBaseUrlInDocuments,
  RewriteBaseUrlCount,
} from 'src/utils/rewriteBaseUrl';
import { MetaProvider } from '../meta/meta.provider';
import { VisitProvider } from '../visit/visit.provider';
import { RevisionProvider } from '../revision/revision.provider';
import { MigrationProvider, MigrationKind } from '../migration/migration.provider';
import { sleep } from 'src/utils/sleep';
import { CategoryDocument } from 'src/scheme/category.schema';
import { escapeRegExp, safeSearchPattern } from 'src/utils/regex';
import { asQueryString } from 'src/utils/sanitizeRequest';
import { envPositiveInt } from 'src/utils/envNumber';

/**
 * 取哪一份投影。⚠️ `'listSlim'` 是**公开列表**的精简形状（少 `hidden`/`lastVisitedTime`/
 * `wordCount` 三个"公开响应里零消费者"的字段，见 `slimListView` 的注释），
 * **只能**由公开接口在调用方显式要求时使用；管理端一律用 `'admin'`/`'list'`。
 */
export type ArticleView = 'admin' | 'public' | 'list' | 'listSlim';

/**
 * 「扫描文章图片」的**分批**参数。
 *
 * 为什么必须分批：这个扫描要读**每篇文章的正文**（图片链接就在正文里），而正文是整个库里
 * 最大的字段。以前是一次 `find()` 把全部未删除文章连正文一起拉进堆：
 * 5000 篇 × 300 KB ≈ **1.5 GB** ⇒ worker 直接 OOMKilled。
 * ⚠️ 而这条路径**不是只有管理员能碰**：`post-/api/admin/img/scan` 既不在 `publicRoutes`
 * 也不在 `pathPermissionMap` 里，但 `/api/admin/img` 不在 `SUPER_ADMIN_ONLY_ROUTE_PREFIXES`
 * 里 ⇒ **勾了「所有权限」的协作者可以调**。在"低权限账号应当按已被攻陷来设计"的威胁模型下，
 * 这就是"一个廉价请求打死整个 worker"的放大链（而且可反复触发：重启后再来一次）。
 *
 * 分批之后**峰值**内存只与批大小有关（50 篇 × 300 KB ≈ 15 MB），与全站规模无关。
 */
const IMG_LINK_SCAN_BATCH_SIZE = 50;

/**
 * 一轮扫描最多处理多少篇文章。
 *
 * 上限存在的理由是**运行时间**而不是内存（内存已经由分批解决）：下游对每个图片链接都要
 * 真去下载一次（`static.provider.getImgInfoByLink` → `fetchImg`，单张上限 50 MB、超时 15 s，
 * 失败还会用 encodeURI 再试一次），链接多时整轮可能跑几十分钟，一直占着一个请求。
 * ⚠️ 撞上限时**必须如实报告**（`truncated: true` + WARN），绝不能静默返回不完整结果
 * 让调用方以为"全站都扫过了"—— 那会让"补缩略图/找失效图"这类维护动作给出错误的结论。
 */
const IMG_LINK_SCAN_MAX_ARTICLES = envPositiveInt(
  'VANBLOG_IMG_SCAN_MAX_ARTICLES',
  5000,
  1,
  1000000,
);

/** 单篇文章的图片链接汇总（`getAllImageLinks` 的元素形状，**对外契约不变**）。 */
export interface ArticleImageLinks {
  articleId: number;
  title: string;
  links: string[];
}

/** 带扫描元信息的结果：给需要"如实说明扫了多少、有没有被截断"的调用方用。 */
export interface ArticleImageLinksScan {
  items: ArticleImageLinks[];
  /** 实际处理的文章篇数 */
  scannedArticles: number;
  /** 实际解析出的图片链接总数 */
  scannedLinks: number;
  /** 累计读入的正文字节数（只用于日志，不是内存峰值——分批后峰值只与批大小有关） */
  contentBytes: number;
  /** 是否因为撞上 `IMG_LINK_SCAN_MAX_ARTICLES` 而**没有扫完全站** */
  truncated: boolean;
  /** 本轮生效的上限（便于日志与调用方如实转述） */
  articleCap: number;
}

/** 相关文章（P6）：一次查询最多取多少候选（JS 里再排序取前 RELATED_MAX） */
export const RELATED_CANDIDATE_LIMIT = 50;
/** 相关文章最多返回几条（任务契约：max 5） */
export const RELATED_MAX = 5;

/**
 * 🔴 公开文章详情口"看不到这篇文章"时**唯一**允许的对外文案（GET 与 POST 两条路共用）。
 *
 * 为什么必须是**一个常量**而不是两处相同的字面量：这个值承担的是**安全性质**——
 * "文章不存在"、"文章被隐藏且不允许按 URL 打开"、"文章还没到发布时间"三种情况对匿名调用方
 * **必须不可区分**。如果写成两处字面量，将来任何人改其中一处（哪怕只是改个标点）就会
 * **静默地重新打开一个枚举 oracle**，而所有测试可能仍然全绿（除非有测试逐字比对，
 * 而"逐字比对两处字符串"这种断言本身也容易被顺手改掉）。共用一个常量把"不可区分"
 * 变成**结构性**事实：改它就是同时改三种情况，想制造差异必须显式引入第二个字符串，
 * 而那会被守卫抓到（`audit-hardening-round4-security-bruteforce.spec.ts` 与本文件的
 * 不可区分性用例都钉住了"公开路径只允许这一个文案"）。
 *
 * ⚠️ 措辞本身不重要，重要的是**唯一性**：不要给它加任何区分性的后缀（例如"（隐藏）"），
 *    也不要为某一种情况另造一句"更友好"的文案 —— 那正是本常量要防止的事。
 */
export const NOT_FOUND_MESSAGE = '找不到文章';

/** 公开详情 payload 里 relatedArticles 的条目形状（前台另一个 agent 按这个契约消费） */
export interface RelatedArticleItem {
  /** 数字 id 的字符串形式（本站文章的对外标识一直是数字 id，不是 mongo ObjectId） */
  _id: string;
  /** 同上，数字形式（与全仓库其它 payload 的 `id` 字段一致） */
  id: number;
  title: string;
  pathname: string;
  cover: string;
  updatedAt: Date | null;
  readingMinutes: number;
}

@Injectable()
export class ArticleProvider {
  private readonly logger = new Logger(ArticleProvider.name);
  idLock = false;
  constructor(
    @InjectModel('Article')
    private articleModel: Model<ArticleDocument>,
    @InjectModel('Category') private categoryModal: Model<CategoryDocument>,
    @Inject(forwardRef(() => MetaProvider))
    private readonly metaProvider: MetaProvider,
    private readonly visitProvider: VisitProvider,
    /**
     * 文章历史版本（可选注入：单测/量具直接 `new ArticleProvider(...)` 时不传，
     * 行为与引入该功能之前完全一致 —— 不记快照）。
     */
    @Optional() private readonly revisionProvider?: RevisionProvider,
    /** 迁移台账（可选注入，同上）。只给后台触发的回填类修复记账用。 */
    @Optional() private readonly migration?: MigrationProvider,
  ) {}
  publicView = {
    title: 1,
    content: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    createdAt: 1,
    lastVisitedTime: 1,
    id: 1,
    top: 1,
    _id: 0,
    viewer: 1,
    visited: 1,
    private: 1,
    hidden: 1,
    author: 1,
    copyright: 1,
    pathname: 1,
    cover: 1,
  };

  adminView = {
    title: 1,
    content: 1,
    tags: 1,
    category: 1,
    lastVisitedTime: 1,
    updatedAt: 1,
    createdAt: 1,
    id: 1,
    top: 1,
    hidden: 1,
    password: 1,
    private: 1,
    _id: 0,
    viewer: 1,
    visited: 1,
    author: 1,
    copyright: 1,
    pathname: 1,
    cover: 1,
    // P5：后台列表/详情要能看到定时发布状态（publishAt > now = 待发布）。
    // 只加在 adminView —— 公开面（publicView/listView）的响应形状不变。
    publishAt: 1,
  };

  listView = {
    title: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    lastVisitedTime: 1,
    createdAt: 1,
    id: 1,
    top: 1,
    hidden: 1,
    private: 1,
    _id: 0,
    viewer: 1,
    visited: 1,
    author: 1,
    copyright: 1,
    pathname: 1,
    cover: 1,
    // P6：wordCount 存储副本 —— 列表投影不带 content，readingMinutes 靠它算
    wordCount: 1,
  };

  /**
   * 回收站列表投影（P3）：管理端列表需要的字段，**没有 content / password**。
   * wordCount 是存储副本（P6 维护），publishAt 让后台能看出"删掉的是不是定时文章"。
   */
  deletedListView = {
    id: 1,
    title: 1,
    pathname: 1,
    category: 1,
    tags: 1,
    top: 1,
    hidden: 1,
    author: 1,
    cover: 1,
    wordCount: 1,
    publishAt: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: 1,
    _id: 0,
  };

  /**
   * **管理端**列表投影：与 listView 逐字段一致，只多 select 一个 `password`。
   *
   * 为什么需要它：`password` 从此不再下发（schema 的 toJSON transform 会把它换成布尔
   * `hasPassword`），但后台「文章列表 → 修改信息」弹窗是直接拿**列表行**当初始值的，
   * 它需要知道"这篇到底设没设密码"才能把输入框提示写成「已设置（留空表示不修改）」
   * 而不是「留空表示不加密」。取出来只为了算那个布尔，出口一定被脱敏（见 getByOption
   * 末尾的 redactAccessSecretList）。
   *
   * ⚠️ 公开面（isPublic）**永远用 listView**：这条投影只在管理端分支里出现，
   * 前台列表/__NEXT_DATA__ 的形状与体积一个字节都不变。
   */
  adminListView = {
    ...this.listView,
    password: 1,
  };

  /**
   * **公开列表的精简投影**（`view: 'listSlim'`）：`listView` 去掉三个"公开响应里没有任何消费者"
   * 的字段 —— `hidden`、`lastVisitedTime`、`wordCount`。
   *
   * ## 为什么是这三个（逐个核实过，不是猜的）
   * 实测 `/api/public/category`（53 篇）里每个字段的 JSON 字节占比：这三个合计
   * **3,882 B = 响应的 19.2%**（`lastVisitedTime` 2,332 B / 11.5%、`wordCount` 808 B / 4.0%、
   * `hidden` 742 B / 3.7%）；`/api/public/tag` 与 `/api/public/timeline` 同量级（19.0% / 19.1%）。
   *  - `hidden`：公开**列表**路径一律带 `hidden:false` 过滤（`getAll(view, includeHidden=false)`
   *    与 `getTimeLineInfo` 都是），所以响应里它**恒为 false** —— 实测 53/53 全是 `false`，
   *    零信息量。公开**详情**路径（`publicView`）才可能出现 `hidden:true`，而那只在站长开启了
   *    `allowOpenHiddenPostByUrl` 时发生，此时调用方**已经拿到这篇文章**了，这个布尔不透露任何
   *    它还不知道的事。⇒ 它是**白传**，不是泄漏（真正可区分的是 404 文案，见
   *    `audit-hardening-round4-security-bruteforce.spec.ts` 里那条已登记、待与前台协同修的 oracle）。
   *  - `lastVisitedTime`：访问台账，前台不显示。`packages/website` 里产品代码**零读者**
   *    （命中的全是测试与注释）；sitemap 的 `lastmod` 用的是 `updatedAt || createdAt`
   *    （`provider/sitemap/sitemap.provider.ts:140`），**不是**它；ISR 只用 `id`/`pathname`
   *    （`utils/articlePublicPaths.ts`）。后台确实用它（阅读排行/最近浏览），但后台走
   *    `adminView`/`adminListView`，与这条投影无关。
   *  - `wordCount`：`packages/website` 产品代码零读者；前台要的"阅读时长"是服务端算好的
   *    `readingMinutes`（`getByOption` 里由 `content` 或这个存量副本推出）。搜索索引虽然读
   *    `article.wordCount`，但它走的是 `getAll('public', …)`（`publicView`，本来就不带 wordCount），
   *    且**已经**有"取不到就用同一个 `utils/wordCount` 现算"的回落（`searchIndexBuild.ts:248-254`）。
   *
   * ## 为什么写成"显式清单"而不是 `{...this.listView}` 再删键
   * 🔴 **默认精简、新增字段要显式 opt-in**：将来给 `listView` 加字段时，它**不会**自动出现在
   * 公开精简响应里 —— 漏掉的失败方向是"少发一个字段"（可诊断、可补），而不是"又白传一个字段"
   * （静默、没人发现）。这与前台上一轮确立的"lean by default + explicit opt-in"是同一条原则。
   * 配套的守卫在 `article.provider.slimListView.spec.ts`：钉住"slim 恰好比 listView 少这三个字段"
   * 与"slim ⊂ listView"，所以两侧漂移都会红。
   *
   * ⚠️ **不要把它用在管理端**：后台的分类/标签页要显示"隐藏"标记、阅读排行要 `lastVisitedTime`、
   * 统计要 `wordCount`。管理端走 `includeHidden=true` 的调用方，默认仍是 `listView`。
   * ⚠️ **也不含 `content`**（与 `listView` 一致）⇒ 用它算不出 `readingMinutes`；需要阅读时长的
   * 消费方应当走 `/api/public/article?toListView=true&withExcerpt=true`（那条会算好再下发）。
   */
  slimListView = {
    title: 1,
    tags: 1,
    category: 1,
    updatedAt: 1,
    createdAt: 1,
    id: 1,
    top: 1,
    private: 1,
    _id: 0,
    viewer: 1,
    visited: 1,
    author: 1,
    copyright: 1,
    pathname: 1,
    cover: 1,
  };

  toPublic(oldArticles: Article[]) {
    return oldArticles.map((item) => {
      return {
        title: item.title,
        content: item.content,
        tags: item.tags,
        category: item.category,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
        id: item.id,
        top: item.top,
      };
    });
  }
  async create(
    createArticleDto: CreateArticleDto,
    skipUpdateWordCount?: boolean,
    id?: number,
  ): Promise<Article> {
    // P5：publishAt 入库前统一归一化（非法值 400，绝不存 Invalid Date；
    // undefined=本次不设置，null=显式清除定时）
    if (createArticleDto.publishAt !== undefined) {
      (createArticleDto as any).publishAt = normalizePublishAt(createArticleDto.publishAt);
    }
    // 访问密码入库前换成 scrypt 哈希：明文存储等于"拿到库就拿到全站加密文章的密码"。
    // 新建语义下**留空 = 不加密**（没有旧值需要保留）；`clearPassword` 不是 schema
    // 字段，必须从入库对象里摘掉。规则的唯一真源是 utils/accessPassword.ts。
    // ⚠️ 必须用异步变体并 await：同步 scrypt 单次阻塞事件循环约 63 ms（本机实测）。
    //    这条是**鉴权后可达**的写入路径，一个有写权限的协作者反复保存加密文章就能持续
    //    拖慢整个 worker（而 UV_THREADPOOL_SIZE=16 决定的异步口令吞吐 ≈254 次/秒，
    //    只有在异步化之后才成立）。⚠️ 漏写 await 会让 `passwordWrite` 变成一个 Promise，
    //    于是 `passwordWrite.password` 是 undefined ⇒ 走"不修改密码"分支，静默丢密码。
    const passwordWrite = await resolveAccessPasswordWriteAsync(createArticleDto, 'create');
    const payload: any = { ...createArticleDto };
    delete payload.clearPassword;
    payload.password = passwordWrite.password ?? '';
    const createdData = new this.articleModel(payload);    const newId = id || (await this.getNewId());
    createdData.id = newId;
    createdData.pathname = await this.resolvePathnameForCreate(createArticleDto, newId);
    // P6：正文字数副本入库（readingMinutes 在"投影不带正文"的查询里靠它算）。
    // 老文档由启动回填补齐（backfillWordCounts，台账 key `backfill:articleWordCount`）。
    createdData.wordCount = wordCount((createArticleDto as any)?.content || '');
    if (!skipUpdateWordCount) {
      this.metaProvider.updateTotalWords('新建文章');
    }
    const res = createdData.save();
    return res;
  }

  /**
   * Alias used in the public URL `/post/<pathname>`.
   *
   * A manually provided alias is validated and has to be free. Otherwise the
   * title is turned into a pinyin slug and the first unused candidate wins
   * (`my-post`, `my-post-2`, …, `my-post-<id>`). Titles without any URL-safe
   * character (or titles that would slugify to a bare number) keep the plain
   * `/post/<id>` URL.
   */
  private async resolvePathnameForCreate(
    createArticleDto: CreateArticleDto,
    id: number,
  ): Promise<string> {
    const manual = normalizePathname(createArticleDto?.pathname);
    if (manual) {
      assertUsablePathname(manual);
      if (await this.isPathnameTaken(manual)) {
        throw new BadRequestException(`路径别名 "${manual}" 已被其它文章占用`);
      }
      return manual;
    }
    for (const candidate of slugCandidates(titleToSlug(createArticleDto?.title), id)) {
      if (!(await this.isPathnameTaken(candidate))) {
        return candidate;
      }
    }
    return '';
  }

  /**
   * Soft-deleted articles keep occupying their alias: restoring one must not
   * collide with a slug handed out in the meantime.
   */
  private async isPathnameTaken(pathname: string, excludeId?: number): Promise<boolean> {
    if (!pathname) {
      return false;
    }
    const filter: any = { pathname };
    if (excludeId != null) {
      filter.id = { $ne: excludeId };
    }
    const hit = await this.articleModel.findOne(filter, { id: 1 }).exec();
    return !!hit;
  }

  /**
   * Give pinyin aliases to articles that predate this feature (or whose title
   * produced no slug). Existing aliases are never touched, so re-running is
   * safe; `dryRun` reports the same picks without writing.
   *
   * 后台触发的数据修复 ⇒ 记一条迁移台账（`backfill:articlePathname`）；
   * 台账没注入（单测直接 new）时行为与从前逐字节一致。
   */
  async backfillPathname(options?: { dryRun?: boolean }): Promise<{
    dryRun: boolean;
    scanned: number;
    updated: number;
    skipped: number;
    items: { id: number; title: string; pathname: string }[];
  }> {
    return this.withLedger(
      'backfill:articlePathname',
      'backfill',
      () => this.doBackfillPathname(options),
      (r) => ({ dryRun: r.dryRun, scanned: r.scanned, updated: r.updated, skipped: r.skipped }),
    );
  }

  /** 台账在就包一层 run()（计时+记账+失败 WARN），不在就原样跑；错误语义不变（原样上抛）。 */
  private withLedger<T>(
    key: string,
    kind: MigrationKind,
    task: () => Promise<T>,
    detail?: (result: T) => unknown,
  ): Promise<T> {
    if (this.migration) {
      return this.migration.run({ key, kind }, task, detail ? { detail } : undefined);
    }
    return task();
  }

  private async doBackfillPathname(options?: { dryRun?: boolean }): Promise<{
    dryRun: boolean;
    scanned: number;
    updated: number;
    skipped: number;
    items: { id: number; title: string; pathname: string }[];
  }> {
    const dryRun = options?.dryRun === true;
    const articles = await this.articleModel
      .find(
        {
          $or: [{ pathname: '' }, { pathname: null }, { pathname: { $exists: false } }],
          deleted: { $ne: true },
        },
        { id: 1, title: 1 },
      )
      .sort({ id: 1 })
      .exec();
    const items: { id: number; title: string; pathname: string }[] = [];
    // dryRun writes nothing, so duplicates have to be blocked in memory to
    // report the same slugs a real run would pick.
    const pending = new Set<string>();
    let skipped = 0;
    for (const article of articles) {
      const doc: any = article;
      let picked = '';
      for (const candidate of slugCandidates(titleToSlug(doc.title), doc.id)) {
        if (pending.has(candidate) || (await this.isPathnameTaken(candidate))) {
          continue;
        }
        picked = candidate;
        break;
      }
      if (!picked) {
        skipped += 1;
        continue;
      }
      pending.add(picked);
      if (!dryRun) {
        await this.articleModel.updateOne({ id: doc.id }, { pathname: picked });
      }
      items.push({ id: doc.id, title: doc.title, pathname: picked });
    }
    return {
      dryRun,
      scanned: articles.length,
      updated: items.length,
      skipped,
      items,
    };
  }
  async searchArticlesByLink(link: string) {
    const artciles = await this.articleModel.find(
      {
        content: { $regex: safeSearchPattern(link), $options: 'i' },
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
      this.listView,
    );
    return artciles;
  }
  /**
   * 批量统计一批图片链接分别被哪些文章引用（图片管理列表要显示「引用文章」）。
   * 一次 $regex 把候选文章捞出来，再在内存里逐个计数，避免每张图查一次库。
   * 传相对路径（`/static/img/x.webp`）时，正文里写绝对 URL 的也能命中。
   */
  async countArticlesByLinks(links: string[]) {
    const cleaned = Array.from(
      new Set((links || []).map((link) => String(link || '').trim()).filter(Boolean)),
    ).slice(0, 200);
    const result: Record<string, { count: number; articles: { id: number; title: string }[] }> = {};
    for (const link of cleaned) {
      result[link] = { count: 0, articles: [] };
    }
    if (!cleaned.length) {
      return result;
    }
    // 单条链接限长：否则一个几 MB 的「链接」会拼出巨型 $regex，让每次查询都全表扫描
    const pattern = cleaned
      .map((link) => escapeRegExp(link.slice(0, 2048)))
      .filter(Boolean)
      .join('|');
    const articles = await this.articleModel.find(
      {
        content: { $regex: pattern, $options: 'i' },
        $or: [{ deleted: false }, { deleted: { $exists: false } }],
      },
      { _id: 0, id: 1, title: 1, content: 1 },
    );
    for (const article of articles) {
      const content = String((article as any)?.content || '').toLowerCase();
      for (const link of cleaned) {
        if (!content.includes(link.toLowerCase())) {
          continue;
        }
        const entry = result[link];
        entry.count += 1;
        // 列表里只显示前几篇，够用了
        if (entry.articles.length < 10) {
          entry.articles.push({ id: (article as any).id, title: (article as any).title });
        }
      }
    }
    return result;
  }

  /**
   * 全站文章里的图片链接（对外形状**不变**：仍是 `ArticleImageLinks[]`）。
   *
   * ⚠️ 需要知道"扫了多少 / 有没有被截断"的调用方请用 `scanAllImageLinks()`，
   * 别用这个方法的长度去推断完整性 —— 撞上限时它就是**不完整**的。
   */
  async getAllImageLinks(): Promise<ArticleImageLinks[]> {
    return (await this.scanAllImageLinks()).items;
  }

  /**
   * `getAllImageLinks` 的诚实版：按 `_id` **keyset 分页**分批读取，每批只投影必要字段，
   * 处理完即释放；撞上限时返回 `truncated: true` 并打 WARN。
   *
   * 为什么用 keyset（`_id > last`）而不是 `skip/limit`：`skip` 在深分页时是 O(skip) 的
   * （服务端要数着跳过），扫全站会变成 O(n²)；keyset 每批都走 `_id` 索引，总成本 O(n)。
   * ⚠️ 排序**必须**与游标条件同一个键（`_id` 升序），否则会漏文档或重复处理。
   */
  async scanAllImageLinks(): Promise<ArticleImageLinksScan> {
    const baseQuery = {
      $or: [{ deleted: false }, { deleted: { $exists: false } }],
    };
    // 只取用得上的字段：`content` 是必须的（链接在正文里），但绝不取 revisions/其它大字段
    const projection = { _id: 1, id: 1, title: 1, content: 1 };

    const items: ArticleImageLinks[] = [];
    let lastObjectId: any = null;
    let scannedArticles = 0;
    let scannedLinks = 0;
    let contentBytes = 0;
    let truncated = false;

    for (;;) {
      const filter =
        lastObjectId === null
          ? baseQuery
          : { $and: [baseQuery, { _id: { $gt: lastObjectId } }] };
      // ⚠️ 批大小要按**剩余配额**收窄：否则上限是在整批处理完之后才检查的，
      //    一轮会超出上限最多 (批大小 - 1) 篇 —— 上限就不再是上限了。
      const remaining = IMG_LINK_SCAN_MAX_ARTICLES - scannedArticles;
      if (remaining <= 0) {
        break;
      }
      const take = Math.min(IMG_LINK_SCAN_BATCH_SIZE, remaining);
      const batch = await this.articleModel
        .find(filter, projection)
        .sort({ _id: 1 })
        .limit(take)
        .exec();
      if (!batch || batch.length === 0) {
        break;
      }
      for (const article of batch) {
        const content = (article as any)?.content || '';
        const eachLinks = parseImgLinksOfMarkdown(content);
        contentBytes += typeof content === 'string' ? content.length : 0;
        scannedLinks += eachLinks.length;
        items.push({
          articleId: (article as any).id,
          title: (article as any).title,
          links: eachLinks,
        });
        scannedArticles += 1;
      }
      lastObjectId = (batch[batch.length - 1] as any)._id;

      if (scannedArticles >= IMG_LINK_SCAN_MAX_ARTICLES) {
        // 诚实判定"还有没有剩"：只取一条、只投影 _id，成本可忽略
        const more = await this.articleModel
          .find({ $and: [baseQuery, { _id: { $gt: lastObjectId } }] }, { _id: 1 })
          .sort({ _id: 1 })
          .limit(1)
          .exec();
        truncated = Boolean(more && more.length > 0);
        break;
      }
      if (batch.length < take) {
        break; // 最后一批不满 ⇒ 已经到底
      }
    }

    if (truncated) {
      this.logger.warn(
        `扫描文章图片链接**未覆盖全站**：已达单轮上限 ${IMG_LINK_SCAN_MAX_ARTICLES} 篇，` +
          `本次只处理了前 ${scannedArticles} 篇（解析出 ${scannedLinks} 个图片链接、` +
          `累计正文 ${(contentBytes / 1024 / 1024).toFixed(1)} MB），后面还有文章没扫。` +
          `结果**不完整**，请勿据此认为"全站图片都已入库/没有失效图"。` +
          `要一次扫完全站，调大 VANBLOG_IMG_SCAN_MAX_ARTICLES（内存峰值只与批大小 ` +
          `${IMG_LINK_SCAN_BATCH_SIZE} 篇有关，与全站规模无关，所以调大是安全的，只是更慢）。`,
      );
    } else {
      this.logger.log(
        `扫描文章图片链接完成：${scannedArticles} 篇、${scannedLinks} 个链接、` +
          `正文合计 ${(contentBytes / 1024 / 1024).toFixed(1)} MB（分 ${IMG_LINK_SCAN_BATCH_SIZE} 篇/批）`,
      );
    }

    return {
      items,
      scannedArticles,
      scannedLinks,
      contentBytes,
      truncated,
      articleCap: IMG_LINK_SCAN_MAX_ARTICLES,
    };
  }

  async rewriteBaseUrl(oldBase?: string, newBase?: string): Promise<RewriteBaseUrlCount> {
    const bases = prepareRewriteBases(oldBase, newBase);
    if (!bases) {
      return { updated: 0, replacements: 0 };
    }
    const articles = await this.articleModel.find({
      $or: [
        {
          deleted: false,
        },
        {
          deleted: { $exists: false },
        },
      ],
    });
    return rewriteBaseUrlInDocuments(
      articles || [],
      async (id, content) => {
        // 正文被改写 ⇒ P6 的字数副本同步重算
        await this.articleModel.updateOne(
          { id },
          { content, wordCount: wordCount(content), updatedAt: new Date() },
        );
      },
      bases.oldBase,
      bases.newBase,
    );
  }

  async updateViewerByPathname(pathname: string, isNew: boolean) {
    let article = await this.getByPathName(pathname, 'list');
    if (!article) {
      // 这是通过 id 的吧。
      const numericId = tryParseNumericId(pathname);
      if (numericId == null) {
        return;
      }
      article = await this.getById(numericId, 'list');
      if (!article) {
        return;
      }
    }
    // ⚠️ 以前是「读出来 +1 再写回绝对值」：两个人同时看同一篇文章，后写的会覆盖先写的，
    //    阅读量**永久少计**。visit / meta 两个 provider 早就改成原子 $inc 了，这里漏了。
    await this.articleModel.updateOne(
      { id: article.id },
      {
        $inc: isNew ? { viewer: 1, visited: 1 } : { viewer: 1 },
        $set: { lastVisitedTime: new Date() },
      },
    );
  }

  async updateViewer(id: number, isNew: boolean) {
    const article = await this.getById(id, 'list');
    if (!article) {
      return;
    }
    // 同上：原子 $inc，别再读出来 +1 写回绝对值（并发会丢计数）
    await this.articleModel.updateOne(
      { id: id },
      {
        $inc: isNew ? { viewer: 1, visited: 1 } : { viewer: 1 },
        $set: { lastVisitedTime: new Date() },
      },
    );
  }

  async getRecentVisitedArticles(num: number, view: ArticleView) {
    return await this.articleModel
      .find(
        {
          lastVisitedTime: { $exists: true },
          $or: [
            {
              deleted: false,
            },
            {
              deleted: { $exists: false },
            },
          ],
        },
        this.getView(view),
      )
      .sort({ lastVisitedTime: -1 })
      .limit(num);
  }

  async getTopViewer(view: ArticleView, num: number) {
    return await this.articleModel
      .find(
        {
          viewer: { $ne: 0, $exists: true },
          $or: [
            {
              deleted: false,
            },
            {
              deleted: { $exists: false },
            },
          ],
        },
        this.getView(view),
      )
      .sort({ viewer: -1 })
      .limit(num);
  }
  async getTopVisited(view: ArticleView, num: number) {
    return await this.articleModel
      .find(
        {
          viewer: { $ne: 0, $exists: true },
          $or: [
            {
              deleted: false,
            },
            {
              deleted: { $exists: false },
            },
          ],
        },
        this.getView(view),
      )
      .sort({ visited: -1 })
      .limit(num);
  }

  // ⚠️ 这里以前有两个方法：`washViewerInfoByVisitProvider()`（用 visits 台账覆盖文章的阅读量）
  // 与 `washViewerInfoToVisitProvider()`（反过来把文章的阅读量写回今天的 visits 行）。
  // 已删除，原因：① **零调用方**（全仓库 grep 只有定义本身）；② 都是"每篇文章一次
  // `visitProvider.getByArticleId` / `rewriteToday`"的 N+1 形状；③ 它们直接改**统计口径**
  // （visits.viewer/visited 是按路径的累计快照，而 article.viewer 是原子 $inc 的累计值，
  // 两套台账在引入拼音别名之后本来就不是一一对应，见 §7.45）。
  // 留着的风险正是"以后有人不明就里接上去"，把两套台账互相覆盖一遍。
  // 真要合并这两套台账，见 §7.40 B-7 —— 那是一次需要单独决策的数据迁移，不是一个 wash 方法。

  async importArticles(articles: Article[]) {
    // 先获取一遍新的 id
    // for (let i = 0; i < articles.length; i++) {
    //   const newId = await this.getNewId();
    //   articles[i].id = newId;
    // }

    // id 相同就合并，以导入的优先
    for (const a of articles) {
      const { id, ...createDto } = a;
      const oldArticle = await this.getById(id, 'admin');
      if (oldArticle) {
        // 必须 await：updateById 会因为路径名冲突等原因抛 BadRequestException，
        // 不 await 就是 unhandledRejection → Node 20 直接退出进程（导入到一半 server 挂掉）
        try {
          await this.updateById(
            oldArticle.id,
            {
              ...createDto,
              deleted: false,
              updatedAt: oldArticle.updatedAt || oldArticle.createdAt,
            },
            true,
          );
        } catch (error) {
          this.logger.warn(
            `导入文章失败，已跳过：id=${id} title=${(a as any)?.title} reason=${
              error?.message || error
            }`,
          );
        }
      } else {
        await this.create(
          {
            ...createDto,
            updatedAt: createDto.updatedAt || createDto.createdAt || new Date(),
          },
          true,
          id,
        );
      }
    }
    this.metaProvider.updateTotalWords('导入文章');
  }

  async countTotalWords() {
    // Public 总字数: unpublished hidden/deleted copies are excluded.
    // Drafts live in another collection and are never counted here.
    let total = 0;
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
      {
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      },
      // P5：公开口径的总字数不含还没到点的定时文章（与 getTotalNum 同口径）
      visiblePublishFilter(),
    ];
    const articles = await this.articleModel
      .find(
        {
          $and,
        },
        // 只算字数，却把**每篇文章的全部字段**（含正文里所有其它内容）都拉回来：
        // explain 显示 examined=106 个完整文档 ≈ 200KB，而真正用到的只有 content。
        // 这个函数在每次启动、以及每次增删改文章后 30 秒都会跑一遍。
        { content: 1 },
      )
      .exec();
    articles.forEach((a) => {
      total = total + wordCount(a?.content || '');
    });
    return total;
  }
  async getTotalNum(includeHidden: boolean) {
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    if (!includeHidden) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5：公开口径的文章总数不含"还没到点"的定时文章
      $and.push(visiblePublishFilter());
      // 未鉴权的搜索不能变成「加密文章正文探测器」：
      // 以前只排除 deleted/hidden，于是拿候选词反复搜 /api/public/search，
      // 看加密文章的标题是否出现，就能一个词一个词地把受密码保护的正文试出来。
      $and.push({
        $or: [
          { private: false },
          { private: { $exists: false } },
        ],
      });
      const privateCategories = await this.getPrivateCategoryNames();
      if (privateCategories.length) {
        $and.push({ category: { $nin: privateCategories } });
      }
    }
    return await this.articleModel
      .find({
        $and,
      })
      // ⚠️ mongoose 8 删掉了 `count()`（它发的是 `count` 命令），一律用
      // `countDocuments()`（`$match + $group` 聚合）。同样的过滤条件计数一致，
      // 本机 explain 前后对比过：命中的索引与 examined 数不变。
      .countDocuments();
  }

  getView(view: ArticleView) {
    // ⚠️ 兜底值从 `adminView` 改成最窄的 `slimListView`（**fail-closed**）。
    // 原来这里默认 `adminView`，而 `adminView` 是**唯一 select 了 `password`** 的投影 ⇒
    // 任何没匹配上的 view 都会拿到最宽的那份（含存储态密码，靠 schema 的 toJSON transform
    // 才没出网）。今天四个 case 覆盖了 `ArticleView` 的全部成员、且所有调用方传的都是
    // 类型内的字面量，所以这条分支**不可达**；但"投影选择器的兜底是最宽投影"是个
    // 只要有人加一个 view 忘了加 case 就会静默成立的形状，而失败方向是**多下发字段**。
    // 改成最窄的公开投影后，漏 case 的失败方向变成"少下发字段"（会被调用方的测试抓到）。
    let thisView: any = this.slimListView;
    switch (view) {
      case 'admin':
        thisView = this.adminView;
        break;
      case 'list':
        thisView = this.listView;
        break;
      case 'listSlim':
        thisView = this.slimListView;
        break;
      case 'public':
        thisView = this.publicView;
    }
    return thisView;
  }

  /**
   * **全站唯一**允许把"存储态访问密码"交出去的读接口：给后台「导出 JSON 备份」用
   * （`controller/admin/backup/backup.controller.ts` 的 `GET /api/admin/backup/export`）。
   *
   * 为什么必须单独开一个口子：`ArticleSchema` 挂了 toJSON transform（密文绝不下发），
   * 而导出接口最后一步是 `JSON.stringify(data)` —— 直接丢 mongoose 文档进去，
   * `password` 会被 transform 抹掉，导出的 JSON 再导入到**另一套站点**时
   * `create()` 走"留空 = 不加密"分支，加密文章会**静默变成公开文章**。
   * 这里用 `toObject()`（transform 刻意没挂在 toObject 上）拿到原样文档，
   * 与整站备份归档"存的值原样进、原样出"的原则一致。
   *
   * ⚠️ 不要把它的返回值直接塞进任何 HTTP 响应：它带密文。
   * 导入侧是安全的 —— `hashAccessPasswordIdempotent` 认得已经是 scrypt 的值，
   * 不会把哈希再哈希一次（见 utils/accessPassword.ts）。
   */
  async getAllForExport(includeHidden = true, includeDelete?: boolean): Promise<any[]> {
    const docs = await this.getAll('admin', includeHidden, includeDelete);
    return (docs || []).map((doc: any) =>
      typeof doc?.toObject === 'function' ? doc.toObject() : { ...(doc?._doc || doc) },
    );
  }

  async getAll(
    view: ArticleView,
    includeHidden: boolean,
    includeDelete?: boolean,
  ): Promise<Article[]> {    const thisView: any = this.getView(view);
    const $and: any = [];
    if (!includeDelete) {
      $and.push({
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      });
    }
    if (!includeHidden) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5：includeHidden=false 的调用方全是公开面（RSS/sitemap/tag/category/前台列表）
      $and.push(visiblePublishFilter());
    }

    const articles = await this.articleModel
      .find(
        $and.length > 0
          ? {
              $and,
            }
          : undefined,
        thisView,
      )
      .sort({ createdAt: -1 })
      .exec();
    return articles;
  }

  async getTimeLineInfo() {
    // 肯定是不需要具体内容的，一个列表就好了
    const articles = await this.articleModel
      .find(
        {
          $and: [
            {
              $or: [
                {
                  deleted: false,
                },
                {
                  deleted: { $exists: false },
                },
              ],
            },
            {
              $or: [
                {
                  hidden: false,
                },
                {
                  hidden: { $exists: false },
                },
              ],
            },
            // P5：时间线（公开面）不含还没到点的定时文章
            visiblePublishFilter(),
          ],
        },
        this.listView,
      )
      .sort({ createdAt: -1 })
      .exec();
    // 清洗一下数据。
    const dates = Array.from(new Set(articles.map((a) => a.createdAt.getFullYear())));
    const res: Record<string, Article[]> = {};
    dates.forEach((date) => {
      res[date] = articles.filter((a) => a.createdAt.getFullYear() == date);
    });
    return res;
  }
  async getByOption(
    option: SearchArticleOption,
    isPublic: boolean,
  ): Promise<{
    // withExcerpt 时列表项会多出 excerpt/firstImage 两个现算字段（见 ArticleExcerptFields）
    articles: Array<Article & ArticleExcerptFields>;
    total: number;
    totalWordCount?: number;
  }> {
    const query: any = {};
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    const and = [];
    let sort: any = { createdAt: -1, id: -1 };
    if (isPublic) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5 定时发布：publishAt 还没到的文章对**所有公开面**不可见（与 hidden 同一个门槛，
      // 过滤器共用 utils/publishAt.ts 的 visiblePublishFilter，逐路径钉子见 publishAt spec）
      $and.push(visiblePublishFilter());
    }

    if (option.sortTop) {
      if (option.sortTop == 'asc') {
        sort = { top: 1, id: -1 };
      } else {
        sort = { top: -1, id: -1 };
      }
    }
    if (option.sortViewer) {
      if (option.sortViewer == 'asc') {
        sort = { viewer: 1, id: -1 };
      } else {
        sort = { viewer: -1, id: -1 };
      }
    }
    if (option.sortCreatedAt) {
      if (option.sortCreatedAt == 'asc') {
        sort = { createdAt: 1 };
      }
    }
    const tagsParam = asQueryString(option.tags);
    if (tagsParam) {
      const tags = tagsParam.split(',');
      const or: any = [];
      tags.forEach((t) => {
        if (option.regMatch) {
          or.push({
            tags: { $regex: safeSearchPattern(t), $options: 'i' },
          });
        } else {
          or.push({
            tags: t,
          });
        }
      });
      and.push({ $or: or });
    }
    const categoryParam = asQueryString(option.category);
    if (categoryParam) {
      if (option.regMatch) {
        and.push({
          category: { $regex: safeSearchPattern(categoryParam), $options: 'i' },
        });
      } else {
        and.push({
          category: categoryParam,
        });
      }
    }
    const titleParam = asQueryString(option.title);
    if (titleParam) {
      and.push({
        title: { $regex: safeSearchPattern(titleParam), $options: 'i' },
      });
    }
    if (option.startTime || option.endTime) {
      const obj: any = {};
      if (option.startTime) {
        obj['$gte'] = new Date(option.startTime);
      }
      if (option.endTime) {
        obj['$lte'] = new Date(option.endTime);
      }
      $and.push({ createdAt: obj });
    }

    if (and.length) {
      $and.push({ $and: and });
    }

    query.$and = $and;
    // console.log(JSON.stringify(query, null, 2));
    // console.log(JSON.stringify(sort, null, 2));
    let view: any = isPublic ? this.publicView : this.adminView;
    if (option.toListView) {
      // 管理端列表用 adminListView（= listView + password）：不是为了下发密码，
      // 而是为了在出口把它换成布尔 hasPassword（后台「修改信息」弹窗直接拿列表行当初始值，
      // 得知道"设没设过"）。公开面照旧用 listView，形状与体积一个字节都不变。
      view = isPublic ? this.listView : this.adminListView;
    }
    if (option.withWordCount || option.withExcerpt) {
      // 两个开关都需要正文才能算（字数 / 摘要），先按完整视图取，算完再在下面剥掉。
      view = isPublic ? this.publicView : this.adminView;
    }
    const paging = sanitizePagination(option.page, option.pageSize, { allowUnlimited: true });
    option.page = paging.page;
    option.pageSize = paging.pageSize;
    // 公开列表要不要在**数据库里**完成"置顶优先 + 分页"（见 orderPublicArticles 的说明）
    const wantDbPaging = isPublic && option.pageSize != UNLIMITED_PAGE_SIZE;

    let articles: any[];
    if (wantDbPaging) {
      articles = await this.findPublicPage(query, view, sort, paging.skip, option.pageSize);
    } else {
      let articlesQuery = this.articleModel.find(query, view).sort(sort);
      if (option.pageSize != UNLIMITED_PAGE_SIZE && !isPublic) {
        articlesQuery = articlesQuery.skip(paging.skip).limit(option.pageSize);
      }
      articles = await articlesQuery.exec();
      if (isPublic && option.pageSize != UNLIMITED_PAGE_SIZE) {
        // 理论上走不到这里（wantDbPaging 已经覆盖了同样的条件），留着是为了
        // findPublicPage 内部聚合失败回退时仍然有正确的语义。
        articles = orderPublicArticles(articles, paging.skip, option.pageSize);
      }
    }
    // withWordCount 只会返回当前分页的文字数量

    // mongoose 8 删掉了 Model.count()（走 `count` 命令），换成 countDocuments()
    // （`$match + $group` 聚合）；同一个 query，计数语义不变。
    const total = await this.articleModel.countDocuments(query).exec();
    // 过滤私有文章
    if (isPublic) {
      // ⚠️ 以前这里是 **N+1**：循环里对每篇文章 `await categoryModal.findOne({name})`，
      //    一页 10 篇就是 10 次额外查询，而 `pageSize=-1`（前台静态生成）是**全部文章**各查一次。
      //    分类表一共就那么几条，一次查完做成 Set 就够了（getPrivateCategoryNames 已有现成实现）。
      const privateCategories = new Set(await this.getPrivateCategoryNames());
      const tmpArticles: any[] = [];
      for (const a of articles) {
        //@ts-ignore
        const isPrivateInArticle = a?._doc?.private || a?.private;
        //@ts-ignore
        const isPrivateInCategory = privateCategories.has(a?._doc?.category || a?.category);
        const isPrivate = isPrivateInArticle || isPrivateInCategory;
        if (isPrivate) {
          tmpArticles.push({
            //@ts-ignore
            ...(a?._doc || a),
            content: undefined,
            password: undefined,
            private: true,
          });
        } else {
          tmpArticles.push({
            //@ts-ignore
            ...(a?._doc || a),
          });
        }
      }
      articles = tmpArticles;
      // P6：公开列表项带 readingMinutes（契约：toListView 列表与详情都有）。
      // content 在手上（withExcerpt/withWordCount 流程）就现算；否则用存储副本 wordCount
      // （listView 投影已带该字段）。私密文章不给：正文都藏了，阅读时长也不给。
      // ⚠️ 必须在「过滤私密文章」之后跑（顺序反了会按加密正文算时长）。
      articles = articles.map((a: any) => {
        const doc = a?._doc || a;
        if (doc?.private === true) {
          return doc;
        }
        const content = typeof doc?.content === 'string' ? doc.content : null;
        const minutes =
          content != null
            ? readingMinutesFromContent(content)
            : readingMinutesFromUnits(Number(doc?.wordCount) || 0);
        return { ...doc, readingMinutes: minutes };
      });
    }
    const resData: any = {};
    if (option.withWordCount) {
      let totalWordCount = 0;
      articles.forEach((a) => {
        totalWordCount = totalWordCount + wordCount(a?.content || '');
      });
      resData.totalWordCount = totalWordCount;
    }
    if (option.withExcerpt) {
      // 为什么在 server 出摘要：首页/分页页以前把每篇列表文章的**全文**塞进前台的
      // __NEXT_DATA__（实测首页 5 篇正文 25,053 B，卡片只渲染 3,263 B 摘要，87% 白送；
      // __NEXT_DATA__ 占首页 gzip 体积的 54.8%）。摘要语义与前台**逐字符一致**：
      // utils/articleExcerpt.ts 是 website/utils/articleExcerpt.ts 的移植，
      // 对照测试在 website/__tests__/articleExcerptParity.spec.ts。
      // ⚠️ 必须放在上面「过滤私密文章」**之后**跑：私密文章的 content 已被置空，
      //    先算摘要再过滤会把加密正文的前 200 字泄进未鉴权的公开列表。
      articles = articles.map((a: any) => {
        const doc = a?._doc || a;
        const content = typeof doc?.content === 'string' ? doc.content : '';
        if (!content) {
          return doc;
        }
        const item: any = { ...doc, excerpt: articleOverviewMarkdown(content) };
        // 卡片缩略图兜底：正文里文档顺序的第一张可用图。preferLocal 关掉才和前台
        // listCardImage 的取值规则一致（前台不按本站图床优先）；cover 存在时前台仍优先
        // cover，这个字段只在「没设 cover」时补位。
        const firstImage = pickCoverFromContent(content, { preferLocal: false });
        if (firstImage) {
          item.firstImage = firstImage;
        }
        return item;
      });
    }
    if ((option.withWordCount || option.withExcerpt) && option.toListView) {
      // 重置视图。
      // ⚠️ `password: undefined` 只在**公开面**加：管理端要把真实值留到出口的
      //    redactAccessSecretList 那里换成 hasPassword（提前抹成 undefined 会让
      //    "有没有设过密码"这个信息一起丢掉，弹窗就只能瞎猜文案了）。
      resData.articles = articles.map((a: any) => ({
        ...(a?._doc || a),
        content: undefined,
        ...(isPublic ? { password: undefined } : {}),
      }));
    } else {
      resData.articles = articles;
    }

    // 管理端出口统一脱敏（P3）：上面几条分支返回的形状**不一致** —— 有的是 mongoose
    // 文档（schema 的 toJSON transform 会脱敏），有的是 `{...doc._doc}` 展开出来的普通
    // 对象（transform 管不到，比如 withExcerpt 分支、以及 isPublic 的私密文章分支）。
    // 在出口过一遍 redactAccessSecret：文档走 toJSON、普通对象就地删键，两种形状出来
    // 都是"没有 password"；只有投影真的取了密码时才多出布尔 hasPassword。
    // ⚠️ 公开面（isPublic）不进这里：publicView/listView 压根没 select password，
    //    公开响应的形状必须与今天逐字节一致（前台 __NEXT_DATA__ 里多一个键都是白送体积）。
    if (!isPublic) {
      resData.articles = redactAccessSecretList(resData.articles);
    }

    resData.total = total;
    return resData;
  }

  /**
   * 公开列表页的取数：把"置顶优先 + 分页"整件事交给 MongoDB。
   *
   * 以前的做法是**把整个集合连正文捞回 Node**，在 JS 里分成置顶/非置顶两组、排序、拼接，
   * 最后才 `slice(skip, end)`。explain 实测：内存 SORT、examined=106、returned=53
   * （≈200KB），而调用方只要 5 条 —— 每翻一页、每次 ISR 重渲染都要重来一遍，
   * 而且成本随文章数**线性增长**（1000 篇 × 5KB 就是每次 5MB + 一次 JS 全排序）。
   *
   * 现在改成聚合管道：`$match → $addFields(isTop/topRank) → $sort → $skip → $limit → $project`，
   * 排序语义与原来**逐条对齐**（见 orderPublicArticles 与 topSortSpec 的对照测试）：
   * 置顶组永远按 top 值**降序**排在最前（原来的 JS 就是这么写的，即使调用方传了
   * sortTop=asc 也不影响置顶组内部的顺序），非置顶组按调用方给的 sort 排。
   *
   * ⚠️ 聚合失败时回退到原来的 JS 路径：这是全站最热的读路径，
   * 宁可慢一点也不能因为一个管道写法问题让整个列表 500。
   */
  private async findPublicPage(
    query: any,
    view: any,
    sort: any,
    skip: number,
    limit: number,
  ): Promise<any[]> {
    try {
      const rows = await this.articleModel
        .aggregate([
          { $match: query },
          {
            // top 可能是数字、数字字符串、''、null 或者干脆没有这个字段（老数据）。
            // "置顶"的判据要和原来 JS 的 `Boolean(top) && top != ''` 一致。
            $addFields: {
              isTop: {
                $let: {
                  vars: { t: { $ifNull: ['$top', null] } },
                  in: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$$t', null] },
                          { $ne: ['$$t', ''] },
                          { $ne: ['$$t', 0] },
                          { $ne: ['$$t', false] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          },
          {
            // 非置顶的一律给 0，这样它们在 $sort 里是常量，顺序完全由后面的 sort 键决定
            $addFields: {
              topRank: {
                $cond: [
                  { $eq: ['$isTop', 1] },
                  // ⚠️ 参数名是 `to`，不是 `targetType`：写错时 Mongo 报
                  // "$convert found an unknown argument: targetType"，而下面的 catch 会
                  // 静默回退到内存分页 —— 功能"看起来正常"，优化却根本没生效。
                  // 所以每次改这个管道，都要确认日志里**没有**"回退到内存分页"。
                  { $convert: { input: '$top', to: 'double', onError: 0, onNull: 0 } },
                  0,
                ],
              },
            },
          },
          // 聚合返回的是原始 BSON，不会应用 schema 默认值；补齐后才能和 find() 的
          // 响应形状逐字段一致（否则老文档会少一个 cover: "" 之类的字段）
          articleDefaultsStage(),
          { $sort: topSortSpec(sort) },
          { $skip: skip },
          { $limit: limit },
          { $project: view },
        ])
        .allowDiskUse(true)
        .exec();
      return rows;
    } catch (err) {
      this.logger.warn(
        `公开列表的聚合分页失败，回退到内存分页：${(err as Error)?.message || err}`,
      );
      const all = await this.articleModel.find(query, view).sort(sort).exec();
      return orderPublicArticles(all, skip, limit);
    }
  }

  async getByIdOrPathname(id: string | number, view: ArticleView) {
    const articleByPathname = await this.getByPathName(String(id), view);

    if (articleByPathname) {
      return articleByPathname;
    }
    const numericId = tryParseNumericId(id);
    if (numericId == null) {
      return null;
    }
    return await this.getById(numericId, view);
  }

  async getByPathName(pathname: string, view: ArticleView): Promise<Article> {
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    // P5：公开详情（含 URL 直达 /post/<pathname>）里，publishAt 没到的文章一律
    // 按"不存在"处理（404）；admin/list 视图不过滤 —— 后台必须能看到定时文章。
    if (view === 'public') {
      $and.push(visiblePublishFilter());
    }

    return await this.articleModel
      .findOne(
        {
          // ⚠️ 不能直接 decodeURIComponent：别名来自 URL，`%25` 这种就能让它抛 URIError，
          //    公开接口因此 500（实测过）。解不开就按字面值查，最多 404。
          pathname: safeDecodeURIComponent(pathname),
          $and,
        },
        this.getView(view),
      )
      .exec();
  }

  async getById(id: number | string, view: ArticleView): Promise<Article> {
    const numericId = parseNumericId(id);
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    // P5：同 getByPathName —— 只有 public 视图过滤未发布文章
    if (view === 'public') {
      $and.push(visiblePublishFilter());
    }

    return await this.articleModel
      .findOne(
        {
          id: numericId,
          $and,
        },
        this.getView(view),
      )
      .exec();
  }
  async getByIdWithPassword(id: number | string, password: string): Promise<any> {
    const article: any = await this.getByIdOrPathname(id, 'admin');
    if (!article) {
      return null;
    }
    // 🔴 2026-09-21 匿名枚举 oracle 修复：下面这两个分支**以前抛 404**，而"文章不存在"那一支
    //    `return null`（控制器包成 HTTP 201 + `data:null`）⇒ **404 唯一地证明了"这个数字 id 上
    //    挂着一篇还没发布/被隐藏的文章"**，未鉴权调用方可以逐个 id 试出来（活体记录见
    //    `audit-hardening-round4-security-bruteforce.spec.ts` 的 FINDING R4-5）。
    //    现在三种"看不到"的结果**逐字节同形**（都是 `return null` ⇒ 201 + `data:null`）。
    // ⚠️ 为什么选"都返回 null"而不是"都抛 404"：两者都能消除 oracle，但改状态码会动到
    //    HTTP 层的形状（第三方主题/脚本可能在 POST 这个口子），而 null 这条路**一个状态码都不变**，
    //    blast radius 为零。⚠️ 那条 `xit` 里写的 blast radius 警告（"前台按 data===null 判密码错"）
    //    **与现状不符**：`components/UnLockCard/index.tsx:28` 用的是 `if (!res)` **外加一个 catch-all**，
    //    所以 null、undefined（404 时解构 `{data}` 得到的就是 undefined）与抛错**三种都会**显示
    //    "密码错误！请重试！"⇒ 前台**无需改动**，两个方向都安全。以现实为准，按 null 方向做。
    //
    // 🔴🔴 **这两个 if 绝不能因为"三支都返回 null 了"就被当成冗余删掉。**
    //    删掉 `isFuturePublish` 这一支 ⇒ 定时文章会**继续往下走**到密码逻辑，而它若未加密
    //    （`!isPrivate`）就会 `return plain` ⇒ **未发布文章的全文在未鉴权口子上泄漏**。
    //    删掉 `hidden` 这一支同理 ⇒ 隐藏文章正文泄漏（这个 POST 口子历史上就因为没查 hidden
    //    而泄漏过，见下面保留的原注释）。它们的价值不在"返回什么"，而在"**不再往下走**"。
    //    两条都有变异对照钉住（把 if 去掉必须红）。
    //
    // P5：这条解锁接口用 admin 视图取文（要读 password/private），公开的 publishAt
    // 查询过滤帮不到它 —— 必须显式挡。与 hidden 不同：allowOpenHiddenPostByUrl
    // **不放行**定时文章（到点前 URL 直达也不能确认它的存在）。
    if (isFuturePublish(article.publishAt)) {
      return null;
    }
    // 隐藏文章必须和 GET /api/public/article/:id 一样受 allowOpenHiddenPostByUrl 约束。
    // 这个 POST 口子以前完全没检查 hidden，于是未登录也能拿到隐藏文章正文。
    if (article.hidden) {
      const siteInfo = await this.metaProvider.getSiteInfo();
      if (!siteInfo?.allowOpenHiddenPostByUrl || siteInfo?.allowOpenHiddenPostByUrl == 'false') {
        return null;
      }
    }
    if (!password) {
      return null;
    }
    const category =
      (await this.categoryModal.findOne({
        name: article.category,
      })) || ({} as any);

    const categoryPrivate = !!category.private;
    const isPrivate = !!article.private || categoryPrivate;
    const targetPassword = categoryPrivate ? category.password : article.password;
    const plain = { ...(article?._doc || article), password: undefined };
    // P6：解锁口返回全文时同样带 readingMinutes（与 GET 详情口径一致）
    if (typeof (plain as any).content === 'string' && (plain as any).content) {
      (plain as any).readingMinutes = readingMinutesFromContent((plain as any).content);
    }
    if (!isPrivate) {
      // 本来就没加密：GET 也会给全文
      return plain;
    }
    // 加密文章/加密分类：必须密码匹配才给正文。
    // 旧实现在「标记了加密但没设密码」时直接返回全文，于是任何人随便填个密码
    // 就能拿到 GET 接口特意抹掉 content 的那些文章（未鉴权的正文泄露）。
    const supplied = asQueryString(password);
    // 常量时间比较（原来的 !== 会因短路而泄露长度/前缀信息），
    // 并且同时支持历史的明文密码与将来的 scrypt 哈希
    // ⚠️ 必须用**异步**变体并 await：本方法是**匿名可达**的解锁路径，同步 scrypt 每次
    //    阻塞事件循环约 63 ms（本机实测），而解锁预算是 20 次/10 分钟/(IP×文章) ⇒
    //    单个组合的一轮预算就能独占事件循环 1.26 秒；攻击者不需要猜中密码，只要用很多
    //    (IP×文章) 组合就能把 worker 打满，连带把 `/api/public/health` 拖超时 ⇒
    //    容器判 unhealthy ⇒ `restart: always` 重启风暴，而**重启不能缓解**（攻击继续）。
    //    ⚠️ 千万别"顺手"去掉这个 await：`!Promise` 恒为 false，那等于**任何密码都能解开
    //    任何加密文章**（静默的未鉴权正文泄露）。有专门的漂移守卫盯着这一行的形状。
    if (!(await verifyAccessPasswordAsync(targetPassword, supplied))) {
      return null;
    }
    return plain;
  }
  async getByIdOrPathnameWithPreNext(id: string | number, view: ArticleView) {
    const curArticle = await this.getByIdOrPathname(id, view);
    if (!curArticle) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    if (curArticle.hidden) {
      const siteInfo = await this.metaProvider.getSiteInfo();
      if (!siteInfo?.allowOpenHiddenPostByUrl || siteInfo?.allowOpenHiddenPostByUrl == 'false') {
        // 🔴 2026-09-21 匿名枚举 oracle 修复：这里**曾经**抛一句专属文案，而"文章不存在"抛的是
        //    NOT_FOUND_MESSAGE ⇒ 匿名调用方靠文案就能区分"这里挂着一篇隐藏文章"与"没有这篇文章"，
        //    从而枚举出隐藏文章的存在（并结合 id 递增摸出站点规模）。现在两者**逐字相同**。
        // ⚠️ 定时文章在这一支之前就被查询过滤掉了（`getById`/`getByPathName` 对 `view==='public'`
        //    会加 `visiblePublishFilter()`）⇒ 落到 `!curArticle` 那一支，文案也相同 ⇒ 三种情况同形。
        // ⚠️ 后台**不受影响**：管理端读文章走 `getByIdOrPathname(id,'admin')`
        //    （`controller/admin/article/article.controller.ts:108`），那条路**从来不抛这两句**，
        //    所以"后台要能看出这篇是隐藏的"这个可用性需求本来就由另一个方法满足，无需按身份分支
        //    （也就避免了"分支判据来自请求参数、可被伪造"这个坑）。本方法的调用方只有两个：
        //    公开控制器（`view='public'`）与 ISR 的 `activeArticleById`（`view='list'`，且全仓无调用方）。
        throw new NotFoundException(NOT_FOUND_MESSAGE);
      }
    }
    if (curArticle.private) {
      curArticle.content = undefined;
    } else {
      // 检查分类是不是加密了
      const category = await this.categoryModal.findOne({
        name: curArticle.category,
      });
      if (category && category.private) {
        curArticle.private = true;
        curArticle.content = undefined;
      }
    }
    const res: any = { article: curArticle };
    // P6：公开详情 payload 加 readingMinutes 与 relatedArticles。
    // 只在 public 视图上做（admin/list 视图的输出一个字节都不变）。
    if (view === 'public') {
      const content = (curArticle as any)?.content;
      if (typeof content === 'string' && content) {
        // mongoose 文档上挂新字段进不了 toJSON，转成普通对象（公开列表路径同款做法）；
        // 私密文章 content 已被置 undefined，走不到这里 ⇒ 不给 readingMinutes
        const plainArticle: any = { ...((curArticle as any)._doc || curArticle) };
        plainArticle.readingMinutes = readingMinutesFromContent(plainArticle.content);
        res.article = plainArticle;
      }
      try {
        res.relatedArticles = await this.getRelatedArticles(curArticle as any);
      } catch (err) {
        // 相关文章是增强字段：算不出来不该把详情页带崩（前台缺字段就不渲染这一块）
        this.logger.warn(
          `相关文章计算失败（文章 ${id}）：${(err as Error)?.message || err}`,
        );
      }
    }
    // 找它的前一个和后一个。
    // P8：加密分类名单只查一次，pre/next 共用（导航里不出现加密文章，理由见 getPre 注释）
    const privateCategoryNames = await this.getPrivateCategoryNames();
    const preArticle = await this.getPreArticleByArticle(
      curArticle,
      'list',
      undefined,
      privateCategoryNames,
    );
    const nextArticle = await this.getNextArticleByArticle(
      curArticle,
      'list',
      undefined,
      privateCategoryNames,
    );
    if (preArticle) {
      res.pre = preArticle;
    }
    if (nextArticle) {
      res.next = nextArticle;
    }
    return res;
  }
  async getPreArticleByArticle(
    article: Article,
    view: ArticleView,
    includeHidden?: boolean,
    excludeCategoryNames?: string[],
  ) {
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
      { createdAt: { $lt: article.createdAt } },
    ];
    if (!includeHidden) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5：上一篇/下一篇（公开详情页脚）也不能链到还没发布的文章
      $and.push(visiblePublishFilter());
      // P8：加密文章（private 或加密分类）不再出现在公开的上一篇/下一篇里。
      // 正文一直有密码保护，但**标题和别名本身可能就是全部秘密**
      // （与 §7.40 关掉的搜索/RSS/解锁口三处泄露同一类）。选择"整体省略"而不是
      // "按解锁状态放行"：解锁状态是 per-IP 的尝试限额桶（attemptLimit），
      // 而 pre/next 会被 ISR 静态化成所有人共享的页面 —— 按单个访客的解锁状态
      // 渲染邻居在 ISR 模型下根本不成立，省略是唯一不泄密的选择。
      $and.push({ $or: [{ private: false }, { private: { $exists: false } }] });
      if (excludeCategoryNames?.length) {
        $and.push({ category: { $nin: excludeCategoryNames } });
      }
    }
    const result = await this.articleModel
      .find(
        {
          $and,
        },
        this.getView(view),
      )
      .sort({ createdAt: -1 })
      .limit(1);
    if (result.length) {
      return result[0];
    }
    return null;
  }
  async getNextArticleByArticle(
    article: Article,
    view: ArticleView,
    includeHidden?: boolean,
    excludeCategoryNames?: string[],
  ) {
    const $and: any = [
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
      { createdAt: { $gt: article.createdAt } },
    ];
    if (!includeHidden) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5：同 getPreArticleByArticle
      $and.push(visiblePublishFilter());
      // P8：同 getPreArticleByArticle（加密文章不进公开导航）
      $and.push({ $or: [{ private: false }, { private: { $exists: false } }] });
      if (excludeCategoryNames?.length) {
        $and.push({ category: { $nin: excludeCategoryNames } });
      }
    }
    const result = await this.articleModel
      .find(
        {
          $and,
        },
        this.getView(view),
      )
      .sort({ createdAt: 1 })
      .limit(1);
    if (result.length) {
      return result[0];
    }
    return null;
  }

  async findOneByTitle(title: string): Promise<Article> {
    return this.articleModel.findOne({ title }).exec();
  }

  toSearchResult(articles: Article[]) {
    return articles.map((each) => ({
      title: each.title,
      id: each.id,
      category: each.category,
      tags: each.tags,
      updatedAt: each.updatedAt,
      createdAt: each.createdAt,
    }));
  }

  /** 加密分类名列表（分类加密 = 分类下所有文章都加密）。 */
  async getPrivateCategoryNames(): Promise<string[]> {
    const categories = await this.categoryModal.find({ private: true }).exec();
    return (categories || [])
      .map((c: any) => String(c?.name))
      .filter((name) => name && name !== 'undefined');
  }

  async searchByString(str: string | unknown, includeHidden: boolean): Promise<Article[]> {
    // 用户输入必须转义：`(`/`[`/`*` 会让 Mongo 抛错变成 500，`(a+)+b` 可能灾难性回溯
    const keyword = asQueryString(str) ?? '';
    const pattern = safeSearchPattern(keyword);
    if (!pattern) {
      return [];
    }
    const $and: any = [
      {
        $or: [
          { content: { $regex: pattern, $options: 'i' } },
          { title: { $regex: pattern, $options: 'i' } },
          { category: { $regex: pattern, $options: 'i' } },
          { tags: { $regex: pattern, $options: 'i' } },
        ],
      },
      {
        $or: [
          {
            deleted: false,
          },
          {
            deleted: { $exists: false },
          },
        ],
      },
    ];
    if (!includeHidden) {
      $and.push({
        $or: [
          {
            hidden: false,
          },
          {
            hidden: { $exists: false },
          },
        ],
      });
      // P5：公开搜索搜不到还没到点的定时文章
      $and.push(visiblePublishFilter());
      // P8：公开搜索也不再返回加密文章的**标题**（正文从来没给过，但标题本身
      // 可能就是秘密；getTotalNum 的公开计数口径早就排除了它们，搜索结果与计数
      // 从此一致）。与 RSS/sitemap 的既有行为对齐。
      $and.push({ $or: [{ private: false }, { private: { $exists: false } }] });
      const privateCategoryNames = await this.getPrivateCategoryNames();
      if (privateCategoryNames.length) {
        $and.push({ category: { $nin: privateCategoryNames } });
      }
    }
    const rawData = await this.articleModel
      .find({
        $and,
      })
      // 搜索没有分页：一个单字查询能匹配全站所有文章，于是一次请求就把整个语料库
      // （连正文）拉进 Node，再做 O(n²) 去重。maxTimeMS 只挡住了慢查询，挡不住"查得快但查得多"。
      // 搜索结果超过这个数量对用户已经没有意义（前台也只显示一屏），所以直接在库里截断。
      .limit(SEARCH_MAX_RESULTS)
      .maxTimeMS(SEARCH_MAX_TIME_MS)
      .exec();
    const s = keyword.toLocaleLowerCase();
    // 字段可能缺失（老数据 / JSON 导入 / category 没有默认值），
    // 以前直接 .toLocaleLowerCase() 会抛 TypeError → 公开搜索 500，整站搜索都不可用
    const text = (value: unknown) => String(value ?? '').toLocaleLowerCase();
    const titleData = rawData.filter((each) => text(each.title).includes(s));
    const contentData = rawData.filter((each) => text(each.content).includes(s));
    const categoryData = rawData.filter((each) => text(each.category).includes(s));
    const tagData = rawData.filter((each) =>
      (Array.isArray(each.tags) ? each.tags : []).map((t) => text(t)).includes(s),
    );
    const sortedData = [...titleData, ...contentData, ...tagData, ...categoryData];
    // ⚠️ 以前是 `for (const e of sortedData) if (!resData.includes(e)) resData.push(e)`：
    // `includes` 是线性扫描，于是去重是 **O(k²)**（k = 命中数，上限 4×SEARCH_MAX_RESULTS=800
    // ⇒ 最多 32 万次对象引用比较）。Set 按引用去重、保留插入顺序，结果数组**逐项相同**，
    // 复杂度降到 O(k)。搜索是公开接口（`GET /api/public/search`），单字查询必然打满 k。
    const seen = new Set<Article>();
    const resData: Article[] = [];
    for (const e of sortedData) {
      if (seen.has(e)) {
        continue;
      }
      seen.add(e);
      resData.push(e);
    }
    return resData;
  }

  // ⚠️ 这里以前有一个 `findAll()`（`return this.articleModel.find({}).exec()`），已删除。
  // 原因：① **全仓库零调用方**（grep 见交付报告）；② 它是"无投影、整集合、连
  // password 一起捞回来"的形状 —— 访问密码哈希化之后，一个死方法还在往外递存储态密文，
  // 正是上一轮删掉 washViewerInfoByVisitProvider / washViewerInfoToVisitProvider 时
  // 要消灭的那类陷阱："以后有人不明就里接上去"。
  // 要全量读文档请用带 view 投影的 getAll(view, …)；要给整站备份导出用 getAllForExport()
  // （那是全站唯一被允许交出存储态密码的读接口，返回值绝不进 HTTP 响应）。

  async deleteById(id: number | string) {
    const numericId = parseNumericId(id);
    // deletedAt：回收站列表按"最近删除"排序（P3）。老数据没有这个字段，不回填；
    // 排序里用 updatedAt 兜底。
    const res = await this.articleModel
      .updateOne({ id: numericId }, { deleted: true, deletedAt: new Date() })
      .exec();
    this.metaProvider.updateTotalWords('删除文章');
    return res;
  }

  /**
   * 回收站列表（P3）：软删文章的投影**不含 content/password** ——
   * 列表接口贵的从来都是正文（§7.40 B-6 的教训）。wordCount 用存储副本
   * （schema 字段，P6 维护 + 启动回填），拿不到副本的老文档回落 0。
   */
  async getDeleted(page?: unknown, pageSize?: unknown): Promise<{
    articles: Array<Record<string, unknown>>;
    total: number;
  }> {
    const paging = sanitizePagination(page, pageSize, { defaultPageSize: 20 });
    const filter = { deleted: true };
    const [rows, total] = await Promise.all([
      this.articleModel
        .find(filter, this.deletedListView)
        // 最近删除的在前；没有 deletedAt 的老数据（历史软删）自然沉底，按 updatedAt 排
        .sort({ deletedAt: -1, updatedAt: -1, id: -1 })
        .skip(paging.skip)
        .limit(paging.pageSize)
        .exec(),
      this.articleModel.countDocuments(filter).exec(),
    ]);
    return { articles: rows as any, total };
  }

  /** 取一条软删文章（回收站操作用；getById 会过滤 deleted，这里反之）。 */
  async findDeletedById(id: number | string, view: ArticleView = 'admin'): Promise<Article | null> {
    const numericId = parseNumericId(id);
    return this.articleModel
      .findOne({ id: numericId, deleted: true }, this.getView(view))
      .exec();
  }

  /**
   * 恢复软删文章（P3）。返回恢复后的文章；不在回收站里（或不存在）返回 null。
   * 别名不会被抢占：`isPathnameTaken` 从来不排除软删文章（见其注释），
   * 所以恢复时 pathname 一定还是自己的。
   */
  async restoreById(id: number | string): Promise<Article | null> {
    const numericId = parseNumericId(id);
    const res = await this.articleModel
      .updateOne(
        { id: numericId, deleted: true },
        { deleted: false, deletedAt: null, updatedAt: new Date() },
      )
      .exec();
    if (!res?.matchedCount) {
      return null;
    }
    // 与 deleteById 对称：软删时重算了总字数（公开口径排除了它），恢复也要重算回来
    this.metaProvider.updateTotalWords('恢复文章');
    return this.getById(numericId, 'admin');
  }

  /**
   * 彻底删除（P3）：**只接受已在回收站里的文章**（filter 带 deleted:true），
   * 这是全站唯一的文章硬删除入口。文档移除后：
   *  - 总字数重算（与软删同一套副作用；软删文章的 content 本来就计入 metas 的
   *    历史口径里 —— countTotalWords 排除 deleted，所以 purge 本身不改总字数，
   *    但重算无害且保持"文章集合变了就刷缓存"的既有约定）；
   *  - 历史版本（revisions 集合）随文章一起清掉：文章都没了，留着正文副本
   *    只会在每次整站备份里白白占体积。
   * visits/评论等外部台账与既有软删一样**不动**（保持既有语义，不扩大破坏面）。
   */
  async purgeById(id: number | string): Promise<{ purged: boolean; id: number }> {
    const numericId = parseNumericId(id);
    const res = await this.articleModel.deleteOne({ id: numericId, deleted: true }).exec();
    const purged = (res?.deletedCount || 0) > 0;
    if (purged) {
      this.metaProvider.updateTotalWords('彻底删除文章');
      if (this.revisionProvider) {
        try {
          const removed = await this.revisionProvider.deleteForArticle(numericId);
          if (removed > 0) {
            this.logger.log(`彻底删除文章 ${numericId}：连带清理 ${removed} 条历史版本`);
          }
        } catch (err) {
          // 版本清理失败不该把 purge 判为失败（文档已经删了），但必须留痕
          this.logger.warn(
            `彻底删除文章 ${numericId} 后清理历史版本失败：${(err as Error)?.message || err}`,
          );
        }
      }
    }
    return { purged, id: numericId };
  }

  async updateCategoryName(oldName: string, newName: string) {
    if (!oldName || !newName || oldName === newName) {
      return { modifiedCount: 0 };
    }
    return this.articleModel.updateMany({ category: oldName }, { category: newName });
  }

  async updateById(
    id: number | string,
    updateArticleDto: UpdateArticleDto,
    skipUpdateWordCount?: boolean,
    opts?: { skipRevision?: boolean },
  ) {
    const numericId = parseNumericId(id);
    const patch: UpdateArticleDto = { ...updateArticleDto };
    // 访问密码（P1）：留空/缺键 = **不修改**（表单已经不再回填密文，见 utils/accessPassword.ts），
    // 要解除加密必须显式 `clearPassword: true`；填了新值就存 scrypt 哈希。
    // ⚠️ 异步变体 + await（同步 scrypt 每次阻塞事件循环约 63 ms；漏 await 会静默丢密码，
    //    因为 `passwordWrite.password` 会变成 undefined ⇒ 落到"不修改"分支）。
    const passwordWrite = await resolveAccessPasswordWriteAsync(updateArticleDto, 'update');
    delete (patch as any).clearPassword;
    if (passwordWrite.password === undefined) {
      delete patch.password;
    } else {
      patch.password = passwordWrite.password;
    }
    if (patch.pathname !== undefined) {
      // 别名只在显式传入时才校验/改写：标题变化不会重新生成 slug，
      // 否则已经分享出去的 /post/<pathname> 会全部失效。
      const nextPathname = normalizePathname(patch.pathname);
      assertUsablePathname(nextPathname);
      if (await this.isPathnameTaken(nextPathname, numericId)) {
        throw new BadRequestException(`路径别名 "${nextPathname}" 已被其它文章占用`);
      }
      patch.pathname = nextPathname;
    }
    // P5：显式给了 publishAt 才归一化/校验；键不存在 = 保持原值（管理端清空定时发 null）
    if (patch.publishAt !== undefined) {
      (patch as any).publishAt = normalizePublishAt(patch.publishAt);
    }
    // P6：正文变了就同步字数副本（只随 content 变；改标题/标签不会触发重算）
    if (typeof patch.content === 'string') {
      (patch as any).wordCount = wordCount(patch.content);
    }
    // 文章历史版本（P4）：旧状态被这次保存替换之前先拍快照。
    //  - 只在 patch 真的带了 title/content 时才多读一次旧文档（比较后**变了才写**）；
    //  - appendSafe 永不抛错：快照写失败只 WARN，绝不能把保存本身带崩；
    //  - `opts.skipRevision`：恢复历史版本的流程自己记 'pre-restore' 快照，跳过这里的自动快照。
    const touchesContent =
      typeof patch.title === 'string' || typeof patch.content === 'string';
    if (!opts?.skipRevision && touchesContent && this.revisionProvider?.enabled()) {
      const before = await this.articleModel
        .findOne({ id: numericId }, { title: 1, content: 1 })
        .exec();
      if (before) {
        await this.revisionProvider.appendSafe(numericId, before as any, patch);
      }
    }
    // 顺手升级（P2）：这次保存**没碰密码**，但库里存的还是历史明文，就趁这次写一起换成
    // scrypt 哈希 —— 一台从不重启的站点也能收敛，不必等启动 wash。
    // 已经是哈希的（needsPasswordUpgrade=false）一个字节都不动，所以**幂等**：不会二次哈希。
    // ⚠️ 整段包 try/catch：这只是"顺便做的好事"，读失败（DB 抖动 / 投影不支持）绝不能
    //    把保存本身带崩；漏掉的文档由启动 wash 兜底。
    if (passwordWrite.password === undefined) {
      try {
        const stored: any = await this.articleModel
          .findOne({ id: numericId }, { password: 1 })
          .exec();
        if (stored && needsPasswordUpgrade(stored.password)) {
          patch.password = await hashAccessPasswordIdempotentAsync(stored.password);
          this.logger.log(
            `文章 ${numericId} 的历史明文访问密码已在本次保存时升级为 scrypt 哈希`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `读取文章 ${numericId} 的存量访问密码失败，跳过本次顺手升级：${
            (err as Error)?.message || err
          }`,
        );
      }
    }
    const res = await this.articleModel.updateOne(
      { id: numericId },
      {
        ...patch,
        updatedAt: patch.updatedAt || new Date(),
      },
    );
    if (!skipUpdateWordCount) {
      this.metaProvider.updateTotalWords('更新文章');
    }
    return res;
  }

  /**
   * 批量把「正文首图」写进 cover 字段。
   *
   * 默认只补 cover 为空的文章（`onlyMissing`），默认先 `dryRun` 让后台预览。
   * 返回的 items 带 `previousCover`，配合 revertCovers() 可以**精确撤销**这一次改动
   * （把旧值原样写回，而不是简单地清空 —— 万一某篇本来就有封面，清空等于破坏数据）。
   */
  async backfillCoversFromContent(option?: {
    dryRun?: boolean;
    onlyMissing?: boolean;
    ids?: number[];
  }): Promise<{
    scanned: number;
    matched: number;
    changed: number;
    skippedNoImage: number;
    skippedHasCover: number;
    dryRun: boolean;
    items: Array<{ id: number; title: string; cover: string; previousCover: string }>;
  }> {
    return this.withLedger(
      'backfill:articleCovers',
      'backfill',
      () => this.doBackfillCoversFromContent(option),
      (r) => ({
        dryRun: r.dryRun,
        scanned: r.scanned,
        matched: r.matched,
        changed: r.changed,
        skippedNoImage: r.skippedNoImage,
        skippedHasCover: r.skippedHasCover,
      }),
    );
  }

  private async doBackfillCoversFromContent(option?: {
    dryRun?: boolean;
    onlyMissing?: boolean;
    ids?: number[];
  }): Promise<{
    scanned: number;
    matched: number;
    changed: number;
    skippedNoImage: number;
    skippedHasCover: number;
    dryRun: boolean;
    items: Array<{ id: number; title: string; cover: string; previousCover: string }>;
  }> {
    const dryRun = option?.dryRun === true;
    const onlyMissing = option?.onlyMissing !== false;
    const filter: any = { deleted: false };
    const ids = Array.isArray(option?.ids)
      ? option.ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0)
      : [];
    if (ids.length) {
      filter.id = { $in: ids.slice(0, 500) };
    }

    const articles = await this.articleModel
      .find(filter, { id: 1, title: 1, cover: 1, content: 1 })
      .exec();

    const result = {
      scanned: articles.length,
      matched: 0,
      changed: 0,
      skippedNoImage: 0,
      skippedHasCover: 0,
      dryRun,
      items: [] as Array<{ id: number; title: string; cover: string; previousCover: string }>,
    };

    for (const article of articles as any[]) {
      const previousCover = String(article?.cover ?? '').trim();
      if (previousCover && onlyMissing) {
        result.skippedHasCover += 1;
        continue;
      }
      const cover = pickCoverFromContent(article?.content);
      if (!cover) {
        result.skippedNoImage += 1;
        continue;
      }
      if (cover === previousCover) {
        result.skippedHasCover += 1;
        continue;
      }
      result.matched += 1;
      if (result.items.length < 200) {
        result.items.push({
          id: Number(article.id),
          title: String(article?.title ?? '').slice(0, 120),
          cover,
          previousCover,
        });
      }
      if (!dryRun) {
        await this.articleModel
          .updateOne({ id: article.id }, { cover, updatedAt: new Date() })
          .exec();
        result.changed += 1;
      }
    }

    if (!dryRun && result.changed) {
      this.logger.log(`从正文首图回填封面：扫描 ${result.scanned} 篇，写入 ${result.changed} 篇`);
    }
    return result;
  }

  /**
   * 撤销一次回填：把 cover 写回调用方给的旧值。
   * 只认「id + 期望的当前值」都匹配的记录，避免把用户后来手动改过的封面又覆盖掉。
   */
  async revertCovers(
    items: Array<{ id: number; cover: string }>,
  ): Promise<{ reverted: number; skipped: number }> {
    const list = Array.isArray(items) ? items.slice(0, 500) : [];
    let reverted = 0;
    let skipped = 0;
    for (const item of list) {
      const id = Number(item?.id);
      if (!Number.isFinite(id)) {
        skipped += 1;
        continue;
      }
      const previous = typeof item?.cover === 'string' ? item.cover : '';
      const res = await this.articleModel
        .updateOne(
          { id, cover: { $ne: previous } },
          { cover: previous, updatedAt: new Date() },
        )
        .exec();
      if (res?.modifiedCount) {
        reverted += 1;
      } else {
        skipped += 1;
      }
    }
    return { reverted, skipped };
  }

  /**
   * 给老文档回填 wordCount 副本（P6）。启动时由 main.ts 触发（主实例、fire-and-forget），
   * 自己往迁移台账记 `backfill:articleWordCount` 一条。
   *
   * 幂等：只找「wordCount 字段还不存在」的文档 —— 新文档 create/update 都会算好写入
   * （schema 也有 default 0），跑过一遍之后每次启动这条查询命中 0 行，
   * 成本是一次无索引的集合扫描（不在请求路径上）。
   * **含软删文档**：回收站列表也要显示 wordCount。
   * ⚠️ 不碰 updatedAt：回填不是内容编辑，不该把文章顶到"最近更新"前面去。
   */
  async backfillWordCounts(): Promise<{ scanned: number; updated: number }> {
    return this.withLedger(
      'backfill:articleWordCount',
      'backfill',
      () => this.doBackfillWordCounts(),
      (r) => r,
    );
  }

  private async doBackfillWordCounts(): Promise<{ scanned: number; updated: number }> {
    const docs = await this.articleModel
      .find({ wordCount: { $exists: false } }, { id: 1, content: 1 })
      .exec();
    let updated = 0;
    for (const doc of docs as any[]) {
      await this.articleModel
        .updateOne({ id: doc?.id }, { wordCount: wordCount(doc?.content || '') })
        .exec();
      updated += 1;
    }
    if (updated > 0) {
      this.logger.log(`回填文章字数副本：扫描 ${docs.length} 篇，写入 ${updated} 篇`);
    }
    return { scanned: docs.length, updated };
  }

  /**
   * 启动清洗（P2）：把**历史明文**的文章 / 分类访问密码洗成 scrypt 哈希。
   *
   * 为什么需要它：写入路径（create / updateById / importX / 分类更新）从今往后只会存
   * 哈希，但库里已有的文档、以及从**旧整站备份**恢复进来的文档（`utils/fullBackup.ts`
   * 用原生 driver 原样写回，绕过所有 provider）都还是明文。校验端
   * `verifyAccessPassword` 两种格式都认，所以迁移**不是**"不洗就打不开"的硬门槛，
   * 而是一次把窗口关掉的收尾。
   *
   * 性质：
   * - **幂等**：只动"非空且不是 scrypt 格式"的值；第二次跑 washed=0（有测试钉子）。
   * - **有界**：一次查完（投影只取 `_id`+`password`），返回 scanned/washed 计数，
   *   由 main.ts 的 `wash('wash:accessPasswords', …)` 记进 `migrations` 台账。
   * - **可中断**：逐条 `updateOne`，洗到一半挂了也只是"一部分还是明文"，
   *   那部分照样能解锁，下次启动接着洗。
   * - **不阻塞事件循环**：scrypt 是同步的（N=16384,r=8 ⇒ 16MB，单次几十毫秒），
   *   每条之间 `await sleep(0)` 让出一次；启动这会儿正好是 ISR 全量渲染的时候，
   *   连续几百次同步 scrypt 会把整个进程钉死。
   *
   * ⚠️ 这个方法**自己往台账记账**：main.ts 那边已经用 `wash()` 包了一层
   * （与 `wash:userSalt` 同一个形状），再包一次就记重了。
   */
  async washAccessPasswords(): Promise<{
    scanned: number;
    washed: number;
    alreadyHashed: number;
    articles: number;
    categories: number;
    durationMs: number;
  }> {
    const started = Date.now();
    const articles = await this.washAccessPasswordsIn(this.articleModel as any, '文章');
    const categories = await this.washAccessPasswordsIn(this.categoryModal as any, '分类');
    const result = {
      scanned: articles.scanned + categories.scanned,
      washed: articles.washed + categories.washed,
      alreadyHashed: articles.alreadyHashed + categories.alreadyHashed,
      articles: articles.washed,
      categories: categories.washed,
      durationMs: Date.now() - started,
    };
    if (result.washed > 0) {
      this.logger.log(
        `访问密码明文清洗完成：文章 ${articles.washed} 篇、分类 ${categories.washed} 条` +
          `（扫描 ${result.scanned} 条，已是哈希 ${result.alreadyHashed} 条，耗时 ${result.durationMs}ms）`,
      );
    }
    return result;
  }

  private async washAccessPasswordsIn(
    model: Model<any>,
    label: string,
  ): Promise<{ scanned: number; washed: number; alreadyHashed: number }> {
    // 过滤条件刻意宽松（只排掉"没有 / 空 / null"），非字符串这种畸形值也捞出来在 JS 里
    // 判一遍：漏掉一条就等于库里永远留着一份明文。
    const docs: any[] = await model
      .find({ password: { $exists: true, $nin: ['', null] } }, { password: 1 })
      .exec();
    let washed = 0;
    let alreadyHashed = 0;
    for (const doc of docs) {
      const stored = doc?.password;
      if (stored === undefined || stored === null || stored === '') {
        continue;
      }
      const text = String(stored);
      if (isScryptHash(text)) {
        alreadyHashed += 1;
        continue;
      }
      // 用 _id 定位：文章/分类的业务主键（id / name）都可能是导入时改过的，_id 一定唯一
      // ⚠️ 异步哈希：wash 是批量循环，同步版会让启动阶段连续阻塞（每篇约 63 ms）
      await model
        .updateOne({ _id: doc._id }, { password: await hashAccessPasswordIdempotentAsync(text) })
        .exec();
      washed += 1;
      if (washed % 25 === 0) {
        this.logger.log(`清洗${label}访问密码：已处理 ${washed} 条`);
      }
      await sleep(0);
    }
    return { scanned: docs.length, washed, alreadyHashed };
  }

  /**
   * 相关文章（P6）：**一次查询**取候选（共享 tag 或同 category，投影不含 content），
   * JS 里按「共享标签数 → 同分类 → 更新时间」排。跑在 ISR 缓存页的取数里，
   * 不是每请求热路径，但候选有上限（RELATED_CANDIDATE_LIMIT），不会随文章数线性恶化。
   *
   * 过滤口径与公开列表一致：排除自身、软删、隐藏、**未到点的定时文章**（visiblePublishFilter）。
   * 私密文章不排除（标题/封面本来就出现在公开列表里），但绝不带正文。
   */
  async getRelatedArticles(
    article: { id?: number; tags?: string[]; category?: string } | null | undefined,
    limit: number = RELATED_MAX,
    now: Date = new Date(),
  ): Promise<RelatedArticleItem[]> {
    const numericId = Number(article?.id);
    if (!Number.isFinite(numericId)) {
      return [];
    }
    const tags = Array.isArray(article?.tags)
      ? article.tags.filter((t): t is string => typeof t === 'string' && t !== '').slice(0, 50)
      : [];
    const category = typeof article?.category === 'string' ? article.category : '';
    const or: any[] = [];
    if (tags.length) {
      or.push({ tags: { $in: tags } });
    }
    if (category) {
      or.push({ category });
    }
    if (!or.length) {
      return [];
    }
    // P8：相关推荐是公开导航面 —— 加密文章（含加密分类）整体排除，口径与 pre/next 一致
    const privateCategoryNames = await this.getPrivateCategoryNames();
    const and: any[] = [
      { $or: [{ deleted: false }, { deleted: { $exists: false } }] },
      { $or: [{ hidden: false }, { hidden: { $exists: false } }] },
      { $or: [{ private: false }, { private: { $exists: false } }] },
      visiblePublishFilter(now),
      { id: { $ne: numericId } },
      { $or: or },
    ];
    if (privateCategoryNames.length) {
      and.push({ category: { $nin: privateCategoryNames } });
    }
    const query: any = { $and: and };
    const candidates = await this.articleModel
      .find(query, {
        id: 1,
        title: 1,
        pathname: 1,
        cover: 1,
        updatedAt: 1,
        tags: 1,
        category: 1,
        wordCount: 1,
        _id: 0, // ⚠️ 投影里没有 content（任务硬要求），也没有 password
      })
      .sort({ updatedAt: -1 })
      .limit(RELATED_CANDIDATE_LIMIT)
      .exec();
    const tagSet = new Set(tags);
    const scored = (candidates as any[]).map((c) => {
      const doc: any = c?._doc || c;
      const sharedTags = (Array.isArray(doc?.tags) ? doc.tags : []).filter((t: any) =>
        tagSet.has(t),
      ).length;
      const sameCategory = category && doc?.category === category ? 1 : 0;
      return { doc, score: sharedTags * 100 + sameCategory * 10 };
    });
    // candidates 已按 updatedAt 倒序，V8 的 sort 稳定 ⇒ 同分时新的在前（recency 兜底）
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit)).map(({ doc }) => ({
      // 契约里的 `_id`：本站文章的对外标识一直是数字 id（schema 的 id 字段），
      // 这里给它的字符串形式，并同时带数字 id（与全仓库其它 payload 一致）
      _id: String(doc?.id),
      id: Number(doc?.id),
      title: String(doc?.title ?? ''),
      pathname: String(doc?.pathname ?? ''),
      cover: String(doc?.cover ?? ''),
      updatedAt: (doc?.updatedAt as Date) ?? null,
      readingMinutes: readingMinutesFromUnits(Number(doc?.wordCount) || 0),
    }));
  }

  async getNewId() {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    try {
    const maxObj = await this.articleModel.find({}).sort({ id: -1 }).limit(1);
    let res = 1;
    if (maxObj.length) {
      res = maxObj[0].id + 1;
    }
      return res;
    } finally {
      // 一次查询失败就会让 idLock 永远为 true，之后所有新建请求都在 while 里空转，
      // 只能重启进程才能恢复 —— 所以必须放在 finally 里释放
      this.idLock = false;
    }
  }
}
