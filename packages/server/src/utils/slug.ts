import { pinyin } from 'pinyin-pro';

/**
 * Article pathnames double as URL path segments (`/post/<pathname>`), so only
 * unreserved characters survive. Very long slugs get truncated by chat clients
 * and search results, hence the cap.
 */
export const SLUG_MAX_LENGTH = 60;

/** Everything that is not a lowercase letter or a digit becomes a separator. */
const DISALLOWED_RUN = /[^a-z0-9]+/g;

function truncateSlug(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) {
    return slug;
  }
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  // Prefer cutting on a syllable boundary; never keep a trailing separator.
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** Normalize arbitrary text into a lowercase, dash-separated, URL-safe slug. */
export function slugify(input: unknown, maxLength = SLUG_MAX_LENGTH): string {
  const slug = String(input ?? '')
    .toLowerCase()
    .trim()
    .replace(DISALLOWED_RUN, '-')
    .replace(/^-+|-+$/g, '');
  return truncateSlug(slug, maxLength);
}

/**
 * A pathname is looked up *before* the numeric id (`getByIdOrPathname`), so an
 * all-digit pathname would shadow the article that owns that id. Such slugs are
 * rejected and the article keeps its `/post/<id>` URL.
 */
function isAmbiguousWithId(slug: string): boolean {
  return /^\d+$/.test(slug);
}

/**
 * Default pathname for an article title: Chinese becomes toneless pinyin
 * (`pinyin-pro` resolves multi-tone characters by phrase), other scripts are
 * kept verbatim, then the result is slugified.
 *
 * Returns `''` when nothing URL-safe is left (emoji-only titles) or when the
 * slug would collide with the numeric-id route.
 */
export function titleToSlug(title: unknown, maxLength = SLUG_MAX_LENGTH): string {
  const raw = String(title ?? '').trim();
  if (!raw) {
    return '';
  }
  const syllables = pinyin(raw, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
    // ü has to become "v": the raw umlaut is not URL-safe and would be
    // stripped into a stray dash (策略 → ce-lue, not ce-l-e).
    v: true,
  });
  const slug = slugify(syllables.join('-'), maxLength);
  if (!slug || isAmbiguousWithId(slug)) {
    return '';
  }
  return slug;
}

/**
 * Ordered pathname candidates for a slug: the bare slug, then `-2`, `-3`, … and
 * finally `-<fallbackId>`, so duplicated titles still get a stable, meaningful
 * URL. Callers take the first candidate that is free in the database.
 */
export function slugCandidates(
  slug: string,
  fallbackId?: number | string,
  limit = 10,
): string[] {
  const base = slugify(slug);
  if (!base || isAmbiguousWithId(base)) {
    return [];
  }
  const candidates = [base];
  for (let i = 2; i <= limit; i += 1) {
    candidates.push(truncateSlug(`${base}-${i}`, SLUG_MAX_LENGTH));
  }
  const id = String(fallbackId ?? '').trim();
  if (id) {
    candidates.push(truncateSlug(`${base}-${id}`, SLUG_MAX_LENGTH));
  }
  return candidates;
}
