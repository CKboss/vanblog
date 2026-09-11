import { BadRequestException } from '@nestjs/common';

/**
 * Pathnames end up as a single URL segment (`/post/<pathname>`), so they are
 * kept short and free of separators. `/c/<pathname*>` (custom pages) and the
 * article route would otherwise compete for the same request.
 */
export const PATHNAME_MAX_LENGTH = 100;

/** Trim surrounding whitespace and slashes; `''` means "use /post/<id>". */
export function normalizePathname(input: unknown): string {
  return String(input ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Reject manual pathnames that cannot work as an article URL.
 *
 * An empty value is allowed and means "no alias" (the article stays reachable
 * at `/post/<id>`). A purely numeric alias is rejected because
 * `getByIdOrPathname` matches pathnames *before* ids, so `pathname: "53"`
 * would shadow article 53.
 */
export function assertUsablePathname(pathname: string): void {
  if (!pathname) {
    return;
  }
  if (pathname.length > PATHNAME_MAX_LENGTH) {
    throw new BadRequestException(
      `路径别名过长（最多 ${PATHNAME_MAX_LENGTH} 个字符）：${pathname}`,
    );
  }
  if (pathname.includes('/')) {
    throw new BadRequestException(`路径别名不能包含 "/"：${pathname}`);
  }
  if (/^\d+$/.test(pathname)) {
    throw new BadRequestException(
      `路径别名不能是纯数字（会与文章 id 冲突）：${pathname}`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pathname)) {
    throw new BadRequestException('路径别名不能包含控制字符');
  }
}
