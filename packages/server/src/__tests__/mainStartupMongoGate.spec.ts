import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { MONGO_READY_TIMEOUT_ENV } from 'src/utils/mongoReady';

/**
 * 启动全量 ISR 渲染之前必须**先等数据库就绪**。
 *
 * 实测事故（故障注入，2026-09-20，镜像 `vanblog:hardened`）：`podman restart` 之后 mongo
 * 还在重连、`/api/public/health` 仍返回 503 degraded，而 `main.ts` 立刻触发了启动全量渲染。
 * 那一轮要经前台 SSR 回源查库，库没就绪就失败，于是把当时写死的 6×3s ≈ 18 秒重试窗口烧光，
 * 打出「达到最大增量渲染重试次数！」后**永久放弃**这一轮预热。站点仍能对外服务
 * （ISR 缓存 + `fallback:'blocking'` 按需渲染），但每个页面都要等访客第一次访问才现场渲染 ——
 * 在敌意环境下，任何能让容器重启的手段（崩溃循环、OOM、`docker restart`）都可能把站点
 * 长期留在这个最贵、最容易被放大的形状上。
 *
 * ⚠️ `main.ts` 的 `bootstrap()` 无法在单测里真跑（它会 listen、连库、拉子进程），
 *    所以这里钉的是**源码结构**：调用形状 + 三个顺序不变量。
 *    顺序才是这条修复的本体 —— 只断言"`waitForMongoReady` 这个符号出现了"是空断言
 *    （import 一行就能让它过），把它挪到 listen 之前、或挪到 activeAll 之后，
 *    性质就完全变了，而那三种形状都必须被这里的断言抓到。
 */
const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, '../main.ts'), 'utf-8'));

/** 取某个子串第一次出现的位置；找不到返回 -1（调用方要显式处理，别让 -1 参与比较而假绿）。 */
const at = (needle: string | RegExp) =>
  typeof needle === 'string' ? SRC.indexOf(needle) : (SRC.search(needle) ?? -1);

describe('main.ts：启动全量渲染前的数据库就绪闸门', () => {
  it('三个关键调用都存在（否则下面的顺序比较会因 -1 而假绿）', () => {
    const listen = at(/await\s+listenWithBacklog\(/);
    const wait = at(/await\s+waitForMongoReady\(/);
    const storm = at(/isrProvider\.activeAll\(/);
    expect(listen).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(storm).toBeGreaterThan(-1);
  });

  it('顺序：listen → 等数据库就绪 → 触发启动全量渲染', () => {
    const listen = at(/await\s+listenWithBacklog\(/);
    const wait = at(/await\s+waitForMongoReady\(/);
    const storm = at(/isrProvider\.activeAll\(/);
    // ⚠️ 这条是"不延后对外服务"的保证：等待发生在 listen **之后**，
    //    站点已经能吐出 ISR 缓存内容了，等库只是为了让预热这件事值得做。
    expect(listen).toBeLessThan(wait);
    expect(wait).toBeLessThan(storm);
  });

  it('等待发生在 `if (primary)` 里面（每个 worker 都等一遍是没有意义的重复）', () => {
    const primary = SRC.lastIndexOf('if (primary) {', at(/await\s+waitForMongoReady\(/));
    const wait = at(/await\s+waitForMongoReady\(/);
    const storm = at(/isrProvider\.activeAll\(/);
    expect(primary).toBeGreaterThan(-1);
    expect(primary).toBeLessThan(wait);
    expect(wait).toBeLessThan(storm);
  });

  it('连接对象取自 DI 容器的 getConnectionToken()，与 health.controller 的 @InjectConnection 同源', () => {
    // 判据必须一致：否则会出现"/api/public/health 说 503，而这里说库已就绪"的自相矛盾。
    expect(SRC).toMatch(/app\.get<Connection>\(\s*getConnectionToken\(\)\s*\)/);
    expect(SRC).toMatch(/import\s*\{[^}]*getConnectionToken[^}]*\}\s*from\s*'@nestjs\/mongoose'/);
  });

  it('超时**不放弃启动**：!ready 分支里只打日志，没有 return / exit / throw', () => {
    const idx = at(/if\s*\(!mongoReady\.ready\)\s*\{/);
    expect(idx).toBeGreaterThan(-1);
    // 取出这个 if 块（到与之配对的右花括号）
    let depth = 0;
    let end = -1;
    for (let i = SRC.indexOf('{', idx); i < SRC.length; i += 1) {
      if (SRC[i] === '{') depth += 1;
      else if (SRC[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(idx);
    const block = SRC.slice(idx, end);
    expect(block).toContain('console.warn');
    expect(block).not.toMatch(/\breturn\b/);
    expect(block).not.toMatch(/process\.exit/);
    expect(block).not.toMatch(/\bthrow\b/);
    // 空转反证：把上面三条"不许出现"的尺子对准一个真的会放弃启动的形状，必须命中
    const giving = 'if (!mongoReady.ready) { console.warn("x"); return; }';
    expect(giving).toMatch(/\breturn\b/);
  });

  it('超时那条 WARN 说清了后果与兜底，并给出可照做的旋钮名', () => {
    const idx = at(/if\s*\(!mongoReady\.ready\)\s*\{/);
    const block = SRC.slice(idx, idx + 2000);
    expect(block).toContain('仍然继续启动');
    expect(block).toContain('按需渲染'); // 兜底
    // ⚠️ 消息里是 `${MONGO_READY_TIMEOUT_ENV}`（插值导出的常量），不是字面量 ——
    //    所以这里断言"引用了那个常量"，并**另外**断言常量的值就是文档里那个名字。
    //    只断言字面量会红（我第一版就这么写错了），只断言常量名则可能钉到一个值已经改掉的常量。
    expect(block).toContain('MONGO_READY_TIMEOUT_ENV');
    expect(MONGO_READY_TIMEOUT_ENV).toBe('VANBLOG_MONGO_READY_TIMEOUT_MS');
    expect(block).toContain('VANBLOG_ISR_RETRY_MAX');
    // ⚠️ 不许回显一个不存在的环境变量（本仓库有过 VANBLOG_SHUTDOWN_TIMEOUT_MS 的先例：
    //    一个代理照着 main.ts 里拼错的注释 grep，得出"该变量不存在"的结论并写进了文档）
    expect(block).not.toContain('VANBLOG_SHUTDOWN_TIMEOUT_MS');
  });

  it('等待有进度日志（否则运维看到的就是"启动卡住了一分钟，什么也没说"）', () => {
    expect(SRC).toMatch(/onProgress:\s*\(waitedMs,\s*stateText\)/);
    expect(SRC).toContain('在等数据库就绪后才触发启动全量渲染');
  });
});
