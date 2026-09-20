import * as fs from 'fs';
import * as path from 'path';
import {
  CADDY_SERVE_HTML_DYNAMIC_SENTINEL,
  CADDY_SERVE_HTML_SENTINEL,
  DEFAULT_WEBSITE_PAGES_DIR,
  SERVE_HTML_PAGES_DIR_ENV,
} from 'src/provider/caddy/caddy.provider';

/**
 * **降级发布**：数据库在启动期不可达时，让 caddy 直接发磁盘上的 ISR HTML，
 * 于是"已发布的内容"在 server 起不来的情况下**仍然对外可读**。
 *
 * ## 为什么这件事只需要写文件
 * `provider/caddy/caddy.provider.ts` 的头注释写明了机制：caddy 模板里有一条
 * `vanblog-serve-html` 路由，**按哨兵文件、每个请求现查**，所以档位切换
 * **不需要 reload caddy、也不依赖任何 Node 代码在跑**。这正好是降级驻留需要的性质 ——
 * 那时 Nest 应用根本没起来（只有一个占位监听器），任何"调 caddy admin API"或
 * "走 provider"的方案都不成立。
 *
 * ⚠️ 路径与文件名**从 caddy.provider 导入**，不在这里重抄一遍：
 * 抄一份就会漂，而漂了的表现是"降级时写了哨兵、caddy 却不认"——静默失效，最难查。
 *
 * ## 🔴 代价（必须如实，别把它当成"无损降级"）
 * 降级期间发出去的是**磁盘上最后一次成功渲染的 HTML**，所以：
 *  1. **内容可能陈旧**：停在最后一次渲染时的样子，数据库恢复前不会更新；
 *  2. **依赖 SSR 的功能全部失效**：访问密码文章、站内搜索、阅读数、按需渲染新文章、
 *     评论提交（waline 子进程也没起来）；
 *  3. ⚠️ **一条安全相关的残余风险**：正常情况下"不再可公开发布"的路径（deleted/hidden/private/
 *     加密分类/publishAt 未到）是由 `provider/isr/artifactReaper` 在每轮风暴收尾与周期对账时
 *     从盘上删掉三件套的 —— 而降级期间 **reaper 不在跑**。所以如果某篇文章是在数据库挂掉
 *     **之前的很短时间内**被改成私密/加密、而 reaper 还没来得及删它的 .html，
 *     降级期间这份旧 HTML 会被公开服务。窗口很窄（reaper 每轮风暴 + 周期对账都会扫），
 *     但不是零，所以这里写清楚，不假装没有。
 *  4. 但**已发布的内容仍然对外可读** —— 在"极端环境下要持续发布信息"的场景里，
 *     这是正确的取舍：陈旧但可读，优于完全下线。
 *
 * ## 与站长手动开关的关系
 * `VANBLOG_CADDY_SERVE_HTML` 的默认值**保持 off**（站长裁定：只在降级模式自动开）。
 * 所以本模块必须**记录降级前的哨兵状态并在恢复时还原**：如果站长本来就手动开了
 * `true`/`all`，降级结束不能把它关掉；如果本来没开，降级结束必须删干净，
 * 否则站点会一直停在"caddy 直发旧 HTML"的状态而没人知道。
 */

/** 哨兵所在目录（与 CaddyProvider 同一个解析口径）。 */
export function resolveServeHtmlSentinelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR;
}

/** 降级前哨兵的状态快照，用于恢复时**精确还原**。 */
export interface ServeHtmlSentinelSnapshot {
  dir: string;
  fixed: boolean;
  dynamic: boolean;
}

function sentinelPaths(dir: string) {
  return {
    fixed: path.join(dir, CADDY_SERVE_HTML_SENTINEL),
    dynamic: path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL),
  };
}

/**
 * 读当前哨兵状态。**绝不抛异常**：目录不存在（开发环境没有 website 构建产物）就是"两个都没有"。
 */
