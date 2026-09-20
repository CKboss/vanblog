import { HttpStatus, PayloadTooLargeException } from '@nestjs/common';
import {
  DEFAULT_SANITIZE_MAX_NODES,
  SanitizeBudgetError,
  SanitizeBodyPipe,
  isSanitizeBudgetError,
  resolveSanitizeMaxNodes,
  sanitizeBudgetMessage,
  sanitizeRequestPayloads,
  stripOperatorKeys,
} from './sanitizeRequest';

/**
 * 净化成本上界（`VANBLOG_SANITIZE_MAX_NODES`）。
 *
 * 为什么值得单独一个文件：净化的中间件跑在**限流器与鉴权之前**
 * （顺序是 `[json][sanitize][static403]…[rateLimit][init][router]`），而四个大限额解析器只按
 * **路径**挂、不看身份 ⇒ 匿名请求就能让服务器解析并递归净化一个 50MB 的 JSON。实测最省字节的
 * 形状约 96,335 键/MB、净化 ≈ 91 ms/MB 且严格线性 ⇒ 50MB ≈ **7.5 秒同步阻塞**；默认单 worker 下
 * 约 8 个这种请求/分钟就能让事件循环 100% 忙，前台 SSR 与健康检查全部假死，而容器仍是 Up、
 * `restart` 不介入。被限流 429 挡下的请求**同样已经把 CPU 烧完了**。
 *
 * ⚠️ 这些断言全部是**行为级**的：真的构造超限输入、真的看响应码与 `next()` 有没有被调用。
 * 只 grep 源码里有没有 413 分支是**空断言** —— 把判定写成 `if (false && …)` 子串仍然匹配，
 * 本仓库本轮已经有两条守卫因此空转。
 */

function buildRes() {
  const sent: { status?: number; body?: any } = {};
  const headers = new Set<string>();
  const res: any = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: any) {
      sent.body = body;
      return res;
    },
    setHeader(k: string) {
      headers.add(k);
    },
  };
  return { res, sent, headers };
}

/** 构造"键极多、值极短"的形状 —— 这正是把递归净化成本放到最大的输入。 */
function wideBody(keys: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < keys; i += 1) {
    out[`k${i}`] = i;
  }
  return out;
}

describe('净化成本上界：环境变量解析', () => {
  it('缺失与垃圾值一律回落默认（绝不会变成"不限"）', () => {
    expect(resolveSanitizeMaxNodes(undefined)).toBe(DEFAULT_SANITIZE_MAX_NODES);
    expect(resolveSanitizeMaxNodes('')).toBe(DEFAULT_SANITIZE_MAX_NODES);
    expect(resolveSanitizeMaxNodes('abc')).toBe(DEFAULT_SANITIZE_MAX_NODES);
    expect(resolveSanitizeMaxNodes('1e6')).toBe(DEFAULT_SANITIZE_MAX_NODES);
    expect(resolveSanitizeMaxNodes('-5')).toBe(DEFAULT_SANITIZE_MAX_NODES);
    expect(resolveSanitizeMaxNodes(null)).toBe(DEFAULT_SANITIZE_MAX_NODES);
  });

  it('0 不是"关闭检查"，而是夹到下限 1000', () => {
    expect(resolveSanitizeMaxNodes('0')).toBe(1000);
    expect(resolveSanitizeMaxNodes('7')).toBe(1000);
  });

  it('合法值照用，超大值夹到 5,000,000', () => {
    expect(resolveSanitizeMaxNodes('2000')).toBe(2000);
    expect(resolveSanitizeMaxNodes('999999999')).toBe(5_000_000);
  });

  it('消息里提到的变量名与常量一致（否则会指向一个不存在的旋钮）', () => {
    expect(sanitizeBudgetMessage(50000)).toContain('VANBLOG_SANITIZE_MAX_NODES');
    expect(sanitizeBudgetMessage(50000)).toContain('50000');
    // 可照做：必须告诉用户"合法的大正文不受影响"与"该走哪条通道"
    expect(sanitizeBudgetMessage(50000)).toContain('导入');
  });
});

