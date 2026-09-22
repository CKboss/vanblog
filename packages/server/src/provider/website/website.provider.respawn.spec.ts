import { spawn } from 'node:child_process';
import { WebsiteProvider } from './website.provider';

/**
 * website 子进程的生命周期：**主动停掉之后不能被自己的 exit 钩子复活**，
 * 重叠的 restart 不能双开（抢 3001 端口），意外退出要有有界退避重启。
 *
 * 三个真实缺陷（都在改动前存在）：
 *  1. `stop()` 把 ctx 置空并杀进程，但子进程的 `exit` 处理器**无条件**
 *     `restore()` → `run()` → 再 spawn 一个。优雅停机时刚杀掉的前台会复活，
 *     而 spawn 是 `detached: true`，于是它脱离进程组活下来：server 退了，
 *     3001 上还有个 next 在接客（多实例部署下还会继续触发定时任务）。
 *     waline 那边一直有 `stopping` 标志，website 没有。
 *  2. `restart()` = `stop()` + 依赖 exit 钩子拉起。加了 stopping 之后必须显式 run()，
 *     否则"重启"会变成"永久停掉"。
 *  3. `starting` 这个互斥量**从来没有被赋值过**（死代码），
 *     于是两次重叠的 restart 会在 `this.ctx == null` 判断之间各自 spawn 一个 next。
 */

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

type Handler = (...args: any[]) => void;

class FakeChild {
  handlers: Record<string, Handler[]> = {};
  stdout = { on: jest.fn() };
  stderr = { on: jest.fn() };
  pid: number;
  signals: string[] = [];
  exited = false;
  constructor(pid: number) {
    this.pid = pid;
  }
  on(event: string, cb: Handler) {
    (this.handlers[event] = this.handlers[event] || []).push(cb);
    return this;
  }
  once(event: string, cb: Handler) {
    const wrapped: Handler = (...args) => {
      this.handlers[event] = (this.handlers[event] || []).filter((h) => h !== wrapped);
      cb(...args);
    };
    return this.on(event, wrapped);
  }
  unref() {
    return this;
  }
  kill(signal?: string) {
    this.signals.push(String(signal));
    this.emitExit(null, signal || 'SIGTERM');
    return true;
  }
  emitExit(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of [...(this.handlers['exit'] || [])]) cb(code, signal);
  }
}

let children: FakeChild[] = [];
let nextPid = 4000;
let killSpy: jest.SpyInstance;

function installSpawnMock() {
  children = [];
  nextPid = 4000;
  mockedSpawn.mockReset();
  mockedSpawn.mockImplementation((() => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  }) as any);
  // stop() 杀的是**进程组**（detached），所以是 -pid
  killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
    const target = children.find((c) => -c.pid === pid || c.pid === pid);
    if (!target) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    target.signals.push(String(signal));
    target.emitExit(null, signal || 'SIGTERM');
    return true;
  }) as any);
}

