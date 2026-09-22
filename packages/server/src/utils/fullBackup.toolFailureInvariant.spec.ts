import { readFileSync } from 'fs';
import { join } from 'path';
import { composeToolFailure, explainSilentToolFailure } from './fullBackup';

/**
 * `listArchiveMembers` 那条 `tarErr || decErr` 回退的**不变量钉子**。
 *
 * ## 为什么只有守卫、没有产品代码改动（这是有意的决定，别当成漏修）
 *
 * 已核实的现状（`fullBackup.ts` 的 `listArchiveMembers`，tar 的 close 分支）：
 * tar 以非 0 退出时用 `composeToolFailure('读不出归档成员表', code, tarErr || decErr, 300, 'tar 退出码')`
 * 组装报错，而 `composeToolFailure` 的两条分支都保证有内容 ——
 * 有 stderr 时给原文 + `explainTarFailure` 的翻译，**stderr 为空时给 `explainSilentToolFailure` 的可照做提示**
 * ⇒ 🔴 **"报错以冒号收尾、后面什么都没有"这个缺陷在这条路上已经不可能出现**。
 *
 * ## ⚠️ 但仍然残留一个**窄竞争**，本文件把它钉住而不是修掉
 * `decErr` 是靠 `decompressor.stderr.on('data')` 累积的，而 tar 的 `close` 只保证 **tar 自己的**
 * stdio 已排空 ⇒ tar 先退出时，解压器刚写出的 stderr **可能还没送达 Node**。两种后果：
 *  1. `decErr` 非空但不完整 ⇒ 报错里带的是**部分**诊断（可用，只是不全）；
 *  2. `decErr` 仍是空串 ⇒ 走 `explainSilentToolFailure`，而它的话是"**没有留下任何诊断输出**" ——
 *     🔴 这句话在此刻**可能是不准确的**（解压器其实说了话，只是我们没等到）。
 *     并且此时 `fail()` 已置 `settled`，随后解压器的 close 分支变成 no-op ⇒
 *     **解压器真正的 stderr 永远不会展示给站长**。
 *
 * 🔴 **为什么故意不修**：要修就得"等解压器 stderr 排空后再 settle"，而那正是
 * `fullBackup.ts` 里 tar close 分支上方那段注释明确防的事 —— 提前/延后 settle 曾让
 * **截断或损坏的归档使这个 promise 永远不 settle**（实测 69MB 真 zstd 归档砍掉 1MB 必现），
 * 它会同时挂住 `verifyFullBackup` 与两条恢复路由，而匿名的 init/restore 还会因此
 * **永久占着单飞锁**。⚖️ 权衡：一边是"提示可能不完整/可能多说一句'没有诊断输出'"，
 * 另一边是"恢复路径可能永久挂住并占死单飞锁"。⇒ **保留现状**。
 * 而且实际危害有限：那条提示仍然引导站长去核对 `.sha256` sidecar、并单独跑
 * `gzip -t` / `zstd -t` / `xz -t` —— **照做就能拿到解压器真正的报错**。
 *
 * 👉 所以本文件的职责是：**把这个取舍钉住**，让将来"顺手加个 await 等排空"的改动会红，
 *    迫使改的人先读到上面这段权衡。
 */

const src = readFileSync(join(__dirname, 'fullBackup.ts'), 'utf8');
/** 剥掉注释后再断言"代码里没有某形状"，避免被说明文字喂饱。 */
const codeLines = src
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/**
 * 🔴 只取 `listArchiveMembers` 的函数体。
 * 这一步是必需的，不是洁癖：`tar.on('close', (code) => {` 在本文件里出现在 **1045 与 2140** 两处，
 * `const fail = (message: string) => {` 出现在 **320 / 1010 / 2115** 三处 ⇒
 * 直接对全文 `indexOf` 会命中**别的函数**，于是断言在量错对象（本文件第一版就因此红了两条）。
 * ⚠️ 这正是本仓库那条老规矩的又一形态：**锚点必须先证明"唯一命中"**，
 *    而"唯一"要在**正确的范围**里成立。
 */
function listArchiveMembersBody(): string {
  const start = src.indexOf('export async function listArchiveMembers(');
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  // 函数体到下一个顶层 export 之前（本文件里它后面还有别的导出）
  const nextExport = rest.search(/\nexport /);
  return nextExport > 0 ? rest.slice(0, nextExport) : rest;
}

