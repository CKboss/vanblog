import { BadRequestException } from '@nestjs/common';

import { codedError } from 'src/utils/serverErrorCodes';
export type RewriteBaseUrlTextResult = {
  text: string;
  replacements: number;
};

export type RewriteBaseUrlCount = {
  updated: number;
  replacements: number;
};

export function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input.trim().replace(/\/+$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace an old site/static base URL with a new one inside stored markdown/HTML.
 * Trailing slashes on either side are ignored. A match is only counted when the
 * old base is a real URL prefix (end of string, or followed by `/ ? # " ' ) ]`
 * or whitespace) so `https://old.com.evil.com` is left alone.
 */
export function rewriteBaseUrlInText(
  text: string,
  oldBase: string,
  newBase: string,
): RewriteBaseUrlTextResult {
  const source = text ?? '';
  const oldNorm = normalizeBaseUrl(oldBase);
  const newNorm = normalizeBaseUrl(newBase);
  if (!source || !oldNorm || !newNorm || oldNorm === newNorm) {
    return { text: source, replacements: 0 };
  }

  const pattern = new RegExp(`${escapeRegExp(oldNorm)}(?=[/?#"')\\]\\s]|$)`, 'g');
  let replacements = 0;
  const next = source.replace(pattern, () => {
    replacements += 1;
    return newNorm;
  });
  return { text: next, replacements };
}

// 🔴 期 9 第九批：第二个参数从**中文 label**（'旧地址' / '新地址'）改成**语义 which**（'old' | 'new'）。
//    原来那句是 `${label}只支持 http 或 https 地址` ⇒ 中文当参数拼进消息，英文界面里就会夹中文
//    （本项目**第 6 次**处理这个形状）。拆成 6 个码而不是"3 个码 + {label} 参数"：
//    服务端的 `fillServerErrorMessage` 不实现 ICU select。
export function assertHttpBaseUrl(raw: string, which: 'old' | 'new'): void {
  const prefix = which === 'old' ? 'old' : 'new';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    if (prefix === 'old') throw codedError('oldBaseUrlNeedsProtocol');
    throw codedError('newBaseUrlNeedsProtocol');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    if (prefix === 'old') throw codedError('oldBaseUrlHttpOnly');
    throw codedError('newBaseUrlHttpOnly');
  }
  if (!parsed.hostname) {
    if (prefix === 'old') throw codedError('oldBaseUrlMissingHost');
    throw codedError('newBaseUrlMissingHost');
  }
}

/**
 * Returns normalized bases, or null when the rewrite should be a no-op
 * (missing old/new, or they are the same after stripping trailing slashes).
 * Throws when a non-empty value is not an http(s) URL.
 */
export function prepareRewriteBases(
  oldBase: unknown,
  newBase: unknown,
): { oldBase: string; newBase: string } | null {
  const oldNorm = normalizeBaseUrl(oldBase);
  const newNorm = normalizeBaseUrl(newBase);
  if (!oldNorm || !newNorm || oldNorm === newNorm) {
    return null;
  }
  assertHttpBaseUrl(oldNorm, 'old');
  assertHttpBaseUrl(newNorm, 'new');
  return { oldBase: oldNorm, newBase: newNorm };
}

export async function rewriteBaseUrlInDocuments(
  docs: Array<{ id: number; content?: string }>,
  updateContent: (id: number, content: string) => Promise<unknown>,
  oldBase: string,
  newBase: string,
): Promise<RewriteBaseUrlCount> {
  let updated = 0;
  let replacements = 0;
  for (const doc of docs) {
    const result = rewriteBaseUrlInText(doc.content || '', oldBase, newBase);
    if (result.replacements === 0) {
      continue;
    }
    await updateContent(doc.id, result.text);
    updated += 1;
    replacements += result.replacements;
  }
  return { updated, replacements };
}