function createProvider() {
  const provider = new WebsiteProvider(
    {
      getAll: jest.fn().mockResolvedValue({ siteInfo: { baseUrl: 'https://blog.example.com' }, socials: [] }),
    } as any,
    { getISRSetting: jest.fn().mockResolvedValue({ mode: 'onDemand' }) } as any,
  );
  return provider;
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/**
 * `@types/jest@29.4.1` 还没声明 `advanceTimersByTimeAsync`（jest 29.5 运行时是有的），
 * 所以这里过一道 any，并在拿不到时退化成"推进 + 冲微任务"。
 */
const advanceAsync = async (ms: number) => {
  const anyJest = jest as any;
  if (typeof anyJest.advanceTimersByTimeAsync === 'function') {
    await anyJest.advanceTimersByTimeAsync(ms);
    return;
  }
  jest.advanceTimersByTime(ms);
  await flush();
};

describe('WebsiteProvider 停机', () => {
  beforeEach(() => {
    installSpawnMock();
    jest.useFakeTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
  });
  afterEach(() => {
    jest.useRealTimers();
    killSpy?.mockRestore();
  });

  it('主动 stop() 之后，子进程的 exit 不会把它复活', async () => {
    const provider = createProvider();
    await provider.run();
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const child = children[0];

    await provider.stop();
    expect(child.exited).toBe(true);
    await flush();
    await advanceAsync(60000);
    // 关键断言：没有第二个 next 被拉起来
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(provider.ctx).toBeNull();
  });

  it('优雅停机路径（stop 之后进程真的退出）不会再 spawn', async () => {
    const provider = createProvider();
    await provider.run();
    const stopPromise = provider.stop();
    children[0].emitExit(0, 'SIGTERM');
    await stopPromise;
    await advanceAsync(120000);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('stop() 会等子进程退出：2 秒不退就 SIGKILL', async () => {
    const provider = createProvider();
    await provider.run();
    const child = children[0];
    // 让 SIGTERM 不生效：把 emitExit 拦掉一次
    const realEmit = child.emitExit.bind(child);
    child.emitExit = ((code: number | null, signal: string | null) => {
      if (signal === 'SIGTERM') return; // 假装没收到
      realEmit(code, signal);
    }) as any;

    const stopPromise = provider.stop();
    await advanceAsync(2100);
    await stopPromise;
    expect(child.signals).toContain('SIGTERM');
    expect(child.signals).toContain('SIGKILL');
  });

  it('stop() 在没有子进程时也能安全调用', async () => {
    const provider = createProvider();
    await expect(provider.stop()).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('WebsiteProvider restart', () => {
  beforeEach(() => {
    installSpawnMock();
    jest.useFakeTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
  });
  afterEach(() => {
    jest.useRealTimers();
    killSpy?.mockRestore();
  });

  it('restart() 会真的把前台重新拉起来（不再依赖 exit 钩子）', async () => {
    const provider = createProvider();
    await provider.run();
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const first = children[0];
    // 环境变量变了才会真的重启
    (provider as any).lastEnvJson = '{"stale":true}';
    await provider.restart('测试');
    await flush();
    expect(first.exited).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(provider.ctx).toBe(children[1]);
  });

  it('环境变量没变时 restart() 跳过（不停站）', async () => {
    const provider = createProvider();
    await provider.run();
    await provider.restart('改站点描述');
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(children[0].exited).toBe(false);
  });

  it('旧进程的 exit 事件迟到时不会把新进程顶掉（不会双开抢 3001）', async () => {
    const provider = createProvider();
    await provider.run();
    const first = children[0];
    (provider as any).lastEnvJson = '{"stale":true}';
    await provider.restart('测试');
    const second = children[1];
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    // 旧进程的 exit 现在才到（真实世界里 kill 是异步的）
    first.exited = false;
    first.emitExit(null, 'SIGTERM');
    await flush();
    await advanceAsync(60000);
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(provider.ctx).toBe(second);
  });

  it('两次重叠的 restart 只会 spawn 一次新的（starting 互斥量真的生效了）', async () => {
    const provider = createProvider();
    await provider.run();
    (provider as any).lastEnvJson = '{"stale":true}';
    await Promise.all([provider.restart('A'), provider.restart('B'), provider.run(), provider.run()]);
    await flush();
    // 一开始 1 个 + 重启后最多 1 个
    expect(mockedSpawn.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('WebsiteProvider 意外退出的退避重启', () => {
  beforeEach(() => {
    installSpawnMock();
    jest.useFakeTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
  });
  afterEach(() => {
    jest.useRealTimers();
    killSpy?.mockRestore();
  });

  it('崩溃后会自动重启（延迟 2 秒）', async () => {
    const provider = createProvider();
    await provider.run();
    children[0].emitExit(1, null);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    await advanceAsync(1999);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    await advanceAsync(2);
    await flush();
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });

  it('快速退避阶梯有界：连续崩 5 次后不再快速重试（不会刷日志、不会烧 CPU）', async () => {
    const provider = createProvider();
    await provider.run();
    for (let i = 0; i < 8; i += 1) {
      const child = children[children.length - 1];
      child.emitExit(1, null);
      await advanceAsync(31000);
      await flush();
    }
    // 1 次正常启动 + 最多 5 次快速退避重启
    expect(mockedSpawn.mock.calls.length).toBeLessThanOrEqual(6);
    // 🔴 升级（2026-09-22）：原来这条只断言"总数 <= 6"，在"进入慢速重试"之后会**静默变弱**
    // —— 因为 8 轮 x 31s = 248s 短于默认 5 分钟的慢速间隔，慢速定时器根本没在窗口内触发，
    // 于是"总数 <= 6"仍然成立，但它已经不再证明标题所说的"放弃"。
    // 现在把两半分开钉：这一条只负责**快速阶梯有界**（再多推进一段远小于慢速间隔的时间，
    // 也一次都不许多 spawn），"会不会自愈"由下面那个 describe 负责。
    const before = mockedSpawn.mock.calls.length;
    await advanceAsync(60 * 1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(before);
  });

  it('VANBLOG_DISABLE_WEBSITE=true 时不 spawn（无前台模式）', async () => {
    process.env.VANBLOG_DISABLE_WEBSITE = 'true';
    const provider = createProvider();
    await provider.run();
    expect(mockedSpawn).not.toHaveBeenCalled();
    await provider.restart('测试');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe('WebsiteProvider 源码守卫', () => {
  /** 去掉注释再断言：仓库里踩过十次"断言匹配到了记录这个坑的注释" */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('exit 处理器里有 stopping 与"还是不是当前子进程"两道判断', () => {
    const fs = require('fs');
    const src = stripComments(fs.readFileSync(require.resolve('./website.provider.ts'), 'utf8'));
    expect(src).toContain('if (this.ctx !== child)');
    expect(src).toContain('if (this.stopping)');
    // 不能再出现"无条件 restore"的那种 exit 处理器
    expect(src).not.toMatch(/on\('exit',\s*async\s*\(\)\s*=>\s*\{\s*await this\.restore/);
  });

  it('starting 互斥量确实被赋值（以前是死代码）', () => {
    const fs = require('fs');
    const src = stripComments(fs.readFileSync(require.resolve('./website.provider.ts'), 'utf8'));
    expect(src).toMatch(/this\.starting\s*=\s*task/);
    expect(src).toMatch(/if\s*\(this\.starting\)/);
  });
});

describe('WebsiteProvider 慢速重试（放弃快速阶梯之后仍能自愈）', () => {
  /**
   * 🔴 这一组钉的是 2026-09-22 修掉的那个轴⑤（自愈）缺陷：
   * 改动前 `scheduleRestart()` 在 `restartAttempts >= 5` 时直接 return，
   * 而计数只在"手动 restart()"与"子进程稳定跑过 60 秒"时归零 —— 放弃之后既没有子进程、
   * 也没有人触发 restart()，于是**前台永久不再自动拉起**，即使崩溃的瞬态原因早已消失。
   *
   * ⚠️ 两半都要钉，只钉一半会被"过度修复"钻空子：
   *  - **会自愈**：经过一个慢速间隔之后必须再试一次（否则缺陷还在）；
   *  - **不会风暴**：慢速间隔之内一次都不许多试，且间隔**不可能被配成 0**
   *    （否则有人会把它改成紧密重启循环 —— 那比永久放弃更糟：烧 CPU、刷日志、每次重试还要查两次库）。
   *
   * ⚠️ 全部用假定时器：本仓库已有两次因墙上时钟断言而偶发红，其中一次的症状与负载假红完全一致。
   * ⚠️ 一个必须注意的语义细节：exit 钩子用 `Date.now() - startedAt > 60s` 判"稳定运行"，
   * 而假定时器下推进时间会同时推进 `Date.now()` ⇒ **要在"刚 spawn 完、还没推进时间"时 emitExit**
   * 才能模拟"秒退"；要模拟"稳定跑过 60 秒后退出"则必须先推进 >60s 再 emitExit。
   */
  const SLOW_ENV = 'VANBLOG_WEBSITE_SLOW_RETRY_MS';
  const DEFAULT_SLOW_MS = 5 * 60 * 1000;

  beforeEach(() => {
    installSpawnMock();
    jest.useFakeTimers();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
    delete process.env[SLOW_ENV];
  });
  afterEach(() => {
    jest.useRealTimers();
    killSpy?.mockRestore();
    delete process.env[SLOW_ENV];
  });

  /**
   * 崩到快速阶梯用尽、进入慢速段。返回时的 spawn 数应当是 6（1 次正常启动 + 5 次快速退避）。
   *
   * ⚠️ 最后一次 emitExit **后面不能推进时间**：慢速定时器是在那次 emitExit 里安排的，
   * 再推进就把间隔吃掉一截。第一版正是这么错的 —— 循环里每轮都推进 31 秒，
   * 于是慢速间隔只剩 269 秒，"差 1 秒满 5 分钟不许重试"那条断言在 269 秒时就红了。
   * 前 5 轮推进是为了让快速阶梯的定时器逐个触发。
   */
  async function exhaustFastLadder(provider: WebsiteProvider) {
    await provider.run();
    for (let i = 0; i < 5; i += 1) {
      children[children.length - 1].emitExit(1, null);
      await advanceAsync(31000);
      await flush();
    }
    // 第 6 个子进程秒退 ⇒ 进入慢速段，且慢速定时器是**完整**的一个间隔
    children[children.length - 1].emitExit(1, null);
    await flush();
    return mockedSpawn.mock.calls.length;
  }

  it('进入慢速段之前：快速阶梯恰好 5 次，且慢速间隔之内一次都不多试', async () => {
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    expect(afterLadder).toBe(6);
    // 反空转：确实已经 spawn 过（否则上面的 6 是假的）
    expect(children.length).toBe(6);
    // 🔴 不会风暴：推进到差 1 秒就满一个默认慢速间隔，一次都不许多
    await advanceAsync(DEFAULT_SLOW_MS - 1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder);
  });

  it('🔴 瞬态原因消失后能自愈：一个慢速间隔之后会再试一次', async () => {
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    await advanceAsync(DEFAULT_SLOW_MS);
    await flush();
    // 修复生效的那一半：改动前这里永远是 6
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 1);
  });

  it('🔴 节奏有界：K 个慢速间隔恰好换来 K 次重试，每次秒退也不会加速', async () => {
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    // ⚠️ "秒退"必须在**假时间轴上真的只活了 0 秒**：emitExit 要紧跟在 spawn 它的那次推进之后，
    // 中间不能再推进时间。第一版在两次推进之间 emitExit，于是那个子进程在假时间轴上已经
    // "活了" 299 秒 ⇒ 合法地触发既有的"稳定跑过 60 秒 ⇒ 计数归零"判据 ⇒ 掉回 2 秒快速阶梯，
    // 看起来像产品多 spawn 了一次。**那是产品行为正确、测试模型错了**（插桩实测确认）。
    const FAST_LADDER_WINDOW = 60 * 1000;
    for (let k = 1; k <= 4; k += 1) {
      await advanceAsync(k === 1 ? DEFAULT_SLOW_MS : DEFAULT_SLOW_MS - FAST_LADDER_WINDOW);
      await flush();
      expect(mockedSpawn.mock.calls.length).toBe(afterLadder + k);
      // 刚 spawn 完就秒退（存活 0 秒）⇒ 仍然在慢速段
      children[children.length - 1].emitExit(1, null);
      // 🔴 秒退之后**不许**掉回 2 秒的快速阶梯（那才是风暴）：推进 60 秒一次都不许多
      await advanceAsync(FAST_LADDER_WINDOW);
      await flush();
      expect(mockedSpawn.mock.calls.length).toBe(afterLadder + k);
    }
  });

  it('一次成功的慢速重试（活过 60 秒）会把快速阶梯完整恢复', async () => {
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    await advanceAsync(DEFAULT_SLOW_MS);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 1);
    const healed = children[children.length - 1];
    // 模拟"稳定跑过一分钟之后才退出"：先推进 >60s，再 emitExit
    await advanceAsync(61 * 1000);
    healed.emitExit(1, null);
    await flush();
    // 计数已归零 ⇒ 下一次是 2 秒的快速退避，而不是 5 分钟的慢速重试
    await advanceAsync(2000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 2);
  });

  it('间隔可配：VANBLOG_WEBSITE_SLOW_RETRY_MS 生效', async () => {
    process.env[SLOW_ENV] = '60000';
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    await advanceAsync(59000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder);
    await advanceAsync(1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 1);
  });

  it('🔴 任何非法输入都不可能产生 0 间隔（一律落回默认 5 分钟）', async () => {
    // 逐个喂：0、负数、非数字、空串、纯空白、Infinity、NaN 字面量
    for (const bad of ['0', '-1', 'abc', '', '   ', 'Infinity', 'NaN']) {
      installSpawnMock();
      process.env[SLOW_ENV] = bad;
      const provider = createProvider();
      const afterLadder = await exhaustFastLadder(provider);
      // 如果 0 间隔生效，这里会立刻多 spawn 一次甚至打转；正确行为是仍然等满 5 分钟
      await advanceAsync(30 * 1000);
      await flush();
      expect(mockedSpawn.mock.calls.length).toBe(afterLadder);
      await advanceAsync(DEFAULT_SLOW_MS - 30 * 1000);
      await flush();
      expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 1);
    }
  });

  it('🔴 间隔被夹在 [1 分钟, 1 小时]：超大值不会变成"实际上永不重试"', async () => {
    process.env[SLOW_ENV] = '999999999';
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    await advanceAsync(59 * 60 * 1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder);
    await advanceAsync(60 * 1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder + 1);
  });

  it('🔴 下限也被夹住：配成 1 毫秒不会变成紧密重启风暴', async () => {
    process.env[SLOW_ENV] = '1';
    const provider = createProvider();
    const afterLadder = await exhaustFastLadder(provider);
    // 1 毫秒会被夹到下限 1 分钟 ⇒ 推进 30 秒仍然不该有新的 spawn
    await advanceAsync(30 * 1000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(afterLadder);
  });

  it('人工 restart() 之后从干净的快速阶梯重新开始（慢速状态被清掉）', async () => {
    const provider = createProvider();
    await exhaustFastLadder(provider);
    const before = mockedSpawn.mock.calls.length;
    await provider.restart('测试');
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(before + 1);
    // 新拉起的这个秒退 ⇒ 应当走 2 秒的快速阶梯，而不是 5 分钟的慢速重试
    children[children.length - 1].emitExit(1, null);
    await advanceAsync(2000);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(before + 2);
  });

  it('主动 stop() 优先：慢速定时器被清掉，不会再拉起', async () => {
    const provider = createProvider();
    await exhaustFastLadder(provider);
    const before = mockedSpawn.mock.calls.length;
    await provider.stop();
    await advanceAsync(DEFAULT_SLOW_MS * 3);
    await flush();
    expect(mockedSpawn.mock.calls.length).toBe(before);
  });
});

describe('WebsiteProvider 慢速重试源码守卫', () => {
  /** 去掉注释再断言：仓库里踩过十次"断言匹配到了记录这个坑的注释" */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const readSrc = () => {
    const fs = require('fs');
    return stripComments(fs.readFileSync(require.resolve('./website.provider.ts'), 'utf8'));
  };

  it('慢速间隔走 envPositiveInt，且默认值与下限都被钉住（下限不许降到 0）', () => {
    const src = readSrc();
    // 反空转：确实读到了这个文件的实质内容
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('private slowRetryMs(): number {');
    // 🔴 这一条同时钉住三件事：变量名、默认 5 分钟、**下限 1 分钟**、上限 1 小时。
    // 下限是防"紧密重启风暴"的那一半 —— 有人把它改成 0 或 1 就会红。
    expect(src).toMatch(
      /envPositiveInt\(\s*'VANBLOG_WEBSITE_SLOW_RETRY_MS',\s*5 \* 60 \* 1000,\s*60 \* 1000,\s*60 \* 60 \* 1000/,
    );
  });

  it('放弃快速阶梯之后仍然会安排一次重试（不再是不设定时器就 return）', () => {
    const src = readSrc();
    // 尺子有效性：切出 scheduleRestart 的函数体，断言"进入慢速段"那一支里确实在算间隔
    const start = src.indexOf('private scheduleRestart()');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('private async doRun()', start));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('this.restartAttempts >= 5');
    expect(body).toContain('delay = this.slowRetryMs()');
    // 🔴 快速阶梯那一支必须仍然自增计数（否则"连续 5 次"的语义就没了）
    expect(body).toContain('this.restartAttempts += 1');
    // 🔴 慢速段**不许**自增计数（否则 60 秒稳定判据清零之后就再也回不到快速阶梯）
    expect(body.match(/this\.restartAttempts \+= 1/g) || []).toHaveLength(1);
  });

  it('两处复位点都在：手动 restart() 与"稳定跑过 60 秒"', () => {
    const src = readSrc();
    // 复位必须是"计数 + 慢速状态"一起清，只清一半会让 ERROR 再也记不出来或阶梯回不来
    expect(src.match(/this\.inSlowRetry = false;/g) || []).toHaveLength(2);
    expect(src.match(/this\.slowRetries = 0;/g) || []).toHaveLength(2);
    expect(src.match(/this\.restartAttempts = 0;/g) || []).toHaveLength(2);
  });
});
