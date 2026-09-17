/**
 * 文章 / 分类「访问密码」的**写入规则**与**下发规则**（唯一真源）。
 *
 * 背景：这个字段历史上是**明文**存进 Mongo 的（拿到库 = 拿到所有加密文章的密码）。
 * 现在写入一律走 scrypt（`utils/crypto.ts` 的 `hashAccessPassword`），读取一律
 * 走 `verifyAccessPassword`（同时认新哈希与历史明文，常量时间比较）。
 *
 * 两件必须一次说清的事：
 *
 * 1) **密文永不下发**。哈希不是"可以下发的东西"：它一样能让拿到响应的人离线爆破，
 *    而且后台表单一旦回填，就等于把"服务端必须能读出密码"这个前提焊死了。
 *    所以所有会序列化成响应的形状都走 `redactAccessSecret()` / schema 的 toJSON
 *    transform（见 scheme/article.schema.ts、scheme/category.schema.ts），
 *    把 `password` 换成布尔 `hasPassword`。UI 只需要知道"有没有设"。
 *
 * 2) **"留空 = 不修改"，清除必须显式**。既然不再回填，留空就不能再被解释成
 *    "把密码清空"（否则任何一次不碰密码字段的保存都会把加密悄悄抹掉）。
 *    线上契约因此是：
 *
 *      | 请求里的 password        | clearPassword | 结果                     |
 *      |--------------------------|---------------|--------------------------|
 *      | 缺键 / 空串 / 全空白     | 缺省或 false  | **不动**（新建时为"不加密"） |
 *      | 非空字符串               | 缺省或 false  | 写入 scrypt 哈希          |
 *      | 缺键 / 空串              | true          | 写入 `''`（解除加密）      |
 *      | 非空字符串               | true          | **400**（两种意图冲突）    |
 *
 *    `clearPassword` 只认布尔 `true` 与字符串 `'true'`（表单/查询串两种形状都能用），
 *    其它真值（`1`、`'yes'`）一律当没传 —— 宁可"没清掉"也不要"意外清掉"。
 */

import { BadRequestException } from '@nestjs/common';
import { hashAccessPassword, isScryptHash, needsPasswordUpgrade } from './crypto';

/** 显式清除密码的请求字段名（文章 / 分类共用） */
export const CLEAR_PASSWORD_FIELD = 'clearPassword';

/** `create`：留空 = 不加密（本来就没有旧值）；`update`：留空 = 保持原样 */
export type AccessPasswordMode = 'create' | 'update';

export interface AccessPasswordInput {
  password?: unknown;
  clearPassword?: unknown;
}

export interface AccessPasswordWrite {
  /** 要写进 `password` 字段的值；`undefined` = 本次**不动**这个字段 */
  password?: string;
  /** 本次是否写入了一个新哈希（用于日志/测试断言） */
  hashed: boolean;
  /** 本次是否显式清除 */
  cleared: boolean;
}

/** 只认 `true` / `'true'`：见文件头注释里"宁可没清掉"的理由 */
export function isClearPasswordFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * 幂等哈希：已经是 scrypt 格式就**原样返回**。
 *
 * 为什么必须幂等：导入 JSON 备份 / 整站恢复出来的文档里可能已经是哈希了，
 * 再哈希一次就变成"密码是那串 scrypt 字符串"，文章永久锁死且无法还原。
 */
export function hashAccessPasswordIdempotent(value: unknown): string {
  const text = String(value ?? '');
  if (!text) {
    return '';
  }
  return isScryptHash(text) ? text : hashAccessPassword(text);
}

/** "这个值算不算设了密码"：只看非空字符串（历史数据里 password 一定是字符串） */
export function hasAccessPasswordValue(value: unknown): boolean {
  return typeof value === 'string' ? value.length > 0 : Boolean(value);
}

/**
 * 把请求里的 password/clearPassword 解释成"要不要写、写什么"。
 * 抛 BadRequestException 的两种情况：类型不对、以及"设新密码 + 清除"同时给。
 */
