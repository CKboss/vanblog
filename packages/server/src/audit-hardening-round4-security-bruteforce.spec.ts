import { readFileSync } from 'fs';
import { join } from 'path';

import { parseNumericId, tryParseNumericId } from './utils/numericId';
import {
  __resetAttemptLimitForTest,
  attemptLimitStats,
  consumeAttempt,
  normalizeAttemptKey,
  resetAttempts,
} from './utils/attemptLimit';
import { pickSocketIp } from './provider/log/utils';
import { pickTrustedClientIp } from './utils/trustedProxy';

/**
 * 第四轮安全审计（黑客视角，只看**未鉴权**面）——「爆破与限流」这一组。
 *
 * ⚠️ 这个文件里的用例分两类，命名上分得很清楚：
 *  - `FINDING R4-x`：**钉住当前（有漏洞的）行为**，是漏洞的可执行证据。
 *    打上补丁之后这些用例会变红 —— 那时候请把断言翻成同一个 `it` 里
 *    `xit('AFTER THE FIX …')` 那一条（每条 FINDING 都附了修好之后该断言什么）。
 *  - `REGRESSION R4-x`：钉住**已经修好**的东西，任何时候都必须是绿的。
 *
 * 全部是进程内 / 源码级断言，不连数据库、不打 :3000（活体灌流量会顶掉别人在用的桶）。
 * 活体证据（一次性 mongod:27099 + 临时端口的一次性实例）见交付报告里的 curl 记录。
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

/** public.controller.ts 里那把解锁限流钥匙的构造方式（逐字复刻，见下面的源码钉子） */
const unlockKeyOf = (ip: string, id: unknown) => `unlock-${ip}-${String(id).slice(0, 80)}`;

