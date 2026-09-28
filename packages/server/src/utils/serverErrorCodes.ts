import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotAcceptableException,
  NotImplementedException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * 🔴 服务端**错误码登记表**（方案 B）：稳定错误码 + 三语文案在 admin 侧，而 `message` **仍然是中文**。
 *
 * ## 为什么需要它（实测口径）
 * 服务端有 **252** 处 `throw` 带中文（146 处只含字符串字面量、97 处只含模板片段、9 处两者都有）
 * 与 **108** 处 `message:` 带中文的返回体（其中 **100** 处在 `throw` 之外，主要是"演示站禁止…"那一族）
 * —— 口径：AST 遍历 `packages/server/src/**\/*.ts`（排除 `*.spec.ts` 与 `test/`，245 个文件、0 解析失败）。
 * 而 admin 的全局 `errorHandler` 与 22 处调用点**直接透出服务端 message** ⇒
 * 🔴 **在不做这件事之前，"后台完全多语言"不可达**：把 admin 那 129 个文件全翻完，
 * 用户仍然会在"操作失败"的那一刻看到中文。
 *
 * ## 机制（三个约束同时成立）
 * 1. 🔴 **`message` 仍是中文，而且与迁移前逐字相同** ⇒ 服务端日志与排障线索不变，
 *    而且**钉住那些中文字面量的既有测试一条都不用改**（本仓库有大量这种锚点）。
 * 2. 🔴 响应体**只多两个字段**：`code`（稳定错误码）与可选的 `params`（插值参数）。
 *    形状其余部分由 Nest 自己决定 —— 实现手法是"先用旧的构造方式造一个探针异常、
 *    取它的 `getResponse()` 当模板、再补两个字段、用**同一个异常类**重新构造"，
 *    所以 `error: 'Not Acceptable'` 这类字段**原样保留**（🔴 手写 body 会把它弄丢）。
 * 3. 🔴 **admin 有码用码、无码回落 `message`** ⇒ 渐进迁移：**任何时刻**都是可用的
 *    （迁移了一个码就多一条能翻译的消息，没迁移的照旧显示中文，不会有"半坏"的中间态）。
 *
 * ## 三处口径的对应关系（谁都不许漂）
 * - 本文件 `SERVER_ERROR_CODES[code].zh` = **服务端返回体里的 message**（权威中文）；
 * - admin 三份语言包里的 `error.<code>` = 该码的三语文案，🔴 其中 **zh-CN 的值必须与上面的 `zh` 逐字相同**
 *   （由 `packages/admin/tests/unit/i18nServerErrorCodes.test.js` 钉住）；
 * - 🔴 **反向**：每个登记的码都必须真的被某处抛出/返回（防死条目），同一条守卫钉住。
 *
 * ## 命名
 * 码会直接变成 admin 的 i18n key（`error.<code>`），所以 🔴 **码里不许有点**、只许 `A-Za-z0-9_-`
 * （`i18nKeyNaming` 钉的是 key 的形状：2–3 段、每段 `[A-Za-z0-9_-]`）。
 * 用 camelCase 的名词短语描述**发生了什么**，不要描述 HTTP 状态（状态在 `Ctor`/`status` 里）。
 */

/** Nest 异常类的最小构造签名（子类只收 body，`HttpException` 还收 status）。 */
type ExceptionCtor = new (...args: any[]) => HttpException;

/** 插值参数：与 react-intl 的 `{name}` 占位符同名，前后端共用一份。 */
export type ServerErrorParams = Record<string, string | number>;

interface ServerErrorEntry {
  /** 🔴 中文消息模板（可含 `{name}` 占位符）。这就是响应体里的 `message`。 */
  zh: string;
  /** 用哪个 Nest 异常类：它同时决定默认状态码与 body 里的 `error` 字段。 */
  Ctor: ExceptionCtor;
  /** 仅当 `Ctor` 是 `HttpException` 本身时必须给（它没有默认状态码）。 */
  status?: number;
}

/**
 * 用工厂函数而不是裸对象字面量：这样每一条都能在**编译期**被检查形状，
 * 同时 `SERVER_ERROR_CODES` 仍保留字面量 key（`keyof typeof` 才是联合类型，
 * 写成 `Record<string, …>` 会退化成 `string`，调用点就没有自动补全与拼写检查了）。
 */
function entry(zh: string, Ctor: ExceptionCtor, status?: number): ServerErrorEntry {
  return { zh, Ctor, status };
}

/**
 * 🔴 两条"密码太短"共用的解释尾巴（管理员 / 协作者各一个码，但这段解释逐字相同）⇒ 一处定义。
 * ⚠️ 里面那句「5 次/300 秒/IP」是**服务端防爆破参数的描述**（与 `utils/rateLimit.ts` 的实际配置对应），
 * 🔴 三份译文都必须保留同样的数字（admin 侧有一条"数字契约"守卫会逐 key 对账）。
 */
const WEAK_PASSWORD_TAIL =
  '弱口令在"5 次/300 秒/IP"的防爆破预算下，用一批代理 IP 仍然可在数小时内撞开，而协作者账号一旦被撞开就能改站点内容。';