export function resolveAccessPasswordWrite(
  input: AccessPasswordInput | null | undefined,
  mode: AccessPasswordMode,
): AccessPasswordWrite {
  const raw = input?.password;
  const clear = isClearPasswordFlag(input?.clearPassword);

  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new BadRequestException('访问密码必须是字符串');
  }
  const text = typeof raw === 'string' ? raw : '';
  // 全空白按"没填"处理：否则用户手滑敲几个空格就把文章锁在一个看不见的密码上
  const blank = text.trim() === '';

  if (clear && !blank) {
    throw new BadRequestException(
      `不能同时"设置新密码"和"${CLEAR_PASSWORD_FIELD}=true"：要换密码就只填新密码，要解除加密就只勾清除`,
    );
  }
  if (clear) {
    return { password: '', hashed: false, cleared: true };
  }
  if (blank) {
    // create：不写就是 schema 默认 ''（= 不加密）；update：不写 = 保持原值
    return { password: mode === 'create' ? '' : undefined, hashed: false, cleared: false };
  }
  return { password: hashAccessPasswordIdempotent(text), hashed: true, cleared: false };
}

/**
 * 就地脱敏：把 `password` 键换成布尔 `hasPassword`。
 *
 * **"键存在才动"** 是刻意的：公开面投影（publicView / listView）根本没 select
 * password，键不存在 ⇒ 一个字节都不改，公开响应的形状与今天完全一致。
 * 只有真的把密码取出来的管理端投影才会多出 `hasPassword`。
 */
export function redactPasswordInPlain(plain: any): any {
  if (plain && typeof plain === 'object' && Object.prototype.hasOwnProperty.call(plain, 'password')) {
    const value = plain.password;
    // `password: undefined` 是"这个形状本来就没取密码"（listView 投影 / 已经脱敏过一次），
    // 不是"没有密码"。这种情况下只删键、**不**断言 hasPassword，免得给出一个骗人的 false
    // （加密文章在列表投影里会被标成"没设密码"）。删掉 undefined 键与今天的 JSON 一致
    // （JSON.stringify 本来就丢 undefined 值），所以响应形状不变。
    if (value !== undefined) {
      plain.hasPassword = hasAccessPasswordValue(value);
    }
    delete plain.password;
  }
  return plain;
}

/** mongoose schema 的 `toJSON.transform`（文章 / 分类共用） */
export function accessPasswordToJson(_doc: any, ret: any): any {
  return redactPasswordInPlain(ret);
}

/**
 * 响应边界脱敏：mongoose 文档走 `toJSON()`（schema transform 已经处理过），
 * 普通对象（`{...doc._doc}` 这类展开产物）自己处理一遍。
 * 返回的**一定是普通对象**，调用方拿到后不要再当文档用。
 */
export function redactAccessSecret<T = any>(doc: T): T {
  if (doc === null || doc === undefined) {
    return doc;
  }
  const anyDoc = doc as any;
  const plain =
    typeof anyDoc?.toJSON === 'function'
      ? anyDoc.toJSON()
      : { ...(anyDoc?._doc || anyDoc) };
  return redactPasswordInPlain(plain) as T;
}

/** 列表版；非数组原样返回（容错，别让一个坏形状把整个接口打成 500） */
export function redactAccessSecretList<T = any>(docs: T): T {
  if (!Array.isArray(docs)) {
    return docs;
  }
  return docs.map((item) => redactAccessSecret(item)) as unknown as T;
}

// ---------------------------------------------------------------------------
// 流水线事件 payload（G5）
// ---------------------------------------------------------------------------

/**
 * 事件 payload / 日志里必须摘掉的键。
 *
 * `beforeUpdateArticle`、`beforeUpdateDraft` 这类**前置**事件传的是客户端刚提交的 DTO，
 * 里面的 `password` 是用户在后台表单里敲的**明文**。它流向四个地方，每一个都不该看到它：
 *  1. `PipelineProvider.logger.log(JSON.stringify(data))` —— 服务端日志（接了日志聚合器
 *     的部署里，读者远不止管理员）；
 *  2. `subProcess.send(data)` —— IPC 给用户自己写的流水线脚本；
 *  3. `LogProvider.runPipeline(..., input)` —— **持久化进 logs 集合**，后台「日志管理」直接展示；
 *  4. `JSON.stringify(result)` —— 脚本的返回值；它能回显的只有它收到过的东西，
 *     所以掐断 1–3 之后这条自然干净（`redactAccessSecretDeep` 也照样过一遍返回值入口）。
 *
 * 哈希化之后这件事更严重：库里存的已经是 scrypt 哈希，日志反而成了明文**唯一**还活着的地方
 * —— 一次专门为了消灭明文而做的迁移，最后把明文留在了日志表里。
 *
 * 事后事件（`afterUpdateArticle` / `deleteArticle`）传的是 mongoose 文档，schema 的 toJSON
 * transform 已经脱敏；这里仍然一视同仁地过一遍（纵深防御，脚本也可能收到普通对象）。
 *
 * ⚠️ **行为变更**（要写进 changelog）：流水线脚本从此看不到 `password` / `clearPassword`，
 * 前置事件的 payload 改成多一个布尔 `hasPassword`（= 这份 DTO 带没带密码）。
 * 想知道"这篇文章是否加密"请读 payload 里的 `private`；事件处理器没有任何正当理由
 * 需要那个秘密本身。
 */
