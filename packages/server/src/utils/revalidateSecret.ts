/**
 * server → website 的 `/api/revalidate` 共享密钥（含"没人配"时的进程内自动生成）。
 *
 * ## 为什么需要这个模块（P0 回归的成因）
 *
 * website 的 `pages/api/revalidate.ts` 在**没配** `VAN_BLOG_REVALIDATE_SECRET` 时会退化成
 * "只放行本机回环直连"，判据是"套接字是回环 **且没有** `x-forwarded-for` / `x-real-ip`"。
 * 那条判据在 Next 里**永远不可能成立**：
 *
 *     // node_modules/next/dist/server/base-server.js:527-530（每个请求都跑，没有任何配置开关）
 *     req.headers["x-forwarded-host"]  ??= req.headers["host"] ?? this.hostname;
 *     req.headers["x-forwarded-port"]  ??= this.port ? String(this.port) : isHttps ? "443" : "80";
 *     req.headers["x-forwarded-proto"] ??= isHttps ? "https" : "http";
 *     req.headers["x-forwarded-for"]   ??= originalRequest.socket?.remoteAddress;
 *
 * 也就是说 handler 拿到的 `req.headers` **一定**含 `x-forwarded-for`（Next 自己按套接字地址补的）。
 * 实测（真 `NextServer` + 真编译产物 + 只发 host/connection 两个头的回环请求）：
 * `req.socket.remoteAddress === "127.0.0.1"`、`hasSocket === true`，但响应仍是 **403**。
 * ⇒ 一体式镜像里 server 触发的**每一次** revalidate 都被拒，冷启动全量渲染全败、
 *   `post/*.html` 产物 0 个，"数据库挂了还能发布缓存内容"因此无产物可发。
 *
 * ⚠️ 注意 `??=` 的语义：Next 只在**缺失时**补，真实反代加的 `x-forwarded-for` 会被保留。
 * 所以"把判据放宽成 XFF 全是回环就放行"看似可行，但它会把 `cc1c51eb` 想防的形状重新放开：
 * 该提交的前提是"反代一定会加转发头"，而 **nginx 默认并不加 `X-Forwarded-For`**
 * （要 `proxy_set_header` 显式配），那种部署下攻击者的请求经同机反代转发后
 * XFF 会被 Next 补成反代自己的回环地址 ⇒ 放行。**IP 判定在这里根本不可靠**，
 * 所以修法是给一体式部署一把**真密钥**，而不是把 IP 判定调松。
 *
 * ## 为什么用文件而不是只写 process.env
 *
 * 多进程（`VANBLOG_CLUSTER_WORKERS>1`）时 `utils/clusterBootstrap.ts` 的 `envForWorker()`
 * 在 `startClusterPrimary()` 调用时就**快照**了 `baseEnv`，而前台子进程是之后
 * `websiteProvider.init()` 才 spawn 的 ⇒ 那时再往 `process.env` 写值，**已经 fork 出去的
 * worker 拿不到**，各 worker 会各自生成一把 ⇒ 非主 worker 触发的重渲染全部 401。
 * 所以密钥要放在**所有进程都能读到的同一个地方**：一个 0600 文件，用 `wx` 原子创建，
 * 谁先创建谁定值、其余进程读到同一把（EEXIST 就重读），天然免锁。
 *
 * ## 生命周期与边界
 * - 运维**显式配置**了 `VAN_BLOG_REVALIDATE_SECRET` ⇒ 一律用它，本模块不生成、不覆盖、不写文件。
 * - 没配 ⇒ 生成一把 32 字节随机（64 位十六进制）密钥，落在 `os.tmpdir()` 下。
 *   容器重启后若 `/tmp` 仍在，会**复用**旧值：这没有问题，因为 server 与 website
 *   子进程总是一起重启、且两侧读的是同一个来源。
 * - 🔴 **绝不出现在日志、argv、接口响应里**（沿用本仓库对口令/PEM 的既有纪律）。
 *   分离部署时 website 是另一个容器、读不到这个文件也没配 env ⇒ 仍然**失败关闭**（403），
 *   与 `cc1c51eb` 的意图一致：那种部署必须显式配同一个密钥，WARN 会告诉他们。
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 两侧共用的环境变量名（website 的 `pages/api/revalidate.ts` 读同一个）。 */
export const REVALIDATE_SECRET_ENV = 'VAN_BLOG_REVALIDATE_SECRET';

