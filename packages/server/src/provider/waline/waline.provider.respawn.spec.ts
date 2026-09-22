import { WalineProvider } from './waline.provider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 🔴 Waline 的退避重启：**快速阶梯用尽后转入慢速重试，永不彻底放弃**。
 *
 * 缺陷（改动前）：`scheduleRestart()` 在 `restartAttempts >= 5` 时打一条 ERROR 就 `return`，
 * 而计数只在"手动 restart()"与"子进程稳定跑过 60 秒"时归零 ⇒ **一次瞬态崩溃风暴之后
 * waline 永久不再自动拉起**，而 server 还活着 ⇒ `restart: always` 不触发，
 * 用户只看到"评论发不出去"（`/comment*`、`/ui` 一直 502），直到有人重启容器。
 *
 * ⚠️ **测试口径**：直接驱动私有的 `scheduleRestart()` 并把 `run()` 桩掉。
 * 这是**有意**的 —— 被测的正是退避决策那一段，而真实的 `run()` 要拉起 spawn、
 * 读 meta/setting/config 拼一整套环境变量；把它拉进来会让"退避是否正确"这个判据
 * 被无关的失败淹没（🔴 而本仓库已有七次"替身钉住作者假设"的事故，所以这里刻意
 * **只桩掉与被测逻辑无关的那一层**，退避状态机本身跑的是真代码）。
 *
 * ⚠️ 另：`@types/jest@29.4.1` 没声明 `advanceTimersByTimeAsync`（jest 29.5 运行时是有的），
 * 所以走 `website.provider.respawn.spec.ts` 同款的运行时探测，避免 TS2551。
 */

const SRC = fs.readFileSync(path.join(__dirname, 'waline.provider.ts'), 'utf8');

/** 剥掉注释与字符串字面量：钉"代码里有没有某个调用"时必须连字符串一起剥，
 *  否则**本文件自己的断言消息与注释里的字面量会把守卫喂饱**（本仓库已三次栽在这上面）。 */
function maskCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      // 保留换行，这样行号仍然可用
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      // 字符串内容替换成两个占位字符（保留引号，避免把两侧的代码粘在一起）
      out += ch + ' ' + ch;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CODE = maskCommentsAndStrings(SRC);

function makeProvider() {
  const provider = new WalineProvider({} as any, {} as any);
  const runMock = jest.fn().mockResolvedValue(undefined);
  // 只桩掉"拉起子进程"这一层；退避状态机跑真代码
  (provider as any).run = runMock;
  return { provider, runMock };
}

/** 连续触发 n 次"子进程意外退出 ⇒ scheduleRestart"，返回每次调度后的状态快照。 */
function crash(provider: any) {
  provider.scheduleRestart();
}

async function advance(ms: number) {
  const anyJest = jest as any;
  if (typeof anyJest.advanceTimersByTimeAsync === 'function') {
    await anyJest.advanceTimersByTimeAsync(ms);
    return;
  }
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
}

