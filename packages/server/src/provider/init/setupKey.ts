import fs from 'fs';
import path from 'path';
import { BadRequestException, HttpException } from '@nestjs/common';
import { config } from 'src/config';
import { makeSalt, safeEqual } from 'src/utils/crypto';

/**
 * 初始化密钥（setup key）：**唯一真正能关掉"匿名抢先初始化"窗口的机制**。
 *
 * 背景：`POST /api/admin/init` 与 `POST /api/admin/init/restore` 是匿名的，
 * 唯一的闸门是"users 集合有没有行"。攻击者只需要**一个请求**就能抢在站长之前
 * 把全新实例变成自己的（限流只约束重试，不约束那一次成功的请求）。
 * 这里的做法完全**镜像既有的 restore.key**（「忘记密码」流程，站长已经熟悉）：
 *  - 站点未初始化期间，每次启动用 `makeSalt()`（32 随机字节）生成一个密钥；
 *  - 写进 `<日志目录>/setup.key`（mode 0600，日志目录通常是挂载卷）；
 *  - 站点未初始化期间**反复** WARN 打印：启动一次 + 每
 *    `VANBLOG_SETUP_KEY_REMIND_MINUTES`（默认 10 分钟）重印一次，直到完成初始化
 *    （站长要求：全新实例可能放几个小时才有人来装，而 docker logs 会滚动，
 *    只印一次等于没印）；
 *  - 两条 init 路由必须携带密钥（**默认开启**，见下），比较用 `safeEqual`（常量时间）。
 *
 * ⚠️ **默认值的历史**：这个开关首版默认 `false`（"升级不破坏走到一半的安装"），
 * 站长随后拍板翻成**默认 `true`**：「首次安装要用密钥为true，每次检查到当前未安装
 * 时都在terminal中显示秘钥」。翻默认是**有意的破坏性变更**：升级时正走到一半的安装，
 * 下一次提交会 400 —— 但密钥在日志里反复打印，400 消息也指路（文件路径 +
 * docker logs 命令），逃生口是显式 `VANBLOG_INIT_REQUIRE_SETUP_KEY=false`。
 * 因此解析规则是：未设置/空 ⇒ **开**；显式 `false/0/no/off` ⇒ 关；
 * **无法识别的值 ⇒ 开 + WARN 点名**（打错的 `=flase` 绝不许静默把保护关掉 ——
 * 默认翻转之后，"静默失败"这个本仓库记录在案的头号陷阱指向的正是"静默关闭"）。
 *
 * 生命周期（为什么要删文件）：初始化成功后这把密钥**不再授予任何东西**
 * （两条路由对已初始化站点直接 403/500），而日志目录是挂载卷、还会被
 * `vanblog.sh backup` 打包 —— 留一个 0600 的"看着像活密钥"的文件本身就是味道。
 * 所以 init()/restore/env-bootstrap 成功后都调用 `clearSetupKey()` 删掉它，
 * 之后启动也不再生成（站点已初始化）。restore.key 不删：它一直有用（忘记密码）。
 *
 * ⚠️ 这个文件刻意只依赖 fs/path/config/crypto + Nest 的两个异常类 ——
 * 控制器经由 `InitProvider.assertSetupKeyAllowed` 调这里的 `enforceSetupKey`，
 * 校验与报错形状（wire 契约）都收敛在本文件里。
 */

export const SETUP_KEY_REQUIRE_ENV = 'VANBLOG_INIT_REQUIRE_SETUP_KEY';
export const SETUP_KEY_FILE_NAME = 'setup.key';

/** 未初始化期间重印密钥的间隔（分钟）。显式 `0` = 只在启动时印一次。 */
export const SETUP_KEY_REMIND_ENV = 'VANBLOG_SETUP_KEY_REMIND_MINUTES';
export const SETUP_KEY_REMIND_DEFAULT_MINUTES = 10;

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

export interface SetupKeyRequirement {
  enabled: boolean;
  /** false = 环境变量存在但不是可识别的布尔字面量（按**开启**处理，且必须 WARN 点名） */
  recognized: boolean;
}

