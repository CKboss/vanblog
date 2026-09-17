import * as fs from 'fs';
import {
  detectFormat,
  extractSingleFile,
  listArchiveMembers,
  specFor,
} from './fullBackup';
import { FullBackupManifest, isFullBackupManifest } from './backupCodec';

/**
 * 整站备份的**写后校验**（P2：「备份暂时不要加密，但迭代时一定要确保备份能成功」）。
 *
 * 每次导出（手动或 cron —— cron 走的也是同一个 server 接口）之后，对刚落盘的归档做
 * 一轮只读体检，全部复用既有 helper，不写第二个解析器：
 *
 *  1. **readThrough**：`listArchiveMembers()` = 解压器全量读一遍 + `tar -tf -` 走完每个头。
 *     zstd/xz/gzip 边解压边校验 CRC，截断/位翻转在这里必然炸（解压退出码非 0）。
 *  2. **manifestFromArchive**：归档**内部**的 `manifest.json`（`extractSingleFile`，
 *     不是 sidecar！）能解析且过 `isFullBackupManifest()` 闸门。
 *  3. **sidecarMatches**：`.manifest.json` sidecar（后台列表页读的 cheap path）与内部
 *     manifest 的 databases/static/totals 一致，且 sidecar 的 archiveBytes == 实际文件大小。
 *  4. **countsConsistent**：totals.documents == Σ 每集合 count、totals.collections ==
 *     Σ 集合数、totals.files == Σ static[folder].files、每个集合都有对应 `.ndjson` 成员。
 *  5. **staticConsistent**：manifest 里 static[folder].files == tar 列表里
 *     `./static/<folder>/` 下**文件**成员数（"记录的静态文件数 vs 实际写进去的"）。
 *  6. **countsNonZero**：databases≥1、collections≥1、documents≥1、归档字节>0。
 *     为什么敢要求非零：导出接口在 AdminGuard + InitMiddleware 后面 ⇒ 站点必已初始化 ⇒
 *     users/metas/settings 至少有文档；全零只可能是"导出静默产出了空归档"，正是本校验要抓的。
 *     ⚠️ static 文件数**不**要求非零（全新站点可以一张图都没有，0==0 一致即可）。
 *
 * 校验失败不改归档、不删归档（留着排障），由调用方记状态 + ERROR 日志 + 把导出接口判为失败。
 * **归档格式一个字节都没动**：老归档照常可恢复，也可以随时用本函数补验。
 */

export interface BackupVerifyIssue {
  check: string;
  message: string;
}

export interface BackupVerifyChecks {
  readThrough: boolean;
  manifestFromArchive: boolean;
  sidecarMatches: boolean;
  countsConsistent: boolean;
  staticConsistent: boolean;
  countsNonZero: boolean;
}

export interface BackupVerifyResult {
  ok: boolean;
  ms: number;
  archiveBytes: number;
  /** tar 列表里的成员总数（含目录项） */
  members: number;
  format: string | null;
  checks: BackupVerifyChecks;
  issues: BackupVerifyIssue[];
}

const ALL_CHECKS: BackupVerifyChecks = {
  readThrough: false,
  manifestFromArchive: false,
  sidecarMatches: false,
  countsConsistent: false,
  staticConsistent: false,
  countsNonZero: false,
};

/** tar 成员名归一化：GNU/busybox 输出可能带 './' 前缀与结尾 '/' */
function normalizeMember(name: string): string {
  let n = String(name || '').trim();
  if (n.startsWith('./')) {
    n = n.slice(2);
  }
  return n;
}

function isDirMember(name: string): boolean {
  return name.endsWith('/');
}

