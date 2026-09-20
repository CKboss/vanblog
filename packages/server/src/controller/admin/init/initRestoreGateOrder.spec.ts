import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';

import { InitController, __resetInitRestoreLockForTest } from './init.controller';
import { clearSetupKey } from 'src/provider/init/setupKey';
import { BACKUP_SIG_MAGIC, generateSigningKeyPair } from 'src/utils/backupSigning';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 🔴 恢复路径上的**闸门顺序**，以及"清单读不出"这条拒绝必须留痕、必须能区分三种情况。
 *
 * 为什么要有这个文件：修复前匿名恢复的顺序是
 *   文件名形状 → `inspectFullBackup`（解出 ./manifest.json）→ `assertRestorableArchive`
 *   （签名 → 成员上限 → 体积 → 剩余空间）→ 解包
 * 于是两条**都被活体实测确认过**的后果：
 *  ① 被篡改的归档（翻中段一个字节就破坏 zstd 流）**先**撞上"读不出这个备份的清单：
 *     文件损坏/不完整"⇒ 站长看到的是"这份副本坏了"，而真相可能是"这份被人换过"。
 *     敌意环境下这两种结论的处置**完全不同**（排查入侵 vs 重传副本）。
 *  ② 不含 manifest 的**成员炸弹**（实测 318,857 字节 / 10 万个空文件）也被清单检查先拦下
 *     ⇒ 成员上限与签名闸门**根本执行不到**，应用日志里 `member-cap` **0 命中**
 *     ⇒ 这类**匿名**放大尝试毫无痕迹（只有 caddy 访问日志能看到一个 400）。
 *
 * ⚠️ 而修复前**没有任何测试钉住这个顺序**：21 个套件 / 355 条用例在错误的顺序下全绿。
 *    这正是"闸门顺序"这类性质的典型盲区 —— 每条闸门各自都有测试，**它们之间的先后**没有。
 *
 * 判据的核心是一条**同时满足两种失败条件**的归档：既缺清单、又超成员上限（或验签不过）。
 * 报出来的是哪一条，就是顺序的行为级证据 —— 比"源码里 A 出现在 B 之前"强得多，
 * 因为源码级断言在"两处都还在、只是运行时走不到"的情况下照样绿。
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
// ⚠️ 只把 `recordRestoreRejection` 换成 spy：节流/升级/打码那些真实现由
//    restoreSecurityLog.spec.ts 负责，这里要观测的是"控制器有没有调它、传的类别对不对"。
jest.mock('src/utils/restoreSecurityLog', () => {
  const actual = jest.requireActual('src/utils/restoreSecurityLog');
  return { ...actual, recordRestoreRejection: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fullBackup = require('src/utils/fullBackup');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const secLog = require('src/utils/restoreSecurityLog');
const mockedInspect = fullBackup.inspectFullBackup as jest.Mock;
const mockedAssert = fullBackup.assertRestorableArchive as jest.Mock;
const mockedWarning = fullBackup.takeRestoreSignatureWarning as jest.Mock;
const mockedReject = secLog.recordRestoreRejection as jest.Mock;

const MANIFEST = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-21T01:02:03.000Z',
  databases: { vanBlog: { collections: { users: { count: 1 } } } },
};

/** 活体实测里那两条拒绝的文案形状（用来断言"报的是哪一条"） */
const MEMBER_CAP_MSG =
  '备份归档的成员条数超过上限（已数到 50001 个仍未结束，允许 50000 个），已中止读取并拒绝恢复' +
  '（没有解包、没有写盘）。这通常说明它不是本功能导出的整站备份，或是一个用海量小成员做放大的归档。';
const SIG_MISMATCH_MSG =
  '拒绝恢复：🔴 vanblog-full-20260921-010203.tar.zst 签名**不匹配**（密钥指纹对得上，但签名验不过）。' +
  '这说明归档或 .sig 文件在签名之后**被改动过**';
const MANIFEST_MSG_RE = /读不出这个备份的清单/;

/** 一份**形状合法**的 .sig（密码学验签在被 mock 的闸门里，所以不需要真签名） */
function makeSigJson() {
  return JSON.stringify({
    magic: BACKUP_SIG_MAGIC,
    v: 1,
    alg: 'ed25519',
    digest: 'sha256',
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 4096,
    keyFingerprint: 'f'.repeat(16),
    signedAt: '2026-09-21T01:02:03.000Z',
    signature: 'x'.repeat(88),
    archiveName: 'vanblog-full-20260921-010203.tar.zst',
  });
}

let tmp: string;
let backupDirValue: string;
/** 两道闸门被调用的先后（本文件的核心观测量） */
let order: string[];

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
  return { path: p, originalname: 'vanblog-full-20260921-010203.tar.zst', size: 21 } as any;
}

const fakeReq = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-gate-order-'));
  backupDirValue = path.join(tmp, 'backups');
  fs.mkdirSync(backupDirValue, { recursive: true });
  order = [];
  __resetInitRestoreLockForTest();
  clearSetupKey(tmp);
  mockedInspect.mockReset();
  mockedAssert.mockReset();
  mockedWarning.mockReset();
  mockedReject.mockReset();
  mockedWarning.mockReturnValue(null);
  // 默认：两道闸门都"通过"，单条用例再按需换实现
  mockedInspect.mockImplementation(async () => {
    order.push('inspect');
    return MANIFEST;
  });
  mockedAssert.mockImplementation(async () => {
    order.push('assert');
    return 226;
  });
  // ⚠️ 环境变量必须清干净：`resolveVerifyKey` 先看 env，留着上一轮的公钥会让
  //    "没有公钥"那条用例变成"有公钥"，于是三种文案里只测到两种（而且是静默的）。
  delete process.env.VANBLOG_BACKUP_VERIFY_KEY;
  delete process.env.VANBLOG_BACKUP_VERIFY_KEY_FILE;
  delete process.env.VANBLOG_BACKUP_SIGNING_KEY;
  delete process.env.VANBLOG_BACKUP_SIGNING_KEY_FILE;
});

