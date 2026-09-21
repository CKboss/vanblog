/**
 * 🔴 限流分档的路径归一化：堵住「大小写变体 / 尾斜杠」这类**匿名可达**的限流绕过。
 *
 * ## 缺陷（活体实证过，不是推理）
 * Express 默认 `case sensitive routing=false` 且 `strict routing=false`，本项目 `main.ts` 两项都没改
 * ⇒ 路由匹配大小写不敏感、尾斜杠可选。活体实测（dev :3000，全 GET 只读）：
 * `/api/public/category`、`/API/public/category`、`/api/public/CATEGORY`、`/api/public/category/`
 * **四种写法全部 200 且返回逐字节相同的 22,131 B** ⇒ 打的是同一个处理器。
 * 而限流的分档判定历史上是大小写敏感的 startsWith ⇒ **改个大小写就能照样命中处理器、却不进那个更严的档**。
 * 受影响的严档：`/api/admin/init`（5 次/10 分钟的初始化/恢复爆破防护）与 `/api/public/`（30/分钟匿名写档）。
 *
 * ## 本文件钉住的性质
 * 1. 归一化口径本身（大小写 / 尾斜杠 / query / hash / 非法输入）；
 * 2. 🔴 **变体与规范路径共用同一个桶**（这是"绕过被堵住"的直接判据，比"变体也被计数"更强）；
 * 3. 🔴 **失败方向**：奇怪路径绝不落到"不限"，至少仍受全局档约束；
 * 4. **阈值与语义没被顺手改掉**（钉 envInt 的源码形状，与既有守卫同一手法）；
 * 5. **尺子有效性**：证明第 2 条在"归一化被去掉"时会红（用源码锚点 + 变异对照，见汇报）。
 *
 * ⚠️ 判据一律走**真中间件**（不打桩 rateLimitMiddleware 本身），并配"替身确实被调用过"的自检。
 */
