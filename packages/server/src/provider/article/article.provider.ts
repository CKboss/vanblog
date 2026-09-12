import {
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreateArticleDto, SearchArticleOption, UpdateArticleDto } from 'src/types/article.dto';
import { Article, ArticleDocument } from 'src/scheme/article.schema';
import { parseImgLinksOfMarkdown } from 'src/utils/parseImgOfMarkdown';
import { wordCount } from 'src/utils/wordCount';
import { parseNumericId, tryParseNumericId } from 'src/utils/numericId';
import { sanitizePagination, UNLIMITED_PAGE_SIZE } from 'src/utils/pagination';
import { slugCandidates, titleToSlug } from 'src/utils/slug';
import { assertUsablePathname, normalizePathname } from 'src/utils/articlePathname';
import {
  prepareRewriteBases,
  rewriteBaseUrlInDocuments,
  RewriteBaseUrlCount,
} from 'src/utils/rewriteBaseUrl';
import { MetaProvider } from '../meta/meta.provider';
import { VisitProvider } from '../visit/visit.provider';
import { sleep } from 'src/utils/sleep';
import { CategoryDocument } from 'src/scheme/category.schema';
import { escapeRegExp } from 'src/utils/regex';

export type ArticleView = 'admin' | 'public' | 'list';

@Injectable()
export class ArticleProvider {
  idLock = false;
  constructor(
    @InjectModel('Article')
    private articleModel: Model<ArticleDocument>,
    @InjectModel('Category') private categoryModal: Model<CategoryDocument>,
    @Inject(forwardRef(() => MetaProvider))
    private readonly metaProvider: MetaProvider,
    private readonly visitProvider: VisitProvider,
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
    const createdData = new this.articleModel(createArticleDto);
    const newId = id || (await this.getNewId());
    createdData.id = newId;
    createdData.pathname = await this.resolvePathnameForCreate(createArticleDto, newId);
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
   */
  async backfillPathname(options?: { dryRun?: boolean }): Promise<{
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
        content: { $regex: link, $options: 'i' },
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
    const pattern = cleaned.map(escapeRegExp).join('|');
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
        await this.articleModel.updateOne({ id }, { content, updatedAt: new Date() });
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
    const oldViewer = article.viewer || 0;
    const oldVIsited = article.visited || 0;
    const newViewer = oldViewer + 1;
    const newVisited = isNew ? oldVIsited + 1 : oldVIsited;
    const nowTime = new Date();
    await this.articleModel.updateOne(
      { id: article.id },
      { visited: newVisited, viewer: newViewer, lastVisitedTime: nowTime },
    );
  }

  async updateViewer(id: number, isNew: boolean) {
    const article = await this.getById(id, 'list');
    if (!article) {
      return;
    }
    const oldViewer = article.viewer || 0;
    const oldVIsited = article.visited || 0;
    const newViewer = oldViewer + 1;
    const newVisited = isNew ? oldVIsited + 1 : oldVIsited;
    const nowTime = new Date();
    await this.articleModel.updateOne(
      { id: id },
      { visited: newVisited, viewer: newViewer, lastVisitedTime: nowTime },
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

  async washViewerInfoByVisitProvider() {
    // 用 visitProvider 里面的数据洗一下 article 的。
    const articles = await this.getAll('list', true);
    for (const a of articles) {
      const visitData = await this.visitProvider.getByArticleId(a.id);
      if (visitData) {
        const updateDto = {
          viewer: visitData.viewer,
          visited: visitData.visited,
        };
        await this.updateById(a.id, updateDto);
      }
    }
  }

  async washViewerInfoToVisitProvider() {
    // 用 visitProvider 里面的数据洗一下 article 的。
    const articles = await this.getAll('list', true);
    for (const a of articles) {
      await this.visitProvider.rewriteToday(`/post/${a.id}`, a.viewer, a.visited);
    }
  }

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
        this.updateById(
          oldArticle.id,
          {
            ...createDto,
            deleted: false,
            updatedAt: oldArticle.updatedAt || oldArticle.createdAt,
          },
          true,
        );
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
    ];
    const articles = await this.articleModel
      .find({
        $and,
      })
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
    }
    return await this.articleModel
      .find({
        $and,
      })
      .count();
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
  ): Promise<{ articles: Article[]; total: number; totalWordCount?: number }> {
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
    let sort: any = { createdAt: -1 };
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
    }

