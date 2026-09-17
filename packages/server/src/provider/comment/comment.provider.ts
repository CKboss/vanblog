import { BadRequestException, ForbiddenException, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import cluster from 'node:cluster';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CommentDocument, CommentStatus, NativeComment } from 'src/scheme/comment.schema';
import {
  AdminCommentOption,
  CreateCommentDto,
  PublicComment,
  QueryCommentOption,
  UpdateCommentDto,
} from 'src/types/comment.dto';
import { CommentSetting } from 'src/types/setting.dto';
import { SettingProvider } from '../setting/setting.provider';
import { MigrationProvider } from '../migration/migration.provider';
import { Article, ArticleDocument } from 'src/scheme/article.schema';
import { Meta, MetaDocument } from 'src/scheme/meta.schema';
import { config } from 'src/config';
import { consumeAttempt } from 'src/utils/attemptLimit';
import { isPrimaryInstance, scaleLimit } from 'src/utils/clusterRole';
import { pickSocketIp } from '../log/utils';
import { bruteForceClientIp } from '../../utils/trustedProxy';
import { sleep } from 'src/utils/sleep';
import { asQueryString } from 'src/utils/sanitizeRequest';

/** 只用于去重键，不是安全用途 */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

const RATE_WINDOW_MS = 10 * 60 * 1000;
/** 每篇顶层评论最多带多少条回复（超出的走「查看更多回复」） */
const MAX_CHILDREN_PER_ROOT = 100;

/**
 * 公开评论列表的复合索引（第四轮审计 B8）：listByPath 的三条查询全部按
 * `(path, rootId, status)` 等值前缀过滤、按 `(createdAt, id)` 排序 ——
 * 以前 comments 上只有四个单列索引（path / rootId / status / createdAt 各一个），
 * planner 只能选一个单列索引再把排序做在内存里，匿名 GET 每次都要付一遍。
 * 键序就是查询形状：等值列在前（path, rootId, status），排序列在后（createdAt, id）。
 * ⚠️ `id` 必须进索引（审计原文只点到 createdAt 为止）：两条列表查询的排序都是
 * `{createdAt, id}` 双键 —— 少了 id，planner 仍然要做内存 SORT，而且为了取到排序键
 * 得把**全部**匹配文档 FETCH 一遍（真库实测：20,000 条回复的 children 查询
 * examined 停在 20,000；带上 id 之后 SORT 在索引键上完成 top-k，FETCH 只剩 limit 那 100 条）。
 * 根评论那条查询（rootId=0 全等值）则直接按索引序出结果，SORT 阶段整个消失，
 * skip/limit 变成纯索引行走 —— page 上限 500 的最深 skip 也因此有界。
 * 建索引走启动期的幂等 createIndex（沿用 statsMaintenance 的约定），并记进迁移台账。
 */
export const COMMENT_LIST_INDEX_KEYS: Record<string, number> = {
  path: 1,
  rootId: 1,
  status: 1,
  createdAt: 1,
  id: 1,
};
export const COMMENT_LIST_INDEX_NAME = 'path_1_rootId_1_status_1_createdAt_1_id_1';
/** 迁移台账的 key（一个 key 一行，见 provider/migration/migration.provider.ts） */
export const COMMENT_LIST_INDEX_LEDGER_KEY = 'index:comments.path_rootId_status_createdAt_id';

function sameIndexKeySpec(a: Record<string, unknown> | undefined): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(COMMENT_LIST_INDEX_KEYS);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (Number(a[ka[i]]) !== Number(COMMENT_LIST_INDEX_KEYS[kb[i]])) return false;
  }
  return true;
}

@Injectable()
export class CommentProvider implements OnApplicationBootstrap {
  logger = new Logger(CommentProvider.name);
  private idLock = false;
  private indexDone = false;

  constructor(
    @InjectModel(NativeComment.name) private readonly commentModel: Model<CommentDocument>,
    // 直接注入 model 而不是 ArticleProvider / MetaProvider：
    // Article ↔ Meta 之间本来就有互相引用，再从这里引一条边会让 Nest 报
    // 「A circular dependency has been detected inside AppModule」，整个进程起不来。
    @InjectModel(Article.name) private readonly articleModel: Model<ArticleDocument>,
    @InjectModel(Meta.name) private readonly metaModel: Model<MetaDocument>,
    private readonly settingProvider: SettingProvider,
    /** 迁移台账（可选注入：单测直接 `new` 时不传；record 永不抛错）。 */
    @Optional() private readonly migration?: MigrationProvider,
  ) {}

  /**
   * 启动时建一次公开列表要用的复合索引（见 COMMENT_LIST_INDEX_KEYS 上的说明）。
   * 故意**不 await**（Nest 会等 onApplicationBootstrap 返回才继续 listen），
   * 也不在请求路径上；多进程时只让主实例做（沿用 statsMaintenance 的约定）。
   */
  onApplicationBootstrap() {
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    void this.ensureListIndex('启动').catch((err) => {
      this.logger.error(`评论复合索引维护失败（不影响服务）：${(err as Error)?.message || err}`);
    });
  }

  /**
   * 幂等地保证 `(path, rootId, status, createdAt)` 复合索引存在，并把结果记进迁移台账。
   * ⚠️ 台账只做可观测性，绝不用来跳过维护（与 statsMaintenance 同一条约定）：
   * 已经存在时只花一次 listIndexes；不存在时 createIndex（同键同名重跑是 no-op）。
   */
  async ensureListIndex(reason: string): Promise<{ created: boolean; exists: boolean; error?: string }> {
    if (this.indexDone) {
      return { created: false, exists: true };
    }
    this.indexDone = true;
    const started = Date.now();
    try {
      let exists = false;
      try {
        const indexes = await this.commentModel.collection.indexes();
        exists = indexes.some(
          (i: any) => sameIndexKeySpec(i?.key) || i?.name === COMMENT_LIST_INDEX_NAME,
        );
      } catch {
        // 全新站点集合还不存在（NamespaceNotFound）：按"没有索引"处理，直接建
        exists = false;
      }
      if (exists) {
        await this.migration?.recordSkipped(
          { key: COMMENT_LIST_INDEX_LEDGER_KEY, kind: 'index' },
          `复合索引已存在（${COMMENT_LIST_INDEX_NAME}），无需重建`,
        );
        return { created: false, exists: true };
      }
      await this.commentModel.collection.createIndex(COMMENT_LIST_INDEX_KEYS, {
        name: COMMENT_LIST_INDEX_NAME,
        background: true,
      });
      await this.migration?.record({
        key: COMMENT_LIST_INDEX_LEDGER_KEY,
        kind: 'index',
        outcome: 'ok',
        durationMs: Date.now() - started,
        detail: { reason, name: COMMENT_LIST_INDEX_NAME, keys: COMMENT_LIST_INDEX_KEYS },
      });
      this.logger.log(`[${reason}] comments 复合索引 ${COMMENT_LIST_INDEX_NAME} 已创建`);
      return { created: true, exists: false };
    } catch (err) {
      const message = String((err as Error)?.message || err).slice(0, 300);
      this.indexDone = false; // 失败了允许下一次启动/调用重试
      await this.migration?.record({
        key: COMMENT_LIST_INDEX_LEDGER_KEY,
        kind: 'index',
        outcome: 'error',
        durationMs: Date.now() - started,
        detail: `${reason}：${message}`,
      });
      this.logger.error(`comments 建复合索引 ${COMMENT_LIST_INDEX_NAME} 失败：${message}`);
      return { created: false, exists: false, error: message };
    }
  }