describe('读不出归档成员表：tarErr 与 decErr 都为空时仍然可照做', () => {
  it('🔴 不以冒号收尾，且给出可照做的提示', () => {
    // 这就是 listArchiveMembers 的 tar close 分支在两个 stderr 都空时的确切调用形状
    const out = composeToolFailure('读不出归档成员表', 2, '', 300, 'tar 退出码');
    expect(out.startsWith('读不出归档成员表（tar 退出码 2）：')).toBe(true);
    expect(out.trimEnd().endsWith('：')).toBe(false);
    // 可照做的三件事都要在
    expect(out).toContain('.sha256');
    expect(out).toContain('gzip -t / zstd -t / xz -t');
    expect(out).toContain('没有留下任何诊断输出');
  });

  it('空白字符（不是空串）同样走兜底提示，而不是留下一个空尾巴', () => {
    const out = composeToolFailure('读不出归档成员表', 2, '   \n\t ', 300, 'tar 退出码');
    expect(out.trimEnd().endsWith('：')).toBe(false);
    expect(out).toContain('没有留下任何诊断输出');
  });

  it('只有 tarErr 有内容时用它，且带上天书翻译（回退顺序的第一支）', () => {
    const out = composeToolFailure(
      '读不出归档成员表',
      2,
      'tar: This does not look like a tar archive',
      300,
      'tar 退出码',
    );
    expect(out).toContain('does not look like a tar archive');
    expect(out).not.toContain('没有留下任何诊断输出');
  });

  it('tarErr 为空而 decErr 有内容时用 decErr（这正是那条 || 回退的意义）', () => {
    const out = composeToolFailure('读不出归档成员表', 2, 'zstd: error: unknown header', 300, 'tar 退出码');
    expect(out).toContain('unknown header');
    expect(out.trimEnd().endsWith('：')).toBe(false);
  });

  it('尺子有效性：兜底提示本身确实非空、且随退出码变化', () => {
    expect(explainSilentToolFailure(2).length).toBeGreaterThan(40);
    expect(explainSilentToolFailure(2)).not.toBe(explainSilentToolFailure(137));
    expect(explainSilentToolFailure(137)).toContain('137');
  });
});

describe('🔴 钉住那个取舍：tar 的 close 分支不得改成"等解压器排空后再 settle"', () => {
  it('tar 的 close 分支直接 fail(composeToolFailure(...))，中间没有 await', () => {
    const fn = listArchiveMembersBody();
    const start = fn.indexOf("tar.on('close', (code) => {");
    expect(start).toBeGreaterThan(-1);
    const body = fn.slice(start, fn.indexOf('});', start));
    // 尺子有效性：确认切出来的确实是成员表那条分支（而不是同形的别处）
    expect(body).toContain('读不出归档成员表');
    // 关键性质：这条分支的**代码**里不许出现等待（一旦出现，就意味着在等别的流排空，
    // 而那正是会让截断归档永不 settle 的形状）。
    // 🔴 必须先剥注释再断言：本函数体上方那段取舍说明里就**写着**这个词（用来说明
    //    "顺手加一个等待会直接变红"），而不剥注释的话，**我为了警告这个坑而写的注释
    //    自己就会触发断言** —— 本仓库已三次栽在同一形状上。
    const bodyCode = body
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(bodyCode).not.toMatch(/\bawait\b/);
    // 尺子有效性反证：这把尺子必须量得到"加了等待"的坏形状，否则上面那条恒真
    expect((bodyCode + '\n  await drainDecompressor();').match(/\bawait\b/) !== null).toBe(true);
    // 并且剥注释这一步真的在干活（否则 bodyCode === body，上面那条可能在量注释）
    expect(bodyCode.length).toBeLessThan(body.length);
    // 并且它确实走 composeToolFailure（而不是手写拼接）
    expect(body).toContain('composeToolFailure(');
    expect(body).toContain('tarErr || decErr');
  });

  it('fail() 仍然自己落 settled 标志（提前置位会让截断归档永不 settle）', () => {
    const fn = listArchiveMembersBody();
    const start = fn.indexOf('const fail = (message: string) => {');
    expect(start).toBeGreaterThan(-1);
    const body = fn.slice(start, fn.indexOf('};', start));
    // 尺子有效性：确认这是成员表函数里的那个 fail（它要 SIGKILL 两个子进程）
    expect(body).toContain('decompressor');
    expect(body).toContain('if (settled) return');
    expect(body).toContain('settled = true');
    // 🔴 顺序必须是"先判断再置位"，反过来就是那个已修过的 bug
    expect(body.indexOf('if (settled) return')).toBeLessThan(body.indexOf('settled = true'));
  });

  it('源码级：读取侧不许再出现手写拼接（与既有收敛守卫同口径，这里只钉成员表那一条）', () => {
    // ⚠️ 断言的对象是**代码行**（已剥注释），所以本文件顶部的说明文字不会喂饱它
    expect(codeLines).not.toMatch(/读不出归档成员表（tar 退出码 \$\{code\}）：\$\{/);
    // 反证：这把尺子量得到坏形状（否则恒真）
    const handRolled = /读不出归档成员表（tar 退出码 \$\{code\}）：\$\{/;
    expect(handRolled.test('fail(`读不出归档成员表（tar 退出码 ${code}）：${tarErr.slice(0, 300)}`);')).toBe(
      true,
    );
  });
});
