/**
 * 后台表单的**账号口令策略**（单一真相源）。
 *
 * ## 为什么这个文件必须存在：服务端在后台路径上**数学上无法**强制最小长度
 *
 * 后台所有涉及账号口令的入口都在浏览器里先做 sha256 派生再发出去
 * （`services/van-blog/encryptPwd.js`，调用点见 `pages/user/Login`、`pages/user/Restore`、
 * `pages/SystemConfig/tabs/User`、`pages/InitPage`、`components/CollaboratorModal`）。
 * 派生结果**恒为 64 个十六进制字符**，与原始口令长度无关：口令是 `1` 个字符还是 40 个，
 * 服务端看到的都是同一个形状。sha256 不可逆 ⇒ 服务端无法反推强度，
 * `provider/user/user.provider.ts` 的 `assertAccountPasswordStrength` 对派生形状只能放行。
 * 所以「账号口令 ≥10」真正的强制点只有两处：**这里（后台表单）** 与
 * `provider/init/envBootstrap.ts`（零接触初始化，那里拿到的是原始口令）。
 *
 * ⚠️ 因此：新增任何口令表单时**必须**挂上 `accountPasswordMinRule()`，否则那个入口就是
 *    策略的缺口 —— 而且服务端不会拦、日志里也不会有任何痕迹（静默缺口）。
 *    `tests/unit/passwordPolicy.test.js` 会枚举现有的四个入口，新增入口请一并加进去。
 *
 * ## 常量为什么是 10
 * 与服务端 `MIN_ACCOUNT_PASSWORD_LENGTH`（`packages/server/src/provider/user/user.provider.ts`）
 * 取同一个值。⚠️ 两个包无法互相 import，所以这里是**镜像**而非引用 —— 由
 * `tests/unit/passwordPolicy.test.js` 做跨包对账（任一侧改了、另一侧没改就红）。
 * 取 10 的理由见服务端那个常量上的注释（字典 + 少量变形在现有防爆破预算内不可行的下限）。
 *
 * ## 为什么是 CommonJS（`module.exports`）而不是 ESM
 * 本包 `package.json` 没有 `"type": "module"`，而 `tests/unit/*.test.js` 用 `node --test` + `require()`
 * 直接测纯逻辑模块（既有先例：`services/van-blog/accessPassword.js`）。写成 ESM 的话测试就
 * `require` 不到；写成 CommonJS，JSX 侧照样能用 `import { … } from` 引入（webpack 会做互操作）。
 */

/** 账号口令（管理员 / 协作者）的最小**字符数**。镜像服务端同名常量，由测试对账。 */
const MIN_ACCOUNT_PASSWORD_LENGTH = 10;

/**
 * 提示文案：说清「最少多少」与「为什么」（一句话，不写成长篇）。
 *
 * ⚠️ 计数口径要如实：async-validator 对字符串按**码点**计数（它先把代理对
 * `[\uD800-\uDBFF][\uDC00-\uDFFF]` 折叠成一个字符再取 length），所以一个 emoji 算 1 个字符、
 * 不是 2 个。文案里只说「字符」，不说「字节」。服务端 env bootstrap 用
 * `Array.from(password).length` 保持同一口径，两边不会出现「表单过了、启动被拒」。
 */
const ACCOUNT_PASSWORD_MIN_MESSAGE = `密码至少 ${MIN_ACCOUNT_PASSWORD_LENGTH} 个字符：更短的口令在“5 次/300 秒/IP”的防爆破限制下，用一批代理 IP 仍可能在数小时内被撞开，而账号一旦被盗就能改站点内容`;

/**
 * 账号口令字段的**最小长度规则**（antd 4 / async-validator 的声明式 `min`）。
 *
 * 用法：`rules={[{ required: true, message: '这是必填项' }, accountPasswordMinRule()]}`
 *
 * ⚠️ 为什么是工厂函数而不是导出的常量对象：antd/async-validator 会往规则对象上挂
 *    `field` / `fullField` 等字段，四个表单共享同一个对象实例会互相污染。
 *    每次调用返回新对象就没这个问题。
 *
 * ⚠️ 与 `required` 规则并存时**不会**重复报错：async-validator 的 string 校验器只在
 *    `!isEmptyValue(value, 'string')` 时才跑 `rules.range`，所以空值只由 `required` 那条报出来。
 *
 * ⚠️ `min` 规则作用于**派生之前**的原始输入：表单 rules 校验的是字段值，
 *    而 `encryptPwd` 是在 `onFinish` 里才调用的（拿到的 values 仍是原始口令）。
 */
function accountPasswordMinRule() {
  return {
    min: MIN_ACCOUNT_PASSWORD_LENGTH,
    message: ACCOUNT_PASSWORD_MIN_MESSAGE,
  };
}

module.exports = {
  MIN_ACCOUNT_PASSWORD_LENGTH,
  ACCOUNT_PASSWORD_MIN_MESSAGE,
  accountPasswordMinRule,
};
