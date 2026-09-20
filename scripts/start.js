#! /usr/bin/env node
/**
 * 容器里的主进程：拉起 server（server 自己再拉起前台 Next 与 waline），并负责
 * **信号转发**、**子进程退出时让容器一起退出**、以及 stdio 日志的**大小轮转**。
 *
 * 这一份文件以前有三个只在生产容器里才会暴露的问题：
 * 1. `ctx.on('exit')` 只打印一行"已停止"，**自己不退出** → server 崩了之后容器仍然
 *    "Up"，docker 的 `restart: always` 也就永远不会拉起它，用户看到的是"站点打不开
 *    但容器在跑"（和 caddy 配置加载失败那次一模一样的症状）。
 * 2. 只处理了 SIGINT，而 `docker stop` 发的是 **SIGTERM** → node 直接被默认处理干掉，
 *    子进程收不到任何信号，谈不上优雅退出（正在写的备份/导出/上传会被截断）。
 *    而且原来那句 `process.kill(-ctx.pid, 'SIGINT')` 用的是**进程组**负 pid，
 *    但子进程 spawn 时没有 `detached: true`，根本没有独立进程组 → 抛 ESRCH。
 * 3. stdio 日志往 `/var/log/vanblog-*.log` **无限追加**，而 `/var/log` 是挂载到宿主机
 *    数据目录的卷 → 跑上几个月能把小机器的磁盘写满。
 *
 * ## 本轮新增：重启风暴熔断（进程/容器层）
 * 编排层的 `restart: always` 没有 backoff：如果故障是**持续**的（mongo 起不来、配置写坏、
 * 归档恢复失败），就是无限快速重拉 —— CPU 被打满、日志爆盘，而故障注入矩阵把这条列为"没有熔断"。
 * `deploy.restart_policy` 在 compose v1 / 非 swarm 下**不生效**，所以熔断只能做在进程里。
 *
 * ⚠️ 与 `packages/server/src/utils/clusterBootstrap.ts` 的 `maxFastCrashes`（默认 5）的**分工**：
 *  - 那个管的是 **cluster worker 层**：主进程数 worker 的崩溃窗口，超了主进程自己 exit(1)；
 *  - 这个管的是 **容器/进程层**：`start.js` 数 server 子进程的崩溃窗口，超了就**先睡再退**，
 *    于是 `restart: always` 的下一次拉起被推迟 —— 退避发生在容器**内部**，
 *    因为编排层的 backoff 在本项目支持的部署形态里并不可靠。
 *  两者不冲突：worker 崩溃 → 主进程 exit(1) → 子进程退出 → 这里计数。
 *
 * ⚠️ 状态存在**挂载的数据目录**（默认与日志同目录）而不是容器内：熔断要防的是
 * "跨容器重建仍然持续的故障"，存容器内的话每次重建就归零，等于没有熔断。
 * 代价是"故障修好之后可能还要等一次退避"，用两条来控制：退避**有上限**（默认 5 分钟），
 * 且**一次足够长的健康运行会把计数清零**。
 *    ⚠️ 但 `vanblog-stdio.log` 不能不写：后台「查看日志」读的就是它
 *    （`packages/server/src/provider/log/log.provider.ts` 的 `systemLogPath`），
 *    所以是**轮转**而不是删掉。
 */
