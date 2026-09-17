import { wordCount } from './wordCount';

/**
 * 阅读时长估算（P6）。
 *
 * 单位口径直接复用 `utils/wordCount.ts`（与站点"总字数"、ByteMD 编辑器状态栏同一套）：
 * 每个 CJK 字符算 1、每个拉丁/数字词算 1。
 *
 * **除数选 350 单位/分钟**，理由：中文成年读者的默读速度常见口径是 300–500 字/分钟，
 * 任务给的建议区间是 300–400；本站是中文为主、夹杂代码与英文的技术博客，
 * 代码块会拖慢实际速度，取建议区间的中值偏保守 350。
 * 可用 `VANBLOG_READING_SPEED_WPM` 调（夹在 50–2000，非法值回落默认）。
 */

export const READING_SPEED_ENV = 'VANBLOG_READING_SPEED_WPM';
export const DEFAULT_READING_SPEED_WPM = 350;
const MIN_SPEED = 50;
const MAX_SPEED = 2000;

export function resolveReadingSpeed(
  raw: string | undefined = process.env[READING_SPEED_ENV],
  fallback: number = DEFAULT_READING_SPEED_WPM,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.floor(n)));
}

/**
 * 由"字数单位"得出阅读分钟数：
 *  - 0 / 负数 / 非数 → 0（空文章没有阅读时长，字段消费方按"未知"处理）；
 *  - 任何非空文章 ≥ 1（任务契约：integer ≥ 1 for any non-empty article）。
 */
export function readingMinutesFromUnits(
  units: number,
  speed: number = resolveReadingSpeed(),
): number {
  if (!Number.isFinite(units) || units <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(units / speed));
}

/** 由正文现算（详情页/列表带 content 时的最准路径）。 */
export function readingMinutesFromContent(content: string | null | undefined): number {
  return readingMinutesFromUnits(wordCount(content ?? ''));
}
