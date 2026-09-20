import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `main.ts` 的「降级驻留」路径上，**尽力而为的步骤绝不能打死启动流程**。
 *
 * ## 钉的是什么
 * 实测事故（2026-09-20，活体日志 `vanblog_dev/tmp/defect-degraded-crash.log`）：数据库不可达 ⇒
 * 已经打出完整的三条下一步、准备进入降级驻留 ⇒ `snapshotServeHtmlSentinels()` 抛 TypeError ⇒
 * `main()` 的 `.catch()` ⇒ 退出码 1 ⇒ 容器退出 ⇒ **caddy 也死了**，连 `/static/*` 都发不出去。
 * 也就是从"降级但仍在发布"直接掉回"完全下线"，而降级驻留这个机制存在的理由正是为了避免这件事。
 *
 * 那一次的直接原因是验证脚手架的混代产物（AGENTS.md §7.79c），**但缺陷是真的**：
 * 生产里同样会触发的形状有 pages 目录不可读/不可写、只读挂载、卷没挂上、磁盘满 ENOSPC、EACCES/EROFS。
 *
 * ## 为什么是源码结构断言而不是行为断言
 * ⚠️ `main.ts` **不能被 import**：它在模块加载时就调用 `main()`（会 listen、连库、拉子进程）。
 * 所以行为级证据放在 `utils/degradedServeHtml.spec.ts`（真临时目录 + 真 fs 错误）与
 * `utils/degradedHold.spec.ts`（真起 HTTP），这里钉的是**接线**：
 * 哪些调用被包住了、顺序对不对、以及关键步骤**没有**被包进去。
 *
 * ⚠️ 顺序与包含关系才是本体：只断言"源码里有 try"是空断言（加个空 try 就能过），
 * 所以这里用**花括号配平**求真正的包含关系，并且每条都带反证。
 */
const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, '../main.ts'), 'utf-8'));

const at = (needle: string, from = 0) => SRC.indexOf(needle, from);

/** 求 `try {` 与其配对 `}` 的区间；返回所有 try 块。 */
function tryBlocks(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const braceOpen = src.indexOf('{', m.index);
    let depth = 0;
    for (let i = braceOpen; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({ start: m.index, end: i });
          break;
        }
      }
    }
  }
  return out;
}

/** 从 `needle` 处那个 `{` 开始，取到配对 `}` 为止的区块（含首尾）。找不到返回 null。 */
function bracedBlock(src: string, needle: string): string | null {
  const idx = src.indexOf(needle);
  if (idx < 0) return null;
  const open = src.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  return null;
}

/** needle 是否落在**某个** try 块内（按花括号配平，不是"附近有没有 try 这个词"）。 */
function isInsideAnyTry(src: string, needle: string): boolean {
  const idx = src.indexOf(needle);
  if (idx < 0) return false;
  return tryBlocks(src).some((b) => idx > b.start && idx < b.end);
}

/** 包含 needle 的那个 try 块的区间（找不到返回 null）。 */
function tryBlockContaining(src: string, needle: string) {
  const idx = src.indexOf(needle);
  if (idx < 0) return null;
  return tryBlocks(src).find((b) => idx > b.start && idx < b.end) ?? null;
}

