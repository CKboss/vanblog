#!/usr/bin/env node
/**
 * VanBlog 访问性能压测器（入库版，`scripts/benchmark/measure.sh` 会调它）。
 *
 * 为什么要它：性能结论必须能被别人重跑。报告（docs/advanced/benchmark.md）里的每一个数字
 * 都由这个脚本产生，命令与参数一并写在报告里。
 *
 * 为什么自己写：这台机器上没有 ab/wrk，而我要的不是"某个工具的输出"，
 * 是几个能直接对上代码的具体指标 —— 并发扫描下的 rps/p95、**socket 层错误**
 * （ECONNRESET / EPIPE，用来抓 Node keepAliveTimeout 与反代空闲超时打架那个经典竞态）、
 * 以及"一万条连接同时挂着"时 caddy 还接不接。
 *
 * ⚠️ 客户端与服务端在同一台机器上跑，CPU 是抢的，所以绝对数字偏保守；
 *    但**改造前后的对比是有效的**（同一台机、同一份数据、同样的脚本）。
 *
 * 用法：
 *   node loadtest.cjs --base http://127.0.0.1:18080 --profile mixed --c 50,200,500,1000 --n 2000
 *   node loadtest.cjs --base http://127.0.0.1:18080 --profile c10k --hold 10000
 */
const http = require('http');

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const BASE = get('base', 'http://127.0.0.1:18080');
const PROFILE = get('profile', 'mixed');
const CONCURRENCIES = String(get('c', '50,200,500,1000')).split(',').map(Number);
const TOTAL = Number(get('n', 2000));
const HOLD = Number(get('hold', 10000));
const TIMEOUT = Number(get('timeout', 30000));

const u = new URL(BASE);
const HOST = u.hostname;
const PORT = Number(u.port || 80);

// 混合流量配比：一个真实博客大致是"页面少、接口多、图片字节大"
const PROFILES = {
  home: [{ path: '/', w: 1 }],
  api: [{ path: '/api/public/meta', w: 3 }, { path: '/api/public/article?page=1&pageSize=5&toListView=true&withExcerpt=true', w: 7 }],
  // 只有静态资源：用来验证"图片走独立桶"（改造前它们和 API 抢同一个 600/分钟）
  static: [
    { path: '/static/img/d2230c4e12515ddfeecce26c3058a3c5._DSC9498_D.webp', w: 1 },
    { path: '/static/img/thumb/d2230c4e12515ddfeecce26c3058a3c5._DSC9498_D.webp', w: 3 },
  ],
  mixed: [
    { path: '/', w: 20 },
    { path: '/api/public/meta', w: 15 },
    { path: '/api/public/article?page=1&pageSize=5&toListView=true&withExcerpt=true', w: 30 },
    { path: '/api/public/article?page=2&pageSize=5&toListView=true&withExcerpt=true', w: 10 },
    { path: '/robots.txt', w: 5 },
    { path: '/api/public/comments/setting', w: 10 },
    { path: '/api/public/theme.css', w: 10 },
    // 静态资源要占真实流量的大头（一篇带图的文章 = 1 个 HTML + N 张图），
    // 不压它就测不出"全局限流把图片也算进去"这个问题的影响
    { path: '/static/img/d2230c4e12515ddfeecce26c3058a3c5._DSC9498_D.webp', w: 25 },
    { path: '/static/img/thumb/d2230c4e12515ddfeecce26c3058a3c5._DSC9498_D.webp', w: 25 },
  ],
};

function pickPath(list) {
  const total = list.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const item of list) {
    r -= item.w;
    if (r <= 0) return item.path;
  }
  return list[list.length - 1].path;
}

// ---------------------------------------------------------------------------
// 失败分类：为什么"失败=N"这一个数字必须拆开
//
// 本轮踩过的坑：C10K 段报「200=5033 失败=4967」，而那 4967 里混着**四种指向完全不同根因**
// 的东西，旧代码把它们统统记成 `failed += 1`：
//   · 非 2xx 状态码（502/503/504）⇒ caddy 连不上上游，日志是 `dial tcp 127.0.0.1:3000: i/o timeout`
//   · ECONNRESET                  ⇒ 对端主动重置（accept 队列溢出且 tcp_abort_on_overflow=1，或应用崩）
//   · ETIMEDOUT（建连阶段）       ⇒ SYN 被静默丢弃（tcp_abort_on_overflow=0 时 backlog 溢出就是这样）
//   · EADDRNOTAVAIL（客户端侧）   ⇒ 本机临时端口耗尽（上游连接不复用时会这样）
// 合成一个数字 = 把四种修法混成一句"失败了"。所以从这里开始每个请求都归到一个桶，
// 并且**区分失败发生在建连阶段还是请求阶段**：backlog 溢出只可能发生在建连阶段，
// 这个区分是唯一能把"内核不肯接受连接"与"应用不肯处理请求"分开的证据。
// ---------------------------------------------------------------------------

