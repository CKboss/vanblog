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
 *    entrypoint 曾经在这两处调用上带 `2>/dev/null`，于是所有 WARN 在容器日志里都看不到
 *    （"站长把值设错了"因此永远静默）；那条已在 `6fff2ed4` 修掉，现在 stderr 会正常进
 *    `podman logs` / `docker logs`。
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

/**
 * 站点级 CSP：`VANBLOG_CSP_MODE=off|report|enforce`（默认 **report**）。
 *
 * ## 为什么落点在 caddy，而不是应用层
 *
 * 应用层的 `securityHeadersMiddleware`（`packages/server/src/utils/rateLimit.ts`）只在
 * `matchesPreNestPrefix` 那 4 个前缀上生效（`/static/`、`/rss/`、`/sitemap`、`/swagger`），
 * 而**前台是独立的 Next 进程、后台是 caddy 直接 file_server 的静态产物**，两者都不经过它
 * ⇒ 在 caddy 这一层之前，**全站页面没有任何 CSP**。这里补的正是那一段。
 * 应用层那三条（`frame-ancestors`/`object-src`/`base-uri`）保留，作为"不经 caddy 部署"的兜底。
 *
 * ⚠️ 两层会**同时出现在同一个响应上**（实测，不是推断：真 caddy v2.11.4 + 一个也设 CSP 的上游，
 *    `reverse_proxy` **不覆盖**上游的头，响应里出现**两条** `Content-Security-Policy`）。
 *    按 CSP 规范浏览器会**同时执行两条策略**（等效于取交集），而这里下发的策略在那三条指令上
 *    与应用层**取值完全相同**（`frame-ancestors 'self'`、`object-src 'none'`、`base-uri 'none'`），
 *    所以并存不会互相削弱，也不会产生"哪条生效"的不确定性。
 * ⚠️ 同一层内部：**后一条 `set` 会覆盖前一条**（实测），所以将来要给 `/admin*` 单独下发更严的
 *    策略是可行的；而 `add` 是追加（实测会出现三条头），不要用 `add`。
 * ⚠️ `headers` handler **没有 `defer` 字段**（v2.11.4 严格解码会以 `unknown field "defer"` 拒绝整份配置
 *    ⇒ entrypoint 退回降级模板 ⇒ HTTPS 静默变自签）。别照着 Caddyfile 的 `header defer` 写法搬。
 *
 * ## 为什么默认是 report 而不是 enforce，以及 `'unsafe-inline'` 为什么去不掉
 *
 * `script-src` 必须带 `'unsafe-inline'`，这**不是偷懒而是结构性的**，证据来自真实构建产物：
 * - `packages/admin/dist/index.html`：**2 个裸内联 `<script>`**（umi 3 运行时，不支持 nonce）；
 * - `packages/website/.next/server/pages/index.html`：**7 个内联脚本** = JSON-LD、
 *   `vanblog-theme-init`（THEME_INIT_SCRIPT）、**5 个 Next.js 自己发出的裸内联脚本**，
 *   外加站长在「定制化」里配的第三方统计（也是内联的）。
 * - 而这些 HTML 是**被 caddy 直接 `file_server` 的缓存文件**（ISR 产物）⇒ **nonce 不可能**：
 *   nonce 会被烤进缓存文档，同源 XSS 本来就能读到那份 HTML，等于零防护；
 *   **hash 也不现实**：Next 的内联脚本每次构建都变，要把它塞进 caddy 配置等于每次构建改配置。
 *
 * ⚠️ 所以请**如实**理解这一层的价值，别把它说成"已防住 XSS"：
 * 带 `'unsafe-inline'` 的 CSP **挡不住内联脚本注入**，但仍然挡得住
 * ①加载攻击者的**外链**脚本（`<script src="https://evil/x.js">`，这是挂马/挖矿最常见的投递方式）、
 * ②`<object>`/`<embed>` 与 `<base>` 劫持、③被 iframe 嵌进钓鱼页（`frame-ancestors`）、
 * ④表单提交到站外（`form-action`）、⑤**把数据外传到攻击者域名**（`connect-src`/`img-src` 白名单）。
 * 第 ⑤ 条在"敌意环境下持续发布信息"的场景里价值最高：它把"注入成功"与"数据能送出去"解耦。
 *
 * 默认 `report` 的理由：`Content-Security-Policy-Report-Only` **不阻断任何东西**，只让浏览器上报违规。
 * 默认 `enforce` 会打坏未知数量的站点（站长的自定义统计、字体、图床外链各不相同，见下面的
 * "白名单不可能预先写全"）；默认 `off` 又等于什么都没做 ⇒ report 是唯一能"先看清会打坏什么"的默认值。
 *
 * ## 白名单不可能预先写全 ⇒ 必须给站长扩展入口
 *
 * 「定制化」里的 `customScript`/`customHtml` 是**站长自己填的**，可以引用任意第三方域名。
 * 实测这台机器上的构建产物里就有百度统计、GA、51la、以及一个 time.is 时钟挂件 —— 后两个不在
 * 我们的默认白名单里。所以除了 `VANBLOG_CSP_EXTRA_SCRIPT_SRC` / `_EXTRA_CONNECT_SRC`，
 * 还提供 `VANBLOG_CSP_OVERRIDE`（整条策略自己写）。⚠️ **没有提供"追加任意指令"的入口**：
 * 同一条策略里**重复的指令只有第一条生效**（CSP 规范），把 `; script-src ...` 追加到末尾会被静默忽略，
 * 那种"看起来配上了其实没生效"的旋钮比没有更糟。
 */
const CSP_HEADER = 'Content-Security-Policy';
const CSP_REPORT_HEADER = 'Content-Security-Policy-Report-Only';
const CSP_MODES = new Set(['off', 'report', 'enforce']);
const CSP_DEFAULT_MODE = 'report';

