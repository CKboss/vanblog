/**
 * 服务端下发的「阅读时间」展示工具。
 *
 * 契约（server 侧另一个代理在实现，两边都按防御式写）：
 * `readingMinutes` 是**整数 ≥ 1**，出现在公开列表 payload（toListView）与文章详情
 * payload 的 article 对象上。字段是可选的：server 没实现、旧 ISR 缓存页、或接口
 * 降级时都可能缺失 —— 缺失/非法一律返回 null，UI **什么都不渲染**。
 *
 * ⚠️ 不要在客户端从正文兜底计算：列表接口（withExcerpt）已经不再下发 content，
 * 本地既算不了，也不该算（两份实现会漂，见 §7.42 的教训）。
 */

/** 把任意输入收敛成"可展示的分钟数"；不合法返回 null（绝不产出 NaN/0/负数）。 */
export function normalizeReadingMinutes(raw: unknown): number | null {
  if (raw == null || raw === "") {
    return null;
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  // 契约是整数；真收到小数（server 侧口径变化）就向下取整，也比渲染 "2.7 分钟" 好
  return Math.floor(n);
}

/** 展示文案："约 N 分钟"；不可展示时返回 null，调用方据此整块不渲染。 */
export function formatReadingTime(raw: unknown): string | null {
  const n = normalizeReadingMinutes(raw);
  return n == null ? null : `约 ${n} 分钟`;
}
