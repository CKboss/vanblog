import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { sanitizeAttachmentName } from './attachment';

/**
 * 落盘文件名的**本地净化**与**容器化校验**。
 *
 * ## 为什么要有这个文件
 *
 * 附件那条路一直是安全的：`buildStoredFileName()` → `sanitizeAttachmentName()`
 * 会剥掉路径分隔符、控制字符、引号与前导点；`local.provider.saveAttachment()` 落盘前
 * 还会再挡一次分隔符。
 *
 * 而**图片**那条路以前两层都没有：`static.provider.upload()` 直接拼
 * `<md5>.<originalName>`，其中 `originalName` 只过了 `decodeUploadFileName()`
 * —— 那个函数只把 latin1 还原成 utf8（修中文名乱码），**不剥分隔符**；
 * 随后 `local.provider.saveImg()` 是裸的 `path.join(staticPath, 'img', fileName)` +
 * `writeFileSync`，既没有 `saveAttachment` 那道分隔符检查，也没有 `resolveCustomPageAbs`
 * 那种"解析完再证明没跑出目录"的容器化校验。
 *
 * 今天不可利用，但**原因不在我们的代码里**：`preservePath` 全仓库未设置，
 * 于是 busboy 默认对 multipart 的 filename 做 `basename()`（`busboy@1.6.0`
 * `lib/types/multipart.js`），`/` 与 `..` 根本进不到 `originalname`。
 * 也就是说这条防线**建立在依赖项的默认值上**：一个 `preservePath: true`、
 * 一次 multer/busboy 升级改默认值、或者换一个上传库，就把它变成任意路径写。
 * 第二个生产者更直接：`transferRemoteImages()` 的 `filenameFromRemote()` 从**远程 URL**
 * 造名字，压根不经过 busboy（它自己有白名单，但那是另一处独立的运气）。
 *
 * ⇒ 净化放在**生产者**（拼名字的地方），容器化校验放在**消费者**（真正 writeFileSync 的地方）。
 * 两层都加，是因为消费者那层能一次性覆盖所有现在和将来的生产者。
 */

/** 报错里回显文件名时的长度上限（避免把一整段垃圾塞进日志）。 */
const ECHO_MAX = 80;

/**
 * 把可能来自外部的文件名压成"日志里的一行安全文本"：
 * 去掉控制字符（含换行，防日志注入）、压掉重复空白、截断。
 * ⚠️ 只用于**回显**，不要拿它的返回值当文件名用。
 */
export function describeUnsafeNameForLog(fileName: unknown): string {
  const raw = String(fileName ?? '');
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = flat.length > ECHO_MAX ? `${flat.slice(0, ECHO_MAX)}…` : flat;
  return cut || '(空)';
}

/**
 * 图片落盘名：与附件用**同一套**净化规则（`sanitizeAttachmentName`），
 * 这样"图片名"和"附件名"的安全口径不会再各自漂移。
 *
 * 净化掉的东西：路径分隔符（取最后一段）、控制字符、单双引号、前导点；
 * 空结果回落成 `attachment`（继承既有行为），超长保留后缀截断到 160 字符。
 */
export function sanitizeStoredImageName(originalName: unknown): string {
  return sanitizeAttachmentName(originalName);
}

/**
 * 断言 `fileName` 是一个**单段**文件名（不是相对路径），并返回它。
 * 拒绝：空、含 `/` 或 `\`、含 `..` 段、含 NUL、含其它控制字符。
 *
 * 这是 `saveAttachment()` / `saveThumb()` 里那道便宜检查的统一版本 ——
 * 便宜检查先挡掉绝大多数，`resolveStoredFileAbs()` 再给出**证明**。
 *
 * ⚠️ 控制字符（换行等）在 POSIX 上是**合法**的文件名字符，拒它不是因为穿越，
 * 而是因为这种名字会污染日志与响应头（`Content-Disposition` 里就带着文件名）。
 * 生产者那层（`sanitizeAttachmentName`）已经剥掉了，这里是消费侧的第二道。
 *
 * ⚠️ 这里**不解码**百分号转义：`%2e%2e%2fevil.png` 是一个字面的单段名字，
 * 落盘就叫这个、写不出目录；解码反而会把"看起来像转义"的合法名字改坏。
 * 真正解码 URL 的是服务层（express static + `utils/staticGuard`），它们各自有容器化校验。
 */
