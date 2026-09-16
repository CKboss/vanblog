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

/**
 * 单请求延迟剖析：对每个路径连打 n 次，报 min/中位/p95/max 与字节数。
 * 与并发扫描分开做，是因为两者回答的是不同问题 —— 这个答"一次访问要等多久"，
 * 那个答"能同时服务多少人"。混在一起的话，排队时间会被当成服务时间。
 */
function runLatency(paths, n, gzip) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const out = [];
  const one = (path) =>
    new Promise((resolve) => {
      const lat = [];
      let bytes = 0;
      let status = 0;
      let done = 0;
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
            done += 1;
            next();
          });
        });
        req.on('error', () => { done += 1; next(); });
        req.setTimeout(60000, () => req.destroy(new Error('ETIMEDOUT')));
        req.end();
      };
      next();
    });
  return paths.reduce((p, path) => p.then(() => one(path)), Promise.resolve()).then(() => out);
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
            done += 1;
            if (done >= n) finish();
            else next();
          });
        },
      );
      req.on('error', (e) => {
        const k = e.code || e.message;
        errCount[k] = (errCount[k] || 0) + 1;
        done += 1;
        if (done >= n) finish();
        else next();
      });
      req.setTimeout(TIMEOUT, () => req.destroy(new Error('ETIMEDOUT')));
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
  const t0 = Date.now();
  await new Promise((resolve) => {
    for (let i = 0; i < hold; i += 1) {
      const s = new (require('net').Socket)();
      s.setTimeout(TIMEOUT);
      s.once('connect', () => {
        connected += 1;
        sockets.push(s);
        if (connected + countErr() >= hold) resolve();
      });
      s.once('error', (e) => {
        const k = e.code || e.message;
        connectErrors[k] = (connectErrors[k] || 0) + 1;
        if (connected + countErr() >= hold) resolve();
      });
      s.once('timeout', () => { s.destroy(); });
      s.connect(PORT, HOST);
      // 分批建连，别把本机端口一次性打光（也顺带看看服务端接连接的速率）
      if (i % 500 === 499) {
        // eslint-disable-next-line no-await-in-loop
        const wait = new Promise((r) => setTimeout(r, 20));
        // 不 await，只是让出事件循环
        wait.then(() => {});
      }
    }
    setTimeout(resolve, 60000);
  });
  const connectMs = Date.now() - t0;

  // 在已建立的连接上发一个最小请求（HTTP/1.1 手写，保持连接不关）
  const c10kPath = get('path', '/api/public/meta');
  const req = 'GET ' + c10kPath + ' HTTP/1.1\r\nHost: ' + HOST + '\r\nConnection: keep-alive\r\n\r\n';
  console.log('  请求路径: ' + c10kPath);
  let ok = 0;
  let failed = 0;
  const t1 = Date.now();
  await new Promise((resolve) => {
    let settled = 0;
    const done1 = () => { settled += 1; if (settled >= sockets.length) resolve(); };
    for (const s of sockets) {
      let buf = '';
      const onData = (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          if (/^HTTP\/1\.[01] 200/.test(buf)) ok += 1; else failed += 1;
          s.removeListener('data', onData);
          done1();
        }
      };
      s.on('data', onData);
      s.once('error', () => { failed += 1; done1(); });
      s.once('timeout', () => { failed += 1; s.destroy(); done1(); });
      try { s.write(req); } catch { failed += 1; done1(); }
    }
    setTimeout(resolve, 90000);
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
  };
}

// latency profile 的路径清单：覆盖"静态直服 / ISR 页面 / 动态接口 / 大文件 / 后台"
const LATENCY_PATHS = String(get('paths', '')).split(',').filter(Boolean);

(async () => {
  console.log(`压测目标 ${BASE}  profile=${PROFILE}  本机 fd 软限制=${require('child_process').execSync('ulimit -n').toString().trim()}`);
  if (PROFILE === 'latency') {
    const paths = LATENCY_PATHS.length ? LATENCY_PATHS : ['/', '/api/public/meta', '/robots.txt'];
    const rounds = Number(get('n', 20));
    for (const gzip of [false, true]) {
      const rows = await runLatency(paths, rounds, gzip);
      console.log(`\n== 单请求延迟（每路径 ${rounds} 次，accept-encoding: ${gzip ? 'gzip' : 'identity'}）==`);
      console.log('路径 | 状态 | 字节 | min | p50 | p95 | max (ms)');
      for (const r of rows) {
        console.log(`${r.path} | ${r.status} | ${r.bytes} | ${r.min} | ${r.p50} | ${r.p95} | ${r.max}`);
      }
      if (get('json', '')) {
        require('fs').appendFileSync(get('json', ''), JSON.stringify({ base: BASE, gzip, rounds, rows }, null, 2) + '\n');
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
    return;
  }
  const list = PROFILES[PROFILE] || PROFILES.mixed;
  console.log(`  路径配比：${list.map((x) => `${x.path}×${x.w}`).join('  ')}`);
  // 预热：让 ISR 把要打的页面都生成出来，否则测的是"冷启动渲染"
  for (const item of list) {
    await new Promise((res) => {
      http.get({ host: HOST, port: PORT, path: item.path }, (r) => { r.resume(); r.on('end', res); }).on('error', res);
    });
  }
  await new Promise((r) => setTimeout(r, 3000));
  console.log('\n并发 | 完成 | 秒 | rps | p50 | p95 | p99 | max | Mbps | 状态码 | socket 错误');
  for (const c of CONCURRENCIES) {
    const r = await runRound(list, c, TOTAL);
    const st = Object.entries(r.status).map(([k, v]) => `${k}:${v}`).join(' ');
    const er = r.errTotal ? JSON.stringify(r.errors) : '-';
    console.log(`${String(r.concurrency).padStart(5)} | ${String(r.requests).padStart(4)} | ${r.seconds.toFixed(1).padStart(5)} | ${String(r.rps).padStart(7)} | ${String(Math.round(r.p50)).padStart(4)} | ${String(Math.round(r.p95)).padStart(4)} | ${String(Math.round(r.p99)).padStart(4)} | ${String(Math.round(r.max)).padStart(5)} | ${String(r.mbps).padStart(6)} | ${st} | ${er}`);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
})();
