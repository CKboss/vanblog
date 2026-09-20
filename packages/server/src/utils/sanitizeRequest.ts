import type { NextFunction, Request, Response } from 'express';
import { ArgumentMetadata, HttpStatus, Injectable, PayloadTooLargeException, PipeTransform } from '@nestjs/common';

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
 *
 * ⚠️ **净化本身也是一条 DoS 路径，所以它有成本上界**（见下面的 `SANITIZE_MAX_NODES_ENV`）：
 * 中间件顺序是 `[json][sanitize][static403]…[rateLimit][init][router]`，也就是说**解析与净化
 * 跑在限流器和鉴权之前**。一个"键极多、值极短"的 body 能把递归净化的成本放到最大
 * （实测最省字节的形状约 96,335 键/MB，净化 ≈ 91 ms/MB，且**严格线性**：16MB → 约 1000 ms），
 * 而 `main.ts` 的四个大限额解析器只按**路径**匹配、不看鉴权 ⇒ 匿名用户就能对
 * `/api/admin/article` 投 50MB，最终虽然 401，CPU 已经烧完；被限流 429 的请求同样烧满，
 * **限流器对这条路径零保护**。默认单 worker 下约 8 个这种请求/分钟就能让事件循环 100% 忙，
 * 于是前台 SSR 与健康检查全部假死，而容器仍是 Up、`restart` 策略不介入。
 *
 * 超限时**拒绝请求（413）而不是跳过净化**：跳过就等于把 `$` 操作符与 `__proto__` 原样放过去，
 * 那正是上面那组注入。宁可让一个畸形请求失败，也不能让"太大"变成绕过净化的条件。
 */
const FORBIDDEN_KEY = /^(\$|__proto__$|^constructor$|^prototype$)/;
const MAX_DEPTH = 8;

/** 净化成本上界的环境变量名（单位：访问到的 JSON 节点数） */
export const SANITIZE_MAX_NODES_ENV = 'VANBLOG_SANITIZE_MAX_NODES';
/**
 * 默认 50,000 个节点。依据是**本站合法 body 的真实形状**，不是拍脑袋：
 *  - 需要大 body 的四类路由（文章/草稿/自定义页面/管线）体积大在**字符串值**上
 *    （正文内嵌 base64 图片、整页 HTML/JS、脚本正文），键数只有几十个 —— 净化只递归
 *    对象与数组、只测键名，**字符串值原样返回**，所以 50MB 的合法正文只花几十个节点；
 *  - 200MB 的旧版 JSON 导入走 **multipart**（`uploadLimits.ts` 的 `JSON_IMPORT_UPLOAD_OPTIONS`），
 *    根本不经过 `express.json`，也就到不了这里；multipart 的文本字段永远是字符串，
 *    管道对它们是 O(1)；
 *  - 查询串另有 qs 的 `parameterLimit`（默认 1000）与 depth 限制兜着。
 * ⇒ 50,000 比任何合法请求高出三个数量级，而把最坏情况的净化成本从"50MB ≈ 7.5 秒同步阻塞"
 *   压到约 33 ms。夹取范围 1,000–5,000,000；写错值一律回落默认，**绝不会变成不限**。
 */
export const DEFAULT_SANITIZE_MAX_NODES = 50_000;
const MIN_SANITIZE_MAX_NODES = 1_000;
const MAX_SANITIZE_MAX_NODES = 5_000_000;

/**
 * 把环境变量清洗成一个可用的节点上限。三种情况分开处理，**没有一种是"不限"**：
 *
 * ⚠️ 默认参数刻意写成 `process.env.VANBLOG_SANITIZE_MAX_NODES` 这种**点号字面量**，而不是
 * `process.env[SANITIZE_MAX_NODES_ENV]`：`utils/envVarMentions.spec.ts` 要求"用户可见字符串里
 * 提到的变量名必须有真实读取点"，点号形式是它无条件认得的形状（本文件下面的 413 消息里
 * 就提到了这个变量名）。
 *  - 缺失 / 非纯数字（`abc`、`1e6`、`-5`、空串）→ 回落默认 50,000；
 *  - 是纯数字但小于下限（含 `0`）→ 夹到 1,000。⚠️ `0` **不是**"关闭检查"，
 *    这条上界是安全边界，没有关闭档位；
 *  - 大于上限 → 夹到 5,000,000。
 */
export function resolveSanitizeMaxNodes(
  raw: unknown = process.env.VANBLOG_SANITIZE_MAX_NODES,
): number {
  const text = String(raw ?? '').trim();
  if (!text || !/^\d+$/.test(text)) {
    return DEFAULT_SANITIZE_MAX_NODES;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SANITIZE_MAX_NODES;
  }
  if (parsed < MIN_SANITIZE_MAX_NODES) {
    return MIN_SANITIZE_MAX_NODES;
  }
  return Math.min(parsed, MAX_SANITIZE_MAX_NODES);
}