export const SERVER_ERROR_CODES = {
  // ── 分类（category.provider.ts，期 9 第一批）──────────────────────────────
  categoryDuplicateOnCreate: entry('分类名重复，无法创建！', NotAcceptableException),
  categoryDeleteNeedsName: entry('删除分类必须带分类名（name 不能为空）。', NotAcceptableException),
  categoryHasArticles: entry('分类已有文章，无法删除！', NotAcceptableException),
  categoryReorderNoPayload: entry('无有效排序信息！', NotAcceptableException),
  categoryNoneToReorder: entry('无分类可排序！', NotAcceptableException),
  categoryUpdateNoPayload: entry('无有效信息，无法修改！', NotAcceptableException),
  categoryOrderInvalid: entry('排序值无效！', NotAcceptableException),
  categoryDuplicateOnUpdate: entry('分类名重复，无法修改！', NotAcceptableException),

  // ── 文章的回收站 / 历史版本 / .mdz 导入（article.controller.ts，期 9 第二批）──────────
  // ⚠️ 这几条的 admin 消费方**目前还会自己组消息**（`components/RecycleBin` 用
  //    `describeRecycleActionFailure()` 拼一句更详细的人话，而不是直接透出服务端 message）
  //    ⇒ 码先登记好、响应体先带上，等那一批组件接上注入式翻译器时直接可用
  //    （🔴 见手册 §7.141 H 记录的"21 处绕过全局 errorHandler 的直通点"）。
  articleImportMdzNoFile: entry('没有收到文件：请用 multipart 上传一个 .mdz（字段名 file）', BadRequestException),
  articleNotInRecycleBin: entry('回收站里没有这篇文章（可能已恢复或已彻底删除）', NotFoundException),
  articlePurgeRequiresRecycleBin: entry('只能彻底删除回收站里的文章（请先移入回收站）', NotFoundException),
  articleNotFoundForRevision: entry('找不到文章（回收站里的文章请先恢复再还原历史版本）', NotFoundException),
  revisionFeatureUnavailable: entry('历史版本功能不可用（RevisionProvider 未注册）', NotFoundException),
  revisionNotFound: entry('找不到这条历史版本（或它不属于这篇文章）', NotFoundException),

  // ── 草稿的回收站（draft.controller.ts，期 9 第二批）──────────────────────────────
  draftNotInRecycleBin: entry('回收站里没有这篇草稿（可能已恢复或已彻底删除）', NotFoundException),
  draftPurgeRequiresRecycleBin: entry('只能彻底删除回收站里的草稿（请先移入回收站）', NotFoundException),

  // ── Markdown 导出归档的下载（export.controller.ts，期 9 第二批）───────────────────
  exportArchiveNameInvalid: entry('非法的归档名', BadRequestException),
  exportArchiveMissing: entry('归档不存在（可能已被清理，请重新导出）', NotFoundException),

  // ── 自定义页面（customPage.provider.ts / customPage.controller.ts，期 9 第三批）──────────
  customPageCreateNeedsPath: entry('创建自定义页面必须带 path（页面路由，例如 /uptime）。收到的请求里没有可用的 path。', BadRequestException),
  customPagePathDuplicate: entry('已有此路由的自定义页面！无法重复创建！', ForbiddenException),
  customPageUpdateNeedsTarget: entry('必须指明要修改哪一个自定义页面：请在请求体里带 `_id`（推荐，改路由时也只有它能命中原来那一行）或 `path`（页面路由，例如 /uptime）。两者都缺失时无法定位目标，服务端已拒绝执行（否则查询条件会退化成"任意一页"）。', BadRequestException),
  customPageDeleteNeedsPath: entry('删除自定义页面必须带 path（页面路由，例如 /uptime）。收到的请求里没有可用的 path，服务端已拒绝执行（否则查询条件会退化成"任意一页"，删掉一个无辜的页面）。', BadRequestException),
  customPageNotFound: entry('未找到该页面！', HttpException, 404),

  // ── 账号与协作者（user.provider.ts / auth.controller.ts，期 9 第三批）──────────────────
  // 🔴 `accountNameInvalid` 一处登记、**两个调用点**（user.provider 与 auth.controller 曾各写一遍同一句话，
  //    那就是"同一性质两处口径"）⇒ 合并成一个码正是登记表的价值。
  // 🔴 期 9 第一批（2026-09-27）：上面那条"刻意不含"的欠条**已还** —— 那 5 处带 `${label}` / `${MIN}` /
  //    `${name}` 的模板消息全部迁进码表（下面 8 个码）。
  //    🔴 `label` 那个坑的解法选了**按 label 拆码**（`adminPasswordXxx` / `collaboratorPasswordXxx`），
  //    而不是 ICU select：`fillServerErrorMessage()` 只做 `{name}` 替换、**不实现 select**
  //    （服务端返回体里的 message 就是这张表的 `zh` 插值结果 ⇒ 用 select 会把 `{kind, select, …}` 原样发给用户）。
  //    👉 于是 `assertAccountPasswordStrength(value, label)` 的第二个参数从**中文字面量**（'管理员'/'协作者'）
  //    改成了**语义 kind**（'admin' | 'collaborator'）—— 🔴 中文当参数值传进消息模板，
  //    英文里就会夹中文（与 admin 侧 `NumSelect d="天"` 那个坑同一个形状：**别把给用户看的文字当协议值**）。
  //    ⚠️ 数字（{min} / {max} / {count}）走 params，不写死在译文里：admin 侧那条"数字契约"守卫会三份包对账。
  adminPasswordEmpty: entry('管理员密码不合法（不能为空，且必须是 {min}-{max} 个字符）', BadRequestException),
  collaboratorPasswordEmpty: entry('协作者密码不合法（不能为空，且必须是 {min}-{max} 个字符）', BadRequestException),
  adminPasswordTooLong: entry('管理员密码不合法（1-{max} 个字符）', BadRequestException),
  collaboratorPasswordTooLong: entry('协作者密码不合法（1-{max} 个字符）', BadRequestException),
  adminPasswordTooShort: entry(
    '管理员密码太短：至少 {min} 个字符（当前 {count} 个）。' + WEAK_PASSWORD_TAIL,
    BadRequestException,
  ),
  collaboratorPasswordTooShort: entry(
    '协作者密码太短：至少 {min} 个字符（当前 {count} 个）。' + WEAK_PASSWORD_TAIL,
    BadRequestException,
  ),
  collaboratorNameTakenByCollaborator: entry(
    '用户名「{name}」已被一个协作者占用，请换一个（管理员与协作者不能同名，否则登录会落到不确定的账号上）',
    BadRequestException,
  ),
  collaboratorNameSameAsAdmin: entry(
    '用户名「{name}」与管理员账号相同，不可用于协作者（否则该用户名登录会落到不确定的账号上）',
    ForbiddenException,
  ),
  collaboratorNameInvalid: entry('协作者用户名不合法（1-50 个字符）', BadRequestException),
  accountNameInvalid: entry('用户名不合法（1-50 个字符）', BadRequestException),
  adminPasswordInvalidNoChange: entry('密码不合法，未做任何修改', BadRequestException),
  collaboratorNameDuplicate: entry('已有为该用户名的协作者，不可重复创建！', ForbiddenException),
  collaboratorPasswordInvalidOnCreate: entry('密码不合法，未创建协作者', BadRequestException),
  collaboratorNotFound: entry('没有此协作者！无法更新！', ForbiddenException),
  collaboratorPasswordInvalidOnUpdate: entry('密码不合法，未修改协作者', BadRequestException),

  // ── 认证与初始化族（auth.controller.ts / init.controller.ts / jwt.strategy.ts / initJwt.ts /
  //    login.guard.ts / init.provider.ts，期 9 第二批）─────────────────────────────
  // 🔴 这一批里**刻意不含** init.controller 的两处 `已初始化`：那是**协议字符串**
  //    （admin 的 `InitPage` 拿它与响应文本比对来判断"站点已初始化"，登记在硬编码棘轮的永久例外里），
  //    译了会让初始化检测静默失效 ⇒ 要改就得**前后端同时**改成按 code 判断，单独排一批。
  // ⚠️ `authBadCredentials` 等几条的 zh 被跨包测试与部署脚本钉住（`requestError.test.js`、
  //    `admin-login-expired.spec.js`、`vanblog-reset.test.sh`）⇒ zh 必须**逐字不变**，
  //    这也是"码表的 zh 就是权威中文"这条设计的价值：迁移不改一个字，那些测试就都还是绿的。
  // 🔴 形状说明：auth.controller 那几处原本是 `new UnauthorizedException({ statusCode: 401, message: '…' })`
  //    （**对象体**，没有 `error` 字段）；改走 `codedError` 之后响应体会多出 Nest 自己算的
  //    `error: 'Unauthorized'` 与我们的 `code`。已核对消费方：admin 的 `isSessionExpiredPayload()`
  //    只看 `statusCode` 与 **`message`**（不看 `error`），部署脚本只匹配 `message` ⇒ 形状变化是安全的，
  //    而且**黄金快照会把新形状钉住**（谁再改就红）。
  initBusySameProcess: entry(
    '已经有一个初始化/恢复正在进行，请等它结束（若那一次成功了，刷新页面即可）',
    HttpException,
    409,
  ),
  initBusyOtherProcess: entry(
    '已经有一个初始化/恢复正在进行（由另一个进程持有锁），请等它结束（若那一次成功了，刷新页面即可）',
    HttpException,
    409,
  ),
  initRestoreBusySameProcess: entry(
    '已经有一个恢复正在进行，请等它结束（完成后刷新页面即可进入后台）',
    HttpException,
    409,
  ),
  initRestoreBusyOtherProcess: entry(
    '已经有一个恢复正在进行（由另一个进程持有锁），请等它结束（完成后刷新页面即可进入后台）',
    HttpException,
    409,
  ),
  initRestoreAlreadyInitialized: entry(
    '站点已经初始化过了：这条接口只对全新站点开放，请登录后到「备份与恢复」里恢复',
    HttpException,
    403,
  ),
  initRestoreNeedsFile: entry('请上传整站备份文件（multipart 字段名 file）', BadRequestException),
  initRestoreBadArchiveName: entry(
    '文件名不像是本功能导出的整站备份（应形如 vanblog-full-20260913-140955.tar.zst），收到：{name}',
    BadRequestException,
  ),
  // 🔴 这两条的 zh 写成**单引号字符串的 `+` 拼接**，不用模板字符串：
  //    码表解析器（`astInventory.resolveConstString`）认字面量 / 模块级字符串常量 / 二者拼接，
  //    **不认 TemplateLiteral** ⇒ 用模板字符串它会 fail-loud（本轮实测就是这么被拦下来的）。
  //    ⚠️ 反引号在单引号字符串里**不需要**转义（原调用点写在模板字符串里才要 `` \.sig ``）。
  initRestoreSigTooLarge: entry(
    'signature 字段太大了（{size} 字节，上限 {max}）：' +
      '.sig' +
      ' 是一份几百字节的 JSON，请确认你上传的是归档旁边那个 ' +
      '`.sig` 文件本身，而不是归档或别的文件',
    BadRequestException,
  ),
  initRestoreSigNotOurs: entry(
    'signature 字段不是本功能生成的 `.sig`（应是一份含 magic={magic} 的 JSON）：' +
      '请上传归档**旁边**那个同名 `.sig` 文件的内容（curl 用 -F "signature=<路径>"）。' +
      '⚠️ 如果你手上没有 `.sig`，就**不要**带这个字段 —— 不带它恢复照常进行，只是无法证明归档没被换过',
    BadRequestException,
  ),
  authBadCredentials: entry('用户名或密码错误！', UnauthorizedException),
  authNoCredentials: entry('无登录凭证！', UnauthorizedException),
  authRestoreRateLimited: entry('恢复接口调用过于频繁，请稍后再试', HttpException, 429),
  authRestoreKeyUnavailable: entry('恢复密钥错误！', UnauthorizedException),
  authRestoreKeyInvalid: entry('恢复密钥错误！', UnauthorizedException),
  jwtAdminMissing: entry(
    '管理员账号不存在（库里没有 id=0 的用户）：站点数据可能已损坏，或被恢复成了一份空/坏的备份',
    UnauthorizedException,
  ),
  jwtBadSubject: entry(
    '令牌缺少有效的用户标识（sub 不是整数）：站点数据可能已损坏，或该令牌由旧版本签发。请重新登录以获取新令牌',
    UnauthorizedException,
  ),
  jwtCollaboratorGone: entry('该协作者已不存在', UnauthorizedException),
  jwtSecretMissing: entry(
    '当前库里还没有 JWT 密钥（站点可能尚未初始化）：请先完成初始化，再考虑轮换。',
    BadRequestException,
  ),
  jwtSecretRotateConflict: entry(
    'JWT 密钥在轮换过程中被另一个请求改动了（CAS 未命中）：请重新加载页面后再试一次。',
    BadRequestException,
  ),
  loginThrottled: entry('错误次数过多！请 {seconds} 秒后再试！', UnauthorizedException),
  // 🔴 用 BadRequestException：这是**迁移前那处的实际类型**（`throw new BadRequestException('初始化失败')`）。
  //    黄金快照的意义就是"迁移不许悄悄改状态码"⇒ 先照抄，要改状态码得单独论证并同步快照。
  initFailed: entry('初始化失败', BadRequestException),

  // ── 评论族（comment.provider.ts，期 9 第三批）────────────────────────────────
  // 🔴 这一族**大多数是访客可见**的（前台评论表单的拒绝原因）：错误码先到位，
  //    前台（访客站）的多语言是**另一批工作**，届时直接按 code 取译文即可 ——
  //    ⚠️ 前台目前仍显示服务端返回的中文（与今天逐字相同，没有回归）。
  //    后台侧会显示的是评论管理那几条（`commentNotFound` 等）。
  // 🔴 zh **逐字照抄**迁移前的文本：`audit-hardening-round4-fixes-comment.spec.ts` 用
  //    `rejects.toThrow(/今天评论太多了/)` 这类**行为断言**钉着它们 ⇒ 迁移不许改一个字。
  // ⚠️ 两处重复文本各**共用一个码**（`个人主页地址只支持 http/https` 有两个调用点、
  //    `评论不存在` 有两个调用点）：同一句话登记两遍就是"两处口径"，迟早漂。
  // ── 演示站守卫族（各 admin controller 的 `return { statusCode: 401, message: … }`，期 9 第七批）────
  // 🔴 这是**单批覆盖最多站点**的一族：88 处（8 种文案）⇒ 8 个码。
  //    形状是"HTTP 200 + 响应体里的 statusCode:401"（VanBlog 的既有约定，`vanblog-drill.test.sh`
  //    专门有一条钉住"演示站信封必须被判失败"）⇒ 用 **`codedBody()`**（返回体）而不是 `codedError()`（抛异常），
  //    HTTP 状态码因此**保持 200 不变**，只是响应体多出 `code`。
  // ⚠️ `UnauthorizedException` 只用来让 `codedBody` 算出 `statusCode: 401`（与迁移前逐字相同）。
  // 🔴 8 种文案刻意**不合并成一个码**：它们分别对应"改文章/删文章/建文章/发草稿/改口令/改登录安全策略/
  //    改定制化/其它"，合并之后英文就只能说 "Not allowed"，站长看不出**哪一类操作**被演示站挡住了。
  // ── 主题读取 / 路径别名 / 落盘文件名 / 公开接口限流 / 备份文件名（期 9 第八批）──────────
  // 🔴 这一批**刻意不含**两类：
  //   ① `public.controller.ts` 的 `throw new TypeError('publicListCacheKey: 未知的 kind…')` ——
  //      那是**开发者不变量**（注释写明"不要静默降级成一个共用键"），不是给用户看的文案，
  //      它会以 500 的形式暴露给运维而不是站长 ⇒ 与 `queryFilter.ts` / `meta.provider.ts` 那几条同类，
  //      统一留待"开发者不变量要不要改英文"那次裁定；
  //   ② `fullBackup.provider.ts` 的 `整站备份校验失败：{message}（归档已保留：{name}）` ——
  //      🔴 那个 `{message}` 本身是 `backupVerify.ts` 里**若干条中文校验结论**拼出来的
  //      （`issues.map(i => `[${i.check}] ${i.message}`).join('；')`），而这些结论**同时会被写进
  //      校验报告文件**（产物内容）⇒ 只翻外壳会得到"英文外壳 + 中文内核"的半截译文。
  //      必须连 `backupVerify` 的报告形状一起改（`reason: string` → `code + params`），单独排一批。
  // ── 访问密码 / 改写 baseUrl / 附件 / 路径别名 / 图片压缩 / 非法路径 / 流水线 id / 定时发布（期 9 第九批）──
  // 🔴 `assertHttpBaseUrl(raw, label)` 的 `label` 原来是**中文**（'旧地址' / '新地址'）⇒ 按 label **拆成 6 个码**
  //    （第 6 次处理"中文当参数传"这个形状；服务端的填充器不实现 ICU select，所以一律拆码）。
  // 🔴 `customPagePath.ts` 与 `pipeline.provider.ts` 抛的是**同一句**「非法路径」⇒ 共用 `illegalPath` 一个码。
  // ⚠️ 刻意**不含**三处开发者不变量：`thumbnail.ts`（"生成成功就必须有 buffer"这个不变量被破坏）、
  //    `backupCodec.ts`（解析不出 BSON 构造器）、`public.controller.ts` 的 `publicListCacheKey: 未知的 kind`
  //    —— 它们是给运维/开发者看的（消息里带函数名或内部字段名），等"开发者不变量保持中文还是改英文"的裁定。
  // ── 整站备份接口（controller/admin/backup/backup.controller.ts，期 9 第十批）──────────────
  // 🔴 这一批是备份族里**唯一纯界面文案**的一族（其余 `fullBackup` / `backupCrypto` / `backupSigning` /
  //    `backupVerify` 里有很多是**写进备份清单与校验报告文件**的产物内容，要先分类再动手）。
  //    ⚠️ `backupRestoreNeedsConfirm` 里的 `confirm=true` / `"true"` / `"1"` / `"yes"` / `"TRUE"`
  //    是**接口契约**（调用方照着敲的字面量）⇒ 三份译文都必须逐字保留。
  // ── 零散 UI 文案（期 9 第十一批）──────────────────────────────────────────
  // 🔴 前两个是**自查发现的回归**：期 9 第八/九批把 `流水线 id 不合法：${id || '(空)'}` 与
  //    `…收到：${originalName || '(空)'}` 迁进码表时，把中文兜底值 `(空)` 当**参数**传了进去 ⇒
  //    英文界面会渲染出 `Invalid pipeline id: (空)`（半截中文）。这是本项目**第 7 次**踩
  //    "把给用户看的文字当协议值传"。修法与前几次一致：**拆成"带值"与"空值"两个码**。
  //    👉 🔴 迁移时凡是看到 `x || '中文兜底'` 这种形状，都要拆码 —— 兜底值也是文案。
  pipelineIdInvalidEmpty: entry('流水线 id 不合法：(空)', BadRequestException),
  initRestoreBadArchiveNameEmpty: entry(
    '文件名不像是本功能导出的整站备份（应形如 vanblog-full-20260913-140955.tar.zst），收到：(空)',
    BadRequestException,
  ),
  // 🔴 `setupKeyUnavailable` 的响应体带一个**自定义字段** `setupKeyUnavailable: true`，
  //    后台 `pages/InitPage/setupKeyCore.js` 会按它分支（"服务端自己丢了密钥 ⇒ 填什么都没用，不骗人"）
  //    ⇒ 迁移时用 `codedError(code, params, { setupKeyUnavailable: true })` 把它**原样保留**。
  setupKeyUnavailable: entry(
    '服务端当前没有可用的初始化密钥（预期文件 {path} 不存在，本进程内存里也没有）：' +
      '重启 vanblog 会重新生成并打印到日志。站点状态未受影响',
    HttpException,
    500,
  ),
  collaboratorAdminMissingForList: entry(
    '管理员账号不存在（库里没有 id=0 的用户），无法生成协作者清单。' +
      '这通常意味着数据被恢复成了一份损坏或空的备份：先跑 ./vanblog.sh doctor 看体检，' +
      '必要时用 ./vanblog.sh restore --offline-full <归档> 从一份好归档重建（数据库起不来时也能用）',
    NotFoundException,
  ),
  customPageNoUpload: entry('未收到上传文件', HttpException, 400),
  fileNoUpload: entry('没有收到文件！', BadRequestException),
  commentMissingPaths: entry('缺少 paths 参数', BadRequestException),
  draftMissingOrPublished: entry('草稿不存在或已经发布过了', BadRequestException),
  exportDraftNotFound: entry('草稿不存在！', BadRequestException),
  exportArticleNotFound: entry('文章不存在！', BadRequestException),
  // ⚠️ 刻意**不迁**：`caddy.controller.ts` 的 `未授权的域名`（403）—— 那个响应是给 **caddy** 看的
  //    （ACME on-demand TLS 的 ask 端点），不是给站长看的界面文案 ⇒ 属"机器消费方"，
  //    与日志同一类（翻它没有任何用户能看到，反而会让 caddy 侧的排障文本跟着界面语言漂）。

  backupGraceDaysInvalid: entry(
    'graceDays 必须是 0 到 365 之间的数字（0 = 旧密钥立即失效），收到：{value}',
    BadRequestException,
  ),
  backupManifestUnreadable: entry(
    '读不出这个备份的清单：文件损坏，或不是本功能导出的整站备份',
    BadRequestException,
  ),
  backupRestoreNeedsConfirm: entry(
    '恢复会覆盖当前全部数据，请带 confirm=true 再调用一次（只接受字面量 true 或字符串 "true"；' +
      '"1"/"yes"/"TRUE" 都不算确认）',
    BadRequestException,
  ),
  backupRestoreNeedsTarget: entry(
    '请指定要恢复的备份（name），或直接上传备份文件',
    BadRequestException,
  ),
  backupSigMissing: entry(
    '这份归档没有 {ext}（{name}）：它可能早于签名功能，' +
      '或备份时没有配签名密钥。用 GET /api/admin/backup/signing/key 看当前签名配置。',
    NotFoundException,
  ),

  accessPasswordTooShort: entry(
    '访问密码太短：至少 {min} 个字符（当前 {count} 个）。' +
      '解锁接口是匿名可达的（20 次/10 分钟/(IP×文章)），短密码用几个代理 IP 就能穷尽。',
    BadRequestException,
  ),
  accessPasswordMustBeString: entry('访问密码必须是字符串', BadRequestException),
  accessPasswordClearConflict: entry(
    '不能同时"设置新密码"和"{field}=true"：要换密码就只填新密码，要解除加密就只勾清除',
    BadRequestException,
  ),
  oldBaseUrlNeedsProtocol: entry(
    '旧地址请填写包含协议的完整 URL，例如 https://example.com',
    BadRequestException,
  ),
  oldBaseUrlHttpOnly: entry('旧地址只支持 http 或 https 地址', BadRequestException),
  oldBaseUrlMissingHost: entry('旧地址缺少主机名', BadRequestException),
  newBaseUrlNeedsProtocol: entry(
    '新地址请填写包含协议的完整 URL，例如 https://example.com',
    BadRequestException,
  ),
  newBaseUrlHttpOnly: entry('新地址只支持 http 或 https 地址', BadRequestException),
  newBaseUrlMissingHost: entry('新地址缺少主机名', BadRequestException),
  attachmentEmpty: entry('上传内容为空！', BadRequestException),
  attachmentTooLarge: entry('附件超过单文件上限 {max}（当前 {size}）', BadRequestException),
  pathnameTaken: entry('路径别名 "{pathname}" 已被其它文章占用', BadRequestException),
  imgCompressUnsupportedFormat: entry(
    '不支持的图片压缩格式：{value}，可选 webp 或 avif',
    BadRequestException,
  ),
  illegalPath: entry('非法路径', ForbiddenException),
  pipelineIdInvalid: entry('流水线 id 不合法：{id}', BadRequestException),
  publishAtInvalid: entry('publishAt 不是合法时间', BadRequestException),
  publishAtInvalidValue: entry('publishAt 不是合法时间：{value}', BadRequestException),
  publishAtWrongType: entry('publishAt 只接受 ISO 时间字符串、毫秒数或 null', BadRequestException),

  themeIdMissing: entry('缺少 id', BadRequestException),
  themeNotFoundForRead: entry('没有这个主题：{id}', NotFoundException),
  themeBuiltinNoCssFile: entry(
    '「{id}」是内置主题，样式打包在前台产物里，没有单独的文件',
    NotFoundException,
  ),
  themeFileMissing: entry('主题文件不在了（可能被手工删掉），重新上传一次即可', NotFoundException),
  pathnameTooLong: entry('路径别名过长（最多 {max} 个字符）：{pathname}', BadRequestException),
  pathnameHasSlash: entry('路径别名不能包含 "/"：{pathname}', BadRequestException),
  pathnameNumeric: entry('路径别名不能是纯数字（会与文章 id 冲突）：{pathname}', BadRequestException),
  pathnameControlChars: entry('路径别名不能包含控制字符', BadRequestException),
  storedFileNameIllegal: entry('非法的文件名：{name}', BadRequestException),
  storedImageNameIllegal: entry('非法的图片名：{name}', BadRequestException),
  storedFileNameEscapes: entry('非法的文件名（会指向 {dir} 目录之外）：{name}', BadRequestException),
  storedImageNameEscapes: entry('非法的图片名（会写出 {dir} 目录之外）：{name}', BadRequestException),
  // 🔴 名字差点撞车：登记表里**早就有** `customPageNotFound`，但它的中文是 `未找到该页面！`
  //    （HttpException 404），而 `public.controller.ts` 这两处是 `找不到自定义页面`（NotFoundException）
  //    ⇒ **两句不同的话**，必须用不同的码名（`customPageMissing`）。
  //    👉 🔴 重复登记会被 tsc 抓（TS1117 对象字面量不能有同名属性）—— 这次就是这么发现的；
  //    但更隐蔽的失败是"以为在复用、其实覆盖了另一句话" ⇒ **加码前先 grep 一遍登记表**，
  //    而且要比对**中文**，不只是看码名在不在。
  customPageMissing: entry('找不到自定义页面', NotFoundException),
  accessUnlockThrottled: entry('尝试次数过多，请 {seconds} 秒后再试', HttpException, 429),
  articleUnlockThrottled: entry(
    '这篇文章的密码尝试次数过多，请 {seconds} 秒后再试',
    HttpException,
    429,
  ),
  backupNameIllegal: entry('备份文件名不合法！', BadRequestException),
  backupFileNotFound: entry('找不到这个备份文件！', NotFoundException),

  demoSiteBlocked: entry('演示站禁止修改此项！', UnauthorizedException),
  demoSiteArticleEditBlocked: entry('演示站禁止修改文章！', UnauthorizedException),
  demoSiteArticleDeleteBlocked: entry('演示站禁止删除文章！', UnauthorizedException),
  demoSiteArticleCreateBlocked: entry('演示站禁止创建文章！', UnauthorizedException),
  demoSiteDraftPublishBlocked: entry('演示站禁止发布草稿！', UnauthorizedException),
  demoSitePasswordChangeBlocked: entry('演示站禁止修改账号密码！', UnauthorizedException),
  demoSiteLoginSecurityBlocked: entry('演示站禁止修改登录安全策略设置！', UnauthorizedException),
  demoSiteCustomizingBlocked: entry('演示站禁止修改定制化设置！', UnauthorizedException),
  commentDemoBlocked: entry('演示站禁止发表评论', ForbiddenException),
  commentNotBuiltin: entry('当前评论系统不是内置评论，无法通过该接口发表', ForbiddenException),
  commentClosedForArticle: entry('该文章未开放评论', ForbiddenException),
  commentRateLimited: entry('评论太频繁了，请 {seconds} 秒后再试', BadRequestException),
  commentDailyLimit: entry('今天评论太多了，请明天再来', BadRequestException),
  commentDuplicate: entry('刚才已经发过一样的评论了', BadRequestException),
  commentParentMissing: entry('要回复的评论不存在', BadRequestException),
  commentParentNotReplyable: entry('要回复的评论已不可回复', BadRequestException),
  commentCrossArticleReply: entry('不能跨文章回复', BadRequestException),
  commentArticleMissing: entry('评论所属的文章不存在', BadRequestException),
  commentArticlePathInvalid: entry('评论所属的文章路径不合法', BadRequestException),
  commentNickRequired: entry('昵称必填，且不超过 30 个字符', BadRequestException),
  commentEmailRequired: entry('本站要求填写邮箱（不会公开显示）', BadRequestException),
  commentEmailInvalid: entry('邮箱格式不正确', BadRequestException),
  commentSiteTooLong: entry('个人主页地址过长', BadRequestException),
  commentSiteHttpOnly: entry('个人主页地址只支持 http/https', BadRequestException),
  commentSiteInvalid: entry('个人主页地址不正确', BadRequestException),
  commentContentEmpty: entry('评论内容不能为空', BadRequestException),
  commentContentIllegalChars: entry('评论内容包含非法字符', BadRequestException),
  commentContentTooLong: entry('评论内容不能超过 {max} 个字符', BadRequestException),
  commentNotFound: entry('评论不存在', BadRequestException),
  // ── 限流信封（utils/rateLimit.ts，期 9 第四批）──────────────────────────────
  // 🔴 这一处以前**两个棘轮都数不到**：中文不是写在 `throw` 里、也不是写在 `{ message: … }` 里，
  //    而是当**实参**传给响应助手 `tooManyRequests(res, secs, '请求过于频繁，请稍后再试')`
  //    （助手内部才拼 `{ statusCode: 429, message }`）⇒ 属清点口径的**盲区**（见手册 §7.186 A）。
  //    而它偏偏是**访客最先撞到的错误之一**（公开写接口、静态资源、全局三个桶都用它）。
  rateLimited: entry('请求过于频繁，请稍后再试', HttpException, 429),
  // 🔴 这两条是**给脚本/运维看的长指引**（提到环境变量、健康检查端点、数据库级分页的替代路径），
  //    而不是访客 toast ⇒ 译文按"运维文档"的口吻写，且 🔴 环境变量名、HTTP 方法、端点路径
  //    三份都必须逐字相同（技术标识符契约）。
  //    ⚠️ 原来是"模板字符串 + 拼接"（`${scaleLimit(INIT_LIMIT_PER_10MIN)}` 直接插值）⇒
  //    现在数字走 params（`{max}` / `{seconds}`），文案在码表里；`scaleLimit()` 仍在调用点算
  //    （它按 worker 数摊薄，是**运行时**的值，不能写死在译文里）。
  initRateLimited: entry(
    '初始化/恢复接口调用过于频繁：每 10 分钟最多 {max} 次写请求，' +
      '约 {seconds} 秒后可以重试。' +
      '只有**写操作**（POST 等非安全方法）计入这个额度，GET/HEAD/OPTIONS 不计。' +
      '如果你是在做健康检查或"站点是否已初始化"的状态探测，请改用 GET /api/public/health —— ' +
      '它不占这个额度，也不会把真正的初始化/灾难恢复锁在门外。' +
      '确需更多次恢复尝试（例如反复试口令）可临时调高 VANBLOG_INIT_LIMIT_PER_10MIN。',
    HttpException,
    429,
  ),
  // ── 主题族（theme.provider.ts / types/theme.dto.ts 的 `validateThemeCss`，期 9 第五批）──────
  // 🔴 `validateThemeCss()` 返回的 `reason` 也是**用户可见**的（provider 把它当异常消息抛出去）⇒
  //    这一批给它**同时**返回 `code`（与可选 `params`），reason 保留（有 spec 钉着它的内容），
  //    并由 spec 断言 `reason === SERVER_ERROR_CODES[code].zh`（🔴 否则同一句话就有两处口径，迟早漂）。
  // 🔴 6 条"CSS 里含有 X"刻意**按 X 拆成 6 个码**，而不是一个码 + `{label}` 参数：
  //    那张 banned 表里的 label **本身含中文**（`javascript: 伪协议`、`</style> 闭合标签`、`<script> 标签`）
  //    ⇒ 当参数传进 ICU，英文里就会夹中文（与 `${label}密码太短` / `NumSelect d="天"` 同一个形状的坑）。
  // ── 图床与静态文件族（static.provider.ts / static/local.provider.ts，期 9 第五批）──────────
  // 🔴 重复文本各**共用一个码**（`文件不存在` 2 处、`非法的静态文件路径！` 2 处、`上传失败` 2 处、
  //    `打包错误！` 2 处、`找不到这张图片！` 2 处）⇒ 18 处 throw → 13 个码。
  // ⚠️ `imgPackFailed` 迁移前是 `new HttpException({ statusCode: 500, message: '打包错误！' }, 500)`
  //    （**对象体** + 显式 500）⇒ 码表里用 `HttpException` + `status: 500`，形状与状态码都由黄金快照钉住。
  // ── 上传校验与 .mdz 导入（utils/uploadLimits.ts / utils/mdzImport.ts / img.controller.ts，期 9 第六批）──
  // 🔴 两处"条件片段"刻意**拆成两个码**（而不是一个码 + 可选参数）：
  //    `${declaredName ? `：${declaredName}` : ''}` 与 `${type || '未知'}` ——
  //    服务端的 `fillServerErrorMessage` 只做 `{name}` 替换、不实现 ICU select/默认值，
  //    而且 🔴 把中文兜底值（'未知'）当参数传进模板，英文里就会夹中文（第 4 次踩这个坑）。
  uploadEmpty: entry('上传内容为空', BadRequestException),
  uploadSvgRejected: entry('图床不接受 SVG（可内嵌脚本），请作为附件上传', BadRequestException),
  uploadNotAnImage: entry('这不是可识别的图片文件。非图片请走「附件管理」上传', BadRequestException),
  uploadNotAnImageNamed: entry(
    '这不是可识别的图片文件：{name}。非图片请走「附件管理」上传',
    BadRequestException,
  ),
  uploadUnsupportedType: entry('不支持的图片类型：{type}', BadRequestException),
  uploadUnsupportedTypeUnknown: entry('不支持的图片类型：未知', BadRequestException),
  uploadTooLargePixels: entry('图片尺寸过大（{width}x{height}），请缩小后再上传', BadRequestException),
  stegoImageTooLarge: entry(
    '这张图太大了，没法在线检测（上限约 {max}MP）。要验更大的图，请先把它上传到图床，然后在图片列表里用「检测水印」按 sign 验。',
    BadRequestException,
  ),
  // 🔴 期 9 第六批补一个：图片隐写检测那一档**自己的**限流（`img.controller.ts`），
  //    与 `rateLimited`（全局/公开写/静态三个桶共用的那句）不是同一句文案 ⇒ 单独一个码。
  //    ⚠️ 这一处是活体撞出来的：探针在 en-US 那轮把检测额度用掉了，zh-CN / zh-TW 两轮就吃到
  //    这句**还没有码**的中文 ⇒ 界面上是中文、其它地方是译文（正是"漏一个码"会长什么样）。
  imgDetectRateLimited: entry('图片检测过于频繁，请稍后再试', HttpException, 429),
  mdzImportEmpty: entry('上传内容为空：请选择一个 .mdz 文件', BadRequestException),
  mdzImportNoMarkdown: entry(
    '压缩包里没有找到 Markdown 文件（*.md）：.mdz 应该是「一个 .md + 同名 .assets 图片目录」的 zip 包',
    BadRequestException,
  ),

  staticFileNotFound: entry('文件不存在', HttpException, 404),
  staticPathNotLocal: entry('只能处理本站 /static/ 下的文件！', BadRequestException),
  staticPathIllegal: entry('非法的静态文件路径！', BadRequestException),
  staticThumbNameIllegal: entry('非法的缩略图文件名！', BadRequestException),
  staticAttachmentNameIllegal: entry('非法的附件文件名！', BadRequestException),
  imgUploadFailed: entry('上传失败', HttpException, 500),
  imgPackFailed: entry('打包错误！', HttpException, 500),
  imgPackUnsupportedProvider: entry('其他图床暂不支持打包导出！', NotImplementedException),
  imgFileRecordMissing: entry('找不到该文件（可能已经被删除）', BadRequestException),
  imgNoFileReceived: entry('没有收到文件！', BadRequestException),
  imgNotFound: entry('找不到这张图片！', BadRequestException),
  imgReplaceUnsupportedRemote: entry(
    '远程图床（PicGo / OSS）暂不支持替换，请删除后重新上传！',
    BadRequestException,
  ),
  imgNoDetectableImages: entry('没有可检测的图片！', BadRequestException),

  themeUploadNoFile: entry('没有收到文件（表单字段名要是 file）', BadRequestException),
  themeUploadTooLarge: entry('文件太大（{size}KB），主题 CSS 上限 {max}KB', BadRequestException),
  themeUploadNotCss: entry('只接受 .css 文件（主题就是一份样式表）', BadRequestException),
  themeCssInvalid: entry('CSS 校验没通过', BadRequestException),
  themeIdInvalid: entry(
    '主题 id 不合法：只能是小写字母、数字、- 和 _，2-40 位，且以字母或数字开头',
    BadRequestException,
  ),
  themeIdIsBuiltin: entry('「{id}」是内置主题的名字，换一个 id', BadRequestException),
  themeNotFound: entry('没有这个主题：{id}', BadRequestException),
  themeBuiltinCannotDelete: entry('内置主题不能删除', BadRequestException),
  themeUploadedNotFound: entry('没有这个上传主题：{id}', BadRequestException),
  themeInUseCannotDelete: entry('这个主题正在使用中，先切换到别的主题再删', BadRequestException),
  themeCssEmpty: entry('CSS 是空的', BadRequestException),
  themeCssTooLarge: entry('CSS 太大（{size}KB > {max}KB）', BadRequestException),
  themeCssHasNul: entry('文件里有 NUL 字节，看起来不是 CSS 文本', BadRequestException),
  themeCssForbiddenJsProtocol: entry(
    'CSS 里含有 javascript: 伪协议，已拒绝（主题只能是样式）',
    BadRequestException,
  ),
  themeCssForbiddenExpression: entry(
    'CSS 里含有 CSS expression()，已拒绝（主题只能是样式）',
    BadRequestException,
  ),
  themeCssForbiddenBehavior: entry(
    'CSS 里含有 CSS behavior（HTC），已拒绝（主题只能是样式）',
    BadRequestException,
  ),
  themeCssForbiddenMozBinding: entry(
    'CSS 里含有 -moz-binding，已拒绝（主题只能是样式）',
    BadRequestException,
  ),
  themeCssForbiddenStyleClose: entry(
    'CSS 里含有 </style> 闭合标签，已拒绝（主题只能是样式）',
    BadRequestException,
  ),
  themeCssForbiddenScriptTag: entry(
    'CSS 里含有 <script> 标签，已拒绝（主题只能是样式）',
    BadRequestException,
  ),

  publicListRateLimited: entry(
    '分类/标签列表接口调用过于频繁，请稍后再试。' +
      '这一档默认每 IP 每分钟 {max} 次，' +
      '可用 VANBLOG_PUBLIC_LIST_LIMIT_PER_MIN 调整。' +
      '若你在做站点聚合，请改用 /api/public/article?category=…&page=…&pageSize=…（那是数据库级分页）。',
    HttpException,
    429,
  ),

  commentDataImageBudget: entry(
    '评论里包含无法在合理时间内解析的 data: 图片引用（疑似构造输入），该行已跳过',
    BadRequestException,
  ),
};