function newCounters() {
  return { buckets: Object.create(null), total: 0 };
}

function bump(c, key, n) {
  const add = n === undefined ? 1 : n;
  c.buckets[key] = (c.buckets[key] || 0) + add;
  c.total += add;
}

/** 2xx/3xx 算成功；其它状态码**按码分别计数**（502 与 503 的成因不同，合并就丢了信息） */
function statusBucket(code) {
  return code >= 200 && code < 400 ? 'ok' : `http_${code}`;
}

/** 取 errno 名字；取不到就退化成消息里第一个全大写词，再退化成 UNKNOWN（绝不静默丢弃） */
function errCode(e) {
  if (!e) return 'UNKNOWN';
  if (e.code) return String(e.code);
  const m = /\b([A-Z][A-Z0-9_]{2,})\b/.exec(String(e.message || ''));
  return m ? m[1] : 'UNKNOWN';
}

/**
 * 跟踪"这个请求失败在建连阶段还是请求阶段"。
 * ⚠️ keep-alive 复用的 socket 在 `socket` 事件时**已经**连上了（`s.connecting === false`），
 * 新建的则要等 `connect`。两种都要覆盖，否则复用连接上的失败会被误记成建连失败 ——
 * 那正好是本轮要分辨的两类之一，记错就等于没测。
 * 必须在 `req.end()` 之前挂（`socket` 事件在 flush 时才发）。
 */
function phaseTracker(req) {
  let phase = 'connect';
  req.on('socket', (s) => {
    if (s.connecting === false) phase = 'request';
    else s.once('connect', () => { phase = 'request'; });
  });
  return () => phase;
}

/**
 * 客户端自己的超时，必须与内核的 ETIMEDOUT 区分开：
 * 前者是"我们等了 30 秒放弃了"（服务端可能还在处理），后者是"TCP 重传耗尽"。
 * 混在一起会让人以为服务端在超时，其实可能是压测器太急。
 */
function armClientTimeout(req, ms) {
  req.setTimeout(ms, () => {
    const e = new Error(`client gave up after ${ms}ms`);
    e.code = 'CLIENT_TIMEOUT';
    req.destroy(e);
  });
}

/**
 * 打印分类表。⚠️ **成功也要打印**：只打印错误就看不出"总数对不对"。
 * 旧代码里 C10K 有一类失败既不计状态码也不计错误码（挂着不响应、被总超时截断），
 * 总数悄悄少了都没人发现 —— 所以这里显式算 `未归类` 并在非零时告警。
 * 行首刻意用 `[`（不是数字）：measure.sh 用 `^ *[0-9]+ \|` 抓数据行，不能被误抓。
 */
function printClassification(label, c, attempted) {
  const keys = Object.keys(c.buckets).sort((a, b) => {
    if (a === 'ok') return -1;
    if (b === 'ok') return 1;
    return c.buckets[b] - c.buckets[a] || (a < b ? -1 : 1);
  });
  const ok = c.buckets.ok || 0;
  const fails = c.total - ok;
  const unclassified = typeof attempted === 'number' ? Math.max(0, attempted - c.total) : 0;
  const total = typeof attempted === 'number' ? attempted : c.total;
  console.log(`  [分类] ${label} 总=${total} 成功=${ok} 失败=${fails} 未归类=${unclassified}`);
  console.log(`  [明细] ${keys.length ? keys.map((k) => `${k}=${c.buckets[k]}`).join(' ') : '（一个都没完成）'}`);
  if (unclassified > 0) {
    console.log(`  [警告] ${unclassified} 个请求既没有状态码也没有错误码 —— 通常是连接挂着不响应、被总超时截断；旧代码会静默吞掉这一类`);
  }
  return { ok, fails, unclassified };
}

