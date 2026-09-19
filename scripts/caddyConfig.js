#!/usr/bin/env node
/**
 * 生成 caddy 的 JSON 配置（容器启动时用）。
 *
 * 用法：node caddyConfig.js <模板路径> <permission|ask> [email]
 *
 * 为什么需要它：**Caddy 2.11 把 on-demand TLS 的 `ask` 换成了 permission 模块**
 *
 *   旧（≤2.9）：  "on_demand": { "ask": "http://127.0.0.1:3000/api/admin/caddy/ask" }
 *   新（≥2.11）： "on_demand": { "permission": { "module": "http", "endpoint": "同上" } }
 *
 * 用错形式，caddy 直接拒绝加载整份配置：
 *   `provisioning automation policy 0: on-demand TLS cannot be enabled without a
 *    permission module to prevent abuse`
 * 而镜像里的 caddy 是 `apk add` 装的，版本会随基础镜像漂移 —— 所以**不猜版本**：
 * entrypoint 会把两种形式都生成一次、各自 `caddy validate`，用通过的那个。
 *
 * 顺带把 `VAN_BLOG_EMAIL` 占位换成真实邮箱（在解析后的对象里换，不是文本替换：
 * 邮箱里万一有引号或反斜杠，文本替换会把整份 JSON 写坏）。
 *
 * ─── 模板里那几个超时/连接池数值为什么是这些值（JSON 不能写注释，只能记在这里）───
 *
 * 超时是 **server 级**的（Caddy 的 JSON 里它们是 server 对象上的扁平字段：
 * `read_timeout` / `read_header_timeout` / `write_timeout` / `idle_timeout` /
 * `max_header_bytes`，**没有** `timeouts` 这个包装对象 —— 那是 Caddyfile 全局选项的写法，
 * 写进 JSON 会因为未知字段被拒），所以**没法按路径分别设**。于是只能这样取舍：
 *
 *   read_header_timeout = 10s   Caddy 默认 1 分钟。请求头就 1KB 量级，10s 对移动网络也够；
 *                               这是 slowloris（发半个头一直挂着）的主要防线。
 *   idle_timeout        = 60s   Caddy 默认 **5 分钟**。压到 60s 是为了限制"攻击者停一堆空闲连接"
 *                               能占住的资源，同时不影响正常浏览的 keep-alive 复用
 *                               （浏览器连续点击都在秒级内）。与反代 transport 的 60s 一致，
 *                               也小于 Node 的 keepAliveTimeout(65s)。
 *   max_header_bytes    = 32768 Go 的默认是 **1MB** ⇒ 一万条连接各挂 1MB 头缓冲就是 10GB 量级的
 *                               内存放大。本站后台 token 存 localStorage、用 `token` 请求头传，
 *                               **不依赖 Cookie**，所以 32KB 绰绰有余（nginx 默认才 8KB），
 *                               同时给第三方评论(waline)可能带的 Cookie 留了余量。
 *   read_timeout        = **不设**（0 = 不限）。⚠️ 这是有意的：同一个 server 上挂着匿名的
 *                               **整站恢复上传（上限 8GiB**，见 `utils/restoreUpload.ts`）、
 *                               图片上传(50MB)与附件上传(200MB)。任何有限值都会把大恢复切断。
 *                               慢 body 攻击由 Node 那层兜：`requestTimeout`（默认 300s，
 *                               `VANBLOG_REQUEST_TIMEOUT_MS` 可调）+ JSON bodyLimit(1mb/50mb)
 *                               + multer 限额 + 恢复的体积/剩余空间闸门。
 *   write_timeout       = **不设**（0 = 不限）。整站备份下载与 200MB 附件在慢链路上
 *                               不能被写超时切断。
 *
 * 反代连接池 `max_idle_conns` 64→1024、`max_idle_conns_per_host` 32→512：
 * 原来一轮高并发结束后只留 32 条空闲上游连接，其余全关 ⇒ 大量 TIME_WAIT，且每轮重建连接
 * 会撞 Node 的 accept 队列（实测 C10K 下 502=3563、容器 netns 的 TcpExtListenOverflows=3745；
 * Node 侧已把 listen backlog 提到 4096，这里是另一半）。生产 compose 的 ulimits.nofile 是
 * 65536，512 条空闲连接的占用可以忽略。
 * ⚠️ waline(:8360) 那 14 个反代块原本**完全没有 transport** ⇒ 用 Go 默认的
 *    MaxIdleConnsPerHost=2，评论流量下 churn 更严重；本轮补齐成同一份。
 *
 * 日志滚动 `roll_size_mb`/`roll_keep`/`roll_keep_days`/`mode` 是**显式写出 Caddy 的默认值**
 * （100MB / 10 份 / 90 天 / 0600），不是新增限制：镜像里的 caddy 是 `apk add` 装的、版本不钉，
 * 默认值一旦漂移，"日志会不会写满盘"这个结论就跟着变。写死它 ⇒ 行为可复现、也能被守卫钉住。
 * ⚠️ 两个访问日志 logger 指向**同一个文件**是安全的：Caddy 按 `file:<filename>` 复用 writer
 *    （`FileWriter.WriterKey()`），不是两个独立的滚动器。
 */
