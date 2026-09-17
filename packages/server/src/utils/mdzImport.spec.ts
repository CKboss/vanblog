import * as fs from 'fs';
import * as path from 'path';
import compressing from 'compressing';
import { BadRequestException } from '@nestjs/common';
import {
  EXPORT_NOTE_BASENAME,
  MDZ_MAX_ENTRIES,
  importMdzBuffer,
  normalizeFrontMatter,
  parseMdzMarkdown,
  planImageImports,
  readMdzEntries,
  selectMarkdownMember,
} from './mdzImport';
import { buildFrontMatter, rewriteImageUrls } from './markdownExport';

jest.setTimeout(120000);

/** 在内存里打一个 zip（与导出侧 writeZip 同一个库、同一种 addEntry 用法）。 */
async function buildZip(entries: Array<{ relativePath: string; source: Buffer | string }>): Promise<Buffer> {
  const stream = new compressing.zip.Stream();
  for (const entry of entries) {
    stream.addEntry(entry.source as any, { relativePath: entry.relativePath });
  }
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Buffer.concat(chunks);
}

/** 1x1 真 PNG（魔数正确；纯 util 层不校验，控制器层的 upload 才校验） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function fakeIngest(log: string[] = []) {
  return async (memberName: string, buffer: Buffer) => {
    log.push(memberName);
    return { src: `/static/img/served-${path.basename(memberName)}`, isNew: true, bytes: buffer.length };
  };
}


/**
 * yazl 拒绝**创建**不安全成员名（这本身是好事），所以 zip-slip 测试要"伪造"：
 * 先打一个成员名长度完全相同的安全 zip，再把名字字节整体替换成不安全名 ——
 * 长度不变 ⇒ 本地头/中央目录里的偏移与 nameLength 全部依旧有效。
 */
async function buildZipSlipZip(safeName: string, unsafeName: string): Promise<Buffer> {
  if (safeName.length !== unsafeName.length) {
    throw new Error('test helper: names must be equal length');
  }
  const zip = await buildZip([
    { relativePath: 't.md', source: Buffer.from('---\ntitle: t\n---\n\nhi\n', 'utf8') },
    { relativePath: safeName, source: PNG },
  ]);
  const from = Buffer.from(safeName, 'utf8');
  const to = Buffer.from(unsafeName, 'utf8');
  const out = Buffer.from(zip);
  let idx = out.indexOf(from);
  let count = 0;
  while (idx !== -1) {
    to.copy(out, idx);
    count += 1;
    idx = out.indexOf(from, idx + to.length);
  }
  if (count < 2) {
    throw new Error(`test helper: expected name in local header + central dir, found ${count}`);
  }
  return out;
}

async function expect400(promise: Promise<any>, messagePart: string) {
  let err: any = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(BadRequestException);
  expect(String(err?.message)).toContain(messagePart);
  return err;
}

/** 与导出侧完全同构地做一个 .mdz：front matter + 相对链接 md + <标题>.assets/ 图片 */
async function buildExportShapedMdz(opts?: { password?: string }) {
  const article = {
    title: '往返测试',
    pathname: 'wang-fan-ce-shi',
    category: '技术',
    tags: ['A', 'B'],
    top: 2,
    hidden: true,
    private: opts?.password ? true : undefined,
    password: opts?.password,
    cover: '/static/img/cover.webp',
    createdAt: new Date('2024-07-07T10:00:00.000Z'),
    updatedAt: new Date('2024-08-08T10:00:00.000Z'),
  };
  const fm = buildFrontMatter(article as any);
  const body = [
    '# 标题',
    '',
    '![图一](往返测试.assets/aaa-md5.图一.webp)',
    '',
    '<img src="往返测试.assets/bbb-md5.pic.png" width="100">',
    '',
    '重复引用：![again](往返测试.assets/aaa-md5.图一.webp)',
    '',
    '```',
    '![代码块里的假链接](往返测试.assets/aaa-md5.图一.webp)',
    '```',
    '',
    '<!-- more -->',
    '外链保留：![ext](https://example.com/x.png)',
  ].join('\n');
  // 导出侧的改写：url -> `<assetsDir>/<name>`（这里直接按导出产物形态写 md）
  const md = `${fm}${rewriteImageUrls(
    body
      .replace(/往返测试\.assets\//g, '/static/img/')
      .replace('/static/img/aaa-md5.图一.webp', '/static/img/aaa-md5.图一.webp'),
    new Map([
      ['/static/img/aaa-md5.图一.webp', '往返测试.assets/aaa-md5.图一.webp'],
      ['/static/img/bbb-md5.pic.png', '往返测试.assets/bbb-md5.pic.png'],
      ['/static/img/cover.webp', '往返测试.assets/cover.webp'],
    ]),
  )}`;
  return buildZip([
    { relativePath: '往返测试.md', source: Buffer.from(md, 'utf8') },
    { relativePath: '往返测试.assets/aaa-md5.图一.webp', source: PNG },
    { relativePath: '往返测试.assets/bbb-md5.pic.png', source: PNG },
    { relativePath: '往返测试.assets/cover.webp', source: PNG },
    { relativePath: EXPORT_NOTE_BASENAME, source: Buffer.from('# 导出说明\n', 'utf8') },
  ]);
}

