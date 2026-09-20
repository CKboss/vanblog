import { spawn } from 'node:child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { WebsiteProvider } from './website.provider';

/**
 * 前台子进程的日志**严重级别**：stderr 是诊断流，不是错误流。
 *
 * 改动前 `child.stderr` 的每一行都被转成 `logger.error`。实测后果（故障注入，2026-09-20）：
 * `packages/website/pages/api/revalidate.ts` 里那条用 `console.warn` 打的提示
 * ——「未设置 VAN_BLOG_REVALIDATE_SECRET…」，注释里明写这是**默认状态而不是异常**——
 * 在 server 日志里变成了 `ERROR [WebsiteProvider] …`。Next 自己的任何 warning
 * （bundle 体积建议、deprecation）同样会变成 ERROR。于是本轮刚给 `./vanblog.sh doctor`
 * 加的"统计近 24h 日志里的 ERROR/FATAL"这一项体检，在**每一个一体式部署**上都会报异常，
 * 而真正的错误被这些噪音淹没。
 *
 * ⚠️ 降级的前提是"崩溃判定不看 stderr"，这一点已核实并且**在这里钉住**：
 * 崩溃走 `child.on('exit')`，加上 `scheduleRestart()` 里"重拉失败"与"达到最大重启次数"
 * 两处 `logger.error`。所以本文件同时断言：
 *   ① 普通 stderr → WARN（不再是 ERROR）；
 *   ② **异常退出 → ERROR**（本轮把它从 WARN 升上来，正是为了补偿 ① 的降级，
 *      否则"容器 Up 但前台坏死"就没有任何 ERROR 级线索了）；
 *   ③ 正常退出（code=0）→ 仍是 WARN，不制造假警报；
 *   ④ 那三处"真错误"路径的 `logger.error` 一个都没被顺手降级。
 */

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

type Handler = (...args: any[]) => void;

/** 与 respawn.spec 里的 FakeChild 同形，但**捕获 stdout/stderr 的 handler**（那边只是桩）。 */
class FakeChild {
  handlers: Record<string, Handler[]> = {};
  stdoutHandlers: Handler[] = [];
  stderrHandlers: Handler[] = [];
  stdout = {
    on: (_e: string, cb: Handler) => {
      this.stdoutHandlers.push(cb);
      return this.stdout;
    },
  };
  stderr = {
    on: (_e: string, cb: Handler) => {
      this.stderrHandlers.push(cb);
      return this.stderr;
    },
  };
  pid: number;
  exited = false;
  constructor(pid: number) {
    this.pid = pid;
  }
  on(event: string, cb: Handler) {
    (this.handlers[event] = this.handlers[event] || []).push(cb);
    return this;
  }
  once(event: string, cb: Handler) {
    return this.on(event, cb);
  }
  unref() {
    return this;
  }
  kill(signal?: string) {
    this.emitExit(null, signal || 'SIGTERM');
    return true;
  }
  emitStderr(text: string) {
    for (const cb of [...this.stderrHandlers]) cb(Buffer.from(text));
  }
  emitStdout(text: string) {
    for (const cb of [...this.stdoutHandlers]) cb(Buffer.from(text));
  }
  emitExit(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of [...(this.handlers['exit'] || [])]) cb(code, signal);
  }
}

let children: FakeChild[] = [];
let nextPid = 5100;
let killSpy: jest.SpyInstance;

function installSpawnMock() {
  children = [];
  nextPid = 5100;
  mockedSpawn.mockReset();
  mockedSpawn.mockImplementation((() => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child;
  }) as any);
  killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as any);
}