export type ServerErrorCode = keyof typeof SERVER_ERROR_CODES;

/**
 * 把 `{name}` 占位符填进中文模板。
 * 🔴 未提供的占位符**原样留着**（不要替换成空串或 `undefined`）：
 * 留着的 `{name}` 在日志里一眼就能看出"这个参数没传"，而空串会伪装成正常消息。
 * ⚠️ 占位符语法刻意与 react-intl 的 ICU `{name}` 一致 ⇒ **同一份 params 前后端通用**。
 */
export function fillServerErrorMessage(zh: string, params?: ServerErrorParams): string {
  if (!params) return zh;
  return String(zh).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}

function lookup(code: ServerErrorCode | string, fn: string): ServerErrorEntry {
  const e = (SERVER_ERROR_CODES as Record<string, ServerErrorEntry | undefined>)[code as string];
  if (!e) {
    // ⚠️ 这条**刻意用英文**：它是开发者不变量（"码没登记"），不是给用户看的消息。
    //    🔴 用中文会让它被"带中文的 throw 站点"棘轮统计进去，把用户可见消息的口径弄脏。
    throw new Error(
      `${fn}: unregistered server error code "${String(code)}" — add it to SERVER_ERROR_CODES in src/utils/serverErrorCodes.ts first`,
    );
  }
  return e;
}

