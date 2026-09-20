import * as fs from 'fs';
import * as path from 'path';
import {
  SERVE_HTML_PAGES_DIR_ENV,
  resolveWebsitePagesDir,
} from '../caddy/caddy.provider';

/**
 * ISR 产物清道夫（stale-artifact reaper）。
 *
 * ## 为什么需要它（2026-09 实测，全部在真容器 + 真数据上验证过）
 * Next 14.2.35 的 file-system-cache **只写不删**（源码里没有任何 unlink）：
 * - 文章被删除/隐藏/加密/改成定时发布之后，revalidate 只会把「404/notFound」记在
 *   **进程内存**里，旧的 `.html`（连同全文的 `__NEXT_DATA__`）永远留在盘上；
 * - caddy 的 `vanblog-serve-html` 路由（`VANBLOG_CADDY_SERVE_HTML=all`）按文件直服，
 *   看不见 Next 的内存态 —— 文件在，就会把**已删文章的正文按 200 永远发出去**；
 * - 这个坑还有一个今天就能观察到的温和版本：website 进程重启后内存 404 丢失，
 *   Next 自己也会短暂地从盘上把已删文章serve回来，直到下一轮风暴把它盖掉。
 * 所以直服动态路由的前提是：**有人负责把"不再可公开发布"的路径的产物从盘上删掉**。
 * 这个文件就是那个人（纯 fs 逻辑，可单测；触发时机在 isr.provider.ts）。
 *
 * ## 安全边界（每一条都有测试钉住）
 * - 只碰四个动态前缀目录：post/ page/ category/ tag/（对应 /post/* /page/* /category/* /tag/*）。
 *   六个固定页（index/about/link/timeline/category/tag 的**根级** .html）永远不扫、不删。
 * - 每个待删路径都经过 resolve + 前缀检查（slug 是用户可影响的字符串，
 *   `..`/绝对路径/越界一律拒绝 —— traversal-safe join 是必答题不是装饰）。
 * - pages 目录不存在（dev 机、website 单独部署、VANBLOG_DISABLE_WEBSITE）= no-op。
 * - 幂等：重复跑结果一致；文件不存在不报错。
 * - 删除以「三件套」为单位（.html/.json/.meta），绝不让 Next 看到半套产物。
 * - 目录读失败记 error 而不是吞掉：静默失败的清道夫 = 已删文章继续公开。
 *
 * ## 名字编码
 * 盘上文件名是**解码后**的路径段（实测容器里有 `category/博客.html`；带空格的别名
 * 会存成含空格的真实文件名）。调用方传入的 qualified 集合必须同样是解码后的
 * URL 路径（isr.provider 里对 getCategoryUrls/getTagUrls 做了 decodeURIComponent）。
 */

/** 允许清理的动态前缀目录（= caddy 直服路由里的四个通配） */
export const DYNAMIC_ARTIFACT_DIRS = ['post', 'page', 'category', 'tag'] as const;

/** 一个 ISR 页面在盘上的三件套后缀 */
export const ARTIFACT_SUFFIXES = ['.html', '.json', '.meta'] as const;

/**
 * 与 caddy 哨兵同一个目录来源（env 覆盖用于测试与分离部署）。
 *
 * ⚠️ 必须走共用的 `resolveWebsitePagesDir()`，不能是裸 `env || DEFAULT`。
 * 🔴 这一处的失败方向比另两处更严重，因为 reaper 是**删除**操作：
 * 修复前一个非法值会被原样拿来当扫描根 ——
 *   - `/` ⇒ 去扫**文件系统根**下的 post/ page/ category/ tag/；
 *   - `/a/../b` ⇒ 把可删除范围移出产物目录；
 *   - 相对路径 ⇒ 相对进程 cwd 解析，落在哪取决于启动方式。
 * 现在非法值一律回落默认目录（= 真正的产物目录），这是**安全方向**：
 * 宁可"在正确的目录里清理"，也不要"在一个没人指定的地方删文件"。
 *
 * ⚠️ **合法值必须原样生效**（不规范化以外的任何改动）：分离部署与测试都靠它，
 * 而且 caddy 的 `vars.root` 用的就是同一个合法值 —— 两侧必须指同一个目录，
 * 否则"caddy 直服的产物"与"reaper 清理的产物"不是同一批文件，
 * 已删/已转私密的文章会继续被公开服务。有断言钉住这一点。
 *
 * @param log 可选；给了就把"值被拒绝/被规范化"的 WARN 打出来。
 */
export function reaperPagesDir(log?: { warn(message: string): void }): string {
  const resolved = resolveWebsitePagesDir(process.env[SERVE_HTML_PAGES_DIR_ENV]);
  for (const w of resolved.warns) log?.warn(`[artifact-reaper] ${w}`);
  return resolved.dir;
}

/**
 * URL 路径 → 产物相对路径（`/post/x` → `post/x.html`）。
 * 固定页（`/`、`/about`…）、更深的路径（`/post/a/b`）、四个前缀之外的一切 → null。
 * 动态路由全部是单段参数，所以只认「恰好两段」。
 */
