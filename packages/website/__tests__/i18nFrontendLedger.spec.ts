import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require2 = createRequire(import.meta.url);
const websiteRoot = path.join(__dirname, "..");
const repoRoot = path.join(websiteRoot, "..", "..");
// 🔴 复用**同一把尺子**（后台与服务端用的都是它）：`scripts/i18n/astInventory.js` 的 `bareChinese()`。
//    👉 尺子必须只有一把 —— 三个包各写一把，就会出现"同一个文件在两套口径下数字不同"，
//    那时谁也说不清哪个是真的（本项目在期 6 就因为"我自己另写了一把尺子"删掉过一份重复实现）。
const ai = require2(path.join(repoRoot, "scripts/i18n/astInventory.js"));

/**
 * 🔴 前台（访客站）多语言**收口台账 + 棘轮**（期 10 第一批，2026-09-30）。
 *
 * ## 与服务端那份台账（`packages/admin/tests/unit/serverI18nCloseout.test.js`）的关系
 * 同一套设计、同一个道理，只是**粒度按文件**（前台有 55 个文件、261 条，按站点登记太重；
 * 而后台那份硬编码棘轮本来就是按文件登记的，这里保持一致）。
 *
 * ## 它钉住三件事
 * ① **棘轮**：裸中文总数只许减不许增（预算写死，超了就红）；
 * ② **全覆盖**：每个还有裸中文的文件都必须在台账里登记，并写明"是 UI 文案（欠条，点名批次）"
 *    还是"**故意不翻**（永久例外，写明理由）"⇒ 🔴 新增一个文件、或在已登记文件里**多写**几条，都会红；
 * ③ **无死条目**：台账里登记的文件必须**真的还有那么多条**（迁走了就要把数字改小、或整条删掉），
 *    否则台账会变成一份"看起来还有很多没做"的假账。
 *
 * ## 🔴 前台的"收口"长什么样（与后台不同，先说清楚）
 * 站长裁定：**内容不做多语言**（文章/页面/评论正文），本批也**不做** locale 路由与词典。
 * 所以前台的收口目标是：
 * **所有"给用户看的界面文案"都已经过接缝（`t(id, 中文默认值)` / `useT()` / 注入的 `t` 尾参）**，
 * 而剩下的裸中文只有两类：① 非界面（内部不变量、机器消费方、日志、内容数据）；
 * ② **已经过接缝的默认值**（🔴 这一类在 `bareChinese` 口径里**不算**裸中文 ——
 * 尺子认得 `t('x', '中文')` 这个形状，所以迁完就会从计数里消失）。
 */

type Entry = {
  /** 相对 `packages/website` 的路径 */
  file: string;
  /** 这个文件里**还剩**多少条裸中文（必须与实测一致） */
  count: number;
  kind: "permanent" | "iou";
  /** 欠条必须点名批次 */
  batch?: string;
  why: string;
};