describe('mdzImport：导出→导入 往返', () => {
  it('导入导出产物：链接变成服务 URL、front matter 白名单齐全、图片全部 ingest', async () => {
    const zip = await buildExportShapedMdz();
    const log: string[] = [];
    const result = await importMdzBuffer(zip, fakeIngest(log));
    expect(result.markdownMember).toBe('往返测试.md');
    expect(result.title).toBe('往返测试');
    // 相对链接全部改写为服务 URL，正文里不再有 .assets/ 引用（代码块里的假链接除外——它本来就不该被改）
    expect(result.content).toContain('/static/img/served-aaa-md5.图一.webp');
    expect(result.content).toContain('/static/img/served-bbb-md5.pic.png');
    const outsideFence = result.content.split('```')[0] + result.content.split('```')[2];
    expect(outsideFence).not.toContain('往返测试.assets/');
    // 代码块里的"图片"两个方向都不动（extractImageRefs 涂黑逻辑，导出/导入共用）：
    // 导出时它保持原站的 /static/ 链接没被改成相对路径，导入时也就不该被改成 served URL
    expect(result.content.split('```')[1]).toContain('/static/img/aaa-md5.图一.webp');
    expect(result.content.split('```')[1]).not.toContain('served-');
    // 封面 cover 也是 /static/ 链接 → 不在 assets 里？导出侧只打包正文引用；cover 在 front matter 里，正文没引用
    expect(result.importedImages).toBe(2); // aaa（去重后 1 次 ingest，两处引用都改写）+ bbb
    expect(log).toEqual(['往返测试.assets/aaa-md5.图一.webp', '往返测试.assets/bbb-md5.pic.png']);
    expect(result.content).toContain('![again](/static/img/served-aaa-md5.图一.webp)');
    // 外链原样保留 + 进 skippedImages
    expect(result.content).toContain('https://example.com/x.png');
    expect(result.skippedImages.some((s) => s.name.includes('example.com'))).toBe(true);
    // front matter 白名单字段
    expect(result.frontMatter).toEqual(
      expect.objectContaining({
        title: '往返测试',
        pathname: 'wang-fan-ce-shi',
        category: '技术',
        tags: ['A', 'B'],
        top: 2,
        hidden: true,
        cover: '/static/img/cover.webp',
        createdAt: '2024-07-07T10:00:00.000Z',
        updatedAt: '2024-08-08T10:00:00.000Z',
      }),
    );
    expect(result.frontMatter.password).toBeUndefined();
    expect(result.passwordDropped).toBe(false);
    // cover.webp 在包里但正文没引用 → 不导入 + notes 说明
    expect(result.notes.join('\n')).toContain('未被正文引用');
  });

  it('password（scrypt 哈希）被丢弃：不进 frontMatter、不进响应任何角落、notes 明确要求重设', async () => {
    const hash = 'scrypt$deadbeef$ffffffffffffffff';
    const zip = await buildExportShapedMdz({ password: hash });
    const result = await importMdzBuffer(zip, fakeIngest());
    expect(result.passwordDropped).toBe(true);
    expect(result.frontMatter.password).toBeUndefined();
    // fail-closed：private 保留（private+空密码 = 谁都解不开，绝不静默变公开）
    expect(result.frontMatter.private).toBe(true);
    expect(result.notes.join('\n')).toContain('原文设置了访问密码，导入后需要重新设置');
    // 哈希值绝不出现在响应的任何字符串里
    expect(JSON.stringify(result)).not.toContain(hash);
    expect(JSON.stringify(result)).not.toContain('deadbeef');
  });

  it('同一个 url 引用多次：只 ingest 一次，所有出现位置都改写（与导出侧 byUrl 去重对称）', async () => {
    const md = '---\ntitle: t\n---\n\n![a](t.assets/x.png)\n\n![b](t.assets/x.png)\n';
    const zip = await buildZip([
      { relativePath: 't.md', source: Buffer.from(md, 'utf8') },
      { relativePath: 't.assets/x.png', source: PNG },
    ]);
    const log: string[] = [];
    const result = await importMdzBuffer(zip, fakeIngest(log));
    expect(log.length).toBe(1);
    expect(result.importedImages).toBe(1);
    expect(result.content.match(/\/static\/img\/served-x\.png/g)?.length).toBe(2);
  });

  it('ingest 抛错（例如图床拒收 SVG）：该链接进 skippedImages，导入继续，链接原样保留', async () => {
    const md = '---\ntitle: t\n---\n\n![a](t.assets/x.svg)\n\n![b](t.assets/y.png)\n';
    const zip = await buildZip([
      { relativePath: 't.md', source: Buffer.from(md, 'utf8') },
      { relativePath: 't.assets/x.svg', source: Buffer.from('<svg></svg>') },
      { relativePath: 't.assets/y.png', source: PNG },
    ]);
    const result = await importMdzBuffer(zip, async (name) => {
      if (name.endsWith('.svg')) {
        throw new BadRequestException('图床不接受 SVG');
      }
      return { src: '/static/img/served-y.png', isNew: true };
    });
    expect(result.importedImages).toBe(1);
    const skipped = result.skippedImages.find((s) => s.name.includes('x.svg'));
    expect(skipped?.reason).toContain('图床不接受 SVG');
    expect(result.content).toContain('![a](t.assets/x.svg)');
    expect(result.content).toContain('/static/img/served-y.png');
  });

  it('isNew=false（内容 sign 命中已有图片）计入 dedupedImages —— 幂等导入的观察点', async () => {
    const md = '---\ntitle: t\n---\n\n![a](t.assets/x.png)\n';
    const zip = await buildZip([
      { relativePath: 't.md', source: Buffer.from(md, 'utf8') },
      { relativePath: 't.assets/x.png', source: PNG },
    ]);
    const result = await importMdzBuffer(zip, async () => ({ src: '/static/img/old.png', isNew: false }));
    expect(result.importedImages).toBe(1);
    expect(result.dedupedImages).toBe(1);
  });
});

