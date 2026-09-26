/**
 * 🔴 i18n 硬编码棘轮（照 scripts/tests/strict-null-ratchet.test.sh 的先例形状）
 *
 * ## 为什么需要它
 * 多语言改造的最大风险不是"翻不完"，而是**腐烂**：每翻译完一个文件，下一个人加新功能时
 * 又会写回硬编码中文，而没有守卫会红。本仓库已经反复证明"没有守卫的约定会漂"
 * （API Token 默认值六处口径两处错、api.md 限流表漏掉一整个桶、一个分页闸门在 docs/ 里一次都没提过）。
 *
 * ## 判据
 * 对**已经接入 i18n 的文件**（下面 TRANSLATED_FILES 清单），用 AST 数出
 * 「**没有被包在 t()/formatMessage() 的 defaultMessage 位、也不在注释里**」的含中文字面量与 JSX 文本节点，
 * 🔴 **每文件一个预算，只许减少不许增加**。
 *
 * 🔴 **必须用 AST，不能用正则**：正则口径在本项目已被证明不可靠两次
 * （`grep -acE "^\s*'"` 数语言包 key 得 128/117/116，真值 105/105/105；
 *  以及"带引号字面量"正则漏掉 19 条 JSX 文本节点，使语言包从 63 key 补到 82 key）。
 *
 * 🔴 **为什么按"已翻译文件"而不是全仓**：全仓 admin/src 下有 129 个文件、1,887 条待翻译项
 * （实测口径见 vanblog_dev/I18N-ARCHITECTURE-2026-09-25.md），把它们全纳入就是 1,887 条永久红。
 * **假缺口比没守卫更糟 —— 它会训练下一个人忽略红灯。**
 *
 * 🔴 **两处刻意保留的例外，用"反向断言"钉住**（不是靠白名单放过，而是要求它们**必须仍然存在**）：
 *   - `已初始化`：那是**协议字符串**（匹配服务端 HttpException 的文本），翻译了会静默破坏初始化检测；
 *   - `初始化密钥`：那是**要照着敲进 shell 的命令与启动日志标签**（服务端输出的就是简体），
 *     翻译了 `grep` 就抓不到东西；
 *   - `语言 · Language`：那是**静态双语 tooltip**，服务于"还没切语言的人"，刻意不走 t()。
 * 把它们钉成"必须在"，才能防止有人好心把它们"翻译掉"而破坏行为。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 🔴 AST 逻辑不再内联在本文件里，而是 require 仓库内的**唯一权威实现**
//    `scripts/i18n/astInventory.js`（CLI 工具 `scripts/i18n/inventory.js` 用的是同一份）。
// 为什么：此前守卫与一次性分类脚本各有一份 AST 逻辑 ⇒ 🔴 **两处实现同一件事就一定会漂移**。
// 由 `i18nSharedImpl.test.js` 钉住"两边确实共用同一实现"。
// ⚠️ 那个模块内部同样 fail-loud：找不到 @babel/parser 或解析失败都会抛错，
//    🔴 **"解析不到"绝不等于"没有问题"**（跳过就等于给这些文件发永久通行证）。
const astInventory = require('../../../../scripts/i18n/astInventory.js');

const ADMIN = path.resolve(__dirname, '../..');
// 🔴 汉字正则（HAN）也在共享模块里，本文件不再各自定义一份。

/**
 * 🔴 已接入 i18n 的文件 → 裸中文预算（只许减少不许增加）。
 * 基线于 2026-09-25 用 AST 实测取出（排除注释、排除 t()/formatMessage() 的 defaultMessage 位、按文件内去重）。
 * ⚠️ 0 表示"这个文件已经完全翻译干净"，任何新增裸中文都会红。
 */