export function urlPathToArtifactRel(urlPath: unknown): string | null {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) {
    return null;
  }
  const noQuery = urlPath.split('?')[0].split('#')[0];
  const trimmed = noQuery.length > 1 ? noQuery.replace(/\/+$/, '') : noQuery;
  const segs = trimmed.split('/').slice(1);
  if (segs.length !== 2) {
    return null; // '/'、'/about'、'/post/a/b' 全都在这里被挡掉
  }
  const [dir, name] = segs;
  if (!(DYNAMIC_ARTIFACT_DIRS as readonly string[]).includes(dir) || !name) {
    return null;
  }
  return `${dir}/${name}.html`;
}

/**
 * 把相对路径安全地拼进 pages 目录：resolve 之后必须仍在目录内，否则 null。
 * （readdir 出来的文件名不会含 '/'，但 urlPath 来的会 —— 两边都过这道闸。）
 */
export function safeArtifactPath(pagesDir: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) {
    return null;
  }
  const root = path.resolve(pagesDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return null;
  }
  return full;
}

/**
 * 按 URL 路径删掉一个动态页的三件套（事件驱动入口用；固定页/越界路径 → []）。
 * 返回实际删除的文件绝对路径列表。
 */
export function reapPathArtifacts(pagesDir: string, urlPath: string): string[] {
  const rel = urlPathToArtifactRel(urlPath);
  if (!rel) {
    return [];
  }
  const removed: string[] = [];
  const base = rel.slice(0, -'.html'.length);
  for (const suffix of ARTIFACT_SUFFIXES) {
    const target = safeArtifactPath(pagesDir, base + suffix);
    if (!target) {
      continue;
    }
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(target);
      }
    } catch {
      // 单个文件删不掉（权限/竞态）不影响其它两件；由 reconcile 的下一轮兜底
    }
  }
  return removed;
}

export interface ReconcileResult {
  /** 实际删除的文件（相对 pages 目录），按发现顺序 */
  deleted: string[];
  /** 非致命错误（目录读失败、单文件删除失败），带上下文，供调用方打日志 */
  errors: string[];
  /** 扫到的 .html 产物数（量具/日志用） */
  scanned: number;
}

/**
 * 全量对账（周期兜底 + 每轮风暴收尾）：列出四个动态目录下的 .html，
 * URL 路径不在 `qualifiedUrlPaths` 里的，连同 .json/.meta 一起删。
 *
 * `qualifiedUrlPaths` 必须是**解码后**的可公开 URL 路径集合
 * （/post/<slug 或数字 id>、/category/<名>、/tag/<名>、/page/<N>）。
 *
 * 纯 fs + 纯集合运算（不读库、不碰网络），所以可以在任何环境安全重跑；
 * pages 目录不存在时是 no-op。孤儿 .json/.meta（没有同名 .html）不处理：
 * caddy 只按 .html 直服，Next 读缓存也以 .html 为先，孤儿文件发不出去。
 */
export function reconcileArtifacts(
  pagesDir: string,
  qualifiedUrlPaths: ReadonlySet<string>,
): ReconcileResult {
  const result: ReconcileResult = { deleted: [], errors: [], scanned: 0 };
  const root = path.resolve(pagesDir);
  let rootExists = false;
  try {
    rootExists = fs.statSync(root).isDirectory();
  } catch {
    rootExists = false;
  }
  if (!rootExists) {
    return result; // dev 机 / 分离部署：没有产物目录就没有可删的东西
  }
  const qualifiedRels = new Set<string>();
  for (const url of qualifiedUrlPaths) {
    const rel = urlPathToArtifactRel(url);
    if (rel) {
      qualifiedRels.add(rel);
    }
  }
  for (const dir of DYNAMIC_ARTIFACT_DIRS) {
    const dirPath = path.join(root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // 目录在却读不了（权限/IO）：说出来，别装作扫过了
        result.errors.push(`读取 ${dir}/ 失败：${(err as Error)?.message || err}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.html')) {
        continue; // 目录、符号链接、[id].js、.json、.meta 孤儿都不碰
      }
      result.scanned += 1;
      const rel = `${dir}/${entry.name}`;
      if (qualifiedRels.has(rel)) {
        continue;
      }
      const htmlAbs = safeArtifactPath(root, rel);
      if (!htmlAbs) {
        result.errors.push(`拒绝越界路径：${rel}`);
        continue;
      }
      const base = htmlAbs.slice(0, -'.html'.length);
      for (const suffix of ARTIFACT_SUFFIXES) {
        const target = base + suffix;
        // suffix 拼接不可能越界，但闸门对每个待删路径都过一遍（纵深防御，也是测试钉子）
        if (!safeArtifactPath(root, path.relative(root, target))) {
          result.errors.push(`拒绝越界路径：${target}`);
          continue;
        }
        try {
          if (fs.existsSync(target)) {
            fs.unlinkSync(target);
            result.deleted.push(path.relative(root, target));
          }
        } catch (err) {
          result.errors.push(`删除 ${path.relative(root, target)} 失败：${(err as Error)?.message || err}`);
        }
      }
    }
  }
  return result;
}
