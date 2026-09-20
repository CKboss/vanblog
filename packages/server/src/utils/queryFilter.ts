import { InternalServerErrorException } from '@nestjs/common';

/**
 * Mongoose 查询条件的"非空"判据 —— 本仓库已经**四次**踩同一个坑，所以把它做成一个共用工具，
 * 而不是每个 provider 各写一遍（各写一遍正是它反复复发的原因）。
 *
 * ## 坑是什么
 * Mongoose 会**静默丢掉值为 `undefined` 的查询条件**（`strictQuery` 与此无关，这是 cast 阶段的行为）。
 * 于是 `findOne({ token: undefined, disabled: false })` 实际执行的是 `findOne({ disabled: false })`
 * —— 从"查这一个 token"退化成"**任意一个**未吊销的 token"。条件不是变严了，是**消失了**，
 * 而且不报错、不打日志、返回一条看起来完全正常的数据。
 *
 * 已确认的四例（前三例的严重度依次递增）：
 * 1. `provider/token/token.provider.ts` 的 `checkToken` ⇒ **未认证管理员接管**（已修）；
 * 2. `provider/user/user.provider.ts` 的 `updateCollaborator` ⇒ 不带用户名的更新改掉**任意**协作者口令（已修）；
 * 3. `provider/customPage/customPage.provider.ts` 的 `updateCustomPage` ⇒ 不带标识符的 PUT 改写**任意**
 *    一个自定义页面，而自定义页面是**公开渲染的原始 HTML**（本轮修）；
 * 4. 同文件的 `deleteByPath` ⇒ 不带 `path` 的 DELETE **删掉任意一个**自定义页面，且如果它是 folder
 *    类型还会连带删掉磁盘上的整个目录（本轮修）。
 *
 * ⚠️ 注意 `null` 与 `undefined` 的区别：`{ path: null }` 在 Mongo 里是**合法条件**（匹配 null 与
 * "字段不存在"），所以本工具只把 `undefined`、空串、以及字面量 `'undefined'`/`'null'` 当作不可用 ——
 * 后两者是"前端把 undefined 拼进 URL/JSON"时常见的形状，同样会让条件失效。
 */

/** 字面量字符串 `'undefined'` / `'null'`：来自 `String(undefined)`、模板串拼接或 query 解析。 */
const NULLISH_STRINGS = new Set(['undefined', 'null', '']);

/**
 * 这个值能不能安全地放进 Mongoose 查询条件里当"标识符"用。
 *
 * 判据是**保守**的：只认非空字符串、数字（含 0，因为本仓库有 `id: 0` 表示管理员这个约定）、
 * 布尔值、以及 ObjectId 这类对象（有非空的 `_bsontype` 或 `toHexString`）。
 * 其余一律判不可用 —— 判错的代价是"多拒绝一次请求"，而放过的代价是"条件静默消失"。
 */
export function isUsableFilterValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return !NULLISH_STRINGS.has(value.trim().toLowerCase());
  }
  if (typeof value === 'number') {
    // NaN 会让条件变成永远匹配不上（比"匹配任意一条"安全，但同样是 bug），一并拒掉。
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'object') {
    // ObjectId / Date 这类：只要有可序列化的标识就算可用。
    const candidate = value as { _bsontype?: unknown; toHexString?: unknown; getTime?: unknown };
    return (
      typeof candidate.toHexString === 'function' ||
      typeof candidate.getTime === 'function' ||
      (typeof candidate._bsontype === 'string' && candidate._bsontype.length > 0)
    );
  }
  return false;
}

/**
 * 写操作（`updateOne`/`updateMany`/`findOneAndUpdate`/`deleteOne`/`deleteMany`）**执行前**的最后防线。
 *
 * 为什么在调用点已经校验过标识符之后还要有这一层：条件是"将来有人给这个方法加第三个分支"。
 * 那时他大概率会记得写业务校验，但不会记得"分支组装出来的 filter 可能是空的"。
 * 这一层保证：**无论如何，写操作都不会拿着一个空条件或含不可用值的条件落库**。
 *
 * ⚠️ 抛 500 而不是 400 是有意的：走到这里说明**代码**错了（调用点校验漏了），不是客户端错了。
 * 把它报成 400 会让这个 bug 永远藏在"用户乱传参数"的噪音里。
 *
 * ⚠️ 这里连 `null` 一起拒，比"防止条件消失"更严一点，这是有意的取舍：`{ field: null }` 在 Mongo 里
 * 确实是个合法条件（匹配 null **与字段不存在**），所以它不会消失；但写操作的 filter 语义是
 * "**定位这一行**"，而 `null` 匹配的是一个**集合**而不是某一行 —— 拿它去 update/delete 同样会命中
 * 意料之外的文档。本仓库所有写侧 filter 都是按标识符定位，所以一律拒。
 * 真需要"按 null 查询"的**读**操作，不要用这个函数（它只管写），直接构造 filter 即可。
 */
export function assertSafeWriteFilter(
  filter: Record<string, unknown>,
  context: string,
): asserts filter is Record<string, unknown> {
  const keys = Object.keys(filter ?? {});
  if (keys.length === 0) {
    throw new InternalServerErrorException(
      `${context}：拒绝执行写操作，因为查询条件是空的（那会命中集合里的**任意一条**）。` +
        `这是服务端代码缺陷，不是请求问题 —— 请在构造 filter 的分支里补齐标识符校验。`,
    );
  }
  const unusable = keys.filter((key) => !isUsableFilterValue(filter[key]));
  if (unusable.length > 0) {
    throw new InternalServerErrorException(
      `${context}：拒绝执行写操作，因为查询条件里 ${unusable.join('、')} 的值不可用` +
        `（undefined / null / 空串 / NaN 要么被 Mongoose 静默丢掉让条件消失，要么会命中一整批文档）。` +
        `这是服务端代码缺陷，不是请求问题。`,
    );
  }
}