const BUDGET = {
  // 仍有 18 条：站点 URL 校验那一组的文案尚未翻译（属后续批次的体力活，不是框架问题）
  'src/app.jsx': 18,
  'src/components/ThemeButton/index.tsx': 0,
  'src/components/LogoutButton/index.jsx': 0,
  // 1 条 = 协议字符串「已初始化」，刻意保留（见下面的反向断言）
  'src/pages/InitPage/index.tsx': 1,
  'src/pages/InitPage/RestoreFromBackup.tsx': 0,
  // 4 条 = 要照着敲的命令与启动日志标签，刻意保留简体
  'src/pages/InitPage/setupKeyCore.js': 4,
  // 16 条 = 注入式翻译器的 identity 回落分支（不传 t 时必须返回中文，那是刻意设计）
  'src/pages/InitPage/restoreCore.js': 16,
  // 1 条 = 静态双语 tooltip「语言 · Language」
  'src/pages/user/Login/index.jsx': 1,
  'src/pages/user/Restore/index.jsx': 8,
  // 🔴 期 3 第一批（2026-09-25）：这两个文件已全量接 i18n ⇒ 预算 0，新增硬编码中文会立刻红。
  'src/pages/SystemConfig/tabs/WalineTab.jsx': 0,
  'src/pages/SystemConfig/tabs/ImgTab.jsx': 0,
  // 🔴 期 3 第二批（2026-09-25）：CommentSystem 全量接完 ⇒ 0。
  'src/pages/SystemConfig/tabs/CommentSystem.jsx': 0,
  // 🔴 Customizing 的 4 条 = 那四个**内层页签标签**（自定义 CSS / Script / HTML(body) / HTML(head)）。
  //   它们属**已裁定的暂缓项**，不是漏翻：页签标签是一套跨面"导航路径词汇"（docs 里有一张表逐条列出、
  //   `analysisFields`/`adminCopySync` 把「后台措辞 ↔ 文档措辞」钉在一起），而"文档 i18n"站长尚未裁定
  //   ⇒ 只翻这一侧会造成"界面英文、文档仍中文"的可见不一致（详见手册 §7.139 A）。
  //   ⚠️ 所以这 4 条**刻意不登记进 REQUIRED_EXCEPTIONS**：那张清单的语义是"改掉会破坏行为"
  //   （协议字符串 / 要照着敲的命令 / 静态双语标签），而这 4 条只是**欠着**，tab 那批落地时必须归 0。
  'src/pages/SystemConfig/tabs/Customizing.jsx': 4,
  // 🔴 期 9 第四批（2026-09-26）：回收站抽屉两个文件都已全量接 i18n ⇒ 预算 0。
  //   ⚠️ `recycleCore.js` 是**注入式翻译器**模式（纯 JS、被 node --test 直接 require），
  //   它的中文全部待在 `t()` 的 defaultMessage 位 ⇒ 裸中文 0；
  //   🔴 而"不传 t 时输出与改造前逐字相同"由 `recycleBin.test.js` 的既有 30 条断言钉住（一条都没改就全绿）。
  'src/components/RecycleBin/index.jsx': 0,
  'src/components/RecycleBin/recycleCore.js': 0,
  // 🔴 期 3 第三批（2026-09-26）：SystemConfig 的 Token 与高级设置两个页签全量接完 ⇒ 预算 0。
  //   ⚠️ `Token.tsx` 是 **.tsx** ⇒ 它在 admin 的类型检查门禁范围内（`allowJs:false` 只放过 .js/.jsx），
  //   改它必须保证 `admin-typecheck-ratchet` 不倒退。
  'src/pages/SystemConfig/tabs/Token.tsx': 0,
  'src/pages/SystemConfig/tabs/Advance.jsx': 0,
  // 🔴 期 3 第四批（2026-09-26）：用户设置页签全量接完 ⇒ 预算 0。
  //   ⚠️ 两处**刻意不在本批翻**的中文都不在这个文件里，所以 0 是真的 0：
  //   ① 权限列的权限名来自 `getPermissionLabel()`（CollaboratorModal 的口径）；
  //   ② 口令最短长度提示来自共享常量 `accountPasswordMinRule()`（被 passwordPolicy.test.js 钉着）。
  'src/pages/SystemConfig/tabs/User.jsx': 0,
  // 🔴 期 3 第五批（2026-09-26）：HTTPS 页签（Caddy）33 条里翻了 32 条，**预算 1**。
  //   那 1 条是 🔴 **永久例外**、不是欠条：FAQ 链接的 **URL 锚点**
  //   （`…docs/faq/usage.md#开启了-https-重定向后关不掉`）必须逐字对上中文文档的标题 ——
  //   站长已裁定文档暂不做 i18n（§7.141 A）⇒ 文档仍是中文 ⇒ 锚点翻了就跳不到那一节
  //   （GitHub 的锚点由标题生成）。⚠️ 链接**文字**照翻（那才是给用户看的）；
  //   已登记进 REQUIRED_EXCEPTIONS **反向钉住**（防止将来有人"好心"把它翻掉）。
  'src/pages/SystemConfig/tabs/Caddy.jsx': 1,
  // 🔴 期 4（2026-09-26）：`SiteInfoForm` —— **目前最大的单文件批次**（108 条裸中文 / 150 个替换点）⇒ 预算 0。
  //   用 AST 定位 + 按字符偏移反向替换做的机械化改造（脚本 `vanblog_dev/migrate-siteinfoform.cjs`），
  //   🔴 改完立刻用 `bareChinese` 验证归零、用 `collectTCalls` 验证 150 个调用点都带字面量 defaultMessage。
  //   ⚠️ 两处**刻意不在本批翻**：GA / 百度统计那两个统计 ID 字段的文案来自共享模块 `@/utils/analysisFields`
  //   （被 `analysisFields` 守卫与**文档措辞**钉在一起，属已裁定的暂缓项）⇒ 它们不在这个文件里，所以 0 是真的 0。
  'src/components/SiteInfoForm/index.tsx': 0,
  // 🔴 期 5 第一批（2026-09-26）：`WaterMarkForm`（图床设置里的压缩/水印/缩略图表单）⇒ 预算 0。
  //   同样是 AST 定位 + 偏移替换（脚本 `vanblog_dev/migrate-watermarkform.cjs`），35 个替换点、48 个调用点。
  //   ⚠️ 这批文案里的**数字与技术门槛**（52px / 8px / 320 / 1920 / 8x8 / 4 个色阶 / 200 字节 / 300px / 10KB）
  //   是**契约**：`watermarkText.test.js` 有一条跨包钉子把 52px 与服务端 `utils/watermark.ts` 钉在一起
  //   ⇒ 生成语言包时逐 key 比对了三份的**数字序列**与环境变量名/技术词（sharp、avifenc、WARN、GIF…）。
  'src/components/WaterMarkForm/index.tsx': 0,
  // 🔴 期 5 第一批（同轮追加）：`StaticForm`（存储策略表单）⇒ 预算 0。
  //   与 WaterMarkForm 一起做是为了让**整个「图床设置」页签**不再中英混排（活体探针发现只翻一个的话，
  //   页面上会同时出现「存储策略」与 "Visible watermark"）。
  'src/components/StaticForm/index.tsx': 0,
  // 🔴 期 5 第二批（2026-09-26）：**图片管理页**两份文件一起翻完 ⇒ 都预算 0。
  //   按页面切批次（不是按文件）：只翻 index.tsx 的话，右键「信息」弹窗里的字段名（来自 tools.tsx 的
  //   `mergeMetaInfo`）与复制链接的 toast 仍是中文 ⇒ 半页中文比整页中文更糟。
  //   ⚠️ `tools.tsx` 是**纯函数模块**（`Editor/imgUpload.tsx` 也调它）⇒ 用注入式翻译器：
  //   🔴 不传 t 时输出与改造前逐字相同，所以那个既有调用方一个字都没改。
  'src/pages/Static/img/index.tsx': 0,
  'src/pages/Static/img/tools.tsx': 0,
  // 🔴 期 5 第二批（同轮追加）：`ObjTable`（图片信息弹窗用的键值表，2 条）⇒ 预算 0。
  //   是**活体探针**发现它的：图片管理页翻完后，en-US 下那个弹窗的表头仍是简体「属性/值」
  //   ⇒ 再次印证"批次要按**页面**切"（这一页由 index.tsx + tools.tsx + ObjTable 三块拼成）。
  'src/components/ObjTable/index.tsx': 0,
  // 🔴 期 5 第三批（2026-09-26）：**自定义页面**整页（列表页 + 新建/修改弹窗）⇒ 都预算 0。
  //   ⚠️ `CustomPageModal` 原本是**隐式返回**的箭头组件（`() => (<ModalForm …/>)`），
  //   要用 hook 就得改成块体 + 显式 return（这是本批唯一的结构性改动）。
  'src/pages/CustomPage/index.jsx': 0,
  'src/components/CustomPageModal/index.tsx': 0,
  // 🔴 期 5 第四批（2026-09-26）：**日志管理整页**（index 的三个页签 + 系统/流水线/登录三个子表）⇒ 都预算 0。
  //   ⚠️ `System.tsx` 里那句 `console.error('[系统日志] 拉取失败', err)` **刻意不翻**（开发者界面），
  //   它已经被 bareChinese 的口径排除（见 i18nSharedImpl 那条正负对照），所以这里预算仍然是 0 而**不是 1**。
  //   ⚠️ `Login.jsx` 的 columns 原本是模块级常量 ⇒ 搬进了组件（模块加载期 umi 运行时还没初始化）。
  'src/pages/LogManage/index.jsx': 0,
  'src/pages/LogManage/tabs/Login.jsx': 0,
  'src/pages/LogManage/tabs/Pipeline.tsx': 0,
  'src/pages/LogManage/tabs/System.tsx': 0,
  // 🔴 期 5 第五批（2026-09-26）：**草稿管理页**整页 ⇒ 7 个文件都预算 0。
  //   页面 = index（工具栏/批量操作/表头）+ columes（列与行内操作，`export const columns` 改成
  //   🔴 `export const getColumns = (t)`）+ 新建草稿弹窗 + 导入草稿弹窗 + 三个共用字段组件
  //   （AuthorField / TagSelectField / ExportFormatDropdown）。
  //   ⚠️ 两处**已知中间态**（本轮刻意不动，都记在手册 §7.154）：
  //     · `UpdateModal`(34 条) 与 `PublishDraftModal`(14 条) 共用一大片字段（是否加密/置顶优先级/密码/
  //       是否隐藏/版权声明…）⇒ 与文章页那批一起做，避免同一片文案翻两遍；
  //     · `services/van-blog/{tagTokens,exportFormats,accessPassword}` 是**服务层常量**（各有专门守卫钉着）
  //       ⇒ 属"期 7 services"，本轮不动 ⇒ 切英文时标签字段的占位符/提示、导出格式说明、密码帮助仍是中文。
  'src/pages/Draft/index.jsx': 0,
  'src/pages/Draft/columes.jsx': 0,
  'src/components/NewDraftModal/index.jsx': 0,
  'src/components/ImportDraftModal/index.jsx': 0,
  'src/components/AuthorField/index.tsx': 0,
  'src/components/TagSelectField/index.jsx': 0,
  'src/components/ExportFormatDropdown/index.jsx': 0,
  // 🔴 期 5 第六批（2026-09-26）：文章/草稿的「修改信息」与「发布草稿」两个弹窗。
  //   `PublishDraftModal` 预算 0；`UpdateModal` 预算 **1 = 欠条**（`clearConfirmTitle/Content` 的实参
  //   「这篇文章」，模板本体在服务层 accessPassword.js ⇒ 必须一起翻，见 TOTAL_BUDGET 上面那段账目）。
  //   ⚠️ 这两个弹窗里仍有几处**服务层常量**是中文（PUBLISH_AT_* / PATHNAME_FIELD / PRIVATE_TOGGLE_HINT /
  //   passwordHelp / passwordPlaceholder / CLEAR_PASSWORD_* / TAG_FIELD_* / COVER_FIELD）⇒ 属期 7，本轮不动。
  'src/components/PublishDraftModal/index.jsx': 0,
  // 🔴 期 7 第一批：UpdateModal 的预算 **1 → 0**（§7.155 A 那张跨层欠条已还：实参与模板一起翻了）
  'src/components/UpdateModal/index.tsx': 0,
  // 🔴 期 7 第一批（2026-09-26）：**服务层**纯逻辑模块（访问密码的表单语义与文案）⇒ 预算 0。
  //   解法与 `recycleCore.js` / `Static/img/tools.tsx` 同一套：产文案的函数收尾参 `t = IDENTITY_T`，
  //   🔴 不传 t 时输出与改造前**逐字相同**（Category.jsx 与 accessPassword.test.js 的黄金样本一个字没改）。
  //   ⚠️ 4 个 SCREAMING_CASE 常量保留为"同一份文案的 identity 视图"（`privateToggleHint()` 求值一次），
  //   留给还没接 i18n 的消费方；中文只有一份（在 defaultMessage 里）⇒ 不是两处口径。
  'src/services/van-blog/accessPassword.js': 0,
  // 🔴 期 5 第九批（2026-09-26）：**从正文首图补封面**（弹窗 + 它的服务层）⇒ 都预算 0。
  //   这一批做完，文章管理页工具栏在 en-US 下**一个中文按钮都不剩**（上一轮活体量到的最后一个就是它）。
  //   服务层用注入式翻译器：`summarizeBackfill(data, t = IDENTITY_T)`，
  //   🔴 且它**内部**调 `normalizeBackfillItems(data, t)`（内部也要转发，§7.156 A ③）。
  'src/components/CoverBackfillModal/index.jsx': 0,
  'src/services/van-blog/coverBackfill.js': 0,
  // 🔴 期 5 第七批（2026-09-26）：文章侧两个弹窗 + 题头图字段 ⇒ 都预算 0。
  //   🔴 48 条文案只用了 **9 个新 key**（复用 25 个既有的）—— 前几批把共用字段放 `common.*` 的回报。
  //   ⚠️ `CoverImageField` 的 `COVER_FIELD` 是"**导出对象字面量**"形状 ⇒ 用 §7.156 A 定的解法：
  //   改成 `coverField(t)` 函数 + 保留 `COVER_FIELD = coverField()` 作为 identity 视图（中文只有一份）。
  'src/components/NewArticleModal/index.jsx': 0,
  'src/components/ImportArticleModal/index.jsx': 0,
  'src/components/CoverImageField/index.jsx': 0,
  // 🔴 期 5 第八批（2026-09-26）：**文章管理页**（index + columns）与服务层 `batch.ts`（批量删除确认框）⇒ 都预算 0。
  //   列定义同样用 `getColumns(t)`（与 Draft 那一套完全相同）；`batch.ts` 用注入式翻译器
  //   （`batchDelete(ids, isDraft, t = IDENTITY_T)`），🔴 文章页与草稿页两个调用点都补了 t。
  //   ⚠️ 已知中间态（下一批）：`describeScheduledTag()`（schedule.js）与 `PATHNAME_FIELD`（importPathname.js）
  //   仍是服务层常量 ⇒ 定时状态标签与路径名字段在英文下还是中文；`CoverBackfillModal`(27 条) 也未做。
  'src/pages/Article/index.jsx': 0,
  'src/pages/Article/columns.jsx': 0,
  'src/services/van-blog/batch.ts': 0,
  // 🔴 期 5 第十批（2026-09-26）：**历史版本**（抽屉 UI + `revisionCore.js`）⇒ 都预算 0。
  //   `revisionCore.js` 是注入式翻译器**最大的一单**（7 个常量 + 9 个产文案函数），
  //   而 `revisionHistory.test.js` 有 ~15 条黄金样本直接调它们 ⇒ 🔴 不传 t 时必须逐字相同
  //   （实测：迁移后那 27 条测试全绿，一个字都没改）。
  'src/components/RevisionHistory/index.jsx': 0,
  'src/components/RevisionHistory/revisionCore.js': 0,
  // 🔴 期 7 第二批（2026-09-26）：**服务层字段常量**三个模块 ⇒ 都预算 0。
  //   形状 = §7.157 B 定下的"函数版 + identity 视图"；`PathnameField` 顺带接上 i18n（它本来 0 条，
  //   但文案全部来自 `PATHNAME_FIELD` ⇒ 也必须在这里挂个 0，免得下一个人以为它没接）。
  //   ⚠️ `pages/Editor/index.jsx` 仍调 `describeScheduledTag(x)`（不传 t）⇒ 走 identity、逐字与今天相同，
  //   已登记在 localePackParity 的 NOT_YET_I18N_CONSUMERS 里（Editor 那批落地时要传 t 并从表里删掉）。
  'src/services/van-blog/tagTokens.js': 0,
  'src/services/van-blog/importPathname.js': 0,
  'src/services/van-blog/schedule.js': 0,
  'src/components/PathnameField/index.jsx': 0,
  // 🔴 期 7 第三批（2026-09-26）：**文章导出**（格式常量 + 结果汇总 + 下载流程）⇒ 两个 0、一个 **1**。
  //   那 1 条是 `EXPORT_NOTE_FILENAME = '导出说明.md'` —— **服务端产物的文件名**
  //   （`markdownExport.provider.ts` 里写死的 `relativePath`）⇒ 它是**线路契约**、不是文案，
  //   三种语言的界面都得显示这个字面名，否则用户在压缩包里找不到那个文件。
  //   🔴 所以它不进语言包（文案用 `{note}` 占位符），并且：① 进 REQUIRED_EXCEPTIONS 反向钉住；
  //   ② `exportFormats.test.js` 里有一条**跨层断言**：服务端那个 `relativePath` 改名 ⇒ 这里必须跟着改。
  'src/services/van-blog/exportFormats.js': 1,
  'src/services/van-blog/exportMarkdown.tsx': 0,
  // 🔴 期 7 第四批（2026-09-26）：零散小服务模块 + 两个上传按钮 ⇒ 都预算 0。
  //   `formatTime.js`（未知大小）/ `relativeTime.js`（刚刚、N 秒前…）/ `tool.js`（getRecentTimeDes 转发）/
  //   `check.ts`（演示站禁止）/ `parseMarkdownFile.jsx`（两个导入提示）/ `CopyUploadBtn` / `UploadBtn`。
  //   🔴 做完这批，**文章管理页表面只剩 5 条 / 2 文件**：requestError.js 的 4 条 +
  //   exportFormats.js 那条永久例外（服务端产物文件名）。
  //   ⚠️ requestError.js **单独留一批**：它的 `SESSION_EXPIRED_MESSAGE` 同时是"与服务端比对的线路字面量"
  //   （`raw === …` / `mapped === …`）⇒ 翻译它必须把线路字面量与显示文案拆开，并在 en-US 下重新活体验 401 检测。
  'src/services/van-blog/formatTime.js': 0,
  'src/services/van-blog/relativeTime.js': 0,
  'src/services/van-blog/tool.js': 0,
  'src/services/van-blog/check.ts': 0,
  'src/services/van-blog/parseMarkdownFile.jsx': 0,
  'src/components/CopyUploadBtn/index.tsx': 0,
  'src/components/UploadBtn/index.tsx': 0,
  // 🔴 期 7 第五批（2026-09-26）：全局请求错误提示 ⇒ 预算 **1**（不是 0）。
  //   那 1 条是 `SERVER_SESSION_EXPIRED_TEXT = '登录失效'` —— 🔴 **线路字面量**：
  //   服务端 401 时 `message` 里可能就是这句中文，`isSessionExpiredPayload` 靠它认会话过期。
  //   翻译了它 ⇒ en-US 下 401 检测静默失效（不弹提示、也不再抑制重复弹窗，而且全都不报错）。
  //   ⇒ 显示文案走 `sessionExpiredMessage(t)`，比对走这个常量，**两个东西**。
  //   它进 REQUIRED_EXCEPTIONS 反向钉住（第 6 类例外形状：与别层比对的协议字面量）。
  'src/services/van-blog/requestError.js': 1,
  // 🔴 期 6 第一批（2026-09-26）：**编辑器插件的界面文案**。
  //   移动端工具栏那 11 条**不进语言包**（与上游 bytemd 的 zh_Hans 值逐字相同 ⇒ 直接读 `editorLocale`，
  //   繁中/英文由上游给）；剩下 6 条上游没有 ⇒ 走 `editor.*`，由 `components/Editor/index.tsx` 在渲染期注入 t。
  //   🔴 `customContainer.tsx` 预算 **6**：那 6 条 `:::info{title="相关信息"}` 模板是被**插入用户文章正文**的
  //   Markdown（= 内容，不是界面文案），而且 `customContainerRemark.js` 靠这几个中文标题**识别存量文章**里的容器
  //   ⇒ 翻译它们会让老文章的容器不再渲染、还会往用户正文里写英文（内容 i18n 站长裁定：暂不做）。
  'src/components/Editor/history.tsx': 0,
  'src/components/Editor/emoji.tsx': 0,
  'src/components/Editor/insertMore.tsx': 0,
  'src/components/Editor/plugins/codeBlock.tsx': 0,
  'src/components/Editor/plugins/mobileToolbar.js': 0,
  'src/components/Editor/plugins/customContainer.tsx': 6,
  // 🔴 期 6 第二批（2026-09-26）：编辑器的三个上传/转存插件 ⇒ 都预算 0。
  //   做完这批，🔴 **en-US 的编辑器工具栏一条中文都不剩**（上一批活体登记的那 3 条 tooltip 就是这三个文件）。
  //   ⚠️ 两处**源码笔误**逐字保留（已登记交站长裁定）：`'上传成功！ '` 结尾的空格、`'剪切板没的图片！'`（应为「没有」）。
  //   🔴 `imgUpload.tsx` 现在给 `copyImgLink` 传了 t（第 5 个参数）⇒ 已从 NOT_YET_I18N_CONSUMERS 删掉。
  'src/components/Editor/imgUpload.tsx': 0,
  'src/components/Editor/fileUpload.tsx': 0,
  'src/components/Editor/transferRemote.tsx': 0,
};
// 🔴 48 → 52（2026-09-25 期 3 第二批）：**这是一张欠条，不是新预算。**
//   涨的 4 条全部来自上面 Customizing 那四个暂缓的内层页签标签；期 3 第一批时两个新文件预算都是 0，
//   所以那时总量没动。等"文档 i18n"裁定、tab 那批（外层 11 个 + 内层 4 个）落地后必须还掉。
// 🔴 52 → **53**（2026-09-26 期 3 第五批）：涨的 1 条是 Caddy 页那个 **URL 锚点**，
//   它是 🔴 **永久例外**（文档按站长裁定仍是中文 ⇒ 锚点必须逐字对上中文标题），**不是欠条、不会还**。
//   ⇒ 账目拆开记：🔴 **53 = 48（目标底）+ 4（Customizing 欠条，tab 那批落地时必须归 0）+ 1（Caddy URL 永久例外）**。
// 🔴 53 → 54（2026-09-26 期 5 第六批）：涨的 1 条是 `UpdateModal` 里 `clearConfirmTitle` / `clearConfirmContent`
//   的**实参**「这篇文章」（去重后算 1 条）。它是 🔴 **欠条**，不是永久例外：
//   模板本体在服务层 `accessPassword.js`，🔴 **两处必须一起翻** ——
//   只翻实参会拼出「确定清除this post的访问密码？」这种半截话，比整句中文更糟。
// 🔴 **54 → 53（2026-09-26 期 7 第一批）：上面那张欠条已还。**
//   `accessPassword.js` 接了注入式翻译器，模板改成 ICU `{target}`，实参也走 t
//   （`clearConfirmTitle(t('accessPassword.targetThisArticle', '这篇文章'), t)`）⇒ `UpdateModal` 预算 1 → **0**。
//   ⇒ 账目回到：53 = 48（目标底）+ 4（Customizing 欠条，tab 那批落地时归 0）+ 1（Caddy URL 永久例外）。
// 🔴 **53 → 54（2026-09-26 期 7 第三批）：多出的 1 条是 `exportFormats.js` 的 `导出说明.md`** ——
//   **服务端产物文件名**（线路契约，不是文案），属**永久例外**那一类（与 Caddy URL 同类）：
//   翻译了它，用户在压缩包里就找不到那个文件。⇒ 账目现在是：
//   54 = 48（目标底）+ 4（Customizing 欠条）+ 2（永久例外：Caddy URL、导出说明.md）。
// 🔴 **54 → 55（2026-09-26 期 7 第五批）：多出的 1 条是 `requestError.js` 的 `SERVER_SESSION_EXPIRED_TEXT`**
//   （= '登录失效'）—— **与服务端比对的线路字面量**，属永久例外（与 `已初始化` 同族）。
//   ⇒ 账目现在是：55 = 48（目标底）+ 4（Customizing 欠条）+ 3（永久例外：Caddy URL、导出说明.md、登录失效）。
// 🔴 **55 → 61（2026-09-26 期 6 第一批）：多出的 6 条是 `customContainer.tsx` 的容器模板** ——
//   它们是被**插入用户文章正文**的 Markdown（内容，不是界面文案），而且 `customContainerRemark.js`
//   靠这几个中文标题识别**存量文章**里的容器 ⇒ 属永久例外（内容 i18n 站长裁定：暂不做、也没预留）。
//   ⇒ 账目现在是：🔴 **61 = 48（目标底）+ 4（Customizing 欠条）+ 9（永久例外：Caddy URL 1、导出说明.md 1、
//   登录失效 1、容器模板 6）**。
//   谁再调大这个数字都要在这里写清"涨的是哪几条、是欠条还是永久例外、什么时候还"。
const TOTAL_BUDGET = Object.values(BUDGET).reduce((a, b) => a + b, 0); // = 61

