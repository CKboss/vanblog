import * as fs from 'fs';
import * as path from 'path';
import {
  BRUTE_FORCE_IP_SOURCE_ENV,
  bruteForceClientIp,
  resolveBruteForceIpSource,
} from './trustedProxy';

/**
 * 防爆破计数（登录 / 评论 / 加密文章解锁）用哪个 IP。
 *
 * 修的漏洞（活体证明过）：这三类计数以前固定在 `pickSocketIp()`，而一体式部署里
 * caddy 从 127.0.0.1 拨到 127.0.0.1:3000 ⇒ **所有访客共用一个桶** ⇒
 * 5 个不同客户端各失败登录 1 次就能让第 6 个**带正确密码**的客户端被锁 300 秒，
 * 每 5 分钟花 5 个请求即可永久续期（后台永久 DoS）；20 个请求锁死一篇加密文章；
 * 10 个请求/10 分钟让全站不能评论。存库的评论 IP 同理全是 127.0.0.1。
 */
const loopbackReq = (headers: Record<string, string> = {}) =>
  ({ headers, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' }) as any;

describe('防爆破计数的 IP 来源', () => {
  it("默认是 trusted，只有字面 'socket' 才切回去；写错的值不会静默变成最松的那种", () => {
    expect(resolveBruteForceIpSource(undefined)).toBe('trusted');
    expect(resolveBruteForceIpSource('')).toBe('trusted');
    expect(resolveBruteForceIpSource('socket')).toBe('socket');
    expect(resolveBruteForceIpSource('SOCKET')).toBe('socket');
    expect(resolveBruteForceIpSource(' socket ')).toBe('socket');
    for (const bad of ['trusted', 'auto', 'yes', '1', 'sockt', 'none']) {
      expect(resolveBruteForceIpSource(bad)).toBe('trusted');
    }
    expect(BRUTE_FORCE_IP_SOURCE_ENV).toBe('VANBLOG_BRUTE_FORCE_IP_SOURCE');
  });

  it('反代（回环对端 + 追加式 XFF）后面：两个不同客户端拿到**不同**的 key —— DoS 被修掉', () => {
    const a = bruteForceClientIp(loopbackReq({ 'x-forwarded-for': '203.0.113.7' }));
    const b = bruteForceClientIp(loopbackReq({ 'x-forwarded-for': '198.51.100.9' }));
    expect(a).toBe('203.0.113.7');
    expect(b).toBe('198.51.100.9');
    expect(a).not.toBe(b);
    // 对照：socket 模式下两者都是 127.0.0.1（这就是漏洞的形状）
    expect(bruteForceClientIp(loopbackReq({ 'x-forwarded-for': '203.0.113.7' }), 'socket')).toBe('127.0.0.1');
    expect(bruteForceClientIp(loopbackReq({ 'x-forwarded-for': '198.51.100.9' }), 'socket')).toBe('127.0.0.1');
  });

  it('⚠️ 客户端伪造 XFF 也拿不到新预算、也栽赃不了受害者（取最右一跳 = caddy 追加的那个）', () => {
    // 攻击者自己塞 "X-Forwarded-For: <受害者>"，caddy 追加它看到的对端 ⇒ "<受害者>, <攻击者>"
    const spoofed = bruteForceClientIp(
      loopbackReq({ 'x-forwarded-for': '192.0.2.50, 203.0.113.66' }),
    );
    expect(spoofed).toBe('203.0.113.66'); // 攻击者自己的 IP，不是它想栽赃的 192.0.2.50
    // 每次都换一个受害者前缀，key 仍然不变 ⇒ 换头换不出新预算
    const again = bruteForceClientIp(
      loopbackReq({ 'x-forwarded-for': '198.51.100.100, 203.0.113.66' }),
    );
    expect(again).toBe(spoofed);
    // CDN 头也一样不被采信（auto 模式只看 XFF 最右一跳 / x-real-ip 兜底）
    expect(
      bruteForceClientIp(loopbackReq({ 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '203.0.113.66' })),
    ).toBe('203.0.113.66');
  });

  it('直连暴露（对端是公网地址）时不采信任何转发头 ⇒ 伪造头无效', () => {
    const req = {
      headers: { 'x-forwarded-for': '192.0.2.50', 'x-real-ip': '8.8.8.8', 'cf-connecting-ip': '1.1.1.1' },
      socket: { remoteAddress: '203.0.113.9' },
      ip: '203.0.113.9',
    } as any;
    expect(bruteForceClientIp(req)).toBe('203.0.113.9');
  });

  it('什么信息都没有时回落到 unknown，且永不返回空串（空串会让所有匿名请求共用一个 key）', () => {
    expect(bruteForceClientIp({} as any)).toBe('unknown');
    expect(bruteForceClientIp(undefined)).toBe('unknown');
    expect(bruteForceClientIp({ headers: {}, socket: {} } as any)).not.toBe('');
  });

  it('源码钉子：三类计数与存库的评论 IP 都必须走 bruteForceClientIp', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const read = (rel: string) =>
      fs
        .readFileSync(path.join(repoRoot, rel), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');

    const guard = read('packages/server/src/provider/auth/login.guard.ts');
    expect(guard).toContain('bruteForceClientIp(req)');
    expect(guard).not.toMatch(/const ip = pickSocketIp\(req\);/);

    const comment = read('packages/server/src/provider/comment/comment.provider.ts');
    expect(comment).toContain('bruteForceClientIp(req)');
    expect(comment).toContain('ip: bruteForceClientIp(data.req)');
    expect(comment).not.toMatch(/ip: pickSocketIp\(data\.req\)/);

    const pub = read('packages/server/src/controller/public/public.controller.ts');
    expect(pub).toMatch(/unlock-\$\{bruteForceClientIp\(req\)\}/);
    expect(pub).not.toMatch(/unlock-\$\{pickSocketIp\(req\)\}/);
  });
});
