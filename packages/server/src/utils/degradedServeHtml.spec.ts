import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CADDY_SERVE_HTML_DYNAMIC_SENTINEL,
  CADDY_SERVE_HTML_SENTINEL,
  DEFAULT_WEBSITE_PAGES_DIR,
  SERVE_HTML_PAGES_DIR_ENV,
} from 'src/provider/caddy/caddy.provider';
import {
  DegradedPublishingOutcome,
  enableDegradedServeHtml,
  enterDegradedPublishing,
  exitDegradedPublishing,
  resolveServeHtmlSentinelDir,
  restoreServeHtmlSentinels,
  snapshotServeHtmlSentinels,
} from './degradedServeHtml';

/**
 * 降级发布的哨兵读写。
 *
 * ⚠️ 全部在**真实临时目录**上跑，不用内存替身：这个模块的全部价值就是"文件真的被写在那儿、
 * 名字真的对得上 caddy 模板要查的那个"。用假 fs 恰好会把最容易出错的那部分（路径拼接）测掉。
 *
 * ⚠️ 哨兵文件名与目录**从 `caddy.provider` 导入**再断言，所以"两边漂了"这件事测不出来 ——
 * 那是有意的：漂不移的正确防线是**只有一处定义**（本模块 import 而不是重抄），
 * 而"import 的来源对不对"由下面的『路径与 CaddyProvider 同源』那组用例钉住。
 */

const SILENT = { warn: () => undefined, log: () => undefined };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-degraded-html-'));
}