/**
 * 单请求延迟剖析：对每个路径连打 n 次，报 min/中位/p95/max 与字节数。
 * 与并发扫描分开做，是因为两者回答的是不同问题 —— 这个答"一次访问要等多久"，
 * 那个答"能同时服务多少人"。混在一起的话，排队时间会被当成服务时间。
 */
function runLatency(paths, n, gzip) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const out = [];
  const counters = newCounters();
  // 逐路径记一份，好在总表之外指出"是哪条路径出的问题"
  const perPath = Object.create(null);
  const one = (path) =>
    new Promise((resolve) => {
      const lat = [];
      let bytes = 0;
      let status = 0;
      let done = 0;
      perPath[path] = newCounters();
      const next = () => {
        if (done >= n) {
          lat.sort((a, b) => a - b);
          out.push({
            path,
            status,
            bytes,
            n,
            min: Math.round(lat[0] || 0),
            p50: Math.round(percentile(lat, 50)),
            p95: Math.round(percentile(lat, 95)),
            max: Math.round(lat[lat.length - 1] || 0),
          });
          return resolve();
        }
        const t0 = process.hrtime.bigint();
        const headers = gzip ? { 'accept-encoding': 'gzip' } : {};
        const req = http.request({ host: HOST, port: PORT, path, method: 'GET', agent, headers }, (res) => {
          status = res.statusCode;
          let b = 0;
          res.on('data', (d) => { b += d.length; });
          res.on('end', () => {
            bytes = b;
            lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
            bump(counters, statusBucket(status));
            bump(perPath[path], statusBucket(status));
            done += 1;
            next();
          });
        });
        const phase = phaseTracker(req);
        req.on('error', (e) => {
          const key = `${phase()}_err_${errCode(e)}`;
          bump(counters, key);
          bump(perPath[path], key);
          done += 1;
          next();
        });
        armClientTimeout(req, 60000);
        req.end();
      };
      next();
    });
  return paths
    .reduce((p, path) => p.then(() => one(path)), Promise.resolve())
    .then(() => ({ rows: out, counters, perPath, attempted: paths.length * n }));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** 一轮固定并发的压测：总共发 n 个请求，始终保持 c 个在飞 */
function runRound(list, c, n) {
  return new Promise((resolve) => {
    // maxSockets 决定"最多同时多少条连接"，也就是并发度
    const agent = new http.Agent({ keepAlive: true, maxSockets: c, maxFreeSockets: c, timeout: TIMEOUT });
    const lat = [];
    const statusCount = {};
    const errCount = {};
    // ⚠️ statusCount / errCount 是历史表格「状态码」「socket 错误」两列的数据源，
    //    口径与列顺序都不能动（docs/advanced/benchmark.md 里的历史表格要能与新输出对照）。
    //    counters 是**新增**的分类账，两者并存、各记一份。
    const counters = newCounters();
    let done = 0;
    let issued = 0;
    let bytes = 0;
    const started = Date.now();

    const finish = () => {
      const ms = Date.now() - started;
      agent.destroy();
      lat.sort((a, b) => a - b);
      resolve({
        concurrency: c,
        requests: done,
        seconds: ms / 1000,
        rps: (done / (ms / 1000)).toFixed(1),
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
        p99: percentile(lat, 99),
        max: lat[lat.length - 1] || 0,
        status: statusCount,
        errors: errCount,
        errTotal: Object.values(errCount).reduce((a, b) => a + b, 0),
        mbps: ((bytes * 8) / (ms / 1000) / 1e6).toFixed(1),
        kbTotal: Math.round(bytes / 1024),
        counters,
        attempted: n,
      });
    };

    const next = () => {
      if (issued >= n) {
        if (done >= n) finish();
        return;
      }
      issued += 1;
      const path = pickPath(list);
      const t0 = process.hrtime.bigint();
      const req = http.request(
        { host: HOST, port: PORT, path, method: 'GET', agent, headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          res.on('data', (d) => { bytes += d.length; });
          res.on('end', () => {
            const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
            lat.push(ms1);
            statusCount[res.statusCode] = (statusCount[res.statusCode] || 0) + 1;
            bump(counters, statusBucket(res.statusCode));
            done += 1;
            if (done >= n) finish();
            else next();
          });
        },
      );
      const phase = phaseTracker(req);
      req.on('error', (e) => {
        const k = e.code || e.message;
        errCount[k] = (errCount[k] || 0) + 1;
        // 建连阶段的失败与请求阶段的失败分开记：backlog 溢出只可能发生在建连阶段
        bump(counters, `${phase()}_err_${errCode(e)}`);
        done += 1;
        if (done >= n) finish();
        else next();
      });
      armClientTimeout(req, TIMEOUT);
      req.end();
    };

    for (let i = 0; i < Math.min(c, n); i += 1) next();
  });
}

