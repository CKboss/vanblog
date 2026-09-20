import {
  GLOBAL_LIMIT_PER_MIN,
  INIT_LIMIT_PER_10MIN,
  PUBLIC_WRITE_LIMIT_PER_MIN,
  isInternalRequest,
  isLoopbackRequest,
  rateLimitMiddleware,
  isStaticAssetPath,
  securityHeadersMiddleware,
} from './rateLimit';

const req = (over: any = {}) =>
  ({
    method: 'GET',
    path: '/api/public/meta',
    socket: { remoteAddress: '203.0.113.7' },
    headers: {},
    ...over,
  } as any);

const res = () => {
  const out: any = { status: 200, headers: {} as Record<string, string>, body: undefined };
  return {
    out,
    setHeader: (k: string, v: string) => {
      out.headers[k] = v;
    },
    getHeader: (k: string) => out.headers[k],
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: any) {
      out.body = body;
      return this;
    },
  } as any;
};

const uniqueIp = () => `203.0.113.${Math.floor(Math.random() * 200) + 20}`;

describe('回环 / 内部请求判定', () => {
  it('回环直连算内部，带转发头的回环不算（反代后面的真实客户端）', () => {
    expect(isLoopbackRequest(req({ socket: { remoteAddress: '127.0.0.1' } }))).toBe(true);
    expect(isLoopbackRequest(req({ socket: { remoteAddress: '::1' } }))).toBe(true);
    expect(isLoopbackRequest(req({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))).toBe(true);
    expect(
      isLoopbackRequest(
        req({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }),
      ),
    ).toBe(false);
    expect(
      isLoopbackRequest(req({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.9' } })),
    ).toBe(false);
    expect(isLoopbackRequest(req({ socket: { remoteAddress: '203.0.113.7' } }))).toBe(false);
  });

  it('内部令牌要对得上才认，且没配令牌时不接受任何值', () => {
    const old = process.env.VAN_BLOG_INTERNAL_TOKEN;
    try {
      delete process.env.VAN_BLOG_INTERNAL_TOKEN;
      expect(
        isInternalRequest(
          req({ socket: { remoteAddress: '203.0.113.7' }, headers: { 'x-forwarded-for': '1.2.3.4', x_vanblog_internal: 'x' } }),
        ),
      ).toBe(false);
      expect(
        isInternalRequest(
          req({
            socket: { remoteAddress: '203.0.113.7' },
            headers: { 'x-forwarded-for': '1.2.3.4', 'x-vanblog-internal': 'anything' },
          }),
        ),
      ).toBe(false);

      process.env.VAN_BLOG_INTERNAL_TOKEN = 's3cret-token';
      expect(
        isInternalRequest(
          req({
            socket: { remoteAddress: '203.0.113.7' },
            headers: { 'x-forwarded-for': '1.2.3.4', 'x-vanblog-internal': 's3cret-token' },
          }),
        ),
      ).toBe(true);
      expect(
        isInternalRequest(
          req({
            socket: { remoteAddress: '203.0.113.7' },
            headers: { 'x-forwarded-for': '1.2.3.4', 'x-vanblog-internal': 'wrong' },
          }),
        ),
      ).toBe(false);
      // 回环直连不需要令牌
      expect(isInternalRequest(req({ socket: { remoteAddress: '127.0.0.1' } }))).toBe(true);
    } finally {
      if (old === undefined) {
        delete process.env.VAN_BLOG_INTERNAL_TOKEN;
      } else {
        process.env.VAN_BLOG_INTERNAL_TOKEN = old;
      }
    }
  });
});

describe('全局限流中间件', () => {
  it('内部回环调用直接放行（前台 SSR / ISR 不能被自己限流限死）', () => {
    const r = res();
    let called = false;
    rateLimitMiddleware(
      req({ socket: { remoteAddress: '127.0.0.1' }, method: 'POST', path: '/api/public/comments' }),
      r,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
    expect(r.out.status).toBe(200);
  });

  it('公开写接口超过每分钟上限就 429，并给 Retry-After', () => {
    const ip = uniqueIp();
    let last: any;
    for (let i = 0; i < PUBLIC_WRITE_LIMIT_PER_MIN + 3; i += 1) {
      const r = res();
      let called = false;
      rateLimitMiddleware(
        req({
          socket: { remoteAddress: '127.0.0.1' },
          headers: { 'x-forwarded-for': ip },
          method: 'POST',
          path: '/api/public/comments',
        }),
        r,
        () => {
          called = true;
        },
      );
      last = { r, called };
    }
    expect(last.called).toBe(false);
    expect(last.r.out.status).toBe(429);
    expect(last.r.out.headers['Retry-After']).toBeTruthy();
    expect(last.r.out.body.statusCode).toBe(429);
  });

  it('初始化接口的额度比公开写接口更严', () => {
    expect(INIT_LIMIT_PER_10MIN).toBeLessThanOrEqual(PUBLIC_WRITE_LIMIT_PER_MIN);
    const ip = uniqueIp();
    const codes: number[] = [];
    for (let i = 0; i < INIT_LIMIT_PER_10MIN + 2; i += 1) {
      const r = res();
      rateLimitMiddleware(
        req({
          socket: { remoteAddress: '127.0.0.1' },
          headers: { 'x-forwarded-for': ip },
          method: 'POST',
          path: '/api/admin/init',
        }),
        r,
        () => undefined,
      );
      codes.push(r.out.status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });

  it('普通 GET 只受全局粗粒度限制，正常量级不会被挡', () => {
    const ip = uniqueIp();
    let blocked = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = res();
      rateLimitMiddleware(
        req({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip }, path: '/api/public/meta' }),
        r,
        () => undefined,
      );
      if (r.out.status === 429) {
        blocked += 1;
      }
    }
    expect(blocked).toBe(0);
    expect(GLOBAL_LIMIT_PER_MIN).toBeGreaterThan(50);
  });

  it('不同 IP 互不影响', () => {
    const a = uniqueIp();
    const b = uniqueIp();
    for (let i = 0; i < PUBLIC_WRITE_LIMIT_PER_MIN + 1; i += 1) {
      const r = res();
      rateLimitMiddleware(
        req({
          socket: { remoteAddress: '127.0.0.1' },
          headers: { 'x-forwarded-for': a },
          method: 'POST',
          path: '/api/public/comments',
        }),
        r,
        () => undefined,
      );
    }
    const rb = res();
    let called = false;
    rateLimitMiddleware(
      req({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': b },
        method: 'POST',
        path: '/api/public/comments',
      }),
      rb,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
  });
});

describe('安全响应头', () => {
  it('四个零风险头都会加上，且不覆盖已有值', () => {
    const r = res();
    securityHeadersMiddleware(req(), r, () => undefined);
    expect(r.out.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(r.out.headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(r.out.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(r.out.headers['Permissions-Policy']).toContain('geolocation=()');

    const preset = res();
    preset.setHeader('X-Frame-Options', 'DENY');
    securityHeadersMiddleware(req(), preset, () => undefined);
    expect(preset.out.headers['X-Frame-Options']).toBe('DENY');
  });

  // ⚠️ 这条以前是「刻意不设 CSP」并断言该头部为 undefined。它保护的其实是**取数指令**
  //    （script-src / style-src / default-src…）：内联样式、bytemd 注入的脚本、可选的第三方统计
  //    都会被它们打坏，要做得先给内联内容发 nonce —— 那个结论**依然成立**，所以钉子保留、
  //    但改成钉"下发的值里没有取数指令"，而不是"整个文件不许出现 CSP"。
  //    现在下发的是三条**非取数**指令，逐条核实过不会弄坏任何现有功能：
  //      frame-ancestors 'self' 与既有 X-Frame-Options: SAMEORIGIN 同义（后台嵌同源 waline /ui
  //        是"我们嵌别人"，由 frame-src 管，不受影响）；
  //      object-src 'none'：正文白名单（website/utils/markdownSanitize.ts）里没有 object/embed/applet；
  //      base-uri 'none'：全仓库 <base 零命中。
  it('CSP 只下发三条零风险指令，且不含任何取数指令', () => {
    const r = res();
    securityHeadersMiddleware(req(), r, () => undefined);
    const csp = String(r.out.headers['Content-Security-Policy'] ?? '');
    expect(csp).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    expect(csp).not.toMatch(/script-src|style-src|default-src|img-src|connect-src|font-src|media-src/);
  });

  it('⚠️ 覆盖面别夸大：这个中间件只挂在 pre-Nest 前缀上，前台与后台不经过它', () => {
    // main.ts 只在 matchesPreNestPrefix(req.path) 为真时调用它（/static/、/rss/、/sitemap/、/swagger）。
    // 要给全站页面上 CSP，正确落点是 caddy 那一层（caddyTemplate.json 的 headers handler）。
    // ⚠️ 路径是 `../main.ts`：本文件在 src/utils/ 下，而 main.ts 在 src/ 下
    const main = require('fs').readFileSync(require('path').join(__dirname, '../main.ts'), 'utf-8');
    expect(main).toMatch(/matchesPreNestPrefix\(req\.path\)/);
    expect(main).toMatch(/securityHeadersMiddleware\(req, res,/);
  });
});

describe('静态资源走独立限流桶', () => {
  // 全局限流挂在 path:'*' 上，一张图也算一次：一篇带 10 张图的文章 = 11 次计数，
  // 600/分钟只够 ~50 次浏览/分钟/IP —— 公司 NAT、校园网、或 CDN 回源 IP 没被识别时，
  // 正常读者会成片 429。所以静态资源必须有自己（宽 10 倍）的桶。
  const mkReq = (path: string, ip = '203.0.113.7') =>
    ({
      path,
      method: 'GET',
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: '10.0.0.9' },
      ip,
    }) as any;
  const mkRes = () => {
    const res: any = { statusCode: 0, body: undefined, headers: {} };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.getHeader = (k: string) => res.headers[k];
    return res;
  };

  it('isStaticAssetPath 只认 /static/ 前缀', () => {
    expect(isStaticAssetPath('/static/img/a.webp')).toBe(true);
    expect(isStaticAssetPath('/static/img/thumb/a.webp')).toBe(true);
    expect(isStaticAssetPath('/api/public/meta')).toBe(false);
    expect(isStaticAssetPath('/')).toBe(false);
    expect(isStaticAssetPath('/statics/x')).toBe(false);
    expect(isStaticAssetPath(undefined as any)).toBe(false);
  });

  it('刷静态资源不会把 API 的桶吃掉', () => {
    const { rateLimitMiddleware } = require('./rateLimit');
    // 打满静态桶的量（远超全局 600），然后再请求一次 API：API 必须仍然放行
    for (let i = 0; i < 700; i += 1) {
      const res = mkRes();
      rateLimitMiddleware(mkReq(`/static/img/f-${i}.webp`), res, () => undefined);
    }
    const apiRes = mkRes();
    let apiPassed = false;
    rateLimitMiddleware(mkReq('/api/public/meta'), apiRes, () => { apiPassed = true; });
    expect(apiPassed).toBe(true);
    expect(apiRes.statusCode).not.toBe(429);
  });

  it('静态桶自己的上限仍然生效（不是无限）', () => {
    const { rateLimitMiddleware, STATIC_LIMIT_PER_MIN, GLOBAL_LIMIT_PER_MIN } = require('./rateLimit');
    expect(STATIC_LIMIT_PER_MIN).toBe(GLOBAL_LIMIT_PER_MIN * 10);
    let blocked = 0;
    for (let i = 0; i < STATIC_LIMIT_PER_MIN + 50; i += 1) {
      const res = mkRes();
      rateLimitMiddleware(mkReq(`/static/img/many-${i}.webp`, '198.51.100.9'), res, () => undefined);
      if (res.statusCode === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

/**
 * 🔴 回归：init 桶曾经把**只读探测**也计入配额，于是监控/脚本能把真正的
 * 初始化与灾难恢复锁死最长 10 分钟。
 *
 * 活体事故形状（不是假想）：一个验证脚本用 `GET /api/admin/init` 判断"站点是否已初始化"，
 * 打了 3 次就把 5 次/10 分钟 的配额吃光，之后所有真请求都是
 * `429 初始化接口调用过于频繁` —— 而它只好把 `VANBLOG_INIT_LIMIT_PER_10MIN` 抬到 500 才能继续测。
 * 后台 `InitPage` 甚至为此专门写了"页面加载时不发探测请求"的注释来绕开它。
 *
 * 判据（也写在了 rateLimit.ts 里）：**写入/消耗资源的才计数，读取/探测的不计数**。
 * ⚠️ 而"不计数"绝不等于"不限流"：这一组用例里有一半是在证明**配额一点没被放宽**，
 * 因为"修可用性问题时顺手把安全性质撤掉"是本仓库真实发生过的事故形状。
 */
describe('init 桶只对写操作计数（读取/探测不烧配额）', () => {
  // 有效配额：与生产同一条计算路径（按 worker 数摊薄），不硬编码 5，
  // 否则 VANBLOG_CLUSTER_WORKERS 一设，这些断言就会集体假红/假绿。
  const { scaleLimit } = require('./clusterRole');
  const quota = () => scaleLimit(INIT_LIMIT_PER_10MIN);

  /** 真发一次请求，返回状态码与响应对象（不是打桩 rateLimitMiddleware 本身） */
  const send = (method: string, path: string, ip: string) => {
    const r = res();
    let passed = false;
    rateLimitMiddleware(
      req({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip }, method, path }),
      r,
      () => {
        passed = true;
      },
    );
    return { status: r.out.status, headers: r.out.headers, body: r.out.body, passed };
  };

  it('🔴 事故形状：打满配额的 GET 探测之后，POST 初始化仍然可用', () => {
    const ip = uniqueIp();
    // 探测次数远超配额（旧代码下第 6 次起就会 429，并把 POST 一起锁死）
    for (let i = 0; i < quota() * 4 + 3; i += 1) {
      const g = send('GET', '/api/admin/init', ip);
      // GET 探测本身也不该被这个桶挡住（它只可能撞全局桶，而这里次数远小于 600）
      expect(g.status).not.toBe(429);
      expect(g.passed).toBe(true);
    }
    // 真正的初始化写入必须仍然拿得到额度
    const post = send('POST', '/api/admin/init', ip);
    expect(post.status).not.toBe(429);
    expect(post.passed).toBe(true);
  });

  it('🔴 事故形状（恢复路径）：GET 探测之后，匿名的 POST /init/restore 仍然可用', () => {
    const ip = uniqueIp();
    for (let i = 0; i < quota() * 3; i += 1) {
      expect(send('GET', '/api/admin/init', ip).status).not.toBe(429);
    }
    // 灾难恢复入口：站长在"主机全毁、拿异地归档重建"时走的就是这一条，绝不能被监控吃掉
    const restore = send('POST', '/api/admin/init/restore', ip);
    expect(restore.status).not.toBe(429);
    expect(restore.passed).toBe(true);
  });

  it('限流没有被放宽：写操作超过配额仍然 429，且前 quota 次都放行', () => {
    const ip = uniqueIp();
    const q = quota();
    const codes: number[] = [];
    for (let i = 0; i < q + 2; i += 1) {
      codes.push(send('POST', '/api/admin/init', ip).status);
    }
    // 前 q 次必须全放行（证明不是"一刀切全拒"）
    expect(codes.slice(0, q).every((c) => c !== 429)).toBe(true);
    // 第 q+1、q+2 次必须被拒（证明配额还是那个配额）
    expect(codes[q]).toBe(429);
    expect(codes[q + 1]).toBe(429);
  });

  it('三个真实 POST 路由共享同一个桶（不是每个路由各 5 次）', () => {
    const ip = uniqueIp();
    const q = quota();
    // init.controller.ts 里这个前缀下只有这三个路由，全是 POST
    const paths = ['/api/admin/init', '/api/admin/init/upload', '/api/admin/init/restore'];
    const codes: number[] = [];
    for (let i = 0; i < q + 2; i += 1) {
      codes.push(send('POST', paths[i % paths.length], ip).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });

  it('HEAD/OPTIONS 与 GET 一样不计数（安全方法一律视为只读）', () => {
    const ip = uniqueIp();
    for (let i = 0; i < quota() * 2; i += 1) {
      expect(send('HEAD', '/api/admin/init', ip).status).not.toBe(429);
      expect(send('OPTIONS', '/api/admin/init/restore', ip).status).not.toBe(429);
    }
    expect(send('POST', '/api/admin/init', ip).status).not.toBe(429);
  });

  it('前缀下**未知**子路径的写请求也计数（将来新增写路由不会静默漏限流）', () => {
    const ip = uniqueIp();
    const q = quota();
    const codes: number[] = [];
    for (let i = 0; i < q + 2; i += 1) {
      codes.push(send('POST', '/api/admin/init/some-future-write-route', ip).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    // 而且它吃掉的是**同一个**桶 ⇒ 真正的恢复路由也跟着被限（这是有意的：宁可严不可漏）
    expect(send('POST', '/api/admin/init/restore', ip).status).toBe(429);
  });

  it('PUT/DELETE 这类非安全方法也计数（判据是"是不是安全方法"，不是"是不是 POST"）', () => {
    const ip = uniqueIp();
    const q = quota();
    const codes: number[] = [];
    for (let i = 0; i < q + 2; i += 1) {
      codes.push(send(i % 2 === 0 ? 'PUT' : 'DELETE', '/api/admin/init', ip).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/public/health 不占 init 桶的额度（这就是探测该改用的端点）', () => {
    const ip = uniqueIp();
    for (let i = 0; i < quota() * 3; i += 1) {
      expect(send('GET', '/api/public/health', ip).status).not.toBe(429);
    }
    // 探了这么多次之后，灾难恢复入口的额度必须一点没动
    expect(send('POST', '/api/admin/init/restore', ip).status).not.toBe(429);
  });

  it('429 带 Retry-After，且文案给出"等多久 + 换哪个端点 + 怎么调额度"', () => {
    const ip = uniqueIp();
    const q = quota();
    let last: any;
    for (let i = 0; i < q + 1; i += 1) {
      last = send('POST', '/api/admin/init', ip);
    }
    expect(last.status).toBe(429);
    // 灾难现场最需要的是"还要等多久"
    expect(last.headers['Retry-After']).toBeTruthy();
    expect(Number(last.headers['Retry-After'])).toBeGreaterThan(0);
    const msg = String(last.body?.message ?? '');
    expect(msg).toContain('/api/public/health'); // 指路到不占额度的探测端点
    expect(msg).toContain('VANBLOG_INIT_LIMIT_PER_10MIN'); // 指路到调额度的旋钮
    expect(msg).toMatch(/写操作|POST/); // 说清只有写操作计数
    expect(msg).toMatch(/秒|分钟/); // 说清要等多久
    expect(last.body.statusCode).toBe(429);
  });

  it('源码绊线：init 桶的条件必须**同时**含前缀判定与方法判定', () => {
    const fs = require('fs');
    const path = require('path');
    const { stripCommentsForAnchor } = require('src/test-utils/anchorCode');
    const src = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, 'rateLimit.ts'), 'utf-8'),
    );
    // 必须是"前缀 && 非安全方法"的组合形状
    expect(src).toMatch(/path\.startsWith\('\/api\/admin\/init'\)\s*&&\s*!SAFE_METHODS\.has\(method\)/);
    // 🔴 负向：改回"一律计数"的形状必须不被上面那条匹配（证明尺子有方向性、不是恒真）
    const reverted = "if (path.startsWith('/api/admin/init')) {";
    expect(reverted).not.toMatch(/path\.startsWith\('\/api\/admin\/init'\)\s*&&\s*!SAFE_METHODS\.has\(method\)/);
    // 安全方法集合本身必须存在且只含这三个（多了会让写操作漏网，少了会让探测重新烧配额）
    expect(src).toMatch(/const SAFE_METHODS = new Set\(\['GET', 'HEAD', 'OPTIONS'\]\)/);
    // 剥注释器确实在工作：注释里提到过 SAFE_METHODS，剥掉之后仍应能从代码里找到它
    const raw = fs.readFileSync(path.join(__dirname, 'rateLimit.ts'), 'utf-8');
    expect(raw).toContain('SAFE_METHODS');
    expect(src).toContain('SAFE_METHODS');
    expect(raw.length).toBeGreaterThan(src.length); // 确实剥掉了东西（否则"剥注释"是空操作）
  });
});
