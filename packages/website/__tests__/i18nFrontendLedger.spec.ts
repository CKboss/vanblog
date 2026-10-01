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
  kind: "permanent" | "iou" | "seamed";
  /**
   * 🔴 `kind: "seamed"` 专用：这个文件里**已经过接缝**的条数（它们剩下的中文是
   * `t(ID, 默认值)` 里的**默认值**，尺子仍然数得到，但性质已经变了 —— 不再是"硬编码文案"）。
   * 判据会**逐条验证**：文件里必须真的能找到 `t(<某个 ID>, <这个常量>)` 的调用，
   * 否则就是"我声称接了接缝，其实没接"（🔴 这是最危险的假账：数字看起来在降，实际没接上）。
   */
  seamWired?: number;
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
    file: "utils/applyFrontLocale.ts",
    count: 4,
    kind: "permanent",
    why:
      "🔴 **语言自称（endonym），故意不翻**：这 4 条是 `简` / `繁` / `繁體中文` / `简体中文` —— " +
      "语言切换按钮上显示的**当前语种名字**。它们必须**用那种语言自己的写法**，" +
      "否则会出现「要读得懂这个按钮，先得懂它指向的那种语言」的鸡生蛋问题" +
      "（例：界面是英文时，按钮若显示 `Traditional Chinese`，繁体用户反而找不到入口；" +
      "显示 `繁體中文` 他一眼就认得）。这是语言切换器的通用做法，不是漏翻。" +
      "⚠️ 对照：同一个组件的 `aria-label`（「切换语言：当前 X，点击切换到 Y」）" +
      "**是**界面文案 ⇒ 它走接缝（`locale.switcher`，词典里有译文）；" +
      "🔴 **短标签是数据、aria-label 是文案**，两者性质不同，别一并处理。",
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
    file: "components/Footer/index.tsx",
    count: 1,
    kind: "permanent",
    why:
      "🔴 **期 10 第十一批：6 条已迁走，剩下的 1 条是永久例外** —— 它是一个 **URL**：" +
      "`https://github.com/CKboss/vanblog/blob/dev/dsh/README.md#出处与许可`。" +
      "🔴 那个 `#出处与许可` 是 **GitHub 上真实存在的中文标题锚点**（README 里那个小节就叫「出处与许可」）⇒ " +
      "**绝不能翻译**：翻了就是一个不存在的锚点（浏览器会跳到页面顶部，访客以为「文档里没有这一节」）。" +
      "它是**链接的一部分**，不是界面文案。" +
      "⚠️ 尺子（bareChinese）会把它数成一条裸中文 ⇒ 所以在这里登记为永久例外并写明理由；" +
      "代码里那一行上方也写了同样的理由（免得下一个人以为是漏翻）。" +
      "👉 🔴 一般化：**URL / 文件名 / 锚点里的中文属于「标识符」，不是文案** —— " +
      "同类还有服务端那个 `导出说明.md`（产物文件名）。判据是「改了它会不会**指向另一个东西**」：" +
      "会 ⇒ 标识符，不翻；不会 ⇒ 文案，翻。",
  },
  {
    file: "components/SearchCard/index.tsx",
    count: 7,
    kind: "iou",
    batch: "期 10 第二批",
    why: "🔴 搜索卡片的标题/占位/快捷键提示 ⇒ 访客可见。",
  },
  {
    file: "components/PostCard/titleCopyA11y.ts",
    count: 6,
    kind: "seamed",
    seamWired: 6,
    why:
      "🔴 **期 10 第三批已过接缝**：6 条（3 个 aria-label + 3 个复制成功 toast）现在都是 " +
      "`t(ID, 默认值)` 里的**默认值** —— 常量本身**刻意保留**（它们既是默认文案、又被测试钉住），" +
      "取文案改成 `titleCopyLabel(kind, t)` / `titleCopyToast(kind, t)` / `buildTitleCopyControl(kind, t)`，" +
      "消费方（`PostCard/title.tsx`、`NavBar/index.tsx`）改成传 `useT()` 的结果。" +
      "🔴 **为什么常量不能直接改成 `t(...)` 的求值结果**：模块级常量在 **import 期**就求值，" +
      "那时词典还没注入（`setDictionary` 是运行时调的）⇒ 中文会被**永久固化**进模块，接了词典也没用。" +
      "👉 规矩（本批定下）：**常量留作默认值 + 另加取文案的函数（尾参 `t = IDENTITY_T`）+ 消费方改调函数**。" +
      "⚠️ 尺子仍然把这 6 条数成「裸中文」（它看不出「这个常量被当作 defaultMessage 用了」）⇒ " +
      "所以台账给它一个**独立的 kind**（`seamed`）并用 `seamWired` 逐条验证，而不是把数字改成 0 造假账。",
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
    kind: "seamed",
    seamWired: 1,
    why:
      "🔴 **期 10 第四批已过接缝**：这一族是**一张 map**（`HEADER_ACTION_LABELS = { search, theme, rss, admin, menu }`）" +
      "⇒ map 保留当默认值，另加 `HEADER_ACTION_LABEL_IDS` 与 `headerActionLabel(kind, t = IDENTITY_T)`；" +
      "四个消费方（`NavBar`、`AdminButton`、`RssButton`、`ThemeButton/core`）已改成传 `useT()` 的结果。" +
      "⚠️ `seamWired: 1` 不是「只有 1 条过了接缝」，而是「文件里有 1 处 `t(ID, 默认值)` 形状的调用」—— " +
      "🔴 因为这一族**共用一个取文案函数**（5 个 label 走同一个 `headerActionLabel`），" +
      "所以「接缝处数」与「文案条数」本来就不相等。判据要的是**下限**（≥ seamWired），" +
      "它能抓住「声称接了、其实一处都没有」，但抓不住「5 条里只接了 1 条」⇒ " +
      "🔴 那半边由**哨兵断言**负责（`i18nSeamWiring.spec.ts` 里逐个 kind 都要返回哨兵）。",
  },
  {
    file: "components/PageNav/jump.ts",
    count: 5,
    kind: "seamed",
    // 🔴 `seamWired: 5` 而不是 6：第 6 条（整句模板 `pageNav.jumpSentence`）的默认值是**模板串**
    //    （`t(ID, `${A} {input} ${B}`, { input })`），而 `seamWired` 判据数的是
    //    `t(<ID 常量>, <默认值常量>)` 这个形状 ⇒ 模板串那条数不到。
    //    ⚠️ 我第一版写了 6，被这条判据**当场抓住**（`声称有 6 条…只找到 5 处`）——
    //    🔴 这正是「下限判据」该有的行为：**宁可让我把数字改小、也不许我随口写个大数**。
    //    （那第 6 条由 `i18nSeamWiring.spec.ts` 的哨兵断言负责，它连模板串那条一起验。）
    seamWired: 5,
    why:
      "🔴 分页跳转的提示与校验文案（「请输入页码」/「超出范围」）⇒ 访客可见。纯函数模块 ⇒ 注入尾参。" +
      "🔴 **期 10 第七批已过接缝**：5 条常量（跳转到页码 / 跳转 / 页 / 页码 / 前往）现在都由取文案函数取(`pageNavJumpLabel(t)` 等)，`seamWired: 6` 是因为还多一条**整句模板** `pageNav.jumpSentence`（`跳转 {input} 页` → `Go to page {input}`）。" +
      "🔴 两个消费方都接上了：① `PageNav/render.tsx` 的 `PageNavJump` 是**组件** ⇒ 在里面调 `useT()`；② `SearchResults/jumpForm.ts` 的 `describeSearchJumpForm()` 是**纯函数描述符工厂**（不是组件）⇒ hook 不能在里面调，`t` 由 `SearchResults/index.tsx` 传进去（注入尾参）。" +
      "⚠️ 那两个常量 `PREFIX`（跳转）与 `UNIT`（页）是**拼接式**文案的两半 ⇒ 🔴 英文语序不同（`Go to page [input]`），**只翻这两半永远拼不对** ⇒ 所以额外给了整句模板 `pageNavJumpSentence(input, t)`；两个常量保留是给「已经在用它们的旧渲染路径」兜底（接缝期它按中文语序拼回来，与今天逐字节相同）。",
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
    file: "components/SearchCard/a11y.ts",
    count: 4,
    kind: "seamed",
    seamWired: 4,
    why:
      "🔴 搜索卡片的无障碍标签 ⇒ 读屏可见。纯函数模块 ⇒ 注入尾参。" +
      "🔴 **期 10 第六批已过接缝**：4 条（对话框 / 输入框 / 清除按钮 / 结果区的无障碍标签与占位符）现在由" +
      "`searchDialogLabel(t)` / `searchInputLabel(t)` / `searchClearLabel(t)` / `searchResultsLabel(t)` 取，" +
      "消费方 `SearchCard/index.tsx` 已改成传 `useT()` 的结果（在 `forwardRef` 的渲染函数内，合法）。" +
      "🔴 浏览器实测（上一批它们还是中文、是台账里的欠条）：切到英文后这 4 个 aria-label 变成" +
      "`Search` / `Search content` / `Clear search` / `Search results`。",
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
    kind: "seamed",
    seamWired: 3,
    why:
      "🔴 目录抽屉的标题与空态 ⇒ 访客可见。纯函数/模型模块 ⇒ 注入尾参。" +
      "🔴 **期 10 第六批已过接缝**：3 条（打开目录 / 关闭目录 / 目录标题）现在由 `tocDrawerOpenLabel(t)` /" +
      "`tocDrawerCloseLabel(t)` / `tocDrawerTitle(t)` 取，消费方 `TocDrawer/index.tsx` 已改成传 `useT()` 的结果。",
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
    kind: "seamed",
    seamWired: 2,
    why:
      "🔴 `全部展开` / `全部收起` ⇒ 访客可见（按钮文案）。纯函数模块 ⇒ 注入尾参。" +
      "🔴 **期 10 第六批已过接缝**：`全部展开` / `全部收起` 现在由 `categoryExpandAllLabel(t)` /" +
      "`categoryCollapseAllLabel(t)` 取，消费方 `CategoryList/index.tsx` 已改成传 `useT()` 的结果。",
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
    why:
      "🔴 **第四批给它加了接缝函数（`codeCopyLabel(t)`），但消费方还没接** —— 原因不是偷懒：" +
      "唯一的消费方 `Markdown/codeBlock.tsx` 是在 **markdown 处理管线里构造 AST 节点**" +
      "（`properties: { ariaLabel: CODE_COPY_LABEL, title: CODE_COPY_LABEL }`），" +
      "🔴 **那里不是 React 渲染期** ⇒ 用不了 hook，也没法就地调 `codeCopyLabel(t)`。" +
      "要接就得把 `t`（或已取好的字符串）从组件**透传进 processor 的配置** ⇒ 一次跨层改造，单独排一批。" +
      "👉 🔴 这是一类新的接缝难点：**文案的使用点不在渲染期**（同类还有 `getStaticProps` 里构造的数据，" +
      "见 `api/getAllData.ts` 那条）。",
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
    kind: "seamed",
    seamWired: 1,
    why:
      "🔴 **期 10 第四批已过接缝**：`LOCKED_ARTICLE_PROMPT`（文章已加密，请输入密码后查看：）保留当默认值，" +
      "另加 `lockedArticlePrompt(t = IDENTITY_T)`，消费方 `UnLockCard/index.tsx` 已改成传 `useT()` 的结果。" +
      "⚠️ 这个组件还会显示**服务端错误消息**（密码错误、限流）⇒ 那部分必须走 `translateServerMessage()`，" +
      "登记在 `components/UnLockCard/index.tsx` 那一条里（6 条，仍是欠条）。",
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
    expect(total).toBeGreaterThan(80);
    const ledgerTotal = LEDGER.reduce((n, e) => n + e.count, 0);
    // 🔴 台账登记的总数必须与实测**完全相等**（不是"不超过"）：
    //    少了说明有条目漏登记，多了说明台账里有死条目 ⇒ 两个方向都要抓。
    expect(ledgerTotal).toBe(total);
  });

  it("棘轮：裸中文总数只许减不许增（预算写死，迁完一批就来下调）", () => {
    // 🔴 251 = 期 10 第三批之后的实测值（第一批 261 → 第二批 253 → 第三批 251；
    //    第二批迁走 8 条，第三批迁走 `PostCard/title.tsx` 的 2 条并把 `titleCopyA11y` 的 6 条接上接缝）。
    //    ⚠️ 每迁一批就要来下调这个预算（棘轮只许减不许增）。
    expect(total).toBeLessThanOrEqual(145);
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
      expect(["iou", "permanent", "seamed"]).toContain(e.kind);
      if (e.kind === "seamed") {
        // 🔴 逐条验证"接缝真的接上了"：文件里必须能找到 `t(<ID 常量>, <默认值常量>)` 这样的调用，
        //    而且数量不少于声称的 `seamWired`。否则就是"声称接了、其实没接"的假账。
        expect(e.seamWired, `${e.file}: kind=seamed 必须写明 seamWired`).toBeTruthy();
        const src = readFileSync(path.join(websiteRoot, e.file), "utf8");
        const wired = Array.from(
          // 🔴 两种形状都要认：`t(ID_CONST, DEFAULT_CONST)`（第三批）与
          //    `t(ID_MAP[kind], DEFAULT_MAP[kind])`（第四批：那一族是**一张 map**，不是一个个常量）
          src.matchAll(
            /\bt\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\s*,\s*[A-Z_][A-Z0-9_]*(?:\[[^\]]*\])?\s*\)/g
          )
        ).length;
        expect(
          wired,
          `${e.file}: 声称有 ${e.seamWired} 条过了接缝，但只找到 ${wired} 处 t(ID, 默认值常量) 的调用`
        ).toBeGreaterThanOrEqual(e.seamWired as number);
      }
    }
    expect(dead).toEqual([]);
  });

  it("🔴 收口状态如实报数：欠条与永久例外各多少（数字变了就要来这里改，改的时候必须重读理由）", () => {
    const perm = LEDGER.filter((e) => e.kind === "permanent");
    const iou = LEDGER.filter((e) => e.kind === "iou");
    const permCount = perm.reduce((n, e) => n + e.count, 0);
    const iouCount = iou.reduce((n, e) => n + e.count, 0);
    // 🔴 口径（期 10 第十一批更新）：**145** 条 = 永久例外 **38** + 欠条 **81** + **已过接缝的默认值 26**。
    //    第十一批销账 5 个文件（`UnLockCard/index.tsx` 6 + `CopyRight` 6 + `ThemeButton/core` 5 +
    //    `404` 4 + `PostCard/index.tsx` 2 = 23 条），并把 `Footer` 的 7 条迁走 6 条、
    //    剩下 1 条（GitHub 锚点 URL）改判**永久例外** ⇒ 174 - 23 - 6 = 145，permanent 37 → 38。
    //    第九批**销账前台最大的单文件**：`components/Comment/index.tsx`（44 条，现在裸中文 **0**）
    //    ⇒ 218 - 44 = 174；词条全部进词典（39 个新 key，词典共 **105 key ×2**）。
    //    🔴 有一处**刻意没迁**：`new Date(time).toLocaleDateString()`（站长裁定：日期跟浏览器 locale 走），
    //    它是**平台的格式化结果**、不是我们的字符串 ⇒ 尺子也数不到它（没有中文字面量）。
    //    ⚠️ 那 4 条相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）**是**我们的文案 ⇒ 迁了，
    //    并且刻意**没有**复用 `relativeTime.*` 的 key（那边无空格、且没有"30 天后改用日期"的分支
    //    ⇒ 两套措辞与行为都不同，硬凑同一个 key 会造成"改一处、另一处跟着变"）。
    //    第八批**销账两个大文件**：`components/SearchResults/index.tsx`（28 条）与 `pages/search.tsx`（9 条）
    //    ⇒ 这两个文件现在**一条裸中文都没有**（全部改成 `t("search.*", 中文默认值)`），
    //    所以台账里**整条删掉**（🔴 不是把 count 改成 0 —— 留着 0 的条目会让人以为"这个文件还有东西要迁"）。
    //    ⚠️ 这两处的中文默认值现在住在**代码里**（`t()` 的第二参），译文住在 `locales/*.ts`
    //    （27 个新 key，词典共 66 key）⇒ 覆盖率对账判据会把两边对上（缺 key / 孤儿 key / 占位符不一致都会红）。
    //    第七批把 `PageNav/jump.ts` 那 5 条接完（两个消费方：组件里用 `useT()`、纯函数工厂用注入尾参）
    //    ⇒ seamed 21 → 26、欠条 197 → 192；🔴 总数仍不变。
    //    第六批把 3 个族的消费方接完（`SearchCard/a11y` 4 + `TocDrawer/model` 3 + `categoryExpand` 2 = 9 条）
    //    ⇒ seamed 12 → 21、欠条 206 → 197；🔴 **总数仍不变**（常量作为默认值仍在文件里，尺子照数）。
    //    第五批新增的 4 条是 `utils/applyFrontLocale.ts` 里的**语言自称**（`简` / `繁` / `繁體中文` / `简体中文`）
    //    ⇒ 🔴 判为永久例外（endonym 必须用那种语言自己的写法，理由见该条）。
    //    ⚠️ 本批**总数涨了 4**（251 → 255）：这不是退步，而是"新增了一个文件、里面的中文是故意不翻的"⇒
    //    台账如实登记，棘轮预算跟着上调（🔴 上调预算必须在同一条注释里写明原因，否则棘轮就失去意义）。
    //    第四批把 `NavBar/a11y`（5，map 形状）与 `UnLockCard/copy`（1）接上接缝 ⇒ seamed 6 → 12、欠条 212 → 206；
    //    🔴 **总数不变**（常量作为默认值仍在文件里，尺子照数）⇒ 这正是 `seamed` 这个类别存在的理由：
    //    进度体现在"欠条 → seamed"的迁移上，而不是"总数下降"。
    //    第二批迁走 8 条（`relativeTime` 5 + `readingTime` 1 + `timelineMonths` 1 + 那个后缀常量 1）；
    //    第三批迁走 `PostCard/title.tsx` 的 2 条（阅读时间的 title 与「编辑」标签）、
    //    并把 `titleCopyA11y.ts` 的 6 条**接上接缝**（它们仍在计数里，因为尺子数的是"文件里的中文字面量"，
    //    而常量作为 `t()` 的默认值仍然是中文字面量 ⇒ 🔴 用独立的 kind 如实区分，**不是把数字改成 0 造假账**）。
    //    销账方式：迁完的文件**整条删掉**（不是把 count 改成 0）。
    //    33 = 内部不变量 24（`utils/searchIndex.ts`）+ 3（`api/searchIndex.ts`）+ 6（`pages/api/revalidate.ts`，机器消费方）。
    //    228 = 52 个文件里的界面文案（最大三处：`components/Comment` 44、`components/SearchResults` 28、
    //          `pages/search.tsx` 9；其余是导航/页脚/无障碍标签/相对时间/404 等）。
    // ⚠️ 这两个数字**刻意写死**：变了就说明有人迁了一批或新增了文案 ⇒ 两种情况都要求改台账并重读理由。
    expect(permCount).toBe(38);
    const seamed = LEDGER.filter((e) => e.kind === "seamed");
    const seamedCount = seamed.reduce((n, e) => n + e.count, 0);
    expect(iouCount).toBe(81);
    expect(seamedCount).toBe(26);
    expect(permCount + iouCount + seamedCount).toBe(total);
    // 🔴 欠条不许"永远欠着"：每条都点名了批次（上面已断言），且同一批不超过 250 条（前台按文件分批）
    const byBatch = new Map<string, number>();
    for (const e of iou) byBatch.set(e.batch || "?", (byBatch.get(e.batch || "?") || 0) + e.count);
    byBatch.forEach((n, batch) => {
      expect(n, `「${batch}」挂了 ${n} 条欠条`).toBeLessThanOrEqual(250);
    });
  });
});
