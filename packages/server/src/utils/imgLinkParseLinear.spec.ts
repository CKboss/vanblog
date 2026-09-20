import {
  IMG_RE,
  MAX_IMG_SCAN_STEPS_PER_BYTE,
  createImgScanStats,
  parseImgLinksOfMarkdown,
} from './parseImgOfMarkdown';
import { maskCodeRegions } from './markdownExport';

/**
 * `parseImgLinksOfMarkdown` 的**线性化**守卫。
 *
 * 旧实现用一条全局正则扫描正文，而 `([^\s)>]+)` 在"没有终止符"的输入上会一路吃到末尾再逐字符
 * 回溯，全局扫描又在每个 `![` 起点重来一遍 ⇒ **严格二次**。实测（跑仓库真函数）：
 * `![a](http://` 重复填充 20,000 B → 209.9 ms，200,000 B → **20,899 ms**（10× 输入 → 100× 时间）；
 * 未闭合 `![` 40,000 B → 1,806.9 ms；同尺寸正常 markdown 只要 24.6 ms。吃它的是**请求体里的正文**
 * （`article.provider.ts:459` 的 `scanLinksOfArticles`，以及经它落到的 `covers/from-content`
 * 与 `transfer-remote`），所以这是一条同步阻塞事件循环的远程 DoS。
 *
 * 这个文件守两件事：
 *  1. **等价性**：手写扫描器的输出与旧正则实现**逐项相同**（差分 fuzz + 结构化用例）。
 *     ⚠️ 不用计时做断言 —— 计时在负载下必然 flaky；计时数字只写进汇报。
 *  2. **算法形状**：扫描步数 ≤ `MAX_IMG_SCAN_STEPS_PER_BYTE` × 输入长度，且两个恶意形状
 *     必须触发"整体中止"（`aborted`），预算兜底（`budgetExhausted`）恒为 false。
 */

/** 旧实现（作为差分的参照物）。⚠️ 它是二次的，所以 fuzz 输入必须很小。 */
function referenceImpl(content: string): string[] {
  const text = String(content ?? '');
  if (!text) return [];
  const masked = maskCodeRegions(text);
  const res: string[] = [];
  const re = new RegExp(IMG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const raw = text.slice(m.index, m.index + m[0].length);
    const exact = new RegExp(IMG_RE.source).exec(raw);
    const url = String(exact?.[2] || '').trim();
    if (url && url.includes('http') && !res.includes(url)) res.push(url);
  }
  return res;
}

describe('等价性：结构化用例（与 imgLinkParse.spec.ts 的既有契约并列）', () => {
  const cases: Array<[string, string[]]> = [
    ['![a](https://cdn.example.com/x.png)', ['https://cdn.example.com/x.png']],
    ['![参见 https://docs.example.com/a](https://cdn.example.com/real.png "标题")', ['https://cdn.example.com/real.png']],
    ["![a](https://cdn/x.png '单引号标题')", ['https://cdn/x.png']],
    // ⚠️ 这个形状**不匹配**（我一开始写错了期望值）：`<?` 吞掉 `<`，URL 段停在空白处，
    //    然后可选标题组要求 `\s+` 后紧跟引号（这里是 `space.png>`，不是引号）⇒ 组不参与，
    //    接着 `\s*` 吃掉那个空格后要求 `)`，而下一个字符是 `s` ⇒ 整体失败。
    ['![a](<https://cdn/with space.png>)', []],
    ['![a](<https://cdn/no-space.png>)', ['https://cdn/no-space.png']], // 尖括号里没有空白才匹配
    ['![a](/static/img/x.webp)', []], // 相对路径不进外链检查
    ['![a](http://x)', ['http://x']],
    ['![](https://cdn/empty-alt.png)', ['https://cdn/empty-alt.png']],
    ['![a](https://one.png) 和 ![b](https://two.png)', ['https://one.png', 'https://two.png']],
    ['![a](https://dup.png) ![b](https://dup.png)', ['https://dup.png']], // 去重且保序
    ['![a](https://dup.png) ![b](https://other.png) ![c](https://dup.png)', ['https://dup.png', 'https://other.png']],
    ['没有图片的正文 ![a] 括号不配对', []],
    ['![a](https://cdn/x.png "未闭合的标题', []],
    ['!![a](https://cdn/double-bang.png)', ['https://cdn/double-bang.png']], // 起点后移一位仍能找到
    ['![a](  https://cdn/spaces.png  )', ['https://cdn/spaces.png']], // `\s*` 两侧
    ['![a](https://cdn/x.png)', ['https://cdn/x.png']],
    ['![a](data:image/png;base64,AAAA)', []], // data: 不含 http，旧行为就是不返回
    // `url.includes('http')` 是**大小写敏感**的，所以大写协议头会被排除 —— 这是旧行为，保持不动
    ['![a](HTTPS://CDN/UPPER.PNG)', []],
    ['![a](https://CDN/UPPER.PNG)', ['https://CDN/UPPER.PNG']],
  ];

  it.each(cases)('输出与旧正则实现逐项相同：%s', (input, expected) => {
    expect(parseImgLinksOfMarkdown(input)).toEqual(expected);
    expect(parseImgLinksOfMarkdown(input)).toEqual(referenceImpl(input));
  });

  it('代码区（围栏与行内代码）里的示例仍然被跳过', () => {
    const md = [
      '真图：![a](https://cdn.example.com/yes.png)',
      '',
      '```md',
      '![b](https://cdn.example.com/in-fence.png)',
      '```',
      '',
      '行内 `![c](https://cdn.example.com/inline.png)` 也不算',
    ].join('\n');
    expect(parseImgLinksOfMarkdown(md)).toEqual(['https://cdn.example.com/yes.png']);
    expect(parseImgLinksOfMarkdown(md)).toEqual(referenceImpl(md));
  });

  it('空输入与 null/undefined 都返回空数组（既有行为）', () => {
    expect(parseImgLinksOfMarkdown('')).toEqual([]);
    expect(parseImgLinksOfMarkdown(undefined as any)).toEqual([]);
    expect(parseImgLinksOfMarkdown(null as any)).toEqual([]);
  });
});

