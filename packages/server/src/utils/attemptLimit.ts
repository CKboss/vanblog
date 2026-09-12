/**
 * 一个极小的内存计数器，用来给「没有登录态、又不该被无限试」的接口做限流。
 *
 * 目前用在 `POST /api/public/article/:id`（输密码解锁加密文章）：
 * 密码是明文比较、又没有任何限制，等于可以无限速爆破。
 * 登录接口有 LoginGuard，这里不重复造轮子，用同一套思路。
 */
interface Bucket {
  count: number;
  firstAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20000;

export interface AttemptLimitOptions {
  max: number;
  windowMs: number;
}

export function consumeAttempt(
  key: string,
  { max, windowMs }: AttemptLimitOptions,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const hit = buckets.get(key);
  if (!hit || now - hit.firstAt > windowMs) {
    if (buckets.size > MAX_BUCKETS) {
      // 防止被大量不同 key 撑爆内存：直接清空重来（限流是尽力而为，不是账本）
      buckets.clear();
    }
    buckets.set(key, { count: 1, firstAt: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  hit.count += 1;
  if (hit.count > max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((hit.firstAt + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetAttempts(key: string): void {
  buckets.delete(key);
}