const { spawn } = require('child_process');
const { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('fs');
const { join } = require('path');

let logPath = `/var/log/`;
if (process.platform === 'win32') {
  logPath = join(__dirname, '../log');
}
const logPathEnv = process.env.VAN_BLOG_LOG;
if (logPathEnv) {
  logPath = logPathEnv;
}

// server 的工作目录。默认就是镜像里的布局；开成环境变量是为了能在容器外做行为测试。
const serverCwd = process.env.VAN_BLOG_SERVER_CWD || '/app/server';
// 单个 stdio 日志文件的上限（默认 20MB），超了就轮转成 .old（只留一份旧的）
const maxLogBytes = Number(process.env.VAN_BLOG_STDIO_LOG_MAX_BYTES || 20 * 1024 * 1024);
// 等子进程优雅退出的时间，超时就硬退（别让 docker 等满 10s 宽限期再 SIGKILL）
const shutdownTimeoutMs = Number(process.env.VAN_BLOG_SHUTDOWN_TIMEOUT_MS || 8000);

// ---- 重启风暴熔断的配置（全部可配，垃圾值回落默认；⚠️ 0 不是"关闭"，见 numOr 的注释）----
/** 数值环境变量的读取：缺失/空/非数字/NaN/Infinity/≤0 一律回落默认。 */
function numOr(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
/** 统计窗口（毫秒）：只有落在这个窗口内的快速崩溃才累计。默认 10 分钟。 */
const crashWindowMs = numOr(process.env.VANBLOG_CRASH_WINDOW_MS, 600000);
/** 窗口内允许的快速崩溃次数，达到就开始退避。默认 5。 */
const maxFastCrashes = numOr(process.env.VANBLOG_MAX_FAST_CRASHES, 5);
/** "快速崩溃"的判据：子进程存活短于这个时长就算一次（长于它说明启动成功过）。默认 60 秒。 */
const fastCrashMs = numOr(process.env.VANBLOG_FAST_CRASH_MS, 60000);
/** 退避基数与上限。默认 5 秒起、封顶 5 分钟。 */
const crashBackoffBaseMs = numOr(process.env.VANBLOG_CRASH_BACKOFF_BASE_MS, 5000);
const crashBackoffMaxMs = Math.max(
  crashBackoffBaseMs,
  numOr(process.env.VANBLOG_CRASH_BACKOFF_MAX_MS, 300000),
);
/**
 * 崩溃计数状态文件。
 * ⚠️ 默认放在 `logPath`（= 挂载到宿主机数据目录的卷）里，所以**跨容器重建仍然有效**；
 * 写在容器内则每次重建归零，熔断形同不存在。
 */
const crashStatePath = process.env.VAN_BLOG_CRASH_STATE_FILE || join(logPath, 'vanblog-crash-state.json');

function readCrashState() {
  try {
    const parsed = JSON.parse(readFileSync(crashStatePath, 'utf8'));
    if (parsed && Array.isArray(parsed.fastCrashes)) {
      // ⚠️ 只接受"有限的正数时间戳"，坏数据当空数组处理：
      //    状态文件损坏绝不能让主进程崩掉（那本身就是它要防的故障）。
      return parsed.fastCrashes.filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    }
  } catch {
    // 文件不存在 / JSON 坏了 ⇒ 从零开始
  }
  return [];
}

function writeCrashState(list) {
  try {
    writeFileSync(crashStatePath, `${JSON.stringify({ fastCrashes: list, updatedAt: new Date().toISOString() })}\n`);
  } catch {
    // 写不进去（只读卷等）时**不要**影响退出流程；代价只是熔断在下次重建后失效，
    // 而"因为写不了状态文件就不退出"会让容器停在 Up 但无服务的状态 —— 那更糟。
  }
}

/** 第 n 次超阈值崩溃要睡多久：指数退避 + 封顶。⚠️ 用 Math.min 防止 2^n 溢出成 Infinity。 */
function crashBackoffMs(overBy) {
  const raw = crashBackoffBaseMs * 2 ** Math.max(0, overBy);
  if (!Number.isFinite(raw)) {
    return crashBackoffMaxMs;
  }
  return Math.min(Math.max(0, Math.floor(raw)), crashBackoffMaxMs);
}

/** 每个文件维护一个内存里的累计大小，避免每条日志都 statSync 一次 */
const logSizes = new Map();

function rotateIfNeeded(file) {
  let size = logSizes.get(file);
  if (size === undefined) {
    try {
      size = statSync(file).size;
    } catch {
      size = 0; // 文件还不存在
    }
    logSizes.set(file, size);
  }
  if (size < maxLogBytes) {
    return;
  }
  try {
    rmSync(`${file}.old`, { force: true });
    renameSync(file, `${file}.old`);
    logSizes.set(file, 0);
  } catch {
    // 轮转失败不该影响主流程（大不了继续追加）
  }
}

const printLog = (string, isError = false) => {
  // 后台「查看日志」读的是 vanblog-stdio.log，另外两份按流分开，方便排查
  const names = [`vanblog-${isError ? 'stderr' : 'stdout'}.log`, 'vanblog-stdio.log'];
  for (const name of names) {
    const file = join(logPath, name);
    try {
      rotateIfNeeded(file);
      appendFileSync(file, string);
      logSizes.set(file, (logSizes.get(file) || 0) + Buffer.byteLength(string));
    } catch {
      // 日志目录不可写（比如没挂卷）时不要因为写日志把进程带崩
    }
  }
};

/** 子进程这一次启动的时刻：用来判断"活多久算崩溃"。 */
const childStartedAt = Date.now();

const ctx = spawn('node', ['main.js'], {
  cwd: serverCwd,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
  },
});

let shuttingDown = false;

ctx.on('exit', (code, signal) => {
  if (shuttingDown) {
    return; // 由 shutdown() 里的 once('exit') 决定退出码
  }
  const exitCode = typeof code === 'number' ? code : 1;
  // ⚠️ 关键：子进程死了，本进程也必须死。
  // 否则容器停在"Up"状态但里面没有任何服务，restart 策略也就永远不会介入。
  process.stderr.write(
    `[vanblog] server 进程已退出（code=${code} signal=${signal}），容器随之退出以便 restart 策略重新拉起\n`,
  );

  // ---- 重启风暴熔断 ----
  const runMs = Date.now() - childStartedAt;
  const now = Date.now();
  let crashes = readCrashState().filter((t) => now - t <= crashWindowMs);
  if (runMs >= fastCrashMs) {
    // 活过了"快速崩溃"阈值 ⇒ 说明它确实启动成功过一段时间，之前的风暴已经结束，清零。
    // ⚠️ 这条很重要：否则一次历史故障会让之后每次正常的偶发崩溃都被退避拖慢。
    if (crashes.length > 0) {
      process.stdout.write(
        `[vanblog] server 本次存活 ${Math.round(runMs / 1000)}s（≥ ${Math.round(fastCrashMs / 1000)}s），` +
          `视为已恢复正常，清空重启风暴计数（原有 ${crashes.length} 次）\n`,
      );
    }
    crashes = [];
    writeCrashState(crashes);
    process.exit(exitCode);
    return;
  }
  crashes.push(now);
  writeCrashState(crashes);

  if (crashes.length < maxFastCrashes) {
    process.exit(exitCode);
    return;
  }
  const overBy = crashes.length - maxFastCrashes;
  const delayMs = crashBackoffMs(overBy);
  // ⚠️ 退避发生在**退出之前**：编排层收到退出后会立刻重拉，所以"先睡再退"才是真正在给
  //    重启循环降速；睡在启动之后（下一次容器里）效果一样，但那样日志会分散在两次启动里，更难读。
  // ⚠️ 睡的时候 `docker stop` 仍然有效：shutdown() 有 shutdownTimeoutMs（默认 8s）的硬超时，
  //    到点直接 exit(1)，所以退避不会让容器变成"停不下来"。
  process.stderr.write(
    `[FATAL][vanblog] 重启风暴熔断：最近 ${Math.round(crashWindowMs / 60000)} 分钟内已经快速崩溃 ` +
      `${crashes.length} 次（阈值 ${maxFastCrashes}，"快速"= 存活不足 ${Math.round(fastCrashMs / 1000)}s），` +
      `本次退出前先等 ${Math.round(delayMs / 1000)}s，以免 restart 策略把 CPU 打满、把日志写爆。\n` +
      `[FATAL][vanblog] ⚠️ 请查**上面第一条**错误：熔断只是降速，不解决故障。常见原因是数据库起不来、` +
      `配置写坏、或恢复失败；可先跑 ./vanblog.sh doctor。\n` +
      `[FATAL][vanblog] 计数存在 ${crashStatePath}（挂载卷内，跨容器重建有效）。退避上限 ` +
      `${Math.round(crashBackoffMaxMs / 1000)}s；一次存活超过 ${Math.round(fastCrashMs / 1000)}s 的运行会自动清零计数。\n`,
  );
  const timer = setTimeout(() => process.exit(exitCode), delayMs);
  // ⚠️ 不要 unref：unref 之后事件循环没有别的工作，进程可能在退避结束前就自然退出了，
  //    那样熔断等于没生效（而且退出码会变成 0，编排层就不重拉了）。
  if (typeof timer.unref === 'function') {
    // 显式什么都不做，保留引用
  }
});

ctx.stdout.on('data', (data) => {
  printLog(data.toString(), false);
  process.stdout.write(data.toString());
});
ctx.stderr.on('data', (data) => {
  printLog(data.toString(), true);
  process.stderr.write(data.toString());
});

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[vanblog] 收到 ${signal}，通知 server 优雅退出（最多等 ${shutdownTimeoutMs}ms）`);
  const timer = setTimeout(() => {
    process.stderr.write('[vanblog] server 未在限定时间内退出，强制结束\n');
    process.exit(1);
  }, shutdownTimeoutMs);
  // 别 unref：unref 之后本进程可能在子进程收尾前就自己退出了
  ctx.once('exit', (code) => {
    clearTimeout(timer);
    process.exit(typeof code === 'number' ? code : 0);
  });
  try {
    // 用 ctx.kill 而不是 process.kill(-pid)：子进程没有独立进程组，负 pid 会抛 ESRCH。
    // 统一转发 SIGTERM —— Nest 的 shutdown hooks（关连接、停前台、flush 日志）挂在它上面。
    ctx.kill('SIGTERM');
  } catch (err) {
    process.stderr.write(`[vanblog] 转发信号失败：${err && err.message}\n`);
    process.exit(1);
  }
}

// docker stop 发 SIGTERM；Ctrl-C 是 SIGINT；SIGHUP 顺手也接上
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