describe('WalineProvider 慢速重试：快速阶梯用尽后永不彻底放弃', () => {
  let provider: any;
  let runMock: jest.Mock;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.VANBLOG_WALINE_SLOW_RETRY_MS;
    // 🔴 **所有测试必须共用这一个实例**：logger 间谍是打在实例上的，
    //    如果 beforeEach 造一个、测试里再造一个，间谍就打在**另一个对象**上 ⇒
    //    "断言 ERROR 只记一次"会因为**永远抓不到任何调用**而恒真地通过。
    //    （这正是本仓库"替身钉住作者假设"那一族的一个变体。）
    const made = makeProvider();
    provider = made.provider;
    runMock = made.runMock;
    errorSpy = jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    errorSpy.mockClear();
    logSpy.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.VANBLOG_WALINE_SLOW_RETRY_MS;
  });

  it('前 5 次崩溃走快速阶梯（2/4/6/8/10 秒），第 6 次转入慢速段而不是放弃', async () => {
    // 反空转：起始状态必须是干净的
    expect((provider as any).restartAttempts).toBe(0);
    expect((provider as any).inSlowRetry).toBe(false);

    // 前 5 次：每次崩溃后都有一个待触发的定时器，且尚未进入慢速段
    for (let i = 1; i <= 5; i += 1) {
      crash(provider);
      expect((provider as any).restartAttempts).toBe(i);
      expect((provider as any).inSlowRetry).toBe(false);
      expect(jest.getTimerCount()).toBe(1);
      await advance(2000 * i); // 阶梯上限 30 秒，这里每次都足够
      jest.clearAllTimers();
    }
    expect(runMock).toHaveBeenCalledTimes(5);

    // 🔴 第 6 次：改动前这里会 `return`（永久放弃）；改动后必须**仍然设一个定时器**
    crash(provider);
    expect(jest.getTimerCount()).toBe(1);
    expect((provider as any).inSlowRetry).toBe(true);
    expect((provider as any).slowRetries).toBe(1);
    // 快速阶梯的计数不再增长（它已用尽）
    expect((provider as any).restartAttempts).toBe(5);

    // 默认 5 分钟：4 分 59 秒时还没重试，5 分钟时才重试
    runMock.mockClear();
    await advance(5 * 60 * 1000 - 1000);
    expect(runMock).not.toHaveBeenCalled();
    await advance(1000);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('慢速段是**无限**的：连续 40 次慢速重试每次都仍然调度下一次', async () => {
    for (let i = 0; i < 5; i += 1) {
      crash(provider);
      jest.clearAllTimers();
    }
    for (let i = 0; i < 40; i += 1) {
      crash(provider);
      // 🔴 核心不变量：每一次 scheduleRestart 都必须留下一个待触发的定时器
      expect(jest.getTimerCount()).toBe(1);
      expect((provider as any).slowRetries).toBe(i + 1);
      await advance(5 * 60 * 1000);
      jest.clearAllTimers();
    }
    expect(runMock).toHaveBeenCalledTimes(40);
    expect((provider as any).inSlowRetry).toBe(true);
  });

  it('只在**进入**慢速段那一次记 ERROR，之后每次慢速重试不再重复记（否则 doctor 的计数会被稳态问题刷爆）', async () => {
    for (let i = 0; i < 5; i += 1) {
      crash(provider);
      jest.clearAllTimers();
    }
    errorSpy.mockClear();
    crash(provider); // 第 6 次 = 进入慢速段
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('VANBLOG_WALINE_SLOW_RETRY_MS');
    // 🔴 文案必须说清"仍然会自动重试"，否则运维会以为彻底放弃了
    expect(msg).toContain('仍会自动重试');

    errorSpy.mockClear();
    for (let i = 0; i < 5; i += 1) {
      crash(provider);
      jest.clearAllTimers();
    }
    // 后续 5 次慢速重试一条 ERROR 都不该再记
    expect(errorSpy).not.toHaveBeenCalled();
    expect((provider as any).slowRetries).toBe(6);
  });

  it('慢速重试真的会去拉起 waline，而不是只设一个空定时器', async () => {
    for (let i = 0; i < 6; i += 1) {
      crash(provider);
      if (i < 5) {
        jest.clearAllTimers();
      }
    }
    runMock.mockClear();
    await advance(5 * 60 * 1000);
    expect(runMock).toHaveBeenCalledTimes(1);
    // 日志要说清这是慢速重试（排障时"第几次"很重要）
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('慢速重试');
  });

  it('慢速重试拉起失败时会再次调度（不会一次失败就彻底停手）', async () => {
    runMock.mockRejectedValue(new Error('8360 端口被占'));
    for (let i = 0; i < 6; i += 1) {
      crash(provider);
      if (i < 5) {
        jest.clearAllTimers();
      }
    }
    await advance(5 * 60 * 1000);
    await Promise.resolve();
    // run() 抛错 ⇒ catch 里再 scheduleRestart ⇒ 仍然有下一个定时器
    expect(jest.getTimerCount()).toBe(1);
  });

  it('主动 stop() 之后不再自动重启（既有的互斥性质没有被慢速重试破坏）', async () => {
    for (let i = 0; i < 6; i += 1) {
      crash(provider);
      if (i < 5) {
        jest.clearAllTimers();
      }
    }
    (provider as any).stopping = true;
    jest.clearAllTimers();
    crash(provider);
    expect(jest.getTimerCount()).toBe(0);
    await advance(60 * 60 * 1000);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('手动 restart() 会把三个退避状态一起清掉（文档里写明的补救手段必须真的有效）', async () => {
    for (let i = 0; i < 6; i += 1) {
      crash(provider);
      jest.clearAllTimers();
    }
    expect((provider as any).restartAttempts).toBe(5);
    expect((provider as any).inSlowRetry).toBe(true);
    // ⚠️ 是 1 不是 6：6 次崩溃里只有**第 6 次**进入慢速段（前 5 次涨的是 restartAttempts）
    expect((provider as any).slowRetries).toBe(1);

    // restart() 在环境变量未变化时会提前 return；这里让它走到真正的重启路径
    (provider as any).env = { SENTINEL: 'before' };
    (provider as any).loadEnv = jest.fn().mockResolvedValue(undefined);
    (provider as any).stop = jest.fn().mockResolvedValue(undefined);
    await (provider as any).restart('测试');

    expect((provider as any).restartAttempts).toBe(0);
    expect((provider as any).inSlowRetry).toBe(false);
    expect((provider as any).slowRetries).toBe(0);
    // 🔴 清完之后，下一次崩溃必须重新走**快速**阶梯（而不是直接进慢速段），
    //    并且必须**重新记一条 ERROR**（否则"评论系统又坏了一次"这个信号会永久丢失）
    errorSpy.mockClear();
    crash(provider);
    expect((provider as any).restartAttempts).toBe(1);
    expect((provider as any).inSlowRetry).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('VANBLOG_WALINE_SLOW_RETRY_MS：任何输入都产生不出 0 间隔', () => {
  let provider: any;
  let runMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.VANBLOG_WALINE_SLOW_RETRY_MS;
    const made = makeProvider();
    provider = made.provider;
    runMock = made.runMock;
    jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.VANBLOG_WALINE_SLOW_RETRY_MS;
  });

  const cases: Array<[string, string, number]> = [
    ['缺失', '', 300000],
    ['空串', '   ', 300000],
    ['非数字', 'abc', 300000],
    ['NaN 形状', 'NaN', 300000],
    ['Infinity', 'Infinity', 300000],
    // 🔴 0 与负数是最危险的两个：0 会变成紧密重启风暴（比永久放弃更糟）
    ['零', '0', 300000],
    ['负数', '-1', 300000],
    ['小于下限', '1000', 60000],
    ['大于上限', String(99 * 60 * 60 * 1000), 60 * 60 * 1000],
    ['合法值', '120000', 120000],
    ['合法下限', '60000', 60000],
    ['合法上限', '3600000', 3600000],
  ];

  it.each(cases)('%s ⇒ 间隔为 %i 毫秒且绝不小于 1 分钟', (_label, raw, expected) => {
    if (raw === '') {
      delete process.env.VANBLOG_WALINE_SLOW_RETRY_MS;
    } else {
      process.env.VANBLOG_WALINE_SLOW_RETRY_MS = raw;
    }
    const got = (provider as any).slowRetryMs();
    expect(got).toBe(expected);
    // 🔴 这条才是安全性质本身：无论输入是什么，都不可能产生 0（或负数）间隔
    expect(got).toBeGreaterThan(0);
    expect(got).toBeGreaterThanOrEqual(60 * 1000);
  });

  it('配置的间隔真的被用上（不是只读了 env 却仍写死 5 分钟）', async () => {
    process.env.VANBLOG_WALINE_SLOW_RETRY_MS = '60000';
    for (let i = 0; i < 6; i += 1) {
      crash(provider);
      if (i < 5) {
        jest.clearAllTimers();
      }
    }
    runMock.mockClear();
    await advance(59 * 1000);
    expect(runMock).not.toHaveBeenCalled();
    await advance(1000);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('每次调用都重新读 env（不是模块级常量），所以改环境变量并重启就能生效', () => {
    process.env.VANBLOG_WALINE_SLOW_RETRY_MS = '90000';
    expect((provider as any).slowRetryMs()).toBe(90000);
    process.env.VANBLOG_WALINE_SLOW_RETRY_MS = '120000';
    expect((provider as any).slowRetryMs()).toBe(120000);
  });
});

describe('WalineProvider 源码守卫：钉住慢速重试的形状', () => {
  /** 只取 `scheduleRestart()` 的函数体：全文 indexOf 会命中别的方法
   *  （本仓库已两次因为"锚点在别的函数里也出现"而量错对象）。 */
  function scheduleRestartBody(): string {
    const start = CODE.indexOf('scheduleRestart()');
    expect(start).toBeGreaterThan(0);
    // 从签名后的第一个 `{` 开始做括号配平
    const braceStart = CODE.indexOf('{', start);
    expect(braceStart).toBeGreaterThan(start);
    let depth = 0;
    for (let i = braceStart; i < CODE.length; i += 1) {
      if (CODE[i] === '{') depth += 1;
      else if (CODE[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          return CODE.slice(braceStart, i + 1);
        }
      }
    }
    throw new Error('没有配平到 scheduleRestart 的结尾');
  }

  it('尺子有效性：剥离器与切片器真的在工作（否则下面所有断言都可能恒真）', () => {
    // 剥离器：注释里的字面量不该被当成代码
    expect(maskCommentsAndStrings('// VANBLOG_ONLY_IN_A_COMMENT_XYZ\nconst a = 1;')).not.toContain(
      'VANBLOG_ONLY_IN_A_COMMENT_XYZ',
    );
    expect(maskCommentsAndStrings("const s = 'VANBLOG_ONLY_IN_A_STRING_XYZ';")).not.toContain(
      'VANBLOG_ONLY_IN_A_STRING_XYZ',
    );
    // 切片器：确实只取了 scheduleRestart 那一段（长度非平凡，且不含别的方法名）
    const body = scheduleRestartBody();
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain('mapConfig2Env');
    expect(body).not.toContain('buildWalineMongoEnv');
  });

  it('🔴 快速阶梯用尽后**不许 return 而不设定时器**（永久放弃正是被修掉的缺陷）', () => {
    const body = scheduleRestartBody();
    // `restartAttempts >= 5` 那个分支必须在里面
    expect(body).toContain('restartAttempts >= 5');
    // 🔴 该分支里必须调用 slowRetryMs() 取间隔 —— 这是"转入慢速段"的证据
    expect(body).toContain('this.slowRetryMs()');
    // 🔴 并且 `setTimeout` 必须出现在分支**之后**（即两个分支共用同一个设定时器的出口），
    //    否则"分支里 return 掉"的形状又会回来
    const branchAt = body.indexOf('restartAttempts >= 5');
    const timeoutAt = body.indexOf('setTimeout(');
    expect(branchAt).toBeGreaterThan(0);
    expect(timeoutAt).toBeGreaterThan(branchAt);
  });

  it('间隔由 envPositiveInt 夹取，所以任何输入都产生不出 0 间隔', () => {
    // ⚠️ 这里必须用 SRC 而不是 CODE：变量名是**字符串字面量**，而 CODE 把字符串内容剥掉了
    //    （剥字符串是为了别的断言不被注释/消息喂饱 —— 🔴 **剥多少取决于你要断言什么**）。
    const call = "envPositiveInt('VANBLOG_WALINE_SLOW_RETRY_MS'";
    expect(SRC).toContain(call);
    // 🔴 上下限就写在调用里：[1 分钟, 1 小时]
    const tail = SRC.slice(SRC.indexOf(call), SRC.indexOf(call) + 200);
    expect(tail).toContain('60 * 1000');
    expect(tail).toContain('60 * 60 * 1000');
  });

  it('🔴 定时器必须 unref：慢速段最长 1 小时，而本 provider 没有 onModuleDestroy', () => {
    const body = scheduleRestartBody();
    expect(body).toContain('unref');
    // 反空转 / 前提核实：确实没有 onModuleDestroy 来清这个定时器（唯一清理点是 stop()）
    expect(CODE).not.toContain('onModuleDestroy');
    expect(CODE).toContain('clearTimeout(this.restartTimer)');
  });

  it('只在进入慢速段时记 ERROR（`if (!this.inSlowRetry)` 那道门必须在）', () => {
    const body = scheduleRestartBody();
    expect(body).toContain('!this.inSlowRetry');
    expect(body).toContain('this.inSlowRetry = true');
  });

  it('🔴 "存活 >60s 归零"必须把三个状态一起清（只清计数会让 ERROR 信号永久丢失）', () => {
    // exit 钩子里那段：稳定跑过一分钟才算"正常运行后退出"
    const at = SRC.indexOf('稳定跑过一分钟才算');
    expect(at).toBeGreaterThan(0);
    const window = SRC.slice(at, at + 700);
    expect(window).toContain('this.restartAttempts = 0');
    expect(window).toContain('this.inSlowRetry = false');
    expect(window).toContain('this.slowRetries = 0');
  });

  it('🔴 手动 restart() 也必须清三个状态（文档写明的补救手段）', () => {
    const at = SRC.indexOf('重启 waline`);');
    expect(at).toBeGreaterThan(0);
    const window = SRC.slice(at, at + 800);
    expect(window).toContain('this.restartAttempts = 0');
    expect(window).toContain('this.inSlowRetry = false');
    expect(window).toContain('this.slowRetries = 0');
  });

  it('🔴 不与 website 共用同一个环境变量名（两者严重度不同，站长应当能分别调）', () => {
    // 🔴 只从 **envPositiveInt 的调用点**取名字，不要全文搜变量名：
    //    本文件的注释里就提到了 website 那个变量名（为了解释"为什么刻意不共用"），
    //    全文 `not.toContain` 会被**自己写的注释**喂饱而恒红 —— 这正是本仓库记过三次的坑。
    const names: string[] = [];
    const re = /envPositiveInt\(\s*'([A-Za-z0-9_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC)) !== null) {
      names.push(m[1]);
    }
    // 反空转：确实解析到了调用点
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(names).toContain('VANBLOG_WALINE_SLOW_RETRY_MS');
    expect(names).not.toContain('VANBLOG_WEBSITE_SLOW_RETRY_MS');
    // 🔴 这个文件里只应当有这一个 envPositiveInt 调用点（多了说明有人又加了一个旋钮）
    expect(names).toEqual(['VANBLOG_WALINE_SLOW_RETRY_MS']);
  });

  it('既有的互斥与守卫性质没有被破坏：stopping 早退、已有子进程时不重复拉起', () => {
    const body = scheduleRestartBody();
    expect(body).toContain('if (this.stopping)');
    expect(body).toContain('this.stopping || this.ctx');
    expect(body).toContain('clearTimeout(this.restartTimer)');
  });

  it('cluster worker 不 spawn 的既有性质仍然在（多 worker 会抢 8360 端口）', () => {
    expect(CODE).toContain('isPrimaryInstance(cluster)');
  });
});
