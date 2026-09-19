/**
 * `uncaughtException` 必须退出（非 0），`unhandledRejection` 必须**不**退出。
 *
 * ## 为什么这两个的处理必须不一样
 * - `unhandledRejection`：这个仓库有大量 fire-and-forget 的写库（浏览计数、菜单清洗、sitemap 生成…），
 *   一次 Mongo 抖动不该带走整个 server ⇒ 只记日志是对的，别动它。
 * - `uncaughtException`：Node 官方明确说此时进程处于**未定义状态**，继续跑不安全。
 *   更实际的是它把 `scripts/start.js` 刚修掉的事故放回来了 —— start.js 的重写目的就是
 *   "子进程退出 ⇒ 容器退出 ⇒ `restart: always` 介入"（见它的头注释与 :88-99）。
 *   只记不退 ⇒ 容器一直 Up、健康检查一直 200、重启策略永不触发，站点却可能已经半死，
 *   日志里只有一行没有上下文的异常。本轮就有一个真实来源：备份的 NDJSON 写流缺 error 监听，
 *   ENOSPC 时错误正是以"EventEmitter 'error' 无监听者"的形式落到这里。
 *
 * ## cluster 模式下退出会不会与主进程的重启逻辑打架？
 * 不会，而且退出正是那套逻辑期望的输入：worker 退出 → 主进程按 `utils/clusterBootstrap.ts`
 * 的崩溃窗口计数重拉；短时间内崩太多次（maxFastCrashes）→ 主进程自己 exit(1) → 容器重启。
 * "把坏掉的 worker 换掉"是它设计出来要做的事；继续带着未定义状态服务请求才是与它冲突的选择。
 *
 * ⚠️ 这些是**源码级**断言，不是行为级：在 jest 里真的触发 uncaughtException 会把测试进程带走。
 * 所以每条"不存在"断言都配了"跑在旧形状上必须命中"的反证，避免空转。
 */
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = stripCommentsForAnchor(readFileSync(join(__dirname, '../main.ts'), 'utf8'));

