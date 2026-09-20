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
  enableDegradedServeHtml,
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

