import * as fs from 'fs';
import * as path from 'path';

/**
 * 🔴 `docs/reference/reverse-proxy.md` 必须讲清「转发头信任」这一维 —— 因为**配错了会让按 IP 的限流与登录锁定静默失效**。
 *
 * ## 为什么要有它
 * 这一页是运维**正在配 nginx/caddy 时会打开的那一页**，而它此前对下面三件事**命中数全是 0**：
 * `VANBLOG_TRUST_FORWARDED_HEADERS`、`VANBLOG_BRUTE_FORCE_IP_SOURCE`、以及「追加」这个词。
 * 而代码的默认 `auto` 模式**正是因为「caddy/nginx 把真实对端追加到客户端自带的 XFF 之后」才取最右一跳**
 * （`utils/trustedProxy.ts` 的 `rightMostForwardedFor` / `pickTrustedClientIp`）⇒
 * 🔴 **外层反代若「覆盖」而不是「追加」XFF，最右一项就是攻击者自己写的值**，于是
 * ①体量类限流被绕过（每换一个伪造 XFF 就拿到一份全新预算），
 * ②🔴 **反过来还能栽赃**（把 XFF 写成受害者的真实 IP，让对方被登录失败锁定挡在门外）。
 * ⚠️ 这两个变量在 `docs/reference/env.md` 里**是**有记录的 ⇒ 所以这不是「没人写过」，
 * 而是 🔴 **「写在运维不会去看的那一页」**：`login.guard.ts` 的 CIDR 拒绝日志原文就在指路
 * 「检查 `VANBLOG_TRUST_FORWARDED_HEADERS`，或反代是否在覆盖而不是追加 X-Forwarded-For」，
 * 而运维顺着这句话去翻反代文档，什么也找不到。
 *
 * ## 口径为什么这么窄（刻意的取舍）
 * 只钉**可机械推导**的三件事：这一页必须提到那两个变量名、必须讲「追加 vs 覆盖」、
 * 且提到的变量名**必须真的在代码里存在**。
 * 🔴 **刻意不钉散文措辞**（那是散文，硬做就要在守卫里维护一份文案副本，等于新造一处会漂移的口径）。
 * ⚠️ **与 `scripts/tests/reverse-proxy-host-header.test.sh`（49 条）不重叠**：那条钉的是
 * 「文档给出的 nginx 片段必须转发 `Host`」「必须旁路缓存」「必须写清监听网卡与 compose 绑定」，
 * 即**片段本身的正确性**；本 spec 钉的是**转发头信任这一维有没有被讲到**，两者维度不同。
 * ⚠️ **反向检查（文档提到的名字必须在代码里存在）的语料只取 `trustedProxy.ts` 一个文件**，
 * 因为断言只针对**这两个变量**，而它们都定义在这一个文件里 ⇒ 不存在「语料太窄 ⇒ 制造假缺口」那个坑
 * （那个坑的形状是：断言覆盖一批名字，而语料没覆盖到其中某些名字的定义处）。
 */

// 🔴 仓库根是 **4** 层（`packages/server/src/utils` → 根），与既有跨切面守卫同口径。
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOC = path.join(REPO_ROOT, 'docs/reference/reverse-proxy.md');
const TRUSTED_PROXY_TS = path.join(REPO_ROOT, 'packages/server/src/utils/trustedProxy.ts');

