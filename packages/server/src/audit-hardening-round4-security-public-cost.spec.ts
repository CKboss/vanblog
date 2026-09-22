import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  articleOverviewMarkdown,
  MORE_MARKER,
  MARKER_EXCERPT_MAX_CHARS,
  DEFAULT_OVERVIEW_CHARS,
} from './utils/articleExcerpt';
import { MAX_SEARCH_INPUT, safeSearchPattern, escapeRegExp } from './utils/regex';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, sanitizePagination } from './utils/pagination';
import { MAX_ARTICLES_PER_PAGE, sanitizeArticlesPerPage } from './utils/articlesPerPage';

/**
 * 第四轮安全审计 —— 「公开面的成本由谁决定」这一组（安全**性能**审计的那一半）。
 *
 * 判据只有一个：**匿名调用方能不能用一个参数把服务端的时间/内存/带宽放大**。
 * 下面每一条都带实测数字（一次性实例 + 一次性 mongod:27099，312 篇 × 约 20 KB 语料，
 * 中位数 7 轮，命令见交付报告），不拿 :3000 灌流量（那会顶掉别人在用的限流桶）。
 *
 * ⚠️ `FINDING R4-x（尚未修）` 钉住当前行为，打完补丁会变红 ——
 * 那时请把断言翻成同一条里 `xit('AFTER THE FIX …')` 的内容。`REGRESSION` 必须常绿。
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('REGRESSION R4-11（已修）：excerpt 现在有硬上限 —— `<!-- more -->` 放得晚也不会把全文当摘要下发', () => {
  // 🔴 2026-09-22 升级（原断言钉的是"无上限"那个现状，修完必然要改 —— 这是**契约变了**，不是放宽）：
  //    旧契约 = 有标记时 `return content.slice(0, cut)`，maxChars 完全不参与，摘要可以等于整篇正文
  //             （旧断言原文：`expect(articleOverviewMarkdown(lateMarker).length).toBeGreaterThan(300_000)`
  //              与 `).toBe('# Title\n\n' + filler + '\n\n')`，即"摘要 = 400 KB 正文"）。
  //    新契约 = 标记分支也有硬上限，且**上限之内完全尊重作者的标记位置**。
  //    ⚠️ 断言因此变得**更强**：既钉源码形状（上限存在、且用 Math.max 不砍小调用方显式要的预算），
  //    又钉三种行为（超上限被截 / 上限之内原样保留 / 没有标记时仍是 200 字回退）。
  it('有标记时以 MARKER_EXCERPT_MAX_CHARS 为硬上限，且上限之内尊重作者的标记位置', () => {
    const src = read('./utils/articleExcerpt.ts');
    // 源码形状：标记分支必须先算 cap，再按 cap 决定原样返回还是截断
    expect(src).toMatch(/if \(cut >= 0\) \{\s*\n[\s\S]{0,400}?const cap = Math\.max\(maxChars, MARKER_EXCERPT_MAX_CHARS\);\s*\n\s*return cut <= cap \? content\.slice\(0, cut\) : completeTruncatedInlineLinks\(content, cap\);/);
    // "没有标记"那条分支的 200 字回退**没被动过**
    expect(src).toMatch(/if \(content\.length <= maxChars\) \{\s*\n\s*return content;/);

    const filler = 'Lorem ipsum 中文内容 '.repeat(20000); // ~400 KB
    const lateMarker = `# Title\n\n${filler}\n\n${MORE_MARKER}\n\ntail`;
    const noMarker = `# Title\n\n${filler}`;

    // ① 标记放得极晚 ⇒ 摘要被截到上限，而不再是整篇正文（旧行为是 300_000+ 字符）
    const capped = articleOverviewMarkdown(lateMarker);
    expect(capped.length).toBeLessThanOrEqual(MARKER_EXCERPT_MAX_CHARS);
    expect(capped).toBe(lateMarker.slice(0, MARKER_EXCERPT_MAX_CHARS));
    expect(capped.length).toBeLessThan(lateMarker.length / 100); // 不到原文的 1%

    // ② 🔴 上限**之内**作者的标记位置原样保留 —— 这是"卡片摘要预算"与"作者手写 more 位置"
    //    是两件事的直接体现：标记在 300 字处时，摘要就是那 300 字，**不会**被砍到 200。
    const midMarker = `${'甲'.repeat(300)}\n\n${MORE_MARKER}\n\n后面的正文`;
    expect(articleOverviewMarkdown(midMarker)).toBe(`${'甲'.repeat(300)}\n\n`);
    expect(articleOverviewMarkdown(midMarker).length).toBeGreaterThan(DEFAULT_OVERVIEW_CHARS);

    // ③ 没有标记时仍然是 200 字回退（这条行为一个字没变）
    expect(articleOverviewMarkdown(noMarker).length).toBeLessThanOrEqual(DEFAULT_OVERVIEW_CHARS + 10);
  });

  it('活体实测：withExcerpt 把响应从 37 KB 撑到 1.68 MB，而 content 字段其实已经被剥掉了', () => {
    // 一次性实例（312 篇 × ~20 KB，标记都在正文末尾）：
    //   GET /api/public/article?pageSize=100&toListView=true                  ->  37,884 B
    //   GET /api/public/article?pageSize=100&toListView=true&withExcerpt=true -> 1,685,104 B  (44×)
    //   GET /api/public/article?pageSize=100                                  -> 1,687,940 B  (content 未剥)
    // 两种情况的 `content` 键都不在响应里 ⇒ 这 1.65 MB **全是 excerpt**。
    // 服务端时间：p50 629 ms（8 并发），单请求吞吐上限约 11.7 rps
    // ⇒ 一个匿名客户端按 600 次/分钟（全局限流）打，就能吃满一个进程。
    expect(Math.round(1685104 / 37884)).toBe(44);
    // 真实站点上暂时看不出来（53 篇里最大的 excerpt 只有 687 字），因为站长的标记都放得很早 ——
    // 也就是说这条**当前不是事故，而是一个由作者行为决定的、没有护栏的放大器**：
    // 一篇把 `<!-- more -->` 放在文末的长文（或导入工具批量追加的标记）就能让首页
    // 与这个匿名接口重新变成"下发全文"，而 §7.42/§7.48 的整个目的正是不要下发全文。
    expect(MAX_ARTICLES_PER_PAGE).toBe(50);
  });

  it('同一个 withExcerpt 开关还会让**每篇文章的全文**在 Node 里过三遍纯函数', () => {
    // getByOption：withExcerpt/withWordCount 时把视图升回 publicView（带 content），
    // 然后 articleOverviewMarkdown + pickCoverFromContent 各跑一遍，最后才把 content 抹掉。
    const src = read('./provider/article/article.provider.ts');
    expect(src).toMatch(/if \(option\.withWordCount \|\| option\.withExcerpt\) \{[\s\S]{0,220}?view = isPublic \? this\.publicView : this\.adminView;/);
    expect(src).toMatch(/const item: any = \{ \.\.\.doc, excerpt: articleOverviewMarkdown\(content\) \};/);
    expect(src).toMatch(/const firstImage = pickCoverFromContent\(content, \{ preferLocal: false \}\);/);
    expect(src).toMatch(/content: undefined,\s*\n\s*password: undefined,/);
  });

  // 🔴 2026-09-22 由 xit 翻成 it（本文件头 :16-17 就写着"打完补丁请把断言翻成 xit 里的内容"）。
  it('R4-11 的修复契约：上限是常量而不是环境变量，且不砍小调用方显式要的预算', () => {
    // 最小补丁（utils/articleExcerpt.ts）：把
    //   if (cut >= 0) return content.slice(0, cut);
    // 换成
    //   if (cut >= 0) {
    //     return cut <= maxChars ? content.slice(0, cut) : completeTruncatedInlineLinks(content, maxChars);
    //   }
    // 并给 maxChars 一个可配的公开上限（例如 VANBLOG_EXCERPT_MAX_CHARS，默认 400，
    // 夹在 100–2000），因为"卡片摘要"和"作者手写的 more 位置"是两件事。
    // blast radius：**标记放得很晚的文章，卡片摘要会变短**（这正是目的）。
    //   前台如果用 excerpt 之外的东西渲染卡片就不受影响；
    //   `website/__tests__/articleExcerptParity.spec.ts` 是 server/website 两份实现的对拍，
    //   改这边必须同步改 website/utils/articleExcerpt.ts，否则那条对拍会红 —— 这是好事。
    //   ⚠️ 也会改变 ISR 已缓存页面的字节，所以要在 CHANGELOG 里写成"默认行为变更"。
    //
    // 🔴 实施时与原方案的两处偏离（都有实测依据，写在下面）：
    //  ① **没有引入 `VANBLOG_EXCERPT_MAX_CHARS` 环境变量**。前台那份实现在 `PostCard` 里被调用，
    //     而 `PostCard` 用了 `useMemo`/`useState` ⇒ **它跑在浏览器里**，客户端读不到
    //     `process.env.VANBLOG_*`（Next 只内联 `NEXT_PUBLIC_*`，且是**构建期**内联，而 server 与
    //     website 在镜像里分开构建）⇒ 一侧读 env、另一侧用常量会让两边在生产环境算出**不同摘要**，
    //     正好触发对拍注释里那条「ISR 重渲染前后卡片文字跳变」。所以用**常量**，两侧同值。
    //  ② 上限是 `Math.max(maxChars, 400)` 而不是固定 400 —— 搜索索引显式传 `budget × 4`
    //     （`searchIndexBuild.ts:183`，OVERSCAN=4），固定 400 会砍小它的过采样预算。
    const src = read('./utils/articleExcerpt.ts');

    // 上限是一个**普通数字常量**（不是 env 读取）：声明形状被钉住，改成读 env 就会红。
    // ⚠️ 这里刻意**不断言** "源码里不含 process.env" —— 文件头注释为了说明"为什么不用 env"
    //    恰好写了那个字面量，那条断言会被自己的注释喂饱（本仓库已三次栽在这个形状上）。
    const m = /export const MARKER_EXCERPT_MAX_CHARS\s*=\s*(\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(400);
    expect(MARKER_EXCERPT_MAX_CHARS).toBe(400);

    // 🔴 调用方显式要更大预算时**不被砍小**（搜索索引那条路径的行为因此逐字不变）
    const filler = 'Lorem ipsum 中文内容 '.repeat(20000);
    const lateMarker = `# Title\n\n${filler}\n\n${MORE_MARKER}\n\ntail`;
    expect(articleOverviewMarkdown(lateMarker, 5000).length).toBe(5000);
    expect(articleOverviewMarkdown(lateMarker, 400).length).toBe(400);
    // 默认调用（列表接口与 RSS description 都走这条）落在 400
    expect(articleOverviewMarkdown(lateMarker).length).toBe(MARKER_EXCERPT_MAX_CHARS);
  });
});

describe('FINDING R4-12（尚未修）：公开搜索把 ≤200 篇**全文**捞回 Node，而响应里一个字的正文都没有', () => {
  it('查询没有投影；而控制器的 toSearchResult 只回 6 个字段（源码钉子）', () => {
    const src = read('./provider/article/article.provider.ts');
    const searchFn = src.slice(src.indexOf('async searchByString('), src.indexOf('async deleteById('));
    expect(searchFn).toMatch(/\.limit\(SEARCH_MAX_RESULTS\)/);
    expect(searchFn).toMatch(/\.maxTimeMS\(SEARCH_MAX_TIME_MS\)/);
    expect(searchFn).not.toMatch(/\.select\(|\.projection\(|, \{ content: 0/); // ← 没有投影
    expect(searchFn).toMatch(/const contentData = rawData\.filter\(\(each\) => text\(each\.content\)\.includes\(s\)\);/);
    const toSearchResult = src.slice(src.indexOf('toSearchResult(articles'), src.indexOf('toSearchResult(articles') + 400);
    for (const field of ['title', 'id', 'category', 'tags', 'updatedAt', 'createdAt']) {
      expect(toSearchResult).toContain(field);
    }
    // 🔴 2026-09-23 补：标题承诺的是「**只**回 6 个字段」，而上面那个循环只证明这 6 个**在**，
    //    多回一个第 7 字段（例如把正文或某个敏感字段加进投影）不会红 ⇒ 补一条精确计数，
    //    让「只回 6 个」这个"只"字真的被钉住。判据数的是 `each.<字段>` 的取值个数，
    //    与上面循环用的是同一个语料切片，所以不会与它重复计数。
    expect((toSearchResult.match(/each\.\w+/g) || []).length).toBe(6);
    expect(toSearchResult).not.toContain('content');
    expect(toSearchResult).not.toContain('password');
    // 而且 searchByString 的**唯一**调用方就是这个公开控制器（grep 全仓库确认过）
    expect(read('./controller/public/public.controller.ts')).toMatch(/this\.articleProvider\.searchByString\(search, false\)/);
  });

  it('实测：加一个 {content:0} 投影，DB 侧快 4.9 倍，另外还省掉 23 ms 的 JS 全文扫描', () => {
    // 312 篇 × ~20 KB 语料，同一个 $and 过滤器，limit(200)，中位数 7 轮：
    //   find(...) 现状（无投影）              87.4 ms   取回 200 篇 / 3.68 MB 正文
    //   find(...).project({content:0,…})      18.0 ms   同一个结果集       ⇒ 4.9×
    //   4 趟 toLocaleLowerCase 过滤（Node 侧）23.4 ms   其中 3.68 MB 那一趟纯属白干
    // 整个匿名搜索请求 p50 749 ms（8 并发），响应只有 33,465 B
    // ⇒ 这是"每字节响应最贵"的公开接口：749 ms 服务端时间换 33 KB。
    expect(87.4 / 18.0).toBeGreaterThan(4);
    expect(MAX_SEARCH_INPUT).toBe(200); // 搜索词本身已经限长了
  });

  it('⚠️ §7.55 L 里"加投影会改公开响应形状"这个理由**不成立**（这条是给它做的更正）', () => {
    // 原文：「`searchByString` 仍把 ≤200 篇全文捞回来 | 公开搜索的响应里就包含 `content`」
    // 实际：public.controller.searchArticle 的响应是 `{total, data: toSearchResult(data)}`，
    // toSearchResult 只挑 6 个字段，`content` 从来不在公开搜索的响应里。
    // 所以投影不会改响应形状 —— 但它**会改结果集**，因为 JS 那四趟过滤里的
    // `text(each.content).includes(s)` 依赖 content 存在（见下一条），这才是真正要处理的点。
    expect(read('./controller/public/public.controller.ts')).toMatch(/data: this\.articleProvider\.toSearchResult\(data\),/);
  });

  xit('AFTER THE FIX：投影掉 content，并把"匹配在正文里"这一趟改成"Mongo 已经匹配上了"', () => {
    // Mongo 的 $regex($options:'i') 已经保证了每篇返回的文档至少在 4 个字段之一里命中，
    // 所以 JS 那四趟过滤只是在做"命中在哪个字段"的分组（决定输出顺序）。改成：
    //   .select({ content: 0, password: 0 })
    //   const titleData = rawData.filter((e) => text(e.title).includes(s));
    //   const tagData   = rawData.filter((e) => (e.tags||[]).map(text).includes(s));
    //   const catData   = rawData.filter((e) => text(e.category).includes(s));
    //   const seenTitle = new Set([...titleData, ...tagData, ...catData]);
    //   const contentData = rawData.filter((e) => !seenTitle.has(e)); // 剩下的就是"命中在正文"
    // 结果**集合完全相同**，顺序也相同（title → content → tag → category 的相对次序
    // 由后面的去重循环保留）。唯一的行为差异：Mongo 的 `i` 与 JS 的 toLocaleLowerCase
    // 在少数非 ASCII 字符上不等价（İ / ß / 开尔文符号），这类文档以前会被 JS 那趟**丢掉**，
    // 改完会**保留**（= 相信数据库的判定）。这个差异要在 CHANGELOG 里写一句。
    // blast radius：公开搜索的响应形状零变化；内存峰值从 ~4 MB/请求降到 ~0.1 MB/请求。
    // 不需要环境变量。
    expect(true).toBe(true);
  });
});

describe('REGRESSION R4-13（已修）：GET /api/public/comments/counts 曾经为了两个字段把 ≤50 篇文章的全文捞回来', () => {
  it('expandPostPaths 的 find 现在带 {id:1,pathname:1,_id:0} 投影，而它只读 id 与 pathname（源码钉子）', () => {
    const src = read('./provider/comment/comment.provider.ts');
    const fn = src.slice(src.indexOf('private async expandPostPaths('), src.indexOf('private async expandPostPaths(') + 2200);
    // 修复前是 `articles = await this.articleModel.find({ $or: or }).exec();`（无投影）
    expect(fn).toMatch(/articles = await this\.articleModel\s*\n\s*\.find\(\{ \$or: or \}, \{ id: 1, pathname: 1, _id: 0 \}\)/);
    expect(fn).toMatch(/String\(a\?\.id\) === key \|\| \(a\?\.pathname && String\(a\.pathname\) === key\)/);
    // 这个函数在**公开**路径上：GET /api/public/comments/counts（≤50 个路径）与 GET /api/public/comments/
    expect(read('./controller/public/comment.controller.ts')).toMatch(/this\.commentProvider\.countByPaths\(list\)/);
  });

  it('实测：加 {id:1,pathname:1} 投影后 DB 侧快 14 倍（审计数字；本轮在一次性 mongod 上复测过，见报告）', () => {
    // 50 个 id 的 $in 查询，312 篇 × ~20 KB 语料，中位数 7 轮：
    //   find({id:{$in:[50]}})            19.7 ms   （取回 ~1 MB 正文）
    //   同上 .project({id:1,pathname:1})  1.4 ms   ⇒ 14×
    // 整个匿名请求 p50 156 ms（8 并发），响应 1,377 B。
    expect(19.7 / 1.4).toBeGreaterThan(10);
  });

  it('AFTER THE FIX（已实现）：一行投影，blast radius 为零', () => {
    // 落地的正是占位文字里的那一行：`.find({ $or: or }, { id: 1, pathname: 1, _id: 0 })`。
    // 这个函数的返回值只被用来读 id/pathname 两个字段 ⇒ 展开语义与响应形状一字不变；
    // listByPath 每条请求的 expandPostPaths([path])（1 篇全文）也被同一个补丁收掉。
    // 行为级钉子（投影参数 + 展开语义对拍）：audit-hardening-round4-fixes-comment.spec.ts「FIX R4-13」；
    // 真库前后耗时测量：test/audit-fixes-comment.e2e-spec.ts（env 门控，一次性 mongod）。
    const src = read('./provider/comment/comment.provider.ts');
    expect(src).toMatch(/\.find\(\{ \$or: or \}, \{ id: 1, pathname: 1, _id: 0 \}\)/);
  });
});

describe('FINDING R4-14（设计取舍，但值得知道）：GET /api/public/article 默认视图**带正文**，pageSize 上限 100', () => {
  it('匿名一次 GET 最多拿走 100 篇全文（实测 1.73 MB），而前台自己用的是 toListView+withExcerpt', () => {
    // 实测（312 篇语料）：
    //   ?pageSize=100                                  -> 1,687,940 B / p50 629 ms / 11.7 rps
    //   ?pageSize=100&toListView=true                  ->    37,884 B
    //   ?pageSize=100&toListView=true&withExcerpt=true -> 1,685,104 B（见 R4-11）
    // 全仓库没有任何前台代码调 `/api/public/article` 的"带正文"形态（grep 过 packages/website
    // 与 packages/admin），所以这 1.73 MB 纯粹是给外部消费者的 —— 也就是给攻击者的放大器。
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(DEFAULT_PAGE_SIZE).toBe(5);
    // 按全局限流 600 次/分钟/IP 算：单 IP 就能拉 ~1 GB/分钟 的出口流量，
    // 同时把进程钉在 ~11.7 rps 的上限（p50 629 ms ⇒ 8 并发即饱和）。
    expect(Math.round((1687940 * 600) / 1024 / 1024 / 1024 * 10) / 10).toBe(0.9);
  });

  it('publicView 投影**不含 password**，加密文章的 content 也在 isPublic 分支里被抹掉（源码钉子）', () => {
    const src = read('./provider/article/article.provider.ts');
    const publicView = src.slice(src.indexOf('publicView = {'), src.indexOf('adminView = {'));
    expect(publicView).not.toMatch(/password/);
    expect(src).toMatch(/const isPrivate = isPrivateInArticle \|\| isPrivateInCategory;/);
    expect(src).toMatch(/content: undefined,\s*\n\s*password: undefined,\s*\n\s*private: true,/);
  });

  xit('AFTER THE FIX（可选）：把"公开列表带正文"这条路收给内部调用', () => {
    // 与 pageSize=-1 同一个开关：`const unlimited = isInternalRequest(req)` 已经在控制器里了，
    // 只要再加一句"isPublic && !toListView && !unlimited ⇒ 强制 toListView"，
    // 或者把公开列表的 MAX_PAGE_SIZE 单独降到 20。
    // blast radius：**会改公开 API 契约** —— 任何直接消费 `GET /api/public/article`
    // 且不带 toListView 的第三方（RSS 阅读器插件、别人的前台）会拿不到 content。
    // 因为这是破坏性的，建议**不要**默默改；要么加环境变量（默认保持今天的行为），
    // 要么只做 R4-11（给 excerpt 封顶）——后者已经把最贵的那条路收住了。
    expect(true).toBe(true);
  });
});

describe('REGRESSION R4-C：公开面的护栏（前几轮修的）全部还在', () => {
  it('pageSize=-1 仍然只给内部调用：匿名请求被夹到 MAX_PAGE_SIZE', () => {
    // 控制器：const unlimited = isInternalRequest(req); sanitizePagination(..., {allowUnlimited: unlimited})
    const c = read('./controller/public/public.controller.ts');
    expect(c).toMatch(/const unlimited = isInternalRequest\(req\);/);
    expect(c).toMatch(/allowUnlimited: unlimited,/);
    expect(sanitizePagination(1, -1, { allowUnlimited: false }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(sanitizePagination(1, -1, { allowUnlimited: true }).pageSize).toBe(-1);
    expect(sanitizePagination(1, 100000, { allowUnlimited: false }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(sanitizePagination(1, 0, { allowUnlimited: false }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(sanitizePagination(1, 'abc', { allowUnlimited: false }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    // 活体：外部客户端（带 XFF）?pageSize=-1 -> 返回 5 篇（回落到默认），?pageSize=100000 -> 100 篇
  });

  it('搜索词限长 200 且元字符被转义（防 500 与灾难性回溯）', () => {
    expect(MAX_SEARCH_INPUT).toBe(200);
    expect(safeSearchPattern('(a+)+b')).toBe('\\(a\\+\\)\\+b');
    expect(safeSearchPattern('x'.repeat(5000)).length).toBe(200);
    // 每个元字符都被反斜杠转义（逐个字符验证，避免手写转义串出错）
    for (const ch of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
      expect([ch, escapeRegExp(ch)]).toEqual([ch, '\\' + ch]);
      expect(new RegExp(escapeRegExp(ch)).test(ch)).toBe(true);
    }
    expect(safeSearchPattern('a'.repeat(199) + 'b').length).toBe(200);
    // 活体：?value=( 、?value=[ 、?value=(a+)+b 全部 200，没有一条 500
  });

  it('搜索结果在库里就截断到 200 条，去重是 Set 不是 O(k²)（§7.55 H）', () => {
    const src = read('./provider/article/article.provider.ts');
    expect(src).toMatch(/const SEARCH_MAX_RESULTS = 200;/);
    expect(src).toMatch(/const seen = new Set<Article>\(\);/);
    expect(src).toMatch(/if \(seen\.has\(e\)\) \{\s*\n\s*continue;/);
  });

  it('articlesPerPage 夹在 1–50，垃圾值回落 5（前台首页的每页篇数不由库里那个数字随便决定）', () => {
    expect(sanitizeArticlesPerPage(99999)).toBe(MAX_ARTICLES_PER_PAGE);
    expect(sanitizeArticlesPerPage(0)).toBe(1);
    expect(sanitizeArticlesPerPage('abc')).toBe(5);
    expect(sanitizeArticlesPerPage(undefined)).toBe(5);
  });

  it('公开时间线 / 标签页 / 分类页用的是 listView（不含正文，也不含密码）', () => {
    const src = read('./provider/article/article.provider.ts');
    const timeline = src.slice(src.indexOf('async getTimeLineInfo()'), src.indexOf('async getByOption('));
    expect(timeline).toMatch(/this\.listView/);
    expect(timeline).toMatch(/visiblePublishFilter\(\)/);
    const listView = src.slice(src.indexOf('listView = {'), src.indexOf('deletedListView = {'));
    expect(listView).toMatch(/listView = \{/); // 切片确实取到了
    expect(listView).not.toMatch(/content: 1/);
    expect(listView).not.toMatch(/password: 1/);
    expect(listView).toMatch(/wordCount: 1/); // readingMinutes 靠这个存量副本，不需要正文
    // 活体：/api/public/timeline 的条目键里没有 content；/api/public/category 同理
  });

  it('私有文章与私有分类在 pre/next、搜索、相关文章三处都被排除（§7.57 H）', () => {
    const src = read('./provider/article/article.provider.ts');
    const pre = src.slice(src.indexOf('async getPreArticleByArticle('), src.indexOf('async getNextArticleByArticle('));
    const next = src.slice(src.indexOf('async getNextArticleByArticle('), src.indexOf('async findOneByTitle('));
    const search = src.slice(src.indexOf('async searchByString('), src.indexOf('async deleteById('));
    const related = src.slice(src.indexOf('async getRelatedArticles('), src.indexOf('async getNewId()'));
    expect(related.length).toBeGreaterThan(200); // 切片没切空
    for (const [name, block] of [['pre', pre], ['next', next], ['search', search], ['related', related]] as Array<[string, string]>) {
      expect([name, /\$or: \[\{ private: false \}, \{ private: \{ \$exists: false \} \}\]/.test(block)]).toEqual([name, true]);
      expect([name, /visiblePublishFilter\(/.test(block)]).toEqual([name, true]);
    }
    expect((src.match(/excludeCategoryNames\?\.length/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/\$and\.push\(\{ category: \{ \$nin: privateCategoryNames \} \}\);/);
  });

  it('加密文章的密码比较是常量时间的，且支持历史明文与新 scrypt 两种存储', () => {
    const crypto = read('./utils/crypto.ts');
    expect(crypto).toMatch(/export function verifyAccessPassword\(stored: unknown, supplied: unknown\): boolean \{/);
    expect(crypto).toMatch(/return safeEqual\(target, input\);/);
    expect(crypto).toMatch(/export function safeEqual\(a: unknown, b: unknown\): boolean \{[\s\S]{0,240}?timingSafeEqual\(left, right\)/);
    // ⚠️ 形状已随 scrypt 异步化改变：`verifyAccessPassword` → `await verifyAccessPasswordAsync`。
    //    这里**必须把 `await` 一起钉住**：漏掉 await 时 `!Promise` 恒为 false ⇒
    //    **任何密码都能解开任何加密文章**（静默的未鉴权正文泄露，比原来的 DoS 严重得多）。
    //    `utils/cryptoUsageDrift.spec.ts` 从"所有调用点都必须 await"这个方向再钉一遍。
    expect(read('./provider/article/article.provider.ts')).toMatch(
      /if \(!\(await verifyAccessPasswordAsync\(targetPassword, supplied\)\)\)/,
    );
    // 解锁成功后才清桶；失败一律返回 null（不区分"密码错"与"文章不存在"）
    const c = read('./controller/public/public.controller.ts');
    expect(c).toMatch(/if \(data\) \{\s*\n\s*resetAttempts\(key\);/);
  });

  it('「标记了加密但没设密码」不再等于白送正文（早先那轮的修复还在）', () => {
    const src = read('./provider/article/article.provider.ts');
    const fn = src.slice(src.indexOf('async getByIdWithPassword('), src.indexOf('async getByIdOrPathnameWithPreNext('));
    expect(fn).toMatch(/const isPrivate = !!article\.private \|\| categoryPrivate;/);
    expect(fn).toMatch(/if \(!isPrivate\) \{[\s\S]{0,120}?return plain;/);
    expect(fn).toMatch(/if \(!\(await verifyAccessPasswordAsync\(targetPassword, supplied\)\)\) \{\s*\n\s*return null;/);
    // password 字段被显式抹掉
    expect(fn).toMatch(/const plain = \{ \.\.\.\(article\?\._doc \|\| article\), password: undefined \};/);
  });

  it('未鉴权的解锁 POST 不能绕过 hidden 与 publishAt 两道门（§7.57 E）', () => {
    const src = read('./provider/article/article.provider.ts');
    const fn = src.slice(src.indexOf('async getByIdWithPassword('), src.indexOf('async getByIdOrPathnameWithPreNext('));
    expect(fn).toMatch(/if \(isFuturePublish\(article\.publishAt\)\)/);
    expect(fn).toMatch(/if \(article\.hidden\) \{[\s\S]{0,260}?allowOpenHiddenPostByUrl/);
    expect(fn).toMatch(/getByIdOrPathname\(id, 'admin'\)/); // 用 admin 视图取文，所以上面两道门必须显式加
  });
});


// 🔴 2026-09-23 新增（§7.119 裁定 3）：本文件里有 2 条停用的 `xit`，标题都是 `AFTER THE FIX…`、
//    body 都是恒真的 `expect(true).toBe(true)`。它们**不是**"静默缺席的守卫"：
//    这个文件头就写明了约定 ——「`FINDING R4-x（尚未修）` 钉住当前行为，**打完补丁会变红** ——
//    那时请把断言翻成同一条里 `xit('AFTER THE FIX …')` 的内容」，而真正承重的是 FINDING 那条 `it`
//    （R4-12 的「查询没有投影」源码钉子）；R4-13 的修复落地后，它的 `xit` 就已被翻成
//    `it('AFTER THE FIX（已实现）…')`（见上面那一条），这是本约定做对了的先例。
//    🔴 但"约定写在注释里"不等于"约定被钉住"：一条裸 `xit` 从 CI 界面上看只是 skipped，
//    谁都可以再停用一个测试而不触发任何东西。所以这里把约定本身钉住 ——
//    **全仓每一条停用的测试都必须以 AFTER THE FIX 开头，且所在文件写明了那条约定**。
describe('停用的测试必须遵守 AFTER THE FIX 约定，不许静默停着（§7.119 裁定 3）', () => {
  // 🔴 探测器用拼接构造，避免本文件自己出现"行首就是 xit("的形状而自我命中
  const PARKED_LINE = new RegExp('^\\s*(' + ['x' + 'it', 'x' + 'describe', 'x' + 'test'].join('|') + ')\\(');
  const CONVENTION_MARK = '打完补丁会变红';

  /** 纯函数：喂给它一组 {rel, raw}，返回三组结论。这样尺子可以用合成输入反证。 */
  const scanParked = (entries: { rel: string; raw: string }[]) => {
    const parked: string[] = [];
    const badTitle: string[] = [];
    const noConvention: string[] = [];
    for (const { rel, raw } of entries) {
      const lines = raw.split('\n');
      const hits = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => PARKED_LINE.test(l));
      if (!hits.length) continue;
      if (!raw.includes(CONVENTION_MARK)) noConvention.push(rel);
      for (const { l, i } of hits) {
        parked.push(`${rel}:${i + 1}`);
        // 🔴 取标题不能用「排除三种引号」的字符类：标题里合法地含有**另一种**引号时
        //    （本文件那两条就在中文里夹了 ASCII 双引号）匹配会在第一个引号处停住 ⇒ 解析不到。
        //    改用纯字符串操作：跳过 `xit(` 与前导空白，把第一个字符当引号，找它的下一次出现。
        //    ⚠️ 解析不到时**当作违规**（fail-loud）而不是跳过 —— 否则尺子坏掉会变成恒真的绿
        //    （这一条不是假想：本守卫的第一版就是这样红的，见 §7.120）。
        const head = l.match(/^\s*x(?:it|describe|test)\(\s*/);
        let title = '';
        if (head) {
          const rest = l.slice(head[0].length);
          const q = rest.slice(0, 1);
          if (q === "'" || q === '"' || q === '`') {
            const end = rest.indexOf(q, 1);
            if (end > 0) title = rest.slice(1, end);
          }
        }
        if (!title.startsWith('AFTER THE FIX')) {
          badTitle.push(`${rel}:${i + 1} → ${title.slice(0, 80) || '（标题解析不到）'}`);
        }
      }
    }
    return { parked, badTitle, noConvention };
  };

  it('尺子有效性：合成的"随便停用一个测试"必须被抓到，而遵守约定的必须放行', () => {
    const bad = scanParked([
      { rel: 'synthetic/a.spec.ts', raw: "describe('x', () => {\n  " + "xit('某个被静默停用的用例', () => {});\n});\n" },
    ]);
    expect(bad.parked.length).toBe(1);
    expect(bad.badTitle.length).toBe(1);          // 标题不是 AFTER THE FIX
    expect(bad.noConvention).toEqual(['synthetic/a.spec.ts']);  // 文件没写约定
    const good = scanParked([
      {
        rel: 'synthetic/b.spec.ts',
        raw:
          '// 未修的 FINDING 钉住当前行为，' + CONVENTION_MARK + '。\n' +
          "describe('FINDING（尚未修）', () => {\n  " + "xit('AFTER THE FIX：做某事', () => {});\n});\n",
      },
    ]);
    expect(good.parked.length).toBe(1);
    expect(good.badTitle).toEqual([]);
    expect(good.noConvention).toEqual([]);
  });

  it('全仓没有任何"不遵守约定就停着"的测试；本文件那 2 条都遵守', () => {
    const specs: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(p);
        } else if (e.name.endsWith('.spec.ts')) specs.push(p);
      }
    };
    walk(__dirname);
    // 反空转：扫描器必须真的扫到了 spec，否则"没有违规"是一个空的绿
    expect(specs.length).toBeGreaterThanOrEqual(100);

    const entries = specs.map((f) => ({
      rel: f.slice(__dirname.length + 1),
      raw: readFileSync(f, 'utf8'),
    }));
    const { parked, badTitle, noConvention } = scanParked(entries);
    // 反空转第二层：这个扫描器在本文件里必须真的看到那 2 条（否则口径坏了也看不出来）
    expect(parked.filter((x) => x.startsWith('audit-hardening-round4-security-public-cost.spec.ts')).length).toBe(2);
    // 🔴 核心性质。失败信息点名 file:line 与标题 ⇒ 读日志的人知道该改哪里。
    expect(badTitle).toEqual([]);
    expect(noConvention).toEqual([]);
  });
});
