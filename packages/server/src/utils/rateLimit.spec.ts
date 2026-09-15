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

  it('刻意不设 CSP（内联样式与第三方统计会被打坏，要做得先上 nonce）', () => {
    const r = res();
    securityHeadersMiddleware(req(), r, () => undefined);
    expect(r.out.headers['Content-Security-Policy']).toBeUndefined();
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
