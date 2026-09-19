import * as fs from 'fs';
import * as path from 'path';
import {
  BackupIntegrity,
  MemberHash,
} from './backupCodec';
import {
  INTEGRITY_ALGORITHM,
  MANIFEST_COPY_MEMBER,
  MANIFEST_MEMBER,
  SHA256_SIDECAR_EXT,
  computeMerkleRoot,
} from './backupTarStream';
import { writeSecretFileSync } from './secretFileMode';

/**
 * 归档防损坏（P1）的**纯逻辑**部分：校验和 sidecar 的读写、压缩器自带校验位的实测、
 * `integrity` 块的组装，以及"清单里记的 vs 实际算出来的"逐项对比。
 *
 * 拆出来的理由：这些函数不碰子进程、不碰数据库，全部可以用固定测试向量钉死，
 * 而 `fullBackup.ts` / `backupVerify.ts` 里那些要跑真 tar + 真压缩器的路径只负责编排。
 *
 * ⚠️ 兼容性铁律：`integrity` 是**可选追加**字段，`version` 仍是 1。
 * 没有这个块的归档（本次改动之前写出去的全部，包括线上那批）必须照样能
 * inspect / verify / restore，校验时只补一句"成员级检查不可用"。
 */

export { SHA256_SIDECAR_EXT, MANIFEST_MEMBER, MANIFEST_COPY_MEMBER, computeMerkleRoot };

export interface CompressorChecksumProbe {
  /** true = 压缩器层面的内容校验位确实开着；false = 明确没开；null = 读不出来 */
  enabled: boolean | null;
  /** 人话说明（判据是什么），进日志与校验报告 */
  detail: string;
}

/**
 * **实测**压缩器自带的内容校验位，而不是假设默认值。
 *
 * 为什么必须实测：`zstd` 的 frame content checksum 是 CLI 默认开的，
 * 所以以前归档里那个 `0x04` 描述符字节只是"碰巧对"—— 哪天有人把压缩命令换成
 * 别的实现（或加了 `--no-check`），归档就静默失去唯一的自校验能力，
 * 而 manifest 里看不出来。这里直接读头部位：
 *  - zstd：magic `28 b5 2f fd` + 帧头描述符字节 bit2（Content_Checksum_flag）
 *  - xz：magic `fd 37 7a 58 5a 00` + stream flags 低 4 位（0 = None，4 = CRC64 是默认）
 *  - gzip：CRC32 是格式强制的（每个 member 都有），恒为 true
 */