/** 🔴 刻意保留的例外：必须仍然存在（反向钉住，防止被"好心翻译掉"而破坏行为）。 */
const REQUIRED_EXCEPTIONS = [
  { file: 'src/pages/InitPage/index.tsx', text: '已初始化', why: '协议字符串：匹配服务端 HttpException 文本，翻译会静默破坏初始化检测' },
  { file: 'src/pages/InitPage/setupKeyCore.js', text: '初始化密钥', why: '要照着敲进 shell 的命令与启动日志标签；服务端输出就是简体，翻译了 grep 抓不到' },
  { file: 'src/pages/user/Login/index.jsx', text: '语言 · Language', why: '静态双语 tooltip，服务于"还没切语言的人"，刻意不走 t()' },
  // 🔴 期 6 第一批新增（第 7 类例外形状：**被插入用户文章正文的 Markdown 模板**）
  //   这 6 条与 `customContainerRemark.js` 的 5 个标题是**同一套契约的两端**：一端写进文章、一端负责识别
  //   ⇒ 只改一边，存量文章的容器就不再渲染（跨文件断言在 i18nEditorLocaleFollows.test.js）。
  {
    file: 'src/components/Editor/plugins/customContainer.tsx',
    text: ':::info{title="相关信息"}',
    why: '插入用户文章正文的 Markdown 模板（= 内容）；customContainerRemark.js 靠这个中文标题识别存量文章的容器',
  },
  // 🔴 期 7 第五批新增（第 6 类例外形状：**与别层比对的协议字面量**）
  {
    file: 'src/services/van-blog/requestError.js',
    text: '登录失效',
    why:
      '服务端 401 时 message 里可能就是这句中文，isSessionExpiredPayload / isSessionExpiredError 靠它认会话过期；' +
      '翻译了它 ⇒ en-US 下 401 检测静默失效（显示文案已拆成 request.sessionExpired 走 t）。',
  },
  // 🔴 期 7 第三批新增（第 5 类例外形状：**服务端产物的文件名**）
  {
    file: 'src/services/van-blog/exportFormats.js',
    text: '导出说明.md',
    why:
      '服务端把它写进 zip（markdownExport.provider.ts 的 relativePath）⇒ 是线路契约不是文案；' +
      '界面三种语言都要显示这个字面名，否则用户在压缩包里找不到它。跨层断言在 exportFormats.test.js。',
  },
  { file: 'src/pages/user/Restore/index.jsx', text: '语言 · Language', why: '同上' },
  // 🔴 期 3 第五批（2026-09-26）新增：**URL 锚点**也必须逐字是中文（这是第 4 类例外形状：
  //    前三类是协议字符串 / 要照着敲的命令 / 静态双语标签，这一类是"指向中文文档的锚点"）
  {
    file: 'src/pages/SystemConfig/tabs/Caddy.jsx',
    text: 'usage.md#开启了-https-重定向后关不掉',
    why:
      'URL 锚点：必须逐字对上 docs/faq/usage.md 里的中文标题（站长已裁定文档暂不做 i18n，文档仍是中文）；' +
      '翻成英文就跳不到那一节（GitHub 的锚点由标题生成）',
  },
];

