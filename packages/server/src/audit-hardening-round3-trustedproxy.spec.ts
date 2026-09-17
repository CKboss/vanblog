import {
  isPrivateOrLoopback,
  pickTrustedClientIp,
  resolveForwardedTrustMode,
  rightMostForwardedFor,
} from './utils/trustedProxy';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 限流的"该信哪个 IP"：`VANBLOG_TRUST_FORWARDED_HEADERS`（默认 `auto`）。
 *
 * 为什么必须有这一组：改动前四档体量限流的 key 是 `pickClientIp(req) || pickSocketIp(req)`，
 * 而 `pickClientIp` 优先读 `cf-connecting-ip` / `true-client-ip` / `x-real-ip` / `x-forwarded-for`
 * —— **全是客户端可控的头**，caddy 只会往 XFF 里追加真实对端、不会剥掉客户端自带的
 * `cf-connecting-ip`。实测（`VANBLOG_RATE_LIMIT_PER_MIN=5`，进程内伪造 req）：
 * 同一套接字 IP 不带头 ⇒ 放行 5 / 拦下 15；每请求换一个 `cf-connecting-ip` ⇒ **放行 20 / 拦下 0**；
 * 换 `x-forwarded-for` 同样 20/0；回环对端（一体式部署里 caddy 就在 127.0.0.1）也 20/0；
 * `/static/**` 那个 10 倍桶同样 20/0。顺带每个伪造 IP 还占一个 attemptLimit 的桶。
 *
 * 但**不能**改成只认套接字地址：反代后面全站共用一个桶就是 §7.44 那场 429 风暴。
 * 所以 `auto` = "对端是回环/私网才采信转发头，而且只信一跳（XFF 的最右一项）"。
 */

const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

