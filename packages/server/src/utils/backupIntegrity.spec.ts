import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildIntegrity,
  diffMembers,
  probeCompressorChecksum,
  readSha256Sidecar,
  summarizeFindings,
  writeSha256Sidecar,
} from './backupIntegrity';
import { computeMerkleRoot, sha256Hex } from './backupTarStream';

/**
 * 归档防损坏的纯逻辑：压缩器校验位实测、`.sha256` sidecar、integrity 组装、成员表逐项对比。
 *
 * ⚠️ 每一项都有**外部权威**对照，不拿被测函数自己算的值当期望：
 *  - 压缩器校验位：读真归档的头部位，并用 `zstd -t` / `xz -t` 交叉验证"能过完整性测试"；
 *  - sidecar 格式：与 `sha256sum` 的输出逐字节相同，并让 `sha256sum -c` 真的去验一次；
 *  - merkleRoot：与 `backupTarStream.spec.ts` 里的固定向量同源（Python hashlib 算的）。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('probeCompressorChecksum（实测，不是假设默认值）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('vanblog-probe-');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const itZstd = has('zstd') ? it : it.skip;

  itZstd('zstd 默认（不带 --check）就已经开了内容校验位：帧头描述符 bit2=1', () => {
    const file = path.join(dir, 'a.tar.zst');
    execFileSync('sh', ['-c', `printf 'hello' | zstd -3 -q -c > '${file}'`]);
    const probe = probeCompressorChecksum(file, 'zstd');
    expect(probe.enabled).toBe(true);
    expect(probe.detail).toContain('bit2(Content_Checksum)=1');
    // 头部位与"zstd 自己认为有没有校验和"必须一致
    const raw = fs.readFileSync(file);
    expect(raw[4] & 0x04).toBe(0x04);
  });

  itZstd('显式 --no-check：必须实测出 false（这就是"pinned, not assumed"要抓的情况）', () => {
    const file = path.join(dir, 'b.tar.zst');
    execFileSync('sh', ['-c', `printf 'hello' | zstd -3 --no-check -q -c > '${file}'`]);
    const probe = probeCompressorChecksum(file, 'zstd');
    expect(probe.enabled).toBe(false);
    expect(fs.readFileSync(file)[4] & 0x04).toBe(0);
  });

  itZstd('server 真正用的那条命令（zstd -19 --long=27 -T0 --check）产出的归档：true', () => {
    const file = path.join(dir, 'c.tar.zst');
    execFileSync('sh', ['-c', `printf 'hello' | zstd -19 --long=27 -T0 --check -q -c > '${file}'`]);
    expect(probeCompressorChecksum(file, 'zstd').enabled).toBe(true);
    // 交叉验证：zstd -t 能通过（真有校验和可验）
    expect(() => execFileSync('zstd', ['-t', '-q', '--long=27', file], { stdio: 'ignore' })).not.toThrow();
  });

  const itXz = has('xz') ? it : it.skip;
  itXz('xz 默认 CRC64：stream flags 的 check 类型非 0', () => {
    const file = path.join(dir, 'a.tar.xz');
    execFileSync('sh', ['-c', `printf 'hello' | xz -1 -c > '${file}'`]);
    const probe = probeCompressorChecksum(file, 'xz');
    expect(probe.enabled).toBe(true);
    expect(probe.detail).toContain('check 类型=4');
  });

  it('gzip 的 CRC32 是格式强制的：true', () => {
    const file = path.join(dir, 'a.tar.gz');
    execFileSync('sh', ['-c', `printf 'hello' | gzip -9 -c > '${file}'`]);
    expect(probeCompressorChecksum(file, 'gzip').enabled).toBe(true);
  });

  it('读不出/认不出：enabled=null 并说明原因（绝不假装 true）', () => {
    const missing = path.join(dir, 'nope.tar.zst');
    expect(probeCompressorChecksum(missing, 'zstd').enabled).toBeNull();
    const junk = path.join(dir, 'junk.tar.zst');
    fs.writeFileSync(junk, 'not a zstd file at all');
    const probe = probeCompressorChecksum(junk, 'zstd');
    expect(probe.enabled).toBeNull();
    expect(probe.detail).toContain('magic');
    expect(probeCompressorChecksum(junk, 'lzh').enabled).toBeNull();
  });
});

describe('sha256 sidecar（与 sha256sum 完全同格式）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('vanblog-sidecar-');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('写出来的内容是 "<hex>  <文件名>\\n"（两个空格），sha256sum -c 能直接验', () => {
    const archive = path.join(dir, 'vanblog-full-20260917-000000.tar.zst');
    fs.writeFileSync(archive, Buffer.from('archive-bytes'));
    const hex = sha256Hex('archive-bytes');
    const sidecar = writeSha256Sidecar(archive, hex);
    expect(sidecar).toBe(`${archive}.sha256`);
    const text = fs.readFileSync(sidecar as string, 'utf8');
    expect(text).toBe(`${hex}  vanblog-full-20260917-000000.tar.zst\n`);
    // 外部权威：coreutils 自己验一遍（-c 会读同目录的相对文件名）
    const out = execFileSync('sha256sum', ['-c', path.basename(sidecar as string)], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(out).toContain('OK');
  });

  it('读回来：present/hex/name；缺失时 present=false 且不抛', () => {
    const archive = path.join(dir, 'vanblog-full-20260917-000001.tar.zst');
    fs.writeFileSync(archive, 'x');
    expect(readSha256Sidecar(archive)).toEqual({
      present: false,
      hex: null,
      name: null,
      parseError: null,
    });
    writeSha256Sidecar(archive, sha256Hex('x'));
    const info = readSha256Sidecar(archive);
    expect(info.present).toBe(true);
    expect(info.hex).toBe(sha256Hex('x'));
    expect(info.name).toBe('vanblog-full-20260917-000001.tar.zst');
  });

  it('也认 sha256sum 二进制模式的 " *" 分隔与大小写十六进制', () => {
    const archive = path.join(dir, 'vanblog-full-20260917-000002.tar.zst');
    fs.writeFileSync(archive, 'x');
    fs.writeFileSync(`${archive}.sha256`, `${sha256Hex('x').toUpperCase()} *vanblog-full-20260917-000002.tar.zst\n`);
    const info = readSha256Sidecar(archive);
    expect(info.hex).toBe(sha256Hex('x'));
    expect(info.name).toBe('vanblog-full-20260917-000002.tar.zst');
  });

  it('格式不认识：present=true 但 hex=null 且带 parseError（不静默当成"没有 sidecar"）', () => {
    const archive = path.join(dir, 'vanblog-full-20260917-000003.tar.zst');
    fs.writeFileSync(archive, 'x');
    fs.writeFileSync(`${archive}.sha256`, 'garbage\n');
    const info = readSha256Sidecar(archive);
    expect(info.present).toBe(true);
    expect(info.hex).toBeNull();
    expect(info.parseError).toBeTruthy();
  });

  it('写不进去时返回 null（调用方记 WARN，绝不让一次成功的备份变成失败）', () => {
    const archive = path.join(dir, 'no-such-dir', 'vanblog-full-20260917-000004.tar.zst');
    expect(writeSha256Sidecar(archive, sha256Hex('x'))).toBeNull();
  });
});

describe('buildIntegrity', () => {
  it('两份清单成员被登记为 null、memberCount 比 tar 流多 2、merkleRoot 覆盖全表', () => {
    const members = {
      './db/vanBlog/articles.ndjson': { sha256: sha256Hex('a'), bytes: 1 },
      './static/img/x.webp': { sha256: sha256Hex('b'), bytes: 1 },
      './manifest.json': { sha256: 'should-be-overwritten', bytes: 9 },
    };
    const integrity = buildIntegrity({ members, memberCount: 5, frameChecksum: true });
    expect(integrity.algorithm).toBe('sha256');
    expect(integrity.zstdFrameChecksum).toBe(true);
    // 暂存树那一遍没有这两份清单，所以 +2
    expect(integrity.memberCount).toBe(7);
    // 传进来的 manifest.json 条目被覆盖成 null（它不可能有自己的哈希）
    expect(integrity.members['./manifest.json']).toBeNull();
    expect(integrity.members['./MANIFEST.copy.json']).toBeNull();
    expect(integrity.merkleRoot).toBe(computeMerkleRoot(integrity.members));
    expect(Object.keys(integrity.members).length).toBe(4);
    // 不改动传进来的对象（避免调用方拿到被污染的表）
    expect(members['./manifest.json']).toEqual({ sha256: 'should-be-overwritten', bytes: 9 });
  });
});

describe('diffMembers（要说出"哪个成员、期望什么、实际什么"）', () => {
  const expected = {
    './manifest.json': null,
    './MANIFEST.copy.json': null,
    './db/a.ndjson': { sha256: sha256Hex('a'), bytes: 1 },
    './static/img/ok.webp': { sha256: sha256Hex('ok'), bytes: 2 },
    './static/img/gone.webp': { sha256: sha256Hex('gone'), bytes: 4 },
  };

  it('完全一致：没有任何发现', () => {
    expect(diffMembers(expected, JSON.parse(JSON.stringify(expected)))).toEqual([]);
  });

  it('内容被改：kind=hash，带期望与实际两个值', () => {
    const actual = JSON.parse(JSON.stringify(expected));
    actual['./db/a.ndjson'].sha256 = sha256Hex('tampered');
    const findings = diffMembers(expected, actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      kind: 'hash',
      path: './db/a.ndjson',
      expected: sha256Hex('a'),
      actual: sha256Hex('tampered'),
      message: 'sha256 不匹配',
    });
    expect(summarizeFindings(findings)).toContain('./db/a.ndjson');
    expect(summarizeFindings(findings)).toContain(`${sha256Hex('a').slice(0, 12)}…`);
  });

  it('成员丢失：kind=missing', () => {
    const actual = JSON.parse(JSON.stringify(expected));
    delete actual['./static/img/gone.webp'];
    const findings = diffMembers(expected, actual);
    expect(findings.map((f) => f.kind)).toEqual(['missing']);
    expect(findings[0].path).toBe('./static/img/gone.webp');
  });

  it('多出成员：kind=unexpected（有人往归档里塞了东西）', () => {
    const actual = JSON.parse(JSON.stringify(expected));
    actual['./static/img/evil.php'] = { sha256: sha256Hex('evil'), bytes: 4 };
    const findings = diffMembers(expected, actual);
    expect(findings.map((f) => f.kind)).toEqual(['unexpected']);
    expect(findings[0].path).toBe('./static/img/evil.php');
  });

  it('字节数变了但哈希"恰好"相同（构造出来的）：kind=size', () => {
    const actual = JSON.parse(JSON.stringify(expected));
    actual['./static/img/ok.webp'].bytes = 999;
    const findings = diffMembers(expected, actual);
    expect(findings.map((f) => f.kind)).toEqual(['size']);
    expect(findings[0].expected).toBe('2');
    expect(findings[0].actual).toBe('999');
  });

  it('期望为 null 的成员（两份清单）只查在不在，不比哈希', () => {
    const actual: any = JSON.parse(JSON.stringify(expected));
    actual['./manifest.json'] = { sha256: sha256Hex('whatever'), bytes: 10 };
    actual['./MANIFEST.copy.json'] = { sha256: sha256Hex('whatever'), bytes: 10 };
    expect(diffMembers(expected, actual)).toEqual([]);
    // 但少一份副本必须被抓出来
    delete actual['./MANIFEST.copy.json'];
    const findings = diffMembers(expected, actual);
    expect(findings.map((f) => [f.kind, f.path])).toEqual([['missing', './MANIFEST.copy.json']]);
  });

  it('summarizeFindings 最多点名 limit 个，并说明还剩几项', () => {
    const exp: any = {};
    const act: any = {};
    for (let i = 0; i < 25; i += 1) {
      exp[`./f${i}`] = { sha256: sha256Hex(`e${i}`), bytes: 1 };
      act[`./f${i}`] = { sha256: sha256Hex(`a${i}`), bytes: 1 };
    }
    const text = summarizeFindings(diffMembers(exp, act));
    expect(text).toContain('另有 15 项');
    expect(text.split('；').length).toBeLessThanOrEqual(11);
    expect(summarizeFindings([])).toBe('无');
  });
});