const fs = require('fs');

const [, , templatePath, mode, emailArg] = process.argv;
if (!templatePath || (mode !== 'permission' && mode !== 'ask')) {
  process.stderr.write('用法: node caddyConfig.js <模板路径> <permission|ask> [email]\n');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const email = typeof emailArg === 'string' ? emailArg : '';

/** 递归把 VAN_BLOG_EMAIL 占位换成真实邮箱（空邮箱也照换：caddy 的 acme issuer 允许没有联系邮箱） */
function fillEmail(node) {
  if (Array.isArray(node)) {
    node.forEach(fillEmail);
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (node[key] === 'VAN_BLOG_EMAIL') {
        node[key] = email;
      } else {
        fillEmail(node[key]);
      }
    }
  }
}
fillEmail(config);

/**
 * 访问日志开关：`VANBLOG_CADDY_ACCESS_LOG=false|off|0|no` 时关闭（默认开启）。
 *
 * 为什么要有这个开关：① 访问日志含访客 IP，本身就是隐私面；② 被攻击时每秒上千条 JSON
 * 写盘是实打实的成本，站长可能宁愿不要这份日志也要保住磁盘与 IO。
 *
 * ⚠️ **只有明确的关闭字面量才关**：未设置、空值、拼错的值一律**保持开启**。
 *    方向是"失败时保留审计日志"，而不是"失败时静默丢掉日志"——与
 *    `VANBLOG_INIT_REQUIRE_SETUP_KEY` 的失败保护方向一致。
 *
 * ⚠️ 关闭时必须**整个替换 writer 对象**，只留 `{"output":"discard"}`：Caddy 对模块配置是
 *    **严格解码**的，`discard` writer 上残留 `filename`/`roll_*`/`mode` 这些 file writer
 *    专有的字段会让整份配置 validate 失败 —— 而 entrypoint 在 validate 失败时会退回
 *    **降级模板**（自签证书、无 on-demand TLS），等于"想关个日志结果把 HTTPS 弄没了"。
 *
 * 只关 log0/log1（访问日志）；`default`（/var/log/caddy.log）保留 —— 那是 caddy 自己的
 * 运行日志（TLS 签发失败、配置错误），不是访问日志，排障时离不开它。
 */
const ACCESS_LOG_OFF = new Set(['false', 'off', '0', 'no']);
const accessLogRaw = (process.env.VANBLOG_CADDY_ACCESS_LOG || '').trim().toLowerCase();
const accessLogDisabled = ACCESS_LOG_OFF.has(accessLogRaw);
if (accessLogDisabled) {
  const logs = config.logging && config.logging.logs;
  if (logs) {
    for (const name of Object.keys(logs)) {
      if (name === 'default') continue; // 运行日志保留
      const writer = logs[name] && logs[name].writer;
      // 只处理"写文件"的访问日志 logger，别把将来可能出现的其它 writer 误改掉
      if (writer && writer.output === 'file') {
        logs[name].writer = { output: 'discard' };
      }
    }
  }
}