/** 我们自己的代码引用到的第三方来源（逐个从源码核过；站长自己加的统计不在这里，见 EXTRA_*）。 */
const CSP_SCRIPT_SRC = ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com', 'https://hm.baidu.com'];
const CSP_STYLE_SRC = ["'self'", "'unsafe-inline'", 'https://static.zeoseven.com', 'https://cdn.jsdelivr.net'];
/** 正文可以嵌任意外链图片（图床/外链转存），所以这里只能是 `*`；`data:` 要显式写（`*` 不含它）。 */
const CSP_IMG_SRC = ['*', 'data:', 'blob:'];
const CSP_FONT_SRC = ["'self'", 'data:', 'https://static.zeoseven.com', 'https://cdn.jsdelivr.net'];
const CSP_CONNECT_SRC = [
  "'self'",
  'https://www.google-analytics.com',
  'https://analytics.google.com',
  'https://region1.google-analytics.com',
  'https://hm.baidu.com',
];
/** 正文允许 `<iframe>`（B 站/YouTube 嵌入，见 markdownSanitize 的白名单），所以 frame-src 要放行 https。 */
const CSP_FRAME_SRC = ["'self'", 'https:'];
/** 这三条与应用层 `securityHeadersMiddleware` 取值一致（见文件头"两层并存"那段），`form-action` 是这里新增的。 */
const CSP_FIXED_TAIL = ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"];

/** 拒 CR/LF 与其它控制字符：这些值会被写进**响应头**，不能让它们变成头注入。 */
function hasControlChars(text) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text);
}

/** 解析模式：未设置/空 ⇒ 默认 report；垃圾值 ⇒ **回落默认 + WARN，绝不当成 off**。 */
function resolveCspMode(raw) {
  const warns = [];
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '') return { mode: CSP_DEFAULT_MODE, warns };
  if (CSP_MODES.has(text)) return { mode: text, warns };
  warns.push(
    `VANBLOG_CSP_MODE='${text}' 不是 off/report/enforce 之一，已回落到默认 ${CSP_DEFAULT_MODE}` +
      '（Report-Only，只上报不阻断）；注意拼错的值不会被当成 off',
  );
  return { mode: CSP_DEFAULT_MODE, warns };
}

/** 解析"追加到某个指令里的来源列表"：按空白切分，拒控制字符与分号（分号会另起一条指令）。 */
function resolveCspExtra(raw, name, warns) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return [];
  if (hasControlChars(text)) {
    warns.push(`${name} 含控制字符（CR/LF 等），已整条忽略：这些值会进响应头，不允许出现头注入形状`);
    return [];
  }
  if (text.includes(';')) {
    warns.push(`${name} 含分号，已整条忽略：同一策略里重复的指令只有第一条生效，追加指令会被静默忽略；` +
      '要改写整条策略请用 VANBLOG_CSP_OVERRIDE');
    return [];
  }
  return text.split(/\s+/).filter(Boolean);
}

const cspWarns = [];
// ⚠️ 只解析一次：第一版为了拿 warns 又调了一遍 resolveCspMode（同一个输入解析两次），
//    行为上无害但读起来像"两次可能不同"，而且将来若给它加了副作用就会变成真 bug。
const { mode: cspMode, warns: cspModeWarns } = resolveCspMode(process.env.VANBLOG_CSP_MODE);
for (const w of cspModeWarns) cspWarns.push(w);

const cspRawOverride = (process.env.VANBLOG_CSP_OVERRIDE || '').trim();
let cspOverride = '';
if (cspRawOverride !== '') {
  if (hasControlChars(cspRawOverride)) {
    cspWarns.push('VANBLOG_CSP_OVERRIDE 含控制字符（CR/LF 等），已整条忽略并改用内置策略');
  } else {
    cspOverride = cspRawOverride;
  }
}

const cspExtraScript = resolveCspExtra(process.env.VANBLOG_CSP_EXTRA_SCRIPT_SRC, 'VANBLOG_CSP_EXTRA_SCRIPT_SRC', cspWarns);
const cspExtraConnect = resolveCspExtra(process.env.VANBLOG_CSP_EXTRA_CONNECT_SRC, 'VANBLOG_CSP_EXTRA_CONNECT_SRC', cspWarns);

/** 拼出最终策略字符串。@returns {string} 空串表示"不下发任何 CSP 头"。 */
function buildCspPolicy() {
  if (cspMode === 'off') return '';
  if (cspOverride) {
    // OVERRIDE 只补 report-uri（站长没写才补），其余原样使用 —— 这是逃生口，不要"帮"站长改策略
    const withReport = cspReportUri && !/(^|[;\s])report-uri\s/.test(cspOverride)
      ? `${cspOverride.replace(/;\s*$/, '')}; report-uri ${cspReportUri}`
      : cspOverride;
    return withReport;
  }
  const scriptSrc = [...CSP_SCRIPT_SRC, ...cspExtraScript];
  const connectSrc = [...CSP_CONNECT_SRC, ...cspExtraConnect];
  const parts = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src ${CSP_STYLE_SRC.join(' ')}`,
    `img-src ${CSP_IMG_SRC.join(' ')}`,
    `font-src ${CSP_FONT_SRC.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    `frame-src ${CSP_FRAME_SRC.join(' ')}`,
    ...CSP_FIXED_TAIL,
  ];
  if (cspReportUri) parts.push(`report-uri ${cspReportUri}`);
  return parts.join('; ');
}

/**
 * 报告端点：默认**不设**（不发 `report-uri`/`report-to`）。
 *
 * ⚠️ 刻意**不在本项目内提供收集端点**：一个匿名可写的收集接口就是现成的 DoS 与日志炸弹
 *    （攻击者可以每秒打几千条违规报告，写满磁盘、淹掉真日志），而 CSP 报告里还带着页面 URL 与
 *    被拦资源地址。要收报告就指向站长自己的日志服务。
 */