/**
 * 数出一个文件里"裸中文"的去重条数。
 *
 * 🔴 **实现不在这个文件里** —— 它是 `scripts/i18n/astInventory.js` 的 `bareChineseFromFile()`，
 *    与 CLI 工具 `scripts/i18n/inventory.js` **共用同一份 AST 实现**（一个性质只留一处权威口径）。
 *    由 `i18nSharedImpl.test.js` 钉住这件事。
 *
 * 语义（在共享模块里实现，这里只记录口径，避免两处描述漂移）：
 * 🔴 排除注释、排除 `t()`/`formatMessage()` 的**第 2 个实参**（defaultMessage 位）、
 *    以及对象字面量里 key 名为 `defaultMessage` 的属性值 —— 那些是**刻意保留的中文**，不是"未翻译"。
 * ⚠️ 那个 `index === 1` 极易写反（写成 0 就会把 id 跳过、把 defaultMessage 算进来，
 *    本文件第一版就是这么错的，实测把 ThemeButton 报成 3 条而真值是 0）⇒
 *    🔴 共享模块里保留了这个警告，本文件的"尺子自证"断言（已翻干净的文件必须是 0）也仍然守着它。
 */
function countBare(rel) {
  const abs = path.join(ADMIN, rel);
  // 🔴 fail-loud：文件不存在 / 解析失败都会抛错，绝不当成"0 条"
  return astInventory.bareChineseFromFile(abs, rel);
}