/** 净化过程中访问到的节点数（对象/数组/键值都算一个），用来给递归设一个硬上界。 */
export interface SanitizeBudget {
  visited: number;
  limit: number;
}

/**
 * 超过成本上界时抛出的错误。
 *
 * ⚠️ 必须是**可识别**的类型：中间件与管道都要把它与"净化本身出 bug"区分开 ——
 * 后者的既有取舍是"不让请求挂掉、交给业务校验"，而前者必须拒绝请求。
 */
export class SanitizeBudgetError extends Error {
  readonly visited: number;
  readonly limit: number;

  constructor(visited: number, limit: number) {
    super(`request payload has too many JSON nodes to sanitize: ${visited} > ${limit}`);
    this.name = 'SanitizeBudgetError';
    this.visited = visited;
    this.limit = limit;
  }
}

/** 给客户端看的可照做消息（中间件与管道共用一份，避免两处口径漂移）。 */
export function sanitizeBudgetMessage(limit: number): string {
  return (
    `请求体的 JSON 结构过于复杂（可净化的节点数超过 ${limit}），已被拒绝。` +
    `正常的文章正文、自定义页面与管线脚本即使有几十 MB 也只有几十个节点，` +
    `所以这条限制不影响它们；如果你确实在提交一个键极多的对象（例如批量数据），` +
    `请改用「数据管理 → 导入」的文件上传通道，或调大 ${SANITIZE_MAX_NODES_ENV}。`
  );
}

export function isSanitizeBudgetError(err: unknown): err is SanitizeBudgetError {
  return err instanceof SanitizeBudgetError || (err as any)?.name === 'SanitizeBudgetError';
}

/**
 * 递归删掉危险键。
 *
 * @param budget 可选的成本计数器；不传就用环境变量解析出的默认上界新建一个。
 *   ⚠️ 传入同一个 budget 可以让**多次调用共享一个上界**（中间件对 query/params/body
 *   各调一次，攻击者 otherwise 能用三倍预算）。
 * @throws SanitizeBudgetError 访问的节点数超过上界。
 */
export function stripOperatorKeys(value: unknown, depth = 0, budget?: SanitizeBudget): any {
  const state: SanitizeBudget =
    budget ?? { visited: 0, limit: resolveSanitizeMaxNodes() };
  state.visited += 1;
  if (state.visited > state.limit) {
    throw new SanitizeBudgetError(state.visited, state.limit);
  }
  if (depth > MAX_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripOperatorKeys(item, depth + 1, state));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      state.visited += 1;
      if (state.visited > state.limit) {
        throw new SanitizeBudgetError(state.visited, state.limit);
      }
      if (FORBIDDEN_KEY.test(key)) {
        continue;
      }
      out[key] = stripOperatorKeys((value as Record<string, unknown>)[key], depth + 1, state);
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

export function sanitizeRequestPayloads(req: Request, res: Response, next: NextFunction) {
  // ⚠️ 三处净化**共享一个预算**：否则攻击者可以把节点数摊到 query / params / body 上，
  //    拿到三倍于配置值的成本。
  const budget: SanitizeBudget = { visited: 0, limit: resolveSanitizeMaxNodes() };
  try {
    if (req.query) {
      Object.defineProperty(req, 'query', {
        value: stripOperatorKeys(req.query, 0, budget),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (req.params) {
      req.params = stripOperatorKeys(req.params, 0, budget);
    }
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      req.body = stripOperatorKeys(req.body, 0, budget);
    }
  } catch (err) {
    if (isSanitizeBudgetError(err)) {
      // 成本上界是**安全边界**，不能像"净化出 bug"那样放过：直接拒绝，并且不进 next()
      // （否则半净化的 body 会继续往下走，`$` 键可能已经在里面了）。
      if (!res.headersSent && typeof res.status === 'function') {
        res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          message: sanitizeBudgetMessage(budget.limit),
        });
        return;
      }
      return;
    }
    // 其它异常保持既有取舍：净化失败不应该让请求挂掉，交给后面的业务校验
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
 * ⚠️ 幂等也意味着**预算会被数第二遍**：中间件已经花掉的节点数不会带过来，所以管道
 * 用的是一个新预算。JSON 接口因此最坏花 2× 上限；multipart 接口只走管道这一遍，
 * 而它的字段都是字符串（O(1)），所以这条对真实攻击面没有放大作用。
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
    } catch (err) {
      if (isSanitizeBudgetError(err)) {
        // 与中间件同一个取舍：超限就拒绝（413），绝不"跳过净化放行"
        throw new PayloadTooLargeException(sanitizeBudgetMessage(err.limit));
      }
      // 其它异常与中间件同一取舍：净化本身不该成为可用性风险
      return value;
    }
  }
}