/** C10K：先把 hold 条连接全部建立并保持，再在上面同时发请求 */
async function runC10K(hold) {
  const sockets = [];
  let connected = 0;
  const connectErrors = {};
  const countErr = () => Object.values(connectErrors).reduce((a, b) => a + b, 0);
  // 建连阶段的分类账。与 connectErrors 并存：后者是历史「建连错误」那一行的数据源，格式不能动。
  const connectCounters = newCounters();
  let connectSettled = 0;
  const t0 = Date.now();
  let guardConnect = null;
  await new Promise((resolve) => {
    // ⚠️ 兜底计时器必须 **clearTimeout**：旧代码两个 `setTimeout(resolve, …)` 既不清除
    //    也不 unref，于是**活儿 1 秒就干完了、进程却要吊满 60/90 秒才退出** ——
    //    measure.sh 每个 C10K 目标白等 90 秒（两个目标 3 分钟），而任何外层超时比它短的人
    //    会拿到 rc=124，把"跑完了"误读成"失败了"。
    // 🔴 但**不要顺手加 unref**（下面 guardConnect 处有完整理由）：unref 解决不了上面这个问题
    //    （真正起作用的是 clearTimeout），却会引入一个更坏的失败形状 —— 当所有 socket 都被对端
    //    关掉、Promise 又因为漏了结算路径而永不 resolve 时，事件循环一空，node 会**静默退出且
    //    退出码为 0**，一行结果都不打印。"吊 90 秒"只是难等，"静默无输出"会被读成"没问题"。
    const done0 = () => { if (guardConnect) clearTimeout(guardConnect); resolve(); };
    const settle = () => { connectSettled += 1; if (connectSettled >= hold) done0(); };
    for (let i = 0; i < hold; i += 1) {
      const s = new (require('net').Socket)();
      s.setTimeout(TIMEOUT);
      // 每条连接只允许得出一次结论：destroy 之后还可能再冒一个 error 事件，
      // 不去重的话同一个失败会被记两次，总数就对不上了。
      let settledHere = false;
      const once = (fn) => { if (settledHere) return; settledHere = true; fn(); settle(); };
      s.once('connect', () => once(() => {
        connected += 1;
        sockets.push(s);
        bump(connectCounters, 'ok');
      }));
      s.once('error', (e) => once(() => {
        const k = e.code || e.message;
        connectErrors[k] = (connectErrors[k] || 0) + 1;
        bump(connectCounters, `connect_err_${errCode(e)}`);
      }));
      // ⚠️ 旧代码这里只 `s.destroy()`、**不计数** ⇒ 超时的连接既不算成功也不算失败：
      //    `connected + countErr()` 永远到不了 hold，整段白等 60 秒兜底，而且这些连接
      //    从统计里彻底消失（本轮"10000 条里只对上一半"就是这么来的）。
      //    建连阶段超时恰恰是 **backlog 溢出**最典型的信号（tcp_abort_on_overflow=0 时
      //    内核静默丢 SYN，客户端只能等到自己放弃），绝不能吞掉。
      s.once('timeout', () => once(() => {
        connectErrors.CLIENT_TIMEOUT = (connectErrors.CLIENT_TIMEOUT || 0) + 1;
        bump(connectCounters, 'connect_err_CLIENT_TIMEOUT');
        try { s.destroy(); } catch { /* 已经在关了 */ }
      }));
      // 🔴 必须结算 close：对端**干净地**关闭（FIN）时不会触发 'error'，socket 关掉后也不会再触发
      //    'timeout'，于是这条连接**永远不结算** ⇒ `connectSettled` 到不了 hold ⇒ Promise 永不 resolve。
      //    而兜底计时器是 unref 的（见下），事件循环一空，node 就**静默退出、一行结果都不打印**。
      //    本轮 `/api/public/meta` 在完整协议下"C10K 那节没有输出"就是这么来的（退出码还是 0）。
      //    ⚠️ 已成功的 socket 之后再 emit 'close' 不会重复计数（`once()` 里有 settledHere 去重）。
      s.once('close', () => once(() => {
        connectErrors.CLOSED_BEFORE_CONNECT = (connectErrors.CLOSED_BEFORE_CONNECT || 0) + 1;
        bump(connectCounters, 'connect_err_CLOSED_BEFORE_CONNECT');
      }));
      s.connect(PORT, HOST);
      // 分批建连，别把本机端口一次性打光（也顺带看看服务端接连接的速率）
      if (i % 500 === 499) {
        // eslint-disable-next-line no-await-in-loop
        const wait = new Promise((r) => setTimeout(r, 20));
        // 不 await，只是让出事件循环
        wait.then(() => {});
      }
    }
    guardConnect = setTimeout(done0, 60000);
    // 🔴 **不要 unref**。旧注释写的是"真卡住时它照样会触发（socket 的 I/O 让事件循环活着）"——
    //    这个前提是**错的**：当所有 socket 都被对端关掉之后，事件循环里就只剩这个计时器，
    //    unref 会让 node **立刻静默退出**（退出码 0），Promise 永远不 resolve，结果一行都不打印。
    //    正常跑完时 `done0()` 已经 clearTimeout，所以**保持 ref 不会把进程吊住**（守卫里有
    //    "跑完立刻退出"那条断言看着）。⇒ 兜底计时器必须能真的兜住底。
    //    ⚠️ 这条与 `050496f5` 那次"加 clearTimeout + unref"的修复不冲突：那次要解决的是
    //    "既不清除也不 unref ⇒ 活儿 1 秒干完却吊满 60/90 秒"，真正起作用的是 **clearTimeout**；
    //    unref 是多余且有害的那一半。
  });
  const connectMs = Date.now() - t0;

  // 在已建立的连接上发一个最小请求（HTTP/1.1 手写，保持连接不关）
  const c10kPath = get('path', '/api/public/meta');
  const req = 'GET ' + c10kPath + ' HTTP/1.1\r\nHost: ' + HOST + '\r\nConnection: keep-alive\r\n\r\n';
  console.log('  请求路径: ' + c10kPath);
  // ⚠️ ok/failed 是历史那一行「连接上发请求 : 200=N 失败=M」的口径（严格 200），保持不变；
  //    真正的分类信息在 counters 里，两者并存，这样历史表格仍能对照。
  let ok = 0;
  let failed = 0;
  const counters = newCounters();
  let settledReqs = 0;
  const t1 = Date.now();
  let guardRequest = null;
  await new Promise((resolve) => {
    if (sockets.length === 0) { resolve(); return; }
    const done0b = () => { if (guardRequest) clearTimeout(guardRequest); resolve(); };
    const done1 = () => { settledReqs += 1; if (settledReqs >= sockets.length) done0b(); };
    for (const s of sockets) {
      let buf = '';
      let settledHere = false;
      const finishOnce = (fn) => { if (settledHere) return; settledHere = true; fn(); done1(); };
      const onData = (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          finishOnce(() => {
            const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
            if (m) {
              const code = Number(m[1]);
              bump(counters, statusBucket(code));
              if (code === 200) ok += 1; else failed += 1;
            } else {
              // 首行不是合法状态行：caddy 直接断了、或只回了半个响应。
              // 旧代码把这一类算进 failed 但不记原因，现在单独成桶。
              bump(counters, 'err_BAD_STATUS_LINE');
              failed += 1;
            }
          });
          s.removeListener('data', onData);
        }
      };
      s.on('data', onData);
      s.once('error', (e) => finishOnce(() => { bump(counters, `request_err_${errCode(e)}`); failed += 1; }));
      s.once('timeout', () => finishOnce(() => {
        bump(counters, 'request_err_CLIENT_TIMEOUT');
        failed += 1;
        try { s.destroy(); } catch { /* 已经在关了 */ }
      }));
      // 🔴 同上：对端在**给出完整响应之前**干净关闭（FIN）时，'data' 等不到 \r\n\r\n、
      //    'error' 不触发、socket 已关所以 'timeout' 也不触发 ⇒ 这条请求**永远不结算**。
      //    这类连接单独成一个桶（CLOSED_NO_RESPONSE），因为它与"超时"和"被重置"的根因不同：
      //    它通常意味着反代/上游在高压下主动收了连接（连接数或 keep-alive 压力），
      //    而不是内核丢 SYN、也不是应用返回了错误状态码。
      s.once('close', () => finishOnce(() => {
        bump(counters, 'request_err_CLOSED_NO_RESPONSE');
        failed += 1;
      }));
      try { s.write(req); } catch (e) { finishOnce(() => { bump(counters, `request_err_WRITE_${errCode(e)}`); failed += 1; }); }
    }
    guardRequest = setTimeout(done0b, 90000);
    // 🔴 同建连阶段：**不要 unref**（理由见上面那段注释）。正常完成时 done0b() 已 clearTimeout。
    //    ⚠️ 另外 `sockets.length === 0` 的早退分支在上面，所以这里一定有 socket 要等。
  });
  const requestMs = Date.now() - t1;
  for (const s of sockets) { try { s.destroy(); } catch {} }
  return {
    hold,
    connected,
    connectErrors,
    connectSeconds: (connectMs / 1000).toFixed(1),
    requestsOk: ok,
    requestsFailed: failed,
    requestSeconds: (requestMs / 1000).toFixed(1),
    connectCounters,
    connectSettled,
    counters,
    settledReqs,
  };
}