function createProvider() {
  const provider = new WebsiteProvider(
    {
      getAll: jest
        .fn()
        .mockResolvedValue({ siteInfo: { baseUrl: 'https://blog.example.com' }, socials: [] }),
    } as any,
    { getISRSetting: jest.fn().mockResolvedValue({ mode: 'onDemand' }) } as any,
  );
  const warns: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  (provider as any).logger = {
    warn: (m: unknown) => warns.push(String(m)),
    error: (m: unknown) => errors.push(String(m)),
    log: (m: unknown) => logs.push(String(m)),
  };
  // 退避重启会在 2000ms 后真的再 spawn 一次；这些用例不关心重启，把它掐掉以免污染断言。
  jest.spyOn(provider as any, 'scheduleRestart').mockImplementation(() => undefined);
  return { provider, warns, errors, logs };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('WebsiteProvider：子进程 stderr 的严重级别', () => {
  beforeEach(() => {
    installSpawnMock();
    delete process.env.VANBLOG_DISABLE_WEBSITE;
  });
  afterEach(() => {
    killSpy?.mockRestore();
    jest.restoreAllMocks();
  });

  it('普通 stderr 行走 **WARN**，不再是 ERROR', async () => {
    const { provider, warns, errors } = createProvider();
    await provider.run();
    await flush();
    expect(children).toHaveLength(1);
    children[0].emitStderr(
      '[revalidate] 未设置 VAN_BLOG_REVALIDATE_SECRET：本接口现在只接受本机回环直连的请求\n',
    );
    expect(warns.join('\n')).toContain('未设置 VAN_BLOG_REVALIDATE_SECRET');
    expect(errors).toEqual([]);
  });

  it('Next 自身的 warning（bundle 体积建议）也走 WARN', async () => {
    const { provider, warns, errors } = createProvider();
    await provider.run();
    await flush();
    children[0].emitStderr('warn - You have enabled experimental feature\n');
    children[0].emitStderr('Creating an optimized bundle... 350 kB\n');
    expect(errors).toEqual([]);
    // ⚠️ 命中 ignore 名单的那条会被整条吞掉（既有行为，不许改）
    expect(warns.join('\n')).not.toContain('experimental feature');
    expect(warns.join('\n')).toContain('optimized bundle');
  });

  it('stdout 仍走 log（不是 warn/error）', async () => {
    const { provider, logs, warns, errors } = createProvider();
    await provider.run();
    await flush();
    children[0].emitStdout('▲ Next.js 14.2.35\n');
    expect(logs.join('\n')).toContain('Next.js');
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('异常退出（非 0 码）⇒ **ERROR**，这是"容器 Up 但前台坏死"的唯一线索', async () => {
    const { provider, errors, warns } = createProvider();
    await provider.run();
    await flush();
    children[0].emitExit(1, null);
    const text = errors.join('\n');
    expect(text).toContain('website 进程退出');
    expect(text).toContain('code=1');
    // 同一条消息不该同时出现在 WARN 里（否则级别判定就含糊了）
    expect(warns.join('\n')).not.toContain('website 进程退出');
  });

  it('被信号打死 ⇒ 同样是 ERROR', async () => {
    const { provider, errors } = createProvider();
    await provider.run();
    await flush();
    children[0].emitExit(null, 'SIGKILL');
    expect(errors.join('\n')).toContain('signal=SIGKILL');
  });

  it('正常退出（code=0、无信号）⇒ 仍是 WARN，不制造假警报', async () => {
    const { provider, errors, warns } = createProvider();
    await provider.run();
    await flush();
    children[0].emitExit(0, null);
    expect(errors).toEqual([]);
    expect(warns.join('\n')).toContain('website 进程退出');
  });
});

describe('WebsiteProvider：降级 stderr 不能顺带降掉真错误', () => {
  const SRC = stripCommentsForAnchor(
    readFileSync(resolve(__dirname, 'website.provider.ts'), 'utf-8'),
  );

  it('三处"真错误"路径仍然是 logger.error（重拉失败 / 达到最大重启次数 / restart 出错）', () => {
    expect(SRC).toMatch(/this\.logger\.error\(\s*`重新拉起 website 失败/);
    expect(SRC).toMatch(/this\.logger\.error\(/);
    // 数量下限：异常退出那处 + 上面这两处 + restart() 里那处 = 至少 4 处
    const errorCalls = SRC.match(/this\.logger\.error\(/g) ?? [];
    expect(errorCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('stderr 转发处不许再出现 logger.error（那就是改动前的形状）', () => {
    // 定位 stderr handler 那一段，断言它内部用的是 warn
    const m = SRC.match(/child\.stderr\?\.on\('data',[\s\S]{0,900}?\n {6}\}\);/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('this.logger.warn(');
    expect(m![0]).not.toContain('this.logger.error(');
    // 空转反证：把这段换成改动前的形状，上面两条断言必须能抓到
    const before = m![0].replace('this.logger.warn(', 'this.logger.error(');
    expect(before).toContain('this.logger.error(');
    expect(before).not.toContain('this.logger.warn(');
  });

  it('崩溃判定靠 exit 事件，不靠 stderr（这是允许降级 stderr 的前提）', () => {
    expect(SRC).toMatch(/child\.on\('exit',/);
    // exit handler 里按"是否异常"分级
    const exit = SRC.match(/child\.on\('exit',[\s\S]{0,1400}?\n {6}\}\);/);
    expect(exit).not.toBeNull();
    expect(exit![0]).toMatch(/const abnormal = code !== 0 \|\| signal !== null/);
    expect(exit![0]).toContain('if (abnormal)');
    expect(exit![0]).toContain('this.logger.error(exitText)');
    expect(exit![0]).toContain('this.logger.warn(exitText)');
  });

  it('ignoreWebsiteWarnings 名单仍然生效（降级不等于把所有噪音都放出来）', () => {
    expect(SRC).toMatch(/for \(const each of ignoreWebsiteWarnings\)/);
    expect(SRC).toMatch(/if \(showLog\)/);
  });
});