    if (option.sortTop) {
      if (option.sortTop == 'asc') {
        sort = { top: 1 };
      } else {
        sort = { top: -1 };
      }
    }
    if (option.sortViewer) {
      if (option.sortViewer == 'asc') {
        sort = { viewer: 1 };
      } else {
        sort = { viewer: -1 };
      }
    }
    if (option.sortCreatedAt) {
      if (option.sortCreatedAt == 'asc') {
        sort = { createdAt: 1 };
      }
    }
    if (option.tags) {
      const tags = option.tags.split(',');
      const or: any = [];
      tags.forEach((t) => {
        if (option.regMatch) {
          or.push({
            tags: { $regex: `${t}`, $options: 'i' },
          });
        } else {
          or.push({
            tags: t,
          });
        }
      });
      and.push({ $or: or });
    }
    if (option.category) {
      if (option.regMatch) {
        and.push({
          category: { $regex: `${option.category}`, $options: 'i' },
        });
      } else {
        and.push({
          category: option.category,
        });
      }
    }
    if (option.title) {
      and.push({
        title: { $regex: `${option.title}`, $options: 'i' },
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
    if (option.withWordCount) {
      view = isPublic ? this.publicView : this.adminView;
    }
    const paging = sanitizePagination(option.page, option.pageSize, { allowUnlimited: true });
    option.page = paging.page;
    option.pageSize = paging.pageSize;
    let articlesQuery = this.articleModel.find(query, view).sort(sort);
    if (option.pageSize != UNLIMITED_PAGE_SIZE && !isPublic) {
      articlesQuery = articlesQuery.skip(paging.skip).limit(option.pageSize);
    }

    let articles = await articlesQuery.exec();
    // public 下 包括所有的，
    if (isPublic && option.pageSize != UNLIMITED_PAGE_SIZE) {
      // 把 top 的诺到前面去
      const topArticles = articles.filter((a: any) => {
        const top = a?._doc?.top || a?.top;
        return Boolean(top) && top != '';
      });
      const notTopArticles = articles.filter((a: any) => {
        const top = a?._doc?.top || a?.top;
        return !Boolean(top) || top == '';
      });
      const sortedTopArticles = topArticles.sort((a: any, b: any) => {
        const topA = a?._doc?.top || a?.top;
        const topB = b?._doc?.top || b?.top;
        if (topA > topB) {
          return -1;
        } else if (topB > topA) {
          return 1;
        } else {
          return 0;
        }
      });
      articles = [...sortedTopArticles, ...notTopArticles];
      const skip = paging.skip;
      const rawEnd = skip + option.pageSize;
      const end = rawEnd > articles.length - 1 ? articles.length : rawEnd;
      articles = articles.slice(skip, end);
    }
    // withWordCount 只会返回当前分页的文字数量

    const total = await this.articleModel.count(query).exec();
    // 过滤私有文章
    if (isPublic) {
      const tmpArticles: any[] = [];
      for (const a of articles) {
        //@ts-ignore
        const isPrivateInArticle = a?._doc?.private || a?.private;
        const category = await this.categoryModal.findOne({
          //@ts-ignore
          name: a?._doc?.category || a?.category,
        });
        const isPrivateInCategory = category?.private || false;
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
    }
    const resData: any = {};
    if (option.withWordCount) {
      let totalWordCount = 0;
      articles.forEach((a) => {
        totalWordCount = totalWordCount + wordCount(a?.content || '');
      });
      resData.totalWordCount = totalWordCount;
    }
    if (option.withWordCount && option.toListView) {
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

    return await this.articleModel
      .findOne(
        {
          pathname: decodeURIComponent(pathname),
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
    if (!password) {
      return null;
    }
    if (!article) {
      return null;
    }
    const category =
      (await this.categoryModal.findOne({
        name: article.category,
      })) || ({} as any);

    const categoryPassword = category.private ? category.password : undefined;
    const targetPassword = categoryPassword ? categoryPassword : article.password;
    if (!targetPassword || targetPassword == '') {
      return { ...(article?._doc || article), password: undefined };
    } else {
      if (targetPassword == password) {
        return { ...(article?._doc || article), password: undefined };
      } else {
        return null;
      }
    }
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
    // 找它的前一个和后一个。
    const preArticle = await this.getPreArticleByArticle(curArticle, 'list');
    const nextArticle = await this.getNextArticleByArticle(curArticle, 'list');
    if (preArticle) {
      res.pre = preArticle;
    }
    if (nextArticle) {
      res.next = nextArticle;
    }
    return res;
  }
  async getPreArticleByArticle(article: Article, view: ArticleView, includeHidden?: boolean) {
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
  async getNextArticleByArticle(article: Article, view: ArticleView, includeHidden?: boolean) {
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

  async searchByString(str: string, includeHidden: boolean): Promise<Article[]> {
    const $and: any = [
      {
        $or: [
          { content: { $regex: `${str}`, $options: 'i' } },
          { title: { $regex: `${str}`, $options: 'i' } },
          { category: { $regex: `${str}`, $options: 'i' } },
          { tags: { $regex: `${str}`, $options: 'i' } },
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
    }
    const rawData = await this.articleModel
      .find({
        $and,
      })
      .exec();
    const s = str.toLocaleLowerCase();
    const titleData = rawData.filter((each) => each.title.toLocaleLowerCase().includes(s));
    const contentData = rawData.filter((each) => each.content.toLocaleLowerCase().includes(s));
    const categoryData = rawData.filter((each) => each.category.toLocaleLowerCase().includes(s));
    const tagData = rawData.filter((each) =>
      each.tags.map((t) => t.toLocaleLowerCase()).includes(s),
    );
    const sortedData = [...titleData, ...contentData, ...tagData, ...categoryData];
    const resData = [];
    for (const e of sortedData) {
      if (!resData.includes(e)) {
        resData.push(e);
      }
    }
    return resData;
  }

  async findAll(): Promise<Article[]> {
    return this.articleModel.find({}).exec();
  }
  async deleteById(id: number | string) {
    const numericId = parseNumericId(id);
    const res = await this.articleModel.updateOne({ id: numericId }, { deleted: true }).exec();
    this.metaProvider.updateTotalWords('删除文章');
    return res;
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

  async getNewId() {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    const maxObj = await this.articleModel.find({}).sort({ id: -1 }).limit(1);
    let res = 1;
    if (maxObj.length) {
      res = maxObj[0].id + 1;
    }
    this.idLock = false;
    return res;
  }
}
