/**
 * init 页「用整站备份恢复」的纯逻辑部分（与 React/DOM 解耦，node --test 可直接 require）。
 *
 * ⚠️ 这个文件刻意用 CommonJS（与 services/van-blog/tagTokens.js、api.js 同一模式）：
 * 后台代码由 babel 编译（CJS 可被 ESM import），而单元测试跑在裸 node 上，
 * require() 只认 CJS —— 写成 .ts/ESM 就测不了行为了。
 *
 * 服务端契约（与 packages/server 的 POST /api/admin/init/restore 对齐）：
 * - multipart 上传，文件字段名固定 `file`；
 * - 成功回**标准信封** `{ statusCode: 200, data: { …counts… } }`
 *   （umi 的 adaptAdminResponse 只认 {statusCode,data} 形状，所以服务端也按这个回）；
 * - 站点已初始化 / 已有一个恢复在跑 / 归档非法（扩展名不对、截断、缺 manifest、
 *   成员路径穿越）时被拒绝，错误信息在响应体的 message 上；
 * - 复用与后台 `POST /api/admin/backup/full/restore` 相同的上传配置，
 *   大小上限一致（几个 GB 级；现实中的归档 ~66MB）。
 */
const INIT_RESTORE_ENDPOINT = '/api/admin/init/restore';
const INIT_RESTORE_FILE_FIELD = 'file';
/** 与后台「上传备份并恢复」的 accept 完全一致 */
const INIT_RESTORE_ACCEPT = '.zst,.xz,.gz,.tgz,.tar';

/**
 * 解析 XHR 回来的响应。
 *
 * ⚠️ 不用 umi-request：那个封装会把非 {statusCode,data} 的 body 直接 reject，
 * 而且拿不到上传进度。这里是裸 XHR + 手工解析，所以**每一种失败形状都要照顾到**：
 * 标准错误信封（statusCode+message）、Nest HttpException 的 body（message 可能是
 * 字符串或数组）、非 JSON 的网关错误页（HTML）、空响应。失败信息要能原样透传
 * 给用户（服务端拒绝的原因就是用户最需要看到的那句话）。
 *
 * @param {number} httpStatus
 * @param {string} responseText
 * @returns {{ok: true, data: object} | {ok: false, message: string, setupKeyRequired?: boolean}}
 *   失败结果**只在**服务端 body 带 `setupKeyRequired:true` 时才附加同名键
 *   （初始化保护开启时的 400，见 ./setupKeyCore.js 的契约说明）。
 */
function parseRestoreResponse(httpStatus, responseText, t) {
  let body = null;
  const text = String(responseText == null ? '' : responseText);
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = null;
    }
  }
  if (httpStatus >= 200 && httpStatus < 300 && body && body.statusCode === 200) {
    return {
      ok: true,
      data: body.data && typeof body.data === 'object' ? body.data : {},
    };
  }
  // 失败：把服务端的话原样带出去
  let message = '';
  if (body) {
    const raw =
      body.message != null
        ? body.message
        : body.data && body.data.message != null
          ? body.data.message
          : body.error;
    if (Array.isArray(raw)) {
      message = raw.join('；');
    } else if (raw != null) {
      message = String(raw);
    }
  }
  if (!message) {
    // 🔴 中文保留为 defaultMessage，`{code}`/`{status}` 用 react-intl 的占位符语法；
    //    不传翻译器时 identityTranslate 会把占位符插值成与旧实现逐字相同的结果。
    const tr = normalizeT(t);
    message =
      body && body.statusCode
        ? tr('init.restore.err.rejected', '恢复被拒绝（statusCode={code}）', {
            code: body.statusCode,
          })
        : tr('init.restore.err.httpFailed', '恢复请求失败（HTTP {status}）', {
            status: httpStatus,
          });
  }
  const failure = { ok: false, message };
  // 服务端开了初始化保护（VANBLOG_INIT_REQUIRE_SETUP_KEY=true）时，400 的 body 里带
  // setupKeyRequired:true —— 组件据此显示「初始化密钥」输入框并原样展示 message。
  // ⚠️ **条件性**附加这个键：没有该标志的响应必须得到与旧版逐字节相同的结果对象
  // （既有用例钉住了失败结果的形状，多一个 undefined 值的键都算漂移）。
  if (body && body.setupKeyRequired === true) {
    failure.setupKeyRequired = true;
  }
  return failure;
}