/** 取出某个 process.on 处理器的那一段源码（到下一个 process.on 或段落末尾为止）。 */
function handlerBlock(event: string): string {
  const start = src.indexOf(`process.on('${event}'`);
  expect(start).toBeGreaterThan(0);
  const rest = src.slice(start);
  const next = rest.slice(10).search(/process\.on\('/);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

describe('uncaughtException：记 FATAL + 优雅清理 + 非 0 退出', () => {
  const block = handlerBlock('uncaughtException');

  it('打了带 FATAL 标记的日志，并说明"进程将退出以便容器重启策略接管"', () => {
    expect(block).toMatch(/\[FATAL\]\[uncaughtException\]/);
    expect(block).toMatch(/进程将退出/);
  });

  it('退出码是 1（非 0）—— 干净退出会让编排系统既不告警也不重启', () => {
    expect(block).toMatch(/process\.exit\(1\)/);
    expect(block).not.toMatch(/process\.exit\(0\)/);
  });

  it('有硬上限定时器，且成功走完清理后会 clearTimeout（不会白等）', () => {
    expect(block).toMatch(/FATAL_EXIT_HARD_LIMIT_MS/);
    expect(block).toMatch(/clearTimeout\(hardExit\)/);
    expect(block).toMatch(/优雅退出超时，强制 exit\(1\)/);
  });

  it('通过钩子复用 gracefulShutdown 的清理链（flush 浏览统计 → 停 waline/前台 → 关 HTTP）', () => {
    expect(block).toMatch(/fatalShutdownHook \? fatalShutdownHook\('uncaughtException'\) : undefined/);
    // 钩子赋值与退出码传参
    expect(src).toMatch(/fatalShutdownHook = \(reason: string\) => gracefulShutdown\(reason, 1\);/);
    expect(src).toMatch(/const gracefulShutdown = async \(signal: string, exitCode = 0\) => \{/);
    expect(src).toMatch(/process\.exit\(exitCode\);/);
  });

  it('清理失败不会卡住退出（catch 之后仍然走到 exit）', () => {
    expect(block).toMatch(/退出前的清理失败/);
    expect(block.indexOf('.catch(')).toBeLessThan(block.indexOf('clearTimeout(hardExit)'));
  });

  it('⚠️ 反证的反证：把上面几条跑在**旧形状**上，必须能命中旧写法（证明断言不是空的）', () => {
    const oldShape = `process.on('uncaughtException', (error: Error) => {
      console.error(\`[uncaughtException] \${error?.stack}\`);
    });`;
    expect(oldShape).toMatch(/process\.on\('uncaughtException'/);
    expect(oldShape).not.toMatch(/process\.exit\(1\)/);
    expect(oldShape).not.toMatch(/\[FATAL\]/);
  });

  it('⚠️ 退出逻辑必须是**真的会执行**的语句，不能被短路掉', () => {
    // 变异对照第一次跑发现：把清理链包进 `if (false) Promise.resolve()…` 之后，
    // 上面所有"包含某子串"的断言**依然全绿** —— 子串还在，只是永远不会执行。
    // 所以这里钉**结构**：Promise 链必须是处理器体内的顶层语句（4 空格缩进、行首就是它），
    // 且整个 main.ts 里不许出现 `if (false)` 这种"关掉一段代码"的写法。
    expect(block).toMatch(/^ {4}Promise\.resolve\(\)$/m);
    expect(block).not.toMatch(/if \(false\)/);
    expect(src).not.toMatch(/if \(false\)/);
    // 硬上限那条 exit(1) 也必须是定时器回调里的真语句
    expect(block).toMatch(/^ {6}process\.exit\(1\);$/m);
  });

  it('⚠️ 上面那条结构断言跑在被短路的形状上必须不命中（否则它自己也是空的）', () => {
    const shortCircuited = "    if (false) Promise.resolve()\n      .then(() => {});";
    expect(shortCircuited).not.toMatch(/^ {4}Promise\.resolve\(\)$/m);
    expect(shortCircuited).toMatch(/if \(false\)/);
  });
});

describe('unhandledRejection：仍然只记日志，不许顺手也改成退出', () => {
  const block = handlerBlock('unhandledRejection');

  it('保留了 process.on("unhandledRejection") 与日志（既有跨包锚点也钉着它）', () => {
    expect(block).toMatch(/\[unhandledRejection\]/);
  });

  it('⚠️ 这一段里没有任何退出调用（fire-and-forget 写库很多，一次抖动不该带走 server）', () => {
    expect(block).not.toMatch(/process\.exit\(/);
    expect(block).not.toMatch(/fatalShutdownHook/);
  });

  it('反证的反证：如果真被改成退出，上面那条断言会命中', () => {
    const badShape = "process.on('unhandledRejection', () => { process.exit(1); });";
    expect(badShape).toMatch(/process\.exit\(/);
  });
});

describe('正常停机路径没有被这次改动破坏', () => {
  it('三个信号仍然接上，且默认退出码是 0', () => {
    expect(src).toMatch(/process\.on\('SIGINT', \(\) => void gracefulShutdown\('SIGINT'\)\)/);
    expect(src).toMatch(/process\.on\('SIGTERM', \(\) => void gracefulShutdown\('SIGTERM'\)\)/);
    expect(src).toMatch(/process\.on\('SIGHUP', \(\) => void gracefulShutdown\('SIGHUP'\)\)/);
    // 信号调用没有传第二个参数 ⇒ 走 exitCode = 0
    expect(src).not.toMatch(/gracefulShutdown\('SIGTERM', 1\)/);
  });

  it('shuttingDown 重入保护还在（致命退出与 SIGTERM 撞车时不会跑两遍清理）', () => {
    expect(src).toMatch(/if \(shuttingDown\) \{/);
  });
});
