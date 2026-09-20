import * as fs from 'fs';
import * as path from 'path';
import {
  detectFormat,
  extractSingleFile,
  hashArchiveMembers,
  listArchiveMembers,
  specFor,
} from './fullBackup';
import { FullBackupManifest, isFullBackupManifest } from './backupCodec';
import {
  MANIFEST_COPY_MEMBER,
  MANIFEST_MEMBER,
  TarHashResult,
  computeMerkleRoot,
  hashFile,
} from './backupTarStream';
import {
  MemberFinding,
  diffMembers,
  probeCompressorChecksum,
  readSha256Sidecar,
  summarizeFindings,
} from './backupIntegrity';

/**
 * 整站备份的**只读体检**（P2 的写后校验 + P1 的防损坏校验 + P4 的定期复验都走这里）。
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
 * 7..10 是 **P1 防损坏**那一组，结果放在 `result.integrity` 里（`checks` 的六个键一个没动，
 * 老调用方与老断言不受影响）：
 *  7. **merkleRootOk**：用清单里的 `integrity.members` 重算 merkleRoot 并比对 ——
 *     一个值就能判断"那张几百行的哈希表"有没有被改或被截断，零额外读盘。
 *  8. **memberCountOk**：`integrity.memberCount` vs `tar -tf` 的真实条数（readThrough 已经拿到了，免费）。
 *  9. **manifestCopyOk**：`./MANIFEST.copy.json` 与 `./manifest.json` 逐字节相同
 *     （两份不一致**本身就是发现**：说明其中一份坏了，而清单是丢了就整份不可恢复的那个成员）。
 * 10. **archiveSha256Ok / frameChecksumOk**：整归档 sha256 vs `.sha256` sidecar；
 *     以及压缩器自带内容校验位的**实测值** vs 清单里记的值（钉住"以后换压缩器不能静默丢掉校验位"）。
 * 11. **成员级哈希**（`deep: true` 时才做）：把归档整份解压一遍（**不落盘**，边流边哈希），
 *     与清单里的期望值逐项对比，报告**具体是哪个成员、期望什么、实际什么**。
 *
 * ⚠️ **向后兼容**：没有 `integrity` 块的归档（本次改动之前写出去的全部，含线上那批）
 * 一律**照常通过**，只在 `integrity.notes` 里说明"成员级检查不可用"，绝不判失败。
 *
 * 校验失败不改归档、不删归档（留着排障），由调用方记状态 + ERROR 日志 + 把导出接口判为失败。
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

/**
 * P1 防损坏那一组的结果。
 * `null` 一律表示"**没查**"（老归档没有 integrity 块、没有 `.sha256` sidecar、没要求深度校验），
 * 与 `false`（查了且不通过）严格区分 —— 把"查不了"报成"坏了"会让老归档全线误报。
 */
export interface BackupIntegrityVerify {
  /** 归档里有没有 `integrity` 块（没有 => 下面大多是 null） */
  available: boolean;
  merkleRootOk: boolean | null;
  memberCountOk: boolean | null;
  /** `integrity.members` 里记的成员数（不含目录项） */
  recordedMembers: number | null;
  manifestCopyOk: boolean | null;
  archiveSha256Ok: boolean | null;
  /** 整归档 sha256（做了深度校验或 sidecar 存在时才算） */
  archiveSha256: string | null;
  frameChecksumOk: boolean | null;
  /** 压缩器内容校验位的实测值 */
  frameChecksum: boolean | null;
  /** 深度（成员级）校验查了多少个成员；null = 没做 */
  membersChecked: number | null;
  /** 成员级的具体发现（哪个成员、期望什么、实际什么） */
  memberFindings: MemberFinding[];
  /** 降级说明与提示（不是问题，不影响 ok） */
  notes: string[];
}

export interface BackupVerifyResult {
  ok: boolean;
  ms: number;
  archiveBytes: number;
  /** tar 列表里的成员总数（含目录项） */
  members: number;
  format: string | null;
  checks: BackupVerifyChecks;
  /** P1 防损坏校验的结果（老归档里大多是 null，见 BackupIntegrityVerify） */
  integrity: BackupIntegrityVerify;
  issues: BackupVerifyIssue[];
}

