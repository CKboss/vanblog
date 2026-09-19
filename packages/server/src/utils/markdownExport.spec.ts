import { BadRequestException } from '@nestjs/common';
import {
  assertSafeRemoteUrl,
  allowedRemoteFetchPorts,
  assetsDirName,
  buildFrontMatter,
  classifyImageUrl,
  extractImageRefs,
  isPrivateAddress,
  maskCodeRegions,
  rewriteImageUrls,
  safeExportName,
  toRelativeLink,
  uniqueAssetName,
  yamlScalar,
} from './markdownExport';

describe('maskCodeRegions', () => {
  it('遮掉围栏代码块与行内代码，且长度不变（偏移才能对上）', () => {
    const src = ['正文 ![a](/x.png)', '```md', '![假](/fake.png)', '```', '尾部 `![内联](/i.png)` 结束'].join(
      '\n',
    );
    const masked = maskCodeRegions(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toContain('/x.png');
    expect(masked).not.toContain('/fake.png');
    expect(masked).not.toContain('/i.png');
    expect(masked).toContain('尾部');
    expect(masked).toContain('结束');
  });

  it('波浪线围栏也认', () => {
    const masked = maskCodeRegions('~~~\n![a](/x.png)\n~~~\n![b](/y.png)');
    expect(masked).not.toContain('/x.png');
    expect(masked).toContain('/y.png');
  });
});

describe('extractImageRefs', () => {
  it('认 markdown 图片、带标题、尖括号 url、html img、引用式', () => {
    const src = [
      '![普通](/static/img/a.webp)',
      '![带标题](/static/img/b.webp "标题")',
      '![尖括号](</static/img/c d.webp>)',
      '<img src="/static/img/e.webp" width="300">',
      "<img src='/static/img/f.webp'>",
      '![引用式][logo]',
      '',
      '[logo]: /static/img/g.webp',
    ].join('\n');
    const urls = extractImageRefs(src).map((ref) => ref.url);
    expect(urls).toEqual([
      '/static/img/a.webp',
      '/static/img/b.webp',
      '/static/img/c d.webp',
      '/static/img/e.webp',
      '/static/img/f.webp',
      '/static/img/g.webp',
    ]);
  });

  it('代码块 / 行内代码里的图片不算', () => {
    const src = ['```', '![假](/static/img/fake1.webp)', '```', '行内 `![假](/static/img/fake2.webp)` 结束'].join(
      '\n',
    );
    expect(extractImageRefs(src)).toEqual([]);
  });

  it('data URI 也当作引用返回（由 classify 决定跳过），偏移准确', () => {
    const src = '前缀 ![d](data:image/png;base64,AAA) 后缀';
    const refs = extractImageRefs(src);
    expect(refs).toHaveLength(1);
    expect(src.slice(refs[0].start, refs[0].end)).toBe(refs[0].url);
  });

  it('每个 ref 的 [start,end) 精确指向原文里的 url', () => {
    const src = 'a ![x](/static/img/1.webp) b <img src="/static/img/2.webp"> c';
    for (const ref of extractImageRefs(src)) {
      expect(src.slice(ref.start, ref.end)).toBe(ref.url);
    }
  });

  it('空内容返回空数组', () => {
    expect(extractImageRefs('')).toEqual([]);
  });
});

describe('rewriteImageUrls', () => {
  it('同一 url 出现多次全部改写，且不动代码块', () => {
    const src = [
      '![a](/static/img/x.webp)',
      '![b](/static/img/x.webp "t")',
      '```',
      '![c](/static/img/x.webp)',
      '```',
    ].join('\n');
    const out = rewriteImageUrls(src, new Map([['/static/img/x.webp', 'T.assets/x.webp']]));
    expect(out).toContain('![a](T.assets/x.webp)');
    expect(out).toContain('![b](T.assets/x.webp "t")');
    // 代码块里那处保持原样
    expect(out.split('```')[1]).toContain('/static/img/x.webp');
  });

  it('改写 html img 时保留引号和其它属性', () => {
    const src = '<img src="/static/img/x.webp" width="300" alt="图">';
    const out = rewriteImageUrls(src, new Map([['/static/img/x.webp', 'T.assets/x.webp']]));
    expect(out).toBe('<img src="T.assets/x.webp" width="300" alt="图">');
  });

  it('引用式改的是定义行', () => {
    const src = '![a][logo]\n\n[logo]: /static/img/x.webp\n';
    const out = rewriteImageUrls(src, new Map([['/static/img/x.webp', 'T.assets/x.webp']]));
    expect(out).toContain('[logo]: T.assets/x.webp');
    expect(out).toContain('![a][logo]');
  });

  it('没有映射时原样返回', () => {
    const src = '![a](/static/img/x.webp)';
    expect(rewriteImageUrls(src, new Map())).toBe(src);
  });
});

describe('classifyImageUrl', () => {
  const base = 'https://blog.example.com/';

  it('本站相对路径 = 本地', () => {
    expect(classifyImageUrl('/static/img/a.webp', base)).toEqual({
      kind: 'local',
      staticRel: 'img/a.webp',
    });
  });

  it('本站域名的绝对地址也算本地', () => {
    const got = classifyImageUrl('https://blog.example.com/static/img/a.webp', base);
    expect(got.kind).toBe('local');
    expect(got.staticRel).toBe('img/a.webp');
  });

  it('别的域名 = 外链', () => {
    const got = classifyImageUrl('https://cdn.other.com/a.png', base);
    expect(got.kind).toBe('remote');
    expect(got.absolute).toBe('https://cdn.other.com/a.png');
  });

  it('协议相对地址按外链处理', () => {
    expect(classifyImageUrl('//cdn.other.com/a.png', base).kind).toBe('remote');
  });

  it('data URI / 空 / 无法定位的相对路径都跳过', () => {
    expect(classifyImageUrl('data:image/png;base64,AA', base).kind).toBe('skip');
    expect(classifyImageUrl('', base).kind).toBe('skip');
    expect(classifyImageUrl('images/a.png', base).kind).toBe('skip');
    expect(classifyImageUrl('/upload/a.png', base).kind).toBe('skip');
  });

  it('中文与空格地址会被解码', () => {
    expect(classifyImageUrl('/static/img/%E4%B8%AD%20%E6%96%87.webp', base).staticRel).toBe(
      'img/中 文.webp',
    );
  });
});

describe('assertSafeRemoteUrl 的前置判断', () => {
  it('内网/回环地址一律识别为私有', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.1.1',
      '::1',
      'foo.local',
    ]) {
      expect(isPrivateAddress(host)).toBe(true);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateAddress(host)).toBe(false);
    }
  });
});

