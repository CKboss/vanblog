import {
  buildDefaultRobotsTxt,
  buildRobotsTxt,
  DEFAULT_ROBOTS_DISALLOW,
  normalizeRobotsBaseUrl,
  ROBOTS_TXT_MAX_BYTES,
  sanitizeRobotsTxt,
} from './robotsTxt';

/**
 * robots.txt 的口径判据。
 *
 * 🔴 这里钉的不是"输出长什么样"，而是**几个会静默坏掉的性质**：
 * ① 默认必须是"**开放收录**"（有人把默认改成 `Disallow: /`，站点会直接从搜索引擎消失，
 *    而且**没有任何测试会红** —— 因为爬虫的行为不在我们的测试里）；
 * ② 自定义内容必须**完全以站长为准**（连"全站禁抓"也要照发，那是他的裁定，不是 bug）；
 * ③ `Sitemap:` 行只在**站长没写**的时候补（写了就不许覆盖）；
 * ④ 脏数据/超长/控制字符不能让爬虫拿到 500 或残缺行。
 */
const wash = (s: string) => (typeof s === 'string' && s.trim() ? s : 'https://');

describe('robots.txt：默认内容必须开放收录', () => {
  const body = buildDefaultRobotsTxt('https://blog.example.com');

  it('有 `User-agent: *` 与 `Allow: /`（默认立场是"整站可抓"）', () => {
    expect(body).toContain('User-agent: *');
    expect(body).toMatch(/^Allow: \/$/m);
  });

  it('🔴 绝不出现"全站禁抓"那一行（`Disallow: /` 后面不能直接行尾）', () => {
    // 这是最贵的静默坏法：写了它，站点从所有搜索引擎消失，而所有测试照样绿。
    expect(body).not.toMatch(/^Disallow: \/[ \t]*$/m);
    expect(body).not.toMatch(/^Disallow:[ \t]*\*[ \t]*$/m);
  });

  it('🔴 刻意不写 Crawl-delay（它会拖慢收录，本站没有需要保护带宽的动态页面）', () => {
    expect(body.toLowerCase()).not.toContain('crawl-delay');
  });

  it('该挡的都挡了：接口、后台、API 文档、导出/临时目录', () => {
    for (const p of DEFAULT_ROBOTS_DISALLOW) {
      expect(body).toContain(`Disallow: ${p}`);
    }
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Disallow: /admin/');
    expect(body).toContain('Disallow: /swagger');
  });

  it('静态资源放开（图床/附件要能被收录）', () => {
    expect(body).toContain('Allow: /static/');
  });

  it('带绝对地址的 Sitemap 行，且尾斜杠已收敛（不能出现 .com//sitemap.xml）', () => {
    expect(body).toContain('Sitemap: https://blog.example.com/sitemap.xml');
    expect(body).not.toContain('com//sitemap');
  });

  it('未配站点 URL 时留说明注释，而不是写出 `Sitemap: https:///sitemap.xml` 这种垃圾行', () => {
    const noBase = buildDefaultRobotsTxt('');
    expect(noBase).not.toMatch(/^Sitemap: /m);
    expect(noBase).toContain('# Sitemap:');
    // 🔴 垃圾行形状一个都不许出现（`https:///` 是 washUrl('') 补协议后的产物）
    expect(noBase).not.toContain('https:///');
    expect(noBase).not.toContain('Sitemap: /sitemap.xml');
    // 反证：上面这条不是空转 —— 垃圾行形状确实能被这条正则抓到
    expect('Sitemap: https:///sitemap.xml').toMatch(/^Sitemap: /m);
  });

  it('🔴 `Allow: /` 不会让 /api/ 重新可抓（最长前缀优先，这条规则本文件本来就依赖）', () => {
    // 性质级判据：`Allow: /static/` 与 `Disallow: /static/export/` 同时存在，
    // 说明"更长的路径规则优先"已经是这份文件的既有前提 ⇒ `Allow: /` 同理不会放开 /api/。
    expect(body).toContain('Allow: /static/');
    expect(body).toContain('Disallow: /static/export/');
  });
});

