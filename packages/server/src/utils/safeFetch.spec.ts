import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { AddressInfo } from 'net';
import { createPinnedAgent, pickPinnedAddress, pinnedLookup } from './safeFetch';

/**
 * IP pinning 的回归钉子。
 *
 * 背景：`assertSafeRemoteUrl` 校验时 `dns.lookup` 解析一次，axios/Node 连接时**再解析一次**，
 * 两次之间 DNS 答案可以变（rebinding、多 A 记录轮流返回、TTL=0 的权威服务器）⇒
 * "校验通过的是公网 IP、真正连上的是 127.0.0.1"。修法是用自定义 Agent 的 `lookup` 钩子
 * 把已校验的地址钉死；**Host 头与 TLS SNI 必须仍然是域名**，否则虚拟主机 / CDN 会直接 404 或证书不匹配。
 *
 * ⚠️ 这些测试全部只连**本机回环上自己起的服务器**，不出网、不依赖 DNS：
 * 域名 `vanblog-pinning.invalid` 是保留的 `.invalid` TLD，永远解析不了 ——
 * 所以"请求居然成功了"这件事本身就证明连接走的是钉住的 IP，而不是 DNS。
 */
describe('pickPinnedAddress：优先 IPv4', () => {
  it('双栈时挑 IPv4（容器与家宽的出向 IPv6 常常不存在，钉到 AAAA 会把能成的抓取变成超时）', () => {
    expect(pickPinnedAddress(['2606:4700:10::6814:179a', '172.66.147.243'])).toBe('172.66.147.243');
    expect(pickPinnedAddress(['1.1.1.1', '2.2.2.2'])).toBe('1.1.1.1');
  });

  it('纯 IPv6 目标就用 IPv6', () => {
    expect(pickPinnedAddress(['2606:4700:10::6814:179a'])).toBe('2606:4700:10::6814:179a');
  });

  it('空/全是空白 ⇒ null（调用方必须因此失败，绝不退回让 Node 自己解析）', () => {
    expect(pickPinnedAddress([])).toBeNull();
    expect(pickPinnedAddress(['', '   '])).toBeNull();
    expect(pickPinnedAddress(undefined as any)).toBeNull();
  });

  it('会 trim 掉首尾空白', () => {
    expect(pickPinnedAddress(['  8.8.8.8  '])).toBe('8.8.8.8');
  });
});

describe('pinnedLookup：永远返回同一个 IP，且两种回调形状都对', () => {
  it('all:false ⇒ (null, address, family)', () => {
    const cb = jest.fn();
    pinnedLookup('127.0.0.1')('anything.example.com', { all: false }, cb);
    expect(cb).toHaveBeenCalledWith(null, '127.0.0.1', 4);
  });

  it('all:true ⇒ (null, [{address, family}])（Node 20+ 的 autoSelectFamily 就是这个形状）', () => {
    // ⚠️ 这条是**踩过坑**才有的：只按 (address, family) 回，Node 会把字符串当地址数组去取
    //    `[0].address`，于是每次外链抓取都失败在 `TypeError: Invalid IP address: undefined`。
    //    容器里是 Node 24、autoSelectFamily 默认开 ⇒ 不是理论问题。
    const cb = jest.fn();
    pinnedLookup('127.0.0.1')('anything.example.com', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: '127.0.0.1', family: 4 }]);
  });

  it('省略 options 的调用形状 lookup(host, cb) 也能用', () => {
    const cb = jest.fn();
    (pinnedLookup('::1') as any)('host', cb);
    expect(cb).toHaveBeenCalledWith(null, '::1', 6);
  });

  it('反证：family 是从地址推出来的，不是写死 4', () => {
    const cb = jest.fn();
    pinnedLookup('2001:4860:4860::8888')('x', { all: false }, cb);
    expect(cb.mock.calls[0][2]).toBe(6);
    expect(net.isIPv6(cb.mock.calls[0][1])).toBeTruthy();
  });

  it('反证：不管传进来什么 hostname 都返回钉住的地址（这才叫 pinning）', () => {
    const cb = jest.fn();
    const lookup = pinnedLookup('9.9.9.9');
    lookup('a.example.com', { all: false }, cb);
    lookup('b.example.org', { all: false }, cb);
    expect(cb.mock.calls.map((c) => c[1])).toEqual(['9.9.9.9', '9.9.9.9']);
  });
});

