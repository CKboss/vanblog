import {
  HttpException,
  HttpStatus,
  NotFoundException, Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SortOrder } from 'src/types/sort';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { CategoryProvider } from 'src/provider/category/category.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { TagProvider } from 'src/provider/tag/tag.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { version } from 'src/utils/loadConfig';
import { CustomPageProvider } from 'src/provider/customPage/customPage.provider';
import { encode } from 'js-base64';
import { asQueryString } from 'src/utils/sanitizeRequest';
import { consumeAttempt, resetAttempts } from 'src/utils/attemptLimit';
import { scaleLimit } from 'src/utils/clusterRole';
import { pickSocketIp } from 'src/provider/log/utils';
import { bruteForceClientIp } from 'src/utils/trustedProxy';
import { tryParseNumericId } from 'src/utils/numericId';
import { getWalinePublicCommentSetting } from 'src/utils/walineExtra';
import { projectPublicSiteInfo } from 'src/provider/meta/meta.provider';
import { sanitizePagination } from 'src/utils/pagination';
import { isInternalRequest } from 'src/utils/rateLimit';
import { readPublicMetaWithSingleFlight } from 'src/utils/publicMetaCache';
import { isTrue } from 'src/utils/isTrue';

/**
 * 匿名请求"含全文的公开文章列表"的单页上限。
 *
 * 为什么单独给全文列表设一个比 `MAX_PAGE_SIZE`(100) 小得多的上限：列表默认
 * （`toListView` 缺省 = false）会在每一项里带**完整正文**，于是一个约 60 字节的匿名请求
 * 能换回约等于整库正文的响应体（本站 59 篇 / 41,508 字，`pageSize=100` 一次就是整库）。
 * 在极端网络环境下**出口带宽是最先耗尽、且最难恢复的资源**，而按 IP 的限流对僵尸网络无效、
 * 默认部署里也没有任何缓存层能吸收 ⇒ 必须在应用层把单次放大倍数压下来。
 *
 * 取 20 的依据：①前台**不受影响**（列表页一律显式传 `toListView=true`，走 `MAX_PAGE_SIZE`）；
 * ②本站内部调用（SSR 带 `VAN_BLOG_INTERNAL_TOKEN` 或回环直连）**不受影响**（`isInternalRequest`）；
 * ③第三方消费者仍然可用，只是拉全文要分 5 倍多的页 —— 这是"可用性与放大倍数"的折中，
 *   比"改默认值不返回全文"温和（那会破坏既有 API 契约）。
 * ⚠️ 想放宽就调这个常量；不要指望用 `pageSize` 绕（`sanitizePagination` 会夹住）。
 */
export const FULL_CONTENT_MAX_PAGE_SIZE = 20;

/**
 * 每篇加密文章、每 10 分钟的**全局**（跨 IP）密码尝试预算。
 *
 * 为什么单有"20 次/10 分钟/(IP×文章)"不够：那是**按 IP** 的，在僵尸网络下等于没有 ——
 * N 个 IP 就是 N×20 次，而每次尝试都要算一次 scrypt（N=16384，实测 63–65 ms / 16MB）。
 * 于是攻击成本是**乘法**：`IP 数 × 加密文章数 × 20`。100 篇加密文章时 5 个 IP 就能产生
 * 3.24 秒/秒的 scrypt 工作量。scrypt 本轮已改成异步（落到 libuv 线程池，事件循环不再被冻结），
 * 但**CPU 总量没变** —— 线程池被打满之后，图片管线等其它异步工作一起排队。
 * 这道闸把总量变成**有界**：每篇文章每 10 分钟最多这么多次尝试，与来源 IP 数无关。
 *
 * ⚠️ 它统计**所有**尝试（包括密码正确的那次），所以阈值要给足正常读者：
 *    默认 500 次/10 分钟/篇 ≈ 一篇文章在 10 分钟内最多被 500 人试密码。
 *    一篇爆文的加密贴可能真的会撞到，所以做成可配（`VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN`）。
 * ⚠️ 故意**不做"全站"预算**：那会让"一篇爆文的合法读者"把全站所有加密文章的解锁一起锁死，
 *    而本站的使用场景恰恰是"要在攻击下把内容发出去"—— 可用性优先，所以按文章分桶。
 * ⚠️ 与按 IP 那道一样用 `scaleLimit()` 摊薄：计数器是每进程一份，多 worker 时不摊薄就等于 N 倍预算。
 */