describe('mdzImport：安全拒绝（全部发生在任何写入之前）', () => {
  /**
   * zip-slip 的两层防线：
   *  1) compressing 读包时自己归一化成员名（前导 / 去掉、.. 段消掉）—— 真字节层面
   *     的 ../evil.png 到不了写入侧就已经变成无害的 evil.png；
   *  2) readMdzEntries 里的 findUnsafeArchiveMember（与整站恢复同一判定）—— 纵深防御，
   *     用假流直接喂不安全名验证它 400 且在收任何字节之前就中止。
   */
  function fakeStreamEmitting(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EventEmitter } = require('events');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Readable } = require('stream');
    return class FakeStream extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => {
          const rs = new Readable({ read: () => undefined });
          this.emit('entry', { name, type: 'file' }, rs, () => undefined);
          rs.push(PNG);
          rs.push(null);
        });
      }
      destroy() {
        // 拒绝路径上会被调用；空实现即可
      }
    };
  }

  it('zip-slip（../ 成员，直接喂给守卫）：400，在收字节之前中止', async () => {
    const err = await expect400(
      readMdzEntries(Buffer.from('whatever'), fakeStreamEmitting('../evil.png')),
      '之外',
    );
    expect(String(err.message)).toContain('../evil.png');
  });

  it('zip-slip（嵌套 .. 段 / 绝对路径 / Windows 盘号，直接喂给守卫）：全部 400', async () => {
    await expect400(
      readMdzEntries(Buffer.from('x'), fakeStreamEmitting('a.assets/../../evil.png')),
      '之外',
    );
    await expect400(
      readMdzEntries(Buffer.from('x'), fakeStreamEmitting('/etc/passwd')),
      '之外',
    );
    await expect400(
      readMdzEntries(Buffer.from('x'), fakeStreamEmitting('C:\\evil\\x.png')),
      '之外',
    );
  });

  it('真字节的 ../evil.png 包：compressing 归一化成无害成员，不逃逸也不报错', async () => {
    const zip = await buildZipSlipZip('safevil.png', '../evil.png');
    const { entries } = await readMdzEntries(zip);
    // 归一化后名字里不可能再有 .. 或前导 /
    for (const name of entries.keys()) {
      expect(name).not.toContain('..');
      expect(name.startsWith('/')).toBe(false);
    }
    expect(entries.has('evil.png')).toBe(true);
  });

  it('不是 zip：400 且信息可读；空文件：400', async () => {
    await expect400(importMdzBuffer(Buffer.from('这不是zip'.repeat(4), 'utf8'), fakeIngest()), '解压');
    await expect400(importMdzBuffer(Buffer.alloc(0), fakeIngest()), '为空');
  });

  it('成员数超过上限：400', async () => {
    const entries = [{ relativePath: 't.md', source: Buffer.from('x', 'utf8') }];
    for (let i = 0; i < MDZ_MAX_ENTRIES + 1; i += 1) {
      entries.push({ relativePath: `a.assets/f${i}.png`, source: PNG });
    }
    const zip = await buildZip(entries);
    await expect400(importMdzBuffer(zip, fakeIngest()), '成员数超过上限');
  });

  it('单个 md 成员超过 20MB：400（zip 炸弹的第一道闸）', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 97); // 'a' × 21MB，deflate 后很小
    const zip = await buildZip([{ relativePath: 't.md', source: big }]);
    await expect400(importMdzBuffer(zip, fakeIngest()), '单文件上限');
  });

  it('解压后总体积超过 400MB：400（81 × 5MB，逐成员累计到第 81 个时触发）', async () => {
    const chunk = Buffer.alloc(5 * 1024 * 1024, 0); // 全零，压缩后极小
    const entries = [{ relativePath: 't.md', source: Buffer.from('x', 'utf8') }];
    for (let i = 0; i < 81; i += 1) {
      entries.push({ relativePath: `a.assets/f${i}.bin`, source: chunk });
    }
    const zip = await buildZip(entries);
    await expect400(importMdzBuffer(zip, fakeIngest()), '总体积超过上限');
  });
});

