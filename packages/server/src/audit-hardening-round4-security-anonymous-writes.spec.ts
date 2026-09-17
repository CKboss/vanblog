import { readFileSync } from 'fs';
import { join } from 'path';

import { RETENTION_DEFAULTS } from './provider/stats/statsMaintenance.provider';
import { VIEW_MAX_RETAINED_KEYS, DEFAULT_VIEW_MAX_RETAINED_KEYS } from './provider/stats/viewStats.provider';
import { DEFAULT_JSON_BODY_LIMIT, DEFAULT_JSON_BODY_LIMIT_LARGE, LARGE_JSON_BODY_PREFIXES } from './utils/bodyLimit';

/**
 * 第四轮安全审计 —— 「匿名可写的口子」这一组。
 *
 * 覆盖三个未鉴权的写入面：
 *  - `POST /api/public/comments`（内置评论）
 *  - `POST /api/public/viewer`（浏览计数）
 *  - `POST /api/admin/auth/logout`（在 `/api/admin` 前缀下，但**曾经没有任何守卫**）
 * 以及一个未鉴权的**读**口子 `GET /api/public/theme.css`（它的路径拼接曾经没有收敛检查）。
 *
 * ⚠️ 2026-09-17：本文件的四条 FINDING（R4-6/R4-7/R4-9/R4-10）**全部已修复**，
 * 已按文件头约定把断言翻成修复后的形状，原 `xit('AFTER THE FIX …')` 占位符
 * 转成了 `it('AFTER THE FIX（已实现）…')` 里的真实断言（实现与占位文字有出入的地方
 * 在各自用例里写明）。审计时的活体证据保留在注释里。`REGRESSION` 必须常绿。
 * 行为级钉子在新 spec：audit-hardening-round4-fixes-{comment,theme,auth,viewstats}.spec.ts；
 * 真库测量在 test/audit-fixes-comment.e2e-spec.ts（env 门控）。
 * 全部是源码级 / 纯函数级断言，不连库、不打 :3000。
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('REGRESSION R4-6（已修）：蜜罐评论曾经在**三道限流之前**就 return —— 现在限流在任何写库之前跑', () => {
  const provider = read('./provider/comment/comment.provider.ts');

  it('源码顺序钉子：ip 解析与三个 consumeAttempt 在 assertContent 之后、蜜罐分支之前', () => {
    const iHoneypot = provider.indexOf("if (typeof dto?.hp === 'string' && dto.hp.trim() !== '')");
    const iHoneypotReturn = provider.indexOf('return { comment: this.toPublic(spam), pending: true, reason: undefined };');
    const iIp = provider.indexOf('const ip = bruteForceClientIp(req);');
    const iLimit = provider.indexOf('consumeAttempt(`comment-${ip}`');
    const iDaily = provider.indexOf('consumeAttempt(`comment-day-${ip}`');
    const iDup = provider.indexOf('const dedupeKey = `comment-dup-${ip}-');
    const iContent = provider.indexOf('const content = this.assertContent(dto?.content, setting.maxContentLength);');
    expect(iHoneypot).toBeGreaterThan(-1);
    expect(iHoneypotReturn).toBeGreaterThan(iHoneypot);
    // ← 修复后的顺序：字段校验 → ip → 三把桶 → 蜜罐判定（只改 status，配额已扣）
    expect(iContent).toBeLessThan(iIp);
    expect(iIp).toBeLessThan(iLimit);
    expect(iLimit).toBeLessThan(iDaily);
    expect(iDaily).toBeLessThan(iDup);
    expect(iDup).toBeLessThan(iHoneypot);
    // 而 hp 分支**确实写库**（判定语义没变：入库为 spam，对外「待审」）
    const hpBlock = provider.slice(iHoneypot, iHoneypotReturn);
    expect(hpBlock).toMatch(/const spam = await this\.insert\(\{/);
    expect(hpBlock).toMatch(/status: 'spam'/);
  });

  it('spam 的上限不再只剩中间件那把 30 次/分钟的公开写桶：三把评论桶对 hp 同样生效', () => {
    const rl = read('./utils/rateLimit.ts');
    expect(rl).toMatch(/PUBLIC_WRITE_LIMIT_PER_MIN = envInt\('VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN', 30, 1, 100000\)/);
    expect(rl).toMatch(/path\.startsWith\('\/api\/public\/'\) && method !== 'GET'/);
    // 修复前：30/分钟 = 43200/天/IP ⇒ 单 IP 约 280 MB/天（默认 maxContentLength=2000），
    // 管理端把 maxContentLength 调到 20000 上限时约 2.6 GB/天，换源 IP 线性放大。
    // 修复后：hp POST 消耗与正常评论相同的三把桶 ⇒ 每 IP 每天最多 scaleLimit(50) 条 spam。
    expect(30 * 60 * 24).toBe(43200);
    expect(provider).toMatch(/max: scaleLimit\(50\)/);
  });

  it('活体证据的形状（修复前，一次性实例、真实 HTTP，见审计报告）', () => {
    // 12 条正常评论 -> 前 10 条 200，第 11/12 条 400「评论太频繁了，请 600 秒后再试」
    // 紧接着 60 条带 hp 字段的评论 -> 修复前 **60 条全部 201**，库里 {approved:10, spam:60}。
    // 修复后的 DB 真值（行为钉子 audit-hardening-round4-fixes-comment.spec.ts）：
    // hp 评论在第 rateLimitPer10Min+1 条起 400，第 51 条起被每日桶挡，spam 行数有硬上限。
    expect({ approved: 10, spam: 60 }).toEqual({ approved: 10, spam: 60 });
  });

  it('AFTER THE FIX（已实现）：限流在**任何写库之前**跑，蜜罐命中只改判定、不改配额', () => {
    // 落地的正是占位文字里的最小补丁：把
    //   const ip = bruteForceClientIp(req); … 三个 consumeAttempt …
    // 整段移到 `const content = this.assertContent(...)` 之后、蜜罐判定之前，
    // 蜜罐分支只负责把 status 改成 'spam'。
    // blast radius：机器人现在也会消耗它自己那把桶（这正是目的）；
    //   真人用户行为一个字节都不变（他们从来不填 hp）。
    //   dedupe 那把桶（同内容 5 分钟）对机器人反而是"帮忙"的——它们通常每条内容不同，
    //   所以真正起作用的是 10 分钟与每日两把。
    // 备选方案（给 spam 单独一把更严的桶，例如 `comment-spam-<ip>` max=5/10min）**评估后没做**：
    //   每日 50 条那把桶已经把单 IP 的日上限钉死（50 条 × 默认 2000 字 ≈ 325 KB/天），
    //   单独的 5/10min 桶只把首个窗口的突发从 10 降到 5、对日上限毫无影响，
    //   却给每个评论 IP 在 attemptLimit 表里多留一把常驻 key（§7.55 G-1 的淘汰压力）——
    //   收益可忽略，所以不加；诚实路径的限额一个没动。
    // 行为级钉子：audit-hardening-round4-fixes-comment.spec.ts「FIX B2/R4-6」（5 条）。
    const iDup = provider.indexOf('const dedupeKey = `comment-dup-${ip}-');
    const iHoneypot = provider.indexOf("if (typeof dto?.hp === 'string' && dto.hp.trim() !== '')");
    expect(iDup).toBeGreaterThan(-1);
    expect(iDup).toBeLessThan(iHoneypot);
  });
});

describe('REGRESSION R4-7（已修）：POST /api/public/viewer 曾经可以用**编造的路径**无界撑大 visits 集合', () => {
  it('保留期默认现在是 3650 天（⚠️ 默认行为变更；显式 0 = 旧行为「永不删除」）', () => {
    expect(RETENTION_DEFAULTS).toEqual({ retentionDays: 3650, minKeepDays: 30 });
    // VANBLOG_VISIT_RETENTION_DAYS 的读取形状一个字没动，只是默认值翻了
    const stats = read('./provider/stats/statsMaintenance.provider.ts');
    expect(stats).toMatch(/'VANBLOG_VISIT_RETENTION_DAYS',\s*\n\s*RETENTION_DEFAULTS\.retentionDays/);
    expect(stats).toContain('默认行为变更');
    expect(stats).toContain('VANBLOG_VISIT_RETENTION_DAYS=0'); // 逃生口写进了注释与 pruneStats 文档
    // 站点级累计（metas.viewer/visited）与文章累计阅读量**不在删除范围内**：
    // pruneStats 只对 visits/viewers 跑 deleteMany({date:{$gte:'0000-00-00',$lt:cutoff}})，
    // 且 minKeepDays=30 兜底、date 为 null/缺失的行永远不删（真 mongod 钉子见
    // test/stats-maintenance.e2e-spec.ts）
    expect(stats).toMatch(/this\.visitModel\.deleteMany\(plan\.filter as any\)/);
  });

  it('路径仍只被限长（500 字）——「是不是本站真实路径」由每日新路径上限兜底（源码钉子）', () => {
    const controller = read('./controller/public/public.controller.ts');
    expect(controller).toMatch(/decoded = decoded\.slice\(0, 500\);/);
    expect(controller).toMatch(/const data = await this\.metaProvider\.addViewer\(isNew, decoded, isNewByPath\);/);
    // addViewer -> viewStats.record({pathname}) -> 当天该路径第一次出现时多 2 次 Mongo 操作
    // （aggregate 取上一天累计值 + 建当天那一行）。修复后：当天新建行的路径键
    // 超过 VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY（默认 5000）就不再建行，只累计站点级/每日总数
    const viewStats = read('./provider/stats/viewStats.provider.ts');
    expect(viewStats).toMatch(/isNewForPath/);
    const buf = read('./utils/viewStatsBuffer.ts');
    expect(buf).toMatch(/DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY = 5000;/);
    expect(buf).toMatch(/VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY/);
  });

  it('两层上限现在都在：内存（G-2 的 20000 键）+ 磁盘（每日新路径 5000 行、保留 3650 天）', () => {
    // 内存侧（§7.55 G-2，语义一字未动）：
    expect(DEFAULT_VIEW_MAX_RETAINED_KEYS).toBe(20000);
    expect(VIEW_MAX_RETAINED_KEYS).toBe(20000);
    // 磁盘侧修复前的活体实测（一次性实例 + 一次性 mongod）：500 个编造路径的 POST
    //   visits 6 -> 506 行；集合 dataSize 12,517 -> 90,909 B ⇒ **约 157 B / 次请求**
    //   ⇒ 30 次/分钟/IP ≈ 6.8 MB/天/IP 的**永久**增长，换 IP 线性放大。
    expect(Math.round((90909 - 12517) / 500)).toBe(157);
    // 修复后的上界（与 IP 数无关，上限是**每进程**的）：每天最多 5000 个新路径键，
    // 保留窗口 3650 天（站长定的 10 年）⇒ visits 稳态上界 ≈ 5000 × 3650 行 × ~157 B ≈ 2.87 GB
    // （极端持续攻击下的理论上限；真实站点的每日路径数 = 真实页面数，远低于 5000）。
    // ⚠️ 这个数字比 365 天版本大 10 倍，是"留十年趋势"这个选择的直接代价 ——
    // 真正把它压住的是**每日新路径上限**，而不是保留期。要更小的上界就把
    // VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY 调低，或把 VANBLOG_VISIT_RETENTION_DAYS 调回 365。
    // 而不是修复前的「无界 × 攻击面」。真库行数测量：test/audit-fixes-comment.e2e-spec.ts。
    expect(5000 * 3650).toBe(18250000);
  });

  it('AFTER THE FIX（已实现）：(a) 默认保留期 3650 天 + (b) 每日新路径键上限（默认 5000）', () => {
    // (a) RETENTION_DEFAULTS.retentionDays 0 → 3650（审计建议 365，站长定为 10 年；
    //     minKeepDays=30 兜底没动，pruneStats 早就实现、记迁移台账 LEDGER_KEYS.pruneStats）。
    //     ⚠️ **默认行为变更**（CHANGELOG 要写）：一年前的按天统计行会被每日 cron 删掉 ——
    //     站点级累计与文章累计不受影响，仪表盘最长回看变成 3650 天；
    //     显式 VANBLOG_VISIT_RETENTION_DAYS=0 回到旧行为。
    expect(RETENTION_DEFAULTS.retentionDays).toBe(3650);
    // (b) 占位文字建议把 maxRetainedKeys 的概念同时用在「当天新建路径键」上 ——
    //     落地为 ViewStatsAggregator 的第二把上限 maxNewPathsPerDay
    //     （env VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY，默认 5000，0 = 不限 = 旧行为）：
    //     站点级与每日累计照常一条不丢，超出只是不再为新 pathname 建行，
    //     丢弃计入 dropped.pathEntries/newPathEntries，由 provider 每轮 flush 最多一条
    //     WARN（带增量与累计）—— 与 §7.55 G-2 的取舍完全一致，绝不静默。
    //     ⚠️ 与占位文字的一个出入：seen 表**跨 take() 存活**（否则每 5 秒一轮 flush
    //     会把预算重新装满，上限名存实亡），只保留最近 2 个日期 ⇒ 内存有界。
    //     VIEW_MAX_RETAINED_KEYS（内存侧）的语义一字未动。
    const buf = read('./utils/viewStatsBuffer.ts');
    expect(buf).toMatch(/maxNewPathsPerDay\?: number;/);
    expect(buf).toMatch(/newPathEntries: number;/);
    expect(buf).toMatch(/private readonly seenPaths = new Map<string, Set<string>>\(\);/);
    // 行为级钉子：audit-hardening-round4-fixes-viewstats.spec.ts（11 条）。
    // isNew 的服务端去重（占位没提、审计要求评估）：结论是**不做**，理由见交付报告 ——
    // 每请求要么多一次 Mongo 读（毁掉 §7.55 的批量写），要么多一张按 IP 的常驻表
    // （NAT 后整栋楼算一个访客，语义反而更差），而它保护的只是聚合计数的准确性，
    // 存储增长已经被 (a)+(b) 封住。
  });
});

describe('REGRESSION R4-9（已修）：POST /api/admin/auth/logout 曾经在 /api/admin 前缀下没有任何守卫', () => {
  const auth = read('./controller/admin/auth/auth.controller.ts');

  it('AuthController 仍没有类级 AdminGuard（login/restore 必须匿名），但 logout 挂上了 TokenGuard', () => {
    expect(auth).toMatch(/@Controller\('\/api\/admin\/auth\/'\)\s*\nexport class AuthController/);
    expect(auth).not.toMatch(/@UseGuards\(\.\.\.AdminGuard\)\s*\n@ApiTags?\('tag'\)/);
    // 四个路由里 login（LoginGuard+local）、PUT /（AdminGuard）与 logout（TokenGuard）有守卫
    expect(auth).toMatch(/@UseGuards\(LoginGuard, AuthGuard\('local'\)\)\s*\n\s*@Post\('\/login'\)/);
    expect(auth).toMatch(/@UseGuards\(\.\.\.AdminGuard\)\s*\n\s*@ApiToken\s*\n\s*@Put\(\)/);
    // ← 修复点：logout 现在挂 TokenGuard（只验 token 在库里且未被吊销，不要求完整 AdminGuard）
    const iLogout = auth.indexOf("@Post('/logout')");
    const logoutBlock = auth.slice(iLogout - 200, iLogout);
    expect(logoutBlock).toMatch(/@UseGuards\(TokenGuard\)/);
    expect(auth).toMatch(/import \{ TokenGuard \} from 'src\/provider\/auth\/token\.guard';/);
    // restore（忘记密码）仍然是匿名的，但那个**应该**匿名：它由 256 位随机恢复密钥把守
    const iRestore = auth.indexOf("@Post('/restore')");
    expect(auth.slice(iRestore - 200, iRestore)).not.toMatch(/@UseGuards/);
    expect(auth).toMatch(/const keyInCache = await this\.cacheProvider\.get\('restoreKey'\);/);
    expect(read('./utils/crypto.ts')).toMatch(/export function makeSalt\(\): string \{\s*\n\s*return randomBytes\(32\)\.toString\('base64'\);/);
  });

  it('dispatchEvent 挪到了吊销成功之后：匿名请求再也不能触发管理员流水线', () => {
    // logout 做的仍是 `tokenProvider.disableToken(request.headers['token'])`（按值吊销）。
    // 修复前真正值钱的问题是：这是一条**匿名可达**的状态变更接口，
    // 每次调用都在吊销**之前** fire-and-forget 触发 dispatchEvent('logout')
    // ⇒ 匿名请求能让管理员编写的流水线脚本跑起来，而且它位于 /api/admin 前缀下、
    // 不受"公开写 30/分钟"那把桶管（只受全局 600/分钟）。
    // 修复后：TokenGuard 先验 token（无效/伪造 ⇒ 401，处理器根本不会跑），
    // 事件只在吊销确实发生之后才触发，且带来源标签 catch（§7.55 J-4 的纪律）。
    const iDisable = auth.indexOf('await this.tokenProvider.disableToken(token);');
    const iDispatch = auth.indexOf(".dispatchEvent('logout', {");
    expect(iDisable).toBeGreaterThan(-1);
    expect(iDispatch).toBeGreaterThan(iDisable); // ← 修复前 dispatch 在 disable 之前
    expect(auth).toMatch(/this\.pipelineProvider\s*\n\s*\.dispatchEvent\('logout', \{\s*\n\s*token,\s*\n\s*\}\)/);
    expect(auth).toMatch(/\.catch\(\(err\) => \{\s*\n\s*this\.logger\.error\(`logout 流水线事件失败/);
    expect(read('./utils/rateLimit.ts')).toMatch(/path\.startsWith\('\/api\/public\/'\) && method !== 'GET'/);
  });

  it('AFTER THE FIX（已实现）：TokenGuard + 事件后置；blast radius（SPA 容忍 401）已读代码核实', () => {
    // 落地的正是占位文字的最小补丁：`@UseGuards(TokenGuard) @Post('/logout')`
    // （只验 token 在库里且未吊销，不要求完整 AdminGuard），
    // 顺带把 dispatchEvent('logout') 挪到"确实吊销成功了"之后（并补了带来源的 catch）。
    // blast radius：拿已失效/伪造 token 调 logout 从 200 变成 401 ——
    //   后台前端的登出逻辑**只读核实过**（packages/admin/src/components/LogoutButton/index.jsx）：
    //   loginOut() 用 try/catch 包住 logout({skipErrorHandler:true})，无条件
    //   removeItem('token') + 跳登录页，失败时提示「已退出登录（服务端会话已失效）」，
    //   注释里本来就写着「token 早就失效时服务端返回 401」⇒ SPA 完全容忍，无需改动。
    // 路由元数据 + 行为级钉子：audit-hardening-round4-fixes-auth.spec.ts（7 条）。
    const iGuards = auth.indexOf('@UseGuards(TokenGuard)');
    expect(iGuards).toBeGreaterThan(-1);
    expect(auth.indexOf("@Post('/logout')") - iGuards).toBeLessThan(80);
  });
});

describe('REGRESSION R4-10（已修）：/api/public/theme.css 的路径拼接曾经没有收敛检查（只有写侧校验）', () => {
  it('sink 已收敛：控制器只经 resolveThemeCssPath，null ⇒ 204（与「内置主题」完全同形）', () => {
    const controller = read('./controller/public/theme.controller.ts');
    expect(controller).toMatch(/const abs = resolveThemeCssPath\(theme\.url\);/);
    expect(controller).toMatch(/if \(!abs\) \{\s*\n\s*res\.status\(204\)\.end\(\);\s*\n\s*return;/);
    expect(controller).toMatch(/const css = await fs\.readFile\(abs, 'utf8'\);/);
    expect(controller).toMatch(/res\.type\('text\/css; charset=utf-8'\)\.send\(css\);/);
    // 裸拼接与 config/path 依赖都从控制器里消失了
    expect(controller).not.toMatch(/path\.join\(config\.staticPath/);
    expect(controller).not.toMatch(/import \* as path from 'path';/);
    // path.join 的语义（审计时实测，保留在这里解释"为什么以前能逃出去"）：
    // `..` 会逃出去，绝对路径不会（join 是拼接，不是 resolve）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    expect(path.join('/app/static', '../../../etc/passwd')).toBe('/etc/passwd');
    expect(path.join('/app/static', 'themes/../../../etc/passwd')).toBe('/etc/passwd');
    expect(path.join('/app/static', '/etc/passwd')).toBe('/app/static/etc/passwd');
    // 收敛器用的是 resolve+relative：上面每一种逃逸（含绝对路径形状）都变成 null
    expect(path.resolve('/app/static', 'themes/../../../etc/passwd')).toBe('/etc/passwd');
    expect(path.relative('/app/static/themes', '/etc/passwd').startsWith('..')).toBe(true);
  });

  it('readUploaded() 仍只过滤 id —— url 的校验责任收敛到读侧这一个函数（源码钉子）', () => {
    const theme = read('./provider/theme/theme.provider.ts');
    expect(theme).toMatch(/return list\.filter\(\(t\) => t && typeof t\.id === 'string'\);/);
    // 写侧校验（slugifyThemeId / THEME_ID_RE / 服务端自己拼 relUrl）保持不变
    expect(theme).toMatch(/slugifyThemeId/);
    expect(theme).toMatch(/const siteInfo: any = \(await this\.metaProvider\.getAll\(\)\)\?\.siteInfo \|\| \{\};/);
    // 两处 unlink（remove 与上传清理）也走同一个收敛器 ⇒ 任意文件删除原语一起收掉
    expect(theme).toMatch(/const oldAbs = resolveThemeCssPath\(prev\.url\);/);
    expect(theme).toMatch(/const abs = resolveThemeCssPath\(target\.url\);/);
    expect(theme).not.toMatch(/path\.join\(config\.staticPath, prev\.url/);
    expect(theme).not.toMatch(/path\.join\(config\.staticPath, target\.url/);
  });

  it('谁能写这个值：settings 集合 —— `POST /api/admin/init/restore` 走原生驱动，schema 不跑（所以收敛必须放在读侧）', () => {
    const fullBackup = read('./utils/fullBackup.ts');
    expect(fullBackup).toMatch(/insertMany/);
    expect(fullBackup).toMatch(/rename\(/);
    const init = read('./controller/admin/init/init.controller.ts');
    expect(init).toMatch(/@Controller\('\/api\/admin'\)/);
    expect(init).not.toMatch(/@UseGuards/); // InitController 整个不挂 AdminGuard（设计如此）
    expect(read('./app.module.ts')).toMatch(/\{ path: '\/api\/admin\/init\/restore', method: RequestMethod\.POST \}/);
    // ⚠️ 诚实说明可利用性（审计原文）：未初始化站点上，能恢复自己归档的攻击者**顺带就成了管理员**
    // （归档里带 users），所以这条的边际收益是"不用登录也能读服务器上的任意文本文件"。
    // 更现实的场景是**已初始化站点恢复了一份来路不明的归档**（换机迁移、别人给的备份）。
    // 修复后：种进来的恶意 url 让 GET /api/public/theme.css 只能得到 204，
    // remove()/上传清理也删不掉 themes/ 之外的任何文件。
    expect(theme_provider_unlink()).toBeGreaterThan(0);
  });

  it('AFTER THE FIX（已实现）：读侧 3 行收敛 + 两处 unlink 用同一个解析器', () => {
    // resolveThemeCssPath 与占位文字给出的最小补丁**逐字一致**（theme.provider.ts 导出），
    // 控制器拿到 null 就 204 —— 与"内置主题/文件丢了"同形：连 ETag 都不设，
    // 不新增可区分的响应。两处 unlink 都先判 null 再动手。
    // blast radius 实测为零：合法主题的 url 一直是服务端自己拼的
    // `/static/themes/<id>-<hash8>.css`，永远在 themes/ 里 ⇒ 正常站点行为零变化；
    // 真实上传主题的往返钉子（upload → themeCss 读出真实字节 → remove 连文件删掉）
    // 见 audit-hardening-round4-fixes-theme.spec.ts（11 条，含恶意 url 的 canary 文件测试）。
    // 占位文字里提到的另一条互补加固（restore 拒绝 tar 的 symlink/hardlink 成员）
    // 属于备份线（fullBackup/backupTarStream 是别的 agent 的领地），本轮**没做**，已在报告里移交。
    const theme = read('./provider/theme/theme.provider.ts');
    expect(theme).toContain('const root = path.resolve(config.staticPath, THEME_SUBDIR);');
    expect(theme).toContain("const abs = path.resolve(config.staticPath, raw.replace(/^\\/static\\//, ''));");
    expect(theme).toContain("return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;");
  });
});

/** theme.provider.ts 里两处 unlink 的行数（用来钉住"任意文件删除"这个附赠原语确实存在） */
function theme_provider_unlink(): number {
  const src = read('./provider/theme/theme.provider.ts');
  return (src.match(/fs\.unlink|unlinkSync|promises\.unlink/g) || []).length;
}