describe('createPinnedAgent：按协议给对的 Agent，并带上 lookup 钩子', () => {
  it('https 给 https.Agent，http 给 http.Agent，两者都挂了 lookup', () => {
    const secure = createPinnedAgent('127.0.0.1', true);
    const plain = createPinnedAgent('127.0.0.1', false);
    expect(secure).toBeInstanceOf(https.Agent);
    expect(plain).toBeInstanceOf(http.Agent);
    expect(typeof (secure as any).options.lookup).toBe('function');
    expect(typeof (plain as any).options.lookup).toBe('function');
    expect((plain as any).options.keepAlive).toBe(false);
    secure.destroy();
    plain.destroy();
  });
});

describe('端到端：钉住 IP 后真的连到那个 IP，而 Host 头仍是域名', () => {  it('用一个永远解析不了的域名 + 钉到 127.0.0.1，请求仍然成功且服务端看到的 Host 是域名', async () => {
    const seen: string[] = [];
    const server = http.createServer((_req, res) => {
      seen.push(String(_req.headers.host));
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const agent = createPinnedAgent('127.0.0.1', false);
    try {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const req = http.request(
          {
            // ⚠️ .invalid 是 RFC 2606 保留 TLD，永远解析不了：请求能成功就证明
            //    连接用的是钉住的 127.0.0.1，而不是"又去解析了一次域名"。
            host: 'vanblog-pinning.invalid',
            port,
            path: '/x.png',
            agent,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body.subarray(0, 4).toString('latin1')).toBe('\u0089PNG');
      // ⚠️ Host 头必须仍是**域名**（不是钉住的那个 IP），否则虚拟主机 / CDN 会 404 或证书不匹配。
      //    Node 在非标准端口时会把端口一起写进 Host，所以这里带上 port。
      expect(seen).toEqual([`vanblog-pinning.invalid:${port}`]);
      expect(seen[0]).not.toContain('127.0.0.1');
    } finally {
      agent.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * 活体验证：HTTPS + SNI 在 pinning 之下是否还正常。
 *
 * ⚠️ 默认 **skip**，要跑就给 `VANBLOG_SAFEFETCH_LIVE=1`（与 `searchIndex.realdb.spec.ts`
 * 的 `VANBLOG_SEARCH_REALDB=1` 同一个套路）：它要出网、要真 DNS、要真证书，
 * 放进 CI 默认跑等于给自己造一个随网络抖动的红。
 *
 * 为什么值得单独验：pinning 只替换"TCP 连到哪个 IP"，而 TLS 的 **SNI 与证书校验用的仍是域名**。
 * 这条推理是对的，但推理不等于证据 —— 本仓库已经两次栽在"看起来显然"上
 * （`pinnedLookup` 的回调形状、`BASH_REMATCH` 的下标）。
 */
const LIVE = process.env.VANBLOG_SAFEFETCH_LIVE === '1';
/** 没给开关就**真的跳过**（不是只打一行 NOTE）：这条要出网、要真 DNS、要真证书，
 *  默认跑等于给 CI 造一个随网络抖动的红。 */
const liveIt = LIVE ? it : it.skip;

describe('活体：HTTPS + pinning（VANBLOG_SAFEFETCH_LIVE=1 才跑）', () => {
    liveIt('钉住 example.com 的真实 IP 后，TLS 握手与证书校验仍然通过', async () => {
      const dns = await import('dns');
      const addresses = await new Promise<string[]>((resolve, reject) => {
        dns.lookup('example.com', { all: true }, (err, r) =>
          err ? reject(err) : resolve((r || []).map((x) => x.address)),
        );
      });
      const pinned = pickPinnedAddress(addresses);
      expect(pinned).toBeTruthy();
      const agent = createPinnedAgent(pinned as string, true);
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = https.request(
            { host: 'example.com', port: 443, path: '/', agent, timeout: 15000 },
            (res) => {
              res.resume();
              resolve(Number(res.statusCode));
            },
          );
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.end();
        });
        // 证书是签给 example.com 的：如果 SNI 或校验被 pinning 弄坏，这里会是
        // ERR_CERT_* / 握手失败，而不是一个正常的状态码。
        expect(status).toBeGreaterThanOrEqual(200);
        expect(status).toBeLessThan(500);
      } finally {
        agent.destroy();
      }
    }, 30000);
});