export function assertSingleFileName(fileName: unknown, what = '文件'): string {
  const name = String(fileName ?? '');
  if (
    !name ||
    name.includes('\0') ||
    /[\\/]/.test(name) ||
    name.split('.').includes('..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new BadRequestException(`非法的${what}名：${describeUnsafeNameForLog(name)}`);
  }
  return name;
}

/**
 * 与 `resolveStoredFileAbs` 同源的容器化校验，但**允许嵌套相对路径**。
 *
 * 为什么需要两个：图片/附件的落盘名永远是单段，所以那边连分隔符一起拒；
 * 而自定义页面 legitimately 是 `sub/page.html` 这种多段名字。
 * 这个版本给"名字来自数据库"的消费点用（例如删除）—— 数据库记录可以由
 * **导入 JSON** 写入，所以 `../../..` 这种名字是可能真的出现在库里的，
 * 而删除是**不可逆**操作，必须先证明目标在目录内。
 *
 * 判据同样是 `path.resolve` + `path.relative` 看前缀（整段相等，不用 `startsWith('..')`，
 * 理由见 `resolveStoredFileAbs` 里的注释）。
 */
export function resolveWithinStorageAbs(staticRoot: string, subDir: string, relName: unknown): string {
  const raw = String(relName ?? '');
  if (
    !raw ||
    raw.includes('\0') ||
    // ⚠️ 反斜杠也拒：在 POSIX 上它是**合法**的文件名字符（所以 `..\\..\\evil` 其实逃不出去），
    //    但自定义页面的名字在写进来时就被 `toPosixRel()` 统一成 `/` 了
    //    （见 utils/customPagePath.ts），所以库里的合法名字**不可能**带反斜杠；
    //    同一份数据又可能在 Windows 上被读到（那时它就是真的穿越）。
    //    拒掉的代价是" refuse + WARN"，不是删数据，所以宁严勿松。
    raw.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new BadRequestException(`非法的文件名：${describeUnsafeNameForLog(raw)}`);
  }
  const root = path.resolve(staticRoot, subDir);
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new BadRequestException(
      `非法的文件名（会指向 ${subDir} 目录之外）：${describeUnsafeNameForLog(raw)}`,
    );
  }
  return abs;
}

/**
 * 把 `<staticRoot>/<subDir>/<fileName>` 解析成绝对路径，并**证明**它落在 `<subDir>` 里面。
 *
 * 判据与 `utils/customPagePath.ts` 的 `resolveCustomPageAbs()` 同款：
 * `path.resolve` 之后用 `path.relative(root, abs)` 看前缀 —— 逃逸时 relative 会以 `..` 开头
 * 或者是绝对路径。⚠️ 不能只比字符串前缀（`/static/img-evil` 会以 `/static/img` 开头），
 * 也不能只做 `includes('..')`（绝对路径 `/etc/passwd` 里没有 `..`，但 `path.resolve` 会让它直接胜出）。
 *
 * @param staticRoot 静态根目录（`config.staticPath`）
 * @param subDir     根下的子目录（`StoragePath[type]`，例如 `img`）
 * @param fileName   单段文件名
 */
export function resolveStoredFileAbs(
  staticRoot: string,
  subDir: string,
  fileName: unknown,
): string {
  const name = assertSingleFileName(fileName, '图片');
  const root = path.resolve(staticRoot, subDir);
  const abs = path.resolve(root, name);
  const rel = path.relative(root, abs);
  // ⚠️ 逃逸判据必须是**整段相等**（`rel === '..'`）或"以 `..` + 分隔符开头"，
  //    不能写 `rel.startsWith('..')`：那样会把**以两个点开头的合法单段名**
  //    （例如 `..%2f..%2fevil.png`、`..foo.png`）误判成逃逸。第一版就是这么写的，
  //    被自己的用例抓到了 —— 误拒同样是 bug（上传会莫名 400）。
  //    最后那条 `rel.includes(path.sep)` 是防御性的：assertSingleFileName 已经拒掉分隔符，
  //    所以正常走不到；万一将来那道检查被放宽，嵌套路径仍会在这里被拦住。
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new BadRequestException(
      `非法的图片名（会写出 ${subDir} 目录之外）：${describeUnsafeNameForLog(name)}`,
    );
  }
  return abs;
}