/**
 * HSTS 的 max-age 可配置：`VANBLOG_HSTS_MAX_AGE`（**秒**），默认 31536000（一年 = 原有行为）。
 *
 * ## 为什么默认仍是一年、却要开这个口子
 *
 * 站长已裁定 HSTS 保持一年（不缩短）：它是"证书续签失败时浏览器硬失败"与"SSL-strip 降级攻击"
 * 之间的取舍，一年是主流做法。但**证书真出事故时**，站长必须能自己把它降下来或关掉 ——
 * 否则唯一的办法是改模板 + 重新构建镜像，而那正是最手忙脚乱的时刻最不该做的事。
 * 所以：`0` = **完全不发这个响应头**（紧急逃生口），其它正整数 = 该秒数。
 *
 * ⚠️ 关掉 HSTS 不能立刻救回已经被"钉住"的浏览器：max-age 是从**浏览器收到头的那一刻**开始算的，
 *    之前发过一年，那些浏览器在一年内仍会硬失败。逃生口的作用是**阻止继续扩大**受影响范围。
 *
 * ## 三条不许动摇的决定（守卫会钉住）
 *
 * 1. **只加在 :443 那个 server 上**（模板里的 srv0）。明文 HTTP 上发 HSTS，浏览器会直接忽略
 *    （RFC 6797 §8.1），只是噪音 ⇒ :80 的 srv1 不许有。
 * 2. **降级模板不发**。那份没有 `apps.tls`、HTTPS 是自签证书；在证书本来就不可信的路径上
 *    要求"一年只用 HTTPS"，等于把站长锁在自己站外面（浏览器不给"仍然前往"）。
 * 3. **不加 `includeSubDomains`，绝对不加 `preload`**：前者会把策略套到站长可能在别处跑的
 *    所有子域（任一子域证书出问题就在整个 max-age 内不可达），后者撤回以月计。
 *
 * 实现上这三条不是靠"记得只对 srv0 动手"来保证的，而是靠**只改已存在的键、绝不新建**：
 * 模板里哪个 server 有这个头，这里就只参数化那个；:80 与降级模板本来就没有这个键 ⇒
 * 结构上不可能被加上。下面写入时也是**整值替换**成 `max-age=<N>`，所以模板里万一被人
 * 塞进 `includeSubDomains`/`preload`，会在这一步被丢掉（并 WARN），不会发到线上。
 *
 * ## 取值判定（⚠️ 失败方向必须是"保持防护"，不是"静默关掉安全头"）
 *
 * - 未设置 / 空串 / 只有空白 ⇒ 默认一年。
 * - **垃圾值**（`abc`、`1年`、`86400.5`、`1e3`、`0x10`、`+86400`、负数）⇒ **回落默认 + WARN**。
 *   ⚠️ 绝不能把垃圾值当成 0：那等于"拼错一个字符就静默关掉一个安全头"。
 *   这也正是不能用 `Number(raw) || DEFAULT` 这种写法的原因 —— `Number('')` 是 0，
 *   而 0 在本变量里是**有意义的关闭指令**，两者必须分开处理。
 * - `0` ⇒ 不发头（唯一能关掉它的方式：显式写 0）。
 * - `1..299` ⇒ **照办但 WARN**。不夹到 300：既然 0（完全关闭）都允许，设一个 300 的下限
 *   就不是真的安全边界，反而会在紧急情况下悄悄改掉站长的明确意图。
 * - `300..63072000` ⇒ 原样使用。
 * - `>63072000`（两年）或超出安全整数 ⇒ **夹到 63072000 + WARN**。上界要夹是因为
 *   多打一个 0（`315360000` = 十年）是很现实的手误，而 HSTS 一旦发出去就撤回不了，
 *   这个方向的错误代价远大于"没照办站长的意图"。
 *
 * ⚠️ WARN 走 **stderr**（stdout 是要被重定向成 caddy.json 的，绝不能污染）。
 *    但 entrypoint 现在两处调用都带 `2>/dev/null`，所以这些 WARN 在容器日志里**看不到**，
 *    只有手动跑本脚本或跑守卫时可见。要让站长看得见，需要 entrypoint 不再丢弃 stderr
 *    （`entrypoint.sh` 不在本文件的改动范围内，已作为待办报给父代理）。
 */
const HSTS_HEADER = 'Strict-Transport-Security';
const HSTS_DEFAULT_MAX_AGE = 31536000; // 一年
const HSTS_WEAK_BELOW = 300; // 小于这个秒数的 HSTS 基本没有防护意义（照办但 WARN）
const HSTS_MAX_ALLOWED = 63072000; // 两年：preload 列表要求的量级，也是"手误多打一个 0"的上界

/** 把环境变量的原始值解析成 { maxAge, warns }；maxAge === 0 表示"不发这个头"。 */
function resolveHstsMaxAge(raw) {
  const warns = [];
  const text = typeof raw === 'string' ? raw.trim() : '';

  // 未设置 / 空串 ⇒ 默认（⚠️ 这一步必须在任何 Number() 之前：Number('') === 0，
  //    而 0 是"关闭安全头"的合法指令，绝不能让空值走到那里）
  if (text === '') return { maxAge: HSTS_DEFAULT_MAX_AGE, warns };

  // 只接受纯十进制非负整数。这一条同时挡掉：负数、小数、1e3、0x10、+86400、"1年"、"86400 "（已 trim）
  if (!/^[0-9]+$/.test(text)) {
    warns.push(
      `VANBLOG_HSTS_MAX_AGE='${text}' 不是非负整数秒，已回落到默认 ${HSTS_DEFAULT_MAX_AGE}（一年）；` +
        '注意拼错的值不会被当成 0（那会静默关掉 HSTS）',
    );
    return { maxAge: HSTS_DEFAULT_MAX_AGE, warns };
  }

  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    warns.push(`VANBLOG_HSTS_MAX_AGE='${text}' 超出安全整数范围，已夹到 ${HSTS_MAX_ALLOWED}`);
    return { maxAge: HSTS_MAX_ALLOWED, warns };
  }
  if (n === 0) {
    warns.push(
      'VANBLOG_HSTS_MAX_AGE=0 ⇒ 不再下发 Strict-Transport-Security 响应头（紧急逃生口）。' +
        '⚠️ 已经收到过 HSTS 的浏览器在其 max-age 内仍会硬失败，关掉只能阻止继续扩大影响范围',
    );
    return { maxAge: 0, warns }; // 显式关闭，这是唯一能关掉它的方式
  }
  if (n > HSTS_MAX_ALLOWED) {
    warns.push(
      `VANBLOG_HSTS_MAX_AGE=${n} 超过上限，已夹到 ${HSTS_MAX_ALLOWED}（两年）；` +
        'HSTS 发出去就撤回不了，多打一个 0 的代价是十年',
    );
    return { maxAge: HSTS_MAX_ALLOWED, warns };
  }
  if (n < HSTS_WEAK_BELOW) {
    warns.push(
      `VANBLOG_HSTS_MAX_AGE=${n} 秒小于 ${HSTS_WEAK_BELOW}，HSTS 基本起不到防护作用（已按你的设置生效）；` +
        '要完全关掉请显式写 0',
    );
  }
  return { maxAge: n, warns };
}

