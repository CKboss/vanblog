/**
 * init 页「初始化密钥（setup key）」的纯逻辑部分（与 React/DOM 解耦，node --test 可直接 require）。
 *
 * ⚠️ 与 restoreCore.js 同一模式：刻意 CommonJS —— 后台代码由 babel 编译（CJS 可被
 * ESM import），单元测试跑在裸 node 上，require() 只认 CJS。
 *
 * 服务端契约（与 packages/server 的 setupKey.ts / init.controller.ts 对齐）：
 * - `VANBLOG_INIT_REQUIRE_SETUP_KEY` **默认开启**（未设置=开；显式 false/0/no/off 才关；
 *   打错的值按开处理并 WARN）。开启时 POST /api/admin/init（JSON 顶层字段
 *   `setupKey`）与 POST /api/admin/init/restore（multipart 文本字段 `setupKey`）
 *   都必须携带初始化密钥；
 * - 没带/带错 ⇒ **HTTP 400**，body 形如
 *   `{statusCode:400, message:'…指路消息…', setupKeyRequired:true,
 *     reason:'setupKeyMissing'|'setupKeyWrong'}`；
 * - 服务端自己丢了密钥 ⇒ HTTP 500 `{setupKeyUnavailable:true}`（此时填什么都没救，
 *   要重启 server 重新生成）；
 * - 密钥**绝不**会出现在任何响应里；消息里只有"去哪找"（启动日志 + 文件路径）。
 *
 * UI 决策（记录在案的理由）：输入框**只在服务端真的要密钥时才出现** ——
 * 判定信号取的是 400 响应里的 `setupKeyRequired:true`（机器可读），
 * 文案匹配（/初始化密钥|setup\.key/）只作旧 server 形状的兜底。
 * 页面加载时不发任何探测请求：`/api/admin/init*` 前缀挂着 5 次/10 分钟的
 * 限流桶，用页面加载去消耗它，等于把站长自己的提交预算烧掉。
 */

/** 两条初始化路由共用的字段名（JSON 字段 / multipart 文本字段） */
const SETUP_KEY_FIELD = 'setupKey';

/**
 * 「去哪找密钥」的固定提示。**第一条先讲清"新版默认就要密钥"**（站长拍板：
 * 首次安装默认 VANBLOG_INIT_REQUIRE_SETUP_KEY=true），逃生口只作最后一条的次要说明。
 * 服务端 400 的 message 已经原样展示，这里是运维视角的补充
 * （反复打印的日志块 / docker logs / 挂载目录 / 重启语义）。
 */
const SETUP_KEY_HINTS = [
  // ⚠️ 这些提示是当**纯文本**渲染的（`<li>{hint}</li>`，见 InitPage/index.tsx 与
  //    RestoreFromBackup.tsx），不走 markdown 渲染器 —— 写 `**强调**` 用户会看到字面星号。
  //    要强调就用中文引号「」或直接改句式。
  '新版安装默认要求初始化密钥（VANBLOG_INIT_REQUIRE_SETUP_KEY 默认开启）：站点未初始化期间，server 会在启动时打印密钥块，之后每 10 分钟重印一次（VANBLOG_SETUP_KEY_REMIND_MINUTES 可调，0=只印一次），直到完成初始化',
  '拿密钥：docker logs <容器名> 2>&1 | grep 初始化密钥；或直接读挂载日志目录里的 setup.key 文件（容器内默认 /var/log/setup.key；裸机部署在 config.yaml 的 log 目录下），复制「完整一行」，不要带多余字符',
  '密钥每次重启 vanblog 都会重新生成；初始化完成后服务端自动删除该文件、停止提醒，两条初始化接口也不再接受密钥',
  '只有运维显式设置了 VANBLOG_INIT_REQUIRE_SETUP_KEY=false（逃生口，不推荐）时才不要求密钥 —— 那种情况下这一栏留空提交即可',
];

/**
 * 🔴 与 `SETUP_KEY_HINTS` **一一对应、顺序必须一致**的 i18n key。
 * 语言包在 `src/locales/{zh-CN,zh-TW,en-US}.ts`，三份的 key 集合由
 * `tests/unit/localePackParity.test.js` 钉住（含「key 数 == 本数组长度」的反空转）。
 */
const SETUP_KEY_HINT_IDS = [
  'init.setupKey.hint1',
  'init.setupKey.hint2',
  'init.setupKey.hint3',
  'init.setupKey.hint4',
];

/**
 * 🔴 取「去哪找密钥」的提示，按传入的翻译器本地化。
 *
 * @param {(id: string, defaultMessage: string) => string} [t] 翻译器。
 *   🔴 **不传时原样返回中文常量** ⇒ 直接 `require()` 本模块的单测
 *   （`tests/unit/initSetupKey.test.js`，它断言 `SETUP_KEY_HINTS` 的内容）
 *   **行为逐字不变**。这些模块是纯 JS、被 `node --test` 直接 require，
 *   拿不到 umi 运行时 ⇒ 所以用**依赖注入**而不是在模块里 import umi。
 *   React 层传 `(id, dm) => intl.formatMessage({ id, defaultMessage: dm })`。
 */
function getSetupKeyHints(t) {
  if (typeof t !== 'function') {
    return SETUP_KEY_HINTS.slice();
  }
  return SETUP_KEY_HINTS.map((defaultMessage, i) => t(SETUP_KEY_HINT_IDS[i], defaultMessage));
}

/** 一个响应 body（对象）是不是"要求初始化密钥"的拒绝 */
function isSetupKeyRejectionPayload(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }
  if (body.setupKeyRequired === true) {
    return true;
  }
  // 兜底：老形状/网关改写导致标志丢了，但状态码与文案还在
  const status = body.statusCode;
  const msg = String(body.message == null ? '' : body.message);
  return status == 400 && /初始化密钥|setup\.key/.test(msg);
}

/**
 * 从 umi-request 抛出的错误对象里提取"服务端在要初始化密钥"这个信号。
 * fetchInit 失败时 err.data / err.info 上挂着响应 body（与 InitPage 既有的
 * 「已初始化」分支读的是同一个位置）。
 *
 * @returns {{required: boolean, message: string, unavailable: boolean}}
 *   message 是服务端的原话（要**原样**展示给用户的那句指路消息）；
 *   unavailable=true 表示 500「服务端自己没有密钥」—— 填输入框救不了，
 *   调用方展示面板时应以服务端 message（"重启 vanblog 重新生成"）为主。
 */
function extractSetupKeyRejection(err) {
  const bodies = [err && err.data, err && err.info];
  for (let i = 0; i < bodies.length; i += 1) {
    const body = bodies[i];
    if (!body || typeof body !== 'object') {
      continue;
    }
    if (body.setupKeyUnavailable === true) {
      return { required: false, unavailable: true, message: String(body.message == null ? '' : body.message) };
    }
    if (isSetupKeyRejectionPayload(body)) {
      return { required: true, unavailable: false, message: String(body.message == null ? '' : body.message) };
    }
  }
  return { required: false, unavailable: false, message: '' };
}

module.exports = {
  SETUP_KEY_FIELD,
  SETUP_KEY_HINTS,
  SETUP_KEY_HINT_IDS,
  getSetupKeyHints,
  isSetupKeyRejectionPayload,
  extractSetupKeyRejection,
};
