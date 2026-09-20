import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { hashFile } from './backupTarStream';
import { assertRestorableArchive } from './fullBackup';
import {
  BACKUP_SIG_ALG,
  BACKUP_SIG_DIGEST,
  BACKUP_SIG_EXT,
  BACKUP_SIG_MAGIC,
  SIGNING_KEY_ENV,
  SIGNING_KEY_FILE_ENV,
  VERIFY_KEY_ENV,
  VERIFY_KEY_FILE_ENV,
  assertArchiveSignatureForRestore,
  generateSigningKeyPair,
  keyFingerprint,
  readSignatureSidecar,
  resolveSigningKey,
  resolveVerifyKey,
  signArchiveDigest,
  signatureSidecarPath,
  signatureVerifyMessage,
  signingPayload,
  verifySignatureAgainstDigest,
} from './backupSigning';

/**
 * 备份归档的离线签名（真实性证明）。
 *
 * 这些用例的判据一律是**行为**：真生成 ed25519 密钥、真签名、真验签、真改一个字节看它是否失败。
 * 源码级锚点只用于"接线位置"这种无法用行为表达的性质（例如"验签闸门必须排在解包之前"），
 * 并且都在剥注释之后断言、都带负向对照。
 *
 * ⚠️ ed25519 很快（签/验各几十微秒），所以这里可以放心做真密码学操作；
 * 但**不要**在这个文件里用生产级 scrypt 参数派生任何东西（本仓库有过一个 400 秒的单测拖垮 CI）。
 */

function tmpDir(prefix = 'vanblog-signing-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeArchive(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function makeEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('backupSigning：密钥解析', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('什么都没配时返回 null（= 默认关，不签名也不验签）', () => {
    expect(resolveSigningKey(dir, {})).toBeNull();
    expect(resolveVerifyKey(dir, {})).toBeNull();
  });

  it('env 里给内联私钥就能签名，并能从它导出公钥与指纹', () => {
    const { privateKeyPem, publicKeyPem } = makeEd25519Pem();
    const key = resolveSigningKey(dir, { [SIGNING_KEY_ENV]: privateKeyPem });
    expect(key).not.toBeNull();
    expect(key!.source).toBe('env');
    expect(key!.fingerprint).toBe(keyFingerprint(publicKeyPem));
    // 指纹是 16 位十六进制（与 JWT 轮换的 kidOf 同一形状）
    expect(key!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('_FILE 优先于内联变量（与既有 secret-file 契约一致）', () => {
    const a = makeEd25519Pem();
    const b = makeEd25519Pem();
    const file = path.join(dir, 'key.pem');
    fs.writeFileSync(file, a.privateKeyPem);
    const key = resolveSigningKey(dir, {
      [SIGNING_KEY_FILE_ENV]: file,
      [SIGNING_KEY_ENV]: b.privateKeyPem,
    });
    expect(key!.source).toBe('env-file');
    expect(key!.fingerprint).toBe(keyFingerprint(a.publicKeyPem));
  });

  it('_FILE 指向读不到的路径时**失败关闭**，绝不静默回落到"不签名"', () => {
    // ⚠️ 静默回落会让站长以为归档签了名、实际没签 —— 那比不做这个功能更糟，
    //    因为他会照着"我有签名保护"去规划异地副本。
    expect(() =>
      resolveSigningKey(dir, { [SIGNING_KEY_FILE_ENV]: path.join(dir, 'nope.pem') }),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveSigningKey(dir, { [SIGNING_KEY_FILE_ENV]: path.join(dir, 'nope.pem') }),
    ).toThrow(/不会静默回落/);
  });

  it('_FILE 只 trimEnd：尾部换行不算内容，但空文件要被拒', () => {
    const { privateKeyPem, publicKeyPem } = makeEd25519Pem();
    const file = path.join(dir, 'key.pem');
    fs.writeFileSync(file, `${privateKeyPem}\n\n`);
    expect(resolveSigningKey(dir, { [SIGNING_KEY_FILE_ENV]: file })!.fingerprint).toBe(
      keyFingerprint(publicKeyPem),
    );
    fs.writeFileSync(file, '   \n');
    expect(() => resolveSigningKey(dir, { [SIGNING_KEY_FILE_ENV]: file })).toThrow(/空的/);
  });

  it('非 ed25519 的密钥被拒（不给"看起来配好了其实算法不对"留余地）', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => resolveSigningKey(dir, { [SIGNING_KEY_ENV]: pem })).toThrow(/ed25519/);
  });

  it('验签钥可以只给公钥；给了私钥也能用（导出公钥）', () => {
    const { privateKeyPem, publicKeyPem } = makeEd25519Pem();
    const byPublic = resolveVerifyKey(dir, { [VERIFY_KEY_ENV]: publicKeyPem });
    const byPrivate = resolveVerifyKey(dir, { [VERIFY_KEY_ENV]: privateKeyPem });
    expect(byPublic!.fingerprint).toBe(keyFingerprint(publicKeyPem));
    expect(byPrivate!.fingerprint).toBe(byPublic!.fingerprint);
  });

  it('没配验签钥时回落到签名钥（一体式部署只配一把私钥也能自验）', () => {
    const { privateKeyPem, publicKeyPem } = makeEd25519Pem();
    const verify = resolveVerifyKey(dir, { [SIGNING_KEY_ENV]: privateKeyPem });
    expect(verify).not.toBeNull();
    expect(verify!.fingerprint).toBe(keyFingerprint(publicKeyPem));
  });

  it('会用到 `<备份目录>/signing/` 下生成的密钥对（公钥优先，其次私钥）', () => {
    const generated = generateSigningKeyPair(dir);
    expect(resolveSigningKey(dir, {})!.fingerprint).toBe(generated.fingerprint);
    expect(resolveSigningKey(dir, {})!.source).toBe('generated');
    expect(resolveVerifyKey(dir, {})!.fingerprint).toBe(generated.fingerprint);
  });
});

