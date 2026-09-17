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
import { verifyAccessPassword } from 'src/utils/crypto';
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

export type ArticleView = 'admin' | 'public' | 'list';

/** 相关文章（P6）：一次查询最多取多少候选（JS 里再排序取前 RELATED_MAX） */
export const RELATED_CANDIDATE_LIMIT = 50;
/** 相关文章最多返回几条（任务契约：max 5） */
export const RELATED_MAX = 5;

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
    const createdData = new this.articleModel(createArticleDto);
    const newId = id || (await this.getNewId());
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

  async getAllImageLinks() {
    const res = [];
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
    for (const article of articles) {
      const eachLinks = parseImgLinksOfMarkdown(article.content || '');
      res.push({
        articleId: article.id,
        title: article.title,
        links: eachLinks,
      });
    }
    return res;
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
    let thisView: any = this.adminView;
    switch (view) {
      case 'admin':
        thisView = this.adminView;
        break;
      case 'list':
        thisView = this.listView;
        break;
      case 'public':
        thisView = this.publicView;
    }
    return thisView;
  }

  async getAll(
    view: ArticleView,
    includeHidden: boolean,
    includeDelete?: boolean,
  ): Promise<Article[]> {
    const thisView: any = this.getView(view);
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
      view = this.listView;
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
      // 重置视图
      resData.articles = articles.map((a: any) => ({
        ...(a?._doc || a),
        content: undefined,
        password: undefined,
      }));
    } else {
      resData.articles = articles;
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
    // P5：这条解锁接口用 admin 视图取文（要读 password/private），公开的 publishAt
    // 查询过滤帮不到它 —— 必须显式挡。与 hidden 不同：allowOpenHiddenPostByUrl
    // **不放行**定时文章（到点前 URL 直达也不能确认它的存在，按 404 处理）。
    if (isFuturePublish(article.publishAt)) {
      throw new NotFoundException('找不到文章');
    }
    // 隐藏文章必须和 GET /api/public/article/:id 一样受 allowOpenHiddenPostByUrl 约束。
    // 这个 POST 口子以前完全没检查 hidden，于是未登录也能拿到隐藏文章正文。
    if (article.hidden) {
      const siteInfo = await this.metaProvider.getSiteInfo();
      if (!siteInfo?.allowOpenHiddenPostByUrl || siteInfo?.allowOpenHiddenPostByUrl == 'false') {
        throw new NotFoundException('该文章是隐藏文章！');
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
    if (!verifyAccessPassword(targetPassword, supplied)) {
      return null;
    }
    return plain;
  }
  async getByIdOrPathnameWithPreNext(id: string | number, view: ArticleView) {
    const curArticle = await this.getByIdOrPathname(id, view);
    if (!curArticle) {
      throw new NotFoundException('找不到文章');
    }

    if (curArticle.hidden) {
      const siteInfo = await this.metaProvider.getSiteInfo();
      if (!siteInfo?.allowOpenHiddenPostByUrl || siteInfo?.allowOpenHiddenPostByUrl == 'false') {
        throw new NotFoundException('该文章是隐藏文章！');
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

  async findAll(): Promise<Article[]> {
    return this.articleModel.find({}).exec();
  }
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