describe('私网/回环判定（信任转发头的前提）', () => {
  const truthy: Array<[any, boolean]> = [
    // 回环
    ['127.0.0.1', true],
    ['127.9.9.9', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', true],
    // RFC1918（docker 默认 172.17/16、compose 网络 172.18–172.31、podman 10.88/16、
    // Docker Desktop 192.168.65.x 全都落在里面 ⇒ 不需要额外网段）
    ['10.0.0.1', true],
    ['10.255.1.1', true],
    ['10.88.0.5', true],
    ['172.16.0.1', true],
    ['172.17.0.2', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.65.3', true],
    // IPv6 ULA 与链路本地
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    // 边界：必须为假
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['11.0.0.1', false],
    ['9.255.255.255', false],
    ['169.254.169.254', false], // 云元数据地址所在的链路本地段，故意不信
    ['100.64.0.1', false], // CGNAT：公网侧共享地址段，信它等于让一整片用户互相顶替
    ['100.127.255.255', false],
    ['203.0.113.7', false],
    ['198.51.100.1', false],
    ['8.8.8.8', false],
    ['2001:db8::1', false],
    ['', false],
    ['not-an-ip', false],
    [undefined as any, false],
    ['256.1.1.1', false],
    ['1.2.3', false],
  ];

  it.each(truthy)('%s ⇒ %s', (ip, expected) => {
    expect(isPrivateOrLoopback(ip)).toBe(expected);
  });

  it('与 provider/log/utils 的 isSkippedPrivateIp 不一样（那个不能用于信任判定）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isSkippedPrivateIp } = require('./provider/log/utils');
    // 上游遗留：10.x 里**只有 10.7.*** 被当成私网，而 172.32 被算进了 172.16/12
    expect(isSkippedPrivateIp('10.0.0.1')).toBe(false);
    expect(isSkippedPrivateIp('10.7.0.1')).toBe(true);
    expect(isSkippedPrivateIp('172.32.0.1')).toBe(true);
    // 新 helper 的判定才是对的
    expect(isPrivateOrLoopback('10.0.0.1')).toBe(true);
    expect(isPrivateOrLoopback('172.32.0.1')).toBe(false);
  });
});

describe('X-Forwarded-For 取最右一项（caddy 是追加，不是覆盖）', () => {
  it('最右 = 可信代理亲眼看到的对端；左边都可能是客户端塞的', () => {
    expect(rightMostForwardedFor('1.2.3.4, 203.0.113.7')).toBe('203.0.113.7');
    expect(rightMostForwardedFor('198.51.100.99, 10.0.0.9, 203.0.113.42')).toBe('203.0.113.42');
    expect(rightMostForwardedFor('203.0.113.7')).toBe('203.0.113.7');
    expect(rightMostForwardedFor('  198.51.100.9 , 203.0.113.9  ')).toBe('203.0.113.9');
    expect(rightMostForwardedFor(['9.9.9.9', '203.0.113.7'])).toBe('203.0.113.7');
    expect(rightMostForwardedFor('garbage, 203.0.113.7')).toBe('203.0.113.7');
    expect(rightMostForwardedFor('2001:db8::1, 203.0.113.7')).toBe('203.0.113.7');
  });
  it('全是垃圾 / 空 / 缺失 ⇒ null（调用方回落到套接字地址）', () => {
    expect(rightMostForwardedFor('garbage')).toBe(null);
    expect(rightMostForwardedFor('')).toBe(null);
    expect(rightMostForwardedFor(undefined)).toBe(null);
    expect(rightMostForwardedFor([])).toBe(null);
  });
});

describe('三种模式', () => {
  const req = (socketIp: string, headers: Record<string, any> = {}) =>
    ({ socket: { remoteAddress: socketIp }, headers } as any);

  it('env 解析：只认 auto/always/never（大小写与空格宽容），写错的值回落 auto', () => {
    expect(resolveForwardedTrustMode('auto')).toBe('auto');
    expect(resolveForwardedTrustMode('ALWAYS')).toBe('always');
    expect(resolveForwardedTrustMode(' never ')).toBe('never');
    expect(resolveForwardedTrustMode('yes')).toBe('auto');
    expect(resolveForwardedTrustMode('')).toBe('auto');
    expect(resolveForwardedTrustMode(undefined)).toBe('auto');
  });

  it('auto：对端是公网 ⇒ 转发头一律忽略（绕过被堵死）', () => {
    const r = req('203.0.113.7', {
      'cf-connecting-ip': '9.9.9.9',
      'x-real-ip': '9.9.9.9',
      'x-forwarded-for': '9.9.9.9',
    });
    expect(pickTrustedClientIp(r, 'auto')).toBe('203.0.113.7');
  });

  it('auto：对端是回环/私网 ⇒ 取 XFF 最右一项；客户端伪造的前缀无效', () => {
    // 真实部署里 caddy 会把真实对端**追加**到客户端自带的 XFF 后面
    expect(
      pickTrustedClientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.99, 203.0.113.42' }), 'auto'),
    ).toBe('203.0.113.42');
    expect(pickTrustedClientIp(req('172.18.0.2', { 'x-forwarded-for': '203.0.113.5' }), 'auto')).toBe(
      '203.0.113.5',
    );
    expect(
      pickTrustedClientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.6' }), 'auto'),
    ).toBe('203.0.113.6');
  });

  it('auto：没有 XFF 时用套接字地址，**不**采信 x-real-ip / cf-connecting-ip（无法区分谁写的）', () => {
    expect(
      pickTrustedClientIp(req('127.0.0.1', { 'x-real-ip': '9.9.9.9', 'cf-connecting-ip': '9.9.9.9' }), 'auto'),
    ).toBe('127.0.0.1');
  });

  it('never：任何头都不看', () => {
    expect(
      pickTrustedClientIp(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.6' }), 'never'),
    ).toBe('127.0.0.1');
    expect(pickTrustedClientIp(req('203.0.113.7', { 'x-forwarded-for': '9.9.9.9' }), 'never')).toBe(
      '203.0.113.7',
    );
  });

  it('always：旧行为（CDN 头优先），给 CF/隧道直连源站的部署用', () => {
    expect(
      pickTrustedClientIp(req('203.0.113.7', { 'cf-connecting-ip': '198.51.100.7' }), 'always'),
    ).toBe('198.51.100.7');
  });

  it('拿不到任何地址时回落 "unknown"（与改动前一致，不会返回空串让所有请求共用一个空 key）', () => {
    expect(pickTrustedClientIp({ headers: {} } as any, 'auto')).toBe('unknown');
  });
});

describe('限流中间件：绕过被堵死，而按真实客户端分桶仍然成立', () => {
  /**
   * 用 `VANBLOG_RATE_LIMIT_PER_MIN=5` 重新加载模块（阈值是 import 时读的），
   * 全程在进程内伪造 req —— **不打活体端口**：真灌流量会把别的测试/别的 agent
   * 正在用的限流桶顶掉。
   */
  function loadLimiter() {
    const oldEnv = process.env.VANBLOG_RATE_LIMIT_PER_MIN;
    process.env.VANBLOG_RATE_LIMIT_PER_MIN = '5';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rateLimit = require('./utils/rateLimit');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const attemptLimit = require('./utils/attemptLimit');
    if (oldEnv === undefined) delete process.env.VANBLOG_RATE_LIMIT_PER_MIN;
    else process.env.VANBLOG_RATE_LIMIT_PER_MIN = oldEnv;
    attemptLimit.__resetAttemptLimitForTest();
    return { rateLimit, attemptLimit };
  }

  const makeRes = () => {
    const out: any = { status: 200, headers: {} };
    return {
      out,
      setHeader: (k: string, v: string) => {
        out.headers[k] = v;
      },
      getHeader: (k: string) => out.headers[k],
      status(c: number) {
        out.status = c;
        return this;
      },
      json(b: any) {
        out.body = b;
        return this;
      },
    } as any;
  };
  const makeReq = (socketIp: string, headers: Record<string, any> = {}, p = '/api/public/meta') =>
    ({ method: 'GET', path: p, url: p, socket: { remoteAddress: socketIp }, headers } as any);

  function fire(
    n: number,
    reqOf: (i: number) => any,
    mode?: string,
  ): { passed: number; limited: number; buckets: number } {
    const { rateLimit, attemptLimit } = loadLimiter();
    if (mode) process.env.VANBLOG_TRUST_FORWARDED_HEADERS = mode;
    let passed = 0;
    let limited = 0;
    for (let i = 0; i < n; i += 1) {
      const res = makeRes();
      let nexted = false;
      rateLimit.rateLimitMiddleware(reqOf(i), res, () => {
        nexted = true;
      });
      if (nexted) passed += 1;
      else limited += 1;
    }
    const size = attemptLimit.attemptLimitStats().size;
    delete process.env.VANBLOG_TRUST_FORWARDED_HEADERS;
    jest.resetModules();
    return { passed, limited, buckets: size };
  }

  it('(a) 非回环对端 + 每请求换一个 cf-connecting-ip ⇒ 仍然只按套接字 IP 计数（绕过失效）', () => {
    const r = fire(
      20,
      (i) => makeReq('203.0.113.7', { 'cf-connecting-ip': `198.51.100.${i % 250}` }),
      'auto',
    );
    expect(r.passed).toBe(5);
    expect(r.limited).toBe(15);
    // 而且只有一个桶（改动前是 20 个）
    expect(r.buckets).toBe(1);
  });

  it('(a2) 非回环对端 + 换 x-forwarded-for / 打静态资源桶 ⇒ 同样绕不过', () => {
    const xff = fire(20, (i) => makeReq('203.0.113.8', { 'x-forwarded-for': `192.0.2.${i}` }), 'auto');
    expect(xff.passed).toBe(5);
    expect(xff.limited).toBe(15);
    const statics = fire(
      20,
      (i) => makeReq('203.0.113.9', { 'cf-connecting-ip': `198.18.0.${i}` }, '/static/img/a.webp'),
      'auto',
    );
    // 静态桶是全局的 10 倍 = 50，20 次都放行，但**桶只有一个**（改动前是 20 个）
    expect(statics.passed).toBe(20);
    expect(statics.buckets).toBe(1);
  });

  it('(a3) 回环对端（一体式部署的形状）+ 伪造的 XFF 前缀 ⇒ 用的是 caddy 追加的最右一项', () => {
    const r = fire(
      20,
      (i) => makeReq('127.0.0.1', { 'x-forwarded-for': `198.51.100.${i % 250}, 203.0.113.7` }),
      'auto',
    );
    expect(r.passed).toBe(5);
    expect(r.limited).toBe(15);
    expect(r.buckets).toBe(1);
  });

  it('(b) 回环对端 + 两个不同的真实客户端 ⇒ 两个独立桶（反代后按客户端限流仍然成立）', () => {
    const { rateLimit, attemptLimit } = loadLimiter();
    const perClient: Record<string, { passed: number; limited: number }> = {};
    for (const client of ['198.51.100.11', '198.51.100.22']) {
      let passed = 0;
      let limited = 0;
      for (let i = 0; i < 7; i += 1) {
        const res = makeRes();
        let nexted = false;
        rateLimit.rateLimitMiddleware(
          makeReq('127.0.0.1', { 'x-forwarded-for': `9.9.9.9, ${client}` }),
          res,
          () => {
            nexted = true;
          },
        );
        if (nexted) passed += 1;
        else limited += 1;
      }
      perClient[client] = { passed, limited };
    }
    expect(perClient['198.51.100.11']).toEqual({ passed: 5, limited: 2 });
    expect(perClient['198.51.100.22']).toEqual({ passed: 5, limited: 2 });
    expect(attemptLimit.attemptLimitStats().size).toBe(2);
    jest.resetModules();
  });

  it('(c) always ⇒ 伪造头会被采信（今天的行为，文档里写明代价）；never ⇒ 两个客户端共用一个桶', () => {
    const always = fire(
      20,
      (i) => makeReq('203.0.113.7', { 'cf-connecting-ip': `198.51.100.${i % 250}` }),
      'always',
    );
    expect(always.passed).toBe(20);
    expect(always.limited).toBe(0);
    expect(always.buckets).toBe(20);

    const never = fire(
      14,
      (i) =>
        makeReq('127.0.0.1', {
          'x-forwarded-for': i % 2 === 0 ? '198.51.100.11' : '198.51.100.22',
        }),
      'never',
    );
    // 只认套接字地址 ⇒ 两个"客户端"共用 127.0.0.1 这一个桶：5 次之后全拦
    expect(never.passed).toBe(5);
    expect(never.limited).toBe(9);
    expect(never.buckets).toBe(1);
  });

  it('回环直连且不带转发头 ⇒ 仍然算站内调用直接放行（前台 SSR / ISR 触发不受影响）', () => {
    const { rateLimit } = loadLimiter();
    let nexted = false;
    rateLimit.rateLimitMiddleware(makeReq('127.0.0.1'), makeRes(), () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    jest.resetModules();
  });
});

describe('哪些调用点用哪个 IP 函数（这条最容易被下一个人改错）', () => {
  it('体量类限流走 pickTrustedClientIp', () => {
    const src = code(read('utils/rateLimit.ts'));
    expect(src).toContain('const ip = pickTrustedClientIp(req);');
    expect(src).not.toContain('pickClientIp(req) || pickSocketIp(req)');
  });

  // ⚠️⚠️ 这条钉子**被第四轮审计推翻了**，保留在这里是为了记录"当初的理由错在哪"。
  //
  // 原来它断言三类防爆破计数必须继续用 pickSocketIp()，理由是"换成可信头就等于重开
  // 『换一个 X-Real-IP 就能无限试密码，还能用受害者 IP 把对方锁在门外』"。
  // 那个理由对**旧的** pickClientIp()（优先读 cf-connecting-ip / x-real-ip，即客户端可控的那一项）成立，
  // 但对 pickTrustedClientIp() 在默认 auto 模式下**不成立**：auto 只在对端是回环/私网时采信转发头，
  // 而且取 XFF 的**最右一跳**（可信代理亲手追加的对端）。客户端塞的 `X-Forwarded-For: <受害者>`
  // 经 caddy 会变成 `<受害者>, <攻击者>`，最右一项仍是攻击者自己 ⇒ 既绕不过也栽赃不了
  // （见 utils/bruteForceIp.spec.ts 的活体形状用例）。
  //
  // 而坚持用套接字地址是有**真实代价**的：一体式部署里 caddy 从 127.0.0.1 拨到 127.0.0.1:3000，
  // 于是所有访客共用一个桶 —— 实测 5 个不同客户端各失败登录 1 次（共 5 个请求），
  // 第 6 个客户端带**正确密码**也被锁 300 秒，且每 5 分钟可续期 ⇒ 后台永久拒绝服务；
  // 20 个请求锁死一篇加密文章；10 个请求/10 分钟让全站不能评论；
  // 存库的评论 IP 也全是 127.0.0.1，后台那一列与按 IP 的审核全部失效。
  //
  // 所以现在走 bruteForceClientIp()（默认 trusted，VANBLOG_BRUTE_FORCE_IP_SOURCE=socket 可退回，
  // 给"反代覆盖而非追加 XFF"的部署留逃生口）。
  it('防爆破类计数走 bruteForceClientIp（默认 trusted；socket 是逃生口）', () => {
    const login = code(read('provider/auth/login.guard.ts'));
    expect(login).toContain('bruteForceClientIp(req)');
    expect(login).not.toMatch(/const ip = pickSocketIp\(req\);/);
    expect(login).not.toContain('pickClientIp');

    const comment = code(read('provider/comment/comment.provider.ts'));
    expect(comment).toContain('const ip = bruteForceClientIp(req);');
    // 存库的评论 IP 也必须是同一个来源，否则后台那一列永远是 127.0.0.1
    expect(comment).toContain('ip: bruteForceClientIp(data.req)');

    const publicCtrl = code(read('controller/public/public.controller.ts'));
    expect(publicCtrl).toMatch(/unlock-\$\{bruteForceClientIp\(req\)\}/);

    // 逃生口本身也要在：只有字面 'socket' 才切回去，写错的值不会静默变成最松的那种
    const proxy = code(read('utils/trustedProxy.ts'));
    expect(proxy).toContain("=== 'socket' ? 'socket' : 'trusted'");
    expect(proxy).toContain('VANBLOG_BRUTE_FORCE_IP_SOURCE');
  });

  it('两个 IP 函数的 docstring 都指向了新 helper（不再互相矛盾）', () => {
    const src = read('provider/log/utils.ts');
    expect(src).toContain('utils/trustedProxy.ts');
    expect(src).toContain('pickTrustedClientIp');
    // 旧的那句"限流关键路径不要用这个函数，用 pickClientIp"是矛盾的源头，必须没了
    expect(src).not.toContain('用本地的 `pickClientIp()`');
  });
});