afterEach(() => {
  __resetInitRestoreLockForTest();
  clearSetupKey(tmp);
  delete process.env.VANBLOG_BACKUP_VERIFY_KEY;
  delete process.env.VANBLOG_BACKUP_VERIFY_KEY_FILE;
  delete process.env.VANBLOG_BACKUP_SIGNING_KEY;
  delete process.env.VANBLOG_BACKUP_SIGNING_KEY_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('匿名恢复：便宜且不依赖内容正确性的闸门必须排在清单解析之前', () => {
  it('🔴 归档同时"缺清单"与"超成员上限"⇒ 报的是**成员上限**，而且清单解析根本没跑', async () => {
    mockedAssert.mockImplementation(async () => {
      order.push('assert');
      throw new BadRequestException(MEMBER_CAP_MSG);
    });
    mockedInspect.mockImplementation(async () => {
      order.push('inspect');
      return null; // 这份归档也读不出清单 ⇒ 两种失败条件同时成立
    });
    const { controller } = makeController();
    let err: any = null;
    try {
      await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err?.message)).toContain('成员条数超过上限');
    // ⚠️ 本体断言：报的**不是**清单那条（顺序反了的话这里就是"读不出这个备份的清单"）
    expect(String(err?.message)).not.toMatch(MANIFEST_MSG_RE);
    // 顺序的行为级证据：清单解析压根没被调用（它在成员上限之后，而后者已经抛了）
    expect(order).toEqual(['assert']);
  });

  it('🔴 归档同时"缺清单"与"验签不过"⇒ 报的是**签名不匹配**（篡改不再被误报成"文件损坏"）', async () => {
    mockedAssert.mockImplementation(async () => {
      order.push('assert');
      throw new BadRequestException(SIG_MISMATCH_MSG);
    });
    mockedInspect.mockImplementation(async () => {
      order.push('inspect');
      return null;
    });
    const { controller } = makeController();
    let err: any = null;
    try {
      // 带 .sig，这样"验签不过"才是这份归档真实会遇到的形状
      await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq(), undefined, makeSigJson());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err?.message)).toContain('签名**不匹配**');
    expect(String(err?.message)).toContain('被改动过');
    expect(String(err?.message)).not.toMatch(MANIFEST_MSG_RE);
    expect(order).toEqual(['assert']);
  });

  it('两道闸门都过了、只是清单读不出 ⇒ 才轮到清单那条文案，且顺序是 assert → inspect', async () => {
    mockedInspect.mockImplementation(async () => {
      order.push('inspect');
      return null;
    });
    const { controller } = makeController();
    await expect(
      controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq()),
    ).rejects.toThrow(MANIFEST_MSG_RE);
    expect(order).toEqual(['assert', 'inspect']);
  });

  it('控制器仍然把 backupDir 传给闸门（否则 API 生成的公钥永远解析不到）', async () => {
    const { controller } = makeController();
    await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    expect(mockedAssert).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ backupDir: backupDirValue }),
    );
    // 负向对照：这把尺子必须能看出"没传 backupDir"
    expect(mockedAssert).not.toHaveBeenCalledWith(expect.any(String), { passphrase: null });
  });
});

