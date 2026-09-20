import * as fs from 'fs';
import * as path from 'path';
import {
  CADDY_SERVE_HTML_DYNAMIC_SENTINEL,
  CADDY_SERVE_HTML_SENTINEL,
  DEFAULT_WEBSITE_PAGES_DIR,
  SERVE_HTML_PAGES_DIR_ENV,
  resolveWebsitePagesDir,
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
 * ## 🔴 本模块的失败契约：**任何函数都绝不抛异常**
 * 这些函数只在「降级驻留」这条路径上被调用 —— 也就是数据库在启动期一直连不上、
 * 进程**必须活下去**的时刻。一个"尽力而为的辅助步骤"在这里抛异常，后果是
 * `main()` 的 `.catch()` 把整个启动打死、退出码 1、容器重启 ⇒ 从"降级但仍在发布"
 * 直接掉回"完全下线"，而这恰恰是本模块存在的理由。
 *
 * ⚠️ 这条契约曾经**只在注释里成立**：`snapshotServeHtmlSentinels` 与
 * `enableDegradedServeHtml` 里的目录解析都写在 try 之外，所以解析一抛就穿透出去。
 * 实测事故（2026-09-20，活体日志）：降级驻留已经打出完整的三条下一步之后，
 * `snapshotServeHtmlSentinels` 抛 TypeError，进程退出码 1。
 * 那一次的直接原因是验证脚手架的混代产物（见 AGENTS.md §7.79c），**但暴露的缺陷是真的**：
 * 生产里同样会触发的形状有 pages 目录不可读/不可写（只读挂载、权限不对、卷没挂上、目录被删）、
 * 磁盘满（ENOSPC）、EACCES/EROFS。
 *
 * ⇒ 所以这里是**两层防护**：本模块每个导出函数自己兜住一切异常（含日志器本身抛异常），
 *   调用方 `main.ts` 另外再包一层（防"模块本身坏了"这种连函数都调不到的情况）。
 *
 * ## 与站长手动开关的关系
 * `VANBLOG_CADDY_SERVE_HTML` 的默认值**保持 off**（站长裁定：只在降级模式自动开）。
 * 所以本模块必须**记录降级前的哨兵状态并在恢复时还原**：如果站长本来就手动开了
 * `true`/`all`，降级结束不能把它关掉；如果本来没开，降级结束必须删干净，
 * 否则站点会一直停在"caddy 直发旧 HTML"的状态而没人知道。
 *
 * ⚠️ 已核实（2026-09-20，从代码而非推断）：**默认配置下降级发布就是生效的**。
 * `scripts/caddyConfig.js` 里 `VANBLOG_CADDY_SERVE_HTML` 只出现在**注释**中（生成器不读这个开关），
 * 生成器也从不删除 `vanblog-serve-html` 路由；模板里那条路由的闸门是
 * `file: {try_files: ["/.vanblog-caddy-serve-html"]}`（与 `-dynamic` 那条），即**纯文件存在性判断**。
 * ⇒ 哨兵一写出来，caddy 下一个请求就会直发磁盘 HTML，不需要 reload、不需要任何 env。
 * 那个 env 只决定**正常模式下** CaddyProvider 要不要写哨兵。
 * 另外：降级驻留期间 Nest 没起来 ⇒ CaddyProvider 的 60 秒对账也不在跑 ⇒ 不会把我们的哨兵删掉。
 */

/**
 * 打一条 WARN，**并且保证日志器自己抛异常也不会穿透**。
 *
 * ⚠️ 这不是多余的：降级驻留期间 `main.ts` 传进来的是直接写 `console.warn` 的对象，
 * 但"日志器坏了"恰恰是最不该让进程死掉的一类故障 —— 而且本模块的全部价值就是
 * "把失败说出来"，如果说的动作本身会杀进程，那就本末倒置了。
 */
function safeWarn(log: DegradedServeHtmlLog | undefined, message: string): void {
  try {
    log?.warn(message);
  } catch {
    // 日志器本身坏了：退到 console，再坏就只能放弃（绝不 rethrow）
    try {
      // eslint-disable-next-line no-console
      console.warn(message);
    } catch {
      /* 无处可说，但绝不能因此让启动流程死掉 */
    }
  }
}

/** 把一个未知异常变成一行可读的原因（`err.message` 可能不存在）。 */
function errText(err: unknown): string {
  return (err as Error)?.message || String(err);
}

/**
 * 哨兵所在目录（与 CaddyProvider、artifactReaper **同一个**解析口径）。
 *
 * ⚠️ 这里必须走共用的 `resolveWebsitePagesDir()`，不能是裸 `env || DEFAULT`：
 * 生成器侧会拒绝非法值并回落模板默认目录，服务端若照用非法值，哨兵就会写到一个
 * caddy 根本不看的地方 ⇒ 降级发布**静默失效**（而降级发布正是"数据库起不来时仍能
 * 对外发布内容"的唯一机制，它的失效必须是大声的）。
 *
 * @param log 可选。给了就把"值被拒绝/被规范化"的 WARN 打出来 —— 降级驻留期间
 *            Nest 还没起来，这条日志是运维唯一能看到的线索，所以调用方应当传。
 *
 * 🔴 **绝不抛异常**：解析失败（共用解析器不可用、env 对象异常等）时回落到
 * `DEFAULT_WEBSITE_PAGES_DIR` 并打 WARN。回落而不是抛，是因为这一步服务于
 * "数据库起不来时仍能对外发布内容"，而抛异常会让整个启动流程死掉 —— 那是严格更糟的结果。
 */
export function resolveServeHtmlSentinelDir(
  env: NodeJS.ProcessEnv = process.env,
  log?: DegradedServeHtmlLog,
): string {
  try {
    const resolved = resolveWebsitePagesDir(env?.[SERVE_HTML_PAGES_DIR_ENV]);
    for (const w of resolved.warns) safeWarn(log, `[degraded-hold] ${w}`);
    // ⚠️ 再兜一层：解析器返回空/非字符串时也不能让 path.join 抛 TypeError
    return typeof resolved?.dir === 'string' && resolved.dir
      ? resolved.dir
      : DEFAULT_WEBSITE_PAGES_DIR;
  } catch (err) {
    safeWarn(
      log,
      `[degraded-hold] 解析哨兵目录失败（${errText(err)}）：回落到镜像默认目录 ${DEFAULT_WEBSITE_PAGES_DIR}。` +
        `影响：如果 ${SERVE_HTML_PAGES_DIR_ENV} 本来指向别处，caddy 会去那里找哨兵、而我们写在默认目录 ⇒ ` +
        `降级发布这一次不生效（页面仍 502），但 /api/public/health 与 /static/* 不受影响，启动流程继续。`,
    );
    return DEFAULT_WEBSITE_PAGES_DIR;
  }
}

/** 降级前哨兵的状态快照，用于恢复时**精确还原**。 */
export interface ServeHtmlSentinelSnapshot {
  dir: string;
  fixed: boolean;
  dynamic: boolean;
  /**
   * 🔴 快照**读失败**时为 true。此时 `fixed`/`dynamic` 是**猜测值**（都是 false），不可信。
   *
   * ⚠️ 为什么不能直接把它们当 false 用：`restoreServeHtmlSentinels` 会按快照"原来没有的删掉"，
   * 于是"读不到状态"会被当成"原来没有" ⇒ **误删站长手动开的 `SERVE_HTML=true|all`**。
   * 那是把一个可用性故障升级成配置丢失。所以读失败时必须**什么都不做**，
   * 交给 CaddyProvider 的 60 秒对账按 env + ISR 模式接管为权威状态（它本来就会接管）。
   */
  readFailed?: boolean;
}

function sentinelPaths(dir: string) {
  return {
    fixed: path.join(dir, CADDY_SERVE_HTML_SENTINEL),
    dynamic: path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL),
  };
}

