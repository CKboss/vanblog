import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  ATTACHMENT_FOLDER,
  ATTACHMENT_MAX_BYTES,
  attachmentDisposition,
  attachmentExtOf,
  attachmentHeadersFor,
  assertAttachmentSize,
  buildStoredFileName,
  decodeUploadFileName,
  displayFileName,
  isAttachmentPath,
  isForcedDownloadExt,
  sanitizeAttachmentName,
  sanitizeDispositionFilename,
} from './attachment';

const SIGN = 'a'.repeat(32);

describe('attachmentExtOf / isForcedDownloadExt', () => {
  it('reads the lowercased extension', () => {
    expect(attachmentExtOf('report.PDF')).toBe('pdf');
    expect(attachmentExtOf('archive.tar.gz')).toBe('gz');
    expect(attachmentExtOf('noext')).toBe('');
    expect(attachmentExtOf('.gitignore')).toBe('');
    expect(attachmentExtOf('trailing.')).toBe('');
    expect(attachmentExtOf(undefined)).toBe('');
  });

  it('forces download only for types a browser would execute in our origin', () => {
    for (const ext of ['html', 'htm', 'svg', 'xml', 'js', 'mjs', 'xhtml']) {
      expect(isForcedDownloadExt(ext)).toBe(true);
    }
    for (const ext of ['pdf', 'zip', 'png', 'webp', 'epub', 'docx', 'txt', '']) {
      expect(isForcedDownloadExt(ext)).toBe(false);
    }
  });
});