/**
 * 🔴 多语言：本模块是纯 JS、被 `node --test` 直接 `require()`，拿不到 umi 运行时，
 * 所以**不在这里 import umi**，而是让调用方（React 层）把翻译器注入进来。
 *
 * 约定：`t(id, defaultMessage, values?)` → 已本地化并完成 `{占位符}` 插值的字符串。
 * 🔴 **不传 `t` 时用下面的 identity 实现，输出与引入 i18n 之前逐字相同** ⇒
 * 直接 require 本模块的单测（`tests/unit/initRestore.test.js`）行为不变。
 */
function identityTranslate(id, defaultMessage, values) {
  const dm = String(defaultMessage == null ? '' : defaultMessage);
  if (!values || typeof values !== 'object') {
    return dm;
  }
  return dm.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

/** 归一化调用方传进来的翻译器：不是函数就回落到 identity（永不抛错）。 */
function normalizeT(t) {
  return typeof t === 'function' ? t : identityTranslate;
}

/** 给确认弹窗展示文件大小（不引新依赖，手写足够） */
function describeFileSize(bytes, t) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    return normalizeT(t)('init.restore.count.unknownSize', '未知大小');
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 恢复成功后的本地清理 + 跳转目标（测试钉住行为，别在组件里散落写）：
 * 与 LogoutButton 的既有登出路径一致 —— 只清 `token`（备份里有自己的 jwt 密钥
 * 与用户表，旧 token 必然失效），然后去登录页；**不调用** /api/admin/auth/logout
 * （init 场景根本没有会话，打了也是 401）。
 */
const INIT_RESTORE_LOGIN_PATH = '/user/login';
const INIT_RESTORE_TOKEN_KEY = 'token';

/**
 * counts 字段 → 中文标签（按这个固定顺序渲染，缺失/非数字的字段跳过）。
 * 服务端 counts 取自归档清单：{articles,statics,users,visits,viewers,settings,total}。
 */
const RESTORE_COUNT_LABELS = [
  ['articles', '文章', 'init.restore.count.articles'],
  ['statics', '图片', 'init.restore.count.images'],
  ['users', '用户', 'init.restore.count.users'],
  ['visits', '访问记录', 'init.restore.count.visits'],
  ['viewers', '访客', 'init.restore.count.viewers'],
  ['settings', '设置', 'init.restore.count.settings'],
  ['total', '合计', 'init.restore.count.total'],
];

/** 把 counts 渲染成「文章 59 · 图片 93 · 访问记录 8746」；没有可用数字时返回空串。 */
function formatRestoreCounts(counts, t) {
  if (!counts || typeof counts !== 'object') {
    return '';
  }
  const parts = [];
  for (let i = 0; i < RESTORE_COUNT_LABELS.length; i += 1) {
    const key = RESTORE_COUNT_LABELS[i][0];
    const labelId = RESTORE_COUNT_LABELS[i][2];
    // 🔴 中文标签保留为 defaultMessage：漏翻译时回落中文，而不是把裸 key 显示给用户
    const label = normalizeT(t)(labelId, RESTORE_COUNT_LABELS[i][1]);
    const value = counts[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${label} ${value}`);
    }
  }
  return parts.join(' · ');
}

/**
 * 成功响应（HTTP 2xx + 信封 statusCode=200）的语义分类。
 *
 * ⚠️ **必须按 `data.initialized` 分支，而不是按 HTTP 200**：
 * 归档里没有 users 集合时，恢复照样成功返回 200，但 `initialized:false`、
 * `adminUserFromArchive:false` —— 站点仍是未初始化状态，正确的下一步是
 * **留在 init 页继续走向导建账号**，而不是跳去一个没有任何账号的登录页。
 * 字段缺失（老版本 server 不发它）按 false 处理，同样留在向导。
 * 所有字段都 optional-chain 到安全默认值：服务端形状再变也只是少显示细节，不会崩。
 */
function classifyRestoreSuccess(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    initialized: d.initialized === true,
    adminUserFromArchive: d.adminUserFromArchive === true,
    seconds:
      typeof d.seconds === 'number' && Number.isFinite(d.seconds) ? d.seconds : null,
    notes: Array.isArray(d.notes)
      ? d.notes
          .filter((note) => note !== null && note !== undefined)
          .map((note) => String(note))
      : [],
    countsText: formatRestoreCounts(d.counts),
    databases: d.databases && typeof d.databases === 'object' ? d.databases : null,
    static: d.static && typeof d.static === 'object' ? d.static : null,
  };
}

/**
 * 失败时按 HTTP 状态 + 服务端 message 给出「操作者视角」的提示。
 * 服务端 message 永远**原样**展示（它就是用户最需要看到的那句话），这里只是加提示：
 * - 409：已有恢复在跑（服务端单飞锁）→ 稍后重试；
 * - 403：站点已初始化 → 走后台「系统设置 → 备份与恢复」；
 * - 429：init 限流桶（每 IP 10 分钟 5 次）→ 稍后再试；
 * - 400 且 message 命中「版本过新/不是整站备份」（服务端原文：
 *   `manifest.json 校验失败：不是 VanBlog 整站备份，或版本过新`）→ 升级 server 镜像；
 * - 其余（含 demo 401 信封、网络错误）→ 通用两条（文件类型 / 已初始化走后台）。
 */
function describeRestoreFailure(httpStatus, message, t) {
  const text = String(message == null ? '' : message);
  const tr = normalizeT(t);
  if (httpStatus === 409) {
    return [tr('init.restore.err.409', '已经有一个恢复在进行中：等它结束再试；若那一次成功了，刷新页面即可进入后台。')];
  }
  if (httpStatus === 403) {
    return [
      tr('init.restore.err.403', '这个站点已经初始化过了：init 入口只对全新站点开放。请登录后台，用「系统设置 → 备份与恢复 → 上传备份并恢复」。'),
    ];
  }
  if (httpStatus === 429) {
    return [tr('init.restore.err.429', '初始化相关请求太频繁（限流：每 10 分钟 5 次），请稍后再试。')];
  }
  if (httpStatus === 400 && /版本过新|不是 VanBlog 整站备份/.test(text)) {
    return [
      tr('init.restore.err.400', '这个文件不是本站导出的整站备份，或它由「更新版本」的 VanBlog 生成、当前 server 读不了：先确认文件来源；确实是新版本备份的话，升级 server 镜像后再恢复。'),
    ];
  }
  return [
    tr('init.restore.err.fallback1', '请确认选的是「导出整站备份」生成的归档（文件名形如 vanblog-full-YYYYMMDD-HHMMSS.tar.zst / .tar.xz / .tar.gz）；后台导出的 JSON 数据备份不走这里 —— 那个要先完成初始化，再到「数据管理」导入。'),
    tr('init.restore.err.fallback2', '如果这个站点其实已经初始化过，这里会拒绝恢复 —— 请登录后台，用「系统设置 → 备份与恢复」的上传恢复。'),
  ];
}

module.exports = {
  INIT_RESTORE_ENDPOINT,
  INIT_RESTORE_FILE_FIELD,
  INIT_RESTORE_ACCEPT,
  INIT_RESTORE_LOGIN_PATH,
  INIT_RESTORE_TOKEN_KEY,
  parseRestoreResponse,
  describeFileSize,
  formatRestoreCounts,
  classifyRestoreSuccess,
  describeRestoreFailure,
};