const cspReportRaw = (process.env.VANBLOG_CSP_REPORT_URI || '').trim();
let cspReportUri = '';
if (cspReportRaw !== '') {
  if (hasControlChars(cspReportRaw)) {
    cspWarns.push('VANBLOG_CSP_REPORT_URI 含控制字符，已忽略（不发 report-uri）');
  } else if (!/^https?:\/\/[^\s;]+$/i.test(cspReportRaw)) {
    cspWarns.push(
      `VANBLOG_CSP_REPORT_URI='${cspReportRaw}' 不是 http(s) URL，已忽略（不发 report-uri）；` +
        '⚠️ 拼错的值不会被当成"关闭"以外的别的意思，报告功能只是不生效',
    );
  } else if (cspReportRaw.includes(';')) {
    cspWarns.push('VANBLOG_CSP_REPORT_URI 含分号，已忽略（避免注入别的指令）');
  } else {
    cspReportUri = cspReportRaw;
  }
}

const cspPolicy = buildCspPolicy();
const cspHeaderName = cspMode === 'enforce' ? CSP_HEADER : CSP_REPORT_HEADER;

/**
 * 把 CSP 挂到**全局那个** headers handler 上（判据：`set` 里含 `X-Content-Type-Options`，
 * 两个 server 各一处，共 2 处）。⚠️ 用这个判据而不是"routes[0]"，是因为将来 route 顺序变了
 * 也不该让 CSP 静默消失；守卫会断言"恰好改写了 2 处"，0 处或 3 处都算失败。
 * @returns {{applied:number, removed:number}}
 */
function applyCsp(node, stats) {
  if (Array.isArray(node)) {
    node.forEach((child) => applyCsp(child, stats));
    return stats;
  }
  if (!node || typeof node !== 'object') return stats;

  if (node.handler === 'headers' && node.response && typeof node.response === 'object') {
    const bag = node.response.set;
    if (bag && typeof bag === 'object' && Object.prototype.hasOwnProperty.call(bag, 'X-Content-Type-Options')) {
      // 两种模式的头名不同：切换模式时必须把另一个删掉，否则同一个响应上会同时挂
      // "强制"和"只上报"两条策略（浏览器会同时执行，等于站长以为在观察、其实已经在阻断）。
      delete bag[CSP_HEADER];
      delete bag[CSP_REPORT_HEADER];
      if (cspPolicy) {
        bag[cspHeaderName] = [cspPolicy];
        stats.applied += 1;
      } else {
        stats.removed += 1;
      }
    }
  }

  for (const key of Object.keys(node)) applyCsp(node[key], stats);
  return stats;
}