describe('等价性：差分 fuzz（随机与畸形输入下与旧正则逐项相同）', () => {
  // ⚠️ 参照实现是二次的，所以 token 数量压得很小；重点是**形状覆盖**，不是长度。
  const TOKENS = [
    '![', ']', '(', ')', '<', '>', '"', "'", ' ', '\t', '\n', 'http://a/b.png', 'https://c/d.png',
    'a', 'alt text', '`', '```', '![x](https://ok/1.png)', '![y](https://ok/2.png "t")', '/', ':',
    '![', '(', 'http', ')', '![a](', '![a](<', '> ', "'", '"', 'x', '\u00a0', '\u3000',
  ];

  function mulberry(seed: number) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('3000 个随机拼接的输入，输出与旧实现完全一致', () => {
    const rand = mulberry(20260920);
    let mismatch = 0;
    const firstBad: any[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const parts: string[] = [];
      const len = 1 + Math.floor(rand() * 12);
      for (let j = 0; j < len; j += 1) {
        parts.push(TOKENS[Math.floor(rand() * TOKENS.length)]);
      }
      const input = parts.join('');
      const mine = parseImgLinksOfMarkdown(input);
      const ref = referenceImpl(input);
      if (JSON.stringify(mine) !== JSON.stringify(ref)) {
        mismatch += 1;
        if (firstBad.length < 3) firstBad.push({ input: JSON.stringify(input), mine, ref });
      }
    }
    expect({ mismatch, firstBad }).toEqual({ mismatch: 0, firstBad: [] });
  });

  it('⚠️ fuzz 真的在生成"能匹配"的输入（否则上面那条是空转）', () => {
    const rand = mulberry(7);
    let matchedInputs = 0;
    for (let i = 0; i < 3000; i += 1) {
      const parts: string[] = [];
      const len = 1 + Math.floor(rand() * 12);
      for (let j = 0; j < len; j += 1) parts.push(TOKENS[Math.floor(rand() * TOKENS.length)]);
      const input = parts.join('');
      if (referenceImpl(input).length > 0) matchedInputs += 1;
    }
    // 反证：token 池里有完整的图片写法，所以一定会有非空结果；
    // 如果哪天 token 池被改坏导致"永远匹配不到"，这条会红，上面那条差分也就没有意义了。
    expect(matchedInputs).toBeGreaterThan(50);
  });
});