describe('mdzImport：markdown 成员选择与 front matter', () => {
  it('没有 md 成员：400 且文案具体', async () => {
    const zip = await buildZip([{ relativePath: 'a.assets/x.png', source: PNG }]);
    await expect400(importMdzBuffer(zip, fakeIngest()), '没有找到 Markdown');
  });

  it('导出说明.md 不算正文候选', async () => {
    const sel = selectMarkdownMember([EXPORT_NOTE_BASENAME, '正文.md', 'a.assets/x.png']);
    expect(sel.name).toBe('正文.md');
    expect(sel.notes).toEqual([]);
  });

  it('多个 md：根目录 > 名字更短 > 字节序，且选择规则写进 notes', async () => {
    const sel = selectMarkdownMember(['nested/long-name.md', 'b.md', 'a.md']);
    expect(sel.name).toBe('a.md');
    expect(sel.notes.join('')).toContain('3 个 Markdown');
    const sel2 = selectMarkdownMember(['dir/x.md', 'root.md']);
    expect(sel2.name).toBe('root.md');
  });

  it('没有 front matter：attrs 为空、正文原样', () => {
    const parsed = parseMdzMarkdown('# 就是正文\n\n---\n\n后面还有分隔线\n');
    expect(parsed.attrs).toEqual({});
    expect(parsed.body).toContain('# 就是正文');
  });

  it('YAML 坏掉：不致命，按无元信息处理并记 notes，原文保留', () => {
    const parsed = parseMdzMarkdown('---\ntitle: [没闭合\n  : : :\n---\n\n正文\n');
    expect(parsed.attrs).toEqual({});
    expect(parsed.notes.join('')).toContain('front matter');
    expect(parsed.body).toContain('title');
  });

  it('与 utils/frontMatter.ts 的正则保持逐字符同步（钉子：谁改了那边这里就红）', () => {
    const fmSrc = fs.readFileSync(path.join(__dirname, 'frontMatter.ts'), 'utf8');
    const mySrc = fs.readFileSync(path.join(__dirname, 'mdzImport.ts'), 'utf8');
    const theirs = /const FRONT_MATTER_RE = (\/.+?\/);/.exec(fmSrc)?.[1];
    const mine = /const FRONT_MATTER_BLOCK_RE = (\/.+?\/);/.exec(mySrc)?.[1];
    expect(theirs).toBeTruthy();
    expect(mine).toBe(theirs);
  });

  it('normalizeFrontMatter：tags 字符串→数组、top true→1、日期归一 ISO、坏日期忽略并记录', () => {
    const r = normalizeFrontMatter({
      tags: 'solo',
      top: true,
      createdAt: '2024-07-07T10:00:00.000Z',
      updatedAt: '不是时间',
      hidden: 'true',
      title: ' t ',
      password: '',
    });
    expect(r.frontMatter.tags).toEqual(['solo']);
    expect(r.frontMatter.top).toBe(1);
    expect(r.frontMatter.createdAt).toBe('2024-07-07T10:00:00.000Z');
    expect(r.frontMatter.updatedAt).toBeUndefined();
    expect(r.notes.join('')).toContain('updatedAt');
    expect(r.frontMatter.hidden).toBe(true);
    expect(r.frontMatter.title).toBe('t');
    expect(r.passwordDropped).toBe(false); // 空串 = 没设密码，不算丢弃
  });
});

