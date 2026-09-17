import * as fs from 'fs';
import * as path from 'path';

/**
 * 把站点上的静态目录**修剪成与归档一致**（P3：100% 保真的恢复）。
 *
 * 为什么需要它：恢复以前只做 `fs.cpSync(src, dst, {recursive:true, force:true})`，
 * 那是**并集**（merge）而不是替换 —— 归档里没有、磁盘上却有的文件会**原样留下**。
 * 于是"把上周的备份恢复到今天的站点"之后：文章、图片元数据都回到了上周，
 * 而这一周新上传的图 / 附件 / 主题 CSS 还躺在磁盘上 ⇒ 站点既不是备份那一刻、
 * 也不是恢复前那一刻，而是一个谁也说不清的混合状态（孤儿文件还会继续被
 * `statics` 集合之外的路径访问到）。owner 要的是"100% 恢复原站点"，所以修剪是必须的。
 *
 * ⚠️ **顺序铁律**：只在拷贝**成功之后**修剪，绝不在之前 —— 一次失败的恢复
 * 不能顺手删掉用户的东西。调用方（`restoreFullBackup`）先做完所有目录的 cpSync，
 * 全部成功才进入修剪阶段。
 *
 * ⚠️ **安全边界**（每一条都有测试钉住）：
 *  - 只在传进来的那个目录里动手，且**用 realpath 后的根**做包含判断
 *    （`img` 本身是软链接到别的磁盘时也不会跑出去）；
 *  - **永不跟随符号链接**：链接一律当叶子处理（`unlink` 链接本身，不碰目标）；
 *    而且指向目录外的链接**连删都不删**，只记进 `skipped` 报告出来 ——
 *    删链接虽然不会伤到目标，但"站点上有一个我不知道指向哪的链接"这件事必须让人看见；
 *  - 自己实现递归删除（不用 `fs.rmSync(recursive:true)`），于是"会不会跟着链接跑出去"
 *    不依赖 Node 内部实现；
 *  - 任何一次删除失败只记 `errors`，不中断其余修剪（修剪是收尾动作，不该反过来把恢复判失败）。
 */

export interface StaticPruneReport {
  /** `BACKUP_STATIC_FOLDERS` 里的名字（img / file / customPage / themes） */
  folder: string;
  /** realpath 之后的目录（日志里用这个才不会误导） */
  root: string;
  removedFiles: number;
  removedDirs: number;
  removedBytes: number;
  /** 被删掉的相对路径，最多 `limit` 个（进 notes 用） */
  names: string[];
  /** 因为安全规则没动的（越界符号链接等） */
  skipped: string[];
  /** 删除失败的（权限 / 竞态） */
  errors: string[];
}

const DEFAULT_NAME_LIMIT = 10;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** 把 srcDir 里存在的相对路径（文件与目录都算）收集成集合，作为"应该留下什么"的权威 */
function collectRelativePaths(root: string): Set<string> {
  const out = new Set<string>(['']);
  const walk = (current: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.add(childRel);
      // 只有真目录才继续往下走：符号链接当叶子（与修剪侧同一条规则）
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), childRel);
      }
    }
  };
  walk(root, '');
  return out;
}

