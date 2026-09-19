import * as fs from 'fs';

/**
 * 落在**挂载到宿主机的目录**里的机密文件，一律 0600 / 0700。
 *
 * ## 为什么需要一个公共定义
 *
 * `/var/log`（容器内）是 bind mount 到宿主机 `<数据目录>/log` 的，而备份归档就写在
 * `<日志目录>/vanblog-backups/` 下面。Node 的默认行为是 `0666 & ~umask` ⇒ 容器里 umask 022
 * 就是 **0644**，目录 **0755**：宿主机上**任何本地用户**都能读走归档。
 *
 * 归档里是整站：全部文章正文、`users` 的 scrypt 口令哈希、`settings{type:'jwt'}` 的
 * **jwt 签名密钥**、API Token、访问密码哈希。拿到 jwt 密钥就能直接伪造管理员 token ——
 * 不需要破解任何口令。所以这不是"文件权限不整齐"，而是一条本地提权/接管路径。
 *
 * 项目自己早就认识这个威胁模型：`provider/init/setupKey.ts` 给 `setup.key` 显式
 * `mode: 0o600` 并额外 `chmodSync`，注释写着"日志目录是挂载到宿主机的卷，默认 0644
 * 等于宿主机人人可读"；`restore.key` 与 cron 的 env 文件同样是 0600。
 * 但同一目录下价值高得多的归档、`backup-status.json`、`.sha256`/`.manifest.json` sidecar
 * 与 `vanblog-event.log`（含后台登录/登出与内容变更事件）当时都还是 0644。
 *
 * ## 两个必须知道的 POSIX 细节（都是踩过的）
 *
 * 1. **`mode` 只在"创建"时生效**：文件已存在时 `writeFileSync`/`createWriteStream` 的
 *    `mode` 会被忽略（open 不带 O_TRUNC 改权限的语义）。所以每次都要跟一发 `chmodSync`
 *    —— `setupKey.ts` 就是这么补的。轮转/覆盖写/重复备份都会命中"已存在"这条路。
 * 2. **`mkdirSync(recursive:true, mode)` 只作用于新建的那一层**，而且已存在的目录不改。
 *    所以目录同样要显式 `chmodSync`。
 *
 * `chmod` 失败一律**不抛**：某些挂载（CIFS/SMB、部分 NFS、只读层）不支持改权限，
 * 那种情况下"备份做不出来"比"权限改不动"糟得多。失败会返回 false，由调用方决定要不要 WARN。
 */

/** 机密文件：仅属主可读写。 */
export const SECRET_FILE_MODE = 0o600;
/** 机密目录：仅属主可进入/列目录。 */
export const SECRET_DIR_MODE = 0o700;

/** 尽力改权限；改不动返回 false（不抛，理由见文件头）。 */
export function chmodBestEffort(target: string, mode: number): boolean {
  try {
    fs.chmodSync(target, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写机密小文件：`mode` + 事后 `chmod`（覆盖"文件已存在"那条路）。
 * 传 `opts` 时可以带 encoding / flag，行为与 `fs.writeFileSync` 一致。
 */
export function writeSecretFileSync(
  file: string,
  data: string | Buffer,
  opts?: { encoding?: BufferEncoding; flag?: string },
): void {
  fs.writeFileSync(file, data, { ...(opts || {}), mode: SECRET_FILE_MODE });
  chmodBestEffort(file, SECRET_FILE_MODE);
}

/**
 * 建目录并要求权限：`mkdirSync(recursive)` + **只收紧、绝不放宽**。
 *
 * ⚠️ 对**已存在**的目录也会处理 —— 这正是我们要的：老部署的 `vanblog-backups/` 现在是
 * 0755，升级后第一次备份就该把 group/other 那几位去掉。
 *
 * ⚠️ 但**不能**无条件 `chmod(dir, 0o700)`：那是"把权限**改成** 0700"，对一个被刻意设成
 * 只读（0500）的目录来说等于**替它加回写权限**。所以这里取 `当前 & 目标`：
 * 只可能去掉位，永远不可能加位。
 *  - 0755（老部署的默认）→ 0700 ✔ 去掉了 group/other
 *  - 0700（新建）→ 0700 ✔ 幂等，一次 syscall 都省了
 *  - 0500（刻意只读）→ 0500 ✔ 不放宽；随后写入照样 EACCES，错误如实抛出
 * 这条不是理论洁癖：`fullBackup.hardening.spec.ts` 里"备份目录写不进去"那个用例就是靠
 * 0500 造出 EACCES 的，无条件 chmod 0700 会把那个用例（以及它守的行为）悄悄弄没。
 */
export function ensureSecretDir(dir: string, mode: number = SECRET_DIR_MODE): string {
  fs.mkdirSync(dir, { recursive: true, mode });
  tightenDirMode(dir, mode);
  return dir;
}

/** 把目录权限收紧到 `mode` 以内（只去掉位）；读不到/改不动都静默返回 false。 */
export function tightenDirMode(dir: string, mode: number = SECRET_DIR_MODE): boolean {
  try {
    const current = fs.statSync(dir).mode & 0o777;
    const target = current & mode;
    if (target === current) {
      return true; // 已经够紧，不动
    }
    fs.chmodSync(dir, target);
    return true;
  } catch {
    return false;
  }
}

/** 读一个路径的实际权限（低 9 位）；读不到返回 null。只给测试与诊断用。 */
export function modeOf(target: string): number | null {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return null;
  }
}