describe('匿名恢复：清单读不出必须留痕，且三种情况的文案必须可区分', () => {
  /** 跑一次"闸门通过 + 清单为 null"，返回抛出的文案与 recordRestoreRejection 的实参 */
  async function runManifestFailure(signature?: string) {
    mockedInspect.mockImplementation(async () => {
      order.push('inspect');
      return null;
    });
    const { controller } = makeController();
    let err: any = null;
    try {
      await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq(), undefined, signature);
    } catch (e) {
      err = e;
    }
    return { message: String(err?.message ?? ''), calls: mockedReject.mock.calls };
  }

  it('没有 .sig ⇒ 沿用"文件损坏/不完整"，并指路"想确定是否被换过就配签名"', async () => {
    const { message, calls } = await runManifestFailure(undefined);
    expect(message).toMatch(MANIFEST_MSG_RE);
    expect(message).toContain('signing-key');
    expect(message).not.toContain('验签通过');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('not-our-archive');
    expect(String(calls[0][1])).toContain('没有 .sig');
  });

  it('有 .sig 但本机没有验签公钥 ⇒ 明说"无法判断是篡改还是损坏"，并给出配置办法', async () => {
    const { message, calls } = await runManifestFailure(makeSigJson());
    expect(message).toMatch(MANIFEST_MSG_RE);
    expect(message).toContain('带有 .sig');
    expect(message).toContain('无法判断');
    expect(message).toContain('VANBLOG_BACKUP_VERIFY_KEY');
    expect(message).not.toContain('验签通过');
    expect(calls[0][0]).toBe('not-our-archive');
    expect(String(calls[0][1])).toContain('无法区分');
  });

  it('🔴 有 .sig 且有公钥（⇒ 签名闸门刚刚放行过）⇒ 给出**确定的**"没被篡改"结论', async () => {
    // 用服务端自己的实现造一对真密钥（不是手搓 PEM）：这样 resolveVerifyKey 走的是
    // 生产里同一条"从 <backupDir>/signing/ 读公钥"的分支。
    generateSigningKeyPair(backupDirValue, {});
    const { message, calls } = await runManifestFailure(makeSigJson());
    expect(message).toContain('验签通过');
    expect(message).toContain('没有被人改过');
    expect(message).toContain('不是本功能导出的整站备份');
    // ⚠️ 这一支**不该**再吓人地说"可能损坏/可能被篡改"
    expect(message).not.toContain('无法判断');
    expect(calls[0][0]).toBe('not-our-archive');
    expect(String(calls[0][1])).toContain('签名验过');
  });

  it('三种文案必须两两不同（否则"区分三种情况"这个目的就没达成）', async () => {
    generateSigningKeyPair(backupDirValue, {});
    const withKeyAndSig = (await runManifestFailure(makeSigJson())).message;
    // 换成"有 .sig 但没公钥"：把生成的密钥挪走
    const signingDir = path.join(backupDirValue, 'signing');
    const stash = path.join(tmp, 'stash-signing');
    fs.renameSync(signingDir, stash);
    const sigOnly = (await runManifestFailure(makeSigJson())).message;
    const noSig = (await runManifestFailure(undefined)).message;
    fs.renameSync(stash, signingDir);

    expect(withKeyAndSig).not.toBe(sigOnly);
    expect(sigOnly).not.toBe(noSig);
    expect(withKeyAndSig).not.toBe(noSig);
  });

  it('⚠️ 替身自检：resolveVerifyKey 真的能区分"有公钥/没公钥"（否则上面三条是同一支）', () => {
    // 这条防的是"三种文案其实走了同一个分支、只是断言写得松"。
    // 判据直接取自生产函数：没生成密钥时必须是 null，生成之后必须非 null。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveVerifyKey } = require('src/utils/backupSigning');
    expect(resolveVerifyKey(backupDirValue)).toBeNull();
    generateSigningKeyPair(backupDirValue, {});
    expect(resolveVerifyKey(backupDirValue)).not.toBeNull();
  });
});

