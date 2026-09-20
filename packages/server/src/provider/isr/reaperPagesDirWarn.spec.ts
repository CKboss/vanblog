/**
 * `reapStaleArtifacts` 必须把 pages-dir 的解析 WARN 说出来，而且**按值去重**。
 *
 * 背景：`reaperPagesDir(log?)` 的 logger 是可选的，而本调用点曾经不传 ⇒ 配错
 * `VANBLOG_CADDY_HTML_PAGES_DIR` 时，"删产物"这一侧一句都不说。整体不算全静默
 * （CaddyProvider 的 60s 对账会为同一个变量打 WARN），但这一侧恰恰是失败方向最严重的：
 * 修复前 `/` 会让 reaper 去扫**文件系统根**下的 post/page/category/tag，`..` 能把可删范围
 * 移出产物目录，相对路径则相对进程 cwd。
 *
 * 🔴 去重是必须的，不是优化：本方法由 `setInterval` 周期调用、且每次全量渲染收尾也调一次，
 * 不去重就每轮刷一条；日志有 20MB×3 轮转上限，攻击期间真信息会被冲走。
 * 去重口径与 `caddy.provider` 的 `pagesDirWarnedFor` 一致：**换一个非法值要再打一条**
 * （那正是需要看见的时刻），同值只打一次。
 *
 * ⚠️ 这里用 `Object.create(prototype)` 而不是 `new ISRProvider(...)`：那个构造器要十几个
 * `@InjectModel` 参数（本仓库既有做法，见 provider/cache/restoreKeyVerification.spec.ts）。
 * ⚠️ 代价是**类属性初始化器不会跑**，所以 `reaperPagesDirWarned` 必须手工挂 ——
 * 这不是掩盖缺陷：生产路径由 Nest 实例化，初始化器一定跑；这里只是替身。
 * 有一条断言专门钉住"忘了挂就会抛"这个事实本身，避免替身悄悄变成"测了个不存在的东西"。
 */
import { ISRProvider } from './isr.provider';

const ENV = 'VANBLOG_CADDY_HTML_PAGES_DIR';

/** 造一个只够跑 `reapStaleArtifacts` 前半段（解析目录 → 发现目录不存在 → 早退）的替身。 */
function makeStub() {
  const warns: string[] = [];
  const stub = Object.create(ISRProvider.prototype) as unknown as {
    logger: { warn(m: string): void; debug?(m: string): void };
    reaperPagesDirWarned: Set<string>;
    reapStaleArtifacts(source: string): Promise<void>;
  };
  stub.logger = { warn: (m: string) => warns.push(m), debug: () => undefined };
  stub.reaperPagesDirWarned = new Set<string>();
  return { stub, warns };
}

describe('reapStaleArtifacts 的 pages-dir WARN', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('配错目录时会打 WARN（不是静默），且文案点名这个环境变量', async () => {
    process.env[ENV] = 'relative/not-absolute';
    const { stub, warns } = makeStub();
    await stub.reapStaleArtifacts('测试');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain(ENV);
    // ⚠️ 文案必须说清"已回落默认目录"，否则运维会以为它用了那个非法值
    expect(warns[0]).toMatch(/回落|沿用|默认/);
  });

  it('同值重复调用只打一条（周期对账 + 每次全量渲染收尾都会调它，不去重就刷屏）', async () => {
    process.env[ENV] = '/pages/../escape';
    const { stub, warns } = makeStub();
    await stub.reapStaleArtifacts('第一次');
    await stub.reapStaleArtifacts('第二次');
    await stub.reapStaleArtifacts('第三次');
    expect(warns).toHaveLength(1);
  });

  it('🔴 换成**另一个**非法值会再打一条（去重按值，不是"打过就永久闭嘴"）', async () => {
    const { stub, warns } = makeStub();
    process.env[ENV] = 'relative/one';
    await stub.reapStaleArtifacts('第一次');
    process.env[ENV] = '/{env.SECRET}/two';
    await stub.reapStaleArtifacts('第二次');
    expect(warns).toHaveLength(2);
    expect(warns[0]).not.toEqual(warns[1]);
  });

  it('合法值不打 WARN（不能把正常配置也变成噪音）', async () => {
    process.env[ENV] = '/tmp/vanblog-reaper-warn-spec-pages';
    const { stub, warns } = makeStub();
    await stub.reapStaleArtifacts('测试');
    expect(warns).toHaveLength(0);
  });

  it('未设置时不打 WARN（默认部署必须安静）', async () => {
    delete process.env[ENV];
    const { stub, warns } = makeStub();
    await stub.reapStaleArtifacts('测试');
    expect(warns).toHaveLength(0);
  });

  it('⚠️ 替身自检：不挂 reaperPagesDirWarned 就会抛 ⇒ 证明上面几条真的在走去重那条路', async () => {
    process.env[ENV] = 'relative/not-absolute';
    const bare = Object.create(ISRProvider.prototype) as unknown as {
      logger: { warn(m: string): void; debug?(m: string): void };
      reapStaleArtifacts(source: string): Promise<void>;
    };
    bare.logger = { warn: () => undefined, debug: () => undefined };
    // 这条不是产品性质，是**尺子有效性反证**：如果去重那行代码被删掉，
    // 这个"忘了挂字段"的替身反而不会抛 ⇒ 说明断言路径变了，需要重看。
    await expect(bare.reapStaleArtifacts('测试')).rejects.toThrow();
  });
});