// latency profile 的路径清单：覆盖"静态直服 / ISR 页面 / 动态接口 / 大文件 / 后台"
const LATENCY_PATHS = String(get('paths', '')).split(',').filter(Boolean);

(async () => {
  // 客户端自己的天花板也要记：EADDRNOTAVAIL（临时端口耗尽）是**压测机**的约束，不是服务端的。
  // 不记这一条，就可能把"本机端口用光了"误判成"服务端接不住"。
  const readFirst = (p) => { try { return require('fs').readFileSync(p, 'utf8').trim().replace(/\s+/g, ' '); } catch { return '?'; } };
  console.log(`压测目标 ${BASE}  profile=${PROFILE}  本机 fd 软限制=${require('child_process').execSync('ulimit -n').toString().trim()}`);
  console.log(`压测机网络事实  临时端口范围=${readFirst('/proc/sys/net/ipv4/ip_local_port_range')}  somaxconn=${readFirst('/proc/sys/net/core/somaxconn')}  tcp_abort_on_overflow=${readFirst('/proc/sys/net/ipv4/tcp_abort_on_overflow')}  tcp_tw_reuse=${readFirst('/proc/sys/net/ipv4/tcp_tw_reuse')}`);
  console.log('  ⚠️ 上面是**压测机**的值；服务端容器内的同名参数由 measure.sh 单独采集（两者不在同一个 netns）');
  if (PROFILE === 'latency') {
    const paths = LATENCY_PATHS.length ? LATENCY_PATHS : ['/', '/api/public/meta', '/robots.txt'];
    const rounds = Number(get('n', 20));
    for (const gzip of [false, true]) {
      const { rows, counters, perPath, attempted } = await runLatency(paths, rounds, gzip);
      console.log(`\n== 单请求延迟（每路径 ${rounds} 次，accept-encoding: ${gzip ? 'gzip' : 'identity'}）==`);
      console.log('路径 | 状态 | 字节 | min | p50 | p95 | max (ms)');
      for (const r of rows) {
        console.log(`${r.path} | ${r.status} | ${r.bytes} | ${r.min} | ${r.p50} | ${r.p95} | ${r.max}`);
      }
      printClassification(`latency/${gzip ? 'gzip' : 'identity'}`, counters, attempted);
      // 只把**有问题的**路径单列出来：延迟表里 status=0 看不出是建连失败还是超时，
      // 而"哪条路径出的问题"直接决定往哪儿查（静态路径 vs 反代路径的根因完全不同）。
      for (const p of Object.keys(perPath)) {
        const bad = Object.keys(perPath[p].buckets).filter((k) => k !== 'ok');
        if (bad.length) console.log(`  [异常路径] ${p} ${bad.map((k) => `${k}=${perPath[p].buckets[k]}`).join(' ')}`);
      }
      if (get('json', '')) {
        require('fs').appendFileSync(get('json', ''), JSON.stringify({ base: BASE, gzip, rounds, rows, buckets: counters.buckets }, null, 2) + '\n');
      }
    }
    return;
  }
  if (PROFILE === 'c10k') {
    const r = await runC10K(HOLD);
    console.log('\n== C10K（先建连接并保持，再一起发请求）==');
    console.log(`  目标连接数     : ${r.hold}`);
    console.log(`  成功建立       : ${r.connected}（用时 ${r.connectSeconds}s）`);
    if (Object.keys(r.connectErrors).length) console.log(`  建连错误       : ${JSON.stringify(r.connectErrors)}`);
    console.log(`  连接上发请求   : 200=${r.requestsOk} 失败=${r.requestsFailed}（用时 ${r.requestSeconds}s）`);
    // 两个阶段分开报：backlog 溢出只会出现在建连阶段，上游连不上只会出现在请求阶段。
    // 混在一起就没法判断该改内核参数、改 Node 的 listen backlog，还是改 caddy 的反代池。
    printClassification('建连阶段', r.connectCounters, r.hold);
    printClassification('请求阶段', r.counters, r.connected);
    return;
  }
  const list = PROFILES[PROFILE] || PROFILES.mixed;
  console.log(`  路径配比：${list.map((x) => `${x.path}×${x.w}`).join('  ')}`);
  // 预热：让 ISR 把要打的页面都生成出来，否则测的是"冷启动渲染"
  // ⚠️ 预热**必须带超时**。旧代码这里是裸 `http.get(...).on('error', res)`：只要有一条路径
  //    挂着不响应（服务端 hang、被限流后连接被挂住、或上游 dial 超时），Promise 永不 resolve，
  //    整个压测就永久卡在预热里、**连一行结果都不打印**。而"卡住"看起来像压测器坏了，
  //    实际是被测端的问题 —— 那恰恰是最该被大声报出来的一类失败。
  const WARM_TIMEOUT = Number(get('warmup-timeout', 20000));
  const warm = [];
  for (const item of list) {
    // eslint-disable-next-line no-await-in-loop
    const r = await new Promise((res) => {
      const rq = http.get({ host: HOST, port: PORT, path: item.path }, (x) => {
        x.resume();
        x.on('end', () => res({ path: item.path, status: x.statusCode }));
      });
      rq.on('error', (e) => res({ path: item.path, error: errCode(e) }));
      rq.setTimeout(WARM_TIMEOUT, () => { rq.destroy(); res({ path: item.path, error: 'CLIENT_TIMEOUT' }); });
    });
    warm.push(r);
  }
  const warmBad = warm.filter((x) => x.error || !(x.status >= 200 && x.status < 400));
  console.log(`  预热：${warm.length} 条路径，正常 ${warm.length - warmBad.length} 条（超时上限 ${WARM_TIMEOUT}ms）`);
  if (warmBad.length) {
    console.log(`  [预热异常] ${warmBad.map((x) => `${x.path}→${x.error || `http_${x.status}`}`).join('  ')}`);
    console.log('  ⚠️ 预热就有路径不通 ⇒ 下面的数字是在"部分路径本来就失败"的前提下测出来的，别当成容量结论');
  }
  await new Promise((r) => setTimeout(r, 3000));
  console.log('\n并发 | 完成 | 秒 | rps | p50 | p95 | p99 | max | Mbps | 状态码 | socket 错误');
  for (const c of CONCURRENCIES) {
    const r = await runRound(list, c, TOTAL);
    const st = Object.entries(r.status).map(([k, v]) => `${k}:${v}`).join(' ');
    const er = r.errTotal ? JSON.stringify(r.errors) : '-';
    console.log(`${String(r.concurrency).padStart(5)} | ${String(r.requests).padStart(4)} | ${r.seconds.toFixed(1).padStart(5)} | ${String(r.rps).padStart(7)} | ${String(Math.round(r.p50)).padStart(4)} | ${String(Math.round(r.p95)).padStart(4)} | ${String(Math.round(r.p99)).padStart(4)} | ${String(Math.round(r.max)).padStart(5)} | ${String(r.mbps).padStart(6)} | ${st} | ${er}`);
    // 每一档都打分类：同一轮里"502 变多"与"ECONNRESET 变多"指向完全不同的约束，
    // 只看汇总会把并发相关的拐点抹平。
    printClassification(`并发 ${r.concurrency}`, r.counters, r.attempted);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
})();