/**
 * 🔴 组装"带码"的**响应体对象**（用于 `return { statusCode, message }` 这一族，例如"演示站禁止…"）。
 * 形状：`{ statusCode, message(中文), code, params? }`。
 */
export function codedBody(
  code: ServerErrorCode,
  params?: ServerErrorParams,
  extra?: Record<string, unknown>,
): { statusCode: number; message: string; code: string; params?: ServerErrorParams } {
  const e = lookup(code, 'codedBody');
  const status = e.status ?? new (e.Ctor as ExceptionCtor)('').getStatus();
  // 🔴 `extra`：**调用方原有的自定义响应体字段**（例如 `setupKeyUnavailable: true`，
  //    后台 `setupKeyCore.js` 会**按这个标志分支**）⇒ 迁进码表时必须原样保留，
  //    否则"翻译了一条消息"就顺手**改坏了线路契约**（那是比没翻译严重得多的回归）。
  //    ⚠️ 放在最后展开：不允许 extra 覆盖 `statusCode` / `message` / `code` / `params`
  //    （那四个是本机制的地基，被覆盖就等于码白加了）。
  const body: any = { statusCode: status, message: fillServerErrorMessage(e.zh, params), code };
  if (params) body.params = params;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'statusCode' || k === 'message' || k === 'code' || k === 'params') continue;
      body[k] = v;
    }
  }
  return body;
}