/**
 * 解析开关。**默认开启**（未设置/空 ⇒ enabled）；显式 falsy 字面量才关闭；
 * 无法识别的值 ⇒ **开启** + `recognized:false`（启动路径的密钥块会 WARN 点名，
 * 绝不让一个打错的值静默关掉保护）。
 */
export function resolveSetupKeyRequirement(
  raw: string | undefined = process.env[SETUP_KEY_REQUIRE_ENV],
): SetupKeyRequirement {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '' || TRUTHY.has(value)) {
    return { enabled: true, recognized: true };
  }
  if (FALSY.has(value)) {
    return { enabled: false, recognized: true };
  }
  // 打错的值：回落到**安全的那一侧**（开），并要求调用方 WARN 点名
  return { enabled: true, recognized: false };
}

export function setupKeyRequired(
  raw: string | undefined = process.env[SETUP_KEY_REQUIRE_ENV],
): boolean {
  return resolveSetupKeyRequirement(raw).enabled;
}

/**
 * 解析重印间隔（分钟）。规则（站长要求"打错的字绝不能把提醒静音掉"）：
 *  - 未设置/空 ⇒ 默认 10；
 *  - 显式 `0` ⇒ 0（只在启动时印一次 —— 这是唯一能得到 0 的输入）；
 *  - 负数/NaN/垃圾 ⇒ 默认 10（**绝不回落成 0**）；
 *  - (0,1) 的小数 ⇒ 1（floor 之后也不许变成 0）。
 */
export function resolveSetupKeyRemindMinutes(
  raw: string | undefined = process.env[SETUP_KEY_REMIND_ENV],
): number {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return SETUP_KEY_REMIND_DEFAULT_MINUTES;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return SETUP_KEY_REMIND_DEFAULT_MINUTES;
  }
  if (value === 0) {
    return 0;
  }
  return Math.max(1, Math.floor(value));
}

/** 密钥文件路径：与 restore.key 同一个目录（config.log，容器里是 /var/log） */
export function setupKeyFilePath(logDir?: string): string {
  return path.join(logDir || config.log || '/var/log', SETUP_KEY_FILE_NAME);
}

/**
 * 本进程内存里的当前密钥。
 *
 * ⚠️ cluster 多 worker 时只有主实例生成密钥（isPrimaryInstance 约定），
 * 而请求可能落在任何 worker 上 —— 所以校验时内存没有就**回落读文件**
 * （同一容器内文件系统共享）。这也是"文件是事实来源、内存只是快路径"的原因。
 */
let currentKey: string | null = null;

export interface GeneratedSetupKey {
  key: string;
  filePath: string;
  /** 文件是否真的写出去了（挂载盘权限问题时可能为 false，此时密钥只在启动日志里） */
  written: boolean;
}

/** 生成新密钥：内存 + `<log>/setup.key`（0600）。镜像 initRestoreKey() 的写法与容错。 */
export function generateSetupKey(logDir?: string): GeneratedSetupKey {
  const key = makeSalt();
  currentKey = key;
  const filePath = setupKeyFilePath(logDir);
  let written = false;
  try {
    // mode 0o600：日志目录是**挂载到宿主机**的卷，默认 0644 等于宿主机人人可读
    fs.writeFileSync(filePath, key, { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600); // 文件已存在时 writeFileSync 的 mode 不生效
    } catch {
      // 权限改不动（比如挂载盘不支持）不该让整个启动失败
    }
    written = true;
  } catch {
    written = false;
  }
  return { key, filePath, written };
}

/** 本进程内存里的密钥（没有则 null）——只给测试与诊断用，绝不出现在 HTTP 响应里 */
export function currentSetupKey(): string | null {
  return currentKey;
}

/**
 * 校验用的"事实来源"：内存优先（生成它的那个进程），否则读文件
 * （cluster 里的其它 worker / 进程重启后文件仍在的场景）。
 * 读到的内容做 trim：文件里就是裸密钥（writeFileSync 不加换行），
 * 但挂载卷上被编辑器动过手脚时尾部空白不该让站长永远对不上。
 */
