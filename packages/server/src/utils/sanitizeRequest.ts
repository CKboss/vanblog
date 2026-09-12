import type { NextFunction, Request, Response } from 'express';

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
 * 注意：整站备份/导入走的是 **multipart 文件上传**，扩展 JSON（`{"$oid": ...}`）在文件里，
 * 不经过 body 净化，因此不受影响。
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
