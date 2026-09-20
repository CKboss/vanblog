import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';

import { InitController, __resetInitRestoreLockForTest } from './init.controller';
import { clearSetupKey } from 'src/provider/init/setupKey';
import { BACKUP_SIG_MAGIC, signatureSidecarPath } from 'src/utils/backupSigning';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 匿名灾难恢复路径（`POST /api/admin/init/restore`）必须能**收到随归档上传的 `.sig`**。
 *
 * 🔴 为什么这条是必须的而不是锦上添花：这条路径就是"主机全毁、拿一份异地签名归档在新机器上
 *    重建站点"——也正是离线签名要保护的那个场景。而 `.sig` 是归档**旁边的另一个文件**，
 *    不随 multipart 上传进去 ⇒ 服务端在 upload-tmp 里找不到 sidecar ⇒ 状态只能是
 *    `missing-sig`，而按设计 `missing-sig` **只记 note、不算 issue** ⇒ 恢复照样成功，
 *    而且**没有人知道签名根本没被验**。也就是说签名功能在它最该起作用的那条路径上
 *    结构性地失效了。
 *
 * 同时钉住三条"不许变"的性质：
 *  - **可选**：不带这个字段时行为与以前逐字节一致（绝不让既有调用方失败）；
 *  - **匿名路径没有任何"跳过验签"的开关**（`skipSignatureCheck` 只存在于管理员接口）；
 *  - sidecar 落在 `signatureSidecarPath(归档路径)`，所以**既有的验签闸门一行都不用改**就能找到它。
 */

jest.mock('src/utils/fullBackup', () => {
  const actual = jest.requireActual('src/utils/fullBackup');
  return {
    ...actual,
    inspectFullBackup: jest.fn(),
    assertRestorableArchive: jest.fn(),
    takeRestoreSignatureWarning: jest.fn(),
  };
});
jest.mock('src/utils/publicMetaCache', () => {
  const actual = jest.requireActual('src/utils/publicMetaCache');
  return { ...actual, invalidatePublicMetaCache: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fullBackup = require('src/utils/fullBackup');
const mockedInspect = fullBackup.inspectFullBackup as jest.Mock;
const mockedAssert = fullBackup.assertRestorableArchive as jest.Mock;
const mockedWarning = fullBackup.takeRestoreSignatureWarning as jest.Mock;

const MANIFEST = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-20T01:02:03.000Z',
  databases: { vanBlog: { collections: { users: { count: 1 }, articles: { count: 2 } } } },
};

/** 一份**形状合法**的 .sig（密码学验签在闸门里，这里被 mock 掉了，所以不需要真密钥） */
function makeSigJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    magic: BACKUP_SIG_MAGIC,
    v: 1,
    alg: 'ed25519',
    digest: 'sha256',
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 4096,
    keyFingerprint: 'f'.repeat(16),
    signedAt: '2026-09-20T01:02:03.000Z',
    signature: 'x'.repeat(88),
    archiveName: 'vanblog-full-20260920-010203.tar.zst',
    ...over,
  });
}

let tmp: string;
let backupDirValue: string;

function makeController() {
  const initProvider: any = {
    checkHasInited: jest.fn(async () => false),
    init: jest.fn(async () => '初始化成功!'),
    invalidateInitCache: jest.fn(),
    recordInstallation: jest.fn(async () => undefined),
    assertSetupKeyAllowed: jest.fn(() => undefined),
  };
  const fullBackupProvider = {
    backupDir: () => backupDirValue,
    restore: jest.fn(async () => ({
      ms: 1500,
      databases: {},
      static: {},
      manifest: MANIFEST,
      notes: [],
      pruned: [],
    })),
  };
  const controller = new InitController(
    initProvider,
    { upload: jest.fn() } as any,
    { activeAll: jest.fn() } as any,
    fullBackupProvider as any,
    { init: jest.fn(async () => undefined) } as any,
    { restart: jest.fn(async () => undefined) } as any,
    { invalidateBase: jest.fn() } as any,
  );
  return { controller, initProvider, fullBackupProvider };
}