export function readSetupKey(logDir?: string): string | null {
  if (currentKey) {
    return currentKey;
  }
  try {
    const text = fs.readFileSync(setupKeyFilePath(logDir), 'utf-8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * 校验结果。⚠️ 刻意**不用可辨识联合**（`{ok:true} | {ok:false, reason}`）：
 * 本仓库 tsconfig 是 `strictNullChecks: false`，判别属性窄化不生效
 * （tsc 会报 "Property 'reason' does not exist on type '{ ok: true; }'"），
 * 所以按扁平接口给全字段，调用方自己按 ok/reason 分支。
 */
export interface SetupKeyVerdict {
  ok: boolean;
  /** 仅 ok=false 有意义：missing=没带；wrong=带了但不对；unavailable=服务端自己都没有密钥（配置/文件被删） */
  reason?: 'missing' | 'wrong' | 'unavailable';
  filePath: string;
}

/**
 * 校验客户端提交的密钥。**永远常量时间比较**（safeEqual，utils/crypto.ts），
 * 提交值先 trim（从文件/日志里复制时最容易带上换行）。
 * 密钥本身绝不出现在返回值里（也就不可能出现在 HTTP 响应里）。
 */
export function verifySetupKey(supplied: unknown, logDir?: string): SetupKeyVerdict {
  const filePath = setupKeyFilePath(logDir);
  const expected = readSetupKey(logDir);
  if (!expected) {
    return { ok: false, reason: 'unavailable', filePath };
  }
  const given = String(supplied ?? '').trim();
  if (!given) {
    return { ok: false, reason: 'missing', filePath };
  }
  return safeEqual(given, expected)
    ? { ok: true, filePath }
    : { ok: false, reason: 'wrong', filePath };
}

/**
 * 初始化成功（任何一条路由 / env 自动引导）之后清掉密钥：内存 + 文件。
 * 永不抛错（文件不在/删不动都不该影响已经成功的初始化）。
 */
export function clearSetupKey(logDir?: string): { removed: boolean } {
  currentKey = null;
  try {
    fs.rmSync(setupKeyFilePath(logDir), { force: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/**
 * 400 的文案。**这里的失败模式是"站长把自己锁在全新安装外面"**，
 * 所以消息必须告诉他密钥在哪：日志里反复打印的那个块 + 文件路径。
 * 消息是匿名可见的（这两条路由本来就匿名），路径与文件名不是秘密，
 * 秘密是文件内容 —— 绝不回显。
 */
export function setupKeyFailureMessage(
  reason: 'missing' | 'wrong',
  filePath: string = setupKeyFilePath(),
): string {
  const where =
    `密钥在 server 日志里反复打印（站点未初始化期间：启动一次，之后每 ${SETUP_KEY_REMIND_DEFAULT_MINUTES} 分钟一次；` +
    `docker logs <容器名> 2>&1 | grep 初始化密钥），` +
    `也写在日志目录的 ${filePath} 文件里（该目录通常挂载在宿主机上）。` +
    `密钥每次重启 vanblog 都会重新生成。`;
  if (reason === 'missing') {
    return (
      `本站开启了初始化保护（${SETUP_KEY_REQUIRE_ENV}，新版默认开启），但请求里没有初始化密钥（字段名 setupKey）：` +
      `请在「初始化密钥」一栏填入后重试。${where}`
    );
  }
  return `初始化密钥不正确：请完整复制 ${filePath} 文件的内容（或日志里「初始化密钥」那一行）后重试，注意不要带多余字符。${where}`;
}

export interface SetupKeyBlockInput {
  key: string;
  filePath: string;
  /** 开关解析结果（决定块里的"当前状态"行） */
  required: boolean;
  recognized: boolean;
  /** 原始 env 值（recognized:false 时点名用） */
  rawFlag?: string;
}

const BLOCK_RULE = '='.repeat(30);

/**
 * 未初始化期间反复打印的**视觉块**（WARN 级）。站长要求它"在长日志里用眼睛就能找到"，
 * 并且必须包含：站点未初始化这个事实、密钥本身、文件路径、
 * `docker logs <容器> 2>&1 | grep 初始化密钥` 的一行配方、"每次重启重新生成"、
 * 以及逃生口（VANBLOG_INIT_REQUIRE_SETUP_KEY=false）。
 *
 * 纯函数：调用方（InitProvider）把结果**缓存**起来，重印就是同一次字符串 ——
 * 每 10 分钟一次的重复打印不再做任何拼接分配。密钥在进程生命周期内不变
 * （重启才重新生成），所以缓存不会过期；唯一的重建时机是密钥被重新生成。
 */
export function buildSetupKeyBlock(input: SetupKeyBlockInput): string {
  let stateLine: string;
  if (!input.recognized) {
    stateLine =
      `⚠️ ${SETUP_KEY_REQUIRE_ENV} 的值「${String(input.rawFlag ?? '').slice(0, 40)}」无法识别，` +
      `按【要求密钥】处理（要关闭请显式设 false/0/no/off —— 打错的值绝不静默关闭保护）`;
  } else if (input.required) {
    stateLine =
      `当前状态：两条初始化接口【要求】携带此密钥（${SETUP_KEY_REQUIRE_ENV} 新版默认开启；` +
      `显式设 ${SETUP_KEY_REQUIRE_ENV}=false 可关闭，不推荐）`;
  } else {
    stateLine =
      `当前状态：${SETUP_KEY_REQUIRE_ENV}=false，初始化接口【不要求】密钥（显式关闭的逃生口）。` +
      `密钥照常生成并显示，随时把该变量改回 true 即可启用保护`;
  }
  return [
    `${BLOCK_RULE} VanBlog 初始化密钥（setup key） ${BLOCK_RULE}`,
    `站点尚未完成初始化：POST /api/admin/init 与 POST /api/admin/init/restore 仍对匿名请求开放，请尽快完成安装。`,
    `初始化密钥： ${input.key}`,
    `密钥文件： ${input.filePath}（0600；日志目录通常挂载在宿主机上）`,
    `这条日志被刷走了？执行： docker logs <容器名> 2>&1 | grep 初始化密钥`,
    `提交方式： 初始化页面会出现「初始化密钥」输入框（接口字段名 setupKey），向导与备份恢复共用同一个值。`,
    `注意： 密钥每次重启 vanblog 都会重新生成；站点完成初始化后自动删除密钥文件、停止本提醒。`,
    stateLine,
    `本提醒每 ${resolveSetupKeyRemindMinutes()} 分钟重印一次（${SETUP_KEY_REMIND_ENV}=0 可改为只印一次）。`,
    BLOCK_RULE + '='.repeat(BLOCK_RULE.length),
  ].join('\n');
}

/**
 * 控制器侧的密钥闸门：flag 关 ⇒ 直接放行（一个布尔判断，行为与旧版逐字节一致）；
 * 开 ⇒ 常量时间校验，没带/带错抛 **400**（wire body 带 `setupKeyRequired:true` 与
 * 机器可读 reason，前端 InitPage 据此显示输入框），服务端自己没有密钥抛 **500**
 * （`setupKeyUnavailable:true` —— 填了也没用，不骗人）。密钥绝不出现在响应里。
 */
export function enforceSetupKey(supplied: unknown, logDir?: string): void {
  if (!setupKeyRequired()) {
    return;
  }
  const verdict = verifySetupKey(supplied, logDir);
  if (verdict.ok) {
    return;
  }
  if (verdict.reason === 'unavailable') {
    throw new HttpException(
      {
        statusCode: 500,
        message:
          `服务端当前没有可用的初始化密钥（预期文件 ${verdict.filePath} 不存在，本进程内存里也没有）：` +
          `重启 vanblog 会重新生成并打印到日志。站点状态未受影响`,
        setupKeyUnavailable: true,
      },
      500,
    );
  }
  // strictNullChecks:false 下没有判别窄化：显式归一成两个字面值（unavailable 上面已经 throw）
  const reason: 'missing' | 'wrong' = verdict.reason === 'wrong' ? 'wrong' : 'missing';
  throw new BadRequestException({
    statusCode: 400,
    message: setupKeyFailureMessage(reason, verdict.filePath),
    // 前端（InitPage）按这个标志显示「初始化密钥」输入框并把 message 原样展示
    setupKeyRequired: true,
    reason: reason === 'missing' ? 'setupKeyMissing' : 'setupKeyWrong',
  });
}