describe('净化成本上界：stripOperatorKeys 的行为', () => {
  it('正常 body 原样保留，$ 键与原型键仍被删掉', () => {
    const input = { title: 'ok', $where: 'evil', nested: { a: 1, $ne: 2 }, __proto__: { x: 1 } };
    const out = stripOperatorKeys(JSON.parse(JSON.stringify(input)));
    expect(out.title).toBe('ok');
    expect(out.$where).toBeUndefined();
    expect(out.nested).toEqual({ a: 1 });
  });

  it('超过预算就抛可识别的错误（而不是静默返回半净化结果）', () => {
    const budget = { visited: 0, limit: 100 };
    expect(() => stripOperatorKeys(wideBody(500), 0, budget)).toThrow(SanitizeBudgetError);
    expect(budget.visited).toBeGreaterThan(100);
  });

  it('⚠️ 超限时绝不会"跳过净化放行"——$ 键不会出现在任何返回值里', () => {
    // 这是这条上界最重要的性质：如果超限时选择"放过 body 交给业务校验"，
    // 就等于让"太大"成为绕过 NoSQL 注入防护的条件。
    let thrown: unknown = null;
    let returned: unknown = 'NOT_CALLED';
    try {
      returned = stripOperatorKeys({ $where: 'x', ...wideBody(500) }, 0, { visited: 0, limit: 100 });
    } catch (err) {
      thrown = err;
    }
    expect(isSanitizeBudgetError(thrown)).toBe(true);
    expect(returned).toBe('NOT_CALLED');
  });

  it('深度上限（MAX_DEPTH=8）仍然生效：第 9 层开始变成 undefined', () => {
    let deep: any = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) {
      deep = { [`l${i}`]: deep };
    }
    const out = stripOperatorKeys(deep);
    // 真的走一遍嵌套，数"还是对象"的层数 —— 不是断言 JSON 里有没有某个字面量
    let cur: any = out;
    let objectLevels = 0;
    while (cur && typeof cur === 'object') {
      const key = Object.keys(cur)[0];
      objectLevels += 1;
      cur = cur[key];
      if (cur === undefined) break;
    }
    expect(objectLevels).toBe(9); // depth 0..8 是对象，depth 9 起 return undefined
    expect(cur).toBeUndefined();
  });

  it('同一个 budget 在多次调用间累计（不能靠拆分拿到多倍预算）', () => {
    const budget = { visited: 0, limit: 1000 };
    stripOperatorKeys(wideBody(300), 0, budget);
    const afterFirst = budget.visited;
    expect(afterFirst).toBeGreaterThan(300);
    expect(() => stripOperatorKeys(wideBody(3000), 0, budget)).toThrow(SanitizeBudgetError);
  });
});