/**
 * 读当前哨兵状态。**绝不抛异常**：目录不存在（开发环境没有 website 构建产物）就是"两个都没有"。
 *
 * ⚠️ "目录不存在"与"**读不了**"是两件不同的事，必须区分：前者是正常状态（两个都 false，可信），
 * 后者是故障（状态未知 ⇒ `readFailed: true`，还原时会跳过而不是误删）。
 * 🔴 这里连**默认参数的求值**也一起兜住了：`resolveServeHtmlSentinelDir()` 写在默认参数位置上，
 * 它在 try 之外求值，所以之前"绝不抛异常"这句只是注释里的愿望（实测就是这样穿透出去的）。
 */
export function snapshotServeHtmlSentinels(
  dir?: string,
  log?: DegradedServeHtmlLog,
): ServeHtmlSentinelSnapshot {
  let resolvedDir = dir;
  try {
    if (typeof resolvedDir !== 'string' || !resolvedDir) {
      resolvedDir = resolveServeHtmlSentinelDir(process.env, log);
    }
    const p = sentinelPaths(resolvedDir);
    // ⚠️ 刻意用 `accessSync` 而不是 `existsSync`：后者**吞掉一切错误只返回 false**，
    //    于是"父目录没权限/父路径是个文件"（EACCES/ENOTDIR）会被当成"哨兵不存在"⇒
    //    快照变成一份**自信的猜测**，而还原时会照它去删 ⇒ 误删站长手动开的 SERVE_HTML。
    //    用 accessSync 才能把"真的没有"（ENOENT）与"读不出来"（其它错误）分开。
    const exists = (f: string): boolean => {
      try {
        fs.accessSync(f);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return false; // 确实不存在 ⇒ 可信的 false
        }
        throw new Error(`哨兵状态不可读（${f}）：${errText(err)}`);
      }
    };
    return { dir: resolvedDir, fixed: exists(p.fixed), dynamic: exists(p.dynamic) };
  } catch (err) {
    const fallbackDir =
      typeof resolvedDir === 'string' && resolvedDir ? resolvedDir : DEFAULT_WEBSITE_PAGES_DIR;
    safeWarn(
      log,
      `[degraded-hold] 读取降级发布哨兵状态失败（${errText(err)}）：无法知道降级前哨兵是否已存在。` +
        `影响：①降级发布本身不受影响（仍会尝试写哨兵）；②**恢复时会跳过还原**，` +
        `以免把站长手动开的 SERVE_HTML 误删 —— 代价是哨兵可能残留，` +
        `CaddyProvider 的 60 秒对账会按设置接管；若站点表现为"一直在发旧 HTML"，` +
        `手工检查并删除 ${fallbackDir} 下的 ${CADDY_SERVE_HTML_SENTINEL} 与 ${CADDY_SERVE_HTML_DYNAMIC_SENTINEL}。` +
        `启动流程继续，不需要处理。`,
    );
    return { dir: fallbackDir, fixed: false, dynamic: false, readFailed: true };
  }
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
 *
 * 🔴 **绝不抛异常**。⚠️ 之前目录解析写在 try 之外，所以解析一抛就穿透到 `main()`；
 * 现在整段（解析 + 拼路径 + 写文件）都在 try 里。
 */
