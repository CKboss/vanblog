import * as fs from 'fs';
import * as path from 'path';

/**
 * 🔴 `docs/reference/api.md` 的「限流」一节与代码里的限流桶必须对齐 —— 钉的是 **"代码 → 文档"** 这个方向。
 *
 * ## 为什么要有它（本轮真实发生的两处漂移）
 * `api.md` 刻意**不抄接口清单**（它开头就写明"抄一份就会过期一份"，完整清单以运行时 swagger 为准），
 * 但它**确实枚举了限流桶与若干默认值** —— 而这一枚举在两个方向上都漂过：
 *
 *  1. 🔴 **少了一整个桶**：代码里有 5 个按路径分桶的限流器（`rl-init` / `rl-public-write` / `rl-static` /
 *     `rl-public-list` / `rl-global`），而文档的表里只列了 4 个 —— **漏掉的 `rl-public-list`
 *     （`/api/public/category` 与 `/api/public/tag`，默认 60/分钟）比全局桶紧 10 倍**。
 *     文档同时写着"全局 | 其余所有请求 | 600 次"，于是照着文档写抓取脚本的人会按 600/分钟做预算、
 *     在 60 次就吃到 429。⚠️ 而 `docs/reference/env.md` **是**正确的（它记了这个变量与 60 这个默认值）
 *     ⇒ 🔴 **同一个性质在两份文档里各有一份口径，改了一处忘了另一处。**
 *  2. 🔴 **默认值过时**：API Token 有效期的默认值在代码里从 365 天压到了 **90** 天
 *     （`provider/token/token.provider.ts` 的 `createAPIToken`，注释里写了演进史与安全理由），
 *     `env.md` 跟着改了，而 `api.md` 三处仍写 365、并声称"填 0 或不设都会回落成 365"。
 *
 * ## 为什么既有的守卫抓不到
 * - `utils/envVarMentions.spec.ts` 钉的是**相反方向**："用户可见文案里提到的环境变量名必须真有人读"
 *   （文档 → 代码）。它抓不到"代码新增了一个桶而文档没写"。
 * - `scripts/tests/docs-consistency.test.sh` 的环境变量名检查同样是**单向**的
 *   （文档提到的名字必须在代码里存在），所以"代码有、文档没写"这一维**此前无守卫**。
 * ⇒ 🔴 本 spec 补的正是那个方向，与上面两者**语料相同但方向相反，不重叠**。
 *
 * ## 口径为什么这么窄（刻意的取舍）
 * 只钉两件事，都是**可机械推导**的：
 *  - **桶变量必须被文档提及**（集合层面）；
 *  - **默认值是数字字面量的那些桶，文档那一行必须出现同一个数字**（数值层面）。
 * 🔴 **刻意不钉"文档描述的文字与代码注释一致"** —— 那是散文，没有可机械推导的对应关系，
 * 硬做就要在守卫里维护一张映射表，等于**新造一处会漂移的口径**（本仓库对"同一性质两处口径"已反复吃亏）。
 * ⚠️ 也因此：默认值是**表达式**而非字面量的桶（静态桶 = 全局 × 10）与形状特殊的闸
 * （解锁全局预算用的是三元表达式）**不在数值断言范围内**，只在"变量名必须被提及"那一层被覆盖。
 * 这个局限写在断言消息里，不藏。
 *
 * ## 🔴 2026-09-23 扩充：把**权威限流表**也纳入，并修掉数值断言的一个"假通过"洞
 * `docs/reference/secure.md` 与 `docs/reference/api.md` 现在都**指向** `docs/advanced/security.md#限流`
 * 那张表而不复制它（"一个性质只留一处权威口径"）⇒ 🔴 **那张表成了唯一权威，而权威口径没有守卫钉住数值就一定会漂。**
 * 所以本守卫的语料从一份文档扩成两份：`api.md`（它自己仍持有一张小表）与 `security.md`（权威表）。
 *
 * 🔴 **扩充时发现的洞（比扩充本身更要紧）**：原来的数值判据是 `row.includes(String(default))`，
 * 而限流数字**互为子串**：`60` ⊂ `600` ⊂ `6000`，`5` ⊂ `15`/`50`/`500`，`30` ⊂ `300`。
 * ⇒ **把 `PUBLIC_LIST` 的 60 改成 600、或把全局的 600 改成 6000，`includes` 仍然为真 ⇒ 断言假通过。**
 * 这不是理论风险：`api.md` 的全局行写的就是"600 次"、静态行在 `security.md` 里写的是"6000 次"。
 * 修法见 `hasBoundedNumber()`：数字**前后都不能再接数字**。这与上一轮 `365` ⊂ `36500` 那个坑同族，
 * 而限流数字比 TTL 更容易撞（TTL 只有一个 365/36500 对，限流有 5/15/50/500/60/600/6000 一整串）。
 *
 * 🔴 **另一处收紧**：原来用 `lines.find(...)` 只取**第一条**匹配行，而 `security.md` 里
 * `VANBLOG_INIT_LIMIT_PER_10MIN` 出现在**三行、分属两张表**（限流表的「忘记密码」恢复 与
 * `/api/admin/init*` 写请求两行 —— 两者刻意共用同一档阈值；以及「环境变量」表里默认值单独占一列的那行）
 * ⇒ 只查第一条会让其余两行静默漂移。现在查**所有**匹配行，🔴 于是数值断言顺带把环境变量表也钉住了。
 *
 * ⚠️ **反向检查（"文档提到的变量必须在代码里存在"）刻意**只**覆盖 `api.md`，没有扩到 `security.md`**：
 * 权威表还提到 `VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN`、`VANBLOG_LOGIN_THROTTLE_MAX_MS`、
 * `VANBLOG_ADMIN_LOGIN_ALLOW_CIDR` 等，它们定义在 `login.guard.ts` / `ip.ts` / `auth.controller.ts` /
 * `main.ts` / `trustedProxy.ts` 等**另外 6 个以上文件**里。🔴 上一轮的教训正是：
 * **"文档提到的名字必须在代码里存在"这类断言，语料必须覆盖文档实际引用的全部子系统，
 * 否则守卫会制造假缺口 —— 而假缺口比没守卫更糟，它会训练下一个人忽略红灯。**
 * 在语料没有可靠地扩全之前，宁可不扩这一维（正向那两维已经覆盖了权威表的数值漂移）。
 */

