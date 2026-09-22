import { readFileSync } from 'fs';
import { resolve } from 'path';
import { InitMiddleware } from './init.middleware';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `InitMiddleware`：站点**未初始化**时把除少数几条之外的所有路由挡在门外。
 *
 * 它拦的方式很特别 —— **HTTP 200 + body `{statusCode:233, message:'未初始化!'}`**，
 * 而不是 4xx。这是**有意设计**（后台前端靠 233 这个信封判断"该跳初始化页了"；
 * 用 401/403 会被前端的"会话过期"逻辑吃掉），所以本文件钉住它、而不是"修"它。
 *
 * 三条真正要紧的性质：
 * 1. **未初始化时绝不能调用 `next()`**：那等于把请求放进业务路由，
 *    而业务路由此时面对的是一个空库（`users` 里没有管理员、`metas` 里没有站点信息）。
 * 2. **它自己的放行是"归一化后与 `/api/admin/init` 精确相等"**（不是前缀匹配）。
 *    🔴 2026-09-22 更正：此前是 `req.path == '/api/admin/init'`（请求侧 + 大小写敏感 + 松散精确相等），
 *    而 Express 默认**大小写不敏感且尾斜杠可选** ⇒ `/api/admin/init/` 与 `/API/admin/init` 会被路由送到
 *    **同一个处理器**、却匹配不上那个字面量 ⇒ 未初始化时被挡在门外（"站点卡在未初始化"）。
 *    现在先经 `normalizeRateLimitPath`（去尾斜杠 + 转小写，**刻意不解码百分号** —— 下游是 Express 路由）
 *    再比较，使**中间件的豁免范围与路由的可达范围一致**。
 *    ⚠️ **失败方向要注意**：不匹配 ⇒ 走 `else` ⇒ 未初始化时返回 233 提示而**不是**放行
 *    ⇒ 这一处**不是安全边界**，与"大小写敏感的前缀比较绕过防护"那四处方向相反（那四处是"不匹配 ⇒ 跳过防护"）。
 *    ⚠️ 而 `/api/admin/init/upload`、`/api/admin/init/restore`、`/api/public/health` 这些**子路径/别的路径**
 *    仍然**不是**被中间件放行的，而是靠 `app.module.ts` 里 `.exclude(...)` 那一串。
 *    这意味着"未初始化时必须能用的路径"这件事被**分散在两个文件里**，
 *    删掉 exclude 清单里的任何一条都会让灾难恢复直接失效（`/api/admin/init/restore`
 *    正是站点还没初始化时导入整站备份的唯一入口）⇒ 两条跨文件漂移守卫。
 * 3. **放行字符串必须与后台前端实际 POST 的路径逐字相同**。前端打的是 `/api/admin/init`
 *    （`packages/admin/src/services/van-blog/api.js`），如果哪天有人给中间件加上尾斜杠、
 *    或前端改成带斜杠，结果会是"初始化页永远收到 233"，站点无法完成首次初始化。
 */

function makeMiddleware(hasInited: boolean) {
  const mw = Object.create(InitMiddleware.prototype) as any;
  const checkHasInited = jest.fn(async () => hasInited);
  mw.initProvider = { checkHasInited };
  const next = jest.fn();
  const json = jest.fn();
  const status = jest.fn();
  const res: any = { json, status, statusCode: 200 };
  return { mw, checkHasInited, next, json, status, res };
}

function req(path: string) {
  return { path, method: 'GET', headers: {} } as any;
}

