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
    // ⚠️ 匿名调用者**不该**看到版本与容量：version 形如 v2026.9.1@0ec01a5，
    // 等于告诉扫描器该去对哪个 commit 的已知漏洞；uptime/内存能推断重启时机与负载。
    expect(out.data.version).toBeUndefined();
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

  it('响应不缓存 + 镜像的 HEALTHCHECK 打的是这个端点', () => {
    const src = read('packages/server/src/controller/public/health.controller.ts');
    expect(src).toContain("@Header('Cache-Control', 'no-store')");
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]{0,200}path:'\/api\/public\/health'/);
    // 编排里故意不重复写 healthcheck（镜像里已经有了），这条钉住这个约定不被"顺手加上"
    const compose = read('docker-compose/docker-compose-template.yml');
    const vanblogSvc = compose.slice(compose.indexOf('  vanblog:'), compose.indexOf('  mongo:'));
    expect(vanblogSvc).not.toMatch(/^\s{4}healthcheck:/m);
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

  it('端点整体行为：令牌请求拿到 version 与 details:true，匿名拿不到', async () => {
    const conn: any = {
      readyState: 1,
      db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) },
    };
    const c = new HealthController(conn);
    const res: any = { statusCode: 200, status() { return this; } };

    const anon: any = await c.health(reqFor(), res);
    expect(anon.data.version).toBeUndefined();
    expect(anon.data.details).toBeUndefined();

    const c2 = new HealthController(conn);
    const withToken: any = await c2.health(
      reqFor({ 'x-vanblog-internal': process.env.VAN_BLOG_INTERNAL_TOKEN || 'x' }),
      res,
    );
    if (process.env.VAN_BLOG_INTERNAL_TOKEN) {
      expect(withToken.data.details).toBe(true);
      expect(typeof withToken.data.version).toBe('string');
      expect(typeof withToken.data.uptimeSeconds).toBe('number');
    } else {
      // 没配令牌时，即使带头也拿不到详细字段（不能因为"带了个头"就放行）
      expect(withToken.data.details).toBeUndefined();
    }
  });
});
