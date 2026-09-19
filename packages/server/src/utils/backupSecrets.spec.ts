import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObjectId } from 'mongodb';
import {
  BACKUP_STALE_WORK_HOURS_ENV,
  DEFAULT_BACKUP_STALE_WORK_HOURS,
  STALE_UPLOAD_PREFIXES,
  STALE_WORK_DIR_PREFIXES,
  cleanupStaleWorkDirs,
  createFullBackup,
  resolveStaleWorkHours,
} from './fullBackup';
import { BACKUP_STATUS_FILE, emptyBackupStatus, writeBackupStatus } from './backupStatus';
import { writeSha256Sidecar } from './backupIntegrity';
import { RotatingFileStream } from './logRotate';
import {
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  ensureSecretDir,
  modeOf,
  tightenDirMode,
  writeSecretFileSync,
} from './secretFileMode';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 备份路径上的两件事：**机密文件的权限**，与**写盘失败时不许永久挂住**。
 *
 * 为什么值得单独一份 spec：这两个缺陷都属于"测试全绿、生产才炸"的形状 ——
 * 权限位没有任何断言看着，而挂死只发生在磁盘写满/数据卷消失的那一刻。
 * 所以这里既有源码级锚点（防止有人把 `mode` 删掉），也有**行为级**断言
 * （真写一个文件到临时目录，再 `statSync(...).mode & 0o777` 量出来）。
 *
 * 每条都注明了负控：把对应修复撤掉，哪一条会红。
 */

jest.setTimeout(120000);

// root 无视权限位，那几条断言就不成立（与 fullBackup.hardening.spec.ts 同款判断）
const canChmod = process.getuid?.() !== 0;

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 最小假 Mongo：只实现导出路径真正调到的那几个方法。 */
function fakeClient(dbs: Record<string, string[]>, docsOf: (name: string) => any[]) {
  return {
    db: (name: string) => ({
      collections: async () => (dbs[name] || []).map((n) => ({ collectionName: n })),
      collection: (n: string) => ({
        find: () => ({
          [Symbol.asyncIterator]: async function* iter() {
            for (const doc of docsOf(n)) {
              yield doc;
            }
          },
          close: async () => undefined,
        }),
        indexes: async () => [{ name: '_id_', key: { _id: 1 } }, { name: 'x', key: { x: 1 } }],
      }),
    }),
  } as any;
}

const DOC = { _id: new ObjectId(), title: '文章', body: 'x'.repeat(64) };

interface Site {
  root: string;
  staticPath: string;
  outDir: string;
  workDir: string;
}