describe('InitMiddleware.use：放行与拦截', () => {
  it('`/api/admin/init` 直接放行，且**不查库**（初始化接口本身当然不能要求"已初始化"）', async () => {
    const { mw, checkHasInited, next, json } = makeMiddleware(false);
    await mw.use(req('/api/admin/init'), {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(checkHasInited).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('已初始化 ⇒ 任何路径都放行', async () => {
    const { mw, next, json } = makeMiddleware(true);
    await mw.use(req('/api/admin/article'), {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it('🔴 未初始化 ⇒ 回 233 信封，且**绝不调用 next()**', async () => {
    const { mw, next, json, res } = makeMiddleware(false);
    await mw.use(req('/api/admin/article'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({ statusCode: 233, message: '未初始化!' });
    expect(body.data).toBeTruthy();
    expect('allowDomains' in body.data).toBe(true);
  });

  it('未初始化时**不改 HTTP 状态码**（仍是 200）—— 这是有意设计，前端靠 body 里的 233 判断', async () => {
    const { mw, res, next } = makeMiddleware(false);
    await mw.use(req('/api/public/meta'), res, next);
    // 没有调用 res.status(...)，也没有 res.sendStatus
    expect(res.statusCode).toBe(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('`allowDomains` 取自 VAN_BLOG_ALLOW_DOMAINS，未设置时是空串（不是 undefined —— 前端会拼进 URL）', async () => {
    const prev = process.env.VAN_BLOG_ALLOW_DOMAINS;
    try {
      delete process.env.VAN_BLOG_ALLOW_DOMAINS;
      const a = makeMiddleware(false);
      await a.mw.use(req('/x'), a.res, a.next);
      expect(a.json.mock.calls[0][0].data.allowDomains).toBe('');

      process.env.VAN_BLOG_ALLOW_DOMAINS = 'https://a.example';
      const b = makeMiddleware(false);
      await b.mw.use(req('/x'), b.res, b.next);
      expect(b.json.mock.calls[0][0].data.allowDomains).toBe('https://a.example');
    } finally {
      if (prev === undefined) delete process.env.VAN_BLOG_ALLOW_DOMAINS;
      else process.env.VAN_BLOG_ALLOW_DOMAINS = prev;
    }
  });

  it('🔴 豁免范围与 Express 路由的可达范围一致：尾斜杠与大小写变体**同样被放行**', async () => {
    // Express 默认 strict routing=false、case sensitive routing=false（`main.ts` 两项都没改），
    // 所以这三种写法都会被路由送到**同一个** init 处理器 ⇒ 中间件也必须同样豁免它们，
    // 否则处理器可达而中间件挡着，未初始化的站点就完不成首次初始化。
    for (const p of ['/api/admin/init', '/api/admin/init/', '/API/admin/init', '/Api/Admin/Init//']) {
      const { mw, next, json, checkHasInited, res } = makeMiddleware(false);
      await mw.use(req(p), res, next);
      expect({ path: p, nextCalled: next.mock.calls.length, jsonCalled: json.mock.calls.length }).toEqual({
        path: p,
        nextCalled: 1,
        jsonCalled: 0,
      });
      // 放行分支不该去查库（豁免的意义就是"未初始化也能过"）
      expect(checkHasInited).toHaveBeenCalledTimes(0);
    }
  });

  it('⚠️ 子路径与其它路径**不**被中间件放行（它们要靠 exclude 清单，豁免没有扩大）', async () => {
    // 🔴 这条是上一条的**反方向对照**：归一化只消除了"尾斜杠/大小写"这两个维度，
    //    **没有**把豁免扩大到子路径或任何别的路径 —— 否则"归一化"就退化成了"前缀匹配"。
    for (const p of [
      '/api/admin/init/restore',
      '/api/admin/init/upload',
      '/api/admin/initX',
      '/api/admin/initialise',
      '/api/admin/ini',
      '/api/public/health',
      '/x',
    ]) {
      const { mw, next, json, checkHasInited, res } = makeMiddleware(false);
      await mw.use(req(p), res, next);
      expect({ path: p, nextCalled: next.mock.calls.length, jsonCalled: json.mock.calls.length }).toEqual({
        path: p,
        nextCalled: 0,
        jsonCalled: 1,
      });
      expect(checkHasInited).toHaveBeenCalledTimes(1);
    }
  });

  it('🔴 百分号编码变体**不**被放行（归一化刻意不解码：解码会让判定比 Express 路由更宽）', async () => {
    // `/api/admin/%69nit` 这类写法：Express 路由匹配用的是**未解码**的 req.path，所以它并**不会**
    // 命中 init 处理器；若中间件解码后再比，就会豁免一个路由根本到不了的路径（判定比路由更宽）。
    for (const p of ['/api/admin/%69nit', '/api/admin/init%2f', '//api//admin//init']) {
      const { mw, next, json, checkHasInited, res } = makeMiddleware(false);
      await mw.use(req(p), res, next);
      expect({ path: p, nextCalled: next.mock.calls.length, jsonCalled: json.mock.calls.length }).toEqual({
        path: p,
        nextCalled: 0,
        jsonCalled: 1,
      });
      expect(checkHasInited).toHaveBeenCalledTimes(1);
    }
  });

  it('🔴 非法输入不抛错、且一律落到"不放行"（失败方向更严）', async () => {
    for (const weird of [undefined, '', null, 42, {}, ['/api/admin/init']]) {
      const { mw, next, json, res } = makeMiddleware(false);
      await mw.use(req(weird as any), res, next);
      expect({ nextCalled: next.mock.calls.length, jsonCalled: json.mock.calls.length }).toEqual({
        nextCalled: 0,
        jsonCalled: 1,
      });
    }
  });

  it('checkHasInited 抛错时**不吞异常**（未初始化检查失败不应该被当成"已初始化"放行）', async () => {
    const mw = Object.create(InitMiddleware.prototype) as any;
    mw.initProvider = {
      checkHasInited: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    const next = jest.fn();
    await expect(mw.use(req('/api/admin/article'), {} as any, next)).rejects.toThrow(/db down/);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('漂移守卫 A：未初始化时必须能用的路径，都还在 app.module 的 exclude 清单里', () => {
  const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, '../../app.module.ts'), 'utf-8'));

  it.each([
    ['/api/admin/init/upload', 'POST'],
    ['/api/admin/init/restore', 'POST'],
    ['/api/public/health', 'GET'],
    ['/api/admin/img/upload', 'POST'],
    ['/api/admin/caddy/ask', 'GET'],
  ])('%s（%s）仍在 exclude 清单里', (path, method) => {
    // 断言"路径 + 方法"这一对出现在 exclude 段里，而不是只断言路径字符串出现过
    const iExclude = SRC.indexOf('.exclude(');
    expect(iExclude).toBeGreaterThan(-1);
    const seg = SRC.slice(iExclude, SRC.indexOf('.forRoutes(', iExclude));
    expect(seg).toContain(`'${path}'`);
    expect(seg).toContain(`RequestMethod.${method}`);
  });

  it('负向对照：把 restore 那条从 exclude 段里删掉，上面那条断言必须能抓到', () => {
    const iExclude = SRC.indexOf('.exclude(');
    const seg = SRC.slice(iExclude, SRC.indexOf('.forRoutes(', iExclude));
    // ⚠️ 用**按行过滤**而不是正则删除：第一版写的正则要求 `)` 后面跟 `,`，
    //    而真实文本里 `.exclude(...)` 后面跟的是 `.`（`.forRoutes(`）⇒ 正则一次都没匹配上，
    //    于是"删掉之后"与原文相同，对照恒真、什么都没证明（是 `not.toBe` 那条先红的）。
    const without = seg
      .split('\n')
      .filter((line) => !line.includes('/api/admin/init/restore'))
      .join('\n');
    expect(without).not.toBe(seg); // 真的删掉了东西（否则这条对照是空的）
    expect(without.includes('/api/admin/init/restore')).toBe(false);
    // 并且：删掉之后，"restore 仍在清单里"那条断言确实会失败
    expect(seg.includes("'/api/admin/init/restore'")).toBe(true);
  });

  it('exclude 段确实作用在 InitMiddleware 上（不是别的中间件的 exclude）', () => {
    const marker = '.apply(InitMiddleware)';
    const iInit = SRC.indexOf(marker);
    const iExclude = SRC.indexOf('.exclude(', iInit);
    expect(iInit).toBeGreaterThan(-1);
    expect(iExclude).toBeGreaterThan(iInit);
    // 两者之间不能夹着另一个 .apply(...)，否则这个 exclude 属于别人。
    // ⚠️ 切片要从 marker **之后**开始：从 iInit 开始的话，切片第一个字符就是 `.apply(`，
    //    断言恒假（第一版就是这么红的）。
    expect(SRC.slice(iInit + marker.length, iExclude)).not.toContain('.apply(');
  });
});

describe('漂移守卫 B：中间件的放行字符串必须与后台前端实际请求的路径逐字相同', () => {
  const MW = stripCommentsForAnchor(readFileSync(resolve(__dirname, 'init.middleware.ts'), 'utf-8'));
  const ADMIN_API = readFileSync(
    resolve(__dirname, '../../../../admin/src/services/van-blog/api.js'),
    'utf-8',
  );

  it('中间件放行的是 `/api/admin/init`（归一化后精确相等，字面量无尾斜杠）', () => {
    // 🔴 2026-09-22 升级：字面量本身仍必须逐字是 `/api/admin/init`（这条守卫的**原意**），
    //    但比较的**左侧**现在是归一化后的路径，所以形状从 `req.path ==` 变成
    //    `normalizeRateLimitPath(req.path) ===`。
    expect(MW).toMatch(/normalizeRateLimitPath\(req\.path\)\s*===\s*'\/api\/admin\/init'/);
    // 🔴 并且必须真的从 rateLimit 引入那个共享口径（而不是就地另写一份，两份就会漂）
    expect(MW).toMatch(/import\s*\{\s*normalizeRateLimitPath\s*\}\s*from\s*'\.\.\/\.\.\/utils\/rateLimit'/);
    // 🔴 刻意不解码百分号：源码里不许出现 decodeURI/decodeURIComponent（解码会让判定比路由更宽）
    expect(MW).not.toMatch(/decodeURI(Component)?\(/);
  });

  it('后台前端 POST 的初始化路径就是 `/api/admin/init`（两边逐字相同）', () => {
    expect(ADMIN_API).toContain("request('/api/admin/init'");
    // ⚠️ 不能是带尾斜杠的形状，否则中间件的精确匹配会落空、初始化页永远收到 233
    expect(ADMIN_API).not.toContain("request('/api/admin/init/'");
  });

  it('负向对照：给中间件的字面量加上尾斜杠，第一条断言必须红', () => {
    // ⚠️ 变异锚点必须**唯一命中代码**：文件头注释里也提到了这个字面量，
    //    所以这里用带 `normalizeRateLimitPath(` 的完整形状做锚点（注释里没有这个形状）。
    const anchor = "normalizeRateLimitPath(req.path) === '/api/admin/init'";
    expect(MW.split(anchor).length - 1).toBe(1); // 🔴 唯一命中，不是 >= 1
    const mutated = MW.replace(anchor, "normalizeRateLimitPath(req.path) === '/api/admin/init/'");
    expect(mutated).not.toBe(MW); // 变异真的发生了
    expect(mutated).not.toMatch(/normalizeRateLimitPath\(req\.path\)\s*===\s*'\/api\/admin\/init'/);
    expect(MW).toMatch(/normalizeRateLimitPath\(req\.path\)\s*===\s*'\/api\/admin\/init'/);
  });

  it('🔴 负向对照：把归一化去掉（退回请求侧原始值比较），第一条断言必须红', () => {
    const anchor = 'normalizeRateLimitPath(req.path)';
    expect(MW.split(anchor).length - 1).toBe(1); // 唯一命中
    const mutated = MW.replace(anchor, 'req.path');
    expect(mutated).not.toBe(MW);
    expect(mutated).not.toMatch(/normalizeRateLimitPath\(req\.path\)\s*===/);
  });
});
