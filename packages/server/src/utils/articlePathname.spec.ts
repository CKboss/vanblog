import { BadRequestException } from '@nestjs/common';
import {
  PATHNAME_MAX_LENGTH,
  assertUsablePathname,
  normalizePathname,
} from './articlePathname';

describe('normalizePathname', () => {
  it('trims whitespace and surrounding slashes', () => {
    expect(normalizePathname('  /my-post/  ')).toBe('my-post');
    expect(normalizePathname('///a///')).toBe('a');
  });

  it('maps missing values to an empty alias', () => {
    expect(normalizePathname(undefined)).toBe('');
    expect(normalizePathname(null)).toBe('');
    expect(normalizePathname('   ')).toBe('');
  });

  it('keeps non-latin aliases untouched', () => {
    expect(normalizePathname('摄影-2024')).toBe('摄影-2024');
  });
});

describe('assertUsablePathname', () => {
  it('accepts an empty alias (the article keeps /post/<id>)', () => {
    expect(() => assertUsablePathname('')).not.toThrow();
  });

  it('accepts ordinary slugs', () => {
    expect(() => assertUsablePathname('my-post')).not.toThrow();
    expect(() => assertUsablePathname('post-53')).not.toThrow();
    expect(() => assertUsablePathname('摄影-2024')).not.toThrow();
  });

  it('rejects a purely numeric alias that would shadow an article id', () => {
    expect(() => assertUsablePathname('53')).toThrow(BadRequestException);
    expect(() => assertUsablePathname('007')).toThrow(BadRequestException);
  });

  it('rejects multi-segment aliases', () => {
    expect(() => assertUsablePathname('a/b')).toThrow(BadRequestException);
  });

  it('rejects over-long aliases', () => {
    expect(() => assertUsablePathname('a'.repeat(PATHNAME_MAX_LENGTH))).not.toThrow();
    expect(() => assertUsablePathname('a'.repeat(PATHNAME_MAX_LENGTH + 1))).toThrow(
      BadRequestException,
    );
  });

  it('rejects control characters', () => {
    expect(() => assertUsablePathname('a\u0000b')).toThrow(BadRequestException);
    expect(() => assertUsablePathname('a\nb')).toThrow(BadRequestException);
  });
});
