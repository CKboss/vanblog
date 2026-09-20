/**
 * 加密文章解锁的**第二道闸：按文章的全局（跨 IP）预算**。
 *
 * 第一道闸是 20 次/10 分钟/**(IP×文章)**，它在僵尸网络下等于没有 —— N 个 IP 就是 N×20 次，
 * 而每次尝试都要算一次 scrypt（N=16384，实测 63–65 ms / 16MB）⇒ 攻击成本是**乘法**：
 * `IP 数 × 加密文章数 × 20`。100 篇加密文章时 5 个 IP 就能产生 3.24 秒/秒的 scrypt 工作量。
 * scrypt 本轮已异步化（事件循环不再被冻结），但 **CPU 总量没变**：libuv 线程池被打满之后，
 * 图片管线等其它异步工作一起排队。这道闸把总量变成有界，与来源 IP 数无关。
 *
 * ⚠️ 断言是**行为级**：真的调用处理器、用不同源 IP 打同一篇文章，看第 N+1 次是否 429。
 * 不是"源码里出现了 consumeAttempt"（那是空断言：import 行就能让它过，
 * 把判定包进 `if (false && …)` 也照样过 —— 本轮已有两条守卫因此空转）。
 */

/** 用指定的全局预算加载一份**独立**的控制器（isolateModules 让计数器也是全新的，互不污染）。 */
function loadController(budget: number) {
  const OLD = process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN;
  process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN = String(budget);
  let mod: any;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('./public.controller');
  });
  if (OLD === undefined) delete process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN;
  else process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN = OLD;

  const calls: Array<{ id: any; password: any }> = [];
  const articleProvider = {
    // 默认"密码错"⇒ 返回 null，不会触发成功路径的重置，便于把预算打满。
    getByIdWithPassword: jest.fn().mockImplementation(async (id: any, password: any) => {
      calls.push({ id, password });
      return null;
    }),
  };
  const noop = jest.fn().mockResolvedValue(undefined);
  const controller = new mod.PublicController(
    articleProvider as any,
    { getAllCategories: noop, getPublicCategoryNames: noop, getCategoriesWithArticle: noop } as any,
    { getAllTags: noop } as any,
    { getAll: noop, getArticlesPerPage: noop, getTotalWords: noop } as any,
    { getLatestVisits: noop } as any,
    { getMenuSetting: noop, getLayoutSetting: noop, encodeLayoutSetting: noop } as any,
    { getPublicCustomPages: noop } as any,
  );
  return { controller, mod, articleProvider, calls };
}

/** 造一个来自指定源 IP 的匿名请求（无转发头 ⇒ 走套接字地址口径）。 */
const reqFrom = (ip: string) => ({ socket: { remoteAddress: ip }, headers: {} } as any);

/** 打一次解锁，返回 'ok' 或 429 的响应文案。 */
async function attempt(controller: any, id: string, ip: string, password = 'wrong') {
  try {
    await controller.getArticleByIdOrPathnameWithPassword(id as any, { password }, reqFrom(ip));
    return { status: 'ok' as const };
  } catch (e: any) {
    // ⚠️ 不能用 `instanceof HttpException`：控制器是 `jest.isolateModules` 里加载的，
    //    它抛出的异常来自**另一份** `@nestjs/common`，`instanceof` 判不中 ⇒ 异常会被重新抛出，
    //    测试看到的就不是"429"而是"炸了"（我第一次写就踩了这个，症状是循环内莫名抛异常）。
    //    改成鸭子类型：有 `getStatus()` 且返回 429 就算。
    if (typeof e?.getStatus === 'function' && e.getStatus() === 429) {
      const raw = typeof e.getResponse === 'function' ? e.getResponse() : e.message;
      return { status: 429 as const, message: String(typeof raw === 'string' ? raw : JSON.stringify(raw)) };
    }
    throw e;
  }
}

