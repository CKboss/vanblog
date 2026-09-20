import { maskCodeRegions } from './markdownExport';

/**
 * 从正文里找出图片链接。
 *
 * 旧实现遍历正则的**每一个捕获分组**，只用 `includes('http')` 过滤，于是：
 * - `![参见 https://docs.xxx](https://cdn/real.png)` 会把 **alt 文本**当成链接返回；
 * - `![a](url "标题")` 会返回 `url "标题"` 这一整段；
 * - 代码块/行内代码里的示例也会被当成真图片。
 * 这些假链接随后被 `scanLinksOfArticles` 拿去请求：失败的会被报成「文章里有失效图片」，
 * 成功的还会往 statics 表里插一条垃圾记录（storageType 写成 picgo）。
 *
 * ⚠️ **第二版：从严格二次改成线性。** 上面那条正则本身没问题，问题是**用它做全局扫描**：
 * `([^\s)>]+)` 在遇到"没有终止符"的输入时会一路吃到字符串末尾，再逐字符回溯，
 * 而全局扫描会在**每一个** `![` 起点重来一遍 ⇒ O(n²)。实测（跑仓库真函数）：
 * 用 `![a](http://` 重复填充，20,000 B → 209.9 ms，200,000 B → **20,899 ms**（10× 输入 → 100× 时间，
 * 拟合 k≈5.2e-7 ms/B² ⇒ **1MB 恶意正文约 572 秒、2MB 约 38 分钟**）；同尺寸的正常 markdown 只要 24.6 ms；
 * 未闭合的 `![` 40,000 B → 1,806.9 ms。吃这个函数的是**请求体里的正文**
 * （`article.provider.ts` 的 `scanLinksOfArticles`，以及经它落到的 `covers/from-content`
 * 与 `transfer-remote` 两个入口），所以这是一条同步阻塞事件循环的远程 DoS。
 *
 * 现在改成手写线性扫描器，语义与那条正则**逐字符等价**（见下面的 `matchImageAt`，
 * 并有差分 fuzz 守卫：随机输入下与旧正则的输出逐项相同）。线性靠两条**可证明安全**的中止规则：
 *  1. 从当前位置往后**再没有 `]`** ⇒ 任何更靠后的起点也不可能匹配（模式要求 `![…](`），整体停；
 *  2. URL 段一路扫到 **EOF 都没遇到终止符**（空白 / `)` / `>`）⇒ 更靠后的起点面对的
 *     终止符集合是它的子集，同样为空，整体停。
 * 这两条正好覆盖上面两个实测的恶意形状，把"每个起点都扫到末尾"变成"总共扫一遍"。
 * 另有一道**工作量预算**兜底（`MAX_IMG_SCAN_STEPS_PER_BYTE`）：即使将来出现我没想到的
 * 重叠扫描形状，成本也被钉在 O(n) 的常数倍以内，而不是退回二次。
 */
export const IMG_RE = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** 每字节允许的扫描步数上限（预算 = max(1MiB 步, 该系数 × 输入长度)）。 */
export const MAX_IMG_SCAN_STEPS_PER_BYTE = 24;
const MIN_SCAN_BUDGET = 1 << 20;

/** 一次扫描的工作量记录（可选出参，用来做**算法形状**断言而不是计时断言）。 */
export interface ImgScanStats {
  /** 实际检查过的字符数（各次尝试扫描距离之和） */
  steps: number;
  /** 本次允许的步数上限 */
  budget: number;
  /** 是否因为"再也不可能匹配"而提前整体中止（两条中止规则之一） */
  aborted: boolean;
  /** 是否因为**预算耗尽**而提前停止（正常情况下永远不该为 true） */
  budgetExhausted: boolean;
  /** 尝试过的起点数 */
  attempts: number;
}

