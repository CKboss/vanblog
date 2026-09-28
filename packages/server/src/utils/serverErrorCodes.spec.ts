import { HttpException, NotAcceptableException } from '@nestjs/common';
import {
  SERVER_ERROR_CODES,
  ServerErrorCode,
  codedBody,
  codedError,
  fillServerErrorMessage,
} from './serverErrorCodes';

/**
 * 🔴 期 9（服务端错误码框架）第一批的行为钉子。
 *
 * 它守的是**三条同时成立**的约束（详见 `serverErrorCodes.ts` 的头注释）：
 *  1. `message` 仍是中文、且与迁移前**逐字相同**（日志/排障线索不变，钉住中文字面量的既有测试不用改）；
 *  2. 响应体**只多** `code`（与可选 `params`）—— 🔴 `error: 'Not Acceptable'` 这类 Nest 自己算出来的字段
 *     必须**原样保留**（手写 body 会把它弄丢，而那会让"按 error 字段分支"的调用方静默改变行为）；
 *  3. 异常类不变（`instanceof` 与状态码推导都不受影响）。
 */
describe('服务端错误码（serverErrorCodes）', () => {
  const codes = Object.keys(SERVER_ERROR_CODES) as ServerErrorCode[];

  it('反空转：登记表非空，且每条都有中文 zh 与异常类', () => {
    expect(codes.length).toBeGreaterThanOrEqual(8);
    for (const code of codes) {
      const e = (SERVER_ERROR_CODES as any)[code];
      expect(typeof e.zh).toBe('string');
      expect(e.zh.length).toBeGreaterThan(0);
      expect(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(e.zh)).toBe(true);
      expect(typeof e.Ctor).toBe('function');
    }
  });

  it('🔴 迁移后的响应体 = 迁移前的响应体 + code（逐字段对齐，message 逐字不变）', () => {
    // 迁移前这一处是：throw new NotAcceptableException('分类名重复，无法创建！')
    const before = new NotAcceptableException('分类名重复，无法创建！');
    const after = codedError('categoryDuplicateOnCreate');

    expect(after).toBeInstanceOf(NotAcceptableException);
    expect(after).toBeInstanceOf(HttpException);
    expect(after.getStatus()).toBe(before.getStatus());
    expect(after.getStatus()).toBe(406);

    const beforeBody = before.getResponse() as Record<string, unknown>;
    const afterBody = after.getResponse() as Record<string, unknown>;
    // 🔴 message 必须**逐字**相同（这是"日志与既有测试不用改"的全部依据）
    expect(afterBody.message).toBe('分类名重复，无法创建！');
    expect(afterBody.message).toBe(beforeBody.message);
    // 🔴 Nest 自己算出来的字段一个都不许丢
    expect(afterBody.error).toBe(beforeBody.error);
    expect(afterBody.error).toBe('Not Acceptable');
    expect(afterBody.statusCode).toBe(beforeBody.statusCode);
    // 🔴 唯一的多出来的东西就是 code
    expect(Object.keys(afterBody).sort()).toEqual([...Object.keys(beforeBody), 'code'].sort());
    expect(afterBody.code).toBe('categoryDuplicateOnCreate');
  });

  it('每个登记的码都能造出异常：状态码是数字、message 是中文、body 里的 code 与登记一致', () => {
    for (const code of codes) {
      // 🔴 期 9 第一批起码表里有**带占位符**的模板（`{min}` / `{max}` / `{count}` / `{name}`）⇒
      //    造异常时要按登记表里的 `zh` **自动喂样例参数**，否则 message 里必然残留 `{min}`。
      //    ⚠️ 这不是放宽判据：下面那条"不许残留占位符"的断言**照旧**，
      //    只是从"不传 params 也不许残留"改成"喂了 params 之后不许残留"——
      //    🔴 前者对带参数的码是**不可能满足的**（那等于禁止码表使用占位符）。
      const zh = String((SERVER_ERROR_CODES as any)[code].zh || '');
      const sample: Record<string, string | number> = {};
      for (const m of zh.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        sample[m[1]] = m[1] === 'name' ? 'someone' : 10;
      }
      const ex = codedError(code, sample);
      expect(ex).toBeInstanceOf(HttpException);
      expect(typeof ex.getStatus()).toBe('number');
      const body = ex.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(code);
      expect(typeof body.message).toBe('string');
      expect((body.message as string).length).toBeGreaterThan(0);
      // 🔴 喂了样例 params 之后，message 里不许残留占位符
      //    （残留 = 登记表写了 `{x}` 而喂参数的地方漏了 x —— 用户会看见字面 `{min}`）
      expect(body.message).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      // 🔴 反向：带占位符的码，样例参数必须真的**被填进去**了（防止"喂了个没人用的参数"这种假绿）
      for (const k of Object.keys(sample)) {
        expect(String(body.message)).toContain(String(sample[k]));
      }
    }
  });

  it('🔴 未登记的码必须 fail-loud（不能静默造出一条 message=undefined 的响应）', () => {
    expect(() => codedError('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/unregistered server error code/);
    expect(() => codedBody('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/unregistered server error code/);
    // 报错里要点名那个码，否则排查时不知道是谁写错了
    expect(() => codedError('thisCodeDoesNotExist' as ServerErrorCode)).toThrow(/thisCodeDoesNotExist/);
  });

  it('fillServerErrorMessage：填已知的、保留未知的、没有 params 时原样返回', () => {
    expect(fillServerErrorMessage('请稍后 {n} 秒再试', { n: 30 })).toBe('请稍后 30 秒再试');
    // 🔴 未提供的占位符**原样留着**：日志里一眼能看出"这个参数没传"，空串会伪装成正常消息
    expect(fillServerErrorMessage('请稍后 {n} 秒再试', {})).toBe('请稍后 {n} 秒再试');
    expect(fillServerErrorMessage('请稍后 {n} 秒再试')).toBe('请稍后 {n} 秒再试');
    // 多个占位符与重复出现
    expect(fillServerErrorMessage('{a} 和 {b}，再来一个 {a}', { a: 1, b: 'x' })).toBe('1 和 x，再来一个 1');
    // 🔴 不许把原型链上的属性当参数（`{constructor}` 这类）
    expect(fillServerErrorMessage('{constructor}', {})).toBe('{constructor}');
  });

  it('codedBody：给 return 体那一族用（形状与 codedError 的 body 同源）', () => {
    const body = codedBody('categoryHasArticles');
    expect(body).toEqual({
      statusCode: 406,
      message: '分类已有文章，无法删除！',
      code: 'categoryHasArticles',
    });
    // 🔴 同一个码，codedBody 与 codedError 的 message/statusCode 必须一致（否则两处口径）
    const viaThrow = codedError('categoryHasArticles').getResponse() as Record<string, unknown>;
    expect(body.message).toBe(viaThrow.message);
    expect(body.statusCode).toBe(viaThrow.statusCode);
  });

/**
 * 🔴 每个码的 **HTTP 状态码 + body.error** 的黄金快照（照迁移前的真实形状逐条抄）。
 *
 * ## 为什么需要它（"message 逐字相同"那条看不见的维度）
 * `codedError()` 的状态码来自登记表里的 `Ctor` / `status` ⇒ 谁把 `NotFoundException` 改成
 * `BadRequestException`，线上那个接口的**状态码就静默变了**，而 message 一个字都没动
 * ⇒ 现有那条"逐字相同"的断言**完全看不出来**。
 * 而调用方常常**按状态码分支**（实例：回收站的 `isNotFoundFailure(err)` ⇒ "404 = 已不在回收站，刷新列表"）
 * ⇒ 🔴 状态码漂了就是**行为**漂了。
 *
 * ## ⚠️ 基类 `HttpException` + 字符串消息这一族**没有 `error` 字段**
 * Nest 只对 `NotFoundException` 这类子类填 `error`。已用**旧镜像 A/B 实测**（不是推断）：
 * `GET /c/<不存在的路径>` 迁移前 body = `{"statusCode":404,"message":"未找到该页面！"}`（Content-Length **52**），
 * 迁移后 = 它 **+ 恰好一个 `code` 字段**（Content-Length **80** = 52 + 28）。
 */
const HTTP_SNAPSHOT: Record<string, { status: number; error?: string }> = {
  // 分类（NotAcceptableException ⇒ 406）
  categoryDuplicateOnCreate: { status: 406, error: 'Not Acceptable' },
  categoryDeleteNeedsName: { status: 406, error: 'Not Acceptable' },
  categoryHasArticles: { status: 406, error: 'Not Acceptable' },
  categoryReorderNoPayload: { status: 406, error: 'Not Acceptable' },
  categoryNoneToReorder: { status: 406, error: 'Not Acceptable' },
  categoryUpdateNoPayload: { status: 406, error: 'Not Acceptable' },
  categoryOrderInvalid: { status: 406, error: 'Not Acceptable' },
  categoryDuplicateOnUpdate: { status: 406, error: 'Not Acceptable' },
  // 文章 / 草稿 / 导出
  articleImportMdzNoFile: { status: 400, error: 'Bad Request' },
  articleNotInRecycleBin: { status: 404, error: 'Not Found' },
  articlePurgeRequiresRecycleBin: { status: 404, error: 'Not Found' },
  articleNotFoundForRevision: { status: 404, error: 'Not Found' },
  revisionFeatureUnavailable: { status: 404, error: 'Not Found' },
  revisionNotFound: { status: 404, error: 'Not Found' },
  draftNotInRecycleBin: { status: 404, error: 'Not Found' },
  draftPurgeRequiresRecycleBin: { status: 404, error: 'Not Found' },
  exportArchiveNameInvalid: { status: 400, error: 'Bad Request' },
  exportArchiveMissing: { status: 404, error: 'Not Found' },
  // 自定义页面（🔴 customPageNotFound 用的是基类 HttpException ⇒ **没有 error 字段**）
  customPageCreateNeedsPath: { status: 400, error: 'Bad Request' },
  customPagePathDuplicate: { status: 403, error: 'Forbidden' },
  customPageUpdateNeedsTarget: { status: 400, error: 'Bad Request' },
  customPageDeleteNeedsPath: { status: 400, error: 'Bad Request' },
  customPageNotFound: { status: 404 },
  // 账号 / 协作者
  collaboratorNameInvalid: { status: 400, error: 'Bad Request' },
  accountNameInvalid: { status: 400, error: 'Bad Request' },
  adminPasswordInvalidNoChange: { status: 400, error: 'Bad Request' },
  collaboratorNameDuplicate: { status: 403, error: 'Forbidden' },
  collaboratorPasswordInvalidOnCreate: { status: 400, error: 'Bad Request' },
  collaboratorNotFound: { status: 403, error: 'Forbidden' },
  collaboratorPasswordInvalidOnUpdate: { status: 400, error: 'Bad Request' },
  // 🔴 期 9 第一批新增的 8 个码（账号口令的 3 类 × 2 种账号 + 协作者用户名冲突 2 条）。
  //    状态码与 error 字段**照抄迁移前**那几处 `new BadRequestException(...)` / `new ForbiddenException(...)`
  //    的实际取值 —— 这份快照的意义就是"迁移不许悄悄改状态码"。
  adminPasswordEmpty: { status: 400, error: 'Bad Request' },
  collaboratorPasswordEmpty: { status: 400, error: 'Bad Request' },
  adminPasswordTooLong: { status: 400, error: 'Bad Request' },
  collaboratorPasswordTooLong: { status: 400, error: 'Bad Request' },
  adminPasswordTooShort: { status: 400, error: 'Bad Request' },
  collaboratorPasswordTooShort: { status: 400, error: 'Bad Request' },
  collaboratorNameTakenByCollaborator: { status: 400, error: 'Bad Request' },
  collaboratorNameSameAsAdmin: { status: 403, error: 'Forbidden' },
  // 🔴 期 9 第二批新增的 21 个码（认证与初始化族）。
  //    状态码与 error 字段**照抄迁移前**那几处的实际取值：
  //    · `HttpException(msg, 409/403/429)` ⇒ 基类**没有 error 字段**（与 customPageNotFound 同理）；
  //    · `BadRequestException` ⇒ 400 / 'Bad Request'；`UnauthorizedException` ⇒ 401 / 'Unauthorized'。
  //    ⚠️ auth.controller 与 login.guard 那几处原来传的是**对象体**（只有 statusCode 与 message），
  //    改走 `codedError` 之后响应体会多出 Nest 自己算的 `error` 与我们的 `code` —— 这份快照就是把新形状钉住。
  initBusySameProcess: { status: 409 },
  initBusyOtherProcess: { status: 409 },
  initRestoreBusySameProcess: { status: 409 },
  initRestoreBusyOtherProcess: { status: 409 },
  initRestoreAlreadyInitialized: { status: 403 },
  initRestoreNeedsFile: { status: 400, error: 'Bad Request' },
  initRestoreBadArchiveName: { status: 400, error: 'Bad Request' },
  initRestoreSigTooLarge: { status: 400, error: 'Bad Request' },
  initRestoreSigNotOurs: { status: 400, error: 'Bad Request' },
  authBadCredentials: { status: 401, error: 'Unauthorized' },
  authNoCredentials: { status: 401, error: 'Unauthorized' },
  authRestoreRateLimited: { status: 429 },
  authRestoreKeyUnavailable: { status: 401, error: 'Unauthorized' },
  authRestoreKeyInvalid: { status: 401, error: 'Unauthorized' },
  jwtAdminMissing: { status: 401, error: 'Unauthorized' },
  jwtBadSubject: { status: 401, error: 'Unauthorized' },
  jwtCollaboratorGone: { status: 401, error: 'Unauthorized' },
  jwtSecretMissing: { status: 400, error: 'Bad Request' },
  jwtSecretRotateConflict: { status: 400, error: 'Bad Request' },
  loginThrottled: { status: 401, error: 'Unauthorized' },
  initFailed: { status: 400, error: 'Bad Request' },
  // 🔴 期 9 第三批新增的 22 个评论族码（状态码与 error 字段照抄迁移前的 Forbidden/BadRequest）
  commentDemoBlocked: { status: 403, error: 'Forbidden' },
  commentNotBuiltin: { status: 403, error: 'Forbidden' },
  commentClosedForArticle: { status: 403, error: 'Forbidden' },
  commentRateLimited: { status: 400, error: 'Bad Request' },
  commentDailyLimit: { status: 400, error: 'Bad Request' },
  commentDuplicate: { status: 400, error: 'Bad Request' },
  commentParentMissing: { status: 400, error: 'Bad Request' },
  commentParentNotReplyable: { status: 400, error: 'Bad Request' },
  commentCrossArticleReply: { status: 400, error: 'Bad Request' },
  commentArticleMissing: { status: 400, error: 'Bad Request' },
  commentArticlePathInvalid: { status: 400, error: 'Bad Request' },
  commentNickRequired: { status: 400, error: 'Bad Request' },
  commentEmailRequired: { status: 400, error: 'Bad Request' },
  commentEmailInvalid: { status: 400, error: 'Bad Request' },
  commentSiteTooLong: { status: 400, error: 'Bad Request' },
  commentSiteHttpOnly: { status: 400, error: 'Bad Request' },
  commentSiteInvalid: { status: 400, error: 'Bad Request' },
  commentContentEmpty: { status: 400, error: 'Bad Request' },
  commentContentIllegalChars: { status: 400, error: 'Bad Request' },
  commentContentTooLong: { status: 400, error: 'Bad Request' },
  commentNotFound: { status: 400, error: 'Bad Request' },
  commentDataImageBudget: { status: 400, error: 'Bad Request' },
  // 🔴 期 9 第四批：限流信封 3 个码。基类 `HttpException` + 显式 429 ⇒ **没有 error 字段**
  //    （与 `customPageNotFound` 同理），而迁移前 `tooManyRequests()` 手写的是
  //    `{ statusCode: 429, message }`（也没有 error）⇒ 形状一致，只是多了 `code`（与可选 `params`）。
  // 🔴 期 9 第七批：演示站守卫族 8 个码。⚠️ 它们走 **`codedBody()`**（返回体，不是抛异常）⇒
  //    HTTP 状态码仍是 **200**（VanBlog 既有约定：演示站信封是"HTTP 200 + body.statusCode 401"），
  //    而这份快照钉的是 `codedBody` 造出来的**响应体里的 statusCode**（= 401，与迁移前逐字相同）
  //    与 `error` 字段（基类语义 ⇒ 'Unauthorized'；迁移前的手写信封**没有**这个字段，是新增的）。
  demoSiteBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteArticleEditBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteArticleDeleteBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteArticleCreateBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteDraftPublishBlocked: { status: 401, error: 'Unauthorized' },
  demoSitePasswordChangeBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteLoginSecurityBlocked: { status: 401, error: 'Unauthorized' },
  demoSiteCustomizingBlocked: { status: 401, error: 'Unauthorized' },
  rateLimited: { status: 429 },
  initRateLimited: { status: 429 },
  publicListRateLimited: { status: 429 },
  // 🔴 期 9 第五批：图床与静态文件族 13 个码 + 主题族 19 个码。
  //    ⚠️ 基类 `HttpException` + 显式状态码 ⇒ **没有 error 字段**（`staticFileNotFound` 404、
  //    `imgUploadFailed` / `imgPackFailed` 500）；`NotImplementedException` ⇒ 501 / 'Not Implemented'。
  staticFileNotFound: { status: 404 },
  staticPathNotLocal: { status: 400, error: 'Bad Request' },
  staticPathIllegal: { status: 400, error: 'Bad Request' },
  staticThumbNameIllegal: { status: 400, error: 'Bad Request' },
  staticAttachmentNameIllegal: { status: 400, error: 'Bad Request' },
  imgUploadFailed: { status: 500 },
  imgPackFailed: { status: 500 },
  imgPackUnsupportedProvider: { status: 501, error: 'Not Implemented' },
  imgFileRecordMissing: { status: 400, error: 'Bad Request' },
  imgNoFileReceived: { status: 400, error: 'Bad Request' },
  imgNotFound: { status: 400, error: 'Bad Request' },
  imgReplaceUnsupportedRemote: { status: 400, error: 'Bad Request' },
  imgNoDetectableImages: { status: 400, error: 'Bad Request' },
  // 🔴 期 9 第八批：17 个码（主题读取 / 路径别名 / 落盘文件名 / 公开接口限流 / 备份文件名）
  // 🔴 期 9 第九批：18 个码（访问密码 / 改写 baseUrl / 附件 / 路径别名 / 图片压缩 / 非法路径 / 流水线 id / 定时发布）
  // 🔴 期 9 第十批：整站备份接口 5 个码
  // 🔴 期 9 第十一批：10 个码。⚠️ `customPageNoUpload` 迁移前是 `HttpException(msg, HttpStatus.BAD_REQUEST)`
  //    （基类 + 显式 400 ⇒ **没有 error 字段**）；`setupKeyUnavailable` 是基类 + 500，
  //    而且它的响应体还带一个自定义字段 `setupKeyUnavailable: true`（后台按它分支）⇒ 由专门的行为断言钉住。
  // 🔴 期 9 第十二批：备份签名密钥 9 个码（🔴 其中两个是"完整句"码：内层"类型不对"不再抛裸 Error
  //    让外层拼中文，而是自己带上指引 ⇒ 外层 catch 用 `isCodedError` 判断后**原样重抛**）
  // 🔴 期 9 第十三批（13a）：备份加密 11 个码
  passphraseFileReadFailed: { status: 400, error: 'Bad Request' },
  passphraseFileEmpty: { status: 400, error: 'Bad Request' },
  passphraseTooShort: { status: 400, error: 'Bad Request' },
  encHeaderTruncatedNoVersion: { status: 400, error: 'Bad Request' },
  encVersionUnsupported: { status: 400, error: 'Bad Request' },
  encHeaderLenInvalid: { status: 400, error: 'Bad Request' },
  encHeaderTruncatedJson: { status: 400, error: 'Bad Request' },
  encHeaderUnreadable: { status: 400, error: 'Bad Request' },
  encChunkOrderWrong: { status: 400, error: 'Bad Request' },
  encDecryptFailed: { status: 400, error: 'Bad Request' },
  encNeedsPassphrase: { status: 400, error: 'Bad Request' },
  signingKeyFileReadFailed: { status: 400, error: 'Bad Request' },
  signingKeyFileTooLarge: { status: 400, error: 'Bad Request' },
  signingKeyFileEmpty: { status: 400, error: 'Bad Request' },
  signingKeyUnusableWrongType: { status: 400, error: 'Bad Request' },
  signingKeyUnusable: { status: 400, error: 'Bad Request' },
  verifyKeyUnusableWrongType: { status: 400, error: 'Bad Request' },
  verifyKeyUnusable: { status: 400, error: 'Bad Request' },
  signingKeyExistsRefuseOverwrite: { status: 400, error: 'Bad Request' },
  signingRejectBadSha: { status: 400, error: 'Bad Request' },
  pipelineIdInvalidEmpty: { status: 400, error: 'Bad Request' },
  initRestoreBadArchiveNameEmpty: { status: 400, error: 'Bad Request' },
  setupKeyUnavailable: { status: 500 },
  collaboratorAdminMissingForList: { status: 404, error: 'Not Found' },
  customPageNoUpload: { status: 400 },
  fileNoUpload: { status: 400, error: 'Bad Request' },
  commentMissingPaths: { status: 400, error: 'Bad Request' },
  draftMissingOrPublished: { status: 400, error: 'Bad Request' },
  exportDraftNotFound: { status: 400, error: 'Bad Request' },
  exportArticleNotFound: { status: 400, error: 'Bad Request' },
  backupGraceDaysInvalid: { status: 400, error: 'Bad Request' },
  backupManifestUnreadable: { status: 400, error: 'Bad Request' },
  backupRestoreNeedsConfirm: { status: 400, error: 'Bad Request' },
  backupRestoreNeedsTarget: { status: 400, error: 'Bad Request' },
  backupSigMissing: { status: 404, error: 'Not Found' },
  accessPasswordTooShort: { status: 400, error: 'Bad Request' },
  accessPasswordMustBeString: { status: 400, error: 'Bad Request' },
  accessPasswordClearConflict: { status: 400, error: 'Bad Request' },
  oldBaseUrlNeedsProtocol: { status: 400, error: 'Bad Request' },
  oldBaseUrlHttpOnly: { status: 400, error: 'Bad Request' },
  oldBaseUrlMissingHost: { status: 400, error: 'Bad Request' },
  newBaseUrlNeedsProtocol: { status: 400, error: 'Bad Request' },
  newBaseUrlHttpOnly: { status: 400, error: 'Bad Request' },
  newBaseUrlMissingHost: { status: 400, error: 'Bad Request' },
  attachmentEmpty: { status: 400, error: 'Bad Request' },
  attachmentTooLarge: { status: 400, error: 'Bad Request' },
  pathnameTaken: { status: 400, error: 'Bad Request' },
  imgCompressUnsupportedFormat: { status: 400, error: 'Bad Request' },
  illegalPath: { status: 403, error: 'Forbidden' },
  pipelineIdInvalid: { status: 400, error: 'Bad Request' },
  publishAtInvalid: { status: 400, error: 'Bad Request' },
  publishAtInvalidValue: { status: 400, error: 'Bad Request' },
  publishAtWrongType: { status: 400, error: 'Bad Request' },
  themeIdMissing: { status: 400, error: 'Bad Request' },
  themeNotFoundForRead: { status: 404, error: 'Not Found' },
  themeBuiltinNoCssFile: { status: 404, error: 'Not Found' },
  themeFileMissing: { status: 404, error: 'Not Found' },
  pathnameTooLong: { status: 400, error: 'Bad Request' },
  pathnameHasSlash: { status: 400, error: 'Bad Request' },
  pathnameNumeric: { status: 400, error: 'Bad Request' },
  pathnameControlChars: { status: 400, error: 'Bad Request' },
  storedFileNameIllegal: { status: 400, error: 'Bad Request' },
  storedImageNameIllegal: { status: 400, error: 'Bad Request' },
  storedFileNameEscapes: { status: 400, error: 'Bad Request' },
  storedImageNameEscapes: { status: 400, error: 'Bad Request' },
  customPageMissing: { status: 404, error: 'Not Found' },
  accessUnlockThrottled: { status: 429 },
  articleUnlockThrottled: { status: 429 },
  backupNameIllegal: { status: 400, error: 'Bad Request' },
  backupFileNotFound: { status: 404, error: 'Not Found' },
  themeUploadNoFile: { status: 400, error: 'Bad Request' },
  themeUploadTooLarge: { status: 400, error: 'Bad Request' },
  themeUploadNotCss: { status: 400, error: 'Bad Request' },
  themeCssInvalid: { status: 400, error: 'Bad Request' },
  themeIdInvalid: { status: 400, error: 'Bad Request' },
  themeIdIsBuiltin: { status: 400, error: 'Bad Request' },
  themeNotFound: { status: 400, error: 'Bad Request' },
  themeBuiltinCannotDelete: { status: 400, error: 'Bad Request' },
  themeUploadedNotFound: { status: 400, error: 'Bad Request' },
  themeInUseCannotDelete: { status: 400, error: 'Bad Request' },
  themeCssEmpty: { status: 400, error: 'Bad Request' },
  themeCssTooLarge: { status: 400, error: 'Bad Request' },
  themeCssHasNul: { status: 400, error: 'Bad Request' },
  themeCssForbiddenJsProtocol: { status: 400, error: 'Bad Request' },
  themeCssForbiddenExpression: { status: 400, error: 'Bad Request' },
  themeCssForbiddenBehavior: { status: 400, error: 'Bad Request' },
  themeCssForbiddenMozBinding: { status: 400, error: 'Bad Request' },
  themeCssForbiddenStyleClose: { status: 400, error: 'Bad Request' },
  themeCssForbiddenScriptTag: { status: 400, error: 'Bad Request' },
  // 🔴 期 9 第六批：上传校验与 .mdz 导入 10 个码（全部 BadRequestException）
  uploadEmpty: { status: 400, error: 'Bad Request' },
  uploadSvgRejected: { status: 400, error: 'Bad Request' },
  uploadNotAnImage: { status: 400, error: 'Bad Request' },
  uploadNotAnImageNamed: { status: 400, error: 'Bad Request' },
  uploadUnsupportedType: { status: 400, error: 'Bad Request' },
  uploadUnsupportedTypeUnknown: { status: 400, error: 'Bad Request' },
  uploadTooLargePixels: { status: 400, error: 'Bad Request' },
  stegoImageTooLarge: { status: 400, error: 'Bad Request' },
  imgDetectRateLimited: { status: 429 },
  mdzImportEmpty: { status: 400, error: 'Bad Request' },
  mdzImportNoMarkdown: { status: 400, error: 'Bad Request' },
};

  it('🔴 码名必须是合法的 i18n key 段（admin 侧的 key 就是 error.<code>）', () => {
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code.includes('.')).toBe(false);
      expect(code.length).toBeGreaterThan(2);
    }
  });

  it('🔴 每个码的 HTTP 状态码与 error 字段都必须与迁移前一致（黄金快照，防"状态码静默漂移"）', () => {
    // 反空转 + 双向：快照必须**恰好**覆盖登记表里的码（少了 = 有码没被快照钉住；多了 = 死条目）
    expect(Object.keys(HTTP_SNAPSHOT).sort()).toEqual(codes.slice().sort());
    // 🔴 先把**所有**漂移收集起来再一次断言，而不是逐条 expect：
    //    逐条 expect 失败时只会打印 `400 ≠ 404` 这种**没说是哪个码**的信息（变异对照实测踩过：
    //    守卫红得对，但我无法从输出里定位是哪个码漂了）⇒ 红的消息必须能直接照做。
    const drift: string[] = [];
    for (const code of codes) {
      const want = HTTP_SNAPSHOT[code];
      const ex = codedError(code);
      const body = ex.getResponse() as Record<string, unknown>;
      // 🔴 状态码：调用方按它分支（例如回收站的 404 = "已不在回收站，刷新列表"）
      if (ex.getStatus() !== want.status) {
        drift.push(`${code}: getStatus() = ${ex.getStatus()}，迁移前是 ${want.status}`);
      }
      if (body.statusCode !== want.status) {
        drift.push(`${code}: body.statusCode = ${String(body.statusCode)}，迁移前是 ${want.status}`);
      }
      // 🔴 error 字段：`undefined` 也要逐字比（基类 HttpException 那一族本来就没有这个字段）
      if (body.error !== want.error) {
        drift.push(`${code}: body.error = ${JSON.stringify(body.error)}，迁移前是 ${JSON.stringify(want.error)}`);
      }
    }
    expect(drift).toEqual([]);
  });
});
