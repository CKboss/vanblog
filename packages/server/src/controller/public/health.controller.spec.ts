import { readFileSync } from 'fs';
import * as path from 'path';
import { HealthController } from './health.controller';

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

describe('GET /api/public/health', () => {
  it('mongo 正常时 200，并给出可判读的状态字段', async () => {
    const { c, res } = makeController(true);
    const out: any = await c.health(res);
    expect(out.statusCode).toBe(200);
    expect(res.statusCode).toBe(200);
    expect(out.data.status).toBe('ok');
    expect(out.data.mongo).toBe('up');
    expect(out.data.mongoStateText).toBe('connected');
    expect(typeof out.data.uptimeSeconds).toBe('number');
    expect(typeof out.data.memoryRssMb).toBe('number');
  });

  it('mongo 探测失败时返回 503 —— 镜像的 HEALTHCHECK 判据是 statusCode<500，所以必须体现在状态码上', async () => {
    const { c, res } = makeController(false);
    const out: any = await c.health(res);
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
    await c.health(res);
    await c.health(res);
    await c.health(res);
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