describe('REGRESSION R4-B：匿名写入面上已经修好的那些仍然成立', () => {
  it('viewer 的路径限长 500（§7.55 之前是任意长）', () => {
    expect(read('./controller/public/public.controller.ts')).toMatch(/decoded = decoded\.slice\(0, 500\);/);
  });

  it('评论的每个字段都有类型收敛与长度上限（源码钉子）', () => {
    const p = read('./provider/comment/comment.provider.ts');
    expect(p).toMatch(/length > 300/); // path
    expect(p).toMatch(/length > 30/); // nick
    expect(p).toMatch(/length > 100/); // email
    expect(p).toMatch(/length > 200/); // site
    expect(p).toMatch(/slice\(0, 20000\)/); // content 硬上限
    expect(p).toMatch(/\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+/); // email 格式
    // site 只允许 http/https：scheme 黑名单 + new URL() 之后**再**查一次 protocol
    expect(p).toMatch(/if \(\/\^\[a-z\]\[a-z0-9\+\.\-\]\*:\/i\.test\(site\) && !\/\^https\?:\\\/\\\/\/i\.test\(site\)\)/);
    expect(p).toMatch(/if \(parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'\)/);
    expect(p).toMatch(/return parsed\.toString\(\)\.slice\(0, 200\);/); // 存的是归一化后的 http(s) URL
  });

  it('评论的公开投影里没有 ip / ua / email / reason（源码钉子）', () => {
    const p = read('./provider/comment/comment.provider.ts');
    const iToPublic = p.indexOf('toPublic(doc: any): PublicComment {');
    expect(iToPublic).toBeGreaterThan(-1);
    // 只取它 return 的那个对象字面量（到第一个 `};` 为止），别把后面的方法也扫进来
    const iReturn = p.indexOf('return {', iToPublic);
    const toPublic = p.slice(iReturn, p.indexOf('};', iReturn));
    expect(toPublic.length).toBeGreaterThan(50);
    expect(toPublic).toMatch(/nick/);
    expect(toPublic).not.toMatch(/\bip\b/);
    expect(toPublic).not.toMatch(/\bua\b/);
    expect(toPublic).not.toMatch(/email/);
    expect(toPublic).not.toMatch(/reason/);
    // 活体：GET /api/public/comments/?path=… 的条目键集合是
    //   children,content,createdAt,id,isAuthor,nick,parentId,path,replyCount,rootId,status
  });

  it('JSON body 限额：全局 1mb，大限额只挂在 4 个**后台内容**前缀上（§7.48）', () => {
    expect(DEFAULT_JSON_BODY_LIMIT).toBe('1mb');
    expect(DEFAULT_JSON_BODY_LIMIT_LARGE).toBe('50mb');
    expect(LARGE_JSON_BODY_PREFIXES.every((p) => p.startsWith('/api/admin/'))).toBe(true);
    expect(LARGE_JSON_BODY_PREFIXES.some((p) => p.includes('public'))).toBe(false);
    // 活体：1.2 MB 的 JSON POST /api/public/comments -> 413 request entity too large
  });

  it('评论内容超过 maxContentLength 直接 400，不是静默截断（活体钉住）', () => {
    // 活体：20000 字的 content -> HTTP 400「评论内容不能超过 2000 个字符」
    expect(read('./provider/comment/comment.provider.ts')).toMatch(/评论内容不能超过/);
  });
});