function makeRestoreFile() {
  const p = path.join(tmp, `upload-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'not-really-an-archive');
  return { path: p, originalname: 'vanblog-full-20260920-010203.tar.zst', size: 21 } as any;
}

const fakeReq = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-init-sig-'));
  backupDirValue = path.join(tmp, 'backups');
  __resetInitRestoreLockForTest();
  clearSetupKey(tmp);
  mockedInspect.mockReset();
  mockedAssert.mockReset();
  mockedWarning.mockReset();
  mockedInspect.mockResolvedValue(MANIFEST);
  mockedAssert.mockResolvedValue(9);
  mockedWarning.mockReturnValue(null);
});

afterEach(() => {
  __resetInitRestoreLockForTest();
  clearSetupKey(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('匿名恢复收 .sig', () => {
  // ⚠️ 观测点必须在**闸门执行期间**：成功路径的 finally 会把 sidecar 和归档一起删掉，
  //    所以在 `restoreFromInitPage` 返回之后再断言"文件存在"必然是 false（我第一版就这么写错了）。
  //    从 mock 的 assertRestorableArchive 里抓，才既证明"写盘了"又证明"闸门跑之前就已经在位"。
  function captureDuringGate() {
    const seen: { exists: boolean; content: string | null; mode: number | null } = {
      exists: false,
      content: null,
      mode: null,
    };
    mockedAssert.mockImplementation(async (archivePath: string) => {
      const sidecar = signatureSidecarPath(archivePath);
      seen.exists = fs.existsSync(sidecar);
      if (seen.exists) {
        seen.content = fs.readFileSync(sidecar, 'utf-8');
        seen.mode = fs.statSync(sidecar).mode & 0o777;
      }
      return 9;
    });
    return seen;
  }

  it('带合法 signature 字段 ⇒ 闸门跑之前 sidecar 已在 signatureSidecarPath(归档) 且字节逐字相同', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    const sig = makeSigJson();
    const seen = captureDuringGate();

    await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, sig);

    expect(seen.exists).toBe(true);
    // 原样落盘：验的就是站长交上来的那份字节，不重新序列化
    expect(seen.content).toBe(sig);
    // 0600：这份 sidecar 含整档 sha256 与公钥指纹，不该让同机其它用户读
    expect(seen.mode).toBe(0o600);
    // 收尾仍然要清干净
    expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
  });

  it('sidecar 的位置就是既有闸门的约定位置（所以闸门不用改就能找到它）', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    const seen = captureDuringGate();
    await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, makeSigJson());
    // 约定 = "归档路径 + .sig"，这正是 utils/backupSigning.ts 的 signatureSidecarPath 的定义
    expect(signatureSidecarPath(file.path)).toBe(`${file.path}.sig`);
    // 而闸门被调用时它已经在位 ⇒ 既有的 assertArchiveSignatureForRestore 一行都不用改
    expect(seen.exists).toBe(true);
    expect(mockedAssert).toHaveBeenCalledWith(file.path, expect.objectContaining({}));
  });

  it('不带 signature ⇒ 一个字节都不写，恢复照常成功（既有行为逐字节不变）', async () => {
    mockedAssert.mockImplementation(async () => 9); // 复原上一条用例换掉的实现
    const { controller } = makeController();
    const file = makeRestoreFile();
    const res: any = await controller.restoreFromInitPage(file, undefined, fakeReq());
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
    // upload-tmp 里也不该多出任何 .sig
    expect(
      fs.readdirSync(tmp).filter((n) => n.endsWith('.sig')),
    ).toEqual([]);
  });

  it('空串/纯空白 ⇒ 与不带一样（不当成"上传了一份空签名"）', async () => {
    const { controller } = makeController();
    for (const value of ['', '   ', '\n']) {
      const file = makeRestoreFile();
      const res: any = await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, value);
      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
    }
  });

  it('🔴 超过 8KB ⇒ 400，且不写盘（不能变成新的匿名上传放大面）', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    const huge = makeSigJson({ padding: 'z'.repeat(9 * 1024) });
    await expect(
      controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, huge),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
  });

  it('不是 JSON / magic 不对 ⇒ 400 且**不写 sidecar**，文案指路"没有 .sig 就别带这个字段"', async () => {
    const { controller } = makeController();
    for (const bad of ['not-json-at-all', '{"magic":"SOMETHINGELSE"}', '[1,2,3]', 'null']) {
      const file = makeRestoreFile();
      let err: any = null;
      try {
        await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(String(err?.message)).toContain('.sig');
      expect(String(err?.message)).toContain('不要');
      expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
    }
  });

  it('成功恢复后 sidecar 被删掉（不能留在 upload-tmp 里当下一次的旧签名）', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    const sidecar = signatureSidecarPath(file.path);
    await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, makeSigJson());
    expect(fs.existsSync(sidecar)).toBe(false);
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('闸门抛错时 sidecar 也被删掉（失败路径不残留）', async () => {
    mockedAssert.mockRejectedValue(new BadRequestException('体积超限'));
    const { controller } = makeController();
    const file = makeRestoreFile();
    const sidecar = signatureSidecarPath(file.path);
    await expect(
      controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, makeSigJson()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it('🔴 验签闸门拿到 backupDir（否则 API 生成的公钥在灾难恢复路径上永远找不到）', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    await controller.restoreFromInitPage(file, undefined, fakeReq(), undefined, makeSigJson());
    expect(mockedAssert).toHaveBeenCalledWith(file.path, {
      passphrase: null,
      backupDir: backupDirValue,
    });
  });

  it('响应体带 signatureWarning，且值来自 takeRestoreSignatureWarning()（不是硬编码）', async () => {
    const warning = '这份归档有 .sig 但本机没配验签公钥：恢复已放行，但**没有**证明它没被换过';
    mockedWarning.mockReturnValue(warning);
    const { controller } = makeController();
    const res: any = await controller.restoreFromInitPage(
      makeRestoreFile(),
      undefined,
      fakeReq(),
      undefined,
      makeSigJson(),
    );
    expect(res.data.signatureWarning).toBe(warning);
    expect(mockedWarning).toHaveBeenCalled();
  });

  it('没有降级结论时 signatureWarning 是 null（不是 undefined，也不是空串）', async () => {
    mockedWarning.mockReturnValue(null);
    const { controller } = makeController();
    const res: any = await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    expect(Object.prototype.hasOwnProperty.call(res.data, 'signatureWarning')).toBe(true);
    expect(res.data.signatureWarning).toBeNull();
  });

  it('参数表顺序：signature 在**最后**，既有按位置调用 (file, setupKey, req, passphrase) 不被打破', async () => {
    const { controller } = makeController();
    const file = makeRestoreFile();
    const passphrase = 'a-passphrase-from-the-body';
    await controller.restoreFromInitPage(file, undefined, fakeReq(), passphrase);
    // 口令落在 passphrase 位（没有被当成 signature 写盘）
    expect(mockedAssert).toHaveBeenCalledWith(file.path, {
      passphrase,
      backupDir: backupDirValue,
    });
    expect(fs.existsSync(signatureSidecarPath(file.path))).toBe(false);
  });
});

describe('匿名路径不许有"跳过验签"的开关', () => {
  const src = stripCommentsForAnchor(
    fs.readFileSync(path.join(__dirname, 'init.controller.ts'), 'utf-8'),
  );

  it('init.controller.ts 里不出现 skipSignatureCheck（剥注释后）', () => {
    expect(src).not.toContain('skipSignatureCheck');
  });

  it('尺子有效性反证：这把尺子量得到坏形状，且"剥注释"真的在工作', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'init.controller.ts'), 'utf-8');
    // 负向对照：如果有人在匿名路径上加了跳过开关，上面那条必须红
    expect(
      stripCommentsForAnchor(`${raw}\nconst x = { skipSignatureCheck: true };\n`),
    ).toContain('skipSignatureCheck');
    // 剥注释器在工作：原文里有 `//` 注释，剥完不该有整行注释
    expect(raw).toMatch(/^\s*\/\//m);
    expect(src).not.toMatch(/^\s*\/\//m);
    // 且这把尺子确实量到了东西（不是空文件）
    expect(src).toContain('restoreFromInitPage');
  });

  it('对照：管理员接口**可以**有这个开关（说明这条禁令是针对匿名路径的，不是全局的）', () => {
    const backupSrc = stripCommentsForAnchor(
      fs.readFileSync(
        path.join(__dirname, '..', 'backup', 'backup.controller.ts'),
        'utf-8',
      ),
    );
    expect(backupSrc).toContain('skipSignatureCheck');
  });
});