test('i18n 棘轮 · 反空转：清单里的文件全部真实存在且内容正常', () => {
  const files = Object.keys(BUDGET);
  assert.ok(files.length >= 9, `清单至少应有 9 个文件，实际 ${files.length}（清单被清空 ⇒ 守卫会退化成恒真）`);
  for (const rel of files) {
    const abs = path.join(ADMIN, rel);
    assert.ok(fs.existsSync(abs), `文件不存在：${rel}`);
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.length > 200, `${rel} 内容异常短（${src.length} 字节），可能读错了文件`);
  }
});

test('i18n 棘轮 · 尺子自证：已知含裸中文的必须数得出，已翻干净的必须是 0', () => {
  // 🔴 反向验证尺子：src/app.jsx 明明含未翻译文案，必须数得出东西（否则守卫恒真）
  assert.ok(countBare('src/app.jsx').size > 0, '尺子失效：src/app.jsx 含未翻译的中文文案，却数出 0 条');
  // 🔴 正向验证"排除 defaultMessage 位"真的生效：这三个文件已翻译干净，必须是 0
  for (const rel of [
    'src/components/ThemeButton/index.tsx',
    'src/components/LogoutButton/index.jsx',
    'src/pages/InitPage/RestoreFromBackup.tsx',
  ]) {
    assert.strictEqual(
      countBare(rel).size,
      0,
      `${rel} 应当已翻译干净（0 条裸中文）；若不为 0，说明"排除 defaultMessage 位"的判据失效了`,
    );
  }
});

