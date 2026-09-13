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
 *    ⚠️ 但 `vanblog-stdio.log` 不能不写：后台「查看日志」读的就是它
 *    （`packages/server/src/provider/log/log.provider.ts` 的 `systemLogPath`），
 *    所以是**轮转**而不是删掉。
 */
const { spawn } = require('child_process');
const { appendFileSync, renameSync, rmSync, statSync } = require('fs');
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
  // ⚠️ 关键：子进程死了，本进程也必须死。
  // 否则容器停在"Up"状态但里面没有任何服务，restart 策略也就永远不会介入。
  process.stderr.write(
    `[vanblog] server 进程已退出（code=${code} signal=${signal}），容器随之退出以便 restart 策略重新拉起\n`,
  );
  process.exit(typeof code === 'number' ? code : 1);
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