describe('backupSigning：生成密钥对', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('私钥落盘 0600、目录 0700，且**返回值里没有私钥**', () => {
    const result = generateSigningKeyPair(dir);
    expect(fs.statSync(result.privatePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.publicPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(result.privatePath)).mode & 0o777).toBe(0o700);
    // ⚠️ 这条是本功能最重要的一条性质：私钥一旦经 HTTP 出去，就会留在浏览器历史、
    //    反代日志与任何中间件里，"备份可证明"的全部价值当场消失。
    const serialized = JSON.stringify(result);
    const onDisk = fs.readFileSync(result.privatePath, 'utf8');
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain(onDisk.trim().split('\n')[1].trim());
    expect(Object.keys(result).sort()).toEqual(
      ['fingerprint', 'privatePath', 'publicKeyPem', 'publicPath', 'replaced'].sort(),
    );
    // 空转反证：同一把尺子在"真的把私钥放进返回值"时必须命中
    expect(JSON.stringify({ ...result, privateKeyPem: onDisk })).toContain('PRIVATE KEY');
  });

  it('已存在时拒绝覆盖（覆盖会让所有旧 .sig 永久验不过），且报错可照做', () => {
    generateSigningKeyPair(dir);
    expect(() => generateSigningKeyPair(dir)).toThrow(BadRequestException);
    expect(() => generateSigningKeyPair(dir)).toThrow(/永久无法验证/);
    expect(() => generateSigningKeyPair(dir)).toThrow(/confirm=true/);
  });

  it('显式 overwrite 才允许换密钥，并如实报告 replaced', () => {
    const first = generateSigningKeyPair(dir);
    const second = generateSigningKeyPair(dir, { overwrite: true });
    expect(second.replaced).toBe(true);
    expect(first.replaced).toBe(false);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('指纹是公钥的纯函数（同一把钥匙算两次相同，两把不同的钥匙不同）', () => {
    const a = makeEd25519Pem();
    const b = makeEd25519Pem();
    expect(keyFingerprint(a.publicKeyPem)).toBe(keyFingerprint(a.publicKeyPem));
    expect(keyFingerprint(a.publicKeyPem)).not.toBe(keyFingerprint(b.publicKeyPem));
  });
});

describe('backupSigning：签与验（真密码学操作）', () => {
  let dir: string;
  let archive: string;
  let sha256: string;
  let key: ReturnType<typeof resolveSigningKey>;

  beforeEach(async () => {
    dir = tmpDir();
    archive = writeArchive(dir, 'vanblog-full-20260920-000000.tar.zst', 'A'.repeat(4096));
    sha256 = (await hashFile(archive)).sha256;
    generateSigningKeyPair(dir);
    key = resolveSigningKey(dir, {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('没配密钥时 signArchiveDigest 返回 null 且**一个字节都不写**（默认关的证据）', () => {
    const before = fs.readdirSync(dir).sort();
    expect(signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: null })).toBeNull();
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.existsSync(signatureSidecarPath(archive))).toBe(false);
  });

  it('签名 → 验签通过；`.sig` 是明文 JSON、带魔数与指纹，且 0600', () => {
    const sigPath = signArchiveDigest({
      archivePath: archive,
      archiveSha256: sha256,
      archiveBytes: 4096,
      signingKey: key,
    });
    expect(sigPath).toBe(`${archive}${BACKUP_SIG_EXT}`);
    expect(fs.statSync(sigPath!).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(fs.readFileSync(sigPath!, 'utf8'));
    expect(raw.magic).toBe(BACKUP_SIG_MAGIC);
    expect(raw.alg).toBe(BACKUP_SIG_ALG);
    expect(raw.digest).toBe(BACKUP_SIG_DIGEST);
    expect(raw.archiveSha256).toBe(sha256);
    expect(raw.keyFingerprint).toBe(key!.fingerprint);
    // 签名本体是 64 字节（ed25519）
    expect(Buffer.from(raw.signature, 'base64')).toHaveLength(64);

    const r = verifySignatureAgainstDigest({
      archivePath: archive,
      actualSha256: sha256,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(r.state).toBe('ok');
    expect(r.ok).toBe(true);
  });

  it('🔴 篡改归档一个字节 ⇒ 验签必须失败，且结论是 mismatch（不是"拿错钥匙"）', async () => {
    signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: key });
    const buf = fs.readFileSync(archive);
    buf[123] = buf[123] ^ 0xff; // 翻一个字节
    fs.writeFileSync(archive, buf);
    const actual = (await hashFile(archive)).sha256;
    const r = verifySignatureAgainstDigest({
      archivePath: archive,
      actualSha256: actual,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(r.state).toBe('mismatch');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/被改动过/);
    expect(r.message).toMatch(/不要用这份归档恢复/);
  });

  it('🔴 篡改 .sig 里的 sha256（"连 sidecar 一起换"这个攻击）⇒ 仍然 mismatch', () => {
    signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: key });
    // 攻击者改了归档，然后把 .sig 里的 archiveSha256 也改成新归档的哈希
    const sigPath = signatureSidecarPath(archive);
    const raw = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    raw.archiveSha256 = 'f'.repeat(64);
    fs.writeFileSync(sigPath, JSON.stringify(raw, null, 2));
    const r = verifySignatureAgainstDigest({
      archivePath: archive,
      actualSha256: 'f'.repeat(64),
      verifyKey: resolveVerifyKey(dir, {}),
    });
    // sha256 对得上，但签名覆盖的载荷变了 ⇒ 密码学验签失败
    expect(r.state).toBe('mismatch');
    expect(r.ok).toBe(false);
  });

  it('🔴 换一把公钥 ⇒ key-mismatch，且文案明确说"归档不一定有问题，是钥匙不对"', () => {
    signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: key });
    const other = makeEd25519Pem();
    const r = verifySignatureAgainstDigest({
      archivePath: archive,
      actualSha256: sha256,
      verifyKey: {
        publicKeyPem: other.publicKeyPem,
        fingerprint: keyFingerprint(other.publicKeyPem),
        source: 'env',
      },
    });
    expect(r.state).toBe('key-mismatch');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/另一把密钥/);
    expect(r.message).toMatch(/不一定有问题/);
    // ⚠️ 三种失败的文案必须**互相可区分**：混成一句"校验失败"会让站长在灾难现场做错决定
    expect(r.message).not.toMatch(/被改动过/);
  });

  it('没有 .sig ⇒ missing-sig（ok=null，**不是** false 也不是 true）', () => {
    const r = verifySignatureAgainstDigest({
      archivePath: archive,
      actualSha256: sha256,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(r.state).toBe('missing-sig');
    expect(r.ok).toBeNull();
    expect(r.message).toMatch(/从没被签过/);
  });

  it('.sig 畸形 ⇒ malformed-sig（既不当通过，也不断言"被篡改"）', () => {
    const sigPath = signArchiveDigest({
      archivePath: archive,
      archiveSha256: sha256,
      archiveBytes: 4096,
      signingKey: key,
    })!;
    for (const broken of ['{', 'not json at all', JSON.stringify({ magic: 'WRONG', v: 1 })]) {
      fs.writeFileSync(sigPath, broken);
      const r = verifySignatureAgainstDigest({
        archivePath: archive,
        actualSha256: sha256,
        verifyKey: resolveVerifyKey(dir, {}),
      });
      expect(r.state).toBe('malformed-sig');
      expect(r.ok).toBeNull();
    }
  });

  it('有 .sig 但没配公钥 ⇒ no-key，且文案明说"这不等于验签通过"', () => {
    signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: key });
    const r = verifySignatureAgainstDigest({ archivePath: archive, actualSha256: sha256, verifyKey: null });
    expect(r.state).toBe('no-key');
    expect(r.ok).toBeNull();
    expect(r.sigFingerprint).toBe(key!.fingerprint); // 知道"签过"，只是验不了
    expect(signatureVerifyMessage({ state: 'no-key', sigFingerprint: null, expectedFingerprint: null })).toMatch(
      /不等于/,
    );
  });

  it('归档改名不影响验签（文件名不参与签名载荷）', () => {
    signArchiveDigest({ archivePath: archive, archiveSha256: sha256, archiveBytes: 4096, signingKey: key });
    const renamed = path.join(dir, 'renamed-by-operator.tar.zst');
    fs.renameSync(archive, renamed);
    fs.renameSync(signatureSidecarPath(archive), signatureSidecarPath(renamed));
    const r = verifySignatureAgainstDigest({
      archivePath: renamed,
      actualSha256: sha256,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(r.state).toBe('ok');
    // 并且载荷里确实不含文件名：把 .sig 里的 archiveName 改掉，验签仍然通过
    const sigPath = signatureSidecarPath(renamed);
    const raw = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    raw.archiveName = 'completely-different-name.tar.zst';
    fs.writeFileSync(sigPath, JSON.stringify(raw, null, 2));
    expect(
      verifySignatureAgainstDigest({
        archivePath: renamed,
        actualSha256: sha256,
        verifyKey: resolveVerifyKey(dir, {}),
      }).state,
    ).toBe('ok');
  });

  it('签名载荷是规范化的：字段顺序固定，ed25519 因此可复现（同输入同签名）', () => {
    const fields = {
      archiveSha256: sha256,
      archiveBytes: 4096,
      keyFingerprint: key!.fingerprint,
      signedAt: '2026-09-20T00:00:00.000Z',
    };
    const a = signArchiveDigest({ archivePath: archive, signingKey: key, now: new Date(fields.signedAt), ...fields, archiveSha256: sha256, archiveBytes: 4096 });
    const sigA = JSON.parse(fs.readFileSync(a!, 'utf8')).signature;
    fs.rmSync(a!, { force: true });
    const b = signArchiveDigest({ archivePath: archive, signingKey: key, now: new Date(fields.signedAt), archiveSha256: sha256, archiveBytes: 4096 });
    expect(JSON.parse(fs.readFileSync(b!, 'utf8')).signature).toBe(sigA);
    // 载荷含魔数/版本/算法/摘要，所以换算法或换版本会得到不同签名（不会跨版本误验通过）
    expect(signingPayload(fields).toString('utf8')).toContain(BACKUP_SIG_MAGIC);
    expect(signingPayload(fields).toString('utf8')).toContain(BACKUP_SIG_ALG);
  });

  it('拒绝签一个畸形 sha256（否则会得到一份"永远验不过"的 .sig，看起来像被篡改）', () => {
    expect(() =>
      signArchiveDigest({ archivePath: archive, archiveSha256: 'nope', archiveBytes: 1, signingKey: key }),
    ).toThrow(/不是 64 位十六进制/);
  });

  it('readSignatureSidecar 对超大 .sig 直接判不可用（不让几 GB 的 .sig 打解析端）', () => {
    const sigPath = signatureSidecarPath(archive);
    fs.writeFileSync(sigPath, JSON.stringify({ magic: BACKUP_SIG_MAGIC }).padEnd(70 * 1024, ' '));
    expect(readSignatureSidecar(sigPath)).toBeNull();
  });
});

describe('backupSigning：恢复闸门（assertArchiveSignatureForRestore）', () => {
  let dir: string;
  let archivePath: string;
  let sha256: string;
  let key: NonNullable<ReturnType<typeof resolveSigningKey>>;

  beforeEach(async () => {
    dir = tmpDir();
    archivePath = writeArchive(dir, 'vanblog-full-20260920-010101.tar.zst', 'B'.repeat(2048));
    sha256 = (await hashFile(archivePath)).sha256;
    generateSigningKeyPair(dir);
    key = resolveSigningKey(dir, {})!;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('配了公钥 + 有 .sig + 签名有效 ⇒ 放行，checked=true', () => {
    signArchiveDigest({ archivePath: archivePath, archiveSha256: sha256, archiveBytes: 2048, signingKey: key });
    const gate = assertArchiveSignatureForRestore({
      archivePath,
      actualSha256: sha256,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(gate.checked).toBe(true);
    expect(gate.result?.state).toBe('ok');
    expect(gate.warning).toBeNull();
  });

  it('🔴 配了公钥 + 签名验不过 ⇒ **抛 400 拒绝恢复**，并给出跳过办法', async () => {
    signArchiveDigest({ archivePath: archivePath, archiveSha256: sha256, archiveBytes: 2048, signingKey: key });
    const buf = fs.readFileSync(archivePath);
    buf[7] = buf[7] ^ 0x01;
    fs.writeFileSync(archivePath, buf);
    const actual = (await hashFile(archivePath)).sha256;
    expect(() =>
      assertArchiveSignatureForRestore({ archivePath, actualSha256: actual, verifyKey: resolveVerifyKey(dir, {}) }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertArchiveSignatureForRestore({ archivePath, actualSha256: actual, verifyKey: resolveVerifyKey(dir, {}) }),
    ).toThrow(/拒绝恢复/);
    expect(() =>
      assertArchiveSignatureForRestore({ archivePath, actualSha256: actual, verifyKey: resolveVerifyKey(dir, {}) }),
    ).toThrow(/skipSignatureCheck=true/);
  });

  it('⚠️ 没配公钥 ⇒ **放行**（既有部署不能因为升级而恢复不了），但给一条响亮的 WARN', () => {
    const gate = assertArchiveSignatureForRestore({ archivePath, actualSha256: sha256, verifyKey: null });
    expect(gate.checked).toBe(false);
    // ⚠️ 断言"没配公钥"这件事，而不是钉死整句文案：两种情况（有 .sig / 没 .sig）的措辞不同，
    //    但都必须说清"没配验签公钥"，否则站长会以为验过了。
    expect(gate.warning).toMatch(/没配验签公钥/);
    expect(gate.warning).toMatch(/真实性未被证明/);
  });

  it('⚠️ 配了公钥但这份归档没签过 ⇒ 也放行 + WARN（历史归档不能变成新的锁死来源）', () => {
    const gate = assertArchiveSignatureForRestore({
      archivePath,
      actualSha256: sha256,
      verifyKey: resolveVerifyKey(dir, {}),
    });
    expect(gate.checked).toBe(false);
    expect(gate.warning).toMatch(/没有 .*\.sig|没有 \.sig/);
    expect(gate.warning).toMatch(/本次仍然放行/);
  });

  it('显式 skip=true 才跳过，且 WARN 说清跳过了什么（字符串 "1" 不算跳过）', () => {
    signArchiveDigest({ archivePath: archivePath, archiveSha256: sha256, archiveBytes: 2048, signingKey: key });
    const buf = fs.readFileSync(archivePath);
    buf[3] = buf[3] ^ 0x02;
    fs.writeFileSync(archivePath, buf);
    // ⚠️ 注意：调用方（controller）用 isTrue() 判过之后才传 boolean 进来；
    //    这里断言的是"本函数只认字面 true"，所以传字符串 'true'/'1' 都**不算**跳过。
    for (const notTrue of ['true', '1', 1 as any, undefined, false]) {
      expect(() =>
        assertArchiveSignatureForRestore({
          archivePath,
          actualSha256: 'deadbeef'.repeat(8),
          verifyKey: resolveVerifyKey(dir, {}),
          skip: notTrue as any,
        }),
      ).toThrow(BadRequestException);
    }
    const gate = assertArchiveSignatureForRestore({
      archivePath,
      actualSha256: 'deadbeef'.repeat(8),
      verifyKey: resolveVerifyKey(dir, {}),
      skip: true,
    });
    expect(gate.checked).toBe(false);
    expect(gate.warning).toMatch(/跳过签名校验/);
  });
});

describe('恢复闸门真的跑在解包之前（行为级，不是靠源码位置）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    generateSigningKeyPair(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 判据设计：拿一份**根本不是归档**的文件，先用它自己的哈希签一个合法 `.sig`，
   * 然后改掉文件内容（签名就失效了）。
   *  - 如果闸门在解包**之前** ⇒ 报的是"签名不匹配 / 拒绝恢复"；
   *  - 如果闸门在解包**之后**（或形同不存在）⇒ 先撞上"读不出归档成员表"。
   * 两种报错的文案完全不同，所以这一条能证明**顺序与效果**，而不只是"源码里有这段"。
   * ⚠️ 源码级的顺序断言（下面那个 describe）钉不住"闸门被短路"：把 `verifyKey` 写成 null
   *    之后位置关系一模一样，但功能已经没了 —— 那次变异对照就是这么发现守卫空转的。
   */
  it('签名验不过时，报的是签名错而不是"读不出成员表"（⇒ 闸门确实在解包之前）', async () => {
    const fake = writeArchive(dir, 'vanblog-full-20260920-020202.tar.zst', 'not an archive at all');
    const goodSha = (await hashFile(fake)).sha256;
    signArchiveDigest({
      archivePath: fake,
      archiveSha256: goodSha,
      archiveBytes: fs.statSync(fake).size,
      signingKey: resolveSigningKey(dir, {}),
    });
    fs.appendFileSync(fake, 'TAMPERED');
    const actual = (await hashFile(fake)).sha256;

    // 直接调闸门：必须抛签名相关的错
    expect(() =>
      assertArchiveSignatureForRestore({
        archivePath: fake,
        actualSha256: actual,
        verifyKey: resolveVerifyKey(dir, {}),
      }),
    ).toThrow(/拒绝恢复/);

    // 再走完整入口：`assertRestorableArchive` 必须**先**撞上签名闸门，
    // 而不是先去看成员表（那会报"读不出归档成员表"）。
    let message = '';
    try {
      await assertRestorableArchive(fake, { backupDir: dir });
    } catch (err) {
      message = String((err as Error)?.message || err);
    }
    expect(message).toMatch(/拒绝恢复|签名/);
    expect(message).not.toMatch(/读不出归档成员表/);
  });

  it('没有配验签公钥时，同一份坏归档会**继续**走到成员表检查（闸门不误伤既有部署）', async () => {
    const fake = writeArchive(dir, 'vanblog-full-20260920-030303.tar.zst', 'still not an archive');
    let message = '';
    try {
      // 不给 backupDir、进程环境里也没有验签钥 ⇒ 闸门放行，随后死在成员表那一步
      await assertRestorableArchive(fake, {});
    } catch (err) {
      message = String((err as Error)?.message || err);
    }
    expect(message).toMatch(/读不出归档成员表|成员/);
    expect(message).not.toMatch(/拒绝恢复：/);
  });
});

describe('接线（源码级，剥注释后断言，每条都带负向对照）', () => {
  const fullBackupSrc = stripCommentsForAnchor(
    readFileSync(resolvePath(__dirname, 'fullBackup.ts'), 'utf-8'),
  );
  const verifySrc = stripCommentsForAnchor(readFileSync(resolvePath(__dirname, 'backupVerify.ts'), 'utf-8'));
  const controllerSrc = stripCommentsForAnchor(
    readFileSync(resolvePath(__dirname, '../controller/admin/backup/backup.controller.ts'), 'utf-8'),
  );
  const providerSrc = stripCommentsForAnchor(
    readFileSync(resolvePath(__dirname, '../provider/backup/fullBackup.provider.ts'), 'utf-8'),
  );

  it('验签闸门排在**解包/成员表之前**（第 0 道），而不是事后补检', () => {
    const gate = fullBackupSrc.indexOf('assertArchiveSignatureForRestore({');
    const list = fullBackupSrc.indexOf('const { entries, decompressError } = await listArchiveEntries(archivePath');
    expect(gate).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(list);
    // 负向对照：这把尺子量"顺序反了"的形状必须不成立
    expect(list).not.toBeLessThan(gate);
  });

  it('签名只在"配了公钥或存在 .sig"时才多读一遍归档（不给既有部署增加恢复耗时）', () => {
    expect(fullBackupSrc).toMatch(/if \(fs\.existsSync\(sigPath\) \|\| verifyKey\) \{/);
    expect(fullBackupSrc).toMatch(/if \(fs\.existsSync\(sigPath\) && verifyKey && options\.skipSignatureCheck !== true\) \{/);
  });

  it('verifyFullBackup 的两条路径都调了 checkSignature（老归档那条也要验）', () => {
    const calls = verifySrc.match(/await checkSignature\(\);/g) ?? [];
    expect(calls.length).toBe(2);
    // 负向对照：只有一处时这把尺子必须能看出来
    expect(calls.length).not.toBe(1);
  });

  it('签名结果进了 verify 的返回值（不是算完就丢）', () => {
    expect(verifySrc).toMatch(/const signature = emptySignature\(\);/);
    expect(verifySrc).toMatch(/\n\s+signature,\n/);
    // emptySignature 的默认 state 必须是 no-key（"没验"），绝不能是 ok
    expect(verifySrc).toMatch(/state: 'no-key',/);
    expect(verifySrc).not.toMatch(/state: 'ok',\s*\n\s*ok: null/);
  });

  it('mismatch / key-mismatch / malformed 记成 issue；missing-sig / no-key 只记 note（老归档不能全线报红）', () => {
    expect(verifySrc).toMatch(/issues\.push\(\{ check: 'signature', message: r\.message \}\)/);
    expect(verifySrc).toMatch(/integrity\.notes\.push\(/);
    expect(verifySrc).toMatch(/if \(r\.state === 'ok'\) \{/);
  });

  it('控制器把 skipSignatureCheck 交给 isTrue（不是 checkTrue、不是裸 truthy）', () => {
    expect(controllerSrc).toMatch(/isTrue\(body\?\.skipSignatureCheck\)/);
    expect(controllerSrc).not.toMatch(/checkTrue\(body\?\.skipSignatureCheck\)/);
    expect(controllerSrc).not.toMatch(/skipSignatureCheck: body\?\.skipSignatureCheck,/);
    // 负向对照：证明上面两把"不许有"的尺子量得到坏形状（否则 doesNotMatch 恒真）
    expect('checkTrue(body?.skipSignatureCheck)').toMatch(/checkTrue\(body\?\.skipSignatureCheck\)/);
    expect('skipSignatureCheck: body?.skipSignatureCheck,').toMatch(/skipSignatureCheck: body\?\.skipSignatureCheck,/);
  });

  it('🔴 私钥不经任何接口返回：控制器里不出现 privateKeyPem，且两个端点都在 /api/admin/backup 下', () => {
    expect(controllerSrc).not.toContain('privateKeyPem');
    expect(controllerSrc).toMatch(/@Get\('signing\/key'\)/);
    expect(controllerSrc).toMatch(/@Post\('signing\/key'\)/);
    // 负向对照：把私钥塞进响应时这把尺子必须命中
    expect('data: { privateKeyPem: pem }').toContain('privateKeyPem');
  });

  it('恢复响应把签名降级提示带回给调用方（不只写进容器日志）', () => {
    expect(controllerSrc).toMatch(/signatureWarning: takeRestoreSignatureWarning\(\)/);
    expect(providerSrc).toMatch(/skipSignatureCheck === true/);
    expect(providerSrc).toMatch(/backupDir: this\.backupDir\(\),/);
  });

  it('删归档时连 .sig 一起删（否则留下孤儿签名，看着像"这里还有一份备份"）', () => {
    expect(controllerSrc).toMatch(/fs\.rmSync\(`\$\{archivePath\}\$\{BACKUP_SIG_EXT\}`, \{ force: true \}\)/);
    // 负向对照：这把尺子在"只删两个旧 sidecar"的旧形状上不成立
    const oldShape = "fs.rmSync(`${archivePath}.sha256`, { force: true });\n    return {";
    expect(oldShape).not.toMatch(/fs\.rmSync\(`\$\{archivePath\}\$\{BACKUP_SIG_EXT\}`/);
  });

  it('.sig 有专门的下载入口（拿不到签名，异地验签这条路就等于不存在）', () => {
    expect(controllerSrc).toMatch(/@Get\('full\/download-sig'\)/);
    // 私钥仍然不经任何接口返回（新端点也不能例外）
    expect(controllerSrc).not.toContain('privateKeyPem');
    // 负向对照：证明上面那把"不许有"的尺子量得到坏形状
    expect('data: { privateKeyPem: pem }').toContain('privateKeyPem');
  });

  /**
   * ⚠️ 这条必须是**行为级**的。
   *
   * 第一版我只断言"源码里出现 NotFoundException 与那句 404 文案"，变异对照把判定改成
   * `if (false)` 之后**一条都没红** —— 因为那些文本仍然在源码里。这就是本仓库反复踩的
   * "符号出现 ≠ 行为"：`if (false && …)` / `if (false)` 能骗过一切子串匹配。
   * 所以现在真构造 controller、真调那个方法、真断言它抛 404。
   */
  it('.sig 缺失时**真的**抛 404（不是返回空文件，空文件会被判成 malformed）', async () => {
    const dir = tmpDir();
    const archivePath = path.join(dir, 'vanblog-full-20260920-040404.tar.zst');
    fs.writeFileSync(archivePath, 'archive-bytes');
    // 13 个构造参数按位置喂；`downloadSignature` 只用到第 12 个（fullBackupProvider）
    const stubs: any[] = Array.from({ length: 11 }, () => ({} as any));
    stubs.push({ resolveArchive: () => archivePath } as any);
    stubs.push({} as any);
    const controller = new (require('../controller/admin/backup/backup.controller').BackupController)(...stubs);
    const res: any = { download: jest.fn() };
    await expect(controller.downloadSignature('whatever', res)).rejects.toBeInstanceOf(NotFoundException);
    let message = '';
    try {
      await controller.downloadSignature('whatever', res);
    } catch (err: any) {
      message = String(err?.message || err);
      // 必须是 404 语义，而不是 400/500
      expect(err?.status || err?.response?.statusCode || err?.getStatus?.()).toBe(404);
    }
    expect(message).toMatch(/没有 \.sig/);
    expect(message).toMatch(/早于签名功能|没有配签名密钥/);
    expect(res.download).not.toHaveBeenCalled();
    // 反证：`.sig` 存在时就走下载，而不是抛
    fs.writeFileSync(`${archivePath}${BACKUP_SIG_EXT}`, '{"magic":"x"}');
    const res2: any = { download: jest.fn() };
    await controller.downloadSignature('whatever', res2);
    expect(res2.download).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('备份成功后把签名状态写进 backup-status（未签名也要写 false，不能留 null 蒙混）', () => {
    // provider 负责把结果传下去；写进状态文件的动作在 backupStatus.ts（下面那条断言）
    expect(providerSrc).toMatch(/signed: result\.signed,/);
    expect(providerSrc).toMatch(/signing: result\.signed/);
    const statusSrc = stripCommentsForAnchor(
      readFileSync(resolvePath(__dirname, 'backupStatus.ts'), 'utf-8'),
    );
    expect(statusSrc).toMatch(/lastSuccessSigned: info\.signed \?\? null,/);
  });
});