  async getNewId(): Promise<number> {
    while (this.idLock) {
      await sleep(10);
    }
    this.idLock = true;
    try {
      const [last] = await this.commentModel.find({}).sort({ id: -1 }).limit(1);
      return last ? last.id + 1 : 1;
    } finally {
      this.idLock = false;
    }
  }

  /** 前台可见的字段：不给 ip / ua / email / reason */
  toPublic(doc: any): PublicComment {
    const raw = doc?._doc || doc || {};
    return {
      id: raw.id,
      path: raw.path,
      rootId: raw.rootId || 0,
      parentId: raw.parentId || 0,
      replyToNick: raw.replyToNick || undefined,
      nick: raw.nick,
      site: raw.site || undefined,
      content: raw.content,
      status: raw.status,
      isAuthor: !!raw.isAuthor,
      createdAt: raw.createdAt instanceof Date ? raw.createdAt.toISOString() : String(raw.createdAt || ''),
    };
  }

  /**
   * 发表（或回复）一条评论。
   *
   * 审核策略见 CommentSetting.moderation：
   * - post：默认直接显示，命中规则转待审
   * - pre ：一律待审
   * - none：一律直接显示
   * 蜜罐字段被填 → 直接判垃圾（任何策略下都不显示）。博主本人（邮箱与 authorEmail 一致）永远直通。
   */
  async create(
    dto: CreateCommentDto,
    req: any,
  ): Promise<{ comment: PublicComment; pending: boolean; reason?: string }> {
    if (config.demo && config.demo == 'true') {
      throw new ForbiddenException('演示站禁止发表评论');
    }
    const setting = await this.getSetting();
    if (setting.provider !== 'builtin') {
      throw new ForbiddenException('当前评论系统不是内置评论，无法通过该接口发表');
    }

    const path = this.assertPath(dto?.path);
    const article = await this.resolveArticle(path);
    if (article.hidden) {
      // 隐藏文章不开放评论：否则等于给「靠 URL 才能访问」的文章留了一个可枚举的入口
      throw new ForbiddenException('该文章未开放评论');
    }
    const nick = this.assertNick(dto?.nick);
    const email = this.assertEmail(dto?.email, setting.requireEmail);
    const site = this.assertSite(dto?.site);
    const content = this.assertContent(dto?.content, setting.maxContentLength);

    // ⚠️ 三道限流必须跑在**任何写库之前**，蜜罐分支也不例外（第四轮审计 B2/R4-6）：
    // 以前蜜罐命中会在限流之前就 insert({status:'spam'}) 并 return，于是机器人
    // 只要带上 hp 字段就绕开了全部三把桶 —— 唯一的剩余上限是中间件那个
    // 30 次/分钟的公开写桶（≈43,200 条 spam 文档/天/IP，每条最大 20,000 字符时
    // 一天能灌进 ~2.6 GB，还顺带撑大后台评论列表每次都要跑的全表 countByStatus）。
    // 现在机器人也消耗它自己那把桶；蜜罐命中只改判定（status:'spam'），不改配额。
    // 真人用户行为一个字节都不变（他们从来不填 hp）。
    const ip = bruteForceClientIp(req);
    const limit = consumeAttempt(`comment-${ip}`, {
      // 计数器是每进程一份：多进程时按 worker 数摊薄，全局阈值才等于设置值
      max: scaleLimit(Math.max(1, setting.rateLimitPer10Min)),
      windowMs: RATE_WINDOW_MS,
    });
    if (!limit.allowed) {
      throw new BadRequestException(
        `评论太频繁了，请 ${limit.retryAfterSeconds} 秒后再试`,
      );
    }
    // 每 IP 每天最多 50 条：防止长时间低频灌库
    const daily = consumeAttempt(`comment-day-${ip}`, {
      max: scaleLimit(50),
      windowMs: 24 * 60 * 60 * 1000,
    });
    if (!daily.allowed) {
      throw new BadRequestException('今天评论太多了，请明天再来');
    }
    // 同 IP + 同内容 5 分钟内只允许一条：挡住复制粘贴式刷屏
    const dedupeKey = `comment-dup-${ip}-${simpleHash(content)}`;
    const dup = consumeAttempt(dedupeKey, { max: 1, windowMs: 5 * 60 * 1000 });
    if (!dup.allowed) {
      throw new BadRequestException('刚才已经发过一样的评论了');
    }

    // 蜜罐：真人看不见这个输入框，填了就说明是脚本。
    // （走到这里说明配额已经扣过了 —— 蜜罐只决定这条评论的 status。）
    if (typeof dto?.hp === 'string' && dto.hp.trim() !== '') {
      const spam = await this.insert({
        path,
        nick,
        email,
        site,
        content,
        status: 'spam',
        reason: '蜜罐字段被填写',
        req,
        parentId: 0,
        rootId: 0,
        replyToNick: '',
        isAuthor: false,
        articleId: article.id,
      });
      // 对机器人也返回「待审」，不要暴露判定逻辑
      return { comment: this.toPublic(spam), pending: true, reason: undefined };
    }

    const isAuthor = await this.isAuthorEmail(email);
    const parent = await this.resolveParent(dto?.parentId, path);
    const verdict = this.judge({ content, setting, isAuthor });

    const created = await this.insert({
      path,
      nick,
      email,
      site,
      content,
      status: verdict.status,
      reason: verdict.reason,
      req,
      parentId: parent ? parent.id : 0,
      rootId: parent ? parent.rootId || parent.id : 0,
      replyToNick: parent ? parent.nick : '',
      isAuthor,
      articleId: article.id,
    });

    return {
      comment: this.toPublic(created),
      pending: verdict.status !== 'approved',
      reason: verdict.reason,
    };
  }