describe('解锁的全局预算（跨 IP）', () => {
  it('🔴 同一篇文章被**不同 IP** 打满预算后，第 N+1 次是 429', async () => {
    const BUDGET = 25;
    const { controller, mod } = loadController(BUDGET);
    expect(mod.UNLOCK_GLOBAL_BUDGET_PER_10MIN).toBe(BUDGET); // 证明 env 真的生效了

    const id = '900001';
    for (let i = 0; i < BUDGET; i += 1) {
      // ⚠️ 每次换一个源 IP：第一道闸（20 次/IP）永远不会触发，
      //    所以能拦下第 26 次的**只可能**是全局预算这道闸。
      const r = await attempt(controller, id, `203.0.113.${i + 1}`);
      expect({ i, r }).toEqual({ i, r: { status: 'ok' } });
    }

    const blocked = await attempt(controller, id, '203.0.113.200');
    expect(blocked.status).toBe(429);
    // 文案要可照做（告诉用户等多久），且不回显文章 id。
    expect(blocked.message ?? '').toMatch(/尝试次数过多/);
    expect(blocked.message ?? '').toMatch(/秒后再试/);
    expect(blocked.message ?? '').not.toMatch(id);
  });

  it('预算是**按文章**分桶的：换一篇文章立刻恢复（不做"全站"预算）', async () => {
    // ⚠️ 预算下限是 20（低于它一律回落默认 500，那是"防止有人把闸配成锁死所有读者"的夹取），
    //    所以测试也必须用 >= 20 的值，否则永远打不满、断言变成"永远 ok"的假绿。
    const BUDGET = 20;
    const { controller } = loadController(BUDGET);

    for (let i = 0; i < BUDGET; i += 1) {
      expect((await attempt(controller, '900002', `198.51.100.${i + 1}`)).status).toBe('ok');
    }
    expect((await attempt(controller, '900002', '198.51.100.99')).status).toBe(429);

    // ⚠️ 这条同时是"不做全站预算"的反证：另一篇文章完全不受影响。
    //    全站预算会让"一篇爆文的合法读者"把全站所有加密文章一起锁死，
    //    而本站的场景恰恰是"要在攻击下把内容发出去"⇒ 可用性优先。
    expect((await attempt(controller, '900003', '198.51.100.99')).status).toBe('ok');
  });

  it('🔴 同一篇文章的不同 id 写法**共享**预算（否则前导零就能绕过这道闸）', async () => {
    const BUDGET = 20;
    const { controller } = loadController(BUDGET);

    // 先用同一种写法把预算打到只剩 1 次，再验证"另一种写法"共享同一个桶。
    for (let i = 0; i < BUDGET - 1; i += 1) {
      expect((await attempt(controller, '900007', `192.0.2.${i + 1}`)).status).toBe('ok');
    }
    // ⚠️ 关键：换成 `0900007`（归一到同一个数字 id）用掉最后一次 ⇒ 桶被同一个 id 的不同写法共享。
    expect((await attempt(controller, '0900007', '192.0.2.200')).status).toBe('ok');
    // 再来任何一种写法（`900007.0` / `900007e0` / 一长串前导零）都必须被拦。
    expect((await attempt(controller, '900007.0', '192.0.2.201')).status).toBe(429);
    expect((await attempt(controller, '900007e0', '192.0.2.202')).status).toBe(429);
    expect((await attempt(controller, '0000000900007', '192.0.2.203')).status).toBe(429);
  });

  it('非数字 id（按 pathname 解锁）同样有全局预算，且按截断后的 pathname 分桶', async () => {
    const BUDGET = 20;
    const { controller } = loadController(BUDGET);

    for (let i = 0; i < BUDGET; i += 1) {
      expect((await attempt(controller, 'my-secret-post', `192.0.2.${i + 60}`)).status).toBe('ok');
    }
    expect((await attempt(controller, 'my-secret-post', '192.0.2.120')).status).toBe(429);
    expect((await attempt(controller, 'another-post', '192.0.2.120')).status).toBe('ok');
  });

  it('垃圾 env 值回落默认 500，且不会变成"无上限"', () => {
    for (const garbage of ['0', '-5', 'abc', '', '1e999']) {
      process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN = garbage;
      let mod: any;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        mod = require('./public.controller');
      });
      // ⚠️ 关键：垃圾值必须回落到默认 500，绝不能变成 0/NaN/Infinity
      //    （0 会把所有解锁都锁死，Infinity 等于这道闸不存在）。
      expect({ garbage, value: mod.UNLOCK_GLOBAL_BUDGET_PER_10MIN }).toEqual({ garbage, value: 500 });
    }
    delete process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN;
  });

  it('低于 20 的配置被拒绝（回落默认），防止有人把闸配成"锁死所有读者"', () => {
    process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN = '5';
    let mod: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('./public.controller');
    });
    expect(mod.UNLOCK_GLOBAL_BUDGET_PER_10MIN).toBe(500);
    delete process.env.VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN;
  });

  it('负向对照：预算足够时不会误伤（第 N 次仍然放行，且真的打到了 provider）', async () => {
    const { controller, articleProvider, calls } = loadController(100);
    const r = await attempt(controller, '900009', '203.0.113.9', 'maybe-right');
    expect(r.status).toBe('ok');
    expect(articleProvider.getByIdWithPassword).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ id: '900009', password: 'maybe-right' });
  });
});