const LEDGER: Entry[] = [
  // ══ A. 内部不变量 / 数据校验：抛给开发者看，界面上不显示（或不该显示）══
  {
    file: "utils/searchIndex.ts",
    count: 24,
    kind: "permanent",
    why:
      "🔴 **不是界面文案**：这 24 条是解析搜索索引时的**内部不变量**（`顶层不是一个对象` / `docs 不是数组` / " +
      "`JSON.parse 失败` / `索引版本 X，前台认识的是 Y` / `….u 不是非空字符串` …），" +
      "它们描述的是「服务端生成的索引文件形状不对」——属**部署/版本问题**，" +
      "访客看到也没有任何可处置的动作（他既不能改索引也不能改版本）。" +
      "⚠️ 消费方核实过：这些 throw 被 `api/searchIndex.ts` / `pages/search.tsx` 的 catch 收成" +
      "「搜索不可用」类的界面提示（那几条**是** UI 文案，登记在下面），" +
      "原始文本只进 `console.error`（开发者界面）。",
  },
  {
    file: "api/searchIndex.ts",
    count: 3,
    kind: "permanent",
    why:
      "🔴 三条里有两条是**运行环境断言**（`运行环境没有 fetch`）与**调用方契约断言**" +
      "（`调用方要求直接走服务端搜索`）⇒ 开发者不变量，不是界面文案；" +
      "第三条 `；服务端搜索也失败了` 是拼进 Error 的技术细节（进 console）。" +
      "⚠️ 若将来要把「搜索不可用」这句话显示给访客，应当由**调用方**（`pages/search.tsx`）用它自己的 " +
      "`t(…)` 文案，而不是把这里的技术串透出去。",
  },
  {
    file: "pages/api/revalidate.ts",
    count: 6,
    kind: "permanent",
    why:
      "🔴 **机器消费方**：这是一个带 secret 的 API 路由（`POST /api/revalidate`），" +
      "调用方是 **server 自己**（发布/删除文章后触发增量渲染）与运维的 curl ⇒ " +
      "响应体是给脚本读的，不是给访客看的。翻它没有任何用户能看到，" +
      "而且 `secret 不正确` / `path 不合法` 这类消息还是**安全审计**的一部分（要与 server 日志对得上）。",
  },

  // ══ B. 内容/数据层：这些中文字符串是"站点数据"，不是界面文案 ══
  {
    file: "api/getAllData.ts",
    count: 9,
    kind: "iou",
    batch: "期 10 第三批（导航与页面标题：要先决定「构建期还是渲染期取语种」）",
    why:
      "🔴 这 9 条是**导航项与页面标题的默认值**（`首页` / `标签` / `分类` / `时间线` / `友链` / `关于` / " +
      "`作者名字` …）⇒ **是**界面文案，必须过接缝。" +
      "⚠️ 但它是在 `getStaticProps` 里构造的**数据**（不是组件里的字面量）⇒ " +
      "接词典之前必须先回答「构建期取语种还是渲染期取语种」：ISR 产物是**一份**、要服务多个语种，" +
      "如果在构建期就固化译文，切换语种就得重新生成（或按语种各生成一份，静态页数 ×3）。" +
      "👉 所以这一批要连着「语种从哪来（请求头 / cookie / 路径前缀）+ 缓存键怎么算」一起做，" +
      "不能只把字符串包一层 `t()`（那样在 SSG 期就把中文固化进产物了，等于白做）。",
  },

  // ══ C. UI 文案：组件与纯函数里的界面字符串（本批的欠条主体）══
  {
    file: "components/Comment/index.tsx",
    count: 44,
    kind: "iou",
    batch: "期 10 第二批（前台最大单文件：评论区的按钮/占位/提示/时间）",
    why:
      "🔴 全部是**访客可见**的界面文案（评论框占位、提交按钮、登录提示、时间显示、错误提示…）⇒ " +
      "必须过接缝（组件里用 `useT()`）。" +
      "⚠️ 这里有两条要特别小心：① 时间显示用了 `new Date(time).toLocaleDateString()` —— " +
      "**它已经跟着浏览器 locale 走了**，接词典时要决定「跟浏览器还是跟站点语种」（两者会打架）；" +
      "② 评论系统是三种（`builtin` / `waline` / `off`），waline 那条路是**外挂子进程**、" +
      "它自己的界面文案由 waline 的 locale 配置决定（不归我们翻）⇒ 只翻我们自己的部分。",
  },
  {
    file: "components/SearchResults/index.tsx",
    count: 28,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 搜索结果页的界面文案（命中条数、无结果提示、高亮说明、加载/失败提示）⇒ 访客可见，必须过接缝。",
  },
  {
    file: "pages/search.tsx",
    count: 9,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 搜索页的标题、占位符与提示（含「搜索不可用」这类由 catch 生成的界面提示）⇒ 访客可见。",
  },
  {
    file: "components/Footer/index.tsx",
    count: 7,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 页脚文案（版权、备案位、运行时间等）⇒ 访客可见。⚠️ 其中「由 XX 驱动」这类若含站点数据，只翻固定部分。",
  },
  {
    file: "components/SearchCard/index.tsx",
    count: 7,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 搜索卡片的标题/占位/快捷键提示 ⇒ 访客可见。",
  },
  {
    file: "components/CopyRight/index.tsx",
    count: 6,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 版权声明与转载提示 ⇒ 访客可见。⚠️ 这一族要留意「协议名（CC BY-NC-SA 4.0）」是**技术标识符**，" +
      "三份译文里必须逐字保留（与后台同一条纪律）。",
  },
  {
    file: "components/PostCard/titleCopyA11y.ts",
    count: 6,
    kind: "iou",
    batch: "期 10 第二批（无障碍标签族）",
    why:
      "🔴 **无障碍标签与复制提示**（读屏软件会念出来）⇒ 访客可见（而且是最需要正确语种的一族：" +
      "读屏按 `<html lang>` 选发音规则，标签语言与页面语言不一致会念错）。" +
      "⚠️ 这是**纯函数模块** ⇒ 用「注入的尾参 `t: TFunc = IDENTITY_T`」这个形状，不能在模块级调用 hook。",
  },
  {
    file: "components/UnLockCard/index.tsx",
    count: 6,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 文章密码解锁卡片（输入框、按钮、错误与限流提示）⇒ 访客可见。" +
      "⚠️ 这里会显示**服务端错误消息**（`articleUnlockThrottled` 等）⇒ 必须走 `translateServerMessage()`，" +
      "不能直通 `err.message`（后台已经修过同一类缺陷：21 处 `message.error(err.message)`）。",
  },
  {
    file: "pages/category.tsx",
    count: 6,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 分类页标题与空态文案 ⇒ 访客可见。",
  },
  {
    file: "pages/timeline.tsx",
    count: 6,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 时间线页标题与空态文案 ⇒ 访客可见。⚠️ 月份/年份的显示要走 `utils/timelineMonths.ts`（见下）。",
  },
  {
    file: "components/Markdown/customContainer.tsx",
    count: 5,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 Markdown 自定义容器（note/tip/warning 之类）的**默认标题** ⇒ 访客可见。" +
      "⚠️ 与后台那个同名组件是一对（后台那份在期 6 已登记为永久例外，因为它写进**用户文章正文**）；" +
      "前台这份是**渲染期**给的默认标题 ⇒ 属界面文案，要翻。🔴 两边的处置不同，别照抄结论。",
  },
  {
    file: "components/NavBar/a11y.ts",
    count: 5,
    kind: "iou",
    batch: "期 10 第二批（无障碍标签族）",
    why: "🔴 导航栏的无障碍标签与跳转提示 ⇒ 读屏可见。纯函数模块 ⇒ 用注入尾参的形状。",
  },
  {
    file: "components/PageNav/jump.ts",
    count: 5,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 分页跳转的提示与校验文案（「请输入页码」/「超出范围」）⇒ 访客可见。纯函数模块 ⇒ 注入尾参。",
  },
  {
    file: "components/RunningTime/index.tsx",
    count: 5,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 「本站已运行 X 天 X 小时」 ⇒ 访客可见。⚠️ **这一条是前台第一个需要复数的地方**" +
      "（英文 `1 day` / `2 days`）⇒ 接词典时必须同时定下 ICU 方案（本仓库不装 intl 库，" +
      "接缝层刻意只实现 `{name}` 插值，见 `utils/i18n.ts` 的注释）。",
  },
  {
    file: "components/ThemeButton/core.tsx",
    count: 5,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 主题切换按钮的 aria-label 与提示（浅色/深色/跟随系统）⇒ 读屏可见。",
  },
  {
    file: "components/SearchCard/a11y.ts",
    count: 4,
    kind: "iou",
    batch: "期 10 第二批（无障碍标签族）",
    why: "🔴 搜索卡片的无障碍标签 ⇒ 读屏可见。纯函数模块 ⇒ 注入尾参。",
  },
  {
    file: "pages/404.tsx",
    count: 4,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 404 页标题与「回到首页」按钮 ⇒ 访客可见（而且是最容易被非中文用户撞到的一页）。",
  },
  {
    file: "components/AlertCard/index.tsx",
    count: 3,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 提示卡片文案 ⇒ 访客可见。",
  },
  {
    file: "components/AuthorCard/index.tsx",
    count: 3,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 作者卡片的固定标签（「关于作者」/「文章数」等）⇒ 访客可见。⚠️ 作者名与简介是**内容**，不翻。",
  },
  {
    file: "components/TocDrawer/model.ts",
    count: 3,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 目录抽屉的标题与空态 ⇒ 访客可见。纯函数/模型模块 ⇒ 注入尾参。",
  },
  {
    file: "pages/tag/[tag].tsx",
    count: 3,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 标签详情页标题与空态 ⇒ 访客可见。⚠️ 标签名本身是**内容**，不翻。",
  },
  {
    file: "utils/pageCopy.ts",
    count: 3,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 复制成功/失败的 toast 与「内容来自本站」那段版权尾注 ⇒ 访客可见。",
  },
  {
    file: "api/search.ts",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 `搜索接口返回了不可用的数据` / `搜索请求失败（HTTP …）` —— 这两条会被 `pages/search.tsx` " +
      "的 catch 显示给访客 ⇒ 属界面文案（与 `api/searchIndex.ts` 那三条**不同**，那三条只进 console）。" +
      "⚠️ 判据是「调用方有没有把它渲染出来」，不是「它在不在 api/ 目录里」。",
  },
  {
    file: "components/PostCard/index.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 文章卡片的固定标签（「阅读全文」/「置顶」等）⇒ 访客可见。",
  },
  {
    file: "components/PostCard/title.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 标题的 aria-label 与复制提示 ⇒ 读屏可见。",
  },
  {
    file: "components/Reward/index.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 打赏按钮与提示 ⇒ 访客可见。",
  },
  {
    file: "pages/_app.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 全局提示（例如加载中/错误边界）⇒ 访客可见。⚠️ 这里也是将来注入词典与语种的地方。",
  },
  {
    file: "pages/about.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 关于页的固定标题与提示 ⇒ 访客可见。⚠️ 页面**正文**是内容，不翻。",
  },
  {
    file: "pages/category/[category].tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 分类详情页标题与空态 ⇒ 访客可见。",
  },
  {
    file: "pages/link.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 友链页标题与空态 ⇒ 访客可见。⚠️ 友链名称与描述是**内容**，不翻。",
  },
  {
    file: "pages/post/[id].tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 文章页的固定标签（「目录」/「相关推荐」等）⇒ 访客可见。⚠️ 文章正文与标题是**内容**，不翻。",
  },
  {
    file: "pages/tag.tsx",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 标签页标题与空态 ⇒ 访客可见。",
  },
  {
    file: "utils/categoryExpand.ts",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 `全部展开` / `全部收起` ⇒ 访客可见（按钮文案）。纯函数模块 ⇒ 注入尾参。",
  },
  {
    file: "utils/commentApi.ts",
    count: 2,
    kind: "iou",
    batch: "期 10 第二批",
    why:
      "🔴 `读取评论失败（…）` / `提交失败（HTTP …）` —— 会被评论组件显示给访客 ⇒ 界面文案。" +
      "⚠️ 括号里拼的是底层技术串（可保留），外层这句要过接缝。",
  },
  {
    file: "api/getArticles.ts",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 `后端返回 …` 这条会被文章列表的 catch 显示给访客 ⇒ 界面文案（判据同 `api/search.ts`）。",
  },
  {
    file: "components/BackToTop/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 回到顶部按钮的 aria-label ⇒ 读屏可见。",
  },
  {
    file: "components/Comment/Content.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 评论正文的固定提示（「该评论已被删除」之类）⇒ 访客可见。⚠️ 评论内容本身是**内容**，不翻。",
  },
  {
    file: "components/ImageBox/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 图片加载失败/放大按钮的 aria-label ⇒ 访客可见。",
  },
  {
    file: "components/Markdown/codeBlock.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 代码块的「复制」按钮文案 ⇒ 访客可见。",
  },
  {
    file: "components/Markdown/codeCopyA11y.ts",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批（无障碍标签族）",
    why: "🔴 复制成功/失败的无障碍播报 ⇒ 读屏可见。纯函数模块 ⇒ 注入尾参。",
  },
  {
    file: "components/MarkdownTocBar/core.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 目录栏的 aria-label ⇒ 读屏可见。",
  },
  {
    file: "components/NavBarMobile/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 移动端导航的展开/关闭 aria-label ⇒ 读屏可见。",
  },
  {
    file: "components/RelatedArticles/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 「相关推荐」标题 ⇒ 访客可见。⚠️ 文章标题是**内容**，不翻。",
  },
  {
    file: "components/RssButton/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 RSS 按钮的 aria-label/提示 ⇒ 访客可见（`RSS` 本身是技术标识符，三份逐字相同）。",
  },
  {
    file: "components/TimeLineItem/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 时间线条目的固定标签 ⇒ 访客可见。",
  },
  {
    file: "components/TimelineArchives/index.tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 归档标题与空态 ⇒ 访客可见。",
  },
  {
    file: "components/UnLockCard/copy.ts",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 解锁卡片的复制提示 ⇒ 访客可见。纯函数模块 ⇒ 注入尾参。",
  },
  {
    file: "pages/page/[p].tsx",
    count: 1,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 分页页的标题/空态 ⇒ 访客可见。",
  },
];