import {
  GLOBAL_LIMIT_PER_MIN,
  INIT_LIMIT_PER_10MIN,
  PUBLIC_WRITE_LIMIT_PER_MIN,
  isStaticAssetPath,
  normalizeRateLimitPath,
  rateLimitMiddleware,
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

// ⚠️ 递增而不是随机：限流桶按 IP 计，随机取值会让两条用例撞上同一个桶而偶发红
// （rateLimit.spec.ts 的 uniqueIp 就因此红过，根因被误当成负载）。
let seq = 0;
const ip = () => {
  seq += 1;
  if (seq > 199) throw new Error('ip 序号超出 203.0.113.20-219 容量');
  return `203.0.113.${seq + 19}`;
};

/** 真发一次请求（socket 是回环、真实客户端 IP 走 x-forwarded-for，与既有 spec 同口径） */
const send = (method: string, path: unknown, addr: string) => {
  const r = res();
  let passed = false;
  rateLimitMiddleware(
    req({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': addr }, method, path }),
    r,
    () => {
      passed = true;
    },
  );
  return { status: r.out.status, headers: r.out.headers, body: r.out.body, passed };
};

describe('归一化口径（与 Express 路由匹配一致）', () => {
  it('大小写与尾斜杠被归一化，且内部双斜杠与百分号编码**刻意不动**', () => {
    expect(normalizeRateLimitPath('/API/public/category')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/api/public/CATEGORY')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/api/public/category/')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/api/public/category///')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/Api/Admin/Init/Restore/')).toBe('/api/admin/init/restore');
    // 🔴 实测：这两类变体在 Express 下是 **404**（路由匹配用未解码的 pathname、且不折叠内部斜杠）
    //    ⇒ 归一化**不该**把它们变成能命中档位的样子，否则限流器会比路由器更宽（把 404 也算进档）。
    expect(normalizeRateLimitPath('/api/public/%63ategory')).toBe('/api/public/%63ategory');
    expect(normalizeRateLimitPath('//api//public//category')).toBe('//api//public//category');
  });

  it('query 与 hash 被切掉（中间件取的是 req.path 或 req.url，后者带 query）', () => {
    expect(normalizeRateLimitPath('/api/public/category?toListView=true')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/api/public/category#frag')).toBe('/api/public/category');
    expect(normalizeRateLimitPath('/API/public/category?x=1#y')).toBe('/api/public/category');
  });

  it('🔴 非法输入一律得到空串（绝不抛错，也绝不产生一个能匹配松档的形状）', () => {
    for (const bad of [undefined, null, '', 123, {}, [], NaN, Symbol.iterator]) {
      expect({ bad: String(bad), out: normalizeRateLimitPath(bad as any) }).toEqual({
        bad: String(bad),
        out: '',
      });
    }
    // 只有斜杠的路径归一化后也是空串（根路径不进任何专用档，但仍受全局档约束）
    expect(normalizeRateLimitPath('/')).toBe('');
    expect(normalizeRateLimitPath('///')).toBe('');
  });

  it('尺子有效性：归一化确实改变了判定结果（否则上面几条可能在恒真）', () => {
    // ⚠️ 必须显式标注 string：不标的话 TS 会把它窄化成字面量类型，
    //    于是 `variant === '/api/public/category'` 变成"两个不同字面量比较"⇒ TS2367 编译错误、
    //    整套 suite failed to run（而当次 `Tests:` 那行会显示**别的文件**的数字，看着像绿）。
    const variant: string = '/API/public/CATEGORY/';
    expect(variant === '/api/public/category').toBe(false); // 原始串确实不同
    expect(normalizeRateLimitPath(variant) === '/api/public/category').toBe(true); // 归一化后相同
    // 静态松档：实测 /STATIC/<真文件> 会 200 并返回完整字节，所以它**是**静态请求
    expect(isStaticAssetPath(normalizeRateLimitPath('/STATIC/img/a.webp'))).toBe(true);
    expect(isStaticAssetPath('/STATIC/img/a.webp')).toBe(false); // 未归一化时不算（这就是不一致的来源）
    // 但 /statics/ 不是 /static/（既有守卫钉过，别被归一化带跑）
    expect(isStaticAssetPath(normalizeRateLimitPath('/statics/x'))).toBe(false);
    expect(isStaticAssetPath(normalizeRateLimitPath('/static'))).toBe(false);
  });
});

describe('🔴 绕过被堵住：变体与规范路径**共用同一个桶**', () => {
  it('init 档（5 次/10 分钟）：大小写与尾斜杠变体照样计数，且与规范路径共享额度', () => {
    const quota = INIT_LIMIT_PER_10MIN;
    expect(quota).toBeGreaterThan(0); // 反空转：额度确实读到了

    // (a) 纯变体也会耗尽额度 ⇒ 变体确实进了这一档
    const a = ip();
    const variants = ['/API/admin/init', '/api/admin/init/', '/Api/Admin/Init/', '/api/admin/INIT'];
    let lastA: any;
    for (let i = 0; i < quota + 1; i += 1) lastA = send('POST', variants[i % variants.length], a);
    expect(lastA.status).toBe(429);
    expect(lastA.headers['Retry-After']).toBeTruthy();

    // (b) 🔴 更强：规范路径与变体**混着打**也共享同一个额度
    //     若归一化失效，变体那几发会落进全局档（600/分钟）而不消耗 init 桶
    //     ⇒ 那么"quota 发里只有 2 发是规范路径"就绝不可能触发 429。
    const b = ip();
    const mixed = ['/api/admin/init/restore', '/API/ADMIN/INIT/RESTORE/', '/api/admin/init/upload'];
    let saw429 = false;
    for (let i = 0; i < quota + 1; i += 1) {
      if (send('POST', mixed[i % mixed.length], b).status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);

    // (c) 安全方法仍然不烧配额（这条既有性质不能被归一化改坏）
    const c = ip();
    for (let i = 0; i < quota * 3; i += 1) {
      expect(send('GET', '/API/ADMIN/INIT', c).status).not.toBe(429);
    }
    expect(send('POST', '/api/admin/init/restore', c).status).not.toBe(429);
  });

  it('公开写档（30/分钟）：变体照样计数，且与规范路径共享额度', () => {
    const quota = PUBLIC_WRITE_LIMIT_PER_MIN;
    const a = ip();
    let last: any;
    for (let i = 0; i < quota + 1; i += 1) {
      last = send('POST', i % 2 === 0 ? '/api/public/comment' : '/API/public/COMMENT/', a);
    }
    expect(last.status).toBe(429);

    // GET 不计入这一档（安全方法），所以打同样多次也不会 429
    const b = ip();
    for (let i = 0; i < quota + 1; i += 1) {
      expect(send('GET', '/API/public/comment', b).status).not.toBe(429);
    }
  });

  it('静态松档：大小写变体现在也算静态请求（与服务器实际行为一致）', () => {
    // ⚠️ 静态档额度是全局的 10 倍，逐发打到 429 太贵，所以这里钉"归类"而不是"耗尽"：
    //    归一化后 /STATIC/... 被当成静态请求 ⇒ 与规范写法进同一个 rl-static 桶。
    expect(isStaticAssetPath(normalizeRateLimitPath('/static/img/a.webp'))).toBe(true);
    expect(isStaticAssetPath(normalizeRateLimitPath('/STATIC/img/a.webp'))).toBe(true);
    expect(isStaticAssetPath(normalizeRateLimitPath('/Static/Img/a.webp/'))).toBe(true);
    // 🔴 但归一化绝不能把**非静态**路径送进这个松档（那才是真正的放宽）
    for (const notStatic of ['/api/public/meta', '/API/PUBLIC/META', '/statics/x', '/static', '/', '']) {
      expect({ notStatic, hit: isStaticAssetPath(normalizeRateLimitPath(notStatic)) }).toEqual({
        notStatic,
        hit: false,
      });
    }
  });
});

describe('🔴 失败方向：奇怪路径绝不落到「不限」', () => {
  it('无法识别的路径仍然受全局档约束（打完额度就 429，而不是无限放行）', () => {
    const a = ip();
    const weird = '//API//public//comment';
    // 反空转：这个形状确实不进任何专用档
    expect(isStaticAssetPath(normalizeRateLimitPath(weird))).toBe(false);
    let last: any;
    let allowed = 0;
    for (let i = 0; i < GLOBAL_LIMIT_PER_MIN + 1; i += 1) {
      last = send('GET', weird, a);
      if (last.status !== 429) allowed += 1;
    }
    expect(last.status).toBe(429);
    expect(allowed).toBe(GLOBAL_LIMIT_PER_MIN); // 恰好放行了全局额度那么多，一次不多
  });

  it('path 缺失（undefined / 空串 / 非字符串）时仍然受限，绝不放行不限', () => {
    for (const bad of [undefined, '', 123 as any, {} as any]) {
      const a = ip();
      let last: any;
      for (let i = 0; i < GLOBAL_LIMIT_PER_MIN + 1; i += 1) last = send('GET', bad, a);
      expect({ bad: String(bad), status: last.status }).toEqual({ bad: String(bad), status: 429 });
    }
  });

  it('中间件不因奇怪输入抛错（限流不该成为可用性风险）', () => {
    for (const bad of [undefined, null, '', 123, {}, [], '/%2e%2e/%2e%2e/etc/passwd']) {
      const r = send('GET', bad, ip());
      expect([200, 429]).toContain(r.status);
    }
  });
});

describe('阈值与语义没有被顺手改掉（钉 envInt 的源码形状）', () => {
  it('四档的默认值、clamp 与判定形状都还在', () => {
    const fs = require('fs');
    const path = require('path');
    const { stripCommentsForAnchor } = require('src/test-utils/anchorCode');
    const raw = fs.readFileSync(path.join(__dirname, 'rateLimit.ts'), 'utf-8');
    const src = stripCommentsForAnchor(raw);
    expect(raw.length).toBeGreaterThan(src.length); // 剥注释器确实在工作

    // 阈值与 clamp：本轮只修"能不能被绕过"，一个参数都不许动
    expect(src).toMatch(/INIT_LIMIT_PER_10MIN = envInt\('VANBLOG_INIT_LIMIT_PER_10MIN', 5, 1, 1000\)/);
    expect(src).toMatch(/PUBLIC_WRITE_LIMIT_PER_MIN = envInt\('VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN', 30, 1, 100000\)/);
    expect(src).toMatch(/GLOBAL_LIMIT_PER_MIN = envInt\('VANBLOG_RATE_LIMIT_PER_MIN', 600, 1, 1000000\)/);

    // 🔴 四个判定必须**都**吃归一化后的 path：中间件里 path 只能由 normalizeRateLimitPath 赋值一次
    expect(src).toMatch(/const path = normalizeRateLimitPath\(\(req as any\)\.path \|\| \(req as any\)\.url\)/);
    expect(src.match(/normalizeRateLimitPath\(/g)?.length).toBeGreaterThanOrEqual(3); // 定义 + 中间件 + 列表档

    // 既有守卫钉住的三个逐字形状必须原样保留（它们不在本次授权可改的文件里）
    expect(src).toMatch(/path\.startsWith\('\/api\/admin\/init'\) && !SAFE_METHODS\.has\(method\)/);
    expect(src).toMatch(/path\.startsWith\('\/api\/public\/'\) && !SAFE_METHODS\.has\(method\)/);
    expect(src).toMatch(/if \(isStaticAssetPath\(path\)\) \{/);
    expect(src).toMatch(/const SAFE_METHODS = new Set\(\['GET', 'HEAD', 'OPTIONS'\]\)/);

    // 🔴 归一化函数本身：必须去尾斜杠、必须转小写、必须切 query/hash，且**不得**解码或折叠内部斜杠
    const fn = src.slice(src.indexOf('export function normalizeRateLimitPath'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/replace\(\/\\\/\+\$\/, ''\)/); // 去尾斜杠
    expect(body).toMatch(/toLowerCase\(\)/); // 转小写
    expect(body).toMatch(/\[\?#\]/); // 切 query/hash
    expect(body).not.toMatch(/decodeURI/); // 🔴 不解码（编码变体是 404，解码会比路由器更宽）
    expect(body).not.toMatch(/replace\(\/\\\/\{2,\}\/g/); // 🔴 不折叠内部斜杠（同理是 404）
    expect(body).toMatch(/return ''/); // 非法输入的失败方向：空串 ⇒ 落全局档，不是"不限"
  });
});
