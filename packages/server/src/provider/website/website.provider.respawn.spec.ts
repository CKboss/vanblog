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

  it('连续崩 5 次就放弃，不会无限重启刷日志', async () => {
    const provider = createProvider();
    await provider.run();
    for (let i = 0; i < 8; i += 1) {
      const child = children[children.length - 1];
      child.emitExit(1, null);
      await advanceAsync(31000);
      await flush();
    }
    // 1 次正常启动 + 最多 5 次退避重启
    expect(mockedSpawn.mock.calls.length).toBeLessThanOrEqual(6);
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