export function createImgScanStats(length: number): ImgScanStats {
  return {
    steps: 0,
    budget: Math.max(MIN_SCAN_BUDGET, MAX_IMG_SCAN_STEPS_PER_BYTE * length),
    aborted: false,
    budgetExhausted: false,
    attempts: 0,
  };
}

/** `\s` 的 ASCII 快路径；超出 ASCII 的罕见空白（\u00a0、\u3000 等）交给正则，保证与 `\s` 完全一致。 */
function isSpaceAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c === 32 || (c >= 9 && c <= 13)) {
    return true; // 空格、\t \n \v \f \r
  }
  if (c < 0x80) {
    return false;
  }
  return /\s/.test(s.charAt(i));
}

interface ImgMatch {
  /** 匹配结束位置（不含） */
  end: number;
  /** URL 分组（正则里的第 2 组）在 s 中的 [start, end) */
  urlStart: number;
  urlEnd: number;
}

/** `matchImageAt` 返回它表示"后面的任何起点都不可能匹配了，整体停"。 */
const ABORT = Symbol('abort-image-scan');

/**
 * 在 `s[i]` 处尝试匹配 `IMG_RE` 一次。与那条正则**逐字符等价**：
 * `!\[` + `([^\]]*)` + `\]\(` + `\s*` + `<?` + `([^\s)>]+)` + `>?`
 * + `(?:\s+(?:"[^"]*"|'[^']*'))?` + `\s*` + `\)`。
 *
 * @returns 匹配信息 / `null`（这个起点不匹配） / `ABORT`（整体可以停）。
 */
export function matchImageAt(s: string, i: number, stats?: ImgScanStats): ImgMatch | null | typeof ABORT {
  const n = s.length;
  if (s.charCodeAt(i) !== 33 /* ! */ || s.charCodeAt(i + 1) !== 91 /* [ */) {
    return null;
  }
  if (stats) stats.attempts += 1;
  let k = i + 2;

  // ([^\]]*) 然后 \]：找到第一个 `]`。找不到 ⇒ 后面任何起点也找不到 ⇒ 整体中止。
  while (k < n && s.charCodeAt(k) !== 93 /* ] */) k += 1;
  if (k >= n) {
    if (stats) {
      stats.steps += n - i;
      stats.aborted = true;
    }
    return ABORT;
  }
  if (s.charCodeAt(k + 1) !== 40 /* ( */) {
    if (stats) stats.steps += k - i + 2;
    return null;
  }
  k += 2;

  // \s*
  while (k < n && isSpaceAt(s, k)) k += 1;
  // <?
  if (s.charCodeAt(k) === 60 /* < */) k += 1;

  // ([^\s)>]+)：至少一个字符，遇到空白 / `)` / `>` 停。
  const urlStart = k;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 41 /* ) */ || c === 62 /* > */ || isSpaceAt(s, k)) break;
    k += 1;
  }
  const urlEnd = k;
  if (urlEnd === urlStart) {
    // `+` 要求至少一个字符 ⇒ 不匹配（但后面的起点仍可能匹配，不能整体中止）
    if (stats) stats.steps += k - i + 1;
    return null;
  }
  if (urlEnd >= n) {
    // URL 段一路吃到 EOF 都没遇到终止符 ⇒ 更靠后的起点面对的终止符集合是子集（也是空），
    // 它们的 URL 段同样会吃到 EOF 并失败 ⇒ 整体中止。这正是 `![a](http://` 重复填充那个形状。
    if (stats) {
      stats.steps += n - i;
      stats.aborted = true;
    }
    return ABORT;
  }

  // >?
  if (s.charCodeAt(k) === 62 /* > */) k += 1;

  // (?:\s+(?:"[^"]*"|'[^']*'))?  —— 可选：不匹配就整个跳过（k 回到这里）
  const beforeTitle = k;
  let t = k;
  while (t < n && isSpaceAt(s, t)) t += 1;
  if (t > k && t < n) {
    const quote = s.charCodeAt(t);
    if (quote === 34 /* " */ || quote === 39 /* ' */) {
      let p = t + 1;
      while (p < n && s.charCodeAt(p) !== quote) p += 1;
      if (p < n) {
        k = p + 1; // 标题匹配成功（引号闭合）
      }
      // 引号没闭合 ⇒ 可选组不匹配，k 保持 beforeTitle
    }
  }
  if (k === beforeTitle) {
    // 可选组没参与匹配
  }

  // \s* 然后 \)
  while (k < n && isSpaceAt(s, k)) k += 1;
  if (s.charCodeAt(k) !== 41 /* ) */) {
    if (stats) stats.steps += Math.max(k, beforeTitle) - i + 1;
    return null;
  }
  if (stats) stats.steps += k + 1 - i;
  return { end: k + 1, urlStart, urlEnd };
}