describe('main.ts：降级驻留路径上，尽力而为的步骤不可致命', () => {
  it('尺子自检：花括号配平的 try 块检测在合成源码上方向正确（否则下面全部恒真/恒假）', () => {
    const wrapped = 'async function f(){ try { await risky(); } catch(e){ log(e); } }';
    const bare = 'async function f(){ await risky(); }';
    // 正对照：包住了 ⇒ true
    expect(isInsideAnyTry(wrapped, 'await risky()')).toBe(true);
    // 负对照：没包 ⇒ false（这条证明尺子不是恒真）
    expect(isInsideAnyTry(bare, 'await risky()')).toBe(false);
    // 负对照：needle 不存在 ⇒ false，而不是抛或恒真
    expect(isInsideAnyTry(wrapped, 'await nonexistent()')).toBe(false);
    // 嵌套：内层 try 里的东西同时也在外层 try 里
    const nested = 'try { outer(); try { inner(); } catch {} } catch {}';
    const blocks = tryBlocks(nested);
    expect(blocks.length).toBe(2);
    expect(isInsideAnyTry(nested, 'inner()')).toBe(true);
    expect(isInsideAnyTry(nested, 'outer()')).toBe(true);
  });

  it('🔴 顺序：先接住端口（health 契约），再做写哨兵这件尽力而为的事', () => {
    // 占位服务由控制器起（`createDegradedHoldController` → `startDegradedHoldServer`），
    // 哨兵由控制器的 `onEnter` 回调写。所以这里钉的是**接线**：
    // onEnter 必须挂在控制器上（而不是在起监听之前裸调），且 enterPublishing 必须在 try 里。
    const controller = at('createDegradedHoldController({');
    const publish = at('enterDegradedPublishing(log)');
    expect(controller).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    // 反过来的形状就是本次事故：哨兵那一步在起监听**之前**裸调、且抛异常 ⇒
    // 占位服务从未启动 ⇒ health 变成 connection refused（编排层看到"容器死了"而不是
    // "站点降级了"，严格更糟）。现在哨兵只能经 onEnter 被调到，而 onEnter 由控制器在
    // 起监听**之后**调用，且被 bestEffort 包住。
    expect(SRC).toMatch(/onEnter:\s*enterPublishing/);
    expect(SRC).toMatch(/onCommit:\s*commitPublishing/);
    expect(isInsideAnyTry(SRC, 'enterDegradedPublishing(log)')).toBe(true);
    expect(isInsideAnyTry(SRC, 'exitDegradedPublishing(was, log)')).toBe(true);
  });

  it('🔴 immediate 模式：**先探库、不可达就立刻驻留**，而不是先烧完整个重试窗口', () => {
    const modeRead = at('resolveDegradedHoldMode(');
    const preProbe = at('await probeDbOnceForHold()');
    const earlyEnter = at('await hold.enter(preHoldReason)');
    const retry = at('await runBootstrapWithDbRetry(bootstrap, {');
    expect(modeRead).toBeGreaterThan(-1);
    expect(preProbe).toBeGreaterThan(-1);
    expect(earlyEnter).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(-1);
    // 顺序：读模式 → 预探 → 立刻驻留 → （只有没驻留时才）走窗口重试
    expect(modeRead).toBeLessThan(preProbe);
    expect(preProbe).toBeLessThan(earlyEnter);
    expect(earlyEnter).toBeLessThan(retry);
    // 预探必须只在 immediate 模式下做（after-window 要保持旧行为，否则那个旋钮就是假的）
    const modeGate = SRC.lastIndexOf("if (holdMode === 'immediate')", preProbe);
    expect(modeGate).toBeGreaterThan(-1);
    // 窗口重试必须被"没有提前驻留"这个条件挡住
    expect(SRC).toMatch(/if\s*\(!preHoldReason\)\s*\{[\s\S]{0,200}runBootstrapWithDbRetry/);
  });

  it('🔴 循环里的顺序：先让出端口，再跑 bootstrap（否则 EADDRINUSE 会被判成非数据库错误 ⇒ 退出码 1）', () => {
    const release = at('await hold.releasePort();');
    const boot = at('await bootstrap();\n      bootstrapped = true;');
    expect(release).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    expect(release).toBeLessThan(boot);
  });

  it('🔴 哨兵还原推迟到 bootstrap **成功之后**（否则 bootstrap 期间会出现新的 502 空窗）', () => {
    const release = at('await hold.releasePort();');
    const commit = at('await hold.commit();');
    const boot = at('await bootstrap();\n      bootstrapped = true;');
    expect(release).toBeLessThan(boot);
    expect(boot).toBeLessThan(commit);
    // releasePort 只关监听、不还原哨兵：钉住控制器里这两件事是分开的两个方法
    expect(SRC).not.toContain('await hold.releasePort();\n    await hold.commit();');
  });

  it('抖动重入走 reenter（带护栏），而不是直接 enter', () => {
    expect(SRC).toContain('await hold.reenter(');
    expect(SRC).toMatch(/if\s*\(!bootstrapped\)\s*\{[\s\S]{0,400}hold\.reenter\(/);
  });

  it('🔴 enterDegradedPublishing 被 try 包住（两层防护的外层：防"模块本身坏了"）', () => {
    expect(isInsideAnyTry(SRC, 'enterDegradedPublishing(log)')).toBe(true);
  });

  it('🔴 exitDegradedPublishing 被 try 包住，且**不在** bootstrap 的那个 try 里', () => {
    expect(isInsideAnyTry(SRC, 'exitDegradedPublishing(was, log)')).toBe(true);

    const bootstrapTry = tryBlockContaining(SRC, 'await bootstrap();\n      bootstrapped = true;');
    expect(bootstrapTry).not.toBeNull();
    const exitIdx = at('exitDegradedPublishing(was, log)');
    expect(exitIdx).toBeGreaterThan(-1);
    // 共用 catch 的后果：启动已经成功、只是还原哨兵失败 ⇒ 掉进 catch ⇒
    // isDbUnreachableError 为 false ⇒ process.exit(1)，把一个**已经恢复正常**的站点杀掉，
    // 还留下"数据库可达但启动失败"这条误导性 FATAL。
    // ⚠️ 判据是"**不在这个 try 块内**"，不是"位置在它之后"：`commitPublishing` 是在 main()
    //    前部**定义**的（比循环里那个 try 更早），所以"大于 end"永远为假 —— 我第一版就这么写错了。
    const inside = exitIdx > bootstrapTry!.start && exitIdx < bootstrapTry!.end;
    expect(inside).toBe(false);
    // 同一个性质也要在**调用点**成立：`await hold.commit()` 也不许落在那个 try 里
    const commitIdx = at('await hold.commit();');
    expect(commitIdx).toBeGreaterThan(-1);
    expect(commitIdx > bootstrapTry!.start && commitIdx < bootstrapTry!.end).toBe(false);
    expect(commitIdx).toBeGreaterThan(bootstrapTry!.end);
  });

  it('bootstrap 的成功/失败由显式标志决定，而不是靠"try 里没抛就是成功"', () => {
    expect(SRC).toContain('let bootstrapped = false;');
    expect(SRC).toContain('bootstrapped = true;');
    // ⚠️ 形状是 `if (!bootstrapped) { log.warn(...); await hold.reenter(...); continue; }`：
    //    不是"裸 continue"，中间要记抖动并重挂占位服务。
    expect(SRC).toMatch(/if\s*\(!bootstrapped\)\s*\{[\s\S]{0,400}continue;/);
  });

  it('降级驻留路径上不再有**裸调用**的哨兵函数（本次事故的形状）', () => {
    // ⚠️ 断言"不存在"必须在剥过注释的文本上做（本仓库已踩 9 次"匹配到解释性注释"）。
    //    这里断言的是**调用形状**，不是符号出现：main.ts 只应通过 enter/exit 这两个入口碰哨兵。
    expect(SRC).not.toContain('snapshotServeHtmlSentinels(');
    expect(SRC).not.toContain('enableDegradedServeHtml(');
    expect(SRC).not.toContain('restoreServeHtmlSentinels(');
    // 反证：这三把尺子量得到坏形状（否则上面的 not.toContain 恒真）
    const bad = 'const s = snapshotServeHtmlSentinels(); enableDegradedServeHtml({}); restoreServeHtmlSentinels(s);';
    expect(bad).toContain('snapshotServeHtmlSentinels(');
    expect(bad).toContain('enableDegradedServeHtml(');
    expect(bad).toContain('restoreServeHtmlSentinels(');
  });
});

describe('main.ts：关键步骤**仍然**致命（不能为了"不崩"把真故障吞掉）', () => {
  it('负向对照：非数据库类的启动失败仍然 process.exit(1)，且这条分支不会"继续往下走"', () => {
    // ⚠️ 必须按**花括号配平**取出这个 if 块，而不是取固定长度的窗口：
    //    我第一版切了 600 字符，窗口越过了本块、吃到了后面 `if (!bootstrapped) { continue; }`
    //    里那个合法的 continue ⇒ 断言假红。"取出真正的那个块"才是这条性质的形状。
    const block = bracedBlock(SRC, 'if (!isDbUnreachableError(err)) {');
    expect(block).not.toBeNull();
    expect(block).toContain('process.exit(1)');
    // 这条分支的语义是"真故障 ⇒ 交给 restart 策略"，所以块内不许出现继续循环/正常返回的形状
    expect(block).not.toContain('continue;');
    expect(block).not.toContain('return;');
    // 反证：这把"不许出现"的尺子量得到坏形状（否则 not.toContain 恒真）
    const swallowed = 'if (!isDbUnreachableError(err)) { log.warn("x"); continue; }';
    expect(swallowed).toContain('continue;');
  });

  it('负向对照：registerFatalHandlers 仍然是 main() 的第一件事，且没有被包进 try', () => {
    const mainIdx = at('async function main() {');
    const regIdx = at('registerFatalHandlers();', mainIdx);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(regIdx).toBeGreaterThan(mainIdx);
    // registerFatalHandlers 与下一个语句之间不许夹着 try（它自己就是兜底，被兜住等于没有兜底）
    const between = SRC.slice(mainIdx, regIdx);
    expect(between).not.toMatch(/\btry\s*\{/);
  });

  it('负向对照：bootstrap 本体没有被"尽力而为"包起来（它失败就该走重试/退出语义）', () => {
    // `runBootstrapWithDbRetry(bootstrap, ...)` 是首次启动路径：它自己分类错误，
    // 绝不能外面再套一个吞异常的 try。
    const first = at('await runBootstrapWithDbRetry(bootstrap, {');
    expect(first).toBeGreaterThan(-1);
    expect(isInsideAnyTry(SRC, 'await runBootstrapWithDbRetry(bootstrap, {')).toBe(false);
  });

  it('负向对照：main() 的 .catch() 仍在（裸调用会让启动失败变成一坨无人解释的 stack）', () => {
    expect(SRC).toMatch(/main\(\)\.catch\(/);
    expect(SRC).toContain('启动流程本身出错（不是数据库不可达那条路径）');
  });

  it('占位服务绑定失败时仍然继续重试，而不是退出（health 契约的降级形状）', () => {
    // startDegradedHoldServer 内部对绑定失败返回 null 而不是抛（见 degradedHold.spec.ts）；
    // 控制器把 null 记成 active 但不 exit。这里钉住 main.ts 没有对"驻留没起来"直接退出：
    // releasePort 之后必须仍然走到 bootstrap，而不是 return/exit。
    const release = at('await hold.releasePort();');
    const boot = at('await bootstrap();\n      bootstrapped = true;');
    expect(release).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(release);
    // ⚠️ 不能笼统断言"releasePort 之后没有 process.exit"：紧跟其后的 catch 里
    //    `!isDbUnreachableError(err)` 那条分支**必须**保留 process.exit(1)
    //    （真故障要交给 restart 策略，吞掉它比原缺陷更糟）。
    // ⚠️ 也不能取"从 bootstrapped = true 到 hold.commit()"这一段：它必然跨过 catch 块，
    //    于是含 process.exit 是**正确**的（我第一版就这么写错了）。
    //    真正要钉的是**成功收尾那一段**：从 `await hold.commit();` 到它后面的 `return;`。
    const commitIdx = at('await hold.commit();');
    expect(commitIdx).toBeGreaterThan(-1);
    const tail = SRC.slice(commitIdx, SRC.indexOf('return;', commitIdx) + 5);
    expect(tail).toContain('数据库恢复后启动成功');
    expect(tail).not.toContain('process.exit');
    // 负向对照：失败分支的 exit 仍在（证明上面那条不是"整个文件都没有 exit"的恒真断言）
    expect(SRC).toContain('process.exit(1)');
  });
});