export async function verifyFullBackup(archivePath: string): Promise<BackupVerifyResult> {
  const started = Date.now();
  const issues: BackupVerifyIssue[] = [];
  const checks: BackupVerifyChecks = { ...ALL_CHECKS };
  let archiveBytes = 0;
  let memberList: string[] = [];
  let manifest: FullBackupManifest | null = null;
  // ⚠️ 必须用 let 提前声明：finish() 在 statSync 失败的早退路径上就会被调用，
  //    而那时 `const format = …` 还没执行（TDZ → ReferenceError，被测试抓出来了）
  let format: ReturnType<typeof detectFormat> = null;

  try {
    archiveBytes = fs.statSync(archivePath).size;
  } catch (err) {
    issues.push({ check: 'readThrough', message: `读不到归档文件：${(err as Error)?.message || err}` });
    return finish();
  }

  format = detectFormat(archivePath);
  const spec = format ? specFor(format) : null;
  if (!format || !spec) {
    issues.push({
      check: 'readThrough',
      message: `无法识别压缩格式或本机没有对应解压器（format=${format}）`,
    });
    return finish();
  }

  // 1) 解压器全量读通 + tar 走完每个成员头
  try {
    memberList = await listArchiveMembers(archivePath);
    checks.readThrough = true;
  } catch (err) {
    issues.push({
      check: 'readThrough',
      message: `解压/tar 列表失败（归档损坏或截断？）：${(err as Error)?.message || err}`,
    });
    return finish(); // 读不通时后面的检查都没有意义
  }

  // 2) 归档内部的 manifest（不用 sidecar：sidecar 是导出进程自己写的，坏归档它也可能"好看"）
  const rawManifest = await extractSingleFile(archivePath, './manifest.json', spec);
  if (!rawManifest) {
    issues.push({ check: 'manifestFromArchive', message: '归档里解不出 ./manifest.json' });
  } else {
    try {
      const parsed = JSON.parse(rawManifest);
      if (isFullBackupManifest(parsed)) {
        manifest = parsed;
        checks.manifestFromArchive = true;
      } else {
        issues.push({
          check: 'manifestFromArchive',
          message: 'manifest.json 不是本功能认的整站备份清单（isFullBackupManifest 不通过）',
        });
      }
    } catch (err) {
      issues.push({
        check: 'manifestFromArchive',
        message: `manifest.json 解析失败：${(err as Error)?.message || err}`,
      });
    }
  }

  // 3) sidecar 与内部 manifest 一致 + archiveBytes 与实际文件大小一致
  const sidecarPath = `${archivePath}.manifest.json`;
  try {
    if (!fs.existsSync(sidecarPath)) {
      issues.push({ check: 'sidecarMatches', message: '缺少 .manifest.json sidecar（后台列表页会读不到清单）' });
    } else {
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      if (!isFullBackupManifest(sidecar)) {
        issues.push({ check: 'sidecarMatches', message: 'sidecar 清单不是合法的整站备份清单' });
      } else if (
        JSON.stringify(stripArchiveBytes(sidecar)) !== JSON.stringify(stripArchiveBytes(manifest))
      ) {
        issues.push({ check: 'sidecarMatches', message: 'sidecar 清单与归档内部清单不一致' });
      } else if (sidecar.totals?.archiveBytes !== archiveBytes) {
        issues.push({
          check: 'sidecarMatches',
          message: `sidecar 记录的 archiveBytes=${sidecar.totals?.archiveBytes} 与实际文件大小 ${archiveBytes} 不符`,
        });
      } else {
        checks.sidecarMatches = true;
      }
    }
  } catch (err) {
    issues.push({ check: 'sidecarMatches', message: `sidecar 读取失败：${(err as Error)?.message || err}` });
  }

  if (manifest) {
    // 4) totals vs 每集合/每目录求和
    let collections = 0;
    let documents = 0;
    const ndjsonMembers = new Set(
      memberList.map(normalizeMember).filter((m) => !isDirMember(m) && m.startsWith('db/')),
    );
    const missingNdjson: string[] = [];
    for (const [dbName, dbSummary] of Object.entries(manifest.databases || {})) {
      for (const [collName, summary] of Object.entries(dbSummary?.collections || {})) {
        collections += 1;
        documents += Number(summary?.count) || 0;
        const expected = `db/${dbName}/${collName}.ndjson`;
        if (!ndjsonMembers.has(expected)) {
          missingNdjson.push(expected);
        }
      }
    }
    const totals = manifest.totals;
    if (
      Number(totals?.databases) !== Object.keys(manifest.databases || {}).length ||
      Number(totals?.collections) !== collections ||
      Number(totals?.documents) !== documents ||
      missingNdjson.length
    ) {
      checks.countsConsistent = false;
      issues.push({
        check: 'countsConsistent',
        message:
          `totals 与逐集合求和不一致：totals={db:${totals?.databases},coll:${totals?.collections},doc:${totals?.documents}} ` +
          `实际={db:${Object.keys(manifest.databases || {}).length},coll:${collections},doc:${documents}}` +
          (missingNdjson.length ? `；归档里缺少成员：${missingNdjson.slice(0, 5).join(', ')}` : ''),
      });
    } else {
      checks.countsConsistent = true;
    }

    // 5) 静态文件：manifest 记的数量 vs tar 里实际写入的文件成员数
    let manifestFiles = 0;
    let staticMismatch: string[] = [];
    const members = memberList.map(normalizeMember);
    for (const [folder, summary] of Object.entries(manifest.static || {})) {
      manifestFiles += Number(summary?.files) || 0;
      const prefix = `static/${folder}/`;
      const actual = members.filter((m) => !isDirMember(m) && m.startsWith(prefix)).length;
      if (actual !== Number(summary?.files)) {
        staticMismatch.push(`${folder}: manifest=${summary?.files} 归档内=${actual}`);
      }
    }
    if (staticMismatch.length || Number(totals?.files) !== manifestFiles) {
      checks.staticConsistent = false;
      issues.push({
        check: 'staticConsistent',
        message:
          `静态文件数不一致：totals.files=${totals?.files} Σmanifest=${manifestFiles}` +
          (staticMismatch.length ? `；${staticMismatch.join('；')}` : ''),
      });
    } else {
      checks.staticConsistent = true;
    }

    // 6) 非零（见文件头注释：导出接口在鉴权+已初始化闸门之后，全零必然是异常）
    if (
      Number(totals?.databases) >= 1 &&
      Number(totals?.collections) >= 1 &&
      Number(totals?.documents) >= 1 &&
      archiveBytes > 0
    ) {
      checks.countsNonZero = true;
    } else {
      issues.push({
        check: 'countsNonZero',
        message: `计数为零（databases=${totals?.databases}, collections=${totals?.collections}, documents=${totals?.documents}, bytes=${archiveBytes}）：已初始化的站点不该导出空备份`,
      });
    }
  }

  return finish();

  function finish(): BackupVerifyResult {
    const ok = issues.length === 0;
    return {
      ok,
      ms: Date.now() - started,
      archiveBytes,
      members: memberList.length,
      format,
      checks,
      issues,
    };
  }
}

/** 比较 sidecar 与内部 manifest 时去掉 archiveBytes：内部那份是打包**前**写的，没有这个字段。 */
function stripArchiveBytes(manifest: FullBackupManifest | null): unknown {
  if (!manifest) {
    return null;
  }
  const totals = { ...manifest.totals };
  delete (totals as any).archiveBytes;
  return { ...manifest, totals };
}