export function probeCompressorChecksum(archivePath: string, format: string | null): CompressorChecksumProbe {
  let head: Buffer;
  try {
    const fd = fs.openSync(archivePath, 'r');
    try {
      head = Buffer.alloc(12);
      const read = fs.readSync(fd, head, 0, 12, 0);
      head = head.subarray(0, Math.max(0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { enabled: null, detail: `读不到文件头：${(err as Error)?.message || err}` };
  }
  if (format === 'zstd') {
    if (head.length < 5 || head[0] !== 0x28 || head[1] !== 0xb5 || head[2] !== 0x2f || head[3] !== 0xfd) {
      return { enabled: null, detail: '不是 zstd magic（28 b5 2f fd）' };
    }
    const descriptor = head[4];
    const enabled = (descriptor & 0x04) !== 0;
    return {
      enabled,
      detail: `zstd 帧头描述符 0x${descriptor.toString(16).padStart(2, '0')}，bit2(Content_Checksum)=${enabled ? 1 : 0}`,
    };
  }
  if (format === 'xz') {
    const magic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
    if (head.length < 8 || !head.subarray(0, 6).equals(magic)) {
      return { enabled: null, detail: '不是 xz magic（fd 37 7a 58 5a 00）' };
    }
    const checkType = head[7] & 0x0f;
    return {
      enabled: checkType !== 0,
      detail: `xz stream flags check 类型=${checkType}（0=None，4=CRC64）`,
    };
  }
  if (format === 'gzip') {
    if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
      return { enabled: null, detail: '不是 gzip magic（1f 8b）' };
    }
    return { enabled: true, detail: 'gzip 的 CRC32 是格式强制的' };
  }
  return { enabled: null, detail: `未知压缩格式：${format}` };
}

/**
 * 写整归档的 `.sha256` sidecar，格式与 `sha256sum` 输出一致（`"<hex>  <文件名>\n"`，两个空格），
 * 也与 `scripts/vanblog.sh write_sha256_sidecar` 一致 ⇒ 两边谁先写都一样，`sha256sum -c` 能直接吃。
 *
 * 写失败**不抛**（备份已经成功了，别反过来把它判失败），返回 null 让调用方记一条 WARN。
 */
export function writeSha256Sidecar(archivePath: string, hex: string): string | null {
  const sidecar = `${archivePath}${SHA256_SIDECAR_EXT}`;
  try {
    const tmp = `${sidecar}.tmp-${process.pid}`;
    // 0600：sidecar 本身只有一个哈希，但它与归档同目录同命运 —— 归档目录已经是 0700，
    // 没有理由让旁边这个文件还是 0644（它会泄露归档名与备份节奏）。
    writeSecretFileSync(tmp, `${hex}  ${path.basename(archivePath)}\n`);
    fs.renameSync(tmp, sidecar);
    return sidecar;
  } catch {
    return null;
  }
}

export interface Sha256SidecarInfo {
  present: boolean;
  hex: string | null;
  /** sidecar 里记的文件名（用来发现"归档被改名了"） */
  name: string | null;
  parseError: string | null;
}

/** 读 `.sha256` sidecar；缺失/格式不对都返回 present=false 或 parseError，不抛。 */
export function readSha256Sidecar(archivePath: string): Sha256SidecarInfo {
  const sidecar = `${archivePath}${SHA256_SIDECAR_EXT}`;
  if (!fs.existsSync(sidecar)) {
    return { present: false, hex: null, name: null, parseError: null };
  }
  try {
    const text = fs.readFileSync(sidecar, 'utf8').trim();
    // `sha256sum` 的两种分隔：两空格（文本模式）或 " *"（二进制模式）
    const match = /^([0-9a-fA-F]{64})[\s]+\*?(.*)$/.exec(text);
    if (!match) {
      return { present: true, hex: null, name: null, parseError: `格式不认识：${text.slice(0, 80)}` };
    }
    return { present: true, hex: match[1].toLowerCase(), name: match[2] || null, parseError: null };
  } catch (err) {
    return { present: true, hex: null, name: null, parseError: (err as Error)?.message || String(err) };
  }
}

/**
 * 组装 manifest 的 `integrity` 块。
 *
 * `tarResult` 来自**打包前**对暂存树跑的那一遍 tar 流（见 `fullBackup.ts` 的
 * `hashStagingTree`），所以成员名与 `tar -tf` 逐字一致。
 *
 * ⚠️ 两份清单成员的哈希只能是 **null**：`manifest.json` 不能包含自己的哈希（自指），
 * 而 `MANIFEST.copy.json` 与它**逐字节相同**，所以它的哈希同样不可知。
 * 这两个成员仍然计入 `memberCount`、也进 merkleRoot（写成字面量 `null`），
 * 于是"少了一份清单副本"或"副本被换掉"都会让 merkleRoot 对不上。
 */
export function buildIntegrity(input: {
  members: Record<string, MemberHash | null>;
  memberCount: number;
  frameChecksum: boolean;
}): BackupIntegrity {
  const members: Record<string, MemberHash | null> = { ...input.members };
  members[MANIFEST_MEMBER] = null;
  members[MANIFEST_COPY_MEMBER] = null;
  return {
    algorithm: INTEGRITY_ALGORITHM,
    zstdFrameChecksum: Boolean(input.frameChecksum),
    merkleRoot: computeMerkleRoot(members),
    // 暂存树那一遍 tar 里没有这两份清单（它们是算完哈希之后才写的），所以 +2
    memberCount: input.memberCount + 2,
    members,
  };
}

export type MemberFindingKind = 'missing' | 'unexpected' | 'hash' | 'size';

export interface MemberFinding {
  kind: MemberFindingKind;
  path: string;
  expected: string | null;
  actual: string | null;
  message: string;
}

/**
 * 清单里记的成员表 vs 实际从归档算出来的成员表，逐项对比。
 *
 * 输出**具体是哪个成员、期望什么、实际什么** —— 而不是笼统一句"归档坏了"：
 * 站点坏了一张图和整份归档烂掉，处置方式完全不同（前者可以从原站重传，后者只能换恢复点）。
 *
 * ⚠️ 期望值为 `null` 的成员（`./manifest.json`、`./MANIFEST.copy.json`、硬链接、设备）**只查在不在**，
 * 不比哈希：清单不可能包含自己的哈希（自指），而副本与主清单逐字节相同 ⇒ 它的哈希同样不可知。
 * 这两个成员的完整性另有三道闸：JSON 能解析且过 `isFullBackupManifest`、两份互为对照
 * （`manifestCopyOk`）、以及 merkleRoot 里 `./manifest.json\nnull` 这两行本身（少一行就对不上）。
 */
export function diffMembers(
  expected: Record<string, MemberHash | null>,
  actual: Record<string, MemberHash | null>,
): MemberFinding[] {
  const findings: MemberFinding[] = [];
  const expectedKeys = Object.keys(expected || {});
  const actualKeys = Object.keys(actual || {});
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(actual || {}, key)) {
      findings.push({
        kind: 'missing',
        path: key,
        expected: expected[key]?.sha256 ?? null,
        actual: null,
        message: `归档里没有这个成员（清单里有）`,
      });
      continue;
    }
    const want = expected[key];
    if (want === null) {
      continue; // 自指成员：只查存在性（上面那一步已经查过了）
    }
    const got = actual[key];
    const gotHash = got === null ? null : got.sha256;
    if (want.sha256 !== gotHash) {
      // 硬链接（实际 sha256 为 null）期望值不是 null 时，也算不匹配
      findings.push({
        kind: 'hash',
        path: key,
        expected: want.sha256,
        actual: gotHash,
        message: `sha256 不匹配`,
      });
      continue;
    }
    const gotBytes = got === null ? null : got.bytes;
    if (want.bytes !== gotBytes) {
      findings.push({
        kind: 'size',
        path: key,
        expected: String(want.bytes),
        actual: gotBytes === null ? null : String(gotBytes),
        message: `字节数不匹配`,
      });
    }
  }
  for (const key of actualKeys) {
    if (!Object.prototype.hasOwnProperty.call(expected || {}, key)) {
      findings.push({
        kind: 'unexpected',
        path: key,
        expected: null,
        actual: actual[key]?.sha256 ?? null,
        message: `归档里多出一个清单里没有的成员`,
      });
    }
  }
  return findings;
}

/** 把成员级的发现压成一句人话（最多点名 10 个），供日志与 notes 使用。 */
export function summarizeFindings(findings: MemberFinding[], limit = 10): string {
  if (!findings.length) {
    return '无';
  }
  const named = findings
    .slice(0, limit)
    .map((f) => {
      const short = (value: string | null) => (value ? `${value.slice(0, 12)}…` : 'null');
      if (f.kind === 'hash') {
        return `${f.path}（sha256 期望 ${short(f.expected)} 实际 ${short(f.actual)}）`;
      }
      if (f.kind === 'size') {
        return `${f.path}（字节数 期望 ${f.expected} 实际 ${f.actual}）`;
      }
      return `${f.path}（${f.message}）`;
    })
    .join('；');
  const rest = findings.length - Math.min(limit, findings.length);
  return `${named}${rest > 0 ? `；另有 ${rest} 项` : ''}`;
}