const RAW_UNLOCK_GLOBAL_BUDGET = Number(process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN);
export const UNLOCK_GLOBAL_BUDGET_PER_10MIN =
  Number.isFinite(RAW_UNLOCK_GLOBAL_BUDGET) && RAW_UNLOCK_GLOBAL_BUDGET >= 20
    ? Math.min(Math.floor(RAW_UNLOCK_GLOBAL_BUDGET), 100000)
    : 500;

/**
 * 公开只读 GET 的缓存头。
 *
 * 为什么值得加：这些接口**匿名可达**且"请求小、响应大"，而默认部署里 caddy 不缓存动态响应
 * ⇒ 每个攻击请求都要穿到 Node 与 Mongo。加上 `s-maxage` 与 `stale-while-revalidate` 之后，
 * **站长只要在前面挂任意 CDN/反代缓存，就能把这类流量吸收在边缘** —— 这是极端环境下唯一能
 * 横向扩展的防线，因为按 IP 限流对僵尸网络无效。
 *
 * ⚠️ 只加在**纯公开、与访客身份无关**的接口上（站点配置、文章列表）：
 *   - 不加在文章详情/解锁接口（含访问密码保护的内容，绝不能被共享缓存存住）；
 *   - 不加在任何 `/api/admin/*`（那边已有 `no-store` 与 CDN 专用头）；
 *   - `max-age=30` 让浏览器最多看到 30 秒旧的站点配置/列表 —— 对博客无感，且后台改动本来
 *     就有 `invalidatePublicMetaCache()` 让**服务端**立刻生效。
 */
const PUBLIC_READ_CACHE_CONTROL = 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400';