describe('robots.txt：站长自定义内容完全以他为准', () => {
  it('自定义内容原样下发（连注释与顺序都不动）', () => {
    const custom = '# my rules\nUser-agent: *\nDisallow: /private/';
    const { body, custom: isCustom } = buildRobotsTxt(
      { baseUrl: 'https://blog.example.com', robotsTxt: custom },
      wash,
    );
    expect(isCustom).toBe(true);
    expect(body).toBe(custom + '\n\nSitemap: https://blog.example.com/sitemap.xml\n');
  });

  it('🔴 站长写"全站禁抓"也照发（那是他的裁定，代码不替他改主意）', () => {
    const { body, custom: isCustom } = buildRobotsTxt({ robotsTxt: 'User-agent: *\nDisallow: /' }, wash);
    expect(isCustom).toBe(true);
    expect(body).toContain('Disallow: /');
    expect(body).not.toContain('Allow: /');
  });

  it('🔴 站长自己写了 Sitemap 行就不许再补一条（不许覆盖/不许出现两条）', () => {
    const custom = 'User-agent: *\nSitemap: https://cdn.example.com/my-sitemap.xml';
    const { body } = buildRobotsTxt({ baseUrl: 'https://blog.example.com', robotsTxt: custom }, wash);
    expect(body).toContain('Sitemap: https://cdn.example.com/my-sitemap.xml');
    expect(body).not.toContain('blog.example.com/sitemap.xml');
    expect(body.match(/^sitemap[ \t]*:/gim)).toHaveLength(1);
  });

  it('`sitemap:` 大小写不敏感、允许行首空白（都算"已经写了"）', () => {
    for (const line of ['sitemap: https://a.example/s.xml', '  SITEMAP : https://a.example/s.xml']) {
      const { body } = buildRobotsTxt(
        { baseUrl: 'https://blog.example.com', robotsTxt: `User-agent: *\n${line}` },
        wash,
      );
      expect(body.match(/sitemap[ \t]*:/gi)).toHaveLength(1);
    }
  });

  it('自定义内容 + 未配站点 URL ⇒ 不补 Sitemap，也不写垃圾行', () => {
    const { body } = buildRobotsTxt({ baseUrl: '', robotsTxt: 'User-agent: *' }, wash);
    expect(body).toBe('User-agent: *\n');
  });

  it('🔴 只有空白/只有换行的自定义内容 ⇒ 回落到默认（不算"站长写了内容"）', () => {
    for (const raw of ['   ', '\n\n', '\t\n ']) {
      const { body, custom: isCustom } = buildRobotsTxt({ robotsTxt: raw }, wash);
      expect(isCustom).toBe(false);
      expect(body).toContain('Allow: /');
    }
  });

  it('字段缺失/undefined/null/非字符串 ⇒ 都用默认（老站点升级后 robots.txt 不变）', () => {
    for (const siteInfo of [{}, { robotsTxt: undefined }, { robotsTxt: null }, { robotsTxt: 42 }, null, undefined]) {
      const { body, custom: isCustom } = buildRobotsTxt(siteInfo as any, wash);
      expect(isCustom).toBe(false);
      expect(body).toContain('User-agent: *');
      expect(body).toContain('Allow: /');
    }
  });
});

describe('robots.txt：净化（脏数据不许变成 500 或残缺行）', () => {
  it('🔴 去掉 \\r（CRLF 混进响应体会让某些爬虫把一行读成两行）', () => {
    expect(sanitizeRobotsTxt('User-agent: *\r\nDisallow: /api/\r\n')).toBe('User-agent: *\nDisallow: /api/');
    expect(sanitizeRobotsTxt('a\rb')).toBe('a\nb');
    // 反证：不净化的话 \r 确实还在
    expect('a\r\nb'.includes('\r')).toBe(true);
  });

  it('去掉 NUL 与其它控制字符（保留 \\n 与 \\t）', () => {
    expect(sanitizeRobotsTxt('a\u0000b\u001fc')).toBe('abc');
    expect(sanitizeRobotsTxt('a\tb')).toBe('a\tb');
  });

  it('去行尾空白与末尾空行（输出时统一补一个 \\n）', () => {
    expect(sanitizeRobotsTxt('User-agent: *   \n\n\n')).toBe('User-agent: *');
  });

  it('🔴 超长时按**整行**截断，不切半行（半行会被爬虫当成一条残缺规则）', () => {
    const line = 'Disallow: /a-very-long-path-that-is-definitely-not-short';
    const many = new Array(Math.ceil((ROBOTS_TXT_MAX_BYTES * 2) / line.length)).fill(line).join('\n');
    const out = sanitizeRobotsTxt(many);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(ROBOTS_TXT_MAX_BYTES);
    // 每一行都必须是完整的那一行（没有被从中间切断）
    for (const l of out.split('\n')) {
      expect(l).toBe(line);
    }
    expect(out.split('\n').length).toBeGreaterThan(10);
  });

  it('非字符串 ⇒ 回落（写入侧回落库里的旧值，读出侧回落默认）', () => {
    expect(sanitizeRobotsTxt(undefined, 'OLD')).toBe('OLD');
    expect(sanitizeRobotsTxt(42, 'OLD')).toBe('OLD');
    expect(sanitizeRobotsTxt({}, 'OLD')).toBe('OLD');
    expect(sanitizeRobotsTxt(undefined)).toBe('');
  });

  it('🔴 写入侧与读出侧是同一份口径（后台看到的 = 爬虫拿到的）', () => {
    const raw = 'User-agent: *\r\nDisallow: /x/   \n\n\n';
    const stored = sanitizeRobotsTxt(raw, '');
    const { body } = buildRobotsTxt({ robotsTxt: stored }, wash);
    expect(body.startsWith(stored + '\n')).toBe(true);
    expect(body).not.toContain('\r');
  });
});

describe('robots.txt：站点 URL 规整', () => {
  it('不合法/空/没有 host ⇒ 返回空串（绝不返回 `https://`）', () => {
    for (const raw of ['', '   ', 'https://', 'http:///', 'not a url']) {
      expect(normalizeRobotsBaseUrl(raw, wash)).toBe('');
    }
    expect(normalizeRobotsBaseUrl(undefined, wash)).toBe('');
    expect(normalizeRobotsBaseUrl(42 as any, wash)).toBe('');
  });

  it('合法地址 ⇒ 收敛尾斜杠', () => {
    expect(normalizeRobotsBaseUrl('https://blog.example.com///', wash)).toBe('https://blog.example.com');
  });

  it('washUrl 抛错也不能把异常抛给爬虫（robots.txt 500 = 爬虫拿不到任何规则）', () => {
    expect(
      normalizeRobotsBaseUrl('https://blog.example.com', () => {
        throw new Error('boom');
      }),
    ).toBe('');
  });
});
