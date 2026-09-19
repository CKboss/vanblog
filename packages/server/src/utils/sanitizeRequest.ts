import type { NextFunction, Request, Response } from 'express';
import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

/**
 * 请求参数净化。
 *
 * 背景：项目**没有**全局 ValidationPipe，而 Express 默认的 qs 解析器会把
 * `?category[$ne]=x` 变成对象 `{ category: { $ne: 'x' } }`。这些对象被直接塞进
 * Mongo 过滤器（`getByOption`、`getOneByPath` 等），于是未鉴权的公开接口上就能：
 *
 *   GET /api/public/article?category[$regex]=客$   → 返回全站文章正文
 *   GET /api/public/article?category[$ne]=zzz      → 绕过分类过滤
 *   GET /api/public/customPage?path[$ne]=/nope     → 吐出任意一条自定义页面文档
 *   GET /api/public/article?tags[$ne]=x            → 500（option.tags.split 不是函数）
 *
 * 这里在**所有路由之前**递归删掉以 `$` 开头的键（Mongo 操作符）以及
 * `__proto__` / `constructor` / `prototype`（原型污染），对象结构保留、字符串值不动，
 * 所以正常的 markdown 正文、`$` 出现在值里（如 `$PATH`）都不受影响。
 *
 * 注意：整站备份/导入走的是 **multipart 文件上传**，multer 在这个中间件**之后**才填 `req.body`，
 * 所以那一半由本文件底部的 `SanitizeBodyPipe`（全局管道，跑在 FileInterceptor 之后）兜住。
 * 扩展 JSON（`{"$oid": ...}`）在**文件内容**里，两者都不碰它，因此不受影响。
 */
const FORBIDDEN_KEY = /^(\$|__proto__$|^constructor$|^prototype$)/;
const MAX_DEPTH = 8;

export function stripOperatorKeys(value: unknown, depth = 0): any {
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripOperatorKeys(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) {
        continue;
      }
      out[key] = stripOperatorKeys((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return value;
}

/** 只接受字符串（或能安全转成字符串的原始值），对象/数组一律视为非法输入。 */
export function asQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

export function sanitizeRequestPayloads(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.query) {
      Object.defineProperty(req, 'query', {
        value: stripOperatorKeys(req.query),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (req.params) {
      req.params = stripOperatorKeys(req.params);
    }
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      req.body = stripOperatorKeys(req.body);
    }
  } catch {
    // 净化失败不应该让请求挂掉，交给后面的业务校验
  }
  next();
}

/**
 * 兜住**中间件够不着的那一半**：multipart 的文本字段。
 *
 * `sanitizeRequestPayloads` 是 Express 中间件，跑在 `express.json()` 之后 —— 但 multer 是
 * Nest 的**方法级拦截器**（`@UseInterceptors(FileInterceptor('file'))`），它在中间件**之后**
 * 才把表单字段写进 `req.body`（`req.body = Object.create(null)` 然后逐字段 `appendField`）。
 * 所以中间件那一趟对 multipart 的文本字段是空转的，而本文件顶部的旧注释正是这么写的
 * （"整站备份/导入走 multipart……不经过 body 净化"）—— 那是一个**结构性缺口**：
 * 今天逐条核过没有"multipart 字段进 Mongo 查询"的路径，但形状就摆在那儿等着被踩。
 *
 * 为什么用全局 Pipe 而不是拦截器/中间件：Nest 的执行顺序是
 * 中间件 → 守卫 → 拦截器（前置） → **管道** → 处理器，
 * 管道正好跑在 FileInterceptor 之后、处理器之前 ⇒ 唯一能"在 multer 填完 body 之后"
 * 统一插一脚的位置。全局拦截器不行（它的前置阶段跑在方法级 FileInterceptor **之前**），
 * 中间件更不行。
 *
 * ⚠️ 覆盖面（有源码级守卫钉着，见 sanitizeRequest.multipart.spec.ts）：
 * 管道只处理**声明为参数**的 body（`@Body()` / `@Body('x')`）。用 `@Request()`/`@Req()`
 * 拿 req 再自己读 `req.body` 的写法它管不到 —— 目前 10 个 multipart 入口没有一个这么写
 * （唯一一处 `req.body` 出现在注释里），守卫会在有人这么写时立刻红。
 *
 * ⚠️ 对已经净化过的 JSON body 再跑一遍是**幂等**的（`stripOperatorKeys` 只删键，
 * 重复调用结果相同），所以全局挂上不会改变既有 JSON 接口的行为。
 */
@Injectable()
export class SanitizeBodyPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata?.type !== 'body') {
      return value;
    }
    // 文件缓冲、字符串（@Body('setupKey') 这种取单个字段的形状）与空值原样放过
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) {
      return value;
    }
    try {
      return stripOperatorKeys(value);
    } catch {
      // 与中间件同一取舍：净化本身不该成为可用性风险
      return value;
    }
  }
}
