import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 这一轮「运行时占用 + 安全/逻辑漏洞」的加固，用源码级断言钉住。
 * 全是"改回去也不会报错、只会在线上出事"的那种改动。
 *
 * 文件名带 `audit-hardening` 是为了能被 CI 那条 `--testPathPattern` 直接匹配到
 * （见 .github/workflows/server-test.yml）。
 */
// __dirname 就是 src/（jest 用 ts-jest 直接跑源码，没有 outDir 那一层）
const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/** 断言前剥掉注释：新写的注释里常常引用"以前是怎样的"，不剥会自己匹配自己 */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/[^'"`]*$/, ''))
    .join('\n');

describe('每次浏览的数据库开销：合并写入', () => {
  it('MetaProvider.addViewer 不再自己写四个集合，而是交给 ViewStatsProvider', () => {
    const src = code(read('provider/meta/meta.provider.ts'));
    expect(src).toContain('this.viewStats.record(');
    // 以前那四处直接写库的痕迹必须消失
    expect(src).not.toContain('metaModel\n      .findOneAndUpdate');
    expect(src).not.toContain('this.viewProvider');
    expect(src).not.toContain('this.visitProvider');
    expect(src).not.toContain('updateViewerByPathname');
  });

  it('getViewer 只取两个数字（不再 findOne 整份 meta 文档）', () => {
    const src = code(read('provider/stats/viewStats.provider.ts'));
    expect(src).toMatch(/findOne\(\{\},\s*\{\s*viewer:\s*1,\s*visited:\s*1\s*\}\)/);
  });

  it('ViewStatsProvider 在 app.module 注册了', () => {
    const src = code(read('app.module.ts'));
    expect(src).toContain('ViewStatsProvider,');
    expect(src).toContain('StatsMaintenanceProvider,');
  });

  it('优雅退出会在关库之前 flush 浏览统计', () => {
    const src = code(read('main.ts'));
    const flushIdx = src.indexOf("viewStats.flush(");
    const closeIdx = src.indexOf('await app.close()');
    expect(flushIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeLessThan(closeIdx);
    expect(src).toContain('viewStats.stopTimer()');
  });

  it('写失败的增量会退回队列，而不是就这么丢掉', () => {
    const src = code(read('provider/stats/viewStats.provider.ts'));
    expect(src).toContain('this.aggregator.merge(');
    // visits 是按路径累计的：当天第一行必须从上一天的值接着加
    expect(src).toContain('$setOnInsert');
    expect(src).toMatch(/\$sort:\s*\{\s*pathname:\s*1,\s*date:\s*-1\s*\}/);
  });
});

describe('visits 的重复行与唯一索引', () => {
  it('唯一索引由维护代码显式建（不交给 autoIndex，否则脏库上第一次启动必然失败）', () => {
    const visitSchema = code(read('scheme/visit.schema.ts'));
    expect(visitSchema).not.toMatch(/index\(\{\s*date:\s*1,\s*pathname:\s*1\s*\}/);
    const maintenance = code(read('provider/stats/statsMaintenance.provider.ts'));
    expect(maintenance).toContain('VISIT_UNIQUE_INDEX_KEYS = { date: 1, pathname: 1 }');
    expect(maintenance).toContain('unique: true');
    expect(maintenance).toContain('dedupVisits');
  });

  it('维护不在请求路径上：只挂在启动钩子与每日 cron 上', () => {
    const maintenance = code(read('provider/stats/statsMaintenance.provider.ts'));
    expect(maintenance).toContain('onApplicationBootstrap()');
    const task = code(read('schedule/viewer.task.ts'));
    expect(task).toContain('pruneStats(');
    // 控制器里不能出现维护调用
    for (const rel of ['controller/public/public.controller.ts', 'controller/admin/analysis/analysis.controller.ts']) {
      expect(code(read(rel))).not.toContain('pruneStats');
    }
  });

  it('viewers.date 不再由 schema 声明索引（否则 autoIndex 会和那个唯一索引天天打架）', () => {
    const src = read('scheme/viewer.schema.ts');
    const stripped = code(src);
    expect(stripped).not.toMatch(/@Prop\(\{\s*index:\s*true\s*\}\)\s*\n\s*date:/);
    expect(stripped).toMatch(/@Prop\(\)\s*\n\s*date:/);
  });

  it('保留期默认 0 = 一行都不删', () => {
    const src = code(read('provider/stats/statsMaintenance.provider.ts'));
    expect(src).toContain("RETENTION_DEFAULTS = { retentionDays: 0, minKeepDays: 30 }");
    expect(src).toContain("if (!plan.enabled || !plan.filter)");
    const util = code(read('utils/statsMaintenance.ts'));
    expect(util).toContain('if (retentionDays <= 0)');
    // 删除条件必须带字符串下界，否则 date 缺失/为 null 的行会被 $lt 一起删掉
    expect(util).toContain("RETENTION_FLOOR = '0000-00-00'");
  });

  it('每日 cron 里的两处 fire-and-forget 写入都挂了 catch', () => {
    const src = code(read('schedule/viewer.task.ts'));
    expect(src).toMatch(/createOrUpdate\([\s\S]*?\)\s*\n\s*\.catch\(/);
    expect(src).toMatch(/pruneStats\('每日定时清理'\)\s*\n\s*\.catch\(/);
  });
});

describe('每个请求的浪费', () => {
  it('checkHasInited 只投影 _id，并且缓存结果', () => {
    const src = code(read('provider/init/init.provider.ts'));
    expect(src).toMatch(/findOne\(\{\},\s*\{\s*_id:\s*1\s*\}\)/);
    expect(src).not.toMatch(/userModel\.findOne\(\{\}\)\.exec\(\)/);
    expect(src).toContain('this.hasInitedCache');
    // 只缓存 true：false 缓存下来会让"别的进程刚初始化完"最长延迟一个 TTL 才被看到
    expect(src).toMatch(/if \(value\) \{\s*\n\s*this\.hasInitedCache/);
  });

  it('initJwt 记忆化 + 一定关闭 MongoClient + 原子 upsert', () => {
    const src = code(read('utils/initJwt.ts'));
    expect(src).toContain('let cached: Promise<string> | null');
    expect(src).toContain('await client.close()');
    expect(src).toContain('$setOnInsert');
    expect(src).toContain('upsert: true');
    // 不能再是"先 findOne，没有就 insertOne"（并发启动会各生成一个 secret）
    expect(src).not.toMatch(/findOne\(\{ type: 'jwt' \}\);\s*\n\s*if \(jwtSetting\)/);
  });

  it('main.ts 与 JwtModule 工厂都还是调同一个 initJwt（由它自己保证只连一次）', () => {
    expect(code(read('main.ts'))).toContain('await initJwt()');
    expect(code(read('app.module.ts'))).toContain('await initJwt()');
  });

  it('searchLog 从尾部读，不再把整份日志逐行 JSON.parse', () => {
    const src = code(read('provider/log/log.provider.ts'));
    expect(src).toContain('readLogTailLines(');
    expect(src).not.toContain('lineReader');
    expect(src).toContain('LOG_SCAN_MAX_LINES');
  });
});

describe('picgo 插件安装的开关', () => {
  it('默认关：只有 isPicgoPluginsAllowed() 放行才会调 pluginHandler.install', () => {
    const src = code(read('provider/static/picgo.provider.ts'));
    const gate = src.indexOf('if (!isPicgoPluginsAllowed())');
    const install = src.indexOf('this.picgo.pluginHandler.install(');
    expect(gate).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(install);
  });

  it('开关默认值是 false（环境变量没设时不装插件）', () => {
    const src = code(read('utils/picgoPlugins.ts'));
    expect(src).toContain('if (raw === undefined) return false;');
    expect(src).toContain("PICGO_PLUGIN_ENV = 'VANBLOG_ALLOW_PICGO_PLUGINS'");
  });

  it('上传路径没有被开关影响（saveFile 里没有任何门禁）', () => {
    const src = code(read('provider/static/picgo.provider.ts'));
    const saveFile = src.slice(src.indexOf('async saveFile('));
    expect(saveFile).toContain('await this.picgo.upload([srcPath])');
    expect(saveFile).not.toContain('isPicgoPluginsAllowed');
  });
});

describe('website 子进程不会再"复活"', () => {
  it('exit 钩子里有 stopping 与"还是不是当前子进程"两道判断', () => {
    const src = code(read('provider/website/website.provider.ts'));
    expect(src).toContain('if (this.ctx !== child)');
    expect(src).toContain('if (this.stopping)');
    expect(src).toContain('this.stopping = true');
    expect(src).not.toMatch(/on\('exit',\s*async\s*\(\)\s*=>\s*\{\s*await this\.restore/);
  });

  it('starting 互斥量真的被赋值了（以前是死代码）', () => {
    const src = code(read('provider/website/website.provider.ts'));
    expect(src).toMatch(/this\.starting\s*=\s*task/);
  });

  it('restart 会显式 run，并且自己兜住失败（调用方都是发出去就不管）', () => {
    const src = code(read('provider/website/website.provider.ts'));
    const stopIdx = src.indexOf('await this.stop();');
    const runIdx = src.indexOf('await this.run();', stopIdx);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(stopIdx);
    expect(src).toContain('this.scheduleRestart();');
  });
});

describe('多进程（cluster）守卫', () => {
  const guarded: Array<[string, string]> = [
    ['schedule/isr.task.ts', 'isPrimaryInstance(cluster)'],
    ['schedule/viewer.task.ts', 'isPrimaryInstance(cluster)'],
    ['provider/waline/waline.provider.ts', 'isPrimaryInstance(cluster)'],
    ['provider/website/website.provider.ts', 'isPrimaryInstance(cluster)'],
    ['provider/stats/statsMaintenance.provider.ts', 'isPrimaryInstance(cluster)'],
  ];
  it.each(guarded)('%s 有主实例守卫', (file, needle) => {
    expect(code(read(file))).toContain(needle);
  });

  it('main.ts 的启动期单例工作全部在 primary 判断里', () => {
    const src = code(read('main.ts'));
    expect(src).toContain('const primary = isPrimaryInstance(cluster);');
    // P1 迁移台账之后，await 的清洗长成 `if (primary) await wash(key, 'wash', () => …)`、
    // fire-and-forget 的长成 `if (primary) void wash(…).catch(…)` —— 不变量没变：
    // 每一条都必须在 primary 守卫里（把守卫拆掉的改动会让下面的正则红）。
    expect(src).toMatch(
      /if \(primary\)\s+await wash\('wash:staticSetting', 'wash', \(\) => initProvider\.washStaticSetting\(\)/,
    );
    expect(src).toMatch(
      /if \(primary\)\s+void wash\('wash:userSalt', 'wash', \(\) => userProvider\.washUserWithSalt\(\)/,
    );
    expect(src).toContain('if (primary) walineProvider.init();');
    expect(src).toMatch(/if \(primary\) \{\s*\n\s*initProvider\.initVersion\(\);\s*\n\s*initProvider\.initRestoreKey\(\);/);
    // 信号处理必须在 checkHasInited() 那个 if **外面**：worker 与未初始化的实例也要能优雅退出。
    // 结构判据：注册语句是函数体缩进（2 空格），在 if 里面会是 4 空格
    const ifIdx = src.indexOf('if (await initProvider.checkHasInited())');
    const sigIdx = src.indexOf("process.on('SIGTERM'");
    expect(ifIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeGreaterThan(ifIdx);
    expect(src).toMatch(/\n {2}process\.on\('SIGTERM'/);
    // 首轮全量渲染在 if 里面、且在信号注册之前
    const isrIdx = src.indexOf("isrProvider.activeAll('首次启动触发全量渲染！'");
    expect(isrIdx).toBeGreaterThan(ifIdx);
    expect(isrIdx).toBeLessThan(sigIdx);
  });

  it('默认 worker 数是 1，cluster 分支只在 >1 时才走', () => {
    const src = code(read('main.ts'));
    expect(src).toContain('if (clusterWorkers > 1 && cluster.isPrimary)');
    expect(code(read('utils/clusterRole.ts'))).toContain('if (value <= 1) return 1;');
  });

  it('每进程的限流预算与连接池都按 worker 数摊薄', () => {
    const rl = code(read('utils/rateLimit.ts'));
    expect(rl).toContain('max: scaleLimit(GLOBAL_LIMIT_PER_MIN)');
    expect(rl).toContain('max: scaleLimit(STATIC_LIMIT_PER_MIN)');
    expect(rl).toContain('max: scaleLimit(PUBLIC_WRITE_LIMIT_PER_MIN)');
    expect(rl).toContain('max: scaleLimit(INIT_LIMIT_PER_10MIN)');
    expect(code(read('provider/auth/login.guard.ts'))).toContain('scaleLimit(configuredMax)');
    expect(code(read('controller/public/public.controller.ts'))).toContain('max: scaleLimit(20)');
    expect(code(read('provider/comment/comment.provider.ts'))).toContain('max: scaleLimit(50)');
    expect(code(read('app.module.ts'))).toContain('scaleLimit(num(process.env.VANBLOG_MONGO_MAX_POOL_SIZE, 100)');
  });

  it('主进程会先解析 jwt 密钥再 fork（全新安装时 worker 不会各生成一个）', () => {
    const src = code(read('main.ts'));
    const jwtIdx = src.indexOf('global.jwtSecret = await initJwt();');
    const forkIdx = src.indexOf('startClusterPrimary(');
    expect(jwtIdx).toBeGreaterThan(-1);
    expect(forkIdx).toBeGreaterThan(jwtIdx);
  });
});