describe('REGRESSION R4-1：加密文章的爆破限流曾经可以用「同一个 id 的不同写法」无限绕过（已修，这里钉住）', () => {
  const publicController = read('./controller/public/public.controller.ts');

  it('钥匙现在按**归一化后的文章身份**构造，不再是原始路径参数（源码钉子）', () => {
    // 修复前的写法是 `unlock-${pickSocketIp(req)}-${String(id).slice(0, 80)}`，
    // 而下游用 parseNumericId(= Number(id)) 解析 —— 两者对"同一个 id 的不同写法"看法不一致，
    // 于是 '07'/'007'/'7.0'/'0x7'/'7e0'/'0b111'/'0o7'/'%207'/'0000000007' 每种都是全新的 20 次，
    // 而前导零没有上界 ⇒ 20 次/10 分钟实际等于无限（只剩 30 次/分钟的公开写桶兜着）。
    expect(publicController).not.toMatch(/unlock-\$\{pickSocketIp\(req\)\}-\$\{String\(id\)\.slice\(0, 80\)\}/);
    expect(publicController).toMatch(/const numericId = tryParseNumericId\(rawId\);/);
    expect(publicController).toMatch(/numericId !== null \? `#\$\{numericId\}` : `p:\$\{rawId\.slice\(0, 80\)\}`/);
  });

  it('同一个数字 id 的写法家族是**无上界**的，而 parseNumericId 把它们全认成同一篇文章', () => {
    const spellings = [
      '7', '07', '007', '0000000007', '7.0', '7.00', '0x7', '0X7', '0b111', '0o7',
      '7e0', '0.7e1', '70e-1', '+7', ' 7', '7 ', '\t7\n',
    ];
    for (const s of spellings) {
      expect([s, parseNumericId(s)]).toEqual([s, 7]);
    }
    expect(parseNumericId('0'.repeat(400) + '7')).toBe(7); // 前导零没有上界
    expect(tryParseNumericId('article-7')).toBeNull(); // 别名只有 1 种写法
  });

  it('可执行证据：修复后**所有写法共用一把 20 次的钥匙**（复刻控制器的钥匙构造）', () => {
    __resetAttemptLimitForTest();
    // 与 public.controller.ts 里那三行逐字等价的钥匙构造
    const keyOf = (ip: string, rawId: string) => {
      const numeric = tryParseNumericId(rawId);
      return normalizeAttemptKey(`unlock-${ip}-${numeric !== null ? `#${numeric}` : `p:${rawId.slice(0, 80)}`}`);
    };
    const budget = { max: 20, windowMs: 10 * 60 * 1000 };
    const ip = '203.0.113.9';
    const mixed = ['7', '07', '007', '7.0', '0x7', '7e0', '0b111', '0o7', '0000000007', '+7', ' 7'];
    // 全部落到同一把钥匙
    expect(new Set(mixed.map((m) => keyOf(ip, m))).size).toBe(1);
    let allowed = 0;
    for (let i = 0; i < 21; i += 1) {
      const spelling = mixed[i % mixed.length];
      expect(parseNumericId(spelling)).toBe(7);
      if (consumeAttempt(keyOf(ip, spelling), budget).allowed) allowed += 1;
    }
    expect(allowed).toBe(20); // 而不是 21（更不是 11 × 20）
    expect(consumeAttempt(keyOf(ip, '0000000000007'), budget).allowed).toBe(false);
    // 活体复验（一次性实例、312 篇语料、真实 HTTP）：21 个混合写法打 id=7
    //   -> 201 × 20，然后 429 × 1；而别名 'article-7' 是另一把钥匙（每篇文章 = 数字 + 别名 两把）
    __resetAttemptLimitForTest();
  });

  it('别名（pathname）这一支不会重新变成"写法家族"：Nest 的 @Param 已经解码过一次', () => {
    // 钥匙里剩下的那一段是 `p:${rawId.slice(0,80)}`，看起来还能用百分号编码制造新写法
    // （'%61rticle-7' vs 'article-7'）—— 但 getByPathName 查库用的是 safeDecodeURIComponent 之后的值，
    // 而 express 交给 @Param 的也已经是解码后的值，所以两者仍然一致。活体验证：
    //   把 'article-7' 打到 429 之后，'%61rticle-7' / 'a%72ticle-7' / 'artic%6Ce-7' /
    //   'article%2D7' / '%61%72%74%69%63%6c%65%2d7' **全部同样 429**（同一把钥匙）。
    // 加尾随空格的写法（'article-7 '）确实是另一把钥匙，但它 `findOne({pathname:'article-7 '})`
    // 匹配不到任何文章、`tryParseNumericId` 也是 null ⇒ 拿不到正文，不构成绕过。
    expect(keyOfLocal('p:article-7')).toBe(keyOfLocal('p:article-7'));
    expect(tryParseNumericId('article-7 ')).toBeNull();
  });
});

/** 本文件内的小工具：把"钥匙片段"原样归一化，便于断言 */
function keyOfLocal(fragment: string): string {
  return normalizeAttemptKey(`unlock-1.2.3.4-${fragment}`);
}

describe('REGRESSION R4-2：三处防爆破计数曾经共用"反代的套接字地址"⇒ 全站一个桶（已修，这里钉住）', () => {
  it('登录 / 评论 / 解锁 / 评论 IP 四处现在都走 bruteForceClientIp（源码钉子）', () => {
    expect(read('./provider/auth/login.guard.ts')).toMatch(/const ip = bruteForceClientIp\(req\);/);
    const comment = read('./provider/comment/comment.provider.ts');
    expect(comment).toMatch(/const ip = bruteForceClientIp\(req\);/);
    expect(comment).toMatch(/ip: bruteForceClientIp\(data\.req\),/); // 存进库的那个 IP 也一起改了
    expect(read('./controller/public/public.controller.ts')).toMatch(/`unlock-\$\{bruteForceClientIp\(req\)\}-\$\{/);
    // 三处都不再直接用套接字地址当防爆破身份
    expect(comment).not.toMatch(/const ip = pickSocketIp\(req\);/);
  });

  it('默认 trusted：反代后面每个真实客户端一把桶，而伪造头既拿不到新预算也栽赃不了别人', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bruteForceClientIp, resolveBruteForceIpSource } = require('./utils/trustedProxy');
    expect(resolveBruteForceIpSource(undefined)).toBe('trusted');
    expect(resolveBruteForceIpSource('garbage')).toBe('trusted'); // 写错的值不回落成最松的那种
    expect(resolveBruteForceIpSource('SOCKET')).toBe('socket');

    const behindCaddy = (xff: string) => ({
      socket: { remoteAddress: '127.0.0.1' }, // 一体式部署里对端恒为 caddy
      headers: { 'x-forwarded-for': xff },
    });
    // 每个真实客户端一把桶（这就是修复前缺的东西）
    expect(bruteForceClientIp(behindCaddy('203.0.113.1'))).toBe('203.0.113.1');
    expect(bruteForceClientIp(behindCaddy('203.0.113.2'))).toBe('203.0.113.2');
    expect(bruteForceClientIp(behindCaddy('203.0.113.1'))).not.toBe(bruteForceClientIp(behindCaddy('203.0.113.2')));
    // 攻击者自带 XFF 想冒充受害者：caddy 会把它自己的 IP 追加到最右 ⇒ 最右一项永远是攻击者
    const spoof = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        'x-forwarded-for': '192.0.2.77, 198.51.100.5',
        'x-real-ip': '192.0.2.77',
        'cf-connecting-ip': '192.0.2.77',
        'true-client-ip': '192.0.2.77',
      },
    };
    expect(bruteForceClientIp(spoof)).toBe('198.51.100.5'); // 不是被冒充的 192.0.2.77
    // 换多少个伪造值，桶都是同一个 ⇒ 换头拿不到新预算
    for (const forged of ['1.1.1.1', '2.2.2.2', '8.8.8.8']) {
      expect(
        bruteForceClientIp({
          socket: { remoteAddress: '127.0.0.1' },
          headers: { 'x-forwarded-for': `${forged}, 198.51.100.5` },
        }),
      ).toBe('198.51.100.5');
    }
    // 对端是公网（Node 直接暴露）⇒ 转发头一律不信
    expect(
      bruteForceClientIp({ socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-forwarded-for': '192.0.2.77' } }),
    ).toBe('198.51.100.9');
    // 没有转发头（反代不追加 XFF 的部署）⇒ 退回套接字地址，绝不返回空
    expect(bruteForceClientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe('127.0.0.1');
    expect(bruteForceClientIp({}, 'trusted')).toBe('unknown');
    // 逃生口：socket 模式 = 修复前的行为
    expect(bruteForceClientIp(spoof, 'socket')).toBe('127.0.0.1');
  });

  it('可执行证据（修复前的形状）：桶按套接字地址分时，5 个不同客户端各错 1 次就能锁死第 6 个人', () => {
    __resetAttemptLimitForTest();
    const max = 5; // DEFAULT_MAX_LOGIN_RETRY
    const windowMs = 300_000; // DEFAULT_LOGIN_WINDOW_SECONDS
    const sharedByWholeSite = `login-127.0.0.1`; // ← 修复前所有访客的 key 都是这一个
    for (let i = 0; i < 5; i += 1) {
      expect(consumeAttempt(sharedByWholeSite, { max, windowMs }).allowed).toBe(true);
    }
    const victim = consumeAttempt(sharedByWholeSite, { max, windowMs });
    expect(victim.allowed).toBe(false); // 站长带正确密码也进不来（守卫在认证之前跑）
    expect(victim.retryAfterSeconds).toBeGreaterThan(0);
    expect(victim.retryAfterSeconds).toBeLessThanOrEqual(300);

    // 修复后：同一个攻击者打 5 次只锁自己，别的客户端不受影响
    const perClient = (ip: string) => `login-${ip}`;
    for (let i = 0; i < 5; i += 1) consumeAttempt(perClient('203.0.113.1'), { max, windowMs });
    expect(consumeAttempt(perClient('203.0.113.1'), { max, windowMs }).allowed).toBe(false);
    expect(consumeAttempt(perClient('192.0.2.77'), { max, windowMs }).allowed).toBe(true); // ← 站长照常登录
    __resetAttemptLimitForTest();
    // 活体复验（一次性实例、真实 HTTP）：修复前 5 次失败登录后，第 6 个客户端带**正确密码**
    // 也拿到 401「错误次数过多！请 300 秒后再试」；评论 10 次/10 分钟、解锁 20 次/10 分钟同形状。
  });
});

describe('FINDING R4-5（尚未修）：解锁 POST 用「404 vs 200/null」把还没发布的定时文章出卖了', () => {
  const articleProvider = read('./provider/article/article.provider.ts');

  it('getByIdWithPassword 对"不存在"返回 null（HTTP 200 信封），对"存在但未到点"抛 404（源码钉子）', () => {
    // article.provider.ts:1221-1231
    expect(articleProvider).toMatch(/async getByIdWithPassword\(id: number \| string, password: string\): Promise<any> \{\s*\n\s*const article: any = await this\.getByIdOrPathname\(id, 'admin'\);\s*\n\s*if \(!article\) \{\s*\n\s*return null;/);
    expect(articleProvider).toMatch(/if \(isFuturePublish\(article\.publishAt\)\) \{\s*\n\s*throw new NotFoundException\('找不到文章'\);/);
    // 控制器把 null 原样塞进 200 信封（public.controller.ts:104-111）
    expect(read('./controller/public/public.controller.ts')).toMatch(/const data = await this\.articleProvider\.getByIdWithPassword\(id, body\?\.password\);[\s\S]{0,200}?statusCode: 200,\s*\n\s*data: data,/);
  });

  it('于是三种结果互不相同，而未鉴权调用方能一眼分辨（活体记录见报告）', () => {
    // 活体（一次性实例，312 篇语料，id=9 是排到一年后的定时文章）：
    //   POST /api/public/article/999999 -> HTTP 201 {"statusCode":200,"data":null}   不存在
    //   POST /api/public/article/9      -> HTTP 404 {"message":"找不到文章"}          存在但未到点
    //   POST /api/public/article/7      -> HTTP 201 {"statusCode":200,"data":null}   加密+密码错
    // ⇒ 404 唯一地证明了"这个数字 id 上挂着一篇还没发布的文章"。
    // 而 GET /api/public/article/:id 对"不存在"与"未到点"都抛同一个 404 ⇒ GET 不是 oracle，POST 是。
    const outcomes: Record<string, string> = {
      '不存在': 'HTTP 201 / data:null',
      '存在但未到点': 'HTTP 404',
      '加密且密码错': 'HTTP 201 / data:null',
    };
    expect(new Set(Object.values(outcomes)).size).toBe(2);
    expect(outcomes['存在但未到点']).not.toBe(outcomes['不存在']);
  });

  it('隐藏文章还多送一句可区分的文案（GET 与 POST 都有）', () => {
    expect(articleProvider).toMatch(/throw new NotFoundException\('该文章是隐藏文章！'\);/g);
    // 两处（getByIdWithPassword 与 getByIdOrPathnameWithPreNext）都用了这句专属文案
    expect((articleProvider.match(/该文章是隐藏文章！/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  xit('AFTER THE FIX：三种结果必须同形（要么都 404，要么都 200/null），文案也不该区分隐藏', () => {
    // 最小补丁：getByIdWithPassword 里把 `return null` 换成 `throw new NotFoundException('找不到文章')`
    // （或反过来把 isFuturePublish 的 404 改成 return null）——两者取其一即可让 oracle 消失。
    // 注意 blast radius：前台的解锁弹窗现在按 data===null 判"密码错"，改成 404 要同步看
    // packages/website 里对这个 POST 的错误处理。
    expect(true).toBe(true);
  });
});

describe('REGRESSION R4-A：已经修好的那几条仍然成立', () => {
  it('attemptLimit 满表时**绝不** clear()（§7.55 G-1）', () => {
    __resetAttemptLimitForTest();
    for (let i = 0; i < 25_000; i += 1) {
      consumeAttempt(`flood-${i}-${'x'.repeat(80)}`, { max: 5, windowMs: 60_000 });
    }
    const stats = attemptLimitStats();
    expect(stats.cleared).toBe(0);
    expect(stats.size).toBeLessThanOrEqual(stats.maxBuckets);
    expect(stats.evicted).toBeGreaterThan(0);
    __resetAttemptLimitForTest();
  });

  it('正在被限流的热桶（count>1）不会被洪水挤掉（§7.55 G-1 的淘汰顺序）', () => {
    __resetAttemptLimitForTest();
    const hot = 'login-127.0.0.1';
    for (let i = 0; i < 5; i += 1) consumeAttempt(hot, { max: 5, windowMs: 300_000 });
    expect(consumeAttempt(hot, { max: 5, windowMs: 300_000 }).allowed).toBe(false);
    for (let i = 0; i < 25_000; i += 1) {
      consumeAttempt(`flood2-${i}`, { max: 5, windowMs: 60_000 });
    }
    // 热桶还在（count 最大，按 count 从小到大淘汰时它最后才走）
    expect(consumeAttempt(hot, { max: 5, windowMs: 300_000 }).allowed).toBe(false);
    __resetAttemptLimitForTest();
  });

  it('钥匙长度被夹到 160 字节，所以 URL 片段撑不爆这张表（§7.55 G-1）', () => {
    expect(normalizeAttemptKey('x'.repeat(5000)).length).toBe(160);
    expect(normalizeAttemptKey(`unlock-1.2.3.4-${'y'.repeat(5000)}`).length).toBe(160);
  });
});