/**
 * 🔴 造一个"带码"的异常（用于 `throw`）。**用法与今天完全一样**：
 * `throw codedError('categoryDuplicateOnCreate')` 替换 `throw new NotAcceptableException('分类名重复，无法创建！')`。
 *
 * 实现要点（🔴 每一步都有理由，别"顺手简化"）：
 * 1. 先用**旧的构造方式**造一个探针异常（`new Ctor(中文message)`），
 *    这样 `error: 'Not Acceptable'`、`statusCode` 这些字段是 **Nest 自己算出来的**，不会漂；
 * 2. 取它的 `getResponse()` 当模板：字符串 body 要补成对象（否则没地方放 `code`）；
 * 3. 补 `code` 与可选 `params`，并**显式覆盖 `message`** 为插值后的中文
 *    （🔴 探针是用未插值的模板造的，不覆盖就会把 `{name}` 原样发给用户）；
 * 4. 用**同一个异常类**重新构造 ⇒ `instanceof` 判断、Nest 的状态码推导、
 *    以及任何按异常类分支的既有代码（例如 guard 里 `catch (e) { if (e instanceof ForbiddenException) }`）都不受影响。
 */
export function codedError(
  code: ServerErrorCode,
  params?: ServerErrorParams,
  extra?: Record<string, unknown>,
): HttpException {
  const e = lookup(code, 'codedError');
  const message = fillServerErrorMessage(e.zh, params);
  const Ctor = e.Ctor;
  const probe: HttpException = e.status === undefined ? new Ctor(message) : new Ctor(message, e.status);
  const raw = probe.getResponse();
  const base: Record<string, unknown> =
    typeof raw === 'string' ? { statusCode: probe.getStatus(), message: raw } : { ...(raw as Record<string, unknown>) };
  base.message = message;
  base.code = code;
  if (params) base.params = params;
  // 🔴 `extra`：同 `codedBody` —— 保留调用方原有的自定义字段（线路契约），但**不许覆盖**那四个地基字段。
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'statusCode' || k === 'message' || k === 'code' || k === 'params') continue;
      base[k] = v;
    }
  }
  return e.status === undefined ? new Ctor(base) : new Ctor(base, e.status);
}