@ApiTags('public')
@Controller('/api/public/')
export class PublicController {
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly categoryProvider: CategoryProvider,
    private readonly tagProvider: TagProvider,
    private readonly metaProvider: MetaProvider,
    private readonly visitProvider: VisitProvider,
    private readonly settingProvider: SettingProvider,
    private readonly customPageProvider: CustomPageProvider,
  ) {}
  @Get('/comment-setting')
  async getCommentSetting() {
    const waline = await this.settingProvider.getWalineSetting();
    return {
      statusCode: 200,
      data: getWalinePublicCommentSetting(waline),
    };
  }

  @Get('/customPage/all')
  async getAll() {
    return {
      statusCode: 200,
      data: await this.customPageProvider.getAll(),
    };
  }
  @Get('/customPage')
  async getOneByPath(@Query('path') path: unknown) {
    // path 来自查询串：`?path[$ne]=/x` 会被解析成对象，直接进 findOne 会 500。
    const rawPath = asQueryString(path);
    if (!rawPath) {
      throw new NotFoundException('找不到自定义页面');
    }
    const doc: any = await this.customPageProvider.getCustomPageByPath(rawPath);
    if (!doc) {
      throw new NotFoundException('找不到自定义页面');
    }
    // 不能 `{...doc}`：mongoose 文档展开后会把 `$__` / `$isNew` / `_doc` 这些内部结构
    // 一起吐给公网（实测过），只挑真正需要的字段返回。
    const data = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
      statusCode: 200,
      data: {
        name: data?.name,
        path: data?.path,
        type: data?.type,
        html: data?.html ? encode(data.html) : '',
      },
    };
  }
  @Get('/article/:id')
  async getArticleByIdOrPathname(@Param('id') id: string) {
    const data = await this.articleProvider.getByIdOrPathnameWithPreNext(id, 'public');
    return {
      statusCode: 200,
      data: data,
    };
  }
  @Post('/article/:id')
  async getArticleByIdOrPathnameWithPassword(
    @Param('id') id: number | string,
    @Body() body: { password: string },
    @Req() req?: any,
  ) {
    // 加密文章的密码是明文比较，接口又完全公开：不限次数的话可以无限速爆破。
    // ⚠️ key 里的 id **必须归一化**：路由参数是原始字符串，而下游用 `parseNumericId`（= `Number(id)`）
    // 解析，同一个整数有无穷多种写法。以前直接拿原始串当 key，于是 `07`、`007`、`7.0`、`0x7`、
    // `7e0`、`0b111`、`0o7`、`%207`、`0000000007` **每种都能拿到全新的 20 次尝试** ——
    // 前导零还没有上界，等于 20 次/10 分钟的预算变成无限，只剩 30 次/分钟的公开写桶兜着
    // （≈4.3 万次/天/IP，换源 IP 还能翻倍）。实测：把 `7` 打到 429 之后，
    // 用 `0000000000007` 加正确密码仍然能拿到完整正文。
    const rawId = String(id ?? '');
    const numericId = tryParseNumericId(rawId);
    const key = `unlock-${bruteForceClientIp(req)}-${
      numericId !== null ? `#${numericId}` : `p:${rawId.slice(0, 80)}`
    }`;
    // 加密文章的密码尝试次数：计数器是每进程一份，多进程时要摊薄，
    // 否则 N 个 worker = N 倍的爆破预算
    const attempt = consumeAttempt(key, { max: scaleLimit(20), windowMs: 10 * 60 * 1000 });
    if (!attempt.allowed) {
      throw new HttpException(
        `尝试次数过多，请 ${attempt.retryAfterSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // ⚠️ 第二道闸：**按文章的全局预算**（跨 IP），理由见 UNLOCK_GLOBAL_BUDGET_PER_10MIN。
    //    key 用的是**归一化后**的 id，与上面那道闸同源 —— 否则 `7` 打满之后换 `0000007`
    //    又能拿到一整份全局预算，等于这道闸不存在（那个前导零洞本轮之前真实存在过）。
    const globalKey = `unlock-global-${
      numericId !== null ? `#${numericId}` : `p:${rawId.slice(0, 80)}`
    }`;
    const globalAttempt = consumeAttempt(globalKey, {
      max: scaleLimit(UNLOCK_GLOBAL_BUDGET_PER_10MIN),
      windowMs: 10 * 60 * 1000,
    });
    if (!globalAttempt.allowed) {
      // ⚠️ 文案不能泄露"这篇文章被爆破过"以外的信息，也不要回显 id。
      throw new HttpException(
        `这篇文章的密码尝试次数过多，请 ${globalAttempt.retryAfterSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const data = await this.articleProvider.getByIdWithPassword(id, body?.password);
    if (data) {
      resetAttempts(key);
    }
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/search')
  async searchArticle(@Query('value') search: string) {
    const data = await this.articleProvider.searchByString(search, false);

    return {
      statusCode: 200,
      data: {
        total: data.length,
        data: this.articleProvider.toSearchResult(data),
      },
    };
  }
  @Post('/viewer')
  async addViewer(
    @Query('isNew') isNew: boolean,
    @Query('isNewByPath') isNewByPath: boolean,
    @Req() req: Request,
  ) {
    // referer 可能缺失或是畸形百分号编码，`new URL(undefined)` / `decodeURIComponent('%')`
    // 都会抛异常 → 这个未鉴权接口以前会直接 500
    const refer = req.headers.referer;
    let pathname = '';
    try {
      if (refer) {
        pathname = new URL(String(refer)).pathname || '';
      }
    } catch {
      pathname = '';
    }
    if (!pathname) {
      pathname = asQueryString((req.query as any)?.path) || '';
    }
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    // 路径限长，避免匿名调用往 visits 表里塞任意长的键
    decoded = decoded.slice(0, 500);
    const data = await this.metaProvider.addViewer(isNew, decoded, isNewByPath);
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/viewer')
  async getViewer() {
    const data = await this.metaProvider.getViewer();
    return {
      statusCode: 200,
      data: data,
    };
  }
  @Get('/article/viewer/:id')
  async getViewerByArticleIdOrPathname(@Param('id') id: number | string) {
    const data = await this.visitProvider.getByArticleId(id);
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/tag/:name')
  async getArticlesByTagName(@Param('name') name: string) {
    const data = await this.tagProvider.getArticlesByTag(name, false);
    return {
      statusCode: 200,
      data: this.articleProvider.toPublic(data),
    };
  }
  @Get('article')
  @Header('Cache-Control', PUBLIC_READ_CACHE_CONTROL)
  async getByOption(
    @Req() req: any,
    @Query('page') page: number,
    @Query('pageSize') pageSize: number | undefined,
    @Query('toListView') toListView = false,
    @Query('regMatch') regMatch = false,
    @Query('withWordCount') withWordCount = false,
    @Query('withExcerpt') withExcerpt = false,
    @Query('category') category?: string,
    @Query('tags') tags?: string,
    @Query('sortCreatedAt') sortCreatedAt?: SortOrder,
    @Query('sortTop') sortTop?: SortOrder,
  ) {
    const defaultPageSize = await this.metaProvider.getArticlesPerPage();
    // `pageSize=-1` 会把**全部文章连正文**一次性拉走（前台静态生成需要它），
    // 但匿名访客也能调，等于一个现成的「拖库 + 打爆内存」按钮。
    // 现在只允许本站内部调用（回环直连，或带 VAN_BLOG_INTERNAL_TOKEN），
    // 其它一律夹到 MAX_PAGE_SIZE；正常翻页与分类/标签页都不受影响。
    const unlimited = isInternalRequest(req);
    // ⚠️ **全文列表的放大闸门**：`toListView` 缺省是 false ⇒ 响应里含**每篇完整正文**，
    //    而 `MAX_PAGE_SIZE` 是 100 ⇒ 一个约 60 字节的匿名请求能换回**约等于整库正文**
    //    （本站 59 篇 / 41,508 字，一次 `pageSize=100` 的全文响应就是整库）。
    //    在极端网络环境下**带宽是最先耗尽且最难恢复的资源**，而按 IP 的限流对僵尸网络无效、
    //    默认部署里也没有任何缓存层能吸收它 ⇒ 这里按"响应是否含全文"分档收紧。
    //    内部调用（SSR 带令牌或回环直连）不受影响；前台列表本来就显式传 `toListView=true`。
    // ⚠️ 判据必须与 provider 同口径：`article.provider.ts:983` 是 `if (option.toListView)` 的
    //    **真值判断**，所以查询串 `?toListView=false`（字符串"false"是真值）其实会走列表视图。
    //    这里若用"严格等于 true"来判定，就会去夹那些实际只返回列表的请求（无害但错），
    //    更糟的是可能放过真正返回全文的形状 ⇒ 一律用同一个真值判断。
    const wantsFullContent = !toListView;
    const paging = sanitizePagination(page, pageSize, {
      allowUnlimited: unlimited,
      defaultPageSize,
      maxPageSize:
        wantsFullContent && !unlimited ? FULL_CONTENT_MAX_PAGE_SIZE : undefined,
    });
    const option = {
      page: paging.page,
      pageSize: paging.pageSize,
      category,
      tags,
      toListView,
      regMatch,
      sortTop,
      sortCreatedAt,
      withWordCount,
      // 前台首页/分页用「toListView + withExcerpt」拿摘要而不再拿全文（见 getByOption）
      withExcerpt,
    };
    // 三个 sort 是完全排他的。
    const data = await this.articleProvider.getByOption(option, true);
    return {
      statusCode: 200,
      data,
    };
  }
  @Get('timeline')
  async getTimeLineInfo() {
    const data = await this.articleProvider.getTimeLineInfo();
    return {
      statusCode: 200,
      data,
    };
  }
  /**
   * 分类 → 该分类下的文章。
   *
   * @param toListView **可选**，默认不传 = 今天的行为（每篇 16 个字段的完整列表形状）。
   *   传 `true` 时改用公开精简投影（少 `hidden`/`lastVisitedTime`/`wordCount` 三个
   *   "公开响应里零消费者"的字段），实测这三个占响应的 **19.2%**（53 篇时 3,882 B / 20,255 B）。
   *   ⚠️ **向后兼容**：这是公开接口，第三方主题/脚本可能在调它，所以精简**必须显式 opt-in**，
   *   缺省形状一个字节都不变。
   *   🔴 **布尔口径与 `/api/public/article` 的 `toListView` 不同，这是有意的**：那边是
   *   `if (option.toListView)` 的**真值判断**（历史行为，查询串 `?toListView=false` 会走列表视图，
   *   见本文件 `getByOption` 里的说明），这边用 `utils/isTrue` 的**严格口径**（只认 `true`/`'true'`）。
   *   为什么不一致反而更安全：两边的**失败方向**不同 —— `/article` 的真值判断失败方向是"给更小的响应"
   *   （无害），而这里如果照抄真值判断，`?toListView=false` 就会给出**比调用方预期更少**的字段
   *   （静默的错答案）。严格口径让"没明确要求精简"的一切输入都落回今天的完整形状。
   *   ⚠️ 不要去"统一"成同一套而不同时检查两侧的失败方向。
   */
  @Get('category')
  async getArticlesByCategory(@Query('toListView') toListView?: unknown) {
    const data = await this.categoryProvider.getCategoriesWithArticle(false, {
      slim: isTrue(toListView),
    });
    return {
      statusCode: 200,
      data,
    };
  }
  @Get('tag')
  async getArticlesByTag(@Query('toListView') toListView?: unknown) {
    // ⚠️ 布尔口径与 `@Get('category')` 一致（严格 `isTrue`：只认字面量 true / 字符串 "true"），
    //    而**故意不同于** `@Get('article')` 的真值判断 —— 理由与守卫见 `@Get('category')` 上方注释：
    //    那边真值判断的失败方向是"给更小的响应"（无害），而这里照抄会让 `?toListView=false`
    //    给出**比调用方预期更少的字段**（静默的错答案）。⚠️ 别"顺手统一"。
    // 🔴 默认（不传参数）逐字节不变：实测 23,265 B，与改动前基线相同。
    const data = await this.tagProvider.getTagsWithArticle(false, {
      slim: isTrue(toListView),
    });
    return {
      statusCode: 200,
      data,
    };
  }

  @Get('/meta')
  @Header('Cache-Control', PUBLIC_READ_CACHE_CONTROL)
  async getBuildMeta() {
    // 这个接口是全站最热的一次读（前台每个页面渲染都要调），内容却只在后台改配置时才变，
    // 所以走"进程内短缓存 + 单飞"（默认 5 秒，见 utils/publicMetaCache.ts）。
    //
    // ⚠️ **单飞不是优化，是必需**：裸 TTL 缓存有一个周期性必然发生的故障形状 —— TTL 到期的
    //    那一瞬间，所有在飞请求**同时未命中**，于是每个都各自去跑下面那 7 个查询。1 万并发
    //    ⇒ 瞬时 **7 万个 Mongo 操作**挤在 `maxPoolSize` 默认 **100** 的池上（且未配
    //    `waitQueueTimeoutMS` ⇒ 排队等池是**无限等**）。结果不是快速失败，而是**延迟雪崩**：
    //    请求在内存里堆积、p99 飙升、上游 caddy 等不到响应而 502。
    //    C10K 实测正是这个形状：caddy 直服的静态路径 10000/10000 全成功，而本接口第二轮
    //    只有 5033/10000（第一轮打热缓存，第二轮撞上过期瞬间）。
    //    ⚠️ 多开 worker 解决不了：池大小被 `scaleLimit()` 按 worker 数摊薄，总和仍约 100。
    return readPublicMetaWithSingleFlight<any>(() => this.buildPublicMeta());
  }

  /** 真正取数与组装。⚠️ 只由上面的 single-flight 包装调用，不要直接调（否则击穿防护失效）。 */
  private async buildPublicMeta() {
    // ⚠️ 这 7 个读互相独立，以前是**串行 await**（7 次 Mongo 往返排队等），
    // 高并发下延迟直接翻好几倍。改成并行后总耗时≈最慢的那一个。
    const [tags, meta, categories, menuRes, totalArticles, totalWordCount, LayoutSetting] =
      await Promise.all([
        this.tagProvider.getAllTags(false),
        this.metaProvider.getAll(),
        this.categoryProvider.getPublicCategoryNames(),
        this.settingProvider.getMenuSetting(),
        this.articleProvider.getTotalNum(false),
        this.metaProvider.getTotalWords(),
        this.settingProvider.getLayoutSetting(),
      ]);
    const metaDoc = (meta as any)?._doc || meta;
    // ⚠️ `getMenuSetting()` 在库里没有 {type:'menu'} 这条设置文档时返回 **null**
    // （setting.provider.ts:134-140），直接解构会抛 ⇒ 全站最热的公开读变成 500、
    // 前台整个死掉、日志里还看不出原因。触发场景真实存在：恢复一份"有 users 但没有
    // settings 集合"的归档（手工做的或部分归档）之后，站点是"已初始化"的，
    // 于是每一个 /api/public/meta 都 500。脚本那路的真机 drill 撞到了这一条。
    // 同一批 Promise.all 里 LayoutSetting 走的是函数调用（encodeLayoutSetting），
    // 它自己对 null 有处理；只有这一处是裸解构。
    const { data: menus } = menuRes ?? {};
    const LayoutRes = this.settingProvider.encodeLayoutSetting(LayoutSetting);
    // ⚠️ **白名单投影，不是全量展开**。`siteInfo` 以前是 `...metaDoc.siteInfo` 直接铺开，
    //    等于"新增字段默认公开"。这不是理论风险：`UpdateSiteInfoDto = Partial<SiteInfo> |
    //    Partial<updateUserDto>`，而 `updateUserDto` 含 `username` —— 旧的 `updateSiteInfo`
    //    只剥 `name`/`password`、**没剥 `username`** ⇒ 一次带 `username` 的后台 PUT 会把
    //    **管理员用户名写进 `metas.siteInfo`**，再被这个匿名可达的接口全量展开出去，
    //    攻击者不用枚举就能精准打真账号。读写两侧现在都堵了（写侧在 meta.provider，读侧是这一行）。
    //    另一个副作用是侦察面：实测公开响应里的 siteInfo 有 19 个键，其中
    //    `allowOpenHiddenPostByUrl` 前台根本不用，而它若是 'true' 就等于告诉攻击者
    //    "枚举文章 id/路径可以拿到隐藏正文"。
    // ⚠️ 投影是**纯函数**（不读库、不改入参），所以不会给这个全站最热的读增加 DB 往返 ——
    //    这点很关键：本 handler 刚加了 single-flight，任何多余的往返都会抵消它的收益。
    // ⚠️ `articlesPerPage` 的夹取与三段文案的净化**已包含在投影里**（与 `getSiteInfo()` 逐项一致，
    //    白名单只有一份真相），所以这里不要再单独调 `sanitizeArticlesPerPage`。
    const siteInfo = { ...projectPublicSiteInfo(metaDoc?.siteInfo) };
    const data = {
      version: version,
      tags,
      meta: {
        ...metaDoc,
        siteInfo,
        categories,
      },
      menus,
      totalArticles,
      totalWordCount,
      ...(LayoutSetting ? { layout: LayoutRes } : {}),
    };
    const res = {
      statusCode: 200,
      data,
    };
    // ⚠️ 不在这里写缓存：写入由 `readPublicMetaWithSingleFlight` 统一负责（它还要比对代号，
    //    以免"在飞期间后台改了设置"时把旧数据写回缓存并再活一个 TTL）。
    return res;
  }
}