/** 自动生成密钥的落盘文件名（放在 `os.tmpdir()` 下）。 */
export const EPHEMERAL_SECRET_FILENAME = 'vanblog-revalidate-secret';

/** 生成密钥的长度：32 字节随机 ⇒ 64 位十六进制。 */
const SECRET_BYTES = 32;
const SECRET_HEX_LEN = SECRET_BYTES * 2;

/** 只认 64 位十六进制，防止把半个文件/别的程序写的垃圾当成密钥用。 */
const SECRET_SHAPE = /^[0-9a-f]{64}$/;

let cached: string | null = null;

export interface EnsureSecretOptions {
  /** 覆盖落盘路径（测试用；生产走 `os.tmpdir()`）。 */
  file?: string;
  /** 可选 logger：只用来打**不含密钥**的告警。 */
  log?: { warn(message: string): void };
}

/** 默认落盘路径。 */
export function ephemeralSecretPath(): string {
  return path.join(os.tmpdir(), EPHEMERAL_SECRET_FILENAME);
}

function readSecretFile(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return SECRET_SHAPE.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * 取得 server 与 website 共用的 revalidate 密钥。
 *
 * 返回**空串**表示"拿不到任何密钥"（既没配、也没法生成/读取）——
 * 调用方必须把它当成"没有密钥"处理（于是 website 侧失败关闭），
 * ⚠️ 绝不能假装成功，否则就是拿一把双方不一致的密钥去发请求，症状是难查的 401。
 */
export function ensureRevalidateSecret(options: EnsureSecretOptions = {}): string {
  // 1) 运维显式配置的优先，且**绝不**被自动生成的值覆盖。
  const configured = process.env[REVALIDATE_SECRET_ENV];
  if (typeof configured === 'string' && configured.trim() !== '') return configured;

  if (cached) return cached;

  const file = options.file ?? ephemeralSecretPath();

  // 2) 别的进程（cluster 主进程、或上一轮启动）可能已经生成过。
  const existing = readSecretFile(file);
  if (existing) {
    cached = existing;
    return existing;
  }

  // 3) 原子创建：`wx` 保证并发下只有一个进程写成功，其余拿到 EEXIST 后重读。
  const generated = randomBytes(SECRET_BYTES).toString('hex');
  try {
    fs.writeFileSync(file, generated, { mode: 0o600, flag: 'wx' });
    cached = generated;
    return generated;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      const raced = readSecretFile(file);
      if (raced) {
        cached = raced;
        return raced;
      }
      // 文件在、但读不出合法形状（被截断/被别的程序占用）。
      // ⚠️ 不删它重来：删掉会让其它已经 adopting 这把值的进程与本进程分叉，
      //    而分叉的症状是"部分 worker 401"，比 outright 失败更难查。
      options.log?.warn(
        `[revalidate-secret] ${file} 存在但内容不是合法密钥形状，已忽略；` +
          'server 触发的前台重渲染会被拒（403/401）。请删除该文件后重启，' +
          `或给 server 与 website 两边显式配置同一个 ${REVALIDATE_SECRET_ENV}。`,
      );
      return '';
    }
    // 只读文件系统、权限不足等：同样**失败关闭**，并把可照做的出路说清。
    options.log?.warn(
      `[revalidate-secret] 无法在 ${file} 生成自动密钥（${code || '未知原因'}）；` +
        'server 触发的前台重渲染会被拒。请显式配置 ' +
        `${REVALIDATE_SECRET_ENV}（server 与 website 两边同一个值）。`,
    );
    return '';
  }
}

/** 只给测试用：清掉进程内缓存，让下一次调用重新走文件/生成逻辑。 */
export function resetRevalidateSecretCacheForTest(): void {
  cached = null;
}