export function snapshotServeHtmlSentinels(
  dir: string = resolveServeHtmlSentinelDir(),
): ServeHtmlSentinelSnapshot {
  const p = sentinelPaths(dir);
  const exists = (f: string) => {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  };
  return { dir, fixed: exists(p.fixed), dynamic: exists(p.dynamic) };
}

export interface DegradedServeHtmlLog {
  warn(message: string): void;
  log(message: string): void;
}

/**
 * 进入降级发布：写**两个**哨兵（= `all` 档）。
 *
 * ⚠️ 为什么是 `all` 而不是只写固定页那一档：站长要的是"被打瘫时仍能发布内容"，
 * 而内容主要在 `/post/*`（动态前缀），只开固定页等于只保住了首页与几个列表页。
 * `all` 档在正常模式下有前提（ISR 必须是 onDemand，且依赖 artifactReaper 清理不再公开的路径），
 * 但降级期间**没有别的选项**：要么发磁盘上的旧 HTML，要么什么都不发。
 *
 * @returns 是否两个哨兵都写成功（写不进去 = 降级发布没生效，调用方要在日志里说清楚）
 */
export function enableDegradedServeHtml(
  options: { dir?: string; log?: DegradedServeHtmlLog } = {},
): boolean {
  const dir = options.dir ?? resolveServeHtmlSentinelDir();
  const log = options.log;
  const p = sentinelPaths(dir);
  const stamp =
    `level=all; degraded-hold (database unreachable at startup); ` +
    `written by main.ts at ${new Date().toISOString()}\n`;
  try {
    fs.writeFileSync(p.fixed, stamp);
    fs.writeFileSync(p.dynamic, stamp);
    return true;
  } catch (err) {
    // ⚠️ 写不进去不是致命错误，但**必须说出来**：否则运维会以为"caddy 在直发 HTML"，
    //    而实际上页面仍然是 502。这正是本仓库最忌讳的"看起来在工作其实没有"。
    log?.warn(
      `[degraded-hold] 降级发布哨兵写入失败（${(err as Error)?.message || err}）：` +
        `目录 ${dir} 可能不存在或只读 ⇒ caddy 不会直发磁盘上的 HTML，页面请求仍会 502。` +
        `（/static/* 不受影响，那是 caddy 自己的 file_server。）`,
    );
    return false;
  }
}

/**
 * 降级结束：**精确还原**到降级前的状态，而不是无条件删。
 *
 * ⚠️ 无条件删会关掉站长手动开的 `SERVE_HTML=true|all`；无条件留会让站点停在
 * "caddy 直发旧 HTML"的状态。所以按快照还原：原来有的写回去（内容换成一句说明，
 * 因为原内容只是一行时间戳，没有信息量），原来没有的删掉。
 * ⚠️ 还原之后 `CaddyProvider` 的 60 秒对账会按 env + ISR 模式接管为权威状态，
 * 这里只负责"别把降级状态留下去"。
 * **绝不抛异常**。
 */
export function restoreServeHtmlSentinels(
  snapshot: ServeHtmlSentinelSnapshot,
  options: { log?: DegradedServeHtmlLog } = {},
): void {
  const p = sentinelPaths(snapshot.dir);
  const stamp =
    `level=restored-after-degraded-hold; ` +
    `restored by main.ts at ${new Date().toISOString()}\n`;
  const apply = (file: string, wanted: boolean) => {
    try {
      if (wanted) {
        fs.writeFileSync(file, stamp);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      options.log?.warn(
        `[degraded-hold] 还原哨兵失败（${file}）：${(err as Error)?.message || err} —— ` +
          `CaddyProvider 的 60 秒对账会按设置接管，但如果站点表现为"一直在发旧 HTML"，请手工检查这个文件。`,
      );
    }
  };
  apply(p.fixed, snapshot.fixed);
  apply(p.dynamic, snapshot.dynamic);
}