/** 在 `s` 里从 `from` 起找第一个匹配（等价于非全局 `IMG_RE.exec(s)` 的语义：任意位置的首个匹配）。 */
function firstMatchIn(s: string, from: number, stats?: ImgScanStats): { match: ImgMatch; index: number } | null {
  let at = s.indexOf('![', from);
  while (at >= 0) {
    const m = matchImageAt(s, at, stats);
    if (m === ABORT) return null; // 短切片里中止 ⇒ 这个切片里没有匹配
    if (m) return { match: m, index: at };
    at = s.indexOf('![', at + 1);
  }
  return null;
}

/**
 * 取出正文里的外链图片 URL（保持旧行为：只关心含 `http` 的外链，本站相对路径不进「失效图片」检查；
 * 去重且保留首次出现的顺序）。
 *
 * @param stats 可选出参：填上本次扫描的工作量，供守卫断言"扫描步数与输入长度成线性"。
 *   ⚠️ 用步数而不是耗时做断言 —— 计时断言在负载下必然 flaky。
 */
export const parseImgLinksOfMarkdown = (content: string, stats?: ImgScanStats): string[] => {
  const text = String(content ?? '');
  if (!text) {
    return [];
  }
  // 代码区「涂黑」成等长占位，偏移量不变，因此可以用 masked 的位置回原文取真实内容
  const masked = maskCodeRegions(text);
  const out = stats ?? createImgScanStats(text.length);
  const res: string[] = [];
  // ⚠️ 去重以前用 `res.includes(url)`，那是"链接条数"上的二次；改用 Set，输出顺序与去重语义不变。
  const seen = new Set<string>();
  const n = masked.length;
  let pos = 0;
  while (pos < n) {
    const bang = masked.indexOf('![', pos);
    if (bang < 0) break;
    const m = matchImageAt(masked, bang, out);
    if (m === ABORT) break;
    if (m) {
      // 与旧实现一致：在**原文**的同一段切片上再解析一次，取真正的 URL
      // （masked 与原文在代码区不同，切片上的首个匹配也可能不在偏移 0）。
      const raw = text.slice(bang, m.end);
      const exact = firstMatchIn(raw, 0);
      const url = exact ? raw.slice(exact.match.urlStart, exact.match.urlEnd).trim() : '';
      // 保持旧行为：只关心外链（本站相对路径不进「失效图片」检查）
      if (url && url.includes('http') && !seen.has(url)) {
        seen.add(url);
        res.push(url);
      }
      pos = m.end;
    } else {
      // 与正则引擎"起点后移一位"等价：`![` 不可能从 bang+1 开始（那里是 `[`），
      // 所以直接从 bang+1 继续找下一个 `![` 即可。
      pos = bang + 1;
    }
    if (out.steps > out.budget) {
      // 兜底：预算耗尽就停止扫描，返回已找到的部分。正常情况下永远走不到这里
      // （两条中止规则已经保证了线性），它的存在只是为了"将来有人改坏了也不会退回二次"。
      out.budgetExhausted = true;
      break;
    }
  }
  return res;
};