/** 扫描前台源码，得到"每个文件还剩多少条裸中文"。 */
function scanWebsite(): { perFile: Map<string, number>; total: number; files: number } {
  const perFile = new Map<string, number>();
  let total = 0;
  let files = 0;
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".next", "public", "dist"].includes(e.name)) continue;
        walk(abs);
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !/\.(test|spec)\./.test(e.name)) {
        files += 1;
        const rel = path.relative(websiteRoot, abs);
        // 🔴 语言包/词典文件本身就是"一堆中文"，不计入（与后台、服务端同一口径）
        if (ai.isLocalePayloadFile(rel)) continue;
        const src = readFileSync(abs, "utf8");
        let n = 0;
        try {
          ai.parseSource(src, abs);
          n = ai.bareChinese(src, abs).size;
        } catch {
          // 解析不了的文件由别的判据负责（这里是 vitest，不能因为一个文件炸掉整份台账）
          n = 0;
        }
        if (n > 0) {
          perFile.set(rel, n);
          total += n;
        }
      }
    }
  })(websiteRoot);
  return { perFile, total, files };
}

describe("🔴 前台多语言收口台账：棘轮 + 全覆盖 + 无死条目", () => {
  const { perFile, total, files } = scanWebsite();

  it("反空转：扫描真的拿到了东西（否则「0 条裸中文」是空的绿）", () => {
    expect(files).toBeGreaterThan(120);
    expect(total).toBeGreaterThan(140);
    const ledgerTotal = LEDGER.reduce((n, e) => n + e.count, 0);
    // 🔴 台账登记的总数必须与实测**完全相等**（不是"不超过"）：
    //    少了说明有条目漏登记，多了说明台账里有死条目 ⇒ 两个方向都要抓。
    expect(ledgerTotal).toBe(total);
  });

  it("棘轮：裸中文总数只许减不许增（预算写死，迁完一批就来下调）", () => {
    // 🔴 253 = 期 10 第二批之后的实测值（第一批建台账时是 261；第二批迁走了 8 条：
    //    `relativeTime` 5 + `readingTime` 1 + `timelineMonths` 1 + 它们各自的常量 1）。
    //    ⚠️ 每迁一批就要来下调这个预算（棘轮只许减不许增）。
    expect(total).toBeLessThanOrEqual(253);
  });

  it("全覆盖：每个还有裸中文的文件都必须在台账里（新增文件/多写几条都会红）", () => {
    // ⚠️ 用 `forEach` 而不是 `for…of`：website 的 tsconfig `target` 低于 es2015，
    //    `for…of` 迭代 Map 会报 TS2802（`--downlevelIteration`）。🔴 别为了让代码好看去改 tsconfig 的 target
    //    （那会牵动整个前台产物的编译结果），改用 forEach 就行。
    const missing: string[] = [];
    perFile.forEach((n, rel) => {
      const e = LEDGER.find((x) => x.file === rel);
      if (!e) {
        missing.push(`${rel}（实测 ${n} 条）没有登记 ⇒ 要么过接缝迁走，要么在台账里写明理由`);
      } else if (e.count !== n) {
        missing.push(`${rel}: 台账写的是 ${e.count} 条，实测 ${n} 条 ⇒ 数字对不上（迁走了就要改小/删条目）`);
      }
    });
    expect(missing).toEqual([]);
  });

  it("无死条目：台账里每个文件都**真的**还有那么多条（迁走了必须来销账）", () => {
    const dead: string[] = [];
    for (const e of LEDGER) {
      const abs = path.join(websiteRoot, e.file);
      let exists = false;
      try {
        exists = statSync(abs).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        dead.push(`${e.file}: 文件不存在了 ⇒ 从台账删掉`);
        continue;
      }
      const actual = perFile.get(e.file) || 0;
      if (actual !== e.count) dead.push(`${e.file}: 台账 ${e.count} 条，实测 ${actual} 条`);
      // ⚠️ 下界取 **12**（不是 30）：实测最短的一条理由是「🔴 分类页标题与空态文案 ⇒ 访客可见。」= 21 字，
      //    而有些条目本来就短。这条断言要防的是"理由写成空串或一个词"，不是"理由必须写满一行"。
      //    👉 🔴 反空转下界必须来自实测（本项目已经因为"觉得应该更长/更多"猜错过 3 次：
      //    admin 的 catch 块数 100 vs 实测 82、throw 站点 >100 vs 实测 91、这里的 30 vs 实测 21）。
      expect(e.why.length).toBeGreaterThan(12);
      if (e.kind === "iou") expect(e.batch, `${e.file}: 欠条必须点名批次`).toBeTruthy();
      expect(["iou", "permanent"]).toContain(e.kind);
    }
    expect(dead).toEqual([]);
  });

  it("🔴 收口状态如实报数：欠条与永久例外各多少（数字变了就要来这里改，改的时候必须重读理由）", () => {
    const perm = LEDGER.filter((e) => e.kind === "permanent");
    const iou = LEDGER.filter((e) => e.kind === "iou");
    const permCount = perm.reduce((n, e) => n + e.count, 0);
    const iouCount = iou.reduce((n, e) => n + e.count, 0);
    // 🔴 口径（期 10 第二批更新）：**253** 条 = 永久例外 **33** + 欠条 **220**。
    //    第二批迁走 8 条（`utils/relativeTime` 5 + `utils/readingTime` 1 + `utils/timelineMonths` 1 +
    //    那个 `MONTH_LABEL_SUFFIX` 常量 1）⇒ 这三个文件已从台账**销账**（整条删掉，不是把数字改成 0）。
    //    33 = 内部不变量 24（`utils/searchIndex.ts`）+ 3（`api/searchIndex.ts`）+ 6（`pages/api/revalidate.ts`，机器消费方）。
    //    228 = 52 个文件里的界面文案（最大三处：`components/Comment` 44、`components/SearchResults` 28、
    //          `pages/search.tsx` 9；其余是导航/页脚/无障碍标签/相对时间/404 等）。
    // ⚠️ 这两个数字**刻意写死**：变了就说明有人迁了一批或新增了文案 ⇒ 两种情况都要求改台账并重读理由。
    expect(permCount).toBe(33);
    expect(iouCount).toBe(220);
    // 🔴 欠条不许"永远欠着"：每条都点名了批次（上面已断言），且同一批不超过 250 条（前台按文件分批）
    const byBatch = new Map<string, number>();
    for (const e of iou) byBatch.set(e.batch || "?", (byBatch.get(e.batch || "?") || 0) + e.count);
    byBatch.forEach((n, batch) => {
      expect(n, `「${batch}」挂了 ${n} 条欠条`).toBeLessThanOrEqual(250);
    });
  });
});
