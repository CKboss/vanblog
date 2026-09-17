import { BadRequestException } from '@nestjs/common';

/**
 * 定时发布（P5）的公共语义。
 *
 * **实现选择：「到点前视为未发布」是查询层过滤，而不是 cron 翻 `hidden` 字段。**
 * 理由（在两条路里选了这条）：
 *  1. 翻 hidden 的方案把"文章可见性"押在 cron 活着上 —— cron 挂了/进程重启错过窗口，
 *     文章就永远不出现；查询层过滤是**到点自动生效**，没有任何"必须成功执行一次写"的环节。
 *  2. 翻 hidden 会与管理员手动设置的 hidden 互相踩踏（cron 到点把管理员刚隐藏的文章翻出来），
 *     要再加一个 scheduledHidden 标记字段与一套同步规则，状态机复杂一倍。
 *  3. 过滤集中在本文件的 `visiblePublishFilter()`，所有公开读路径共用同一段
 *     `{$or:[null, 不存在, <=now]}`，可测试、可穷举（provider 层有逐路径钉子）。
 *
 * ⚠️ 唯一的代价：**每一条公开读路径都必须带上这个过滤**（漏一条就是泄露）。
 * 所以 article.provider.publishAt.spec.ts 把所有公开入口逐个钉住，
 * 新增公开查询时必须过那个 spec。管理端（admin view / includeHidden=true）不过滤 ——
 * 后台必须始终能看到"还没到点"的文章。
 */

/** 归一化后的 publishAt：Date = 定时；null = 不定时（立即可见语义）；undefined = 本次不改。 */
export type NormalizedPublishAt = Date | null | undefined;

/**
 * 保存路径的入参归一化（DTO 里是 `publishAt?: Date | string | number | null`）：
 *  - `undefined` / 键不存在 → undefined（**保持原值不动**，与 null 严格区分：
 *    管理端清空选择器时显式发 null，JSON.stringify 会丢 undefined —— 两种语义不能混）；
 *  - `null` 或 `''` → null（清除定时，立即按 hidden 语义走）；
 *  - Date / 可解析的字符串或毫秒数 → Date；
 *  - 解析不出来的（'明天'、NaN、对象、布尔）→ 400，绝不静默存成 Invalid Date
 *    （Invalid Date 存进 Mongo 会抛 CastError 变 500，读出来又是 null —— 两头都是坑）。
 */
export function normalizePublishAt(value: unknown): NormalizedPublishAt {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BadRequestException('publishAt 不是合法时间');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`publishAt 不是合法时间：${String(value).slice(0, 100)}`);
    }
    return parsed;
  }
  throw new BadRequestException('publishAt 只接受 ISO 时间字符串、毫秒数或 null');
}

/** publishAt 是否还在未来（= 公开面不可见）。缺失/null/非法一律按"不定时"处理。 */
export function isFuturePublish(publishAt: unknown, now: Date = new Date()): boolean {
  if (!publishAt) {
    return false;
  }
  const date = publishAt instanceof Date ? publishAt : new Date(publishAt as any);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getTime() > now.getTime();
}

/**
 * 公开读路径共用的"未发布不可见"过滤器（push 进查询的 $and 里）：
 * `publishAt` 为 null / 不存在 / <= now 才算已发布。
 */
export function visiblePublishFilter(now: Date = new Date()): Record<string, unknown> {
  return {
    $or: [
      { publishAt: null },
      { publishAt: { $exists: false } },
      { publishAt: { $lte: now } },
    ],
  };
}
