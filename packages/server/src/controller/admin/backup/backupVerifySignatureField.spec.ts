import { BackupController } from './backup.controller';
import { emptySignature } from 'src/utils/backupVerify';

/**
 * `POST /api/admin/backup/full/verify` 的响应体**必须带上签名（真实性）校验的结论**。
 *
 * 为什么值得单独一个文件钉住：`signature` 早就在 `BackupVerifyResult` 里被算出来了
 * （`utils/backupVerify.ts`），但控制器的响应体是**手挑字段**拼的，它被漏掉了 ——
 * 于是任何客户端（`vanblog.sh verify`、后台 UI）都拿不到"已签且验过 / 已签但本机没公钥 /
 * 从没签过 / .sig 形状不对 / 验不过"这个**权威五态**，只能自己去盘上看有没有 `.sig`。
 * 而"盘上有 .sig"与"这份归档被证明没被换过"是两件完全不同的事。
 *
 * ⚠️ 用 `Object.create` 而不是 `new`：这个控制器有 13 个构造参数（本轮 JWT 轮换刚追加了
 *    第 13 个 `JwtService`），本仓库既有做法就是绕过构造器（见
 *    `provider/cache/restoreKeyVerification.spec.ts`）。
 */

function makeController(verifyArchive: jest.Mock) {
  const controller: any = Object.create(BackupController.prototype);
  controller.fullBackupProvider = { verifyArchive };
  return controller;
}

/** 一个形状完整的校验结果；`signature` 用一个**带哨兵字段**的对象，用来证明是透传而不是硬编码 */
function makeResult(signature: any) {
  return {
    ok: true,
    ms: 1234,
    archiveBytes: 4096,
    members: 7,
    format: 'tar.zst',
    checks: {
      readThrough: true,
      manifestFromArchive: true,
      sidecarMatches: true,
      countsConsistent: true,
      staticConsistent: true,
      countsNonZero: true,
    },
    integrity: { available: false },
    signature,
    issues: [],
  };
}

describe('full/verify 的响应必须带 signature（真实性）结论', () => {
  it('provider 算出的 signature 被**原样透传**（同一个对象引用，不是硬编码也不是复制品）', async () => {
    const sentinel = {
      checked: true,
      state: 'ok',
      ok: true,
      sigPresent: true,
      keyConfigured: true,
      sigFingerprint: 'abc123',
      expectedFingerprint: 'abc123',
      message: '签名验证通过',
      __sentinel: 'this-object-must-come-from-the-provider',
    };
    const verifyArchive = jest.fn(async () => makeResult(sentinel) as any);
    const res: any = await makeController(verifyArchive).verifyFull({ name: 'a.tar.zst' });

    // 本体：响应里有这个键，且**就是** provider 给的那个对象
    expect(Object.prototype.hasOwnProperty.call(res.data, 'signature')).toBe(true);
    expect(res.data.signature).toBe(sentinel);
    expect(res.data.signature.__sentinel).toBe('this-object-must-come-from-the-provider');
    // 既有字段一个都不能少（纯追加，不是替换）
    for (const key of [
      'name',
      'ok',
      'deep',
      'seconds',
      'bytes',
      'members',
      'format',
      'checks',
      'integrity',
      'issues',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(res.data, key)).toBe(true);
    }
  });

  it('验不过的结论也照原样回去（不能被"美化"成 ok）', async () => {
    const mismatch = {
      ...emptySignature(),
      checked: true,
      state: 'mismatch',
      ok: false,
      sigPresent: true,
      message: '签名不匹配：归档或 .sig 在签名之后被改动过',
    };
    const res: any = await makeController(jest.fn(async () => makeResult(mismatch) as any)).verifyFull({
      name: 'a.tar.zst',
    });
    expect(res.data.signature.state).toBe('mismatch');
    expect(res.data.signature.ok).toBe(false);
  });

  it('🔴 provider 万一没给 signature 时，兜底是"**没验**"的形状，绝不能被读成"没签过"', async () => {
    const broken = makeResult(undefined) as any;
    delete broken.signature;
    const res: any = await makeController(jest.fn(async () => broken)).verifyFull({ name: 'a.tar.zst' });

    expect(res.data.signature).toBeTruthy();
    // 本仓库为 lastSuccessSigned 确立过 **null ≠ false** 的规矩，这里同理：
    // "这一轮没有验签结论" 必须是 ok:null / checked:false，而不是 ok:false 或 state:'missing-sig'
    expect(res.data.signature.ok).toBeNull();
    expect(res.data.signature.checked).toBe(false);
    expect(res.data.signature.state).not.toBe('missing-sig');
    expect(res.data.signature.state).toBe('no-key');
  });

  it('尺子有效性反证：如果响应里根本没有 signature 键，上面第一条断言必须失败', () => {
    const payload: any = { name: 'a', ok: true };
    expect(Object.prototype.hasOwnProperty.call(payload, 'signature')).toBe(false);
    // 且"透传"不能靠 toBeTruthy 蒙混：一个形状相似但不同源的对象必须被判为不相等
    const a = { state: 'ok', __sentinel: 'A' };
    const b = { state: 'ok', __sentinel: 'B' };
    expect(a).not.toBe(b);
  });
});