test('i18n 棘轮 · 逐文件：裸中文条数不得超过预算（只许减不许增）', () => {
  const over = [];
  for (const [rel, budget] of Object.entries(BUDGET)) {
    const n = countBare(rel).size;
    if (n > budget) over.push(`${rel}: 实际 ${n} > 预算 ${budget}`);
  }
  assert.deepStrictEqual(
    over,
    [],
    '🔴 已翻译的文件里出现了新的硬编码中文（棘轮只许减不许增）：\n  ' +
      over.join('\n  ') +
      "\n修法：把新增的中文改成 t('<命名空间>.<key>', '<中文默认文案>') 并同步三份语言包；" +
      '\n如果这条中文是刻意保留的例外（协议字符串 / 要照着敲的命令 / 静态双语标签），' +
      '\n请在 REQUIRED_EXCEPTIONS 里登记理由并同步调高该文件预算。',
  );
});

test('i18n 棘轮 · 总量：全部已翻译文件的裸中文总数不得超过基线', () => {
  let total = 0;
  for (const rel of Object.keys(BUDGET)) total += countBare(rel).size;
  assert.ok(total <= TOTAL_BUDGET, `裸中文总数 ${total} 超过基线 ${TOTAL_BUDGET}（翻译进度在倒退）`);
});

