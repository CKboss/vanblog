import {
  DEFAULT_READING_SPEED_WPM,
  READING_SPEED_ENV,
  readingMinutesFromContent,
  readingMinutesFromUnits,
  resolveReadingSpeed,
} from './readingTime';

/** P6 阅读时长：除数 350、非空文章 ≥1、空文章 0、env 可调且有夹取。 */

describe('resolveReadingSpeed', () => {
  const OLD = process.env[READING_SPEED_ENV];
  afterEach(() => {
    if (OLD === undefined) delete process.env[READING_SPEED_ENV];
    else process.env[READING_SPEED_ENV] = OLD;
  });

  it('默认 350（中文阅读速度建议区间 300–400 的中值）', () => {
    expect(DEFAULT_READING_SPEED_WPM).toBe(350);
    expect(resolveReadingSpeed(undefined)).toBe(350);
    delete process.env[READING_SPEED_ENV];
    expect(resolveReadingSpeed()).toBe(350);
  });

  it('env 覆盖 + 非法回落 + 夹在 [50, 2000]', () => {
    expect(resolveReadingSpeed('400')).toBe(400);
    expect(resolveReadingSpeed('abc')).toBe(350);
    expect(resolveReadingSpeed('-1')).toBe(350); // 非正数 = 非法 → 回落
    expect(resolveReadingSpeed('10')).toBe(50); // 低于下限 → 夹到 50
    expect(resolveReadingSpeed('999999')).toBe(2000);
  });
});

describe('readingMinutesFromUnits / FromContent', () => {
  it('非空 ≥1；整除向上取整；空 → 0', () => {
    expect(readingMinutesFromUnits(0)).toBe(0);
    expect(readingMinutesFromUnits(-5)).toBe(0);
    expect(readingMinutesFromUnits(NaN)).toBe(0);
    expect(readingMinutesFromUnits(1)).toBe(1);
    expect(readingMinutesFromUnits(350)).toBe(1);
    expect(readingMinutesFromUnits(351)).toBe(2);
    expect(readingMinutesFromUnits(3500, 350)).toBe(10);
  });

  it('从正文算：CJK 按字、拉丁按词（与站点总字数同一口径）', () => {
    // 700 个汉字 → 700 单位 → ceil(700/350) = 2
    expect(readingMinutesFromContent('汉'.repeat(700))).toBe(2);
    // 400 个英文单词 → 400 单位 → ceil(400/350) = 2
    expect(readingMinutesFromContent(Array(400).fill('word').join(' '))).toBe(2);
    expect(readingMinutesFromContent('')).toBe(0);
    expect(readingMinutesFromContent(null)).toBe(0);
    expect(readingMinutesFromContent(undefined)).toBe(0);
    // 一篇 2 万字的中文长文 → 58 分钟（方向合理性）
    expect(readingMinutesFromContent('字'.repeat(20000))).toBe(Math.ceil(20000 / 350));
  });
});