const { maxAge: hstsMaxAge, warns: hstsWarns } = resolveHstsMaxAge(process.env.VANBLOG_HSTS_MAX_AGE);

/**
 * 把 max-age 应用到**已经存在**该头的地方（绝不新建）。
 * @returns {{applied:number, removed:number, dropped:string[]}} 供守卫与 WARN 使用
 */
function applyHstsMaxAge(node, stats) {
  if (Array.isArray(node)) {
    node.forEach((child) => applyHstsMaxAge(child, stats));
    return stats;
  }
  if (!node || typeof node !== 'object') return stats;

  // 只认 caddy 的 headers handler：response.set / response.add 里的键值对
  if (node.handler === 'headers' && node.response && typeof node.response === 'object') {
    for (const op of ['set', 'add']) {
      const bag = node.response[op];
      if (!bag || typeof bag !== 'object' || !Object.prototype.hasOwnProperty.call(bag, HSTS_HEADER)) continue;
      const before = Array.isArray(bag[HSTS_HEADER]) ? bag[HSTS_HEADER].join('; ') : String(bag[HSTS_HEADER]);
      if (hstsMaxAge === 0) {
        delete bag[HSTS_HEADER];
        stats.removed += 1;
        continue;
      }
      // ⚠️ 整值替换：模板里若被人塞了 includeSubDomains / preload，在这一步被丢掉
      const wanted = `max-age=${hstsMaxAge}`;
      for (const directive of ['includesubdomains', 'preload']) {
        if (before.toLowerCase().includes(directive)) stats.dropped.push(directive);
      }
      bag[HSTS_HEADER] = [wanted];
      stats.applied += 1;
    }
  }

  for (const key of Object.keys(node)) applyHstsMaxAge(node[key], stats);
  return stats;
}

const hstsStats = applyHstsMaxAge(config, { applied: 0, removed: 0, dropped: [] });
for (const w of hstsWarns) process.stderr.write(`[caddyConfig] ⚠️ ${w}\n`);
// 用了非默认值时留一行痕迹（排障时能确认"线上那份配置到底是按哪个值生成的"）
if (hstsMaxAge !== HSTS_DEFAULT_MAX_AGE) {
  process.stderr.write(
    `[caddyConfig] HSTS max-age=${hstsMaxAge}（改写 ${hstsStats.applied} 处、移除 ${hstsStats.removed} 处）\n`,
  );
}
if (hstsStats.dropped.length > 0) {
  process.stderr.write(
    `[caddyConfig] ⚠️ HSTS 里出现了 ${[...new Set(hstsStats.dropped)].join('/')}，已丢弃：` +
      'includeSubDomains 会波及站长可能在别处跑的所有子域，preload 撤回以月计\n',
  );
}
// ⚠️ 这里**故意不**为"模板里本来就没有 HSTS 头"发提示：降级模板本来就没有（那是设计决定），
//    每次生成都打一行等于噪音；而"主模板的 HSTS 被人删了"这种情况由守卫负责发现
//    （scripts/tests/caddy-config.test.sh 里有一条直接读模板断言 srv0 必须有这个头）。

const tls = config.apps && config.apps.tls;
const automation = tls && tls.automation;
const onDemand = automation && automation.on_demand;
if (onDemand) {
  const endpoint = onDemand.ask || (onDemand.permission && onDemand.permission.endpoint);
  if (endpoint) {
    delete onDemand.ask;
    delete onDemand.permission;
    if (mode === 'permission') {
      onDemand.permission = { module: 'http', endpoint };
    } else {
      onDemand.ask = endpoint;
    }
  }
}

process.stdout.write(JSON.stringify(config));