describe('算法形状：恶意输入必须触发整体中止，且步数与长度成线性', () => {
  function scan(input: string) {
    const stats = createImgScanStats(input.length);
    const links = parseImgLinksOfMarkdown(input, stats);
    return { links, stats, n: input.length };
  }

  it('`![a](http://` 重复填充（实测把旧实现打到 20.9 秒的形状）：中止 + 线性 + 结果为空', () => {
    const input = '![a](http://'.repeat(20000); // 240,000 B
    const { links, stats, n } = scan(input);
    expect(links).toEqual([]);
    expect(stats.aborted).toBe(true);
    expect(stats.budgetExhausted).toBe(false);
    expect(stats.steps).toBeLessThanOrEqual(MAX_IMG_SCAN_STEPS_PER_BYTE * n);
    // ⚠️ 关键：步数不应该随"起点个数"放大。旧实现在这里会扫 ~n²/10 个字符。
    expect(stats.steps).toBeLessThan(n * 2);
    expect(stats.attempts).toBeLessThanOrEqual(2);
  });

  it('未闭合的 `![` 重复填充（实测 40,000 B → 1.8 秒的形状）：中止 + 线性', () => {
    const input = '!['.repeat(20000); // 40,000 B
    const { links, stats, n } = scan(input);
    expect(links).toEqual([]);
    expect(stats.aborted).toBe(true);
    expect(stats.budgetExhausted).toBe(false);
    expect(stats.steps).toBeLessThanOrEqual(MAX_IMG_SCAN_STEPS_PER_BYTE * n);
    expect(stats.steps).toBeLessThan(n * 2);
  });

  it('放大 10× 输入，步数也只放大约 10×（线性的直接证据，不是计时）', () => {
    const small = scan('![a](http://'.repeat(2000));
    const big = scan('![a](http://'.repeat(20000));
    const ratio = big.stats.steps / Math.max(1, small.stats.steps);
    const sizeRatio = big.n / small.n;
    expect(ratio).toBeLessThanOrEqual(sizeRatio * 1.5);
    // ⚠️ 这两条是**变异对照 M3 教会我的**：只断言 steps 比值是不够的。去掉中止规则②之后，
    //    工作量预算会在约 24 次尝试后把扫描截停，steps 被"封顶"⇒ 比值看起来仍然线性，
    //    断言照样绿。所以必须同时要求 **budgetExhausted 为 false**：
    //    线性要来自中止规则（正常的算法性质），而不是来自预算耗尽（兜底被触发）。
    expect(small.stats.budgetExhausted).toBe(false);
    expect(big.stats.budgetExhausted).toBe(false);
  });

  it('⚠️ 合法正文不能被误伤：很多真图片时不中止、预算不耗尽、结果与旧实现一致', () => {
    const parts: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      parts.push(`正文段落 ${i} 与一张图 ![alt${i}](https://cdn.example.com/img-${i}.png "标题${i}")`);
    }
    const input = parts.join('\n\n');
    const { links, stats, n } = scan(input);
    expect(links).toHaveLength(500);
    expect(links[0]).toBe('https://cdn.example.com/img-0.png');
    expect(stats.budgetExhausted).toBe(false);
    expect(stats.steps).toBeLessThanOrEqual(MAX_IMG_SCAN_STEPS_PER_BYTE * n);
    expect(links).toEqual(referenceImpl(input));
  });

  it('恶意形状夹在合法内容中间时，前面的合法图片仍然被找到', () => {
    const input = `![ok](https://cdn/good.png)\n\n${'![a](http://'.repeat(5000)}`;
    const { links, stats } = scan(input);
    expect(links).toEqual(['https://cdn/good.png']);
    expect(stats.aborted).toBe(true);
  });

  it('预算兜底存在但正常情况下不会被触发（防止将来改坏后静默退回二次）', () => {
    const input = '![a](http://'.repeat(20000);
    const stats = createImgScanStats(input.length);
    expect(stats.budget).toBe(MAX_IMG_SCAN_STEPS_PER_BYTE * input.length);
    parseImgLinksOfMarkdown(input, stats);
    expect(stats.budgetExhausted).toBe(false);
    // 反证：把预算压到荒谬的小值时，兜底确实会生效（说明它不是永远为 false 的死断言）。
    // ⚠️ 必须用**不会触发整体中止**的输入：中止规则会在预算检查之前就 break，
    //    所以上面那个恶意形状即使预算=10 也不会置 budgetExhausted（这是设计，不是漏洞）。
    const many = '![a](https://cdn/x.png)'.repeat(200);
    const tiny = createImgScanStats(many.length);
    tiny.budget = 10;
    parseImgLinksOfMarkdown(many, tiny);
    expect(tiny.budgetExhausted).toBe(true);
  });
});

describe('maskCodeRegions 的引用形状没有漂移', () => {
  it('扫描器与参照实现用的是同一个 maskCodeRegions（否则"跳过代码区"会各说各话）', () => {
    // ⚠️ 这条钉的是"实现确实调用了 markdownExport 的那个函数"：
    // 用一个含代码区的输入，断言结果与"直接在原文上跑正则"不同（即 mask 真的起作用了）。
    const md = '```\n![a](https://cdn/in-fence.png)\n```\n![b](https://cdn/real.png)';
    expect(parseImgLinksOfMarkdown(md)).toEqual(['https://cdn/real.png']);
    const noMask = new RegExp(IMG_RE.source, 'g');
    const rawMatches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = noMask.exec(md)) !== null) rawMatches.push(m[2]);
    expect(rawMatches).toContain('https://cdn/in-fence.png'); // 不 mask 就会把代码区里的也当图片
    // ⚠️ 这里**不**写 `expect(importedMask).toBe(maskCodeRegions)` 那种断言：把一个 import 跟它自己比
    //    永远为真，是空转。真正的证据是上面两行——扫描器的结果里没有代码区那条，
    //    而"不 mask 直接跑正则"会有 ⇒ mask 确实生效且用的是同一套代码区语义。
  });
});
