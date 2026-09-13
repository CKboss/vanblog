import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
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
import { Article, ArticleDocument } from 'src/scheme/article.schema';
import { Meta, MetaDocument } from 'src/scheme/meta.schema';
import { config } from 'src/config';
import { consumeAttempt } from 'src/utils/attemptLimit';
import { pickSocketIp } from '../log/utils';
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

@Injectable()
export class CommentProvider {
  logger = new Logger(CommentProvider.name);
  private idLock = false;

  constructor(
    @InjectModel(NativeComment.name) private readonly commentModel: Model<CommentDocument>,
    // 直接注入 model 而不是 ArticleProvider / MetaProvider：
    // Article ↔ Meta 之间本来就有互相引用，再从这里引一条边会让 Nest 报
    // 「A circular dependency has been detected inside AppModule」，整个进程起不来。
    @InjectModel(Article.name) private readonly articleModel: Model<ArticleDocument>,
    @InjectModel(Meta.name) private readonly metaModel: Model<MetaDocument>,
    private readonly settingProvider: SettingProvider,
  ) {}

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

    // 蜜罐：真人看不见这个输入框，填了就说明是脚本
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

    const ip = pickSocketIp(req);
    const limit = consumeAttempt(`comment-${ip}`, {
      max: Math.max(1, setting.rateLimitPer10Min),
      windowMs: RATE_WINDOW_MS,
    });
    if (!limit.allowed) {
      throw new BadRequestException(
        `评论太频繁了，请 ${limit.retryAfterSeconds} 秒后再试`,
      );
    }
    // 每 IP 每天最多 50 条：防止长时间低频灌库
    const daily = consumeAttempt(`comment-day-${ip}`, { max: 50, windowMs: 24 * 60 * 60 * 1000 });
    if (!daily.allowed) {
      throw new BadRequestException('今天评论太多了，请明天再来');
    }
    // 同 IP + 同内容 5 分钟内只允许一条：挡住复制粘贴式刷屏
    const dedupeKey = `comment-dup-${ip}-${simpleHash(content)}`;
    const dup = consumeAttempt(dedupeKey, { max: 1, windowMs: 5 * 60 * 1000 });
    if (!dup.allowed) {
      throw new BadRequestException('刚才已经发过一样的评论了');
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
      ip: pickSocketIp(data.req),
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

    const total = await this.commentModel.countDocuments({ path, rootId: 0, status: 'approved' });
    const roots = await this.commentModel
      .find({ path, rootId: 0, status: 'approved' })
      .sort({ createdAt: sort, id: sort })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .exec();
    if (!roots.length) {
      return { total, page, pageSize, data: [] };
    }
    const rootIds = roots.map((r) => r.id);
    const children = await this.commentModel
      .find({ path, rootId: { $in: rootIds }, status: 'approved' })
      .sort({ createdAt: 1, id: 1 })
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
    const rows = await this.commentModel
      .aggregate([
        { $match: { path: { $in: cleaned }, status: 'approved' } },
        { $group: { _id: '$path', count: { $sum: 1 } } },
      ])
      .exec();
    const out: Record<string, number> = {};
    for (const p of cleaned) {
      out[p] = 0;
    }
    for (const row of rows as any[]) {
      out[String(row?._id)] = Number(row?.count) || 0;
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

  async getById(id: number) {
    return await this.commentModel.findOne({ id: Number(id) }).exec();
  }
}