// 🔴 仓库根是 **4** 层（`packages/server/src/utils` → 根），与既有跨切面守卫 `utils/envVarMentions.spec.ts` 的口径一致。
// ⚠️ 第一版写成 3 层 ⇒ 落到 `packages/` ⇒ ENOENT，而且报的是 `Test Suites: 1 failed / Tests: 0 total`（既不是红也不是绿的第三种形态）。
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RATE_LIMIT_TS = path.join(REPO_ROOT, 'packages/server/src/utils/rateLimit.ts');
const PUBLIC_CONTROLLER_TS = path.join(
  REPO_ROOT,
  'packages/server/src/controller/public/public.controller.ts',
);
const API_MD = path.join(REPO_ROOT, 'docs/reference/api.md');
const SECURITY_MD = path.join(REPO_ROOT, 'docs/advanced/security.md');

/**
 * 持有限流表的文档语料。🔴 **`security.md` 是权威**（另两页指向它而不复制），
 * `api.md` 自己仍持有一张小表 ⇒ 两份都要对账。
 * ⚠️ `docs/reference/secure.md` **不在语料里**：它已改成指向权威表、不再持有数值，
 * 所以对它做数值断言会**要求它复述数值**，那正好违反"一个性质只留一处权威口径"。
 */
const RATE_TABLE_DOCS: { label: string; file: string }[] = [
  { label: 'docs/reference/api.md', file: API_MD },
  { label: 'docs/advanced/security.md（权威表）', file: SECURITY_MD },
];

/**
 * 🔴 **数字必须前后都不再接数字**才算命中。
 * 朴素 `includes` 在限流数字上会假通过：`'每分钟 6000 次'.includes('60')` 为真、
 * `'每分钟 6000 次'.includes('600')` 也为真 ⇒ 把 60 写成 600、或把 600 写成 6000 都抓不到。
 * ⚠️ 不用 lookbehind（`(?<!\d)`）而用捕获组，避免对正则引擎特性的依赖。
 */
