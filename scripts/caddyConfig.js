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
        ' ⚠️ 但服务端仍会把哨兵文件写到你给的这个路径，所以两侧现在不一致、' +
        'caddy 直服 HTML 不会生效 —— 请修正这个值，或直接取消该环境变量。',
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