export interface VerifyFullBackupOptions {
  /**
   * 是否做**成员级**哈希校验（整份解压一遍、逐个成员与清单比对，不落盘）。
   * 代价实测见报告（69MB 归档 ≈ 0.6s）；不开时仍然有 merkleRoot / memberCount /
   * 清单副本 / 整归档 sha256 / 压缩器校验位这五项，全都几乎免费。
   */
  deep?: boolean;
}

const ALL_CHECKS: BackupVerifyChecks = {
  readThrough: false,
  manifestFromArchive: false,
  sidecarMatches: false,
  countsConsistent: false,
  staticConsistent: false,
  countsNonZero: false,
};

function emptyIntegrity(): BackupIntegrityVerify {
  return {
    available: false,
    merkleRootOk: null,
    memberCountOk: null,
    recordedMembers: null,
    manifestCopyOk: null,
    archiveSha256Ok: null,
    archiveSha256: null,
    frameChecksumOk: null,
    frameChecksum: null,
    membersChecked: null,
    memberFindings: [],
    notes: [],
  };
}

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

export async function verifyFullBackup(
  archivePath: string,
  options: VerifyFullBackupOptions = {},
): Promise<BackupVerifyResult> {
  const started = Date.now();
  const issues: BackupVerifyIssue[] = [];
  const checks: BackupVerifyChecks = { ...ALL_CHECKS };
  const integrity = emptyIntegrity();
  let archiveBytes = 0;
  let memberList: string[] = [];
  let manifest: FullBackupManifest | null = null;
  let rawManifest: string | null = null;
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
  rawManifest = await extractSingleFile(archivePath, MANIFEST_MEMBER, spec);
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
  let sidecar: FullBackupManifest | null = null;
  try {
    if (!fs.existsSync(sidecarPath)) {
      issues.push({ check: 'sidecarMatches', message: '缺少 .manifest.json sidecar（后台列表页会读不到清单）' });
    } else {
      const parsedSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      if (!isFullBackupManifest(parsedSidecar)) {
        issues.push({ check: 'sidecarMatches', message: 'sidecar 清单不是合法的整站备份清单' });
      } else if (
        JSON.stringify(stripSidecarOnlyFields(parsedSidecar)) !==
        JSON.stringify(stripSidecarOnlyFields(manifest))
      ) {
        issues.push({ check: 'sidecarMatches', message: 'sidecar 清单与归档内部清单不一致' });
      } else if (parsedSidecar.totals?.archiveBytes !== archiveBytes) {
        issues.push({
          check: 'sidecarMatches',
          message: `sidecar 记录的 archiveBytes=${parsedSidecar.totals?.archiveBytes} 与实际文件大小 ${archiveBytes} 不符`,
        });
      } else {
        sidecar = parsedSidecar;
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

    // 5b) caddy 段（P6，只有打开开关导出的归档才有）：同样按"记的数 vs 真写进去的数"比
    if (manifest.caddy) {
      const caddyActual = members.filter((m) => !isDirMember(m) && m.startsWith('caddy/')).length;
      if (caddyActual !== Number(manifest.caddy.files)) {
        checks.staticConsistent = false;
        issues.push({
          check: 'staticConsistent',
          message: `caddy 段文件数不一致：manifest=${manifest.caddy.files} 归档内=${caddyActual}`,
        });
      }
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

  // 7..10) P1 防损坏（老归档没有 integrity 块 => 全部降级成 notes，一个 issue 都不加）
  await verifyIntegrity();

  // 11) 成员级哈希（只在要求深度校验时做）
  if (options.deep) {
    await verifyMembersDeep();
  } else if (integrity.available) {
    integrity.notes.push('未做成员级哈希校验（deep=false）；已校验 merkleRoot / 成员数 / 清单副本 / 整归档 sha256');
  }

  return finish();

  // -------------------------------------------------------------------------

  async function verifyIntegrity(): Promise<void> {
    // 压缩器自带的内容校验位：不管有没有 integrity 块都实测一次（12 字节读，几乎免费）
    const probe = probeCompressorChecksum(archivePath, format);
    integrity.frameChecksum = probe.enabled;
    if (probe.enabled === false) {
      issues.push({
        check: 'frameChecksum',
        message: `压缩器没有开启内容校验位（${probe.detail}）：归档失去自校验能力`,
      });
      integrity.frameChecksumOk = false;
    }

    const block = manifest?.integrity;
    if (!block || typeof block !== 'object') {
      // ⚠️ 这里以前**只有一种文案**，于是在"清单根本读不出来"的情况下会告诉站长
      //    "只校验了解压读通、**清单可解析**、计数一致" —— 而清单恰恰没解析成功。
      //    在灾难恢复路径上，一句错误的"这项没问题"比一个 TypeError 危险得多：
      //    站长会拿着一份其实无法核验的归档去覆盖现有数据。
      //    所以按"清单在不在"分成两种结论，两种都指向已经记录在 issues 里的真原因。
      const probeText =
        probe.enabled === null ? `（${probe.detail}）` : `（实测${probe.enabled ? '已开启' : '未开启'}）`;
      integrity.notes.push(
        manifest
          ? '这份归档没有 integrity 块（早于防损坏改动写出），成员级检查不可用：' +
              '只校验了解压读通、清单可解析、计数一致，以及压缩器自带的内容校验位' +
              probeText
          : '这份归档的 manifest.json **读不出来**（原因见上面 manifestFromArchive 那条问题：' +
              '解不出、解析失败，或不是本功能认的整站备份清单），所以成员级检查与计数核对**全部没有做**：' +
              '只校验了解压读通，以及压缩器自带的内容校验位' +
              probeText +
              '。⚠️ 不要拿这份归档去覆盖现有数据 —— 先换一份能读出清单的备份，' +
              '或用 ./vanblog.sh backup-verify --all 找出最近一份校验通过的归档',
      );
      // 整归档 sha256：老归档也可能有 `.sha256` sidecar（vanblog.sh 会写）
      await checkArchiveSha256(null);
      return;
    }

    integrity.available = true;
    integrity.recordedMembers = Object.keys(block.members || {}).length;

    // 7) merkleRoot：清单里那张哈希表自身的指纹
    const recomputed = computeMerkleRoot(block.members || {});
    if (String(block.merkleRoot || '') !== recomputed) {
      integrity.merkleRootOk = false;
      issues.push({
        check: 'integrityMerkleRoot',
        message:
          `merkleRoot 与按 members 表重算的结果不一致（清单 ${String(block.merkleRoot).slice(0, 12)}…，` +
          `重算 ${recomputed.slice(0, 12)}…）：清单里的成员哈希表被改过或被截断`,
      });
    } else {
      integrity.merkleRootOk = true;
    }

    // 8) memberCount vs 真实成员表
    //    口径是 `tar -tf | wc -l`（readThrough 已经拿到了，免费）。
    //    ⚠️ 已知边界（实测过）：成员名里的**换行**会让这个行数与真实成员数分叉 ——
    //    GNU tar 把它转义成一行 `a\nb`，busybox tar 原样打成两行；而**控制字符**
    //    （真站那种双重编码的中文图名里就有 C1 控制字节）GNU 会转义成 `\302\233`、
    //    busybox 原样输出，但两者都仍是 1 行 ⇒ 只有换名含行才会造成误报。
    //    所以清单里的 `memberCount` 取自**归档 tar 流本身**（实现无关），
    //    深度校验另有权威计数（`integrity.membersChecked`）。
    if (Number(block.memberCount) !== memberList.length) {
      integrity.memberCountOk = false;
      issues.push({
        check: 'integrityMemberCount',
        message:
          `memberCount 与归档实际成员数不符（清单 ${block.memberCount}，实际 ${memberList.length}）：` +
          `有成员被增删（若归档里有成员名含换行，也会让这一项与 tar -tf 的行数分叉）`,
      });
    } else {
      integrity.memberCountOk = true;
    }

    // 两份清单成员必须都记成 null（它们不可能有自己的哈希），否则 merkleRoot 的语义就漂了
    for (const key of [MANIFEST_MEMBER, MANIFEST_COPY_MEMBER]) {
      if (!Object.prototype.hasOwnProperty.call(block.members || {}, key)) {
        issues.push({
          check: 'integrityMembers',
          message: `integrity.members 里缺少 ${key}（清单必须把自己与副本都登记为 null）`,
        });
      } else if (block.members?.[key] !== null) {
        issues.push({
          check: 'integrityMembers',
          message: `integrity.members['${key}'] 应当是 null（清单不能包含自己的哈希），实际是 ${JSON.stringify(
            block.members?.[key],
          )}`,
        });
      }
    }

    // 10) 压缩器校验位：清单里记的值 vs 实测值
    if (probe.enabled === null) {
      integrity.frameChecksumOk = null;
      integrity.notes.push(`无法实测压缩器内容校验位（${probe.detail}）；清单记录的是 ${block.zstdFrameChecksum}`);
    } else if (Boolean(block.zstdFrameChecksum) !== probe.enabled) {
      integrity.frameChecksumOk = false;
      issues.push({
        check: 'frameChecksum',
        message: `清单记录的压缩器内容校验位（${block.zstdFrameChecksum}）与实测（${probe.enabled}：${probe.detail}）不一致`,
      });
    } else {
      integrity.frameChecksumOk = true;
    }

    // 9) 清单副本：与主清单逐字节相同
    const hasCopyMember = memberList.includes(MANIFEST_COPY_MEMBER);
    if (!hasCopyMember) {
      integrity.manifestCopyOk = false;
      issues.push({
        check: 'manifestCopy',
        message: `归档里没有 ${MANIFEST_COPY_MEMBER}（清单副本丢了：主清单一旦损坏，这份归档就既不可校验也不可恢复）`,
      });
    } else {
      const rawCopy = await extractSingleFile(archivePath, MANIFEST_COPY_MEMBER, spec!);
      if (rawCopy === null) {
        integrity.manifestCopyOk = false;
        issues.push({ check: 'manifestCopy', message: `${MANIFEST_COPY_MEMBER} 解不出来（损坏？）` });
      } else if (rawCopy !== rawManifest) {
        integrity.manifestCopyOk = false;
        issues.push({
          check: 'manifestCopy',
          message:
            `${MANIFEST_COPY_MEMBER} 与 ${MANIFEST_MEMBER} 内容不一致（副本 ${rawCopy.length} 字节，` +
            `主清单 ${rawManifest?.length ?? 0} 字节）：其中一份已损坏`,
        });
      } else {
        integrity.manifestCopyOk = true;
      }
    }

    // 10b) 整归档 sha256 vs sidecar / 清单
    // ⚠️ `manifest?.` 是**防御性**的，不是这里真能为 null：上面 `const block = manifest?.integrity`
    //    为假时已经 return，所以走到这里 `block` 非空 ⇒ `manifest` 必非空。
    //    但 `manifest` 是外层函数的 `let`、本函数是闭包，TS 无法跨闭包收窄 ⇒ 会报 TS18047，
    //    而下一个人看到裸 `manifest.totals` 也无从判断这是"已证明非空"还是"漏了判空"。
    //    写成 `?.` 让类型与意图一致：即使将来有人挪动上面那个 early return，这里也只会退化成
    //    "拿不到清单里的哈希，改用 sidecar"，而不是抛 TypeError。
    await checkArchiveSha256(manifest?.totals?.archiveSha256 ?? sidecar?.totals?.archiveSha256 ?? null);
  }

  async function checkArchiveSha256(fromManifest: string | null): Promise<void> {
    const sidecarInfo = readSha256Sidecar(archivePath);
    const expected = sidecarInfo.hex || fromManifest || null;
    if (!sidecarInfo.present && !fromManifest) {
      integrity.notes.push(
        '没有 .sha256 sidecar、清单里也没有 archiveSha256（老归档或由别的工具搬过来的），整归档哈希无从比对',
      );
      return;
    }
    if (sidecarInfo.present && sidecarInfo.parseError) {
      issues.push({ check: 'archiveSha256', message: `.sha256 sidecar 读不懂：${sidecarInfo.parseError}` });
      integrity.archiveSha256Ok = false;
      return;
    }
    if (sidecarInfo.present && sidecarInfo.name && sidecarInfo.name !== path.basename(archivePath)) {
      // 归档被改过名（或 sidecar 是从别处拷来的）：这本身值得说一声，但哈希仍然可以比
      integrity.notes.push(
        `.sha256 sidecar 里记的文件名是 ${sidecarInfo.name}，与当前文件名不同（归档被改名或 sidecar 来自别处）`,
      );
    }
    if (sidecarInfo.present && fromManifest && sidecarInfo.hex !== fromManifest) {
      issues.push({
        check: 'archiveSha256',
        message:
          `.sha256 sidecar（${String(sidecarInfo.hex).slice(0, 12)}…）与清单 totals.archiveSha256` +
          `（${String(fromManifest).slice(0, 12)}…）不一致：两个"外部凭据"自己就对不上`,
      });
      integrity.archiveSha256Ok = false;
      return;
    }
    let actual: string;
    try {
      actual = (await hashFile(archivePath)).sha256;
    } catch (err) {
      issues.push({ check: 'archiveSha256', message: `回读归档算 sha256 失败：${(err as Error)?.message || err}` });
      integrity.archiveSha256Ok = false;
      return;
    }
    integrity.archiveSha256 = actual;
    if (actual !== expected) {
      integrity.archiveSha256Ok = false;
      issues.push({
        check: 'archiveSha256',
        message: `整归档 sha256 不匹配（记录 ${String(expected).slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）：文件被改动过或损坏`,
      });
      return;
    }
    integrity.archiveSha256Ok = true;
  }

  async function verifyMembersDeep(): Promise<void> {
    const block = manifest?.integrity;
    if (!block) {
      integrity.notes.push('深度校验跳过：这份归档没有 integrity 块，没有可对比的期望哈希');
      return;
    }
    let hashed: { result: TarHashResult; decompressError: string | null };
    try {
      hashed = await hashArchiveMembers(archivePath, spec!);
    } catch (err) {
      issues.push({
        check: 'memberHashes',
        message: `成员级校验跑不起来：${(err as Error)?.message || err}`,
      });
      return;
    }
    const { result, decompressError } = hashed;
    integrity.membersChecked = Object.keys(result.members).length;
    if (decompressError) {
      issues.push({ check: 'memberHashes', message: `解压失败（已算出的成员仍参与比对）：${decompressError}` });
    }
    if (!result.complete) {
      issues.push({
        check: 'memberHashes',
        message: 'tar 流没有走到结束块（归档被截断？）：已算出的成员仍参与比对',
      });
    }
    if (result.badHeaders.length) {
      issues.push({
        check: 'memberHashes',
        message: `tar 头部校验和不对的成员：${result.badHeaders.slice(0, 5).join(', ')}`,
      });
    }
    if (result.duplicateNames.length) {
      issues.push({
        check: 'memberHashes',
        message: `归档里有同名成员：${result.duplicateNames.slice(0, 5).join(', ')}`,
      });
    }
    const findings = diffMembers(block.members || {}, result.members);
    integrity.memberFindings = findings;
    if (findings.length) {
      issues.push({
        check: 'memberHashes',
        message:
          `${findings.length} 个成员与清单不符：${summarizeFindings(findings)}` +
          (decompressError ? '（注意：解压本身也失败了，可能是同一处损坏）' : ''),
      });
    } else if (!decompressError && result.complete) {
      integrity.notes.push(
        `成员级哈希全部匹配（${integrity.membersChecked} 个成员，${(result.ms / 1000).toFixed(2)}s）`,
      );
    }
  }

  function finish(): BackupVerifyResult {
    const ok = issues.length === 0;
    return {
      ok,
      ms: Date.now() - started,
      archiveBytes,
      members: memberList.length,
      format,
      checks,
      integrity,
      issues,
    };
  }
}

/**
 * 比较 sidecar 与内部 manifest 时要剥掉"只在 sidecar 里存在"的字段：
 * `archiveBytes` 与 `archiveSha256` 都是**打包之后**才知道的，内部那份不可能有。
 */
function stripSidecarOnlyFields(manifest: FullBackupManifest | null): unknown {
  if (!manifest) {
    return null;
  }
  const totals = { ...manifest.totals };
  delete (totals as any).archiveBytes;
  delete (totals as any).archiveSha256;
  return { ...manifest, totals };
}