function makeSite(): Site {
  const root = tmpRoot('vanblog-secrets-');
  const staticPath = path.join(root, 'static');
  const outDir = path.join(root, 'backups');
  const workDir = path.join(root, 'work');
  for (const dir of [staticPath, outDir, workDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { root, staticPath, outDir, workDir };
}

async function exportOnce(site: Site, extra: any = {}) {
  const client = fakeClient({ vanBlog: ['articles'], waline: ['Comment'] }, () => [DOC]);
  return createFullBackup({
    client,
    staticPath: site.staticPath,
    dbName: 'vanBlog',
    walineDbName: 'waline',
    format: 'gzip',
    outDir: site.outDir,
    workDir: site.workDir,
    ...extra,
  });
}

const src = (rel: string) =>
  stripCommentsForAnchor(fs.readFileSync(path.join(__dirname, rel), 'utf-8'));

describe('备份机密文件的权限（归档 / 状态 / sidecar / 事件日志）', () => {
  (canChmod ? it : it.skip)('真跑一次导出：归档、manifest、.sha256 都是 0600，目录是 0700', async () => {
    const site = makeSite();
    try {
      const result = await exportOnce(site);
      expect(modeOf(result.path)).toBe(SECRET_FILE_MODE);
      expect(modeOf(`${result.path}.manifest.json`)).toBe(SECRET_FILE_MODE);
      expect(modeOf(`${result.path}.sha256`)).toBe(SECRET_FILE_MODE);
      // 归档目录与暂存根目录：老部署是 0755，导出一次就该收紧
      expect(modeOf(site.outDir)).toBe(SECRET_DIR_MODE);
      expect(modeOf(site.workDir)).toBe(SECRET_DIR_MODE);
      // ⚠️ 归档本身必须仍然**可读可恢复**：收紧权限不是把文件弄坏
      expect(fs.statSync(result.path).size).toBeGreaterThan(0);
      expect(fs.readFileSync(`${result.path}.sha256`, 'utf-8')).toContain(
        path.basename(result.path),
      );
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  (canChmod ? it : it.skip)('已存在的 0755 备份目录会被收紧到 0700（升级路径）', async () => {
    const site = makeSite();
    try {
      fs.chmodSync(site.outDir, 0o755); // 模拟升级前的老部署
      await exportOnce(site);
      expect(modeOf(site.outDir)).toBe(0o700);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  (canChmod ? it : it.skip)('backup-status.json 写成 0600，且覆盖一个已存在的 0644 文件后也是 0600', () => {
    const dir = tmpRoot('vanblog-status-');
    try {
      writeBackupStatus(dir, emptyBackupStatus());
      const file = path.join(dir, BACKUP_STATUS_FILE);
      expect(modeOf(file)).toBe(SECRET_FILE_MODE);
      expect(modeOf(dir)).toBe(SECRET_DIR_MODE);
      // 升级前那个 0644 的文件：rename 覆盖后权限来自 tmp ⇒ 必须收紧
      fs.chmodSync(file, 0o644);
      writeBackupStatus(dir, emptyBackupStatus());
      expect(modeOf(file)).toBe(SECRET_FILE_MODE);
      // tmp 文件不该留下
      expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  (canChmod ? it : it.skip)('.sha256 sidecar 写成 0600（server 侧）', () => {
    const dir = tmpRoot('vanblog-sidecar-');
    try {
      const archive = path.join(dir, 'vanblog-full-x.tar.zst');
      fs.writeFileSync(archive, 'payload');
      const sidecar = writeSha256Sidecar(archive, 'a'.repeat(64));
      expect(sidecar).not.toBeNull();
      expect(modeOf(sidecar as string)).toBe(SECRET_FILE_MODE);
      // 内容格式不能被权限改动带偏：sha256sum -c 要能吃
      expect(fs.readFileSync(sidecar as string, 'utf-8')).toBe(
        `${'a'.repeat(64)}  ${path.basename(archive)}\n`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  (canChmod ? it : it.skip)('事件日志写成 0600；已存在的 0644 日志在打开时被收紧', () => {
    const dir = tmpRoot('vanblog-eventlog-');
    const logPath = path.join(dir, 'vanblog-event.log');
    try {
      fs.writeFileSync(logPath, '{"old":true}\n');
      fs.chmodSync(logPath, 0o644); // 升级前的形状
      const stream = new RotatingFileStream(logPath, 20 * 1024 * 1024, 3);
      stream.write('{"e":1}\n');
      expect(modeOf(logPath)).toBe(SECRET_FILE_MODE);
      // 内容没被截断（flags 仍是 a+）
      expect(fs.readFileSync(logPath, 'utf-8')).toContain('{"old":true}');
      // 这个类没有 close/end（它跟着进程活一辈子），测试里直接把底层流销毁掉，
      // 否则 jest 会报 open handle
      (stream as any).stream?.destroy?.();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('收紧目录权限**只去掉位、绝不加位**（0500 的只读目录不会被放宽成 0700）', () => {
    // 负控：把 tightenDirMode 换成无条件 chmod(0o700)，这条就红 ——
    // 而那正是"备份目录写不进去"那个用例造 EACCES 的手法，无条件 chmod 会把它悄悄弄没。
    if (!canChmod) {
      return;
    }
    const dir = tmpRoot('vanblog-tighten-');
    try {
      fs.chmodSync(dir, 0o500);
      expect(tightenDirMode(dir, SECRET_DIR_MODE)).toBe(true);
      expect(modeOf(dir)).toBe(0o500); // 没被放宽
      fs.chmodSync(dir, 0o755);
      tightenDirMode(dir, SECRET_DIR_MODE);
      expect(modeOf(dir)).toBe(0o755 & SECRET_DIR_MODE); // 0700：group/other 去掉了
      // 幂等：再收一次不变
      tightenDirMode(dir, SECRET_DIR_MODE);
      expect(modeOf(dir)).toBe(0o700);
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensureSecretDir / writeSecretFileSync 的契约（新建即正确权限）', () => {
    if (!canChmod) {
      return;
    }
    const root = tmpRoot('vanblog-helpers-');
    try {
      const nested = path.join(root, 'a', 'b', 'c');
      expect(ensureSecretDir(nested)).toBe(nested);
      expect(modeOf(nested)).toBe(SECRET_DIR_MODE);
      const file = path.join(nested, 'f.json');
      writeSecretFileSync(file, '{}');
      expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('源码级锚点：三处写盘都带着机密权限（剥注释后断言）', () => {
    const fullBackup = src('fullBackup.ts');
    expect(fullBackup).toContain('createWriteStream(outFile, { mode: SECRET_FILE_MODE })');
    expect(fullBackup).toContain('ensureSecretDir(options.outDir, SECRET_DIR_MODE)');
    expect(fullBackup).toContain('writeSecretFileSync(`${archivePath}.manifest.json`');
    const status = src('backupStatus.ts');
    expect(status).toContain('ensureSecretDir(backupDir, SECRET_DIR_MODE)');
    expect(status).toContain('writeSecretFileSync(tmp,');
    const integrity = src('backupIntegrity.ts');
    expect(integrity).toContain('writeSecretFileSync(tmp,');
    const logRotate = src('logRotate.ts');
    expect(logRotate).toContain("createWriteStream(this.logPath, { flags: 'a+', mode: SECRET_FILE_MODE })");
    expect(logRotate).toContain('chmodBestEffort(this.logPath, SECRET_FILE_MODE)');
    // 脚本侧的 sidecar 也必须是 0600（两边口径一致）。
    // ⚠️ **不能**用 stripCommentsForAnchor 剥 shell：那是 TS/JS 的剥注释器，
    //    它会把 `https://…` 当成行注释、并被 bash 里的引号与 `$( )` 带偏，
    //    实测把整份脚本啃成残缺片段（断言于是不可能命中）。
    //    shell 用 shell 的办法：删掉"整行以 # 开头"的注释行（仓库里的 shell 守卫也是这么干的）。
    const scriptRaw = fs.readFileSync(
      path.join(__dirname, '../../../../scripts/vanblog.sh'),
      'utf-8',
    );
    const script = scriptRaw
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    // 先证明这个剥法真的在剥东西（否则下面的 not.toContain 就是空转）：
    // 原始文本里确实有我解释"为什么不是 0644"的注释行
    expect(scriptRaw).toContain('不是 0644');
    expect(script).not.toContain('不是 0644');
    expect(script).toContain('chmod 0600 "${file}.sha256"');
    expect(script).not.toContain('chmod 0644 "${file}.sha256"');
  });
});

describe('NDJSON 写流出错时必须在有限时间内失败，而不是永久挂住', () => {
  /**
   * 怎么造一个真的写盘失败：给假 Mongo 一个**带路径穿越的集合名**，
   * 于是 `<staging>/db/vanBlog/../../../../ro/evil.ndjson` 落到一个 0500 的只读目录里 ⇒
   * `createWriteStream` 在 open 时 EACCES 并 emit 'error'。
   * （不 spyOn fs：Node 24 的 fs 属性不可重定义，hardening spec 里已经记过这个坑。）
   */
  (canChmod ? it : it.skip)('写不下去 ⇒ 有限时间内 reject（带剩余空间的人话），且不留下半成品', async () => {
    const site = makeSite();
    const ro = path.join(site.root, 'ro');
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o500);
    const escapingName = '../../../../ro/evil';
    try {
      const client = {
        db: (name: string) => ({
          collections: async () =>
            name === 'vanBlog' ? [{ collectionName: escapingName }] : [],
          collection: () => ({
            find: () => ({
              [Symbol.asyncIterator]: async function* iter() {
                for (let i = 0; i < 3; i += 1) {
                  yield { _id: new ObjectId(), i };
                }
              },
              close: async () => undefined,
            }),
            indexes: async () => [],
          }),
        }),
      } as any;

      const HANG_GUARD_MS = 20000;
      let outcome: 'rejected' | 'resolved' | 'hung' = 'hung';
      let message = '';
      let caught: any = null;
      await Promise.race([
        (async () => {
          try {
            await createFullBackup({
              client,
              staticPath: site.staticPath,
              dbName: 'vanBlog',
              format: 'gzip',
              outDir: site.outDir,
              workDir: site.workDir,
            });
            outcome = 'resolved';
          } catch (err) {
            outcome = 'rejected';
            caught = err;
            message = (err as Error)?.message || String(err);
          }
        })(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, HANG_GUARD_MS);
          t.unref?.();
        }),
      ]);

      // ⚠️ 这条是本轮的核心：修复前它会挂在 'hung'（drain/end 的回调永远不来），
      // 错误以 uncaughtException 的形式飘走，状态停在"进行中"。
      expect(outcome).toBe('rejected');
      // ⚠️ 必须是**包装过的 400**，不能是裸的 `EACCES: permission denied, open '…'`：
      // 裸错误会被 Nest 变成 500 + "Internal server error"，cron 与后台都看不到原因。
      // 变异对照实测过：摘掉 error 监听之后，这里拿到的正是裸 EACCES（jest 会把无监听者的
      // 'error' 事件当异常抛出），而生产环境里它落到 main.ts 的 uncaughtException —— 只打印不退出，
      // drain/end 的回调再也不来，于是 Promise 永不 settle（状态停在"进行中"、请求一直挂着）。
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(message).toContain('写入备份文件失败');
      expect(message).toContain('剩余空间');
      // 用户可见错误必须是 400 而不是被 Nest 变成 500 + "Internal server error"
      expect(message).not.toContain('Internal server error');
      // 半成品不许留在归档目录里（半成品会挤掉保留策略的名额，还会被误当成可用备份）
      expect(
        fs.existsSync(site.outDir)
          ? fs.readdirSync(site.outDir).filter((n) => n.endsWith('.tar.gz'))
          : [],
      ).toEqual([]);
    } finally {
      fs.chmodSync(ro, 0o700);
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('源码级锚点：NDJSON 流挂了 error 监听，且 drain/end 都 race 上它（剥注释后断言）', () => {
    const code = src('fullBackup.ts');
    expect(code).toContain("stream.once('error'");
    expect(code).toContain('Promise.race([p, errored])');
    // drain 与 end 两处等待都必须走 race（漏一处就还会挂）
    expect(code).toContain("await race(new Promise<void>((resolve) => stream.once('drain'");
    expect(code).toContain('await race(new Promise<void>((resolve) => stream.end(');
    // 负控的空转检查：这条正则在"修复前的形状"上必须**匹配不到**，
    // 否则说明它松到连没有 race 的旧代码也能过
    const oldShape = "await new Promise<void>((resolve) => stream.once('drain', () => resolve()));";
    expect(code).not.toContain(oldShape);
    expect(oldShape).toContain("stream.once('drain'"); // 证明上面那条 not.toContain 不是空转
  });

  it('abort 信号真的能停下备份（不是只让调用方解脱）', async () => {
    const site = makeSite();
    try {
      const controller = new AbortController();
      controller.abort(); // 进场就已中止：导出循环第一次检查就该抛
      let caught: any = null;
      try {
        await exportOnce(site, { abortSignal: controller.signal });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(String(caught?.message)).toContain('中止');
      // 半成品归档不许留下
      expect(fs.readdirSync(site.outDir).filter((n) => n.endsWith('.tar.gz'))).toEqual([]);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('provider 真的把超时接上了：AbortController + timeout stage + 定时器 unref', () => {
    const provider = stripCommentsForAnchor(
      fs.readFileSync(
        path.join(__dirname, '../provider/backup/fullBackup.provider.ts'),
        'utf-8',
      ),
    );
    expect(provider).toContain('abortSignal: controller.signal');
    expect(provider).toContain('resolveBackupTimeoutMinutes()');
    expect(provider).toContain("this.recordFailureSafely(timedOut ? 'timeout' : 'export'");
    expect(provider).toContain('timer.unref?.()');
    // race 之后底下那个 promise 仍会 reject ⇒ 必须挂 catch，否则 unhandledRejection 直接退进程
    expect(provider).toContain('backupPromise.catch(() => undefined)');
  });

  it('超时的 env 解析：0=不限时，垃圾值回落默认，写错单位也夹得住', () => {
    // 与 resolveStaleWarnHours 同一套语义，所以照它的形状钉
    const { resolveBackupTimeoutMinutes, DEFAULT_BACKUP_TIMEOUT_MINUTES } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../provider/backup/fullBackup.provider');
    expect(resolveBackupTimeoutMinutes(undefined)).toBe(DEFAULT_BACKUP_TIMEOUT_MINUTES);
    expect(resolveBackupTimeoutMinutes('')).toBe(DEFAULT_BACKUP_TIMEOUT_MINUTES);
    expect(resolveBackupTimeoutMinutes('0')).toBe(0); // 0 = 关，不是"回落默认"
    expect(resolveBackupTimeoutMinutes('abc')).toBe(DEFAULT_BACKUP_TIMEOUT_MINUTES);
    expect(resolveBackupTimeoutMinutes('-5')).toBe(DEFAULT_BACKUP_TIMEOUT_MINUTES);
    expect(resolveBackupTimeoutMinutes('1e999')).toBe(DEFAULT_BACKUP_TIMEOUT_MINUTES);
    expect(resolveBackupTimeoutMinutes('30.7')).toBe(30);
    expect(resolveBackupTimeoutMinutes('99999999')).toBe(60 * 24 * 365);
  });
});

describe('崩溃遗留的备份/恢复工作目录：启动时清掉，但只清够旧的', () => {
  function seed(root: string) {
    const staticTmp = path.join(root, 'static', 'tmp');
    const uploadTmp = path.join(root, 'backups', 'upload-tmp');
    fs.mkdirSync(staticTmp, { recursive: true });
    fs.mkdirSync(uploadTmp, { recursive: true });
    const old = (p: string, hours: number) => {
      const t = new Date(Date.now() - hours * 3600 * 1000);
      fs.utimesSync(p, t, t);
    };
    // 够旧的（该删）
    fs.mkdirSync(path.join(staticTmp, 'full-restore-OLD'));
    fs.writeFileSync(path.join(staticTmp, 'full-restore-OLD', 'users.ndjson'), 'secret\n'.repeat(10));
    old(path.join(staticTmp, 'full-restore-OLD'), 10);
    fs.mkdirSync(path.join(staticTmp, 'full-backup-OLD'));
    old(path.join(staticTmp, 'full-backup-OLD'), 10);
    fs.writeFileSync(path.join(uploadTmp, 'restore-upload-OLD.tar'), 'z'.repeat(4096));
    old(path.join(uploadTmp, 'restore-upload-OLD.tar'), 10);
    // 很新的（正在跑，绝不能删）
    fs.mkdirSync(path.join(staticTmp, 'full-restore-NEW'));
    fs.writeFileSync(path.join(staticTmp, 'full-restore-NEW', 'a.ndjson'), 'live\n');
    fs.writeFileSync(path.join(uploadTmp, 'restore-upload-NEW.tar'), 'live');
    // 不该被碰的：无关目录、同名的**文件**（前缀对但类型不对）
    fs.mkdirSync(path.join(staticTmp, 'img'));
    fs.writeFileSync(path.join(staticTmp, 'img', 'keep.webp'), 'keep');
    fs.writeFileSync(path.join(staticTmp, 'full-restore-NOTADIR'), 'i am a file');
    old(path.join(staticTmp, 'full-restore-NOTADIR'), 10);
    return { staticTmp, uploadTmp };
  }

  it('只删够旧的目录/上传暂存，新的与无关的一律不动，并统计释放空间', () => {
    const root = tmpRoot('vanblog-stalework-');
    try {
      const { staticTmp, uploadTmp } = seed(root);
      const result = cleanupStaleWorkDirs({
        staticPath: path.join(root, 'static'),
        backupDir: path.join(root, 'backups'),
        maxAgeMs: 6 * 3600 * 1000,
      });
      expect(result.disabled).toBe(false);
      expect(result.scanned).toBeGreaterThanOrEqual(4);
      const names = result.removed.map((item) => item.name).sort();
      expect(names).toEqual(['full-backup-OLD', 'full-restore-OLD', 'restore-upload-OLD.tar']);
      expect(result.bytes).toBeGreaterThan(4096);
      // 删掉的确实没了
      expect(fs.existsSync(path.join(staticTmp, 'full-restore-OLD'))).toBe(false);
      expect(fs.existsSync(path.join(staticTmp, 'full-backup-OLD'))).toBe(false);
      expect(fs.existsSync(path.join(uploadTmp, 'restore-upload-OLD.tar'))).toBe(false);
      // 正在跑的那一次、无关文件、同名文件都还在
      expect(fs.existsSync(path.join(staticTmp, 'full-restore-NEW'))).toBe(true);
      expect(fs.readFileSync(path.join(staticTmp, 'full-restore-NEW', 'a.ndjson'), 'utf-8')).toBe(
        'live\n',
      );
      expect(fs.existsSync(path.join(uploadTmp, 'restore-upload-NEW.tar'))).toBe(true);
      expect(fs.existsSync(path.join(staticTmp, 'img', 'keep.webp'))).toBe(true);
      expect(fs.existsSync(path.join(staticTmp, 'full-restore-NOTADIR'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maxAgeMs=0 ⇒ 整个清理关掉（一个都不删），并且如实报告 disabled', () => {
    // 负控：把 `if (!(maxAgeMs > 0)) return disabled` 那段去掉，这条就红
    const root = tmpRoot('vanblog-stalework-off-');
    try {
      seed(root);
      const result = cleanupStaleWorkDirs({
        staticPath: path.join(root, 'static'),
        backupDir: path.join(root, 'backups'),
        maxAgeMs: 0,
      });
      expect(result.disabled).toBe(true);
      expect(result.removed).toEqual([]);
      expect(fs.existsSync(path.join(root, 'static', 'tmp', 'full-restore-OLD'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录不存在（全新部署）不抛，返回空结果', () => {
    const root = tmpRoot('vanblog-stalework-empty-');
    try {
      const result = cleanupStaleWorkDirs({
        staticPath: path.join(root, 'nope'),
        backupDir: path.join(root, 'nope2'),
        maxAgeMs: 1000,
      });
      expect(result.removed).toEqual([]);
      expect(result.scanned).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('阈值 env 解析：0=关，垃圾值回落默认 6，上限一年', () => {
    expect(BACKUP_STALE_WORK_HOURS_ENV).toBe('VANBLOG_BACKUP_STALE_WORK_HOURS');
    expect(DEFAULT_BACKUP_STALE_WORK_HOURS).toBe(6);
    expect(resolveStaleWorkHours(undefined)).toBe(6);
    expect(resolveStaleWorkHours('')).toBe(6);
    expect(resolveStaleWorkHours('0')).toBe(0);
    expect(resolveStaleWorkHours('abc')).toBe(6);
    expect(resolveStaleWorkHours('-1')).toBe(6);
    expect(resolveStaleWorkHours('2.9')).toBe(2);
    expect(resolveStaleWorkHours('99999999')).toBe(24 * 365);
  });

  it('前缀常量与真实代码里 mkdtemp/upload 用的前缀一致（改了名字这里必须红）', () => {
    expect([...STALE_WORK_DIR_PREFIXES].sort()).toEqual(['full-backup-', 'full-restore-']);
    expect([...STALE_UPLOAD_PREFIXES]).toEqual(['restore-upload-']);
    const code = src('fullBackup.ts');
    expect(code).toContain("fs.mkdtempSync(path.join(workRoot, 'full-backup-'))");
    expect(code).toContain("fs.mkdtempSync(path.join(workRoot, 'full-restore-'))");
    const upload = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, './restoreUpload.ts'), 'utf-8'),
    );
    expect(upload).toContain('restore-upload-');
  });

  it('provider 启动时真的会调用清理器（剥注释后断言）', () => {
    const provider = stripCommentsForAnchor(
      fs.readFileSync(
        path.join(__dirname, '../provider/backup/fullBackup.provider.ts'),
        'utf-8',
      ),
    );
    expect(provider).toContain('this.cleanupStaleWorkDirs();');
    expect(provider).toContain('cleanupStaleWorkDirs({');
    expect(provider).toContain('resolveStaleWorkHours()');
    // 清理必须发生在**主实例**的启动钩子里，别让 N 个 worker 各扫一遍
    expect(provider).toContain('isPrimaryInstance(cluster)');
  });
});