describe('assertSafeRemoteUrl', () => {
  it('拒绝非 http/https 协议', async () => {
    await expect(assertSafeRemoteUrl('file:///etc/passwd')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(assertSafeRemoteUrl('ftp://example.com/a.png')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('拒绝字面量内网地址（不做 DNS 也要挡）', async () => {
    for (const url of ['http://127.0.0.1:3000/x.png', 'http://localhost/y.png', 'http://10.0.0.5/z.png']) {
      await expect(assertSafeRemoteUrl(url)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('拒绝解析不了的域名', async () => {
    await expect(assertSafeRemoteUrl('https://invalid.example.test/a.png')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('放行正常的公网地址', async () => {
    const parsed = await assertSafeRemoteUrl('https://example.com/a.png');
    expect(parsed.hostname).toBe('example.com');
  });
});

describe('文件名与 front matter', () => {
  it('标题里的空格和括号换成 -（否则 markdown 链接要转义，各家编辑器支持不一）', () => {
    expect(safeExportName('6000KM后的 喜德盛 黑客380 使用记录')).toBe(
      '6000KM后的-喜德盛-黑客380-使用记录',
    );
    expect(safeExportName('业余投资者的投资策略(一)')).toBe('业余投资者的投资策略-一');
    expect(safeExportName('【临时】导出 (含空格) [方括号]')).toBe('【临时】导出-含空格-方括号');
    expect(safeExportName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeExportName('   ')).toBe('untitled');
    expect(safeExportName('')).toBe('untitled');
    expect(safeExportName(null, 'fallback')).toBe('fallback');
    expect(safeExportName('.hidden')).toBe('hidden');
    expect(safeExportName('CON')).toBe('_CON');
    expect(safeExportName('x'.repeat(200)).length).toBe(80);
  });

  it('assets 目录名 = 安全化标题 + .assets', () => {
    expect(assetsDirName('我的文章 (一)')).toBe('我的文章-一.assets');
  });

  it('同名资源自动加序号', () => {
    const taken = new Set<string>();
    expect(uniqueAssetName('a.webp', taken)).toBe('a.webp');
    expect(uniqueAssetName('a.webp', taken)).toBe('a-2.webp');
    expect(uniqueAssetName('A.WEBP', taken)).toBe('A-3.WEBP');
    expect(uniqueAssetName('', taken)).toBe('image');
    // 路径分隔符换成 _，前导点被剥掉（避免解出隐藏文件）
    expect(uniqueAssetName('../../etc/passwd', taken)).toBe('_.._etc_passwd');
  });

  it('相对链接不做多余转义（名字已经洗过）', () => {
    expect(toRelativeLink('标题.assets', 'a-b.webp')).toBe('标题.assets/a-b.webp');
  });

  it('front matter 是合法 YAML：标题带冒号要加引号，tags 用数组', () => {
    const fm = buildFrontMatter({
      title: '标题: 副标题 #不是注释',
      pathname: 'my-post',
      category: '博客',
      tags: ['a', 'b c'],
      top: false,
      hidden: true,
      createdAt: new Date('2024-07-07T07:31:35.821Z'),
      updatedAt: '2026-09-12T00:00:00.000Z',
      cover: '',
      password: undefined,
    });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('---\n\n')).toBe(true);
    expect(fm).toContain("title: '标题: 副标题 #不是注释'");
    expect(fm).toContain('pathname: my-post');
    expect(fm).toContain("tags: [a, 'b c']");
    expect(fm).toContain('createdAt: 2024-07-07T07:31:35.821Z');
    expect(fm).toContain('hidden: true');
    // 空值不写进去
    expect(fm).not.toContain('cover');
    expect(fm).not.toContain('password');
    expect(fm).not.toContain('top');
  });

  it('yamlScalar 只在需要时加引号', () => {
    expect(yamlScalar('普通标题')).toBe('普通标题');
    expect(yamlScalar('带 空格')).toBe("'带 空格'");
    expect(yamlScalar('a: b')).toBe("'a: b'");
    expect(yamlScalar('#tag')).toBe("'#tag'");
    expect(yamlScalar('- item')).toBe("'- item'");
    expect(yamlScalar('true')).toBe("'true'");
    expect(yamlScalar(true)).toBe('true');
    expect(yamlScalar(12)).toBe('12');
    expect(yamlScalar("it's")).toBe("'it''s'");
    expect(yamlScalar('')).toBe("''");
  });
});

/**
 * SSRF 过滤器的回归钉子。
 *
 * 旧实现是**字符串正则**（`^127\.`、`^::1$`、`^f[cd][0-9a-f]{2}:`…），而 WHATWG URL 会把
 * 主机名**规范化**，于是下面这四个形状当年全部过检、并且实测真的能打到内网：
 *   `http://[::ffff:127.0.0.1]:2019/`   → hostname 规范化成 `::ffff:7f00:1`（内嵌 IPv4 变十六进制，
 *                                          任何 `^::ffff:\d+\.` 形状的规则永远匹配不上）
 *   `http://[::ffff:169.254.169.254]/`  → `::ffff:a9fe:a9fe`（云 IMDS）
 *   `http://[64:ff9b::7f00:1]:2019/`    → NAT64 前缀，翻译到内网 IPv4
 *   `http://[::]:2019/`                 → 未指定地址
 * 连通性是实测过的（本机 bind 127.0.0.1 的 TCP 靶子，`net.connect(port,'::ffff:127.0.0.1')` 连上并拿到响应）。
 * 触发面是**最低权限协作者**：`fetchRemoteSafely` 的两个调用方（外链图片转存、导出抓远程图）都在
 * 协作者可达面，而 `post-/api/admin/export/markdown` 在 `types/access/access.ts` 的 publicRoutes 里。
 */
describe('SSRF：IPv6 的内嵌/过渡形式必须被识别为内网', () => {
  const BYPASS_HOSTS = [
    '::ffff:127.0.0.1', // IPv4-mapped（点分写法）
    '::ffff:7f00:1', // IPv4-mapped（URL 规范化后的十六进制写法）
    '::ffff:a9fe:a9fe', // IPv4-mapped → 169.254.169.254（云 IMDS）
    '::ffff:10.0.0.5', // IPv4-mapped → 私网
    '::7f00:1', // IPv4-compatible → 127.0.0.1
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '2002:ac10:101::', // 6to4 → 172.16.1.1
    '64:ff9b::7f00:1', // NAT64
    '64:ff9b:1::7f00:1', // 本地 NAT64（RFC 8215）
    '::', // 未指定地址
    '::1', // 回环
    'fc00::1', // ULA
    'fd12:3456::1', // ULA
    'fe80::1', // 链路本地
    'ff02::1', // 组播
    '2001:db8::1', // 文档地址（不可路由）
    '2001::1', // Teredo（能封装任意 IPv4）
  ];

  it('这些形状一律判为内网', () => {
    for (const host of BYPASS_HOSTS) {
      expect({ host, private: isPrivateAddress(host) }).toEqual({ host, private: true });
    }
  });

  it('带方括号、带 zone id、大写、以及解析不了的 IPv6 字面量也判为内网（宁可拒绝）', () => {
    expect(isPrivateAddress('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateAddress('::FFFF:7F00:1')).toBe(true);
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
    expect(isPrivateAddress('gggg::1')).toBe(true); // 解析不了 ⇒ 不安全
    expect(isPrivateAddress('')).toBe(true); // 空主机名 ⇒ 不安全
  });

  it('整条 URL 走 assertSafeRemoteUrl 也被拒（不只是 isPrivateAddress 层面）', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]:2019/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[64:ff9b::7f00:1]:2019/',
      'http://[::]:2019/',
    ]) {
      await expect(assertSafeRemoteUrl(url)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('SSRF：IPv4 按数值判范围（不是按字符串前缀）', () => {
  it('内部/不可路由范围全部拒绝', () => {
    for (const host of [
      '127.0.0.1',
      '127.255.255.254',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // 云 IMDS
      '0.0.0.0',
      '0.1.2.3',
      '100.64.0.1', // CGNAT（旧实现漏了；云上内网极常见）
      '100.127.255.255',
      '224.0.0.1', // 组播
      '240.0.0.1', // 保留
      '255.255.255.255', // 广播
      '192.0.2.1', // TEST-NET-1
      '198.51.100.1', // TEST-NET-2
      '203.0.113.1', // TEST-NET-3
      '198.18.0.1', // 基准测试
      'localhost',
      'foo.local',
      'bar.internal',
    ]) {
      expect({ host, private: isPrivateAddress(host) }).toEqual({ host, private: true });
    }
  });

  it('反证：公网地址与紧邻边界外的地址必须放行（别把功能修坏）', () => {
    for (const host of [
      'example.com',
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // 172.16/12 之外
      '172.15.255.255',
      '11.0.0.1', // 10/8 之外
      '100.63.255.255', // CGNAT 下界之外
      '100.128.0.0', // CGNAT 上界之外
      '192.169.0.1', // 192.168/16 之外
      '169.255.0.1', // 169.254/16 之外
      '2001:4860:4860::8888', // Google 公网 DNS
      'cdn.jsdelivr.net',
    ]) {
      expect({ host, private: isPrivateAddress(host) }).toEqual({ host, private: false });
    }
  });

  it('URL 规范化后的十进制/八进制 IP 仍然被拒（这两种本来就被 WHATWG 挡住，钉住别退化）', async () => {
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1');
    expect(new URL('http://0177.0.0.1/').hostname).toBe('127.0.0.1');
    for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://[0:0:0:0:0:0:0:1]/']) {
      await expect(assertSafeRemoteUrl(url)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('SSRF：端口白名单', () => {
  const OLD = process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS;
    else process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS = OLD;
  });

  it('默认只放行 80/443，内网管理端口一律拒（这正是能打到 :2019/:27017 的原因）', async () => {
    delete process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS;
    expect(allowedRemoteFetchPorts()).toEqual([80, 443]);
    for (const url of [
      'http://example.com:2019/', // caddy admin
      'http://example.com:27017/', // mongo
      'http://example.com:8080/x.png',
      'https://example.com:8443/x.png',
    ]) {
      await expect(assertSafeRemoteUrl(url)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('80/443 与"不写端口"照常放行', async () => {
    delete process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS;
    for (const url of ['http://example.com/a.png', 'https://example.com/a.png', 'http://example.com:80/a.png', 'https://example.com:443/a.png']) {
      const parsed = await assertSafeRemoteUrl(url);
      expect(parsed.hostname).toBe('example.com');
    }
  });

  it('显式配置能放行额外端口，且报错信息里写清怎么配', async () => {
    process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS = '80,443,8080';
    expect(allowedRemoteFetchPorts()).toEqual([80, 443, 8080]);
    const parsed = await assertSafeRemoteUrl('http://example.com:8080/a.png');
    expect(parsed.port).toBe('8080');
    await expect(assertSafeRemoteUrl('http://example.com:9999/a.png')).rejects.toThrow(
      /VANBLOG_REMOTE_FETCH_ALLOWED_PORTS/,
    );
  });

  it('非法值回落默认（绝不因为写错而变成"全部放行"）', () => {
    for (const raw of ['', '   ', 'abc', '0', '99999', '-1', '80x', ',,,']) {
      process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS = raw;
      expect({ raw, ports: allowedRemoteFetchPorts() }).toEqual({ raw, ports: [80, 443] });
    }
    // 部分合法 ⇒ 只用合法的那些（去重 + 升序）
    process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS = '443, 8080 ,,443,abc,0';
    expect(allowedRemoteFetchPorts()).toEqual([443, 8080]);
  });

  it('顺序钉子：内网地址**先于**端口被判（报错要说更贴近真实原因的那个）', async () => {
    // `http://127.0.0.1:3000/` 两个闸门都会拦，但问题是"回环"，不是"3000"。
    // 这条钉子防止有人把顺序调回去（provider 的既有用例也按"内网"这个措辞断言）。
    delete process.env.VANBLOG_REMOTE_FETCH_ALLOWED_PORTS;
    await expect(assertSafeRemoteUrl('http://127.0.0.1:3000/x.png')).rejects.toThrow(/内网/);
    await expect(assertSafeRemoteUrl('http://[::ffff:127.0.0.1]:2019/')).rejects.toThrow(/内网/);
    await expect(assertSafeRemoteUrl('http://example.com:3000/x.png')).rejects.toThrow(/端口 3000/);
  });
});