export function enableDegradedServeHtml(
  options: { dir?: string; log?: DegradedServeHtmlLog } = {},
): boolean {
  const log = options.log;
  let dir = options.dir;
  try {
    if (typeof dir !== 'string' || !dir) {
      dir = resolveServeHtmlSentinelDir(process.env, log);
    }
    const p = sentinelPaths(dir);
    const stamp =
      `level=all; degraded-hold (database unreachable at startup); ` +
      `written by main.ts at ${new Date().toISOString()}\n`;
    fs.writeFileSync(p.fixed, stamp);
    fs.writeFileSync(p.dynamic, stamp);
    return true;
  } catch (err) {
    // ⚠️ 写不进去不是致命错误，但**必须说出来**：否则运维会以为"caddy 在直发 HTML"，
    //    而实际上页面仍然是 502。这正是本仓库最忌讳的"看起来在工作其实没有"。
    safeWarn(
      log,
      `[degraded-hold] 降级发布哨兵写入失败（${errText(err)}）：` +
        `目录 ${dir || '(未能解析)'} 可能不存在或只读 ⇒ caddy 不会直发磁盘上的 HTML，页面请求仍会 502。` +
        `（/api/public/health 与 /static/* 不受影响：前者由占位服务给，后者是 caddy 自己的 file_server。）` +
        `要不要处理：想让页面也能发，就确认 pages 目录存在且可写` +
        `（默认 ${DEFAULT_WEBSITE_PAGES_DIR}，或检查 ${SERVE_HTML_PAGES_DIR_ENV} 是否指错了地方）；` +
        `不处理也不影响数据库恢复后自动回到正常模式。`,
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
 *
 * 🔴 **绝不抛异常**，且有两种"什么都不做"的情况，都必须大声说：
 *  1. `snapshot.readFailed` ⇒ **跳过还原**。因为此时 `fixed`/`dynamic` 是猜测值（都 false），
 *     照它还原等于"无条件删" ⇒ 会误删站长手动开的 `SERVE_HTML=true|all`。
 *     把可用性故障升级成配置丢失是严格更糟的方向；哨兵残留则由 60 秒对账兜住。
 *  2. 单个文件写/删失败 ⇒ 只对该文件 WARN，另一个继续处理（`apply` 内部各自兜住）。
 */
export function restoreServeHtmlSentinels(
  snapshot: ServeHtmlSentinelSnapshot,
  options: { log?: DegradedServeHtmlLog } = {},
): void {
  const log = options.log;
  try {
    if (!snapshot || typeof snapshot !== 'object') {
      safeWarn(
        log,
        `[degraded-hold] 没有可用的哨兵快照（值为 ${String(snapshot)}）⇒ 跳过还原。` +
          `后果：降级期写的哨兵可能残留，CaddyProvider 的 60 秒对账会按设置接管。`,
      );
      return;
    }
    if (snapshot.readFailed) {
      // 🔴 宁可按"对账会接管"处理，也不要拿一份猜测值去删站长的配置。
      safeWarn(
        log,
        `[degraded-hold] 降级前没能读到哨兵状态 ⇒ **跳过还原**（不猜、不删）。` +
          `后果：${snapshot.dir} 下的 ${CADDY_SERVE_HTML_SENTINEL} 与 ` +
          `${CADDY_SERVE_HTML_DYNAMIC_SENTINEL} 可能残留，站点会继续由 caddy 直发磁盘上的旧 HTML，` +
          `直到 CaddyProvider 的 60 秒对账按设置接管。` +
          `若 60 秒后仍在发旧 HTML，手工删除上面那两个文件即可。`,
      );
      return;
    }
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
        safeWarn(
          log,
          `[degraded-hold] 还原哨兵失败（${file}）：${errText(err)} —— ` +
            `CaddyProvider 的 60 秒对账会按设置接管，但如果站点表现为"一直在发旧 HTML"，` +
            `请手工检查/删除这个文件。站点已回到正常模式，这一条不需要立刻处理。`,
        );
      }
    };
    apply(p.fixed, snapshot.fixed);
    apply(p.dynamic, snapshot.dynamic);
  } catch (err) {
    // 兜底：连 sentinelPaths 都可能抛（快照里的 dir 不是字符串时 path.join 会 TypeError）
    safeWarn(
      log,
      `[degraded-hold] 还原哨兵的过程本身出错（${errText(err)}）⇒ 已放弃还原。` +
        `后果：哨兵可能残留、站点继续由 caddy 直发旧 HTML；CaddyProvider 的 60 秒对账会接管，` +
        `必要时手工删除 ${DEFAULT_WEBSITE_PAGES_DIR} 下的 ${CADDY_SERVE_HTML_SENTINEL} 与 ` +
        `${CADDY_SERVE_HTML_DYNAMIC_SENTINEL}。`,
    );
  }
}

/** 进入降级发布的结果，供 `main.ts` 打日志与恢复时使用。 */
export interface DegradedPublishingOutcome {
  /** 降级前的哨兵快照；读取失败时 `readFailed: true`（此时还原会跳过）。 */
  snapshot: ServeHtmlSentinelSnapshot;
  /** 两个哨兵是否都写成功。false ⇒ 降级发布这次没生效（页面仍 502）。 */
  enabled: boolean;
  /** 只有"连快照/写入这两个调用本身都抛了"时才有值（ defence in depth 的最外层）。 */
  error?: string;
}

/**
 * 进入「降级发布」：读快照 + 写哨兵，**整体绝不抛异常**。
 *
 * 🔴 这是 `main.ts` 在降级驻留路径上唯一该调的入口。把两步合起来包一层的原因不只是省事：
 * 实测事故里穿透出去的正是**快照那一步**，而它当时还没被任何 try 包住 —— 也就是说
 * "每个函数各自兜住"仍然不够，调用方还需要一层，因为**模块本身坏了**（例如混代产物里
 * 某个 import 是 undefined）时连函数都调不到。所以这里是两层防护的内层。
 */
export function enterDegradedPublishing(log?: DegradedServeHtmlLog): DegradedPublishingOutcome {
  const fallbackSnapshot: ServeHtmlSentinelSnapshot = {
    dir: DEFAULT_WEBSITE_PAGES_DIR,
    fixed: false,
    dynamic: false,
    readFailed: true,
  };
  try {
    const snapshot = snapshotServeHtmlSentinels(undefined, log);
    const enabled = enableDegradedServeHtml({ log });
    return { snapshot, enabled };
  } catch (err) {
    safeWarn(
      log,
      `[degraded-hold] 进入降级发布这一步整体失败（${errText(err)}）⇒ 跳过降级发布。` +
        `影响：数据库不可达期间**页面**（/、/post/*）会 502；` +
        `/api/public/health 仍返回 503 degraded、/static/*（图片附件）仍由 caddy 直服。` +
        `数据库一通仍会自动完成启动，**不需要重启容器**。`,
    );
    return { snapshot: fallbackSnapshot, enabled: false, error: errText(err) };
  }
}

/**
 * 退出「降级发布」：按快照还原哨兵，**整体绝不抛异常**。
 *
 * ⚠️ 必须与 `enterDegradedPublishing` 成对使用，并且**只在 bootstrap 成功之后**调用：
 * 它失败的唯一后果是哨兵可能残留（60 秒对账会接管），
 * 绝不该让"启动已经成功"这件事被回滚成退出码 1。
 */
export function exitDegradedPublishing(
  outcome: DegradedPublishingOutcome | null | undefined,
  log?: DegradedServeHtmlLog,
): void {
  try {
    if (!outcome) {
      return; // 没进入过降级发布（例如占位服务都没起来）⇒ 没有要还原的东西
    }
    restoreServeHtmlSentinels(outcome.snapshot, { log });
  } catch (err) {
    safeWarn(
      log,
      `[degraded-hold] 退出降级发布这一步整体失败（${errText(err)}）⇒ 哨兵可能残留。` +
        `影响：站点可能继续由 caddy 直发磁盘上的旧 HTML；CaddyProvider 的 60 秒对账会按设置接管，` +
        `必要时手工删除 ${DEFAULT_WEBSITE_PAGES_DIR} 下的 ${CADDY_SERVE_HTML_SENTINEL} 与 ` +
        `${CADDY_SERVE_HTML_DYNAMIC_SENTINEL}。站点已回到正常模式，这一条不需要立刻处理。`,
    );
  }
}