export const SECRET_EVENT_FIELDS = ['password', 'clearPassword'] as const;

/** 递归深度上限：事件 payload 是 DTO / 文档，正常几层就到底，防畸形数据把栈打爆 */
const REDACT_MAX_DEPTH = 8;

/**
 * 给事件 payload 用的脱敏深拷贝：**绝不修改入参**（控制器后面还要拿原 DTO 去写库），
 * 顶层与嵌套的普通对象/数组都摘掉 `SECRET_EVENT_FIELDS`，并在摘掉 `password` 的那一层
 * 补一个布尔 `hasPassword`（= 原值是否非空），让脚本仍能判断"这次请求带没带新密码"。
 *
 * ⚠️ 同名不同义，脚本作者要知道：响应形状上的 `hasPassword`（toJSON transform 产出）
 * 说的是"库里这篇/这个分类**当前**设没设密码"；前置事件 payload 里的 `hasPassword`
 * 说的是"**这份 DTO** 带没带密码"（用户这次有没有在改密码）。判断文章是否加密请读
 * `private`。刻意保留同名，是为了让"只看 hasPassword"的脚本在事件里也能跑起来。
 *
 * mongoose 文档先走 `toJSON()`（顺带享受 schema transform）；带循环引用保护与深度上限；
 * 认不出的形状原样返回（宁可不脱敏，也别把事件本身打崩）。
 */
export function redactAccessSecretDeep(data: unknown, depth = 0, seen?: Set<any>): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (depth > REDACT_MAX_DEPTH) {
    return undefined;
  }
  const value: any =
    depth === 0 && typeof (data as any)?.toJSON === 'function' ? (data as any).toJSON() : data;
  if (typeof value !== 'object') {
    return value;
  }
  const visited = seen || new Set<any>();
  if (visited.has(value)) {
    return undefined; // 循环引用：截断
  }
  visited.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactAccessSecretDeep(item, depth + 1, visited));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if ((SECRET_EVENT_FIELDS as readonly string[]).includes(key)) {
        if (key === 'password') {
          out.hasPassword = hasAccessPasswordValue(item);
        }
        continue;
      }
      out[key] = redactAccessSecretDeep(item, depth + 1, visited);
    }
    return out;
  } finally {
    visited.delete(value);
  }
}

/**
 * 流水线**改写** DTO 之后，把调用方原本的密码意图透传回去。
 *
 * 为什么需要它：脚本已经看不到 `password` 了（上面刚脱敏），所以它返回的 `output` 里
 * 也不会有这个键；而控制器是 `updateDto = lastOutput` **整体替换**的 —— 结果就是
 * "用户在表单里改了密码、站点上正好挂着一个 beforeUpdateArticle 流水线"时，新密码会被
 * **静默丢掉**（留空 = 不修改）。这不是脱敏的目的，所以要补回来。
 *
 * 语义（逐条都有测试）：只透传**顶层**的 `password` / `clearPassword`，只在原始 DTO
 * 真的有这个键时透传，且**不覆盖**脚本自己给的值（脚本给不出真密码，但显式给
 * `clearPassword` 是它的合法意图）。返回新对象，不改入参。
 */
export function carryAccessSecretFields<T extends Record<string, any>>(
  original: Record<string, any> | null | undefined,
  rewritten: T,
): T {
  if (!original || !rewritten || typeof rewritten !== 'object') {
    return rewritten;
  }
  const out: any = { ...rewritten };
  for (const field of SECRET_EVENT_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(original, field) &&
      (original as any)[field] !== undefined &&
      out[field] === undefined
    ) {
      out[field] = (original as any)[field];
    }
  }
  return out as T;
}

export { isScryptHash, needsPasswordUpgrade };
