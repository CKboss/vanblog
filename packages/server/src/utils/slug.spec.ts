import { SLUG_MAX_LENGTH, slugCandidates, slugify, titleToSlug } from './slug';

describe('slugify', () => {
  it('lowercases and replaces every disallowed run with a single dash', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('  Foo,,BAR__baz  ')).toBe('foo-bar-baz');
    expect(slugify('a/b?c=d&e')).toBe('a-b-c-d-e');
  });

  it('keeps digits and drops leading/trailing separators', () => {
    expect(slugify('2024-摄影')).toBe('2024');
    expect(slugify('---x---')).toBe('x');
  });

  it('returns an empty string for input without URL-safe characters', () => {
    expect(slugify('')).toBe('');
    expect(slugify(undefined)).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify('🎉🎉')).toBe('');
  });

  it('truncates on a dash boundary instead of mid-word', () => {
    const slug = slugify('alpha beta gamma delta epsilon zeta eta theta', 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug).toBe('alpha-beta-gamma');
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to a hard cut when a single token exceeds the limit', () => {
    expect(slugify('supercalifragilistic', 10)).toBe('supercalif');
  });
});

describe('titleToSlug', () => {
  it('converts Chinese titles into toneless pinyin', () => {
    expect(titleToSlug('QDII基金限购与纳指风味基金分析')).toBe(
      'qdii-ji-jin-xian-gou-yu-na-zhi-feng-wei-ji-jin-fen-xi',
    );
    expect(titleToSlug('为ClaudeCode接入第三方LLM')).toBe(
      'wei-claudecode-jie-ru-di-san-fang-llm',
    );
  });

  it('resolves multi-tone characters by phrase', () => {
    // 掌握 reads zhang wo here; a per-character table would give "zhang wo"/"zhang yue".
    expect(titleToSlug('快速掌握')).toBe('kuai-su-zhang-wo');
    expect(titleToSlug('重新开始')).toBe('chong-xin-kai-shi');
  });

  it('writes ü as v so the slug stays URL-safe', () => {
    expect(titleToSlug('绿色')).toBe('lv-se');
    expect(titleToSlug('业余投资者的投资策略')).toBe('ye-yu-tou-zi-zhe-de-tou-zi-ce-lve');
  });

  it('keeps punctuation and latin words as separators/segments', () => {
    expect(titleToSlug('[摄影] 2024-厦门')).toBe('she-ying-2024-xia-men');
    expect(titleToSlug('齿比搭配, 看Gear Inch')).toBe('chi-bi-da-pei-kan-gear-inch');
  });

  it('stays within the length cap without a trailing dash', () => {
    const long = titleToSlug(
      '这是一个非常非常非常非常非常非常非常非常非常非常非常非常长的中文文章标题用来测试截断行为',
    );
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(long.endsWith('-')).toBe(false);
    expect(long.split('-').every((part) => /^[a-z0-9]+$/.test(part))).toBe(true);
  });

  it('refuses slugs that would shadow the numeric id route', () => {
    // /post/<id> resolves by pathname first, so "2024" must not become a pathname.
    expect(titleToSlug('2024')).toBe('');
    // A dash already makes it unparseable as an id, so it is safe to keep.
    expect(titleToSlug('123 456')).toBe('123-456');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(titleToSlug('')).toBe('');
    expect(titleToSlug('   ')).toBe('');
    expect(titleToSlug('🎉')).toBe('');
    expect(titleToSlug(undefined)).toBe('');
  });
});

describe('slugCandidates', () => {
  it('offers the bare slug, numeric suffixes and finally the article id', () => {
    const candidates = slugCandidates('my-post', 7);
    expect(candidates.slice(0, 4)).toEqual([
      'my-post',
      'my-post-2',
      'my-post-3',
      'my-post-4',
    ]);
    expect(candidates[candidates.length - 1]).toBe('my-post-7');
  });

  it('normalizes a raw title passed straight in', () => {
    expect(slugCandidates('Hello World')[0]).toBe('hello-world');
  });

  it('returns no candidate for unusable slugs', () => {
    expect(slugCandidates('')).toEqual([]);
    expect(slugCandidates('2024', 5)).toEqual([]);
    expect(slugCandidates('🎉')).toEqual([]);
  });

  it('works without a fallback id', () => {
    const candidates = slugCandidates('dup-title');
    expect(candidates[0]).toBe('dup-title');
    expect(candidates.some((c) => c.endsWith('-undefined'))).toBe(false);
  });
});