function hasBoundedNumber(text: string, n: number): boolean {
  return new RegExp('(^|[^0-9])' + String(n) + '([^0-9]|$)').test(text);
}
/**
 * 🔴 API Token 有效期那个旋钮读在这里，不在 `rateLimit.ts` —— 它正是本轮 G3 那处漂移
 * （文档写 365、代码回落 90）的主角，所以必须纳入"文档 → 代码"这一侧的语料。
 * ⚠️ 第一版语料只有前两个文件，于是它被判成"文档指向一个不存在的旋钮"——
 * 🔴 **那是守卫的语料太窄，不是文档错**。教训：做"文档提到的名字必须在代码里存在"这类断言时，
 * 语料必须覆盖**文档实际引用的全部子系统**，否则会把正确的文档判成假的缺口。
 */
const TOKEN_PROVIDER_TS = path.join(
  REPO_ROOT,
  'packages/server/src/provider/token/token.provider.ts',
);

/**
 * 剥掉块注释与整行注释。
 * 🔴 **必须剥**：`rateLimit.ts` 的注释里提到了别的环境变量（例如集群 worker 数那个），
 * 不剥就会把它当成一个"限流桶"，于是要求文档去写一个与限流无关的变量 ⇒ 假阳性。
 * ⚠️ 这与仓库里另一条教训同源：用 `grep -rc` 数 wrapper 步骤时把**注释里的提及**算进去，
 * 得到 36 而真值是 34。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 桶常量的声明形状：`envInt('NAME', <default>, <min>, <max>)` / `envPositiveInt(...)`。 */
function collectBucketVars(src: string): { name: string; literalDefault: number | null }[] {
  const code = stripComments(src);
  const out: { name: string; literalDefault: number | null }[] = [];
  const re = /env(?:Int|PositiveInt)\(\s*'(VANBLOG_[A-Z0-9_]+)'\s*,\s*([^,]+),/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const raw = m[2].trim();
    // 只有纯数字字面量才纳入数值断言；表达式（如 `GLOBAL_LIMIT_PER_MIN * 10`）记 null。
    out.push({ name: m[1], literalDefault: /^\d+$/.test(raw) ? Number(raw) : null });
  }
  return out;
}

/** 解锁接口的"按文章全局预算"那个闸：形状不同（`process.env.X` + 三元回落），单独取。 */
function collectUnlockVar(src: string): string[] {
  const code = stripComments(src);
  const found = code.match(/process\.env\.(VANBLOG_UNLOCK_[A-Z0-9_]+)/);
  return found ? [found[1]] : [];
}

