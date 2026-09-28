import { BadRequestException } from '@nestjs/common';
import {
  assertHttpBaseUrl,
  normalizeBaseUrl,
  prepareRewriteBases,
  rewriteBaseUrlInDocuments,
  rewriteBaseUrlInText,
} from './rewriteBaseUrl';

describe('normalizeBaseUrl', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl(' https://old.example.com/ ')).toBe('https://old.example.com');
    expect(normalizeBaseUrl('https://old.example.com///')).toBe('https://old.example.com');
    expect(normalizeBaseUrl('https://cdn.example.com/blog/')).toBe('https://cdn.example.com/blog');
  });

  it('treats missing values as empty', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
    expect(normalizeBaseUrl(1 as any)).toBe('');
  });
});

describe('rewriteBaseUrlInText (#475)', () => {
  const markdown = [
    '![cover](https://old.example.com/static/img/cover.webp)',
    '正文里还有 https://old.example.com/static/img/a.png 和一张相对路径 ![](/static/img/keep.webp)',
    '<img src="https://old.example.com/static/img/html.png">',
    '[外链](https://other.example.com/static/img/skip.png)',
    '以及 https://old.example.com.evil.com/phish.webp',
  ].join('\n');

  it('replaces the old base in markdown, HTML, and bare URLs', () => {
    const { text, replacements } = rewriteBaseUrlInText(
      markdown,
      'https://old.example.com',
      'https://new.example.com',
    );

    expect(replacements).toBe(3);
    expect(text).toContain('https://new.example.com/static/img/cover.webp');
    expect(text).toContain('https://new.example.com/static/img/a.png');
    expect(text).toContain('src="https://new.example.com/static/img/html.png"');
    expect(text).toContain('![](/static/img/keep.webp)');
    expect(text).toContain('https://other.example.com/static/img/skip.png');
    expect(text).toContain('https://old.example.com.evil.com/phish.webp');
    expect(text).not.toContain('https://old.example.com/static/');
  });

  it('treats trailing-slash variants of old and new as the same base', () => {
    const content = '![x](https://old.example.com/static/img/x.webp) and https://old.example.com/';
    const a = rewriteBaseUrlInText(
      content,
      'https://old.example.com/',
      'https://new.example.com/',
    );
    const b = rewriteBaseUrlInText(content, 'https://old.example.com', 'https://new.example.com');

    expect(a.replacements).toBe(2);
    expect(b.replacements).toBe(2);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe('![x](https://new.example.com/static/img/x.webp) and https://new.example.com/');
  });

  it('leaves unrelated third-party hosts alone unless they match oldBase', () => {
    const content =
      '![](https://pic.qiniu.com/abc.webp) ![](https://old.example.com/static/img/mine.webp)';
    const { text, replacements } = rewriteBaseUrlInText(
      content,
      'https://old.example.com',
      'https://new.example.com',
    );
    expect(replacements).toBe(1);
    expect(text).toContain('https://pic.qiniu.com/abc.webp');
    expect(text).toContain('https://new.example.com/static/img/mine.webp');
  });

  it('rewrites a picgo/CDN host when that host is the oldBase', () => {
    const content = '![](https://pic.qiniu.com/abc.webp) keep https://old.example.com/static/x.png';
    const { text, replacements } = rewriteBaseUrlInText(
      content,
      'https://pic.qiniu.com',
      'https://cdn.new.com',
    );
    expect(replacements).toBe(1);
    expect(text).toContain('https://cdn.new.com/abc.webp');
    expect(text).toContain('https://old.example.com/static/x.png');
  });

  it('is a no-op when old equals new (including slash variants) or either is missing', () => {
    const content = '![](https://old.example.com/static/img/x.webp)';
    expect(rewriteBaseUrlInText(content, 'https://old.example.com', 'https://old.example.com/')).toEqual({
      text: content,
      replacements: 0,
    });
    expect(rewriteBaseUrlInText(content, '', 'https://new.example.com')).toEqual({
      text: content,
      replacements: 0,
    });
    expect(rewriteBaseUrlInText(content, 'https://old.example.com', '')).toEqual({
      text: content,
      replacements: 0,
    });
    expect(rewriteBaseUrlInText('', 'https://old.example.com', 'https://new.example.com')).toEqual({
      text: '',
      replacements: 0,
    });
  });
});

