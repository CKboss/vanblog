import fs from 'fs';
import { sha256 } from 'js-sha256';
import { SiteInfo } from 'src/types/site.dto';

/**
 * 环境变量自动初始化（部署期把"未初始化窗口"整个关掉的机制）。
 *
 * 为什么要有它：`/api/admin/init*` 匿名可达，唯一的闸门是"库里有没有用户"。
 * 容器从启动到站长走完向导之间，站点是**敞开的** —— 攻击者只需要一个请求。
 * setup key（见 ./setupKey.ts）让这一抢变得需要密钥，env 自动初始化则让
 * "敞开的窗口"**根本不存在**：容器带着管理员凭据启动时，站点在监听第一个
 * HTTP 请求之前就已经初始化完了。
 *
 * 契约：
 *  - `VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`（或 `_FILE`）→ 全新站点自举；
 *  - `VANBLOG_ADMIN_PASSWORD_FILE`（一个路径，例如 Docker secret）**优先于**内联变量，
 *    内容按 secret-file 的标准契约去掉**尾部**换行/空白（只 trim 尾部：
 *    前导空白在理论上是密码的一部分，而尾部换行几乎一定是 `echo` 带进来的）；
 *    读不到文件时**大声失败**，绝不静默回落到内联变量；
 *  - 站点已初始化时这些变量被**忽略**（INFO 说明一句，免得轮换凭据的人疑惑）；
 *  - 凭据被拒绝时**大声失败**（ERROR + 站点保持未初始化的后果写进日志），
 *    绝不静默跳过 —— "运营者给了凭据、站点却没初始化"必须当场可见；
 *  - 密码本身**永不**进日志、永不进迁移台账的 detail。
 *
 * ⚠️ 校验策略：**不发明第二套密码策略**。`InitDto`/`initSystem` 在服务端
 * 对用户名/密码没有任何强度校验（向导前端只有 `required: true`），所以这里
 * 拒绝的恰好是"向导也会拒绝的"：缺失/空白的用户名、空的密码。要加长度下限
 * 应当先加给向导本身，两边一起变。
 */

export const ENV_ADMIN_USER = 'VANBLOG_ADMIN_USER';
export const ENV_ADMIN_PASSWORD = 'VANBLOG_ADMIN_PASSWORD';
export const ENV_ADMIN_PASSWORD_FILE = 'VANBLOG_ADMIN_PASSWORD_FILE';

/** 三个变量里任何一个非空白 = 操作者表达了"要自动初始化"的意图 */
export function envBootstrapRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return [ENV_ADMIN_USER, ENV_ADMIN_PASSWORD, ENV_ADMIN_PASSWORD_FILE].some(
    (name) => String(env[name] ?? '').trim() !== '',
  );
}

export interface EnvCredentials {
  username: string;
  password: string;
  passwordSource: 'file' | 'inline';
  passwordFile?: string;
}

/**
 * 解析结果。⚠️ 扁平接口而不是可辨识联合：本仓库 `strictNullChecks: false`，
 * 判别属性窄化不生效（见 setupKey.ts 的同一说明）。
 */
export interface EnvResolveResult {
  ok: boolean;
  /** ok=true 时必有 */
  creds?: EnvCredentials;
  /** ok=false 时必有：给运维看的拒绝原因（绝不含密码本身） */
  error?: string;
}

/**
 * 解析并校验凭据。**永不返回密码之外的秘密**，错误信息里只有变量名与文件路径。
 * 内联密码按字面字节使用（env 没有"尾部换行"问题；compose 里带尾随空格
 * 属于操作者的字面值），secret 文件按标准契约 trimEnd。
 */
export function resolveEnvCredentials(
  env: NodeJS.ProcessEnv = process.env,
): EnvResolveResult {
  const username = String(env[ENV_ADMIN_USER] ?? '').trim();
  const passwordFile = String(env[ENV_ADMIN_PASSWORD_FILE] ?? '').trim();
  const inline = env[ENV_ADMIN_PASSWORD];

  if (!username) {
    return {
      ok: false,
      error: `缺少 ${ENV_ADMIN_USER}（或只有空白字符）：自动初始化需要管理员用户名`,
    };
  }

  let password: string;
  let passwordSource: 'file' | 'inline';
  if (passwordFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(passwordFile, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error:
          `读取 ${ENV_ADMIN_PASSWORD_FILE}（${passwordFile}）失败：${
            (err as Error)?.message || err
          }。它优先于 ${ENV_ADMIN_PASSWORD}，读不到时**不会**静默回落到内联变量`,
      };
    }
    // secret-file 标准契约：去掉尾部换行/空白（echo/编辑器几乎必然带一个 \n）
    password = raw.replace(/\s+$/, '');
    passwordSource = 'file';
  } else if (typeof inline === 'string' && inline !== '') {
    password = inline;
    passwordSource = 'inline';
  } else {
    return {
      ok: false,
      error:
        `设置了 ${ENV_ADMIN_USER}，但没有任何密码来源：请提供 ${ENV_ADMIN_PASSWORD_FILE}` +
        `（推荐，Docker secret/文件挂载）或 ${ENV_ADMIN_PASSWORD}`,
    };
  }

  if (!password) {
    return {
      ok: false,
      error:
        passwordSource === 'file'
          ? `${ENV_ADMIN_PASSWORD_FILE}（${passwordFile}）去掉尾部空白后是空的：拒绝用空密码初始化`
          : `${ENV_ADMIN_PASSWORD} 是空的：拒绝用空密码初始化`,
    };
  }
  return { ok: true, creds: { username, password, passwordSource, passwordFile: passwordFile || undefined } };
}

/**
 * 浏览器端派生口令（与前端 `services/van-blog/encryptPwd.js` 的 `encryptPwd`
 * **逐字节一致**，也就是 `utils/crypto.ts` 的 `washPassword` 内部那一份）：
 *
 *     sha256(lower(username) + sha256(sha256(sha256(sha256(password))) + sha256(lower(username))))
 *
 * 为什么必须派生：登录接口收到的是浏览器派生后的值，`verifyUserPassword`
 * 用它对 scrypt 哈希。如果这里直接存 env 里的原始密码，管理员**永远登不进来**，
 * 而且没有任何报错能指向这个原因。
 *
 * ⚠️ 这份公式在 crypto.ts 里没有单独导出（washPassword 把它和旧存储格式捆在一起），
 * 而 crypto.ts 本轮禁止改动 —— 所以在这里镜像一份，并用测试与
 * `washPassword`/`encryptPassword` 逐字节对拍钉住（漂移立刻红）。
 */
export function deriveBrowserPassword(username: string, password: string): string {
  const u = String(username ?? '').toLowerCase();
  const p = String(password ?? '');
  return sha256(u + sha256(sha256(sha256(sha256(p))) + sha256(u)));
}

/**
 * 自动初始化用的**最小站点记录**（与向导第一步的必填集对齐后取最保守子集）。
 * 向导里 siteName/author 是必填，这里用得到信息填：作者 = 管理员用户名，
 * 站名给中性默认值。baseUrl 留空（env 契约里没有它；上线后到
 * 「后台 → 站点信息」补一次即可，RSS/sitemap 在那之前没有绝对 URL 可用）。
 * `since` 不用给：`InitProvider.init()` 自己会补 `new Date()`。
 */
export function minimalSiteInfo(username: string): Partial<SiteInfo> {
  return {
    siteName: 'VanBlog',
    author: String(username ?? ''),
    authDesc: '',
    siteDesc: '',
    favicon: '',
    baseUrl: '',
  } as Partial<SiteInfo>;
}