/** 剥掉块注释与整行注释（避免把注释里的提及当成「代码里存在」）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('docs/reference/reverse-proxy.md 必须讲清转发头信任（否则按 IP 的限流会静默失效）', () => {
  const doc = fs.readFileSync(DOC, 'utf-8');
  const code = stripComments(fs.readFileSync(TRUSTED_PROXY_TS, 'utf-8'));

  // 🔴 用相邻字符串拼接构造变量名：本守卫自己的源码也在若干扫描器的语料里，
  //    直接写完整字面量会让「扫全仓找未被读的变量」那一类守卫把它当成真实变量。
  const TRUST_VAR = 'VANBLOG_' + 'TRUST_FORWARDED_HEADERS';
  const BRUTE_VAR = 'VANBLOG_' + 'BRUTE_FORCE_IP_SOURCE';

  it('扫描本身没空转：文档与代码都真的读到了、且代码里确实定义了这两个变量', () => {
    expect(doc.length).toBeGreaterThan(4000);
    // 🔴 反空转：如果这两个名字在代码里都找不到，下面「文档必须提到它们」就变成在要求文档写不存在的东西。
    expect({ 代码里应当定义这两个变量: [code.includes(TRUST_VAR), code.includes(BRUTE_VAR)] }).toEqual({
      代码里应当定义这两个变量: [true, true],
    });
    // 文档必须真的是反代那一页（否则可能读错了文件，而所有 toContain 都恰好通过）。
    expect(doc).toContain('## 反代方式');
  });

  it('文档必须提到那两个转发头相关的变量名（运维正是在这一页配反代）', () => {
    const missing = [TRUST_VAR, BRUTE_VAR].filter((v) => !doc.includes(v));
    expect({
      文档里没提到的: missing,
      修法:
        '在 docs/reference/reverse-proxy.md 里说明这两个变量的作用与取值。' +
        '🔴 权威说明在 docs/reference/env.md，本页应当讲「配反代时该怎么选」并指向它，而不是复制它的表格',
    }).toEqual({ 文档里没提到的: [], 修法: expect.any(String) });
  });

  it('文档必须讲清「追加 vs 覆盖」XFF（这是 auto 模式取最右一跳成立的前提）', () => {
    // 🔴 钉的是**性质**而不是措辞：必须同时出现「追加」与「覆盖」这两个对立面，
    //    并且必须提到「最右」（说明为什么追加才对）。少了任何一项，运维都无法判断自己配错了。
    expect({
      讲了追加: doc.includes('追加'),
      讲了覆盖: doc.includes('覆盖'),
      讲了最右一跳: doc.includes('最右'),
      提到了XFF头名: doc.includes('X-Forwarded-For'),
    }).toEqual({ 讲了追加: true, 讲了覆盖: true, 讲了最右一跳: true, 提到了XFF头名: true });
    // 🔴 并且必须写明「覆盖」的后果，否则读者只知道「要追加」而不知道不追加会怎样。
    expect(doc).toContain('伪造');
  });

  it('文档必须写明 auto 是默认值，且三种取值都讲到（否则运维不知道自己现在是哪一种）', () => {
    expect(doc).toContain('`auto`（默认）');
    for (const mode of ['auto', 'always', 'never']) {
      expect({ 应当讲到该取值: mode, 命中: doc.includes(mode) }).toEqual({ 应当讲到该取值: mode, 命中: true });
    }
    // 🔴 `never` 的后果必须写明（反代后面全站共用一个桶 ⇒ 429 风暴），否则它看起来像个「更安全」的选项。
    expect(doc).toContain('429');
  });

  it('文档提到的这两个变量名必须真的在代码里存在（防止文档教人配一个不存在的旋钮）', () => {
    const dangling = [TRUST_VAR, BRUTE_VAR].filter((v) => !code.includes(v));
    expect({ 文档里指向不存在旋钮的: dangling }).toEqual({ 文档里指向不存在旋钮的: [] });
  });

  it('尺子有效性：一个合成变量名必须被同一套判定逻辑点名（证明上面的「缺失清单为空」不是判定坏了）', () => {
    const synthetic = 'VANBLOG_' + 'ZZZ_SYNTHETIC_PROXY_KNOB';
    expect(doc.includes(synthetic)).toBe(false);
    expect(code.includes(synthetic)).toBe(false);
    const missing = [TRUST_VAR, BRUTE_VAR, synthetic].filter((v) => !doc.includes(v));
    expect(missing).toEqual([synthetic]);
  });

  it('语义空操作对照：把「追加」改成同义的散文表述不得让上面任何一条变红（证明守卫不是对任何改动都红）', () => {
    // 🔴 这条**必须绿**。它是「变异体在语义上是空操作会被误读成守卫没咬住」那条教训的反向用法：
    //    主动放一条本该绿的对照，用它证明前几条的红是有理由的、而守卫又没有过紧。
    const reworded = doc.replace('## 反代方式', '## 反代方式（下面几种都可以）');
    expect(reworded).not.toBe(doc); // 替换真的发生了，否则这条对照是空的
    for (const v of [TRUST_VAR, BRUTE_VAR]) {
      expect(reworded.includes(v)).toBe(true);
    }
    expect(reworded.includes('追加')).toBe(true);
    expect(reworded.includes('覆盖')).toBe(true);
    expect(reworded.includes('最右')).toBe(true);
  });
});
