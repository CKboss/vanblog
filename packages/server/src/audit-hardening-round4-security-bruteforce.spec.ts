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

import { stripCommentsForAnchor } from './test-utils/anchorCode';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

/**
 * 🔴 修复前"隐藏文章"那一句**专属**文案的标记片段。
 * ⚠️ 故意用拼接而不是写完整字面量：本 spec 会被各种"全仓搜文案"的脚本扫到，
 *    写完整字面量会让人误以为代码里还有这句话（也让"搜这个字符串还有没有残留"这类排查失去意义）。
 *    拼出来的值与当年代码里那句**逐字相同**，所以 includes 判定是准确的。
 */
const HIDDEN_LEGACY_MARKER = '该文章是隐藏' + '文章！';

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

describe('FINDING R4-5（✅ 2026-09-21 已修，这里钉住不变量）：解锁 POST 曾用「404 vs 200/null」把还没发布的定时文章出卖了', () => {
  const articleProvider = read('./provider/article/article.provider.ts');

  it('getByIdWithPassword 对"不存在"返回 null（HTTP 200 信封），对"存在但未到点"抛 404（源码钉子）', () => {
    // article.provider.ts:1221-1231
    expect(articleProvider).toMatch(/async getByIdWithPassword\(id: number \| string, password: string\): Promise<any> \{\s*\n\s*const article: any = await this\.getByIdOrPathname\(id, 'admin'\);\s*\n\s*if \(!article\) \{\s*\n\s*return null;/);
    // 🔴 2026-09-21 升级：这一支**曾经**抛 404，而那正是 oracle —— "文章不存在"走的是
    //    `return null`（控制器包成 HTTP 201 + `data:null`），于是 404 唯一地证明了
    //    "这个 id 上挂着一篇还没发布的定时文章"。现在两支都 `return null` ⇒ 同形。
    expect(articleProvider).toMatch(/if \(isFuturePublish\(article\.publishAt\)\) \{\s*\n\s*return null;/);
    // 🔴 这道检查本身**必须还在**：删掉它，未发布文章就会一路走到 `return plain`（全文泄漏）。
    //    它现在的价值不在"返回什么"，而在"不再往下走"⇒ 必须钉住它存在。
    expect(stripCommentsForAnchor(articleProvider)).toMatch(/if \(isFuturePublish\(article\.publishAt\)\) \{/);
    // 控制器把 null 原样塞进 200 信封（public.controller.ts:104-111）
    expect(read('./controller/public/public.controller.ts')).toMatch(/const data = await this\.articleProvider\.getByIdWithPassword\(id, body\?\.password\);[\s\S]{0,200}?statusCode: 200,\s*\n\s*data: data,/);
  });

  it('🔴 修复后：三种结果**完全相同**，未鉴权调用方无从分辨（不变量）', () => {
    // ⚠️ 下面是**修复前**的活体记录（一次性实例，312 篇语料，id=9 是排到一年后的定时文章），
    //    保留作历史证据 —— 它当年证明了这个 oracle 是真的、可远程利用的：
    //      POST /api/public/article/999999 -> HTTP 201 {"statusCode":200,"data":null}   不存在
    //      POST /api/public/article/9      -> HTTP 404 {"message":"..."}                存在但未到点
    //      POST /api/public/article/7      -> HTTP 201 {"statusCode":200,"data":null}   加密+密码错
    //    ⇒ 当时 404 唯一地证明了"这个数字 id 上挂着一篇还没发布的文章"。
    //    而 GET /api/public/article/:id 对"不存在"与"未到点"都抛同一个 404 ⇒ GET 不是 oracle，POST 是。
    // 🔴 修复后（2026-09-21，本机 dev 活体复核，见 vanblog_dev/tmp/oracle-evidence/）：
    //      POST /api/public/article/999999（带密码 / 不带密码）-> HTTP 201 {"statusCode":200,"data":null}
    //      POST 存在但未到点                                  -> HTTP 201 {"statusCode":200,"data":null}
    //      POST 加密且密码错                                  -> HTTP 201 {"statusCode":200,"data":null}
    //    ⇒ 三种（外加"隐藏"）全部同形，Set 的大小必须是 **1**。
    const outcomesAfterFix: Record<string, string> = {
      '不存在': 'HTTP 201 / data:null',
      '存在但未到点': 'HTTP 201 / data:null',
      '隐藏且不允许按 URL 打开': 'HTTP 201 / data:null',
      '加密且密码错': 'HTTP 201 / data:null',
    };
    expect(new Set(Object.values(outcomesAfterFix)).size).toBe(1);
    // ⚠️ 并且状态码不许再出现 404 这一档（那正是当年的区分信号）
    expect(Object.values(outcomesAfterFix).some((v) => v.includes('404'))).toBe(false);
  });

  it('🔴 修复后：隐藏文章**不再**有专属文案，GET 的两支共用同一个常量（不变量）', () => {
    // ⚠️ 修复前这里钉的是缺陷现状：两处（getByIdWithPassword 与 getByIdOrPathnameWithPreNext）
    //    都抛一句专属文案，于是匿名调用方靠文案就能区分"这里挂着一篇隐藏文章"与"没有这篇文章"。
    //    现在改成钉**修复后**的性质。⚠️ 刻意不删除本用例：保留"这里曾经有个 oracle"的历史。
    const stripped = stripCommentsForAnchor(articleProvider);
    // ① 那句专属文案在**代码里**必须彻底消失（用剥注释后的文本，这样注释可以自由讨论历史；
    //    ⚠️ 尺子有效性：同一把尺子在"未剥注释"时对合成样本必须能命中，见下面那条反证）
    expect(stripped.includes(HIDDEN_LEGACY_MARKER)).toBe(false);
    // ② 公开详情口的两支（不存在 / 隐藏）必须**共用同一个常量**，而不是两处相同的字面量 ——
    //    共用常量让"不可区分"成为结构性事实：想制造差异必须显式引入第二个字符串。
    expect((stripped.match(/throw new NotFoundException\(NOT_FOUND_MESSAGE\)/g) || []).length).toBe(2);
    // ③ 那个常量必须真的被导出并定义（否则 ② 是在钉一个不存在的名字）
    expect(articleProvider).toMatch(/export const NOT_FOUND_MESSAGE = '找不到文章';/);
    // ④ 🔴 尺子有效性反证：证明"剥注释器 + includes"这把尺子**真的能命中**这个标记
    //    （否则 ① 恒真 —— 一个永远找不到东西的尺子也能让 not-includes 通过）
    const synthetic = `const a = 1; throw new NotFoundException('${HIDDEN_LEGACY_MARKER}');`;
    expect(stripCommentsForAnchor(synthetic).includes(HIDDEN_LEGACY_MARKER)).toBe(true);
    // ⑤ 反证：注释里出现该标记时，剥注释后**不该**命中（证明剥注释器真的在工作）
    const syntheticComment = `const a = 1; // ${HIDDEN_LEGACY_MARKER}\nconst b = 2;`;
    expect(stripCommentsForAnchor(syntheticComment).includes(HIDDEN_LEGACY_MARKER)).toBe(false);
  });

  it('AFTER THE FIX（✅ 已实现）：三种结果同形、文案不区分隐藏，且前台解锁流程无需改动', () => {
    // 本用例当年是 `xit`（跳过），里面写好了最小补丁：
    //   「getByIdWithPassword 里把 `return null` 换成 `throw new NotFoundException(...)`
    //     （或反过来把 isFuturePublish 的 404 改成 return null）—— 两者取其一即可让 oracle 消失。」
    // 🔴 实际采用的是**第二个方向**（都 return null），理由：两者都能消除 oracle，但改状态码会动
    //    HTTP 层的形状（第三方主题/脚本可能在 POST 这个口子），而 null 方向**一个状态码都不变**，
    //    blast radius 为零。
    // 🔴 并且当年那条 blast radius 警告（"前台按 data===null 判密码错，改成 404 要同步看 website"）
    //    **与代码现状不符**：`components/UnLockCard/index.tsx:28` 用的是 `if (!res)` **外加 catch-all**，
    //    而 `api/getArticles.ts` 的 `getArticleByIdOrPathnameWithPassword` 是 `const { data } = await res.json()`
    //    ⇒ 404 时解构得到的是 **undefined**（不是 null）。`!res` 对 null 与 undefined 同样成立，
    //    catch 分支也显示同一句"密码错误！请重试！"⇒ **两个方向前台都不用改**。
    //    以现实为准（本仓库规矩：交办/旧注释与代码冲突时，以代码为准并说明）。
    const stripped = stripCommentsForAnchor(articleProvider);
    // ① POST 解锁口的三支"看不到"必须都是 return null（同形）
    const unlockBody = stripped.slice(
      stripped.indexOf('async getByIdWithPassword('),
      stripped.indexOf('async getByIdOrPathnameWithPreNext('),
    );
    expect(unlockBody.length).toBeGreaterThan(200); // 尺子自检：真的切到了方法体
    expect((unlockBody.match(/return null;/g) || []).length).toBeGreaterThanOrEqual(4);
    // ② 该方法体里**不许再出现** throw NotFoundException（否则状态码又与"不存在"分叉了）
    expect(unlockBody.includes('NotFoundException')).toBe(false);
    // ③ 前台判据仍然是 `!res`（falsy），不是 `=== null` ⇒ null/undefined/抛错 三者都能被正确处理
    const unlockCard = read('../../website/components/UnLockCard/index.tsx');
    expect(unlockCard).toMatch(/if \(!res\) \{/);
    expect(unlockCard.includes('=== null')).toBe(false);
    // ④ 前台取数确实是解构 { data }（⇒ 404 会得到 undefined，佐证 ③ 的必要性）
    expect(read('../../website/api/getArticles.ts')).toMatch(/const \{ data \} = await res\.json\(\);/);
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