describe('接线（源码级，剥注释后断言，每条都带负向对照）', () => {
  const controllerSrc = stripCommentsForAnchor(
    fs.readFileSync(path.resolve(__dirname, 'init.controller.ts'), 'utf-8'),
  );
  // ⚠️ 两个控制器别搞混：`isTrue(body?.skipSignatureCheck)` 与 confirm 闸门在**管理员**那个
  //    （controller/admin/backup/backup.controller.ts），匿名那个（本目录）**刻意没有**跳过开关。
  //    我第一版就是在这里用错了文件，于是断言在 import 文本上失败。
  const adminSrc = stripCommentsForAnchor(
    fs.readFileSync(
      path.resolve(__dirname, '../../../controller/admin/backup/backup.controller.ts'),
      'utf-8',
    ),
  );
  const fullBackupSrc = stripCommentsForAnchor(
    fs.readFileSync(path.resolve(__dirname, '../../../utils/fullBackup.ts'), 'utf-8'),
  );
  const providerSrc = stripCommentsForAnchor(
    fs.readFileSync(
      path.resolve(__dirname, '../../../provider/backup/fullBackup.provider.ts'),
      'utf-8',
    ),
  );

  it('控制器里 assertRestorableArchive 的位置在 inspectFullBackup **之前**', () => {
    const assertAt = controllerSrc.indexOf('await assertRestorableArchive(uploadedPath');
    const inspectAt = controllerSrc.indexOf('await inspectFullBackup(uploadedPath');
    // 尺子有效性：两个锚点都必须找到（-1 会让"小于"恒真）
    expect(assertAt).toBeGreaterThan(-1);
    expect(inspectAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(inspectAt);
    // 负向对照：反过来的形状必须不成立
    expect(inspectAt).not.toBeLessThan(assertAt);
  });

  it('⚠️ 尺子有效性反证：同一把"位置比较"尺子必须能把**反过来的顺序**判成不合规', () => {
    // 上面那条顺序断言用的是 `indexOf(a) < indexOf(b)`。这种尺子的失效方式是"锚点找不到 ⇒ -1"，
    // 所以除了断言两个锚点都 > -1，还要证明它对**反过来的合成源码**会给出相反的结论。
    // ⚠️ 用合成源码而不是真去改控制器：真改会把工作树弄脏，而合成源码同样能证明尺子有方向性。
    const ruler = (src: string) => {
      const assertAt = src.indexOf('await assertRestorableArchive(uploadedPath');
      const inspectAt = src.indexOf('await inspectFullBackup(uploadedPath');
      if (assertAt < 0 || inspectAt < 0) return 'anchor-missing';
      return assertAt < inspectAt ? 'gates-first' : 'manifest-first';
    };
    const fixed = 'x await assertRestorableArchive(uploadedPath y await inspectFullBackup(uploadedPath';
    const broken = 'x await inspectFullBackup(uploadedPath y await assertRestorableArchive(uploadedPath';
    expect(ruler(fixed)).toBe('gates-first');
    expect(ruler(broken)).toBe('manifest-first');
    expect(ruler('nothing here')).toBe('anchor-missing');
    // 而真实的控制器必须落在"闸门在前"这一侧
    expect(ruler(controllerSrc)).toBe('gates-first');
  });

  it('🔴 restoreFullBackup 内层那次闸门调用**透传** backupDir 与 skipSignatureCheck', () => {
    // 按括号配平取出那一次调用的实参列表，判据是"这个调用的实参里有这两个键"，
    // 而不是"文件里出现过 backupDir"（后者在类型定义与注释里都出现，恒真）。
    const marker = 'const memberCount = await assertRestorableArchive(archivePath, {';
    const at = fullBackupSrc.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const open = fullBackupSrc.indexOf('{', at + marker.length - 1);
    let depth = 0;
    let end = -1;
    for (let i = open; i < fullBackupSrc.length; i += 1) {
      if (fullBackupSrc[i] === '{') depth += 1;
      else if (fullBackupSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(open);
    const args = fullBackupSrc.slice(open, end + 1);
    expect(args).toContain('backupDir: options.backupDir');
    expect(args).toContain('skipSignatureCheck: options.skipSignatureCheck');
    // 负向对照：这把尺子量得到"少一个键"的形状
    expect(args.replace('backupDir: options.backupDir', '')).not.toContain('backupDir: options.backupDir');
    expect(args).not.toContain('backupDir: undefined');
  });

  it('🔴 skipSignatureCheck 的整条链路没有断点（controller → provider → restoreFullBackup → 闸门）', () => {
    // 这条防的正是本次修的缺陷形状：管线每一跳都"看起来实现了"，却在最后一跳被丢掉，
    // 于是文档与脚本承诺的逃生口其实不起作用，而单元测试各自为政谁也发现不了。
    expect(adminSrc).toMatch(/isTrue\(body\?\.skipSignatureCheck\)/);
    const providerAt = providerSrc.indexOf('async restore(');
    expect(providerAt).toBeGreaterThan(-1);
    expect(providerSrc.slice(providerAt, providerAt + 1400)).toContain('skipSignatureCheck');
    // restoreFullBackup 的调用处必须把它交给内层闸门
    const callAt = providerSrc.indexOf('await restoreFullBackup({');
    expect(callAt).toBeGreaterThan(-1);
    expect(providerSrc.slice(callAt, callAt + 1200)).toMatch(/skipSignatureCheck,/);
    expect(providerSrc.slice(callAt, callAt + 1200)).toMatch(/backupDir: this\.backupDir\(\)/);
  });

  it('匿名路径仍然没有"跳过验签"的开关（这条不许因为调序而被顺手加上）', () => {
    expect(controllerSrc).not.toContain('skipSignatureCheck');
    // 正向对照：管理员那条**必须**有它 ⇒ 证明上面这条禁令是针对匿名路径而不是全局的
    expect(adminSrc).toContain('skipSignatureCheck');
  });

  it('清单失败那一支确实调了 recordRestoreRejection，类别是既有的 not-our-archive', () => {
    const at = controllerSrc.indexOf("recordRestoreRejection(\n          'not-our-archive',");
    const atFlat = controllerSrc.indexOf("recordRestoreRejection('not-our-archive'");
    expect(Math.max(at, atFlat)).toBeGreaterThan(-1);
    // ⚠️ 不许新造类别：restoreSecurityLog 的类别清单是有级别映射与守卫的，
    //    多一个没人配级别的类别会让"每类都有级别"那条守卫失去意义。
    expect(controllerSrc).not.toContain("'manifest-unreadable'");
  });
});