describe('sanitizeAttachmentName', () => {
  it('keeps ordinary names, including spaces and CJK', () => {
    expect(sanitizeAttachmentName('年度报告.pdf')).toBe('年度报告.pdf');
    expect(sanitizeAttachmentName('my report v2.docx')).toBe('my report v2.docx');
  });

  it('strips path traversal and separators', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('C:\\Users\\me\\file.txt')).toBe('file.txt');
    expect(sanitizeAttachmentName('/static/file/evil.html')).toBe('evil.html');
  });

  it('drops leading dots, quotes and control characters', () => {
    expect(sanitizeAttachmentName('.htaccess')).toBe('htaccess');
    expect(sanitizeAttachmentName('..')).toBe('attachment');
    expect(sanitizeAttachmentName('a"b\'c.txt')).toBe('abc.txt');
    expect(sanitizeAttachmentName('bad\u0000name.pdf')).toBe('badname.pdf');
  });

  it('falls back to a generic name when nothing is left', () => {
    expect(sanitizeAttachmentName('')).toBe('attachment');
    expect(sanitizeAttachmentName(undefined)).toBe('attachment');
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
  });

  it('truncates very long names but keeps the extension', () => {
    const long = `${'长'.repeat(200)}.pdf`;
    const result = sanitizeAttachmentName(long);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('stored / display names', () => {
  it('prefixes the stored name with the content hash', () => {
    expect(buildStoredFileName(SIGN, '../报告.pdf')).toBe(`${SIGN}.报告.pdf`);
  });

  it('hides the hash again when showing the name to users', () => {
    expect(displayFileName(`${SIGN}.报告.pdf`)).toBe('报告.pdf');
    expect(displayFileName('legacy-name.png')).toBe('legacy-name.png');
  });
});

describe('attachmentDisposition / headers', () => {
  it('forces download for html and svg with an RFC 5987 filename', () => {
    const disposition = attachmentDisposition(`${SIGN}.年度报告.html`);
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent('年度报告.html'));
    // ASCII 兜底里不能有裸引号
    expect(disposition.match(/filename="([^"]*)"/)?.[1]).not.toContain('"');
    expect(attachmentDisposition(`${SIGN}.logo.svg`)).toMatch(/^attachment/);
  });

  it('leaves previews (pdf/zip/images) inline', () => {
    expect(attachmentDisposition(`${SIGN}.book.pdf`)).toBeUndefined();
    expect(attachmentDisposition(`${SIGN}.src.zip`)).toBeUndefined();
    expect(attachmentDisposition(`${SIGN}.photo.webp`)).toBeUndefined();
  });

  it('always sends nosniff for the attachment folder', () => {
    const dangerous = attachmentHeadersFor(`/var/vanblog/static/${ATTACHMENT_FOLDER}/${SIGN}.x.html`);
    expect(dangerous['X-Content-Type-Options']).toBe('nosniff');
    expect(dangerous['Content-Disposition']).toMatch(/^attachment/);

    const safe = attachmentHeadersFor(`/var/vanblog/static/${ATTACHMENT_FOLDER}/${SIGN}.x.pdf`);
    expect(safe).toEqual({ 'X-Content-Type-Options': 'nosniff' });
  });

  it('recognizes the attachment folder from an absolute path', () => {
    expect(isAttachmentPath(`/data/static/${ATTACHMENT_FOLDER}/a.pdf`)).toBe(true);
    expect(isAttachmentPath('/data/static/img/a.webp')).toBe(false);
    expect(isAttachmentPath('/data/static/customPage/block1/a.py')).toBe(false);
    expect(isAttachmentPath('')).toBe(false);
  });
});

describe('decodeUploadFileName', () => {
  it('re-decodes the latin1 filename busboy hands us', () => {
    const mangled = Buffer.from('测试附件.pdf', 'utf8').toString('latin1');
    expect(mangled).not.toBe('测试附件.pdf');
    expect(decodeUploadFileName(mangled)).toBe('测试附件.pdf');
  });

  it('leaves ASCII names untouched', () => {
    expect(decodeUploadFileName('report v2.pdf')).toBe('report v2.pdf');
  });

  it('keeps a value that is not valid UTF-8', () => {
    expect(decodeUploadFileName('\xff\xfe.pdf')).toBe('\xff\xfe.pdf');
  });

  it('handles missing values', () => {
    expect(decodeUploadFileName(undefined)).toBe('');
    expect(decodeUploadFileName('')).toBe('');
  });
});

describe('assertAttachmentSize', () => {
  it('accepts anything up to the cap', () => {
    expect(() => assertAttachmentSize(1024)).not.toThrow();
    expect(() => assertAttachmentSize(ATTACHMENT_MAX_BYTES)).not.toThrow();
  });

  it('rejects empty uploads', () => {
    expect(() => assertAttachmentSize(0)).toThrow(BadRequestException);
    expect(() => assertAttachmentSize(undefined)).toThrow(BadRequestException);
  });

  it('rejects oversized uploads with the limit in the message', () => {
    expect(() => assertAttachmentSize(ATTACHMENT_MAX_BYTES + 1)).toThrow(/200 MB/);
  });
});

/**
 * `Content-Disposition` 的文件名消毒。
 *
 * 为什么单独立一组钉子：正确写法以前**只存在于** `attachmentDisposition()` 里面，
 * 于是 `comment.controller.ts` 的评论导出把原始 `status` 查询参数直接拼进了带引号的
 * filename —— `?download=1&status=x"; filename="evil` 就能提前闭合引号再注入别的参数。
 * 现在消毒逻辑抽成了 `sanitizeDispositionFilename`，两处共用，这里钉住它的行为与"两处都在用"。
 */
describe('sanitizeDispositionFilename', () => {
  it('删掉双引号（否则能提前闭合 filename="…" 再注入参数）', () => {
    const evil = 'x"; filename="evil';
    const out = sanitizeDispositionFilename(evil);
    expect(out).not.toContain('"');
    // 整条头拼出来之后必须**只有一对引号**，且引号里的内容就是消毒结果 ——
    // 也就是攻击者给的字节一个都没能逃到引号外面。
    // ⚠️ 不要去断言"头里不再出现 filename= 这个词"：消毒只删引号，`filename=` 这几个字
    //    留在**引号内**是合法的 quoted-string 内容，注入不了任何东西（第一版就是这么写错的）。
    const header = `attachment; filename="vanblog-comments-${out}-2026.json"`;
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header.match(/filename="([^"]*)"/)![1]).toBe(`vanblog-comments-${out}-2026.json`);
    expect(out).not.toMatch(/[\r\n\u0000]/);
  });

  it('控制字符与 CR/LF 换成下划线（否则能拆行注入别的响应头）', () => {
    const out = sanitizeDispositionFilename('a\r\nSet-Cookie: x=1\u0000b');
    expect(out).not.toMatch(/[\r\n\u0000]/);
    expect(out).toContain('Set-Cookie'); // 内容留着没关系，拆不了行就注入不了
  });

  it('非 ASCII 也换成下划线（ASCII 兜底那一份，RFC 5987 的 filename* 另算）', () => {
    expect(sanitizeDispositionFilename('年度报告.html')).toBe('____.html');
  });

  it('空/全是非法字符 ⇒ 用 fallback，绝不产出空 filename', () => {
    expect(sanitizeDispositionFilename('', 'approved')).toBe('approved');
    expect(sanitizeDispositionFilename('   ', 'approved')).toBe('approved');
    expect(sanitizeDispositionFilename('"""', 'approved')).toBe('approved');
    expect(sanitizeDispositionFilename(undefined, 'approved')).toBe('approved');
    expect(sanitizeDispositionFilename(null)).toBe('download'); // 默认 fallback
  });

  it('正常值原样保留（别把功能修坏）', () => {
    expect(sanitizeDispositionFilename('approved')).toBe('approved');
    expect(sanitizeDispositionFilename('pending-review_1')).toBe('pending-review_1');
  });

  it('attachmentDisposition 走的就是这个消毒（回归钉子，防止又各写一遍）', () => {
    const disposition = attachmentDisposition(`${SIGN}x"; filename="evil.html`) || '';
    expect(disposition).toMatch(/^attachment; filename="/);
    // 带引号的 filename 段里不许再出现引号
    const quoted = disposition.match(/filename="([^"]*)"/);
    expect(quoted).toBeTruthy();
    expect(quoted![1]).not.toContain('"');
  });

  it('源码级钉子：评论导出用的是共享 helper，不是自己拼', () => {
    // ⚠️ 断言"不存在"之前先剥注释（本仓库踩过 6 次：解释性注释里就写着被禁的字符串）
    const src = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, '../controller/admin/comment/comment.controller.ts'), 'utf8'),
    );
    // 必须**用原始 status 参数**去调消毒函数（只断言"文件里出现过这个名字"是空的：
    // import 语句本身就能让它通过 —— 第一版就是这么写了个不会红的钉子）。
    expect(src).toMatch(/sanitizeDispositionFilename\(\s*status/);
    // 头里必须拼消毒后的变量，而不是把查询参数直接插进带引号的 filename
    expect(src).toMatch(/filename="vanblog-comments-\$\{safeStatus\}/);
    expect(src).not.toMatch(/filename="vanblog-comments-\$\{String\(status/);
  });
});