describe('净化成本上界：中间件真的拒绝请求', () => {
  const OLD_ENV = process.env.VANBLOG_SANITIZE_MAX_NODES;
  beforeEach(() => {
    process.env.VANBLOG_SANITIZE_MAX_NODES = '2000';
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.VANBLOG_SANITIZE_MAX_NODES;
    else process.env.VANBLOG_SANITIZE_MAX_NODES = OLD_ENV;
  });

  it('超限 body → 413，且 next() 没被调用（半净化的 body 不会继续往下走）', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    const req: any = { query: {}, params: {}, body: wideBody(5000) };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(sent.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(sent.status).toBe(413);
    expect(String(sent.body?.message || '')).toContain('VANBLOG_SANITIZE_MAX_NODES');
    expect(nextCalled).toBe(0);
  });

  it('⚠️ 带着 $ 键的超限请求到不了任何处理器（413 + 不调 next，两件事必须同时成立）', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    const req: any = { query: {}, params: {}, body: { $where: 'evil', ...wideBody(5000) } };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(sent.status).toBe(413);
    // 真正的安全性质是"链路就地终止"：超限时 `req.body = stripOperatorKeys(...)` 这次赋值
    // **不会完成**，所以 req.body 里仍然留着原始的 `$where` —— 这没问题，因为 next() 没被调用，
    // Express 不会再往下走到任何中间件或路由处理器，那份 body 永远不会被谁读去拼 Mongo 查询。
    // ⚠️ 反过来讲：只 413 但仍 next()、或跳过净化直接放行，都是漏洞 ⇒ 两件事都断言。
    expect(nextCalled).toBe(0);
    expect((req.body as any)?.$where).toBe('evil'); // 记录事实：body 未被改写，靠"不 next()"兜住
  });

  it('合法的大正文照常通过：键少、字符串值巨大（文章/自定义页面/管线脚本的真实形状）', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    // 5MB 的字符串值 + 只有几个键 ⇒ 净化的成本是 O(键数)，不是 O(字节数)
    const req: any = {
      query: {},
      params: {},
      body: { title: 'x'.repeat(5 * 1024 * 1024), content: 'y'.repeat(5 * 1024 * 1024), published: true },
    };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(1);
    expect(sent.status).toBeUndefined();
    expect(req.body.title).toHaveLength(5 * 1024 * 1024);
  });

  it('预算是 query / params / body **共享**的：摊到三处也拿不到多倍额度', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    // 每处 900 个节点，单独看都在 2000 以下，合计 2700 > 2000 ⇒ 必须被拒
    const req: any = { query: wideBody(900), params: wideBody(900), body: wideBody(900) };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(sent.status).toBe(413);
    expect(nextCalled).toBe(0);
  });

  it('小 body 照常通过（正例，防止把正常请求也拒了）', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    const req: any = { query: { page: '1' }, params: { id: '3' }, body: { title: 'hi', $ne: 'x' } };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(1);
    expect(sent.status).toBeUndefined();
    expect(req.body).toEqual({ title: 'hi' });
    expect(req.query).toEqual({ page: '1' });
  });

  it('非预算类异常仍按既有取舍放过（净化本身不该成为可用性风险）', () => {
    const { res, sent } = buildRes();
    let nextCalled = 0;
    const evil: any = {};
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('not a budget problem');
      },
    });
    const req: any = { query: {}, params: {}, body: evil };
    sanitizeRequestPayloads(req, res, () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(1);
    expect(sent.status).toBeUndefined();
  });
});

describe('净化成本上界：全局管道（multipart 那一半）', () => {
  const OLD_ENV = process.env.VANBLOG_SANITIZE_MAX_NODES;
  beforeEach(() => {
    process.env.VANBLOG_SANITIZE_MAX_NODES = '2000';
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.VANBLOG_SANITIZE_MAX_NODES;
    else process.env.VANBLOG_SANITIZE_MAX_NODES = OLD_ENV;
  });

  const pipe = new SanitizeBodyPipe();

  it('超限的 body 抛 413（PayloadTooLargeException），不是"原样返回"', () => {
    let thrown: any = null;
    try {
      pipe.transform(wideBody(5000), { type: 'body' } as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PayloadTooLargeException);
    expect(thrown?.getStatus?.()).toBe(413);
    expect(String(thrown?.message || '')).toContain('VANBLOG_SANITIZE_MAX_NODES');
  });

  it('正常的 body 仍被净化（$ 键被删）', () => {
    expect(pipe.transform({ a: 1, $ne: 2 }, { type: 'body' } as any)).toEqual({ a: 1 });
  });

  it('multipart 的真实形状不受影响：字符串字段是 O(1)，巨大的字符串值也不会被拒', () => {
    // multer 把文本字段填成字符串；一个 5MB 的字符串值只有 1 个节点
    const out = pipe.transform({ content: 'z'.repeat(5 * 1024 * 1024) }, { type: 'body' } as any) as any;
    expect(out.content).toHaveLength(5 * 1024 * 1024);
  });

  it('非 body 参数、Buffer 与字符串原样放过（既有行为）', () => {
    expect(pipe.transform('x', { type: 'custom' } as any)).toBe('x');
    const buf = Buffer.from('abc');
    expect(pipe.transform(buf, { type: 'body' } as any)).toBe(buf);
    expect(pipe.transform('setupKey', { type: 'body' } as any)).toBe('setupKey');
  });

  it('非预算类异常仍按既有取舍原样返回', () => {
    const evil: any = {};
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('not a budget problem');
      },
    });
    expect(pipe.transform(evil, { type: 'body' } as any)).toBe(evil);
  });
});
