/**
 * 🔴 服务端多语言**收口台账**（期 9 第十六批建立）。
 *
 * ## 这份文件解决什么问题
 * 到第十六批为止，服务端"带中文的 throw 站点"从 211 降到 27、"`message:` 带中文的返回体"从 108 降到 18，
 * 但**剩下的 45 处一直只是"两个棘轮数字"** —— 谁也说不清"哪些是该翻还没翻的、哪些是**永远不该翻**的"。
 * 于是每一批都要重新判断一次，而且 🔴 **新增一处中文没人会发现**（棘轮只保证"不超预算"，
 * 预算还有余量时新加一处中文是完全静默的）。
 *
 * 这份台账把"剩下的每一处"逐条登记，并且判据要求：
 * 1. 🔴 **全覆盖**：源码里每一处剩余的中文站点都必须在台账里（新加一处没登记的 ⇒ 立刻红）；
 * 2. 🔴 **无死条目**：台账里每一条都必须在源码里**真的还能找到**（迁走了就要从台账删掉，
 *    否则台账会慢慢变成一份"看起来还有很多没做"的假账）；
 * 3. 🔴 **分类正确**：`permanent`（永久例外，写明理由）与 `iou`（欠条，写明在哪一批还）两种，
 *    每条都要有 `why`；`iou` 还必须有 `batch`。
 *
 * ## 定位方式：`file` + `anchor`（**不用行号**）
 * 🔴 行号会因为上面插注释而漂移（本项目已因此返工 3 次）⇒ 用"那处中文里的一段唯一文本"当锚点。
 * 锚点必须**在该文件里唯一**（判据会检查；不唯一就换一个更长的片段）。
 *
 * ## "收口"的定义
 * 👉 🔴 **收口不是"数字变成 0"**，而是"剩下的每一处都在台账里、且每条都有理由"：
 * `permanent` 那些是**故意不翻**的（翻了会坏），`iou` 那些是**排队等某一批**的。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
// 🔴 仓库根是 `adminRoot/../..`（`adminRoot/..` 只到 `packages/`）—— 这正是 §7.197 C 记的那个坑：
//    本仓库里 `read()` / `readRepo()` / `repoRoot` 这几个名字在**不同文件里指向不同的根**，
//    我写这个新文件时又照着印象写了一遍 ⇒ `Cannot find module …/packages/scripts/i18n/astInventory.js`。
//    👉 报错信息里的路径**多出一层或少一层**时，第一件事是去数 `..` 的层数。
const repoRoot = path.join(adminRoot, '..', '..');
const serverSrc = path.join(repoRoot, 'packages/server/src');
const ai = require(path.join(repoRoot, 'scripts/i18n/astInventory.js'));

// ── 台账 ────────────────────────────────────────────────────────────────
// kind: 'permanent' = 永久例外（**故意不翻**，翻了会坏）；'iou' = 欠条（排队等某一批）
const LEDGER = [
  // ══ A. 协议字符串：前端拿它做**字面量比对**，翻了两边就对不上（3 处 throw + 1 处 message）══
  {
    kind: 'permanent',
    file: 'controller/admin/init/init.controller.ts',
    // ⚠️ 锚点不能只写「已初始化」—— 那个词在这个文件里出现 **10 次**（注释里也在讨论它）
    //    ⇒ 会不精确（把别的行也算成"已登记"）。用**带引号的字面量**当锚点。
    anchors: ["'已初始化'"],
    count: 2,
    why:
      '🔴 **线路协议字符串**：后台 `InitPage` 拿响应文本与「已初始化」逐字比对来判断"站点是否已初始化"。' +
      '只翻服务端会让那个判断静默失效（站点会被当成"未初始化"，于是初始化页重新开放 ⇒ 安全事故）。' +
      '要改必须**前后端一起**改成按 `code` 判断，而那要先给"已初始化"这个**成功**响应也配上码机制' +
      '（现在码表是错误导向的）。已在后台硬编码棘轮的永久例外清单里登记过同一条。',
  },
  {
    kind: 'permanent',
    file: 'provider/auth/init.middleware.ts',
    anchors: ['未初始化!'],
    count: 1,
    why:
      '🔴 同上一族：`statusCode: 233` + `未初始化!` 是**前端按字面量识别**的协议响应' +
      '（233 是这个仓库自己的魔数，不是 HTTP 语义）。翻它同样要前后端一起改。',
  },

  // ══ B. 开发者不变量：消息里带函数名/内部字段名，是给**运维与开发者**看的（8 处）══
  {
    kind: 'permanent',
    file: 'controller/public/public.controller.ts',
    anchors: ['publicListCacheKey: 未知的 kind'],
    count: 1,
    why:
      '🔴 **开发者不变量**：消息里带着**函数名**（`publicListCacheKey`），注释写明"不要静默降级成一个共用键"，' +
      '它会以 500 的形式暴露给运维而不是站长。翻成三语没有意义（没有用户会看到），' +
      '而"跟着界面语言漂"反而会让日志检索失效。',
  },
  {
    kind: 'permanent',
    file: 'provider/meta/meta.provider.ts',
    anchors: ['站点的 meta 文档不存在'],
    count: 1,
    why: '🔴 开发者不变量：源码注释明写「这是服务端代码缺陷，不是请求问题」⇒ 属内部断言，不是用户文案。',
  },
  {
    kind: 'permanent',
    file: 'utils/queryFilter.ts',
    anchors: ['拒绝执行写操作，因为查询条件'],
    count: 2,
    why:
      '🔴 开发者不变量（**安全护栏**）：空查询条件会命中集合里的任意一条 ⇒ 这是防"误删全库"的内部断言，' +
      '触发它就说明**服务端代码有缺陷**。给站长看三语译文没有意义（他无法处置），' +
      '而这条消息同时会进日志 ⇒ 保持中文（与日志一致）更利于排障。',
  },
  {
    kind: 'permanent',
    file: 'utils/backupCodec.ts',
    anchors: ['无法解析 BSON 构造器'],
    count: 1,
    why: '🔴 开发者不变量：消息里点名 `mongoose.mongo` 与 `mongodb` 两个**依赖**，属部署/依赖问题，不是请求问题。',
  },
  {
    kind: 'permanent',
    file: 'utils/keyedSingleFlight.ts',
    anchors: ['keyedSingleFlight.read: key 必须是非空字符串'],
    count: 1,
    why: '🔴 开发者不变量：消息里带**函数名**，是调用方传错参数的内部断言（用户永远看不到）。',
  },
  {
    kind: 'permanent',
    file: 'utils/degradedServeHtml.ts',
    anchors: ['哨兵状态不可读'],
    count: 1,
    why:
      '🔴 开发者不变量：这是"降级服务"路径上的内部状态断言，触发时站点已经在异常态；' +
      '它同时进日志 ⇒ 保持中文与日志一致。',
  },
  {
    kind: 'permanent',
    file: 'utils/thumbnail.ts',
    anchors: ['缩略图结果声明 ok='],
    count: 1,
    why:
      '🔴 开发者不变量：消息明写「"生成成功就必须有 buffer" 这个不变量被破坏了」⇒ 内部契约断言，' +
      '不是用户可处置的文案（用户能做的只有重试，而重试的信息在别处给）。',
  },

  // ══ C. 机器消费方：响应是给 caddy 看的，不是给人看的（1 处）══
  {
    kind: 'permanent',
    file: 'controller/admin/caddy/caddy.controller.ts',
    anchors: ['未授权的域名'],
    count: 1,
    why:
      '🔴 **机器消费方**：那个 403 是 ACME on-demand TLS 的 ask 端点回给 **caddy** 的，' +
      '没有任何界面会渲染它。翻它只会让 caddy 侧的排障文本跟着界面语言漂。' +
      '（同文件里另有一处 `message:` 是给后台看的 ⇒ 登记在下面的欠条里。）',
  },

  // ══ D. 报告/产物内容：写进校验报告与备份状态文件，属**产物**不是界面文案（6 处 message）══
  {
    kind: 'permanent',
    file: 'utils/backupVerify.ts',
    anchors: [
      '归档里解不出 ./manifest.json',
      'isFullBackupManifest 不通过',
      '缺少 .manifest.json sidecar',
      'sidecar 清单不是合法的整站备份清单',
      'sidecar 清单与归档内部清单不一致',
      'tar 流没有走到结束块',
    ],
    count: 6,
    why:
      '🔴 **产物内容**：这 6 条是校验器产出的 `issues[].message`，它们 ① 进 `logger.error`（开发者界面）、' +
      '② 进 `recordFailureSafely` 写的备份状态文件（运维直接读那个 JSON）、' +
      '③ 被 `verifyOne()` 拼进 `issues: ["[check] message"]` 返回给一个**后台从未调用过**的端点。' +
      '⇒ 三条消费路径里没有一条是"界面文案"（界面那条已在第十五批改成**摘要码** `backupVerifyFailedSummary`，' +
      '并给出可 grep 的 `{first}` = `issue.check`）。' +
      '🔴 如果将来后台要逐项展示，正确做法是给每个 issue 配一个 `code`、前端按码取译文 —— ' +
      '**不要**把中文 reason 直接渲染到界面上。',
  },
  {
    kind: 'permanent',
    file: 'main.ts',
    anchors: ['整站备份只能通过后台的鉴权接口下载'],
    count: 1,
    why:
      '🔴 这条是**静态文件服务层的拦截提示**（有人直接去静态目录下载备份归档时回的 403），' +
      '它不经过后台的请求适配器、也没有错误码通道（`main.ts` 里是裸 `res.json`）。' +
      '⚠️ 严格说它是"访客/运维可见"的，所以**不是**永久例外的理想候选 —— ' +
      '但要迁就得在 `main.ts` 里引入码表依赖（启动路径），风险与收益不匹配。' +
      '🔴 如实登记为 permanent 并写明"这是权衡，不是它不该翻"；若将来 `main.ts` 已经依赖码表，应改成欠条。',
  },

  // ══ E. 欠条：报告形状族（要先把 `reason: string` 改成 `code + params`）══
  {
    kind: 'permanent',
    file: 'utils/markdownExport.ts',
    anchors: [
      '图片地址无法解析',
      '只支持 http/https 图片',
      '拒绝抓取内网地址',
      '拒绝抓取端口',
      '图片域名解析失败',
      '图片域名没有解析到任何地址',
      '拒绝抓取解析到内网的地址',
    ],
    count: 7,
    why:
      '🔴 **第十七批查清了消费方，从"欠条"改判为"永久例外"**（三条证据，都可复核）：' +
      '① 这些 throw **全部被 catch**（`markdownExport.provider.ts` 里 ' +
      '`catch (err) { report.failed.push({ url, reason: err.message }) }`）⇒ 它们**从不成为 HTTP 响应**，界面上看不到；' +
      '② `report.failed[].reason` 的唯一去处是 `renderReport()` 生成的 **`导出说明.md`** —— ' +
      '那是**放进导出归档里的产物文件**，整篇都是中文（`# 导出说明` / `- 标题：…` / ' +
      '`## 跳过的图片（保留原样，未打包）` / `- <url> —— <reason>`）；' +
      '③ 🔴 **后台只渲染计数与 URL**：`exportMarkdown.tsx` 的类型是 ' +
      '`{ skipped?: number; failed?: number; failedUrls?: string[] }` —— **没有 reason 字段**。' +
      '⇒ 这 7 条属"**产物内容 + 日志**"，与 `backupVerify` 的 issues 同一类。' +
      '🔴 只翻这 7 条会得到"一份中文文档里夹几句英文"—— 比全中文更糟。' +
      '👉 将来若要本地化 `导出说明.md`，那是**把整份产物当文档来翻**（标题、字段名、章节名一起翻，' +
      '还要决定文件名 `导出说明.md` 要不要跟着变），**不是**逐条替换 reason 字符串。',
 },
  {
    kind: 'permanent',
    file: 'utils/safeFetch.ts',
    anchors: [
      '校验通过的地址无法用于连接',
      '重定向（',
      '重定向地址无法解析',
      '远端返回',
      '抓到的是空文件',
      '重定向次数过多',
      '抓到的内容不是图片',
    ],
    count: 7,
    why:
      '🔴 同 `markdownExport` 那 7 条（第十七批一起改判）：这些是"抓取远端图片"的失败原因，' +
      '被同一个 catch 收进 `report.failed[].reason` ⇒ 唯一去处是 **`导出说明.md`** 那份中文产物文件与日志；' +
      '后台只渲染计数与 URL（`failedUrls`），**从不渲染 reason**。' +
      '⚠️ 它们是 `new Error(中文)` 而不是 HttpException ⇒ 本来也没有错误码通道。',
 },

  // ══ F. 欠条：后台响应体里的短提示（成功/失败 toast，10 处 message）══
  {
    kind: 'permanent',
    file: 'controller/admin/theme/theme.controller.ts',
    anchors: ['上传成功', '已删除'],
    count: 2,
    why:
      '🔴 **第十八批查清了消费方，从「欠条」改判为「永久例外」**：这两条是**成功**提示' +
      '（`{ statusCode: 200, data, message: \u0027上传成功\u0027 }`），而 🔴 **后台根本不显示服务端这句 message** —— ' +
      '它显示自己那份三语文案：`Theme.jsx:335` 是 ' +
      '`message.success(t(\u0027theme.uploadedOk\u0027, \u0027主题「{id}」上传成功\u0027, { id }))`、' +
      '`Theme.jsx:82` 是 `message.success(t(\u0027common.deletedToast\u0027, \u0027已删除\u0027))`。' +
      '而且 🔴 **全仓没有任何字面量比对**（`grep -rn "=== \u0027上传成功\u0027" packages/admin/src` 命中 0）⇒ ' +
      '它不是协议字符串，只是给**非后台调用方**（curl / CLI / 脚本）看的兜底文案。' +
      '⇒ 与 caddy 那个 403、`导出说明.md` 那 14 条同一类：**最终消费方不是界面**。' +
      '👉 🔴 这是第十七批那条教训的第二次应用：**建台账时按形状猜的分类，动手前必须重新查消费方**' +
      '（这次猜的是「成功提示当然要翻」，查完发现后台早自己翻了 ⇒ 翻它反而会造成' +
      '「同一件事有两份文案、还可能不一致」）。',
  },
  {
    kind: 'permanent',
    file: 'provider/tag/tag.provider.ts',
    anchors: ['更新成功', '删除成功'],
    count: 2,
    why:
      '🔴 同 theme 那两条（第十八批改判）：`更新成功！` / `删除成功！` 是 provider 返回给 controller 的' +
      '**成功**提示，后台显示的是自己的 `t(…)` 文案（例如 `Advance.jsx` / `Article/columns.jsx` 里的' +
      '`t(\u0027common.updateSuccess\u0027, \u0027更新成功！\u0027)`），🔴 且全仓没有对这两句的字面量比对。' +
      '⇒ 最终消费方不是界面（是给 curl / CLI 的兜底），不翻。',
  },
  {
    kind: 'permanent',
    file: 'controller/admin/init/init.controller.ts',
    anchors: ['初始化成功!'],
    count: 1,
    why:
      '🔴 **第十八批改判为永久例外**：后台 `InitPage/index.tsx:177` 显示的是自己的 ' +
      '`t(\u0027init.success.title\u0027, \u0027初始化成功!\u0027)`（**不是**服务端那句），且全仓没有对它的字面量比对。' +
      '⚠️ 而且它与同文件那两处 `已初始化`（**协议字符串**，后台按字面量比对）在同一个响应族里 ⇒ ' +
      '在这一族里动 message 的风险高于收益（万一哪天前端的比对从 `已初始化` 扩到 `初始化成功!`，' +
      '只翻服务端就会静默坏掉）⇒ 与那两处一起保持中文，等「前后端一起改成按 code 判断」那一批统一处理。',
  },
];

// ── 扫描源码，得到"实际剩余的每一处" ─────────────────────────────────────
function scanServer() {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const a = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'test') walk(a);
      } else if (a.endsWith('.ts') && !a.endsWith('.spec.ts')) files.push(a);
    }
  })(serverSrc);
  const sites = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let th = [];
    let mp = [];
    try {
      ai.parseSource(src, f);
      th = ai.collectChineseThrows(src, f);
      mp = ai.collectChineseMessageProps(src, f);
    } catch {
      continue; // 解析不了的文件由别的判据负责（这里不静默吞：下面有"文件数"反空转）
    }
    const rel = path.relative(serverSrc, f);
    for (const h of th) sites.push({ kind: 'throw', rel, line: h.line, src });
    for (const h of mp) sites.push({ kind: 'message', rel, line: h.line, src });
  }
  return { sites, fileCount: files.length };
}

describe('🔴 服务端多语言收口台账：剩余的每一处中文都必须登记在册（全覆盖 + 无死条目）', () => {
  const { sites, fileCount } = scanServer();

  it('反空转：扫描真的拿到了东西（否则"全覆盖"是空的绿）', () => {
    assert.ok(fileCount > 200, `只遍历到 ${fileCount} 个服务端源文件（应 >200）⇒ 扫描坏了`);
    assert.ok(sites.length > 20, `只数出 ${sites.length} 处剩余站点（应 >20）⇒ 尺子坏了`);
    const ledgerTotal = LEDGER.reduce((n, e) => n + e.count, 0);
    assert.strictEqual(
      sites.length,
      ledgerTotal,
      `台账登记的总数（${ledgerTotal}）与实际扫到的（${sites.length}）不一致 ⇒ 台账要么漏了、要么有死条目`,
    );
  });

  it('台账里每一条的锚点都**唯一**且**真的还在源码里**（无死条目）', () => {
    const dead = [];
    for (const e of LEDGER) {
      const abs = path.join(serverSrc, e.file);
      let src;
      try {
        src = readFileSync(abs, 'utf8');
      } catch {
        dead.push(`${e.file}: 文件不存在`);
        continue;
      }
      assert.ok(
        Array.isArray(e.anchors) && e.anchors.length > 0,
        `${e.file}: 每条台账都要有 anchors（**每处一个**，同族多处就给多个）`,
      );
      for (const a of e.anchors) {
        const n = src.split(a).length - 1;
        if (n === 0) dead.push(`${e.file}: 锚点「${a}」已经找不到了（迁走了就要从台账删掉）`);
        // ⚠️ 一个锚点命中太多次说明它不够精确（会把别的站点也算成"已登记"）
        if (n > 3) dead.push(`${e.file}: 锚点「${a}」出现 ${n} 次 ⇒ 换一个更精确的片段`);
      }
      assert.ok(e.why && e.why.length > 20, `${e.file}: 每条都必须写明理由（why）`);
      if (e.kind === 'iou') assert.ok(e.batch, `${e.file}: 欠条必须写明在哪一批还（batch）`);
      assert.ok(
        e.kind === 'iou' || e.kind === 'permanent',
        `${e.file}: kind 只能是 iou 或 permanent`,
      );
    }
    assert.deepStrictEqual(dead, [], '🔴 台账有问题：\n  ' + dead.join('\n  '));
  });

  it('🔴 全覆盖：源码里每一处剩余站点都能归到台账的某一条（新加一处没登记的就红）', () => {
    // 归属规则：站点所在文件 + 该文件的中文文本里**包含**某条台账的锚点
    // ⚠️ 一个文件可能有多条台账（例如 caddy.controller 有 1 条 permanent + 1 条 iou）⇒
    //    按"锚点是否出现在那一行的文本里"来归属，而不是按文件。
    const uncovered = [];
    for (const s of sites) {
      const line = s.src.split('\n')[s.line - 1] || '';
      // 有些站点跨行（多段拼接）⇒ 再看上下两行
      const ctx = s.src.split('\n').slice(Math.max(0, s.line - 2), s.line + 3).join('\n');
      const hit = LEDGER.filter(
        (e) =>
          e.file === s.rel &&
          e.anchors.some((a) => line.includes(a) || ctx.includes(a)),
      );
      if (hit.length === 0) {
        uncovered.push(
          `${s.rel}:${s.line}（${s.kind}）没有登记 ⇒ 要么迁进码表，要么在台账里写明理由：` +
            JSON.stringify(line.trim().slice(0, 90)),
        );
      }
    }
    assert.deepStrictEqual(
      uncovered,
      [],
      '🔴 这些剩余的中文站点**没有登记在收口台账里**（棘轮预算还有余量时，新加一处中文是完全静默的 —— ' +
        '这条判据就是为了堵住它）：\n  ' +
        uncovered.slice(0, 10).join('\n  '),
    );
  });

  it('🔴 收口状态如实报数：永久例外与欠条各多少（数字变了就要来这里改，改的时候必须重读理由）', () => {
    const perm = LEDGER.filter((e) => e.kind === 'permanent');
    const iou = LEDGER.filter((e) => e.kind === 'iou');
    const permCount = perm.reduce((n, e) => n + e.count, 0);
    const iouCount = iou.reduce((n, e) => n + e.count, 0);
    // 🔴 口径（第十九批 = **服务端收口**）：剩余 **38** 处 = 永久例外 **38** + 欠条 **0**。
    //    38 = 协议字符串 3（`已初始化` ×2、`未初始化!`）+ 开发者不变量 8 + 机器消费方 1（caddy 那个 403）
    //         + 报告/产物内容 6（`backupVerify` 的 issues）+ `main.ts` 的静态层拦截 1
    //         + 导出产物内容 14（`markdownExport` 7 + `safeFetch` 7）+ 成功提示 5（后台显示自己的 `t(…)`）。
    //    🔴 **欠条 0** ⇒ 服务端多语言进入**收口状态**：剩下的每一处都是"故意不翻、且写了理由"的，
    //    而任何**新增**的中文站点都会被"全覆盖"断言当场抓住。
    // ⚠️ 这两个数字是**刻意写死**的：它们变了说明有人迁走了一批、或者新增了一批中文 ⇒
    //    两种情况都要求改这份台账（并且重读每条理由），所以让它红比让它自适应更有价值。
    assert.strictEqual(permCount, 38, `永久例外应该是 38 处，实测 ${permCount}`);
    // 🔴 期 9 第十九批：**欠条清零**（服务端收口）⇒ 剩下 38 处全部是写明理由的永久例外。
    assert.strictEqual(iouCount, 0, `欠条应该是 0 处（服务端已收口），实测 ${iouCount}`);
    assert.strictEqual(
      permCount + iouCount,
      sites.length,
      '台账总数与实际扫到的站点数不一致',
    );
    // 🔴 反向断言：欠条不许"永远欠着" —— 每条欠条都必须点名一批（上面已断言 batch 非空），
    //    并且**同一批的欠条不许超过 20 处**（否则那一批根本做不完，等于没有计划）
    const byBatch = new Map();
    for (const e of iou) byBatch.set(e.batch, (byBatch.get(e.batch) || 0) + e.count);
    // ⚠️ `iou` 为空时上面那个循环空转、下面这条也空转 ⇒ 这是**预期**（收口状态）；
    //    一旦有人重新登记欠条，这两条立刻恢复作用。
    for (const [batch, n] of byBatch) {
      assert.ok(n <= 20, `🔴 「${batch}」这一批挂了 ${n} 处欠条（>20）⇒ 拆成多批，否则等于没有计划`);
    }
  });
});
