import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotAcceptableException,
  NotFoundException,
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
  // ⚠️ 本批**刻意不含** user.provider 里那 5 处带 `${label}` / `${MIN}` / `${name}` 的模板消息：
  //    其中 `label` 是**中文参数**（'管理员'/'协作者'），直接当 ICU 参数会让英文里夹中文 ⇒
  //    要么按 label 拆成不同的码、要么用 ICU select，单独排一批（见手册 §7.142 F）。
  collaboratorNameInvalid: entry('协作者用户名不合法（1-50 个字符）', BadRequestException),
  accountNameInvalid: entry('用户名不合法（1-50 个字符）', BadRequestException),
  adminPasswordInvalidNoChange: entry('密码不合法，未做任何修改', BadRequestException),
  collaboratorNameDuplicate: entry('已有为该用户名的协作者，不可重复创建！', ForbiddenException),
  collaboratorPasswordInvalidOnCreate: entry('密码不合法，未创建协作者', BadRequestException),
  collaboratorNotFound: entry('没有此协作者！无法更新！', ForbiddenException),
  collaboratorPasswordInvalidOnUpdate: entry('密码不合法，未修改协作者', BadRequestException),
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
): { statusCode: number; message: string; code: string; params?: ServerErrorParams } {
  const e = lookup(code, 'codedBody');
  const status = e.status ?? new (e.Ctor as ExceptionCtor)('').getStatus();
  const body: any = { statusCode: status, message: fillServerErrorMessage(e.zh, params), code };
  if (params) body.params = params;
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
export function codedError(code: ServerErrorCode, params?: ServerErrorParams): HttpException {
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
  return e.status === undefined ? new Ctor(base) : new Ctor(base, e.status);
}
