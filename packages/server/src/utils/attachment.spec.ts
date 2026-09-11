import { BadRequestException } from '@nestjs/common';
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