describe('resolveServeHtmlSentinelDir：与 CaddyProvider 同一个解析口径', () => {
  const saved = process.env[SERVE_HTML_PAGES_DIR_ENV];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    } else {
      process.env[SERVE_HTML_PAGES_DIR_ENV] = saved;
    }
  });

  it('未设置时用镜像里的固定布局', () => {
    delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    expect(resolveServeHtmlSentinelDir({})).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('设置了就用它（开发环境/自定义布局靠这个）', () => {
    const env = { [SERVE_HTML_PAGES_DIR_ENV]: '/tmp/whatever/pages' };
    expect(resolveServeHtmlSentinelDir(env as NodeJS.ProcessEnv)).toBe('/tmp/whatever/pages');
  });

  it('⚠️ 哨兵文件名与 CaddyProvider 导出的常量一致（写错名字 = 静默失效，caddy 永远看不到）', () => {
    const d = tmpDir();
    try {
      expect(enableDegradedServeHtml({ dir: d, log: SILENT })).toBe(true);
      expect(fs.existsSync(path.join(d, CADDY_SERVE_HTML_SENTINEL))).toBe(true);
      expect(fs.existsSync(path.join(d, CADDY_SERVE_HTML_DYNAMIC_SENTINEL))).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('enableDegradedServeHtml：写 all 档（固定页 + 动态前缀）', () => {
  let d: string;
  beforeEach(() => {
    d = tmpDir();
  });
  afterEach(() => fs.rmSync(d, { recursive: true, force: true }));

  it('两个哨兵都写出来，返回 true', () => {
    expect(enableDegradedServeHtml({ dir: d, log: SILENT })).toBe(true);
    const fixed = fs.readFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'utf8');
    const dyn = fs.readFileSync(path.join(d, CADDY_SERVE_HTML_DYNAMIC_SENTINEL), 'utf8');
    expect(fixed).toContain('level=all');
    expect(dyn).toContain('level=all');
  });

  it('哨兵内容说明了"为什么存在"与"谁写的"（现场排查时这行字就是全部线索）', () => {
    enableDegradedServeHtml({ dir: d, log: SILENT });
    const fixed = fs.readFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'utf8');
    expect(fixed).toContain('degraded-hold');
    expect(fixed).toMatch(/database unreachable/i);
    expect(fixed).toContain('main.ts');
  });

  it('⚠️ 只写固定页那一档是不够的：动态前缀哨兵必须也在（否则 /post/* 仍然 502）', () => {
    enableDegradedServeHtml({ dir: d, log: SILENT });
    const snap = snapshotServeHtmlSentinels(d);
    expect(snap.fixed).toBe(true);
    expect(snap.dynamic).toBe(true);
  });

  it('目录不存在时返回 false 并**打 warn**，绝不抛异常（静默失效是最坏的失败方式）', () => {
    const warns: string[] = [];
    const missing = path.join(d, 'no-such-subdir');
    let threw = false;
    let result: boolean | undefined;
    try {
      result = enableDegradedServeHtml({
        dir: missing,
        log: { warn: (m) => warns.push(m), log: () => undefined },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
    expect(warns).toHaveLength(1);
    // ⚠️ warn 必须说清后果（"页面请求仍会 502"），否则运维会以为降级发布在工作
    expect(warns[0]).toContain('502');
    expect(warns[0]).toContain(missing);
  });
});

describe('snapshotServeHtmlSentinels：读状态，绝不抛', () => {
  it('目录不存在 ⇒ 两个都 false（开发环境没有 website 构建产物就是这种）', () => {
    const snap = snapshotServeHtmlSentinels('/nonexistent-vanblog-test-dir');
    expect(snap).toMatchObject({ fixed: false, dynamic: false });
    expect(snap.dir).toBe('/nonexistent-vanblog-test-dir');
  });

  it('只有一个哨兵时如实反映（半套状态是可能出现的：写第二个时失败）', () => {
    const d = tmpDir();
    try {
      fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'level=fixed; x');
      const snap = snapshotServeHtmlSentinels(d);
      expect(snap.fixed).toBe(true);
      expect(snap.dynamic).toBe(false);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('restoreServeHtmlSentinels：**精确还原**，不是无条件删', () => {
  it('降级前是 off ⇒ 恢复后两个哨兵都被删掉（否则站点会一直发旧 HTML 而没人知道）', () => {
    const d = tmpDir();
    try {
      const before = snapshotServeHtmlSentinels(d);
      expect(before).toMatchObject({ fixed: false, dynamic: false });
      enableDegradedServeHtml({ dir: d, log: SILENT });
      expect(snapshotServeHtmlSentinels(d)).toMatchObject({ fixed: true, dynamic: true });
      restoreServeHtmlSentinels(before, { log: SILENT });
      expect(snapshotServeHtmlSentinels(d)).toMatchObject({ fixed: false, dynamic: false });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('🔴 降级前站长手动开了 all ⇒ 恢复后**仍然开着**（无条件删会把站长的配置关掉）', () => {
    const d = tmpDir();
    try {
      fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'level=all; 站长手动开的');
      fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_DYNAMIC_SENTINEL), 'level=all; 站长手动开的');
      const before = snapshotServeHtmlSentinels(d);
      expect(before).toMatchObject({ fixed: true, dynamic: true });

      enableDegradedServeHtml({ dir: d, log: SILENT });
      restoreServeHtmlSentinels(before, { log: SILENT });

      const after = snapshotServeHtmlSentinels(d);
      expect(after).toMatchObject({ fixed: true, dynamic: true });
      // 内容已经被换掉，但"存在"这件事被保住了 —— CaddyProvider 的 60 秒对账会接管为权威状态
      expect(fs.readFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'utf8')).toContain(
        'restored-after-degraded-hold',
      );
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('降级前只开了固定页 ⇒ 恢复后固定页在、动态页被删（半套状态也要精确还原）', () => {
    const d = tmpDir();
    try {
      fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'level=fixed; 站长手动开的');
      const before = snapshotServeHtmlSentinels(d);
      enableDegradedServeHtml({ dir: d, log: SILENT });
      restoreServeHtmlSentinels(before, { log: SILENT });
      expect(snapshotServeHtmlSentinels(d)).toMatchObject({ fixed: true, dynamic: false });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('还原时目录已经没了 ⇒ 不抛异常，只打 warn（并提示去哪查）', () => {
    const d = tmpDir();
    const warns: string[] = [];
    fs.rmSync(d, { recursive: true, force: true });
    let threw = false;
    try {
      restoreServeHtmlSentinels(
        { dir: d, fixed: true, dynamic: true },
        { log: { warn: (m) => warns.push(m), log: () => undefined } },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain('对账');
  });
});

describe('往返一致性（降级 → 恢复 是幂等的）', () => {
  it.each([
    ['off', false, false],
    ['fixed', true, false],
    ['all', true, true],
  ])('降级前是 %s 档，往返后仍然是 %s 档', (_label, fixed, dynamic) => {
    const d = tmpDir();
    try {
      if (fixed) {
        fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_SENTINEL), 'level=x; pre');
      }
      if (dynamic) {
        fs.writeFileSync(path.join(d, CADDY_SERVE_HTML_DYNAMIC_SENTINEL), 'level=x; pre');
      }
      const before = snapshotServeHtmlSentinels(d);
      expect(before).toMatchObject({ fixed, dynamic });

      enableDegradedServeHtml({ dir: d, log: SILENT });
      restoreServeHtmlSentinels(before, { log: SILENT });
      expect(snapshotServeHtmlSentinels(d)).toMatchObject({ fixed, dynamic });

      // 再来一轮，结果不变（幂等）
      const before2 = snapshotServeHtmlSentinels(d);
      enableDegradedServeHtml({ dir: d, log: SILENT });
      restoreServeHtmlSentinels(before2, { log: SILENT });
      expect(snapshotServeHtmlSentinels(d)).toMatchObject({ fixed, dynamic });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});


/**
 * 🔴 本组用例钉的是**失败契约**：这些函数只在「降级驻留」路径上被调用 —— 数据库在启动期
 * 一直连不上、进程**必须活下去**的时刻。一个尽力而为的辅助步骤在这里抛异常，后果是
 * `main()` 的 `.catch()` 把整个启动打死、退出码 1、容器重启 ⇒ 从"降级但仍在发布"
 * 直接掉回"完全下线"。
 *
 * 实测事故（2026-09-20，活体日志 `vanblog_dev/tmp/defect-degraded-crash.log`）：
 * 降级驻留已经打出完整的三条下一步之后，`snapshotServeHtmlSentinels` 抛 TypeError ⇒ 进程退出码 1。
 * 那一次的**直接**原因是验证脚手架的混代产物（AGENTS.md §7.79c），不是产品缺陷；
 * 但它**暴露的缺陷是真的** —— 生产里同样会触发的形状：pages 目录不可读/不可写
 * （只读挂载、权限不对、卷没挂上、目录被删）、磁盘满 ENOSPC、EACCES/EROFS。
 *
 * ⚠️ 触发器全部用**真实 fs 错误**，不用假 fs：
 *  - 目录参数不是字符串 ⇒ `path.join` 抛 TypeError（这条正是修复前穿透出去的形状：
 *    解析/拼路径写在 try 之外）；
 *  - 目录的父路径是一个**文件** ⇒ `writeFileSync` 抛 ENOTDIR；
 *  - 日志器自己抛 ⇒ 验证 `safeWarn` 的兜底（"把失败说出来"这个动作本身不该杀进程）。
 */
describe('🔴 绝不抛异常：尽力而为的步骤不许打死启动流程', () => {
  const saved = process.env[SERVE_HTML_PAGES_DIR_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    else process.env[SERVE_HTML_PAGES_DIR_ENV] = saved;
  });

  /** 造一个"父路径是文件"的目录字符串 ⇒ 任何写/读都会 ENOTDIR。 */
  function notADirectory(): string {
    const d = tmpDir();
    const aFile = path.join(d, 'i-am-a-file');
    fs.writeFileSync(aFile, 'x');
    return path.join(aFile, 'pages');
  }

  it('snapshotServeHtmlSentinels：目录参数不是字符串 ⇒ 不抛，当成"没传"回落到 env 解析', () => {
    // ⚠️ 这条**不是** readFailed：非字符串被当成"调用方没提供目录"，于是照常从 env 解析并
    //    读到真实状态 ⇒ 快照可信。我第一版把它断言成 readFailed，那是**我发明的契约**而不是
    //    产品的契约（本仓库刚记过这条教训：不要为不可达的形状写测试）。该钉的性质是"绝不抛"。
    let snap: ReturnType<typeof snapshotServeHtmlSentinels> | undefined;
    expect(() => {
      snap = snapshotServeHtmlSentinels(123 as unknown as string, SILENT);
    }).not.toThrow();
    expect(snap?.readFailed).toBeUndefined();
    // ⚠️ dir 必须仍然是一个**可用的字符串**（调用方会把它打进日志），不能是 undefined
    expect(typeof snap?.dir).toBe('string');
    expect(snap?.dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
  });

  it('snapshotServeHtmlSentinels：目录不可读（ENOTDIR）⇒ 不抛，标记 readFailed', () => {
    const dir = notADirectory();
    let snap: ReturnType<typeof snapshotServeHtmlSentinels> | undefined;
    expect(() => {
      snap = snapshotServeHtmlSentinels(dir, SILENT);
    }).not.toThrow();
    // ⚠️ 这条区分了"目录不存在"（正常，两个都 false 且**可信**）与"读不了"（故障，不可信）
    expect(snap?.readFailed).toBe(true);
    expect(snap?.dir).toBe(dir);
  });

  it('对照：目录只是**不存在**（开发机没有 website 产物）⇒ 不是 readFailed，快照可信', () => {
    const snap = snapshotServeHtmlSentinels(path.join(tmpDir(), 'nope'), SILENT);
    expect(snap.readFailed).toBeUndefined();
    expect(snap.fixed).toBe(false);
    expect(snap.dynamic).toBe(false);
  });

  it('enableDegradedServeHtml：目录参数不是字符串 ⇒ 不抛，返回 false（修复前这一步会抛）', () => {
    let out: boolean | undefined;
    expect(() => {
      out = enableDegradedServeHtml({ dir: 123 as unknown as string, log: SILENT });
    }).not.toThrow();
    expect(out).toBe(false);
  });

  it('enableDegradedServeHtml：目录不可写（ENOTDIR）⇒ 不抛，返回 false', () => {
    let out: boolean | undefined;
    expect(() => {
      out = enableDegradedServeHtml({ dir: notADirectory(), log: SILENT });
    }).not.toThrow();
    expect(out).toBe(false);
  });

  it('restoreServeHtmlSentinels：快照 dir 不是字符串 ⇒ 不抛（修复前 path.join 在 try 之外）', () => {
    expect(() => {
      restoreServeHtmlSentinels(
        { dir: 123 as unknown as string, fixed: false, dynamic: false },
        { log: SILENT },
      );
    }).not.toThrow();
  });

  it('restoreServeHtmlSentinels：快照是 null/undefined ⇒ 不抛，只 WARN', () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), log: () => undefined };
    expect(() => {
      restoreServeHtmlSentinels(null as unknown as never, { log });
    }).not.toThrow();
    expect(warns.join('\n')).toContain('跳过还原');
  });

  it('🔴 日志器自己抛异常时，三个函数仍然不抛（"把失败说出来"这个动作不该杀进程）', () => {
    const broken = {
      warn: () => {
        throw new Error('logger is broken');
      },
      log: () => {
        throw new Error('logger is broken');
      },
    };
    // safeWarn 会退到 console.warn；这里把它也 stub 掉，避免测试输出噪音，
    // 并顺便证明**兜底路径真的被走到了**（否则这条用例只是"没抛"而已）。
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => snapshotServeHtmlSentinels(123 as unknown as string, broken)).not.toThrow();
      expect(() =>
        enableDegradedServeHtml({ dir: 123 as unknown as string, log: broken }),
      ).not.toThrow();
      expect(() =>
        restoreServeHtmlSentinels({ dir: 123 as unknown as string, fixed: false, dynamic: false }, { log: broken }),
      ).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('WARN 文案说清了"影响是什么"与"要不要处理"（灾难现场只有这行字）', () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), log: () => undefined };
    enableDegradedServeHtml({ dir: notADirectory(), log });
    const text = warns.join('\n');
    expect(text).toContain('502'); // 影响：页面仍发不出去
    expect(text).toContain('/api/public/health'); // 但 health 与 /static/* 不受影响
    expect(text).toContain('要不要处理'); // 明确告诉运维该不该动手
    expect(text).toContain(SERVE_HTML_PAGES_DIR_ENV); // 指向可能配错的那个旋钮
  });
});

describe('🔴 共用解析器本身抛异常时（= 实测事故的形状），三个入口都不许穿透', () => {
  /**
   * ⚠️ 为什么必须用 spy：`resolveServeHtmlSentinelDir` 现在自己就兜住了一切，所以在**一致构建**里
   * 根本造不出"解析器抛异常"。而实测事故恰恰是这个形状（混代产物里 `resolveWebsitePagesDir`
   * 是 undefined ⇒ 调用即 TypeError）。不 mock 就测不到 ⇒ 变异对照 M7 会 NOT_RED，
   * 而那**不是**变异没生效，是这条性质当时**没有任何守卫覆盖**。
   */
  const caddyProvider = require('src/provider/caddy/caddy.provider');

  it('enableDegradedServeHtml：解析器抛 ⇒ 返回 false、不抛、并 WARN', () => {
    const spy = jest
      .spyOn(caddyProvider, 'resolveWebsitePagesDir')
      .mockImplementation(() => {
        throw new TypeError('resolveWebsitePagesDir is not a function');
      });
    const warns: string[] = [];
    try {
      let out: boolean | undefined;
      expect(() => {
        out = enableDegradedServeHtml({ log: { warn: (m: string) => warns.push(m), log: () => undefined } });
      }).not.toThrow();
      expect(out).toBe(false);
      expect(warns.join('\n')).toContain('502');
    } finally {
      spy.mockRestore();
    }
  });

  it('snapshotServeHtmlSentinels：解析器抛 ⇒ 不抛，**回落到默认目录**并照常读到可信快照', () => {
    // ⚠️ 我第一版断言这里会 readFailed，那是错的：`resolveServeHtmlSentinelDir` 自己兜住了
    //    解析器异常并回落 `DEFAULT_WEBSITE_PAGES_DIR`，随后对默认目录的读取是**成功**的 ⇒
    //    快照可信，不该标 readFailed（标了反而会让还原被跳过、哨兵残留）。
    //    readFailed 只属于"连状态都读不出来"那一档（见上面 ENOTDIR 那组用例）。
    const spy = jest
      .spyOn(caddyProvider, 'resolveWebsitePagesDir')
      .mockImplementation(() => {
        throw new TypeError('resolveWebsitePagesDir is not a function');
      });
    const warns: string[] = [];
    try {
      let snap: ReturnType<typeof snapshotServeHtmlSentinels> | undefined;
      expect(() => {
        snap = snapshotServeHtmlSentinels(undefined, {
          warn: (m: string) => warns.push(m),
          log: () => undefined,
        });
      }).not.toThrow();
      expect(snap?.dir).toBe(DEFAULT_WEBSITE_PAGES_DIR);
      expect(snap?.readFailed).toBeUndefined();
      // 回落必须**说出来**：静默回落会让运维以为自定义目录生效了
      expect(warns.join('\n')).toContain('回落到镜像默认目录');
    } finally {
      spy.mockRestore();
    }
  });

  it('enterDegradedPublishing：解析器抛 ⇒ enabled=false、不抛（降级驻留必须继续）', () => {
    const spy = jest
      .spyOn(caddyProvider, 'resolveWebsitePagesDir')
      .mockImplementation(() => {
        throw new TypeError('boom');
      });
    try {
      let out: DegradedPublishingOutcome | undefined;
      expect(() => {
        out = enterDegradedPublishing(SILENT);
      }).not.toThrow();
      expect(out?.enabled).toBe(false);
      expect(() => exitDegradedPublishing(out as DegradedPublishingOutcome, SILENT)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('⚠️ 反证：spy 真的生效了（否则上面三条都是"没抛"的恒真断言）', () => {
    const spy = jest
      .spyOn(caddyProvider, 'resolveWebsitePagesDir')
      .mockImplementation(() => {
        throw new TypeError('boom');
      });
    try {
      expect(() => caddyProvider.resolveWebsitePagesDir('/ok')).toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    // 还原后必须恢复正常（证明 mockRestore 有效，不会污染后面的用例）
    expect(typeof caddyProvider.resolveWebsitePagesDir('/ok')).toBe('object');
  });
});

describe('🔴 readFailed 快照 ⇒ 还原时**跳过**，绝不误删站长手动开的 SERVE_HTML', () => {
  it('快照不可信时，两个已存在的哨兵都**保留**（而不是被当成"原来没有"删掉）', () => {
    const dir = tmpDir();
    const fixed = path.join(dir, CADDY_SERVE_HTML_SENTINEL);
    const dynamic = path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL);
    // 模拟"站长本来就手动开了 all"
    fs.writeFileSync(fixed, 'level=all; operator\n');
    fs.writeFileSync(dynamic, 'level=all; operator\n');

    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m), log: () => undefined };
    restoreServeHtmlSentinels({ dir, fixed: false, dynamic: false, readFailed: true }, { log });

    expect(fs.existsSync(fixed)).toBe(true);
    expect(fs.existsSync(dynamic)).toBe(true);
    const text = warns.join('\n');
    expect(text).toContain('跳过还原');
    expect(text).toContain(CADDY_SERVE_HTML_SENTINEL); // 手工清理办法：点名文件
    expect(text).toContain(CADDY_SERVE_HTML_DYNAMIC_SENTINEL);
    expect(text).toContain('60 秒对账'); // 后果由谁兜住
  });

  it('对照：快照**可信**且原来是 off ⇒ 哨兵被删掉（证明上面那条不是"永远不删"的恒真断言）', () => {
    const dir = tmpDir();
    const fixed = path.join(dir, CADDY_SERVE_HTML_SENTINEL);
    const dynamic = path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL);
    fs.writeFileSync(fixed, 'level=all; degraded-hold\n');
    fs.writeFileSync(dynamic, 'level=all; degraded-hold\n');

    restoreServeHtmlSentinels({ dir, fixed: false, dynamic: false }, { log: SILENT });

    expect(fs.existsSync(fixed)).toBe(false);
    expect(fs.existsSync(dynamic)).toBe(false);
  });
});

describe('enterDegradedPublishing / exitDegradedPublishing：main.ts 唯一该调的两个入口', () => {
  const saved = process.env[SERVE_HTML_PAGES_DIR_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    else process.env[SERVE_HTML_PAGES_DIR_ENV] = saved;
  });

  it('正常往返：进入写出两个哨兵，退出按快照删干净', () => {
    const dir = tmpDir();
    process.env[SERVE_HTML_PAGES_DIR_ENV] = dir;
    const outcome = enterDegradedPublishing(SILENT);
    expect(outcome.enabled).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.snapshot.dir).toBe(dir);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_SENTINEL))).toBe(true);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL))).toBe(true);

    exitDegradedPublishing(outcome, SILENT);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_SENTINEL))).toBe(false);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL))).toBe(false);
  });

  it('🔴 目录不可用时：不抛、enabled=false、且 exit 也不抛（降级驻留必须继续）', () => {
    const d = tmpDir();
    const aFile = path.join(d, 'i-am-a-file');
    fs.writeFileSync(aFile, 'x');
    process.env[SERVE_HTML_PAGES_DIR_ENV] = path.join(aFile, 'pages'); // ENOTDIR

    let outcome: DegradedPublishingOutcome | undefined;
    expect(() => {
      outcome = enterDegradedPublishing(SILENT);
    }).not.toThrow();
    expect(outcome?.enabled).toBe(false);
    expect(() => exitDegradedPublishing(outcome as DegradedPublishingOutcome, SILENT)).not.toThrow();
  });

  it('outcome 为 null（从未进入降级发布）时 exit 什么都不做也不抛', () => {
    expect(() => exitDegradedPublishing(null, SILENT)).not.toThrow();
    expect(() => exitDegradedPublishing(undefined, SILENT)).not.toThrow();
  });

  it('站长手动开了 all ⇒ 往返之后**仍然开着**（enter/exit 组合不许改变这个既有性质）', () => {
    const dir = tmpDir();
    process.env[SERVE_HTML_PAGES_DIR_ENV] = dir;
    fs.writeFileSync(path.join(dir, CADDY_SERVE_HTML_SENTINEL), 'level=all; operator\n');
    fs.writeFileSync(path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL), 'level=all; operator\n');

    const outcome = enterDegradedPublishing(SILENT);
    expect(outcome.enabled).toBe(true);
    expect(outcome.snapshot.fixed).toBe(true);
    expect(outcome.snapshot.dynamic).toBe(true);

    exitDegradedPublishing(outcome, SILENT);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_SENTINEL))).toBe(true);
    expect(fs.existsSync(path.join(dir, CADDY_SERVE_HTML_DYNAMIC_SENTINEL))).toBe(true);
  });
});