describe('docs/reference/api.md 的限流一节必须与代码里的限流桶对齐（代码 → 文档方向）', () => {
  const rateLimitSrc = fs.readFileSync(RATE_LIMIT_TS, 'utf-8');
  const publicSrc = fs.readFileSync(PUBLIC_CONTROLLER_TS, 'utf-8');
  const apiMd = fs.readFileSync(API_MD, 'utf-8');
  const tokenSrc = fs.readFileSync(TOKEN_PROVIDER_TS, 'utf-8');
  const docs = RATE_TABLE_DOCS.map((d) => ({
    label: d.label,
    text: fs.readFileSync(d.file, 'utf-8'),
  }));
  /** 某份文档里所有提到某变量的**表格行**（🔴 全部，不是第一条 —— 权威表里 INIT 那个变量占两行）。 */
  function rowsMentioning(text: string, varName: string): string[] {
    return text.split('\n').filter((l) => l.startsWith('|') && l.includes(varName));
  }

  const buckets = collectBucketVars(rateLimitSrc);
  const unlockVars = collectUnlockVar(publicSrc);
  const allVars = [...buckets.map((b) => b.name), ...unlockVars];
  const literalBuckets = buckets.filter((b) => b.literalDefault !== null);

  it('扫描本身没空转：真的解析到了桶、字面量默认值与文档内容', () => {
    // 🔴 反空转。没有这一条，"解析到 0 个桶 ⇒ 全部通过"会是一个恒真的绿
    //    —— 本仓库已有代理因此写出过恒真守卫（枚举 0 条路由 ⇒ "未覆盖清单为空"）。
    expect(buckets.length).toBeGreaterThanOrEqual(5);
    expect(literalBuckets.length).toBeGreaterThanOrEqual(4);
    expect(unlockVars.length).toBe(1);
    expect(apiMd.length).toBeGreaterThan(4000);
    // 文档必须真的有那一节与那张表，否则"提及"可能来自别处的偶然字符串。
    expect(apiMd).toContain('## 限流');
    expect(apiMd.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThanOrEqual(20);
    // 🔴 扩充后的反空转：语料必须真的有**两份**文档、每份都真的有限流表、
    //    且字面量桶在两份文档里合计匹配到足够多的表格行（否则"所有行都对齐"可能是空的绿）。
    expect(docs.length).toBe(2);
    for (const d of docs) {
      expect({ 文档: d.label, 应当含限流一节: d.text.includes('## 限流') }).toEqual({
        文档: d.label,
        应当含限流一节: true,
      });
      expect(d.text.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThanOrEqual(6);
    }
    const totalRows = literalBuckets.reduce(
      (acc, b) => acc + docs.reduce((n, d) => n + rowsMentioning(d.text, b.name).length, 0),
      0,
    );
    // 实测：api.md 4 个字面量桶各 1 行 = 4；security.md 里 INIT 占 2 行、其余各 1 行 = 5 ⇒ 合计 9。
    expect({ 被数值断言检查的表格行总数: totalRows }).toEqual({ 被数值断言检查的表格行总数: expect.any(Number) });
    expect(totalRows).toBeGreaterThanOrEqual(8);
    // 🔴 `security.md` 里 INIT 那个变量占**三行、分属两张表**，钉住这个数字有两层意义：
    //    ① 限流表里**两行**（「忘记密码」恢复 与 `/api/admin/init*` 写请求，刻意共用同一档阈值）
    //       ⇒ 证明"查所有匹配行"这个收紧真的在干活，没有退化成"只查第一条"；
    //    ② 「环境变量」表里**一行**（默认值单独占一列）⇒ 说明 `rowsMentioning` 扫的是**全文所有表格行**，
    //       所以数值断言**顺带把环境变量表也钉住了**（比只扫限流一节更强，是有意的）。
    //    ⚠️ 这个数字变了不一定是坏事（可能又加了一张表），但它变了就必须有人来读一眼 ⇒ 刻意钉死。
    expect(rowsMentioning(docs[1].text, 'VANBLOG_' + 'INIT_LIMIT_PER_10MIN').length).toBe(3);
    // ⚠️ 顺带钉住"剥注释"这一步真的在干活：未剥注释时全集里会多出集群 worker 那个变量。
    expect(allVars).not.toContain('VANBLOG_' + 'CLUSTER_WORKERS');
  });

  it('代码里的每一个限流桶变量都被**每一份持有限流表的文档**提及（漏一个就意味着那份文档的桶清单不完整）', () => {
    const missing: { 文档: string; 缺失的桶变量: string[] }[] = [];
    for (const d of docs) {
      const m = allVars.filter((v) => !d.text.includes(v));
      if (m.length) missing.push({ 文档: d.label, 缺失的桶变量: m });
    }
    // 🔴 失败信息给可照做的修法，而不是只说"不一致"。
    expect({
      有缺口的文档: missing,
      修法:
        '在缺口的这份文档的「## 限流」表里补上这些桶（覆盖范围、默认值、变量名三列都要）。' +
        '🔴 注意 docs/advanced/security.md 是**权威表**，docs/reference/api.md 与 secure.md 都指向它 —— ' +
        '补权威表即可让另两页的指向仍然成立；若补的是 api.md 自己的小表，务必核实权威表是否也要同步',
    }).toEqual({ 有缺口的文档: [], 修法: expect.any(String) });
  });

  it('默认值是数字字面量的桶，**每一份文档的每一条相关表格行**都必须出现同一个数字（前后不接数字）', () => {
    const wrong: { 文档: string; 变量: string; 代码默认值: number; 文档那一行: string }[] = [];
    for (const d of docs) {
      for (const b of literalBuckets) {
        const rows = rowsMentioning(d.text, b.name);
        // 变量名出现在非表格行也算"提及"，但数值断言只针对表格行；找不到表格行就是缺口。
        if (rows.length === 0) {
          wrong.push({
            文档: d.label,
            变量: b.name,
            代码默认值: b.literalDefault as number,
            文档那一行: '(未找到表格行)',
          });
          continue;
        }
        // 🔴 查**所有**匹配行：权威表里 INIT 那个变量占两行，只查第一条会让第二行静默漂移。
        for (const row of rows) {
          if (!hasBoundedNumber(row, b.literalDefault as number)) {
            wrong.push({
              文档: d.label,
              变量: b.name,
              代码默认值: b.literalDefault as number,
              文档那一行: row.slice(0, 160),
            });
          }
        }
      }
    }
    expect({
      数值对不上的: wrong,
      判据说明:
        '数字必须**前后都不再接数字**才算命中（60 不能靠 600/6000 蒙混过关）。' +
        '修法：把该行「默认」那一列改成代码里的真实默认值，并核实另一份文档是否也要同步',
    }).toEqual({ 数值对不上的: [], 判据说明: expect.any(String) });
  });

  it('尺子有效性：朴素子串匹配会在限流数字上**假通过**，而边界匹配不会（这是上面那条判据存在的理由）', () => {
    // 🔴 反证。没有这一条，"改成边界匹配"这个决定就没有东西钉住，
    //    下一个人很容易"简化"回 includes() 而看不出差别 —— 因为真实文档两种判据都是绿的。
    const corruptedStaticRow = '| 静态资源 `/static/**` | 每分钟 6000 次 | `VANBLOG_' + 'STATIC_LIMIT_PER_MIN` |';
    // 60 与 600 都是 6000 的子串 ⇒ 朴素 includes 会认为"这一行写了 60/600"，而它其实写的是 6000。
    expect(corruptedStaticRow.includes('60')).toBe(true);
    expect(corruptedStaticRow.includes('600')).toBe(true);
    expect(hasBoundedNumber(corruptedStaticRow, 60)).toBe(false);
    expect(hasBoundedNumber(corruptedStaticRow, 600)).toBe(false);
    // 而真正写着 600 的行必须被边界匹配认出来（否则判据会过严 ⇒ 到处假红）。
    expect(hasBoundedNumber('| 全局兜底 | 每分钟 600 次 | X |', 600)).toBe(true);
    // markdown 粗体星号不是数字，所以 **60** 这种排版必须算命中。
    expect(hasBoundedNumber('| 聚合列表 | 每分钟 **60** 次 | X |', 60)).toBe(true);
    // 🔴 以及"改错一位"这个真实场景：60 → 600 之后，边界匹配必须判为不命中。
    expect(hasBoundedNumber('| 聚合列表 | 每分钟 **600** 次 | X |', 60)).toBe(false);
  });

  it('语义空操作对照：只改与数字无关的措辞不得让上面任何一条变红（证明守卫不是"对任何改动都红"）', () => {
    // 🔴 这条**必须绿**。它是上一轮那个教训的产物：变异体在语义上是空操作时会被误读成"守卫没咬住"，
    //    所以反过来主动放一条本该绿的对照，用它证明前几条的红是有理由的、而守卫又没有过紧。
    // 🔴 **不依赖文档里的任何字面量**：变异方式是「在文末追加一行 HTML 注释」。
    //    第一版写成 replace('覆盖面与设计原则：', …)，结果它与真实文档的一句话撞车 ——
    //    任何人改写那句话，这条对照就会失败并报「替换没发生」，看起来像守卫坏了。
    //    👉 教训：**对照/尺子必须锚定在不可能与产物内容冲突的形状上**，
    //       否则它会因为一次无关的散文编辑而假红（而假红会训练下一个人忽略它）。
    const proseOnly = docs[1].text + '\n<!-- 与限流数字无关的一行说明 -->\n';
    expect(proseOnly).not.toBe(docs[1].text); // 追加真的发生了，否则这条对照是空的
    // 追加的这一行不是表格行，所以它不可能被 rowsMentioning 选中 —— 先钉住这个前提，
    // 否则「表格行没变」可能只是因为这行恰好没被扫到。
    expect(proseOnly.split('\n').filter((l) => l.startsWith('|')).length).toBe(
      docs[1].text.split('\n').filter((l) => l.startsWith('|')).length,
    );
    for (const b of literalBuckets) {
      const before = rowsMentioning(docs[1].text, b.name);
      const after = rowsMentioning(proseOnly, b.name);
      expect({ 变量: b.name, 表格行不应因散文改动而变化: after }).toEqual({
        变量: b.name,
        表格行不应因散文改动而变化: before,
      });
      for (const row of after) {
        expect(hasBoundedNumber(row, b.literalDefault as number)).toBe(true);
      }
    }
  });

  it('api.md 的限流表里出现的每个 VANBLOG_ 变量名都真的在代码里存在（防止文档教人配一个不存在的旋钮）', () => {
    // 这是反向的一半：文档 → 代码。⚠️ 与上面"代码 → 文档"合起来才是双向对账。
    // 🔴 语料 = 文档表格实际引用的三个子系统（限流桶、解锁全局闸、API Token 有效期）。
    const code = stripComments(rateLimitSrc) + stripComments(publicSrc) + stripComments(tokenSrc);
    const docVars = Array.from(
      new Set(
        apiMd
          .split('\n')
          .filter((l) => l.startsWith('|'))
          .join('\n')
          .match(/VANBLOG_[A-Z0-9_]+/g) ?? [],
      ),
    );
    expect(docVars.length).toBeGreaterThanOrEqual(6);
    // 🔴 反空转：语料必须真的覆盖到三个来源，否则"没有悬空名字"可能只是语料为空。
    expect(code.includes('VANBLOG_' + 'RATE_LIMIT_PER_MIN')).toBe(true);
    expect(code.includes('VANBLOG_' + 'UNLOCK_GLOBAL_BUDGET_PER_10MIN')).toBe(true);
    expect(code.includes('VANBLOG_' + 'API_TOKEN_TTL_DAYS')).toBe(true);
    const dangling = docVars.filter((v) => !code.includes(`'${v}'`) && !code.includes(`.${v}`));
    expect({ 文档里指向不存在旋钮的: dangling }).toEqual({ 文档里指向不存在旋钮的: [] });
  });

  it('尺子有效性：一个代码里有、文档里没有的合成桶必须被同一套判定逻辑点名', () => {
    // 🔴 反证。否则上面那条"缺失清单为空"可能只是判定逻辑坏了。
    // ⚠️ 合成名字用相邻字符串拼接构造：本守卫自己的源码也在若干扫描器的语料里，
    //    直接写完整字面量会让"扫全仓找未被读的变量"那一类守卫把它当成真实变量。
    const synthetic = 'VANBLOG_' + 'ZZZ_SYNTHETIC_BUCKET';
    for (const d of docs) expect(d.text.includes(synthetic)).toBe(false);
    const fakeAll = [...allVars, synthetic];
    // 🔴 两份文档都必须点名它（否则"缺失清单为空"可能只是某一份没参与判定）。
    for (const d of docs) {
      const missing = fakeAll.filter((v) => !d.text.includes(v));
      expect({ 文档: d.label, 应当只缺合成桶: missing }).toEqual({
        文档: d.label,
        应当只缺合成桶: [synthetic],
      });
    }
  });

  it('尺子有效性：数字对不上时必须被点名（在**两份**文档里各把一个桶的默认值改错）', () => {
    // 用"肯定对不上的数字"：999999 不等于任何真实默认值（它们都 ≤ 6000），
    // 而且它不是任何真实默认值的子串/超串，所以边界匹配与朴素匹配都会判为不命中。
    for (const d of docs) {
      const target = literalBuckets.find((b) => rowsMentioning(d.text, b.name).length > 0);
      expect({ 文档: d.label, 应当至少有一个字面量桶出现在表里: !!target }).toEqual({
        文档: d.label,
        应当至少有一个字面量桶出现在表里: true,
      });
      const b = target as { name: string; literalDefault: number | null };
      const lines = d.text.split('\n');
      const idxs = lines
        .map((l, i) => ({ l, i }))
        .filter((x) => x.l.startsWith('|') && x.l.includes(b.name))
        .map((x) => x.i);
      expect(idxs.length).toBeGreaterThan(0);
      for (const idx of idxs) {
        const corrupted = lines[idx].replace(String(b.literalDefault), '999999');
        expect(corrupted).not.toBe(lines[idx]);
        expect(hasBoundedNumber(corrupted, b.literalDefault as number)).toBe(false);
      }
    }
  });
});