const cspStats = applyCsp(config, { applied: 0, removed: 0 });
for (const w of cspWarns) process.stderr.write(`[caddyConfig] ⚠️ ${w}\n`);
process.stderr.write(
  cspPolicy
    ? `[caddyConfig] CSP mode=${cspMode}（头名 ${cspHeaderName}，改写 ${cspStats.applied} 处）` +
      `${cspReportUri ? '，report-uri 已设' : '，未设 report-uri'}` +
      `${cspOverride ? '，使用 VANBLOG_CSP_OVERRIDE 的自定义策略' : ''}\n`
    : `[caddyConfig] CSP mode=off（不下发任何 CSP 头，移除 ${cspStats.removed} 处）\n`,
);
if (cspMode === 'report' && cspPolicy) {
  process.stderr.write(
    '[caddyConfig] ⚠️ Report-Only **不阻断任何东西**，它只是让浏览器上报违规；' +
      '观察一段时间后确认没有误伤，再设 VANBLOG_CSP_MODE=enforce 才会真正生效\n',
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * VANBLOG_CADDY_HTML_PAGES_DIR：caddy 直服 ISR HTML 时去哪个目录找产物
 *
 * 🔴 这一节修的是一个**静默失效**的缺陷（2026-09 实测确认）：服务端
 * `provider/caddy/caddy.provider.ts` 读这个变量决定**哨兵文件写到哪个目录**
 * （`process.env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR`），
 * 而本生成器以前对它**命中 0 次**、两份模板各自把 root 硬编码成同一个路径 ⇒
 * 设了这个变量，哨兵写到别处、caddy 仍在老地方找，`VANBLOG_CADDY_SERVE_HTML`
 * 一声不响地失效（没有报错、没有日志、没有 500）。今天两侧一致纯属巧合。
 * 站长已把"数据库不可达进入降级驻留时自动开直服"押在这个机制上
 * （`utils/degradedServeHtml.ts`），所以这条路径上不能有静默失效的旋钮。
 *
 * ⚠️ 本文件**不复制那个路径字面量**：改写目标按**结构**定位（group 为
 * `vanblog-serve-html` 的那条路由子树里的 `vars.root`），未设置该变量时
 * 一个字都不改、直接沿用模板里的值，日志里报的"当前生效目录"也是**从配置里读出来的**。
 * 这样生成器就不可能与模板/TS 常量漂移（少一份需要人肉保持一致的副本）。
 * 三处字面量（TS 常量 + 两份模板各 2 处）的一致性由守卫钉住，见
 * `scripts/tests/caddy-config.test.sh` 的"跨文件"那一节。
 *
 * ⚠️ 为什么校验必须在这里做、而不能指望 caddy：用真 caddy v2.11.4 实测，
 * `caddy validate` 对 root='/'、root='{env.HOME}/x'、root='/tmp/a/../b' **全部通过**
 * （它只校验 JSON 结构与模块字段，不校验路径语义）。而 root 会变成 `file_server`
 * 的根，所以垃圾值是有安全后果的：
 *   - `{env.X}` **会在运行时被展开**：实测把 root 写成 `{env.PROBE_SECRET_DIR}`、
 *     该环境变量指向另一个目录，请求 `/probe.html` 返回 **200 且内容来自那个目录**
 *     （正对照：字面量正确目录 200；负对照：字面量错误目录 404）⇒ 占位符一律拒绝；
 *   - `/` 会让 file_server 以**整个文件系统**为根（放行路径仍受路由白名单与
 *     `.html` 后缀约束，但这不是我们想要的失败形状）；
 *   - `..` 能把可发布范围移出产物目录。
 * 拒绝时的失败方向是"**沿用模板默认目录 + 大声 WARN**"，绝不是"关掉直服功能"，
 * 也绝不是让整份配置 validate 失败（那会让 entrypoint 退回降级模板、HTTPS 静默变自签）。
 * ────────────────────────────────────────────────────────────────────────── */
const PAGES_DIR_ENV = 'VANBLOG_CADDY_HTML_PAGES_DIR';
const SERVE_HTML_ROUTE_GROUP = 'vanblog-serve-html';
/** 期望在一份生成结果里找到的：serve-html 路由条数 / 其中的 vars.root 个数（srv0 + srv1） */
const PAGES_DIR_EXPECTED_GROUPS = 2;
const PAGES_DIR_EXPECTED_ROOTS = 2;

/**
 * 纯校验函数（有单测钉住每个分支）：返回 `dir=null` 表示"不改写模板，沿用默认"。
 * ⚠️ 拒绝一个值时**必须**同时说清后果：服务端仍会按这个值写哨兵，于是两侧不一致、
 * 直服不生效 —— 把静默失效变成一条能照做的日志，这正是本次修复的核心。
 * @returns {{dir: string|null, warns: string[]}}
 */
function resolvePagesDir(raw) {
  const warns = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { dir: null, warns }; // 未设置/空 ⇒ 不改写，也不 WARN
  const reject = (why) => {
    warns.push(
      `${PAGES_DIR_ENV}='${text}' 已被忽略：${why}。已沿用模板里的默认产物目录。` +
        // ⚠️ 这句文案在 2026-09-20 之前说的是"服务端仍会把哨兵写到你给的路径 ⇒ 两侧不一致、直服不生效"。
        //    那时是真的；现在服务端三处调用点也都走 resolveWebsitePagesDir()、同样回落默认目录
        //    （见 provider/caddy/caddy.provider.ts），两侧规则由**跨语言守卫**逐条钉住：
        //    scripts/tests/caddy-pages-dir-parity.test.sh + provider/caddy/pagesDirParity.spec.ts
        //    共用同一张取值表 scripts/tests/fixtures/pages-dir-cases.json。
        //    🔴 留着旧文案会让运维去查一个**已经不存在**的不一致 —— 过期的解释比没有解释更糟。
        ' ⚠️ 服务端也会用同样的规则回落到默认目录（两侧规则由跨语言守卫逐条钉住），' +
        '所以哨兵与 caddy 的 root 仍然一致、直服不会因此失效 —— 但请修正这个值，或直接取消该环境变量。',
    );
    return { dir: null, warns };
  };
  if (hasControlChars(text)) return reject('含控制字符（CR/LF/NUL 等），这个值会原样进 caddy 的 JSON 配置');
  if (text.includes('{') || text.includes('}')) {
    return reject(
      '含花括号：caddy 会在**运行时**把它当占位符展开（实测 root 写成 {env.X} 时，' +
        'file_server 真的从那个环境变量指向的目录发文件），所以这里不接受任何占位符形状',
    );
  }
  if (!text.startsWith('/')) {
    return reject('不是绝对路径（必须以 / 开头）：相对路径会相对 caddy 的工作目录解析，等于把产物目录交给一个你没指定的位置');
  }
  if (text.split('/').includes('..')) {
    return reject('含 .. 段：这个值会成为 file_server 的根，.. 能把可发布范围移到产物目录之外');
  }
  const norm = text.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (norm === '') {
    return reject('规范化后就是文件系统根 /：那会让 file_server 以整个文件系统为根');
  }
  if (norm !== text) {
    warns.push(`${PAGES_DIR_ENV} 已规范化：'${text}' → '${norm}'（合并重复斜杠、去掉结尾斜杠）`);
  }
  return { dir: norm, warns };
}

const { dir: pagesDir, warns: pagesDirWarns } = resolvePagesDir(process.env[PAGES_DIR_ENV]);

/**
 * 按**结构**定位改写点：group 为 `vanblog-serve-html` 的路由子树里的 `vars` handler 的 `root`。
 * ⚠️ 判据用 group 名而不是"root 等于某个字面量"，这样模板里的路径将来变了也不会静默失配；
 * 也**不会**误伤静态图那条路由的 `{"handler":"vars","root":"/app"}`（它在别的 group 里）。
 * 每个 server 各一条 ⇒ 一份配置里应当恰好 2 处；数量不对就大声 WARN（形状变了）。
 * @returns {{groups:number, found:number, applied:number, effective:string}}
 */
function applyPagesDir(node, stats) {
  if (Array.isArray(node)) {
    node.forEach((child) => applyPagesDir(child, stats));
    return stats;
  }
  if (!node || typeof node !== 'object') return stats;

  if (node.group === SERVE_HTML_ROUTE_GROUP) {
    stats.groups += 1;
    const found = [];
    const collect = (n) => {
      if (Array.isArray(n)) return n.forEach(collect);
      if (!n || typeof n !== 'object') return undefined;
      if (n.handler === 'vars' && typeof n.root === 'string') found.push(n);
      for (const k of Object.keys(n)) collect(n[k]);
      return undefined;
    };
    collect(node);
    stats.found += found.length;
    for (const vars of found) {
      if (!stats.effective) stats.effective = vars.root; // 模板里的默认值（未设置该变量时它就是生效值）
      if (pagesDir) {
        vars.root = pagesDir;
        stats.applied += 1;
      }
    }
    return stats; // 这条子树已处理完，不再往里递归（避免重复计数）
  }

  for (const key of Object.keys(node)) applyPagesDir(node[key], stats);
  return stats;
}

const pagesDirStats = applyPagesDir(config, { groups: 0, found: 0, applied: 0, effective: '' });
for (const w of pagesDirWarns) process.stderr.write(`[caddyConfig] ⚠️ ${w}\n`);
if (pagesDirStats.groups !== PAGES_DIR_EXPECTED_GROUPS || pagesDirStats.found !== PAGES_DIR_EXPECTED_ROOTS) {
  process.stderr.write(
    `[caddyConfig] ⚠️ 在配置里找到 ${pagesDirStats.groups} 条 ${SERVE_HTML_ROUTE_GROUP} 路由、` +
      `${pagesDirStats.found} 个 vars.root（期望 ${PAGES_DIR_EXPECTED_GROUPS}/${PAGES_DIR_EXPECTED_ROOTS}）：` +
      '模板形状变了，' +
      (pagesDir
        ? `${PAGES_DIR_ENV} 可能没有被完整应用到所有 server 上`
        : '不影响本次输出，但请检查模板与守卫'),
  );
  process.stderr.write('\n');
}
process.stderr.write(
  pagesDir
    ? `[caddyConfig] caddy 直服 HTML 的产物目录 = ${pagesDir}（来自 ${PAGES_DIR_ENV}，改写 ${pagesDirStats.applied} 处）\n`
    : `[caddyConfig] caddy 直服 HTML 的产物目录 = ${pagesDirStats.effective || '(未找到)'}（模板默认；${PAGES_DIR_ENV} 未设置或未生效）\n`,
);

/* ─────────────────────────────────────────────────────────────────────────────
 * 降级期直服 RSS / sitemap 落盘产物
 *
 * ## 要解决的问题（活体实测出来的，不是推理）
 * 站点进入「降级驻留」（数据库在启动期不可达、Nest 没起来、占位监听器接管端口）时，
 * 页面已经能由 caddy 按哨兵直发磁盘 HTML（`vanblog-serve-html` 路由），但实测：
 *   `/`                → 200（磁盘 HTML）      `/post/<别名>` → 200（磁盘 HTML）
 *   `/static/img/*`    → 200（caddy 直服）    `/api/public/health` → 503 degraded
 *   🔴 `/rss/feed.xml` → **503**              `/sitemap.xml` → 503
 * 也就是说「被打瘫时仍能发布内容」这条能力**不含订阅源** —— 而 RSS 恰恰是敌意环境下
 * 最省流量、最难被阻断的发布通道（很多读者与镜像站只拉 feed）。
 *
 * ## 为什么这件事是安全的、且没有引入新的取舍
 * `/rss/*` 与 `/sitemap/*` 在 server 侧**本来就是静态目录服务**，不是每请求动态生成：
 *   `main.ts`: `app.useStaticAssets(path.join(staticPath,'rss'),     { prefix: '/rss/' })`
 *              `app.useStaticAssets(path.join(staticPath,'sitemap'), { prefix: '/sitemap/' })`
 * 产物由 ISR 风暴写入（`provider/rss/rss.provider.ts` → `<staticPath>/rss/{feed.xml,atom.xml,feed.json}`，
 * `provider/sitemap/sitemap.provider.ts` → `<staticPath>/sitemap/sitemap.xml`），都是 tmp+rename 原子写。
 * ⇒ 降级期直服的就是**正常模式下 express 会发的同一批字节**，新鲜度语义完全相同
 *   （都取决于上一次 ISR 风暴），不存在「降级才变陈旧」的额外代价。
 *
 * ## 🔴 必须覆盖别名路由（这条是实测出来的，别只看 `/rss/*`）
 * 后台/前台交给读者的地址是**别名形式**：`components/AuthorCard/index.tsx` 的 `href={'/feed.xml'}`、
 * `components/RssButton/index.tsx` 复制到剪贴板的也是 `/feed.xml`（只有 feed 自身的 `feedLinks`
 * 元数据写 `rss/feed.xml`）。所以只门控 `/rss/*` 的话，降级时读者手里那个 `/feed.xml` 仍然 503
 * ⇒ 等于没修。模板里这 5 条路由（`/rss/*`、`/sitemap.xml`、`/feed.xml`、`/feed.json`、`/atom.xml`）
 * 在 **2 个模板 × 2 个 server** 上共 20 处，全部注入。
 *
 * ## 实现方式：生成期注入（与 CSP、pages-dir 同一套路），模板一个字不改
 * 好处：一处实现覆盖全部 20 处；`off` 时产物与模板逐字节相同；主模板与降级模板不会漂移。
 *
 * ## 🔴 root 必须是**最窄**的那个子目录，绝不能是 staticPath 本身
 * 用真 caddy v2.11.4 实测过（正对照 + 负对照，见 scripts/tests/caddy-config.test.sh）：
 *   - root=`<static>`（宽）时 `/broad/tmp/<归档名>` → **200 拿到内容** ⇒ 会暴露 `staticPath/tmp`
 *     里 in-flight 的**整站恢复归档**（`main.ts` 会 checkOrCreate `tmp`、`export`、`customPage`、
 *     `img`、`rss`、`sitemap`、`search`），以及图床与导出物；
 *   - root=`<static>/rss`（窄）时同样的穿越路径一律 **502/404，一个字节都没泄露**；
 *   - 两种 root 下都**逃不到 root 之上**（`../../` 与 `%2e%2e%2f` 各种编码都是 502/404）。
 * 所以这里只允许 `rss` 与 `sitemap` 两个白名单子目录，其余一律跳过 + WARN（绝不猜）。
 *
 * ## 哨兵 root 与产物 root 不是同一个目录 ⇒ 用 `file` matcher 自带的 `root` 字段
 * caddy 的 `file` matcher 用 `try_files`，而 **`try_files` 相对当前 `root` 解析**；哨兵在
 * pages 目录（`.next/server/pages`），产物在 `<static>/rss`。所以哨兵的存在性判断用
 * `match:[{file:{root:<pages>,try_files:[…]}}]`（root 只作用于这次判断），命中后再
 * `vars root=<static>/<subdir>` 给 `file_server`。⚠️ 不要改成"先插一个路由级 vars root=pages"：
 * 那会把 pages 目录泄漏给同一路由后面的 reverse_proxy 分支，而且每次加功能都会改变
 * pages-dir 守卫统计的「serve-html 之外的 root」集合。
 * ⚠️ pages root **从配置里回读**（serve-html 路由的 `vars.root`），不重新计算 ⇒
 *   它与 `VANBLOG_CADDY_HTML_PAGES_DIR` 天然一致，不可能出现「哨兵写 A、这里查 B」。
 * ⚠️ caddy 每个请求现查哨兵，所以**不需要 reload**（实测：写入后下一个请求立刻生效，
 *   删掉后立刻回落反代）。
 *
 * ## 门控用**主哨兵**（`.vanblog-caddy-serve-html`），不是 dynamic 那个
 * `resolveServeHtmlLevel`：`'all'` 写两个哨兵、`'true'`→`fixed` 只写主哨兵、其它→`off` 都不写；
 * 降级驻留按 `all` 档写两个。feed 是单个固定文件（更像「固定页」而不是「动态前缀」），
 * 所以用主哨兵 ⇒ `fixed` 与 `all` 两档都覆盖，且不需要 dynamic 档的语义。
 *
 * ## 故意不做的事
 * - **不覆盖 Content-Type**：caddy 对 `.xml` 推断 `text/xml; charset=utf-8`，express/mime 给
 *   `application/xml`；两者都是 RFC 7303 认可、阅读器普遍接受的形状，`.json` 则完全一致
 *   （都是 `application/json`）。降级期的对照是 **503**，所以 `text/xml` 远好于发不出去；
 *   手工覆盖反而多一处可能写错的地方。有守卫钉住「只设 Cache-Control 与标记头」。
 * - **不加 `upgrade-insecure-requests` 之类的额外头**；`X-Content-Type-Options: nosniff`
 *   由每个 server 顶部的全局 headers handler 下发，直服路径同样拿得到（实测确认）。
 * - 不动 `/static/*`、`/robots.txt`：robots 是 `robots.controller` 动态生成（要用库里的 baseUrl），
 *   没有落盘产物可直服 ⇒ 降级期它仍然 503，这是**已知缺口**，如实记录。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 与 server 侧 `loadConfig('static.path','/app/static')` 同一个 env、同一个默认值。 */
const STATIC_DIR_ENV = 'VAN_BLOG_STATIC_PATH';
const STATIC_DIR_DEFAULT = '/app/static';
/** 只允许这两个子目录当 `file_server` 的 root（理由见上面「root 必须最窄」那段）。 */
const FEED_ROOT_ALLOWLIST = new Set(['rss', 'sitemap']);
/** 降级期直服 feed 时打的标记头：既给运维/监控看，也是守卫与活体验证的判据。 */
const STATIC_FEED_HEADER = 'X-Vanblog-Static-Feed';
/** 哨兵文件名。⚠️ 必须与 `provider/caddy/caddy.provider.ts` 的 CADDY_SERVE_HTML_SENTINEL 逐字相同
 *  （生成器是独立进程、不能 import TS，所以这里复制字面量 —— 由守卫钉住两侧一致）。 */
const SERVE_HTML_SENTINEL_NAME = '.vanblog-caddy-serve-html';

/**
 * 解析 staticPath（校验规则与 `resolvePagesDir` 逐条对齐，因为两者都是「会进 caddy JSON 的目录」，
 * 写坏的后果同样是 validate 失败 ⇒ 退回降级模板 ⇒ HTTPS 静默变自签）。
 * ⚠️ 故意不复用 `resolvePagesDir`：它的 WARN 文案点名的是 pages-dir 那个变量，混用会报错报到
 *    另一个变量头上（本轮刚修过一次「过期文案误导运维」）。
 */
function resolveStaticDir(raw) {
  const warns = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { dir: STATIC_DIR_DEFAULT, provided: false, warns };
  const reject = (why) => {
    warns.push(
      `${STATIC_DIR_ENV}='${text}' 已被忽略：${why}。已回落到默认静态目录 ${STATIC_DIR_DEFAULT}。` +
        ' ⚠️ 服务端也用同一个变量解析 static.path（env 优先于 config.yaml），所以两侧仍然一致；' +
        '但如果你是想让降级期直服另一个目录里的 feed，请修正这个值。',
    );
    return { dir: STATIC_DIR_DEFAULT, provided: false, rejected: true, warns };
  };
  if (hasControlChars(text)) return reject('含控制字符（CR/LF/NUL 等），这个值会原样进 caddy 的 JSON 配置');
  if (text.includes('{') || text.includes('}')) {
    return reject('含 {} 占位符：caddy 会在**运行时**展开 {env.X}，等于把 file_server 的 root 交给环境变量');
  }
  if (!text.startsWith('/')) return reject('不是绝对路径（必须以 / 开头）');
  if (text.split('/').includes('..')) return reject('含 .. 段（root 会被移出预期目录）');
  let normalized = text.replace(/\/{2,}/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized !== text) {
    warns.push(`${STATIC_DIR_ENV}='${text}' 已规范化为 '${normalized}'（合并重复斜杠 / 去掉结尾斜杠）`);
  }
  if (normalized === '/') return reject('规范化后是文件系统根 /');
  return { dir: normalized, provided: true, warns };
}

/** 从**已生成的配置**里回读 serve-html 路由的 `vars.root`（= 哨兵所在目录）。
 *  ⚠️ 回读而不是重算：重算就多一份可能与 pages-dir 漂移的副本，而漂移的后果是「哨兵写在 A、
 *  这里查 B」⇒ 降级直服**静默失效**。找不到就返回 null，调用方跳过注入并 WARN（失败方向是
 *  「保持现状 503」，绝不是「猜一个目录」。 */
function findServeHtmlPagesRoot(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findServeHtmlPagesRoot(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (node.group === SERVE_HTML_ROUTE_GROUP) {
    let found = null;
    const collect = (n) => {
      if (found || Array.isArray(n)) {
        if (Array.isArray(n)) n.forEach(collect);
        return;
      }
      if (!n || typeof n !== 'object') return;
      if (n.handler === 'vars' && typeof n.root === 'string') found = n.root;
      for (const key of Object.keys(n)) collect(n[key]);
    };
    collect(node.handle);
    if (found) return found;
  }
  for (const key of Object.keys(node)) {
    const hit = findServeHtmlPagesRoot(node[key]);
    if (hit) return hit;
  }
  return null;
}

/** 从一条路由反推「产物子目录 + 要 strip 的前缀」。
 *  ⚠️ 优先看模板自己的 rewrite（别名路由把 /feed.xml 改写成 /rss/feed.xml），
 *  没有 rewrite 就看 match path（`/rss/*`）。这样目标目录**来自模板本身**，
 *  不是我另写的一张表 ⇒ 模板改了这里跟着改，不会漂移。
 *  只接受白名单里的子目录，其余返回 null（跳过 + WARN，绝不猜）。 */
function deriveFeedTarget(route) {
  const sub = route && route.handle && route.handle[0] && route.handle[0].routes;
  if (!Array.isArray(sub)) return null;
  let rewritten = null;
  const scan = (n) => {
    if (rewritten || Array.isArray(n)) {
      if (Array.isArray(n)) n.forEach(scan);
      return;
    }
    if (!n || typeof n !== 'object') return;
    if (n.handler === 'rewrite' && Array.isArray(n.uri_substring) && n.uri_substring[0]) {
      const rep = n.uri_substring[0].replace;
      if (typeof rep === 'string' && rep.startsWith('/')) rewritten = rep;
    }
    for (const key of Object.keys(n)) scan(n[key]);
  };
  scan(sub);
  const paths = (route.match && route.match[0] && route.match[0].path) || [];
  const source = rewritten || (typeof paths[0] === 'string' ? paths[0] : '');
  // `/rss/feed.xml` → `/rss`；`/rss/*` → `/rss`；`/sitemap/sitemap.xml` → `/sitemap`
  const m = /^\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(source);
  if (!m) return null;
  const subdir = m[1];
  if (!FEED_ROOT_ALLOWLIST.has(subdir)) return null;
  return { subdir, strip: `/${subdir}` };
}

/** 造一段「哨兵在 ⇒ 从磁盘直服」的子路由（形状已用真 caddy 实测验证）。 */
function buildFeedGate(pagesRoot, staticDir, subdir, strip) {
  return [
    // 命中哨兵 ⇒ 换 root 到最窄的产物子目录，strip 掉对外前缀，然后直服。
    // ⚠️ 哨兵目录写在 **`file` matcher 自己的 `root` 字段**里，而不是先插一个路由级
    //    `{handler:'vars',root:pages}`：①`try_files` 相对**当前 root** 解析，matcher 的 root
    //    只作用于这次存在性判断，不会把 pages 目录泄漏给后面的 reverse_proxy 分支；
    //    ②路由级 `vars.root` 是 pages-dir 守卫统计的对象，多插一个会让「serve-html 之外还有谁
    //    用了 pages 目录」这个集合每次加功能都变，守卫就得跟着改数字（那种守卫迟早被当噪音删掉）。
    //    两种形状都用真 caddy v2.11.4 实测过（哨兵在→200 直服、撤掉→502 回落反代）。
    {
      match: [{ file: { root: pagesRoot, try_files: [`/${SERVE_HTML_SENTINEL_NAME}`] } }],
      handle: [
        {
          handler: 'subroute',
          routes: [
            {
              handle: [
                { handler: 'vars', root: `${staticDir}/${subdir}` },
                { handler: 'rewrite', strip_path_prefix: strip },
                {
                  handler: 'headers',
                  response: {
                    set: {
                      // ⚠️ no-cache：降级期发的是磁盘上的旧产物，绝不能让中间缓存把它钉住
                      'Cache-Control': ['no-cache'],
                      [STATIC_FEED_HEADER]: [subdir],
                    },
                  },
                },
                { handler: 'file_server' },
              ],
            },
          ],
        },
      ],
      // ③ terminal：命中就别再往下走到 reverse_proxy（否则会对同一个请求既直服又反代）
      terminal: true,
    },
  ];
}

/**
 * 把降级直服注入到所有 feed/sitemap 路由。
 * 返回 stats 供守卫与日志使用；**任何一处形状不符都只 WARN 不猜**。
 */
function applyDegradedFeedServing(node, ctx) {
  if (Array.isArray(node)) {
    node.forEach((child) => applyDegradedFeedServing(child, ctx));
    return ctx.stats;
  }
  if (!node || typeof node !== 'object') return ctx.stats;

  const routes = node.routes;
  if (Array.isArray(routes)) {
    for (const route of routes) {
      const paths = (route && route.match && route.match[0] && route.match[0].path) || [];
      // ⚠️ 判据写成显式形状，别用一条正则概括：第一版写 `^\/(rss|sitemap)(\/|\*|$)`，
      //    结果 `/sitemap.xml` **不匹配**（`sitemap` 后面是 `.`），于是 sitemap 整条被漏掉、
      //    注入数从应有的 10 变成 8 而日志看起来一切正常。这类"少注入几处"的失效是静默的，
      //    所以守卫要断言**注入处数**而不是"至少注入了一处"。
      const FEED_ROUTE_EXACT = new Set(['/sitemap.xml', '/feed.xml', '/feed.json', '/atom.xml']);
      const isFeedRoute =
        Array.isArray(paths) &&
        paths.some(
          (p) =>
            typeof p === 'string' &&
            (FEED_ROUTE_EXACT.has(p) || p === '/rss' || p === '/rss/*' || p.startsWith('/rss/') || p.startsWith('/sitemap/')),
        );
      if (!isFeedRoute) continue;
      ctx.stats.candidates += 1;

      const target = deriveFeedTarget(route);
      if (!target) {
        ctx.warns.push(
          `[degraded-feed] 路由 ${JSON.stringify(paths)} 没法反推产物子目录（rewrite 与 path 都不指向 ` +
            `${[...FEED_ROOT_ALLOWLIST].join('/')} 之一）⇒ **跳过注入**，降级期这条路由仍然 503。`,
        );
        continue;
      }
      const sub = route.handle && route.handle[0] && route.handle[0].routes;
      if (!Array.isArray(sub)) {
        ctx.warns.push(`[degraded-feed] 路由 ${JSON.stringify(paths)} 不是 subroute 形状 ⇒ 跳过注入`);
        continue;
      }
      // 🔴 先把「rewrite 与 reverse_proxy 挤在同一个 handle 数组里」的子路由**拆成两个**。
      //    模板里别名路由的形状是 `handle:[{rewrite uri_substring},{reverse_proxy}]`（一个元素、两个 handler），
      //    于是 `findIndex(reverse_proxy)` 返回 0 ⇒ 门控会被插到 **rewrite 之前**，
      //    此时 URI 还是 `/feed.xml`，`strip_path_prefix:'/rss'` 变成空操作。
      //    ⚠️ 那样"碰巧"也能命中文件（root=`<static>/rss` + uri=`/feed.xml` = 同一个文件），
      //    但这是靠巧合而不是靠设计：换一个别名（例如将来加 `/index.xml` → `/rss/feed.xml`）
      //    就会静默发错文件。拆开之后语义明确，且与真 caddy 实测过的形状一致。
      //    拆分是等价的：caddy 按顺序执行同一 handle 数组里的 handler，拆成两个相邻的无 matcher
      //    子路由仍然按顺序执行；reverse_proxy 块的数量与参数都不变（caddy-perf 的热点池断言不受影响）。
      for (let i = sub.length - 1; i >= 0; i -= 1) {
        const el = sub[i];
        const hs = Array.isArray(el && el.handle) ? el.handle : null;
        if (!hs || el.match) continue; // 带 matcher 的元素不能拆（会改变匹配语义）
        const rpIdx = hs.findIndex((h) => h && h.handler === 'reverse_proxy');
        if (rpIdx <= 0) continue; // 没有 proxy，或 proxy 已经是第一个 ⇒ 无需拆
        sub.splice(i, 1, { handle: hs.slice(0, rpIdx) }, { handle: hs.slice(rpIdx) });
        ctx.stats.split += 1;
      }
      // 插在**第一个含 reverse_proxy 的子路由之前**：拆开之后别名路由是 [rewrite] [proxy]，
      // 所以门控落在 rewrite 之后（URI 已经改写成 /rss/…，strip 前缀才对得上）。
      const proxyIdx = sub.findIndex(
        (x) => Array.isArray(x && x.handle) && x.handle.some((h) => h && h.handler === 'reverse_proxy'),
      );
      if (proxyIdx < 0) {
        ctx.warns.push(
          `[degraded-feed] 路由 ${JSON.stringify(paths)} 里找不到 reverse_proxy ⇒ 模板形状变了，跳过注入` +
            '（不猜插入位置：插错会让正常模式也走直服，把动态 feed 冻成旧文件）',
        );
        continue;
      }
      if (sub.some((x) => Array.isArray(x && x.handle) && x.handle.some((h) => h && h.handler === 'file_server'))) {
        ctx.stats.already += 1; // 幂等：重复跑生成器不会注入两次
        continue;
      }
      sub.splice(proxyIdx, 0, ...buildFeedGate(ctx.pagesRoot, ctx.staticDir, target.subdir, target.strip));
      ctx.stats.injected += 1;
      ctx.stats.roots.add(`${ctx.staticDir}/${target.subdir}`);
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'routes') continue; // 这一层已经处理过
    applyDegradedFeedServing(node[key], ctx);
  }
  return ctx.stats;
}

const staticDirWarns = [];
const staticDirResolved = resolveStaticDir(process.env[STATIC_DIR_ENV]);
staticDirWarns.push(...staticDirResolved.warns);
const feedPagesRoot = findServeHtmlPagesRoot(config);
const feedCtx = {
  pagesRoot: feedPagesRoot,
  staticDir: staticDirResolved.dir,
  warns: [],
  stats: { candidates: 0, injected: 0, already: 0, split: 0, roots: new Set() },
};
if (!feedPagesRoot) {
  feedCtx.warns.push(
    '[degraded-feed] 在配置里找不到 serve-html 路由的 vars.root（哨兵目录未知）⇒ **不注入**降级直服，' +
      '降级期 /rss/* 与 /sitemap.xml 仍会 503。失败方向是保持现状，不是猜一个目录。',
  );
} else {
  applyDegradedFeedServing(config, feedCtx);
}
for (const w of staticDirWarns) process.stderr.write(`[caddyConfig] ⚠️ ${w}\n`);
for (const w of feedCtx.warns) process.stderr.write(`[caddyConfig] ⚠️ ${w}\n`);
process.stderr.write(
  `[caddyConfig] 降级期直服 feed/sitemap：候选路由 ${feedCtx.stats.candidates} 条、注入 ${feedCtx.stats.injected} 处` +
    (feedCtx.stats.already ? `（另有 ${feedCtx.stats.already} 处已注入过，跳过）` : '') +
    `；拆开 rewrite+proxy 合并元素 ${feedCtx.stats.split} 处` +
    `；哨兵目录 = ${feedPagesRoot || '(未知)'}；产物 root = ` +
    (feedCtx.stats.roots.size ? [...feedCtx.stats.roots].sort().join(', ') : '(无)') +
    `（${STATIC_DIR_ENV}=${staticDirResolved.provided ? '来自环境变量' : '默认值'}）\n`,
);

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