  private judge({
    content,
    setting,
    isAuthor,
  }: {
    content: string;
    setting: CommentSetting;
    isAuthor: boolean;
  }): { status: CommentStatus; reason?: string } {
    if (isAuthor) {
      return { status: 'approved' };
    }
    if (setting.moderation === 'none') {
      return { status: 'approved' };
    }
    if (setting.moderation === 'pre') {
      return { status: 'pending', reason: '站点设置为先审后发' };
    }
    const lowered = content.toLowerCase();
    const hit = (setting.keywords || []).find((k) => lowered.includes(k.toLowerCase()));
    if (hit) {
      return { status: 'pending', reason: `命中待审关键词：${hit}` };
    }
    if (setting.pendingOnLink && /(https?:\/\/|(^|[^/\w.])www\.)/i.test(content)) {
      return { status: 'pending', reason: '内容包含外链' };
    }
    return { status: 'approved' };
  }

  private async insert(data: {
    path: string;
    nick: string;
    email: string;
    site: string;
    content: string;
    status: CommentStatus;
    reason?: string;
    req: any;
    parentId: number;
    rootId: number;
    replyToNick: string;
    isAuthor: boolean;
    articleId: number;
  }): Promise<CommentDocument> {
    const id = await this.getNewId();
    return await this.commentModel.create({
      id,
      path: data.path,
      articleId: data.articleId,
      rootId: data.rootId,
      parentId: data.parentId,
      replyToNick: data.replyToNick,
      nick: data.nick,
      email: data.email,
      site: data.site,
      content: data.content,
      status: data.status,
      reason: data.reason || '',
      isAuthor: data.isAuthor,
      // ⚠️ 存库的 IP 也要用同一个来源：以前存套接字地址，反代后面**所有评论的 IP 都是 127.0.0.1**，
      // 后台那一列与任何按 IP 的审核都失效
      ip: bruteForceClientIp(data.req),
      ua: String(data.req?.headers?.['user-agent'] || '').slice(0, 300),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  /** 两层结构：回复挂到所属顶层评论；回复「回复」也归到同一个顶层 */
  private async resolveParent(parentId: unknown, path: string) {
    const id = Number(parentId);
    if (!id || !Number.isFinite(id)) {
      return null;
    }
    const parent = await this.commentModel.findOne({ id }).exec();
    if (!parent) {
      throw new BadRequestException('要回复的评论不存在');
    }
    if (parent.status === 'deleted' || parent.status === 'spam') {
      throw new BadRequestException('要回复的评论已不可回复');
    }
    if (parent.path !== path) {
      throw new BadRequestException('不能跨文章回复');
    }
    return parent;
  }

  private async isAuthorEmail(email: string): Promise<boolean> {
    if (!email) {
      return false;
    }
    try {
      const meta: any = await this.metaModel.findOne({}).exec();
      const authorEmail = String(meta?.siteInfo?.authorEmail || '').trim().toLowerCase();
      return !!authorEmail && authorEmail === email.trim().toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * 校验 path 对应的文章**真实存在且可见**，并取回它的数字 id。
   * 不做这一步的话，机器人可以往任意编造的路径灌评论，把 comments 表撑爆
   * （而且这些垃圾永远不会被前台展示，只能靠人工清）。
   */
  private async resolveArticle(path: string): Promise<{ id: number; hidden: boolean }> {
    let key = path.replace(/^\/post\//, '');
    try {
      key = decodeURIComponent(key);
    } catch {
      // 坏的百分号转义：直接按原样查，查不到就是「文章不存在」
    }
    const numeric = Number(key);
    const filter: any = Number.isFinite(numeric) && String(numeric) === key.trim()
      ? { $or: [{ id: numeric }, { pathname: key }] }
      : { pathname: key };
    const article: any = await this.articleModel.findOne({ ...filter, deleted: false }).exec();
    if (!article) {
      throw new BadRequestException('评论所属的文章不存在');
    }
    return { id: Number(article.id) || 0, hidden: !!article.hidden };
  }

  async getSetting(): Promise<CommentSetting> {
    return await this.settingProvider.getCommentSetting();
  }

  // ---------- 校验 ----------

  private assertPath(raw: unknown): string {
    const path = String(raw ?? '').trim();
    if (!path || path.length > 300 || !path.startsWith('/') || path.includes('..')) {
      throw new BadRequestException('评论所属的文章路径不合法');
    }
    return path;
  }

  private assertNick(raw: unknown): string {
    // eslint-disable-next-line no-control-regex
    const nick = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim();
    if (!nick || nick.length > 30) {
      throw new BadRequestException('昵称必填，且不超过 30 个字符');
    }
    return nick;
  }

  private assertEmail(raw: unknown, required: boolean): string {
    const email = String(raw ?? '').trim();
    if (!email) {
      if (required) {
        throw new BadRequestException('本站要求填写邮箱（不会公开显示）');
      }
      return '';
    }
    if (email.length > 100 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    return email;
  }

  private assertSite(raw: unknown): string {
    const site = String(raw ?? '').trim();
    if (!site) {
      return '';
    }
    if (site.length > 200) {
      throw new BadRequestException('个人主页地址过长');
    }
    // 显式挡掉任何非 http/https 的 scheme（javascript: / data: / vbscript: / blob: …）。
    // 不能只靠 new URL() 失败来拦：`javascript:alert(1)` 前面被拼上 https:// 之后确实解析不了，
    // 但那是「碰巧」，换个写法就可能漏过去，而且报错也说不清原因。
    if (/^[a-z][a-z0-9+.-]*:/i.test(site) && !/^https?:\/\//i.test(site)) {
      throw new BadRequestException('个人主页地址只支持 http/https');
    }
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    } catch {
      throw new BadRequestException('个人主页地址不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // javascript: 之类的一律拒绝，否则评论区会变成 XSS 跳板
      throw new BadRequestException('个人主页地址只支持 http/https');
    }
    return parsed.toString().slice(0, 200);
  }

  private assertContent(raw: unknown, maxLength: number): string {
    const content = String(raw ?? '');
    const trimmed = content.trim();
    if (!trimmed) {
      throw new BadRequestException('评论内容不能为空');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
      throw new BadRequestException('评论内容包含非法字符');
    }
    // 双向控制符（U+202A~U+202E、U+2066~U+2069）能把显示顺序反过来，
    // 用来伪装昵称或链接（经典的 RLO 欺骗），直接删掉
    // eslint-disable-next-line no-misleading-character-class
    const withoutBidi = trimmed.replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
    if (withoutBidi.length > Math.max(1, maxLength)) {
      throw new BadRequestException(`评论内容不能超过 ${maxLength} 个字符`);
    }
    return withoutBidi.slice(0, 20000);
  }

  // ---------- 查询 ----------

  /**
   * 一篇文章对外有**两个**访问路径：`/post/<数字id>` 和 `/post/<拼音别名>`（两个都返回 200）。
   * 评论是按 path 存的，历史评论（尤其从 waline 导入的）可能记在其中任意一个下面，
   * 前台又可能用另一个来查 —— 所以查询前先把同一篇文章的所有等价路径展开，
   * 否则就会出现「库里明明有评论，页面上却一条都不显示」。
   * 写入永远用调用方传来的那一个（前台传的是数字 id 这种不会变的规范键）。
   */
  private async expandPostPaths(paths: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const postKeys = paths
      .filter((p) => p.startsWith('/post/'))
      .map((p) => decodeURIComponent(p.slice('/post/'.length)));
    const nums = Array.from(
      new Set(postKeys.filter((k) => /^\d+$/.test(k)).map((k) => Number(k))),
    );
    const slugs = Array.from(new Set(postKeys.filter((k) => !/^\d+$/.test(k))));
    let articles: any[] = [];
    if (nums.length || slugs.length) {
      const or: any[] = [];
      if (nums.length) {
        or.push({ id: { $in: nums } });
      }
      if (slugs.length) {
        or.push({ pathname: { $in: slugs } });
      }
      // 不过滤 deleted：文章删了评论也不该凭空消失（后台还能看到）
      // 投影只取真正会被读的两个字段（第四轮审计 R4-13）：这个查询在匿名热路径上
      // （GET /api/public/comments/counts 一次最多 50 篇 + 每次 GET /api/public/comments/），
      // 以前把 ≤50 篇文章的**全文**捞回来只为读 id 与 pathname。
      // 实测（一次性 mongod、312 篇 × ~20KB 语料、50 个 key、中位数 7 轮）：19.7ms → 1.4ms（14×）。
      articles = await this.articleModel
        .find({ $or: or }, { id: 1, pathname: 1, _id: 0 })
        .exec();
    }
    for (const path of paths) {
      const set = new Set<string>([path]);
      if (path.startsWith('/post/')) {
        let key = path.slice('/post/'.length);
        try {
          key = decodeURIComponent(key);
        } catch {
          // 坏的转义就按原样比
        }
        const article = articles.find(
          (a) => String(a?.id) === key || (a?.pathname && String(a.pathname) === key),
        );
        if (article) {
          set.add(`/post/${article.id}`);
          if (article.pathname) {
            set.add(`/post/${encodeURIComponent(String(article.pathname))}`);
            set.add(`/post/${article.pathname}`);
          }
        }
      }
      out.set(path, Array.from(set));
    }
    return out;
  }

  /** 文章页的评论列表：顶层分页，每条带上它的回复 */
  async listByPath(option: QueryCommentOption): Promise<{
    total: number;
    page: number;
    pageSize: number;
    data: PublicComment[];
  }> {
    const path = this.assertPath(option?.path);
    const page = Math.max(1, Number(option?.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(option?.pageSize) || 20));
    const sort = option?.sort === 'desc' ? -1 : 1;

    const variants = (await this.expandPostPaths([path])).get(path) || [path];
    const pathFilter = variants.length > 1 ? { $in: variants } : path;
    const total = await this.commentModel.countDocuments({
      path: pathFilter,
      rootId: 0,
      status: 'approved',
    });
    const roots = await this.commentModel
      .find({ path: pathFilter, rootId: 0, status: 'approved' })
      .sort({ createdAt: sort, id: sort })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .exec();
    if (!roots.length) {
      return { total, page, pageSize, data: [] };
    }
    const rootIds = roots.map((r) => r.id);
    // ⚠️ 必须带 .limit()（第四轮审计 B8）：以前这个 find 没有上限，只有**响应**被切到
    // 每条根评论 100 条。一个有几万条已通过回复的根评论（moderation=post 会自动放行
    // 无外链文本，B2 修复前蜜罐还能放大它）会让每次第一页 GET 都变成大抓取 + 内存分组。
    // 上限取 MAX_CHILDREN_PER_ROOT × 本页根评论数 = 响应里最多可能出现的条数：
    // 排序是全局 (createdAt, id)，所以当某条根评论的回复多到吃满整个窗口时，
    // 同页靠后的根评论可能显示不满 100 条 —— 这是有意的取舍：`replyCount` 仍然精确
    // （来自 countReplies 聚合），前台按「查看更多回复」处理，而公开 GET 的抓取量
    // 从此有硬上限（50 × 100 = 5000 条文档）。
    const children = await this.commentModel
      .find({ path: pathFilter, rootId: { $in: rootIds }, status: 'approved' })
      .sort({ createdAt: 1, id: 1 })
      .limit(MAX_CHILDREN_PER_ROOT * roots.length)
      .exec();
    const byRoot = new Map<number, CommentDocument[]>();
    for (const child of children) {
      const list = byRoot.get(child.rootId) || [];
      list.push(child);
      byRoot.set(child.rootId, list);
    }
    const replyCounts = await this.countReplies(rootIds);
    const data = roots.map((root) => {
      const item = this.toPublic(root);
      const kids = byRoot.get(root.id) || [];
      item.children = kids.slice(0, MAX_CHILDREN_PER_ROOT).map((k) => this.toPublic(k));
      item.replyCount = replyCounts.get(root.id) || kids.length;
      return item;
    });
    return { total, page, pageSize, data };
  }

  private async countReplies(rootIds: number[]): Promise<Map<number, number>> {
    const rows = await this.commentModel
      .aggregate([
        { $match: { rootId: { $in: rootIds }, status: 'approved' } },
        { $group: { _id: '$rootId', count: { $sum: 1 } } },
      ])
      .exec();
    const map = new Map<number, number>();
    for (const row of rows as any[]) {
      map.set(Number(row?._id), Number(row?.count) || 0);
    }
    return map;
  }

  /** 列表页要显示的评论数（批量，避免每篇一次查询） */
  async countByPaths(paths: string[]): Promise<Record<string, number>> {
    const cleaned = Array.from(
      new Set((paths || []).map((p) => String(p || '')).filter((p) => p.startsWith('/') && p.length <= 300)),
    ).slice(0, 50);
    if (!cleaned.length) {
      return {};
    }
    const expanded = await this.expandPostPaths(cleaned);
    const all = Array.from(new Set([...expanded.values()].flat()));
    const rows = await this.commentModel
      .aggregate([
        { $match: { path: { $in: all }, status: 'approved' } },
        { $group: { _id: '$path', count: { $sum: 1 } } },
      ])
      .exec();
    const countOf = new Map<string, number>();
    for (const row of rows as any[]) {
      countOf.set(String(row?._id), Number(row?.count) || 0);
    }
    const out: Record<string, number> = {};
    for (const p of cleaned) {
      // 同一篇文章的两个路径加起来才是它真正的评论数
      out[p] = (expanded.get(p) || [p]).reduce((sum, variant) => sum + (countOf.get(variant) || 0), 0);
    }
    return out;
  }

  async countByPath(path: string): Promise<number> {
    const res = await this.countByPaths([path]);
    return res[path] || 0;
  }

  // ---------- 后台 ----------

  async listForAdmin(option: AdminCommentOption) {
    const page = Math.max(1, Number(option?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(option?.pageSize) || 20));
    const filter: any = {};
    // status / path 都要显式收敛成字符串再进过滤器：查询参数可能是对象
    // （`?status[$ne]=x`），全局净化中间件会剥掉 $ 键，但这里再收一道更保险
    const status = asQueryString(option?.status);
    if (status && status !== 'all') {
      filter.status = ['pending', 'approved', 'spam', 'deleted'].includes(status)
        ? status
        : 'approved';
    } else {
      filter.status = { $ne: 'deleted' };
    }
    const path = (asQueryString(option?.path) || '').trim();
    if (path) {
      filter.path = path.slice(0, 300);
    }
    const keyword = String(option?.keyword || '').trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100);
      const re = new RegExp(escaped, 'i');
      filter.$or = [{ content: re }, { nick: re }, { email: re }];
    }
    const [total, rows, counts] = await Promise.all([
      this.commentModel.countDocuments(filter),
      this.commentModel
        .find(filter)
        .sort({ createdAt: -1, id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.countByStatus(),
    ]);
    return {
      total,
      page,
      pageSize,
      counts,
      data: rows.map((r: any) => {
        const raw = r?._doc || r;
        return {
          id: raw.id,
          path: raw.path,
          articleId: raw.articleId || 0,
          rootId: raw.rootId || 0,
          parentId: raw.parentId || 0,
          replyToNick: raw.replyToNick || '',
          nick: raw.nick,
          email: raw.email || '',
          site: raw.site || '',
          content: raw.content,
          status: raw.status,
          reason: raw.reason || '',
          isAuthor: !!raw.isAuthor,
          ip: raw.ip || '',
          ua: raw.ua || '',
          createdAt: raw.createdAt,
        };
      }),
    };
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.commentModel
      .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .exec();
    const out: Record<string, number> = { pending: 0, approved: 0, spam: 0, deleted: 0 };
    for (const row of rows as any[]) {
      out[String(row?._id)] = Number(row?.count) || 0;
    }
    return out;
  }

  async updateById(id: number, dto: UpdateCommentDto) {
    const found = await this.commentModel.findOne({ id: Number(id) }).exec();
    if (!found) {
      throw new BadRequestException('评论不存在');
    }
    const update: any = { updatedAt: new Date() };
    if (dto?.status && ['pending', 'approved', 'spam', 'deleted'].includes(dto.status)) {
      update.status = dto.status;
    }
    if (typeof dto?.content === 'string' && dto.content.trim()) {
      update.content = this.assertContent(dto.content, 20000);
    }
    if (typeof dto?.nick === 'string' && dto.nick.trim()) {
      update.nick = this.assertNick(dto.nick);
    }
    if (typeof dto?.isAuthor === 'boolean') {
      update.isAuthor = dto.isAuthor;
    }
    await this.commentModel.updateOne({ id: found.id }, update).exec();
    return await this.commentModel.findOne({ id: found.id }).exec();
  }

  /** 删除顶层评论会连带删掉它下面的回复（都是软删，便于反悔） */
  async deleteById(id: number): Promise<{ deleted: number }> {
    const found = await this.commentModel.findOne({ id: Number(id) }).exec();
    if (!found) {
      throw new BadRequestException('评论不存在');
    }
    const ids = found.rootId ? [found.id] : [found.id];
    if (!found.rootId) {
      const children = await this.commentModel.find({ rootId: found.id }).exec();
      children.forEach((c) => ids.push(c.id));
    }
    const res = await this.commentModel
      .updateMany({ id: { $in: ids } }, { status: 'deleted', updatedAt: new Date() })
      .exec();
    return { deleted: res?.modifiedCount || ids.length };
  }

  // ---------- 导入 / 导出 ----------

  /**
   * 从 Waline 导出的 JSON 导入评论。
   *
   * 接受三种形状（都是从真实导出文件里见到的）：
   * 1. VanBlog 的 waline 备份：`{ type:'waline', tables:[...], data:{ Comment:[...] } }`
   * 2. `{ Comment: [...] }`
   * 3. 直接一个数组 `[...]`
   *
   * 设计要点：
   * - **默认只导入 `status === 'approved'`**（正式显示的评论）；待审/垃圾要一起导就显式传
   *   `includeNonApproved: true`，它们会按 waline 的状态映射成 pending/spam，不会混进公开列表。
   * - **幂等**：按 `sourceId`（waline 的 objectId）去重，重复导入同一份文件不会翻倍。
   * - 保留原始时间（`insertedAt` → `createdAt`），否则导入后所有评论都变成"刚刚"，
   *   列表顺序和文章页的时间线全乱。
   * - 两层结构：waline 的 `rid` 是根评论 objectId、`pid` 是直接父评论 objectId，
   *   先建顶层拿到本站数字 id，再做 objectId → id 的映射建回复。
   * - 每行都走与本站发表**同一套校验**（路径、昵称、邮箱、主页、内容、控制字符/双向控制符），
   *   导入不是绕过安全的后门。
   */
  async importFromWaline(
    payload: unknown,
    options?: { includeNonApproved?: boolean; dryRun?: boolean },
  ): Promise<{
    total: number;
    imported: number;
    skippedNotApproved: number;
    skippedDuplicate: number;
    skippedInvalid: number;
    dryRun: boolean;
    errors: string[];
  }> {
    const rows = extractWalineComments(payload);
    const includeNonApproved = !!options?.includeNonApproved;
    const dryRun = !!options?.dryRun;
    const result = {
      total: rows.length,
      imported: 0,
      skippedNotApproved: 0,
      skippedDuplicate: 0,
      skippedInvalid: 0,
      dryRun,
      errors: [] as string[],
    };
    if (!rows.length) {
      return result;
    }

    const existing = await this.commentModel
      .find({ sourceId: { $in: rows.map((r) => String(r?.objectId || '')).filter(Boolean) } })
      .exec();
    const seen = new Set(existing.map((c: any) => String(c.sourceId)));

    const statusOf = (raw: unknown): CommentStatus => {
      const value = String(raw ?? '').toLowerCase();
      if (value === 'approved') return 'approved';
      if (value === 'spam') return 'spam';
      return 'pending'; // waline 的 waiting 以及任何未知值都当待审，绝不默认放行
    };

    // 过滤 + 校验，分成顶层与回复两批
    type Prepared = {
      row: any;
      path: string;
      nick: string;
      email: string;
      site: string;
      content: string;
      status: CommentStatus;
      createdAt: Date;
      sourceId: string;
      isReply: boolean;
      rid: string;
      pid: string;
    };
    const prepared: Prepared[] = [];
    for (const row of rows) {
      const sourceId = String(row?.objectId || '');
      const status = statusOf(row?.status);
      if (status !== 'approved' && !includeNonApproved) {
        result.skippedNotApproved += 1;
        continue;
      }
      if (sourceId && seen.has(sourceId)) {
        result.skippedDuplicate += 1;
        continue;
      }
      try {
        const path = this.assertPath(row?.url);
        const nick = this.assertNick(row?.nick || '匿名');
        // 历史数据里邮箱格式不合法很常见（老版本 waline 不校验）。
        // 不能因为邮箱坏了就把整条评论丢掉 —— 邮箱只在后台可见，清空即可。
        let email = '';
        try {
          email = this.assertEmail(row?.mail, false);
        } catch {
          email = '';
          if (result.errors.length < 20) {
            result.errors.push(`${sourceId || '(无 objectId)'}：邮箱格式不合法，已清空后导入`);
          }
        }
        // 主页地址同理：坏了就丢掉地址，不留评论
        let site = '';
        try {
          site = this.assertSite(row?.link);
        } catch {
          site = '';
        }
        // data: URI 的图片（老 waline 里直接把截图塞成 base64）在评论里既不放行也不该存：
        // 一条就几十 KB，还会被原样发给每个访客。前台渲染器本来就会把图片折叠成 alt，
        // 所以导入时直接折叠，内容长度也就回到正常范围了。
        const content = this.assertContent(stripDataUriImages(String(row?.comment ?? '')), 20000);
        const createdAt = toValidDate(row?.insertedAt) || new Date();
        prepared.push({
          row,
          path,
          nick,
          email,
          site,
          content,
          status,
          createdAt,
          sourceId,
          isReply: !!(row?.rid || row?.pid),
          rid: String(row?.rid || ''),
          pid: String(row?.pid || ''),
        });
        if (sourceId) {
          seen.add(sourceId);
        }
      } catch (err) {
        result.skippedInvalid += 1;
        if (result.errors.length < 20) {
          result.errors.push(
            `${sourceId || '(无 objectId)'}：${(err as Error)?.message || err}`.slice(0, 200),
          );
        }
      }
    }

    if (dryRun) {
      result.imported = prepared.length;
      return result;
    }

    // 先建顶层，建立 objectId → 本站数字 id 的映射
    const idByObjectId = new Map<string, number>();
    const roots = prepared.filter((p) => !p.isReply);
    const replies = prepared.filter((p) => p.isReply);
    for (const item of roots) {
      const doc = await this.insertImported(item, 0, 0, '');
      if (item.sourceId) {
        idByObjectId.set(item.sourceId, doc.id);
      }
      result.imported += 1;
    }
    for (const item of replies) {
      const rootKey = item.rid || item.pid;
      const parentKey = item.pid || item.rid;
      const rootId = idByObjectId.get(rootKey) || 0;
      const parentId = idByObjectId.get(parentKey) || rootId;
      const parent = parentId
        ? await this.commentModel.findOne({ id: parentId }).exec()
        : null;
      const doc = await this.insertImported(item, rootId, parentId, parent?.nick || '');
      if (item.sourceId) {
        idByObjectId.set(item.sourceId, doc.id);
      }
      result.imported += 1;
    }
    this.logger.log(
      `从 Waline 导入评论完成：共 ${result.total} 条，导入 ${result.imported}，` +
        `跳过非正式 ${result.skippedNotApproved}，跳过重复 ${result.skippedDuplicate}，` +
        `非法 ${result.skippedInvalid}`,
    );
    return result;
  }

  private async insertImported(
    item: {
      row: any;
      path: string;
      nick: string;
      email: string;
      site: string;
      content: string;
      status: CommentStatus;
      createdAt: Date;
      sourceId: string;
    },
    rootId: number,
    parentId: number,
    replyToNick: string,
  ) {
    const id = await this.getNewId();
    const row = item.row || {};
    return await this.commentModel.create({
      id,
      path: item.path,
      articleId: 0,
      rootId,
      parentId,
      replyToNick,
      nick: item.nick,
      email: item.email,
      site: item.site,
      content: item.content,
      status: item.status,
      reason: item.status === 'approved' ? '' : '从 Waline 导入',
      isAuthor: false,
      ip: String(row.ip || '').slice(0, 64),
      ua: String(row.ua || '').slice(0, 300),
      source: 'waline',
      sourceId: item.sourceId,
      likeCount: Number(row.like) > 0 ? Number(row.like) : 0,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    });
  }

  /**
   * 导出评论。**默认只导出正式显示的（approved）** —— 待审 / 垃圾 / 已删除默认不导出，
   * 需要时显式传 `status=all` 或具体状态。
   * 导出的字段是管理视角的（含 email/ip/ua/status/source），所以这个接口在 AdminGuard 后面。
   */
  async exportComments(status: string = 'approved') {
    const filter: any =
      status === 'all'
        ? { status: { $ne: 'deleted' } }
        : { status: ['approved', 'pending', 'spam', 'deleted'].includes(status) ? status : 'approved' };
    const rows = await this.commentModel.find(filter).sort({ createdAt: 1, id: 1 }).exec();
    return rows.map((r: any) => {
      const raw: any = r?._doc || r;
      return {
        id: raw.id,
        path: raw.path,
        articleId: raw.articleId || 0,
        rootId: raw.rootId || 0,
        parentId: raw.parentId || 0,
        replyToNick: raw.replyToNick || '',
        nick: raw.nick,
        email: raw.email || '',
        site: raw.site || '',
        content: raw.content,
        status: raw.status,
        isAuthor: !!raw.isAuthor,
        ip: raw.ip || '',
        ua: raw.ua || '',
        source: raw.source || '',
        sourceId: raw.sourceId || '',
        likeCount: Number(raw.likeCount) || 0,
        createdAt: raw.createdAt,
      };
    });
  }

  async getById(id: number) {
    return await this.commentModel.findOne({ id: Number(id) }).exec();
  }
}


/**
 * 把 `![alt](data:image/png;base64,…)` 折叠成 alt 文本。
 *
 * ⚠️ 这里以前是一条正则（第四轮审计 B9）：
 *   `/!\[([^\]]*)\]\(\s*<?data:[^)>]*>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi`
 * 它在「`![a](data:` + 大量空白 + **没有右括号**」这种输入上是 O(n²)：
 * `[^)>]*`、title 的 `\s+` 与结尾的 `\s*` 三个变长消费者在同一段空白上互相回退。
 * 实测 5k→125ms、10k→495ms、20k→2.0s、40k→8.0s、80k→32s（每翻倍 ×4）。
 * 唯一调用方 `importFromWaline` 在 AdminGuard 后面、body 上限 1MB ⇒
 * 一条 ~1MB 的评论外推是**数小时**的事件循环阻塞（后台导入接口即可触发）。
 *
 * 现在改成「字面量预检 + 线性扫描器」，它按正则引擎的回退顺序**确定性地**
 * 复刻同一个语言（对拍钉子见 audit-hardening-round4-fixes-comment.spec.ts：
 * 既有钉子 + 手写边界 + 4000 个种子随机向量，输出逐字节相同）。
 * 匹配结构（`data:` 之后）：
 *   P=[^)>]*（停在第一个 `)` / `>` / 串尾）→ `>?` → 可选 title(`\s+`+引号串) → `\s*` → `\)`。
 * 关键事实：
 *  - P 停在 `)` ⇒ 贪婪首试即成功（title 与 `\s*` 都可为空），且这是最左的合法终点；
 *  - P 停在串尾 ⇒ 必然失败（成功的匹配必须以 `)` 结束）⇒ 而且**后面所有锚点也必然失败**
 *    （剩下的串里连一个 `)` 都没有），直接结束整个扫描 —— 这正是旧正则最贵的那种输入；
 *  - P 停在 `>` ⇒ `>?` 要么吃掉它（phase 1：title/`\s*`/`)` 都是确定性的——
 *    `\s+`/`\s*` 取极大段，短了下一个字符还是空白、等不到引号或 `)`），
 *    要么不吃（此时 title/`\s*`/`\)` 都匹配不了 `>`，必然失败）；
 *    要么 P **回退**到 run 内部的某个空白处，让 title 从那里开跑（phase 2）——
 *    ⚠️ 这一支不能省：引号串的内容 `[^"]*` 允许包含 `>` 与 `)`，
 *    所以 `![a](data:x "a > b")` 的合法解析恰恰是「P 让位、title 跨过 `>`」。
 *    phase 2 按引擎的回退顺序从右往左逐个空白段尝试，每个空白段只需试一次
 *    （段内所有回退位置的 `\s+` 极大段都终止于同一个引号位置）。
 *  - 扫描总量另有工作预算（≈20×输入长度）：构造「N 个 `![a](data:` 锚点 + 结尾一个 `>`」
 *    这种连旧正则都要 O(N²) 的输入时，新实现会在几十毫秒内**大声抛错**
 *    （该行导入失败、记进 errors[]），而不是把事件循环阻塞几个小时——绝不静默。
 */
const DATA_URI_WS = /\s/;

/** 字面量 `data:`（大小写不敏感）的线性探测：没有它就绝不可能有匹配 */
const DATA_URI_PROBE = /data:/i;

/** 工作预算：每字符允许的均摊扫描次数（超出 ⇒ 抛错，见上面的说明） */
const STRIP_WORK_FACTOR = 20;
const STRIP_WORK_FLOOR = 100_000;

/** 扫描器的共享状态：工作量计数 + 预算 + 「剩余部分已无 `)`/`>`」的短路标志 */
interface StripScanState {
  work: number;
  budget: number;
  noCloseParen?: boolean;
}

export function stripDataUriImages(text: string): string {
  const input = String(text ?? '');
  // 快速路径：普通长文（绝大多数评论/导入行）一次线性探测就原样返回
  if (!DATA_URI_PROBE.test(input)) {
    return input;
  }
  const budget = input.length * STRIP_WORK_FACTOR + STRIP_WORK_FLOOR;
  const scan: StripScanState = { work: 0, budget };
  let out = '';
  let pos = 0;
  for (;;) {
    const anchor = input.indexOf('![', pos);
    if (anchor < 0) {
      break;
    }
    const hit = matchDataUriImage(input, anchor, scan);
    if (hit === 'BUDGET') {
      throw new BadRequestException(
        '评论里包含无法在合理时间内解析的 data: 图片引用（疑似构造输入），该行已跳过',
      );
    }
    if (hit) {
      out += input.slice(pos, anchor);
      const label = hit.alt.trim();
      out += label || '图片';
      pos = hit.end;
    } else if (scan.noCloseParen) {
      // 剩余部分连一个 `)`/`>` 都没有 ⇒ 之后任何锚点都不可能成功（见函数头注释）
      out += input.slice(pos, anchor);
      pos = anchor;
      break;
    } else {
      // 这个锚点不成：与正则的全局扫描一致，从下一个字符继续找 `![`
      out += input.slice(pos, anchor + 1);
      pos = anchor + 1;
    }
  }
  out += input.slice(pos);
  return out;
}

/**
 * 从 `s[start] === '!'`（且 `s[start+1] === '['`）开始尝试匹配一个 data: URI 图片。
 * 成功返回 alt 与匹配终点（开区间），失败返回 null，超出工作预算返回 'BUDGET'。
 */
function matchDataUriImage(
  s: string,
  start: number,
  scan: StripScanState,
): { alt: string; end: number } | 'BUDGET' | null {
  const over = () => {
    scan.work += 1;
    return scan.work > scan.budget;
  };
  const close = s.indexOf(']', start + 2);
  if (close < 0) {
    return null;
  }
  const alt = s.slice(start + 2, close);
  scan.work += close - start;
  let i = close + 1;
  if (s.charAt(i) !== '(') {
    return null;
  }
  i += 1;
  while (i < s.length && DATA_URI_WS.test(s.charAt(i))) {
    if (over()) return 'BUDGET';
    i += 1;
  }
  if (s.charAt(i) === '<') {
    i += 1;
  }
  if (s.slice(i, i + 5).toLowerCase() !== 'data:') {
    return null;
  }
  i += 5;
  // P = `[^)>]*`：极大跑到第一个 `)` 或 `>`（或串尾）
  const q = i;
  while (i < s.length && s.charAt(i) !== ')' && s.charAt(i) !== '>') {
    if (over()) return 'BUDGET';
    i += 1;
  }
  const g = i;
  if (g >= s.length) {
    // 串尾都没有 `)`/`>`：本锚点与**所有后续锚点**都必然失败
    scan.noCloseParen = true;
    return null;
  }
  if (s.charAt(g) === ')') {
    return { alt, end: g + 1 }; // 贪婪首试即成功，且是最左终点
  }
  // ---- s[g] === '>' ----
  // phase 1：`>?` 吃掉 `>`，之后是确定性的一条路
  const h = g + 1;
  if (over()) return 'BUDGET';
  const afterGt = tryAfterAngle(s, h, alt, scan);
  if (afterGt !== null) {
    return afterGt === 'BUDGET' ? 'BUDGET' : afterGt;
  }
  // phase 2：P 回退到 run 内部的空白段，title 从那里开跑（引号内容可以跨过 `>`）。
  // 按引擎回退顺序从右往左逐段尝试；同一段内的所有回退位置等价，只试一次。
  let e = g - 1;
  while (e >= q) {
    if (over()) return 'BUDGET';
    if (!DATA_URI_WS.test(s.charAt(e))) {
      e -= 1;
      continue;
    }
    // 找到这个空白段的左右端（段内所有起点等价）
    let ws = e;
    while (ws > q && DATA_URI_WS.test(s.charAt(ws - 1))) {
      if (over()) return 'BUDGET';
      ws -= 1;
    }
    let we = e;
    while (we < g && DATA_URI_WS.test(s.charAt(we))) {
      if (over()) return 'BUDGET';
      we += 1;
    }
    // ⚠️ 段尾 we 可能等于 g（`>` 之前全是空白）：那时引号检查自然失败
    const viaTitle = tryTitleAt(s, we, alt, scan);
    if (viaTitle !== null) {
      return viaTitle === 'BUDGET' ? 'BUDGET' : viaTitle;
    }
    e = ws - 1;
  }
  return null;
}

/**
 * `>?` 之后的确定性解析：可选 title → `\s*` → `)`。
 * （title 的 `\s+` 只有极大段可能成功：短了下一个字符还是空白，等不到引号；
 *   `\s*` 同理，只有极大段后面才可能紧跟 `)`。）
 */
function tryAfterAngle(
  s: string,
  h: number,
  alt: string,
  scan: StripScanState,
): { alt: string; end: number } | 'BUDGET' | null {
  let j = h;
  while (j < s.length && DATA_URI_WS.test(s.charAt(j))) {
    j += 1;
    scan.work += 1;
    if (scan.work > scan.budget) return 'BUDGET';
  }
  if (j > h) {
    const viaTitle = tryTitleAt(s, j, alt, scan);
    if (viaTitle !== null) {
      return viaTitle;
    }
  }
  // 无 title：`\s*` → `)`（j 已经是极大空白段的末端）
  if (s.charAt(j) === ')') {
    return { alt, end: j + 1 };
  }
  return null;
}

/** we 处必须是引号；引号内容允许包含 `)` 与 `>`（`[^"]*` 的语义），闭引号只能是第一个同款 */
function tryTitleAt(
  s: string,
  we: number,
  alt: string,
  scan: StripScanState,
): { alt: string; end: number } | 'BUDGET' | null {
  const quote = s.charAt(we);
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const closing = s.indexOf(quote, we + 1);
  scan.work += closing < 0 ? s.length - we : closing - we;
  if (scan.work > scan.budget) return 'BUDGET';
  if (closing < 0) {
    return null;
  }
  let k = closing + 1;
  while (k < s.length && DATA_URI_WS.test(s.charAt(k))) {
    k += 1;
    scan.work += 1;
    if (scan.work > scan.budget) return 'BUDGET';
  }
  if (s.charAt(k) === ')') {
    return { alt, end: k + 1 };
  }
  return null;
}

/** Waline 的 `insertedAt` 可能是 ISO 串、毫秒数或 `{$date: ...}`；解析不出来就返回 null */
function toValidDate(raw: unknown): Date | null {
  let value: any = raw;
  if (value && typeof value === 'object' && '$date' in (value as any)) {
    value = (value as any).$date;
  }
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 从各种形状的导出文件里取出 Comment 行。
 * 只认数组，且数组里必须是对象；其它一律当空，避免把奇怪的结构塞进后续校验。
 */
export function extractWalineComments(payload: unknown): any[] {
  const pickArray = (value: unknown): any[] =>
    Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];

  if (Array.isArray(payload)) {
    return pickArray(payload);
  }
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const obj = payload as Record<string, any>;
  // VanBlog 的 waline 备份：{ type:'waline', tables:[...], data:{ Comment:[...] } }
  if (obj.data && typeof obj.data === 'object') {
    const fromData = pickArray(obj.data.Comment ?? obj.data.comments ?? obj.data.comment);
    if (fromData.length) {
      return fromData;
    }
  }
  const direct = pickArray(obj.Comment ?? obj.comments ?? obj.comment);
  if (direct.length) {
    return direct;
  }
  return [];
}
