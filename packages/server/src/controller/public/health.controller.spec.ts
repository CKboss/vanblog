import { readFileSync } from 'fs';
import * as path from 'path';
import { HealthController, detailsAllowed } from './health.controller';

// 只读仓库根。⚠️ __dirname = packages/server/src/controller/public，要往上 **5** 级才到仓库根
// （public → controller → src → server → packages → 仓库根）；第一版写了 4 级，落到 packages/ 上，
// 于是 readFileSync 全是 ENOENT —— 而这个 off-by-one 在本仓库已经踩过好几次（AGENTS 里记着）。
const root = path.resolve(__dirname, '../../../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const code = (s: string) =>
  s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

function makeController(mongoUp: boolean) {
  const conn: any = {
    readyState: mongoUp ? 1 : 0,
    db: {
      admin: () => ({
        ping: async () => {
          if (!mongoUp) throw new Error('connect ECONNREFUSED');
          return { ok: 1 };
        },
      }),
    },
  };
  const c = new HealthController(conn);
  const res: any = { statusCode: 200, status(n: number) { this.statusCode = n; return this; } };
  return { c, res };
}

/**
 * 造一个请求对象。⚠️ 默认带上"回环"特征（socket.remoteAddress=127.0.0.1）——
 * 一体式部署里 caddy 就是这么拨过来的，所以这正是**最容易被误当成内部请求**的形状。
 */
function reqFor(headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' } as any;
}

describe('GET /api/public/health', () => {
  it('mongo 正常时 200，并给出可判读的状态字段', async () => {
    const { c, res } = makeController(true);
    const out: any = await c.health(reqFor(), res);
    expect(out.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
    expect(out.data.status).toBe('ok');
    expect(out.data.mongo).toBe('up');
    expect(out.data.mongoStateText).toBe('connected');
    // ⚠️ 匿名调用者**可以**看到 version（站长决定：版本号不算秘密 —— 它已经渲染在每个
    // 前台页面的页脚上，也从 /api/public/meta 下发，只在健康端点藏它属于安全表演）。
    // 但 uptime 与内存**不该**公开：那两项不在页脚上，能用来推断重启时机与负载。
    expect(typeof out.data.version).toBe('string');
    expect(out.data.uptimeSeconds).toBeUndefined();
    expect(out.data.memoryRssMb).toBeUndefined();
    expect(out.data.heapUsedMb).toBeUndefined();
    expect(out.data.details).toBeUndefined();
    // 但健康检查与 drill 需要的字段必须在
    expect(typeof out.data.mongoPingMs).toBe('number');
    expect(typeof out.data.now).toBe('string');
  });

  it('mongo 探测失败时返回 503 —— 镜像的 HEALTHCHECK 判据是 statusCode<500，所以必须体现在状态码上', async () => {
    const { c, res } = makeController(false);
    const out: any = await c.health(reqFor(), res);
    expect(out.statusCode).toBe(503);
    expect(res.statusCode).toBe(503);
    expect(out.data.status).toBe('degraded');
    expect(out.data.mongo).toBe('down');
    expect(out.data.mongoStateText).toBe('disconnected');
  });

  it('探测结果缓存 5 秒：连续两次只真的 ping 一次（healthcheck 每 30 秒一次，但别人也能拿它打你）', async () => {
    let pings = 0;
    const conn: any = {
      readyState: 1,
      db: { admin: () => ({ ping: async () => { pings += 1; return { ok: 1 }; } }) },
    };
    const c = new HealthController(conn);
    const res: any = { statusCode: 200, status() { return this; } };
    await c.health(reqFor(), res);
    await c.health(reqFor(), res);
    await c.health(reqFor(), res);
    expect(pings).toBe(1);
  });

  it('路由被排除在 InitMiddleware 之外（未初始化的全新安装不能被判定为不健康）', () => {
    const src = code(read('packages/server/src/app.module.ts'));
    expect(src).toContain("{ path: '/api/public/health', method: RequestMethod.GET }");
    // 而且它确实注册进了 controllers
    expect(src).toContain('HealthController,');
  });

  it('响应不缓存 + 镜像与编排的健康探测都钉在这个端点上，并且都探前台', () => {
    const src = read('packages/server/src/controller/public/health.controller.ts');
    expect(src).toContain("@Header('Cache-Control', 'no-store')");

    // ⚠️ Dockerfile 与 YAML **不能**用 code()：那是 TS 剥注释器，会把 `https://` 当行注释、
    //    被引号与 `$( )` 带偏（实测把整份 shell 脚本啃残）。这里用"整行以 # 开头即注释"的最小剥离。
    const stripHashComments = (text: string): string =>
      text
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');

    const dockerfileRaw = read('Dockerfile');
    const dockerfile = stripHashComments(dockerfileRaw);
    // 空转反证：剥离必须真的删掉了内容，否则下面的 not.toMatch 可能只是"匹配不到"而不是"检查过了"
    expect(dockerfileRaw.length).toBeGreaterThan(dockerfile.length);
    expect(dockerfileRaw).toContain('__vanblog_health_probe__');

    // 1) 仍然探**全路径**健康端点（上一轮特意从 `/` 换过来的：前台 404 时 `/` 也算"健康"）
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*probe\(80,'\/api\/public\/health'/);
    // 2) 判据仍然是 statusCode<500 —— mongo 不通时本端点返回 503，这样才映射成 unhealthy
    expect(dockerfile).toMatch(/probe\(80,'\/api\/public\/health',s=>s<500\)/);
    // 3) 🔴 也必须探前台（Next，3001）：`/api/public/health` 的核心判据（status / statusCode）只看 mongo，
    //    前台永久挂掉时容器仍然 healthy ⇒ 站点发不出页面却没人知道，restart: always 也不介入。
    //    ⚠️ 2026-09-22 更正：这里原先引用了 website.provider 的"连续退出 5 次后停止自动重启"，
    //    而那句话已经过时 —— 那一处后来改成了**放弃快速退避、转入每 5 分钟一次的慢速重试，永不彻底放弃**
    //    （`VANBLOG_WEBSITE_SLOW_RETRY_MS`；waline 侧同族同口径，见 `VANBLOG_WALINE_SLOW_RETRY_MS`）。
    //    🔴 **但这条断言本身一个字都不改，它仍然完全必要**，理由有三：
    //    ① 慢速重试的默认间隔是 5 分钟 ⇒ **仍然有最长 5 分钟的 502 窗口**，而 HEALTHCHECK 30 秒一次看得见它；
    //    ② **永久性原因**（前台构建产物缺失、3001 被别的进程占住）下前台仍然起不来，重试多少次都没用；
    //    ③ 间隔可以被配到 1 小时 ⇒ 窗口可以远大于 5 分钟。
    //    🔴 另外：health 现在虽然多了一个公开的 `website` 字段，但它与"直接探 3001"**不等价、不能互相替代** ——
    //    直接探 3001 证明的是"**HTTP 层面真的能拿到响应**"（端到端，含端口在听、Next 能应答）；
    //    而 `website` 字段只反映"**server 认为它 spawn 的那个子进程还在**"（`ctx` 非 null）⇒
    //    子进程活着但端口没在听、或 Next 卡死不响应，字段会报 `up` 而直接探测会失败。
    //    而且集群模式下非 leader worker 只能报 `unknown`。⇒ **两个信号都要保留。**
    expect(dockerfile).toMatch(/probe\(3001,'\/__vanblog_health_probe__'/);
    // 4) 前台探测**不许**打 `/`：那会触发真实渲染（ISR 未命中还要回源查库），高峰期慢响应会被
    //    误判成坏死并触发重启，把情况弄得更糟。404 由 Next 路由层直接给，不渲染、不查库。
    expect(dockerfile).not.toMatch(/probe\(3001,'\/'[,)]/);
    // 5) 两个探测的结果必须合并（只等一个就退出 = 另一个形同虚设）
    expect(dockerfile).toContain('++n===2');

    // 编排里现在**必须**有一份等价的 healthcheck。⚠️ 这条以前是 `not.toMatch`，钉的是"镜像里已经
    // 有了，编排不重复写"—— 那个理由在 **podman 下不成立**：podman/buildah 构建会丢掉 Dockerfile
    // 的 HEALTHCHECK 指令，于是 podman 部署零健康探测，而 podman 的 restart: always 也不会因
    // unhealthy 重启。两处真相由下面"程序逐字节相同"这条同步，而不是靠人记得。
    const compose = read('docker-compose/docker-compose-template.yml');
    const vanblogSvc = compose.slice(compose.indexOf('  vanblog:'), compose.indexOf('  mongo:'));
    expect(stripHashComments(vanblogSvc)).toMatch(/^\s{4}healthcheck:/m);
    const grab = (text: string, re: RegExp): string => {
      const m = text.match(re);
      return m ? m[1] : '';
    };
    const dfProg = grab(dockerfile, /CMD node -e "([\s\S]*?)"\s*$/m);
    const tplProg = grab(vanblogSvc, /test: \["CMD", "node", "-e", "([\s\S]*?)"\]/);
    expect(dfProg.length).toBeGreaterThan(100); // 空转反证：真的抽到了程序，而不是两个空串相等
    expect(tplProg.length).toBeGreaterThan(100);
    expect(tplProg).toBe(dfProg); // 逐字节相同
  });
});

describe('健康端点的详细字段门控', () => {
  const TOKEN = 'test-internal-token-value';

  it('⚠️ 回环请求**不**等于内部请求：一体式部署里 caddy 就是从 127.0.0.1 拨过来的', () => {
    // 这条钉子防的是"顺手复用 isInternalRequest()"——那个函数对回环直接返回 true，
    // 用它当门等于对每个匿名访客敞开（限流那一轮踩过同一个坑，AGENTS §7.55 F）
    expect(detailsAllowed(reqFor(), { VAN_BLOG_INTERNAL_TOKEN: TOKEN } as any)).toBe(false);
    expect(
      detailsAllowed({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, {
        VAN_BLOG_INTERNAL_TOKEN: TOKEN,
      } as any),
    ).toBe(false);
  });

  it('带正确的内部令牌才给详细字段', () => {
    expect(detailsAllowed(reqFor({ 'x-vanblog-internal': TOKEN }), { VAN_BLOG_INTERNAL_TOKEN: TOKEN } as any)).toBe(true);
  });

  it('令牌不对 / 长度不对 / 没配令牌 / 头缺失，一律不给', () => {
    const env = { VAN_BLOG_INTERNAL_TOKEN: TOKEN } as any;
    expect(detailsAllowed(reqFor({ 'x-vanblog-internal': 'wrong' }), env)).toBe(false);
    expect(detailsAllowed(reqFor({ 'x-vanblog-internal': TOKEN.slice(0, -1) }), env)).toBe(false);
    expect(detailsAllowed(reqFor({ 'x-vanblog-internal': TOKEN }), {} as any)).toBe(false);
    expect(detailsAllowed(reqFor({}), env)).toBe(false);
    expect(detailsAllowed(undefined, env)).toBe(false);
    // 前缀正确但长度相同、只有末字节不同：常量时间比较也必须拒
    const near = TOKEN.slice(0, -1) + (TOKEN.slice(-1) === 'e' ? 'f' : 'e');
    expect(detailsAllowed(reqFor({ 'x-vanblog-internal': near }), env)).toBe(false);
  });

  it('VANBLOG_HEALTH_DETAILS=true 是站长显式选择公开（默认关）', () => {
    expect(detailsAllowed(reqFor(), { VANBLOG_HEALTH_DETAILS: 'true' } as any)).toBe(true);
    expect(detailsAllowed(reqFor(), { VANBLOG_HEALTH_DETAILS: 'TRUE' } as any)).toBe(false); // 严格匹配，别把打错的值当成开
    expect(detailsAllowed(reqFor(), { VANBLOG_HEALTH_DETAILS: '1' } as any)).toBe(false);
    expect(detailsAllowed(reqFor(), {} as any)).toBe(false);
  });

  it('端点整体行为：version 公开，uptime/内存只对带令牌或开了 VANBLOG_HEALTH_DETAILS 的请求可见', async () => {
    const conn: any = {
      readyState: 1,
      db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) },
    };
    const c = new HealthController(conn);
    const res: any = { statusCode: 200, status() { return this; } };

    const anon: any = await c.health(reqFor(), res);
    expect(typeof anon.data.version).toBe('string'); // 版本公开
    expect(anon.data.uptimeSeconds).toBeUndefined(); // 容量信息仍受门控
    expect(anon.data.details).toBeUndefined();

    const c2 = new HealthController(conn);
    const withToken: any = await c2.health(
      reqFor({ 'x-vanblog-internal': process.env.VAN_BLOG_INTERNAL_TOKEN || 'x' }),
      res,
    );
    if (process.env.VAN_BLOG_INTERNAL_TOKEN) {
      expect(withToken.data.details).toBe(true);
      expect(typeof withToken.data.uptimeSeconds).toBe('number');
      expect(typeof withToken.data.memoryRssMb).toBe('number');
    } else {
      // 没配令牌时，即使带头也拿不到详细字段（不能因为"带了个头"就放行）
      expect(withToken.data.details).toBeUndefined();
    }
  });
});