test('i18n 棘轮 · 反向钉住刻意保留的例外：它们必须仍然存在', () => {
  const missing = [];
  for (const ex of REQUIRED_EXCEPTIONS) {
    const items = countBare(ex.file);
    const hit = [...items].some((s) => s.includes(ex.text));
    if (!hit) missing.push(`${ex.file} 里找不到「${ex.text}」（理由：${ex.why}）`);
  }
  assert.deepStrictEqual(
    missing,
    [],
    '🔴 刻意保留的例外被改掉了 —— 它们不是"漏翻译"，改掉会破坏行为：\n  ' + missing.join('\n  '),
  );
});

test('i18n 棘轮 · 预算不得被悄悄放宽：清单条数与总预算都钉死', () => {
  // 🔴 9 → 11（2026-09-25 期 3 第一批）：新增 `SystemConfig/tabs/WalineTab.jsx` 与
  //   `SystemConfig/tabs/ImgTab.jsx`，两者都**已全量接 i18n ⇒ 预算 0** ⇒ 总预算不变（48）。
  // 🔴 11 → 13（2026-09-25 期 3 第二批）：新增 `CommentSystem.jsx`（预算 0）与 `Customizing.jsx`
  //   （预算 4 = 四个**已裁定暂缓**的内层页签标签）⇒ 总预算 48 → 52，那是**欠条**，理由与还款条件
  //   写在 TOTAL_BUDGET 上面那段注释里（🔴 调大总预算必须在那里写清"涨的是哪几条、什么时候还"）。
  assert.strictEqual(Object.keys(BUDGET).length, 74, '清单文件数变了 ⇒ 必须是有意的，并要在注释里说明');
  // 🔴 52 → 53：涨的 1 条是 Caddy 页的 URL 锚点，属**永久例外**（理由写在 BUDGET 与 TOTAL_BUDGET 的注释里）
  // 🔴 53 → 54（2026-09-26 期 5 第六批）：涨的 1 条是 `UpdateModal` 的**欠条** ——
  //   `clearConfirmTitle` / `clearConfirmContent` 的实参「这篇文章」，模板本体在服务层 accessPassword.js，
  //   🔴 两处必须一起翻（只翻实参会拼出「确定清除this post的访问密码？」这种半截话）。
  //   **还款条件**：accessPassword.js 那批落地时一起改，预算归 0、TOTAL 回到 53。
  // 🔴 54 → 53：UpdateModal 那张跨层欠条**已还**（期 7 第一批），账目见 TOTAL_BUDGET 上面那段
  // 🔴 53 → 54（2026-09-26 期 7 第三批）：涨的 1 条是 `exportFormats.js` 的 `EXPORT_NOTE_FILENAME = '导出说明.md'`
  //   —— **服务端产物的文件名**（`markdownExport.provider.ts` 写死的 `relativePath`），属**永久例外**（与 Caddy URL 同类）：
  //   翻译了它，用户在压缩包里就找不到那个文件。它已进 REQUIRED_EXCEPTIONS（反向钉住），
  //   而且 `exportFormats.test.js` 有一条**跨层断言**盯着服务端那个名字。
  assert.strictEqual(TOTAL_BUDGET, 61, '总预算变了 ⇒ 只允许调小；调大需要在注释里写明理由');
  // 🔴 4 → **5**（2026-09-26 期 3 第五批）：新增第 4 类例外形状 —— **指向中文文档的 URL 锚点**
  //   （Caddy 页那条 FAQ 链接；前三类是协议字符串 / 要照着敲的命令 / 静态双语标签）。
  // 🔴 5 → **6**（2026-09-26 期 7 第三批）：新增第 5 类例外形状 —— **服务端产物的文件名**
  //   （`exportFormats.js` 的 `导出说明.md`；前四类是协议字符串 / 要照着敲的命令 / 静态双语标签 / 中文文档 URL 锚点）。
  //   🔴 它同时被 `exportFormats.test.js` 的**跨层断言**盯着：服务端那个 `relativePath` 改名 ⇒ 两边一起改。
  // 🔴 6 → **7**（期 7 第五批）：新增第 6 类例外形状 —— **与别层比对的协议字面量**
  //   （`requestError.js` 的 `SERVER_SESSION_EXPIRED_TEXT`；前五类：协议字符串 / 要照着敲的命令 /
  //   静态双语标签 / 中文文档 URL 锚点 / 服务端产物文件名）。
  assert.strictEqual(REQUIRED_EXCEPTIONS.length, 8, '例外清单条数变了 ⇒ 必须是有意的');
});