describe('mdzImport：链接解析', () => {
  it('相对链接找不到成员：skippedImages 带原因；data URI / 绝对地址原样保留', () => {
    const body = '![m](t.assets/missing.png)\n\n![d](data:image/png;base64,AAAA)\n\n![s](/static/img/old.png)\n';
    const { plan, notes } = planImageImports(body, ['t.md', 't.assets/other.png']);
    const byUrl = new Map(plan.map((p) => [p.url, p]));
    expect(byUrl.get('t.assets/missing.png')).toMatchObject({ kind: 'skip' });
    expect(byUrl.get('t.assets/missing.png')?.reason).toContain('找不到');
    expect(byUrl.get('data:image/png;base64,AAAA')?.reason).toContain('data URI');
    expect(byUrl.get('/static/img/old.png')?.kind).toBe('skip');
    expect(byUrl.get('t.assets/other.png')).toBeUndefined(); // 未引用成员不进 plan
    expect(notes.join('')).toContain('未被正文引用');
  });

  it('百分号编码的相对链接（第三方工具打的包）也能对上成员', async () => {
    const md = '---\ntitle: t\n---\n\n![a](t.assets/my%%20pic.png)\n'.replace('%%', '%');
    const zip = await buildZip([
      { relativePath: 't.md', source: Buffer.from(md, 'utf8') },
      { relativePath: 't.assets/my pic.png', source: PNG },
    ]);
    const result = await importMdzBuffer(zip, fakeIngest());
    expect(result.importedImages).toBe(1);
    expect(result.content).toContain('/static/img/served-my pic.png');
  });

  it('重名成员：保留第一个并记 notes', async () => {
    const zip = await buildZip([
      { relativePath: 't.md', source: Buffer.from('---\ntitle: t\n---\n\nx\n', 'utf8') },
      { relativePath: 'a.assets/dup.png', source: Buffer.from('first') },
      { relativePath: 'a.assets/dup.png', source: Buffer.from('second!!') },
    ]);
    const { entries, notes } = await readMdzEntries(zip);
    expect(entries.get('a.assets/dup.png')?.toString()).toBe('first');
    expect(notes.join('')).toContain('重名');
  });
});