/** 自己实现的递归删除：绝不跟随符号链接，越界的链接直接跳过并记录 */
function removeTreeSafely(
  target: string,
  rel: string,
  root: string,
  report: StaticPruneReport,
  limit: number,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    report.errors.push(`${rel}: lstat 失败（${(err as Error)?.message || err}）`);
    return;
  }
  if (!isInside(root, path.resolve(target))) {
    report.skipped.push(`${rel}: 解析后不在目录内，已跳过`);
    return;
  }
  if (stat.isSymbolicLink()) {
    let linkTarget = '';
    try {
      linkTarget = fs.readlinkSync(target);
    } catch (err) {
      report.errors.push(`${rel}: readlink 失败（${(err as Error)?.message || err}）`);
      return;
    }
    const resolved = path.resolve(path.dirname(target), linkTarget);
    if (!isInside(root, resolved)) {
      // 指向目录外：**不删**。删链接本身不会伤到目标，但这种情况必须让人看见
      report.skipped.push(`${rel}: 符号链接指向目录外（${linkTarget}），已跳过`);
      return;
    }
    try {
      fs.unlinkSync(target);
      report.removedFiles += 1;
      if (report.names.length < limit) report.names.push(rel);
    } catch (err) {
      report.errors.push(`${rel}: 删除符号链接失败（${(err as Error)?.message || err}）`);
    }
    return;
  }
  if (stat.isDirectory()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`${rel}: 读目录失败（${(err as Error)?.message || err}）`);
      return;
    }
    for (const entry of entries) {
      removeTreeSafely(
        path.join(target, entry.name),
        rel ? `${rel}/${entry.name}` : entry.name,
        root,
        report,
        limit,
      );
    }
    try {
      fs.rmdirSync(target);
      report.removedDirs += 1;
      if (report.names.length < limit) report.names.push(`${rel}/`);
    } catch (err) {
      // 目录里还有"被安全规则跳过"的东西时 rmdir 会 ENOTEMPTY：这是预期行为，记一笔就好
      report.errors.push(`${rel}: 删除目录失败（${(err as Error)?.message || err}）`);
    }
    return;
  }
  try {
    fs.unlinkSync(target);
    report.removedFiles += 1;
    report.removedBytes += stat.size;
    if (report.names.length < limit) report.names.push(rel);
  } catch (err) {
    report.errors.push(`${rel}: 删除失败（${(err as Error)?.message || err}）`);
  }
}

/**
 * 把 `dstDir` 修剪成与 `srcDir`（归档里解出来的那份）一致。
 * `srcDir` 不存在时**什么都不做**（归档里没有这一段 ⇒ 无权删任何东西）。
 */
export function pruneFolderToMatch(input: {
  srcDir: string;
  dstDir: string;
  folder: string;
  limit?: number;
}): StaticPruneReport | null {
  const limit = input.limit ?? DEFAULT_NAME_LIMIT;
  const { srcDir, dstDir } = input;
  if (!fs.existsSync(srcDir) || !fs.existsSync(dstDir)) {
    return null;
  }
  const root = safeRealpath(dstDir);
  const report: StaticPruneReport = {
    folder: input.folder,
    root,
    removedFiles: 0,
    removedDirs: 0,
    removedBytes: 0,
    names: [],
    skipped: [],
    errors: [],
  };
  const keep = collectRelativePaths(safeRealpath(srcDir));

  const walk = (current: string, rel: string) => {
    if (!isInside(root, path.resolve(current))) {
      report.skipped.push(`${rel || '.'}: 不在目录内，已跳过`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`${rel || '.'}: 读目录失败（${(err as Error)?.message || err}）`);
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childPath = path.join(current, entry.name);
      if (!keep.has(childRel)) {
        removeTreeSafely(childPath, childRel, root, report, limit);
        continue; // 整棵子树都处理过了，不要再往里走
      }
      // 归档里也有这一项：目录才需要继续往下比对（符号链接不跟随）
      if (entry.isDirectory()) {
        walk(childPath, childRel);
      }
    }
  };
  walk(root, '');
  return report;
}

/** 把修剪报告变成一句人话（进恢复 notes）。 */
export function formatPruneReport(report: StaticPruneReport): string {
  const head =
    `静态目录 ${report.folder}/ 按归档修剪：删掉 ${report.removedFiles} 个文件` +
    (report.removedDirs ? `、${report.removedDirs} 个空目录` : '') +
    `（${report.removedBytes} 字节）`;
  const names = report.names.length ? `：${report.names.join(', ')}` : '';
  const extra: string[] = [];
  if (report.skipped.length) {
    extra.push(`另有 ${report.skipped.length} 项因安全规则未动（${report.skipped.slice(0, 3).join('；')}）`);
  }
  if (report.errors.length) {
    extra.push(`${report.errors.length} 项删除失败（${report.errors.slice(0, 3).join('；')}）`);
  }
  return `${head}${names}${extra.length ? `；${extra.join('；')}` : ''}`;
}