describe('prepareRewriteBases', () => {
  it('returns null when old or new is missing or they match after normalize', () => {
    expect(prepareRewriteBases('', 'https://new.example.com')).toBeNull();
    expect(prepareRewriteBases('https://old.example.com', '')).toBeNull();
    expect(prepareRewriteBases('https://same.com/', 'https://same.com')).toBeNull();
  });

  it('normalizes trailing slashes when both are valid http(s) URLs', () => {
    expect(prepareRewriteBases('https://old.example.com/', 'http://new.example.com')).toEqual({
      oldBase: 'https://old.example.com',
      newBase: 'http://new.example.com',
    });
  });

  it('rejects a non-empty value that is not an http(s) URL', () => {
    expect(() => prepareRewriteBases('old.example.com', 'https://new.example.com')).toThrow(
      BadRequestException,
    );
    expect(() => prepareRewriteBases('https://old.example.com', 'ftp://new.example.com')).toThrow(
      BadRequestException,
    );
  });
});

describe('rewriteBaseUrlInDocuments', () => {
  it('counts updated documents and replacements, skipping unchanged rows', async () => {
    const docs = [
      { id: 1, content: '![](https://old.example.com/static/a.webp) and https://old.example.com/static/b.png' },
      { id: 2, content: 'no images here' },
      { id: 3, content: '![](https://other.com/x.png)' },
    ];
    const written: Array<{ id: number; content: string }> = [];
    const result = await rewriteBaseUrlInDocuments(
      docs,
      async (id, content) => {
        written.push({ id, content });
      },
      'https://old.example.com',
      'https://new.example.com',
    );

    expect(result).toEqual({ updated: 1, replacements: 2 });
    expect(written).toEqual([
      {
        id: 1,
        content: '![](https://new.example.com/static/a.webp) and https://new.example.com/static/b.png',
      },
    ]);
  });
});

describe('🔴 assertHttpBaseUrl：old / new 两种调用方必须拿到**各自**的错误码（期 9 第九批）', () => {
  // ## 为什么要这条（变异对照 B49-M2 打不红揭出来的）
  // 迁移把中文 `label`（'旧地址' / '新地址'）换成了语义 `which: 'old' | 'new'`，
  // 每个分支各抛自己的码（`oldBaseUrlHttpOnly` / `newBaseUrlHttpOnly` …）。
  // 🔴 我把两个分支**故意写反**（old 抛 new 的码）⇒ 全套 562 条断言**全绿**：
  //    两个码都"存在、都被用到、三语齐全、与码表逐字一致"，静态判据看不出**语义错配**。
  //    后果是用户改"新地址"时看到「旧地址只支持 http 或 https 地址」—— 文案对不上他在做的事。
  // ⇒ 这类"分支 ↔ 码"的对应关系只能用**行为断言**钉（真的调一次，看抛出来的 code 是哪个）。
  const cases: Array<['old' | 'new', string, string]> = [
    ['old', 'not-a-url', 'oldBaseUrlNeedsProtocol'],
    ['new', 'not-a-url', 'newBaseUrlNeedsProtocol'],
    ['old', 'ftp://example.com', 'oldBaseUrlHttpOnly'],
    ['new', 'ftp://example.com', 'newBaseUrlHttpOnly'],
  ];
  it.each(cases)('%s + %s ⇒ %s', (which, input, code) => {
    let body: any = null;
    try {
      assertHttpBaseUrl(input, which);
    } catch (err: any) {
      body = typeof err.getResponse === 'function' ? err.getResponse() : null;
    }
    expect(body).not.toBeNull();
    expect(body.code).toBe(code);
    // 🔴 反向：不许拿到"另一边"的码
    expect(body.code).not.toBe(which === 'old' ? code.replace(/^old/, 'new') : code.replace(/^new/, 'old'));
    // 🔴 中文文案也要与码对应（旧地址/新地址不许串）
    expect(String(body.message)).toContain(which === 'old' ? '旧地址' : '新地址');
  });

  // 🔴 反空转 + 一个如实记录的发现：`MissingHost` 那一支**实测不可达** ——
  //    `new URL('http://')` / `new URL('https:///x')` 都会**抛**（http/https 要求有 host），
  //    于是先落到"请填写包含协议的完整 URL"那一支；只有极罕见的输入（例如 `file:///x` 这种
  //    协议能通过第一关却没有 hostname 的情况，而它又会先被"只支持 http 或 https"拦掉）才可能走到。
  //    ⇒ 它是**防御性分支**，这里只钉"两个 which 都各自拿到自己那一支的码"，不硬造不可达输入。
  it('🔴 反空转：两个 which 都必须各自拿到自己那一支的码（不许串）', () => {
    const seen: Record<string, string> = {};
    for (const which of ['old', 'new'] as const) {
      let body: any = null;
      try {
        assertHttpBaseUrl('http://', which);
      } catch (err: any) {
        body = typeof err.getResponse === 'function' ? err.getResponse() : null;
      }
      expect(body?.code).toBe(which === 'old' ? 'oldBaseUrlNeedsProtocol' : 'newBaseUrlNeedsProtocol');
      seen[which] = String(body?.code);
    }
    expect(seen.old).not.toBe(seen.new);
  });
});
