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
    // ⚠️ 顺带钉住"剥注释"这一步真的在干活：未剥注释时全集里会多出集群 worker 那个变量。
    expect(allVars).not.toContain('VANBLOG_' + 'CLUSTER_WORKERS');
  });

  it('代码里的每一个限流桶变量都被 api.md 提及（漏一个就意味着文档的桶清单不完整）', () => {
    const missing = allVars.filter((v) => !apiMd.includes(v));
    // 🔴 失败信息给可照做的修法，而不是只说"不一致"。
    expect({
      缺失的桶变量: missing,
      修法:
        '在 docs/reference/api.md 的「## 限流」表里补上这些桶（路径覆盖范围、默认值、变量名三列都要），' +
        '并核实 docs/reference/env.md 是否也需要同步 —— 这两份文档各有一份口径，改一处忘另一处正是本守卫的由来',
    }).toEqual({ 缺失的桶变量: [], 修法: expect.any(String) });
  });

  it('默认值是数字字面量的桶，文档对应那一行必须出现同一个数字（防止 365/90 那一类过时）', () => {
    const lines = apiMd.split('\n');
    const wrong: { 变量: string; 代码默认值: number; 文档那一行: string }[] = [];
    for (const b of literalBuckets) {
      const row = lines.find((l) => l.startsWith('|') && l.includes(b.name));
      // 变量名出现在非表格行也算"提及"，但数值断言只针对表格行；找不到表格行就是缺口。
      if (!row || !row.includes(String(b.literalDefault))) {
        wrong.push({ 变量: b.name, 代码默认值: b.literalDefault as number, 文档那一行: row ?? '(未找到表格行)' });
      }
    }
    expect(wrong).toEqual([]);
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
    expect(apiMd.includes(synthetic)).toBe(false);
    const fakeAll = [...allVars, synthetic];
    const missing = fakeAll.filter((v) => !apiMd.includes(v));
    expect(missing).toEqual([synthetic]);
  });

  it('尺子有效性：数字对不上时必须被点名（把某个桶的默认值改错一位）', () => {
    const target = literalBuckets[0];
    const lines = apiMd.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('|') && l.includes(target.name));
    expect(idx).toBeGreaterThan(-1);
    // 用"肯定对不上的数字"替换该行：999999 不会等于任何真实默认值（它们都 ≤ 6000）。
    const corrupted = lines[idx].replace(String(target.literalDefault), '999999');
    expect(corrupted).not.toBe(lines[idx]);
    expect(corrupted.includes(String(target.literalDefault))).toBe(false);
  });
});
