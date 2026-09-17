import { BadRequestException } from '@nestjs/common';
import { isFuturePublish, normalizePublishAt, visiblePublishFilter } from './publishAt';

/** P5 定时发布的语义单元：归一化、"未来"判定、公开过滤器形状。 */

describe('normalizePublishAt', () => {
  it('undefined = 键不存在 = 本次不改（与 null 严格区分）', () => {
    expect(normalizePublishAt(undefined)).toBeUndefined();
  });

  it('null / 空串 = 显式清除定时', () => {
    expect(normalizePublishAt(null)).toBeNull();
    expect(normalizePublishAt('')).toBeNull();
  });

  it('ISO 字符串 / 毫秒数 / Date → Date', () => {
    const d = normalizePublishAt('2030-01-02T03:04:05.000Z');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(normalizePublishAt(1893456000000)).toBeInstanceOf(Date);
    const date = new Date('2030-05-05T00:00:00Z');
    expect(normalizePublishAt(date)).toBe(date);
  });

  it('垃圾输入 → 400（绝不静默存 Invalid Date）', () => {
    for (const bad of ['明天', 'abc', NaN, {}, [], true, { $date: 'x' }]) {
      expect(() => normalizePublishAt(bad)).toThrow(BadRequestException);
    }
    expect(() => normalizePublishAt(new Date('invalid'))).toThrow(BadRequestException);
  });
});

describe('isFuturePublish', () => {
  const now = new Date('2026-09-17T00:00:00Z');
  it('未来 → true；过去/缺失/非法 → false（缺失=不定时=立即可见）', () => {
    expect(isFuturePublish(new Date('2026-09-18T00:00:00Z'), now)).toBe(true);
    expect(isFuturePublish('2026-09-18T00:00:00Z', now)).toBe(true);
    expect(isFuturePublish(new Date('2026-09-16T00:00:00Z'), now)).toBe(false);
    expect(isFuturePublish(null, now)).toBe(false);
    expect(isFuturePublish(undefined, now)).toBe(false);
    expect(isFuturePublish(new Date('invalid'), now)).toBe(false);
    // 恰好等于 now = 已到点（$lte 语义一致）
    expect(isFuturePublish(now, now)).toBe(false);
  });
});

describe('visiblePublishFilter', () => {
  it('形状钉死：null / 不存在 / <= now 三支 $or（改形状必须过所有 provider 钉子）', () => {
    const now = new Date('2026-09-17T00:00:00Z');
    expect(visiblePublishFilter(now)).toEqual({
      $or: [
        { publishAt: null },
        { publishAt: { $exists: false } },
        { publishAt: { $lte: now } },
      ],
    });
  });
});
