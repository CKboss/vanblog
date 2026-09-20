import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 🔒 漂移守卫：**任何调用同步 scrypt 系列函数的地方都必须 `await` 其异步变体**。
 *
 * 这条守卫存在的理由是一次真实的事故推演（不是假想）：`verifyAccessPassword` 的调用点原来长这样
 *
 *     if (!verifyAccessPassword(targetPassword, supplied)) { return null; }
 *
 * 如果有人"顺手"把函数签名改成 async 而**没有**同步给调用点加 `await`，那么
 * `!Promise` 恒为 `false` ⇒ **任何密码都能解开任何加密文章**（静默的未鉴权正文泄露，
 * 没有报错、没有日志、测试也可能照绿）。所以本包的实现方式刻意是"新增 `*Async` 变体、
 * 同步版签名一动不动"：漏改的最坏结果只是**继续同步阻塞**（= 修复前的现状），
 * 绝不会退化成鉴权绕过。这条守卫负责把"继续同步阻塞"也消掉。
 *
 * 同时它也守着性能性质本身：同步 scrypt 单次 **63 ms**（本机实测）会独占事件循环，
 * 而文章解锁是匿名可达的 ⇒ 裸调用同步版 = 一条现成的 DoS 放大链。
 *
 * ⚠️ 判据刻意**不是**"源码里出现了 Async 字样"（import 行就能让它过），而是
 * "每个同步函数名的调用点，其紧邻前缀必须是 `await`"。
 */

const SRC_ROOT = resolve(__dirname, '..');

/**
 * 同步实现所在的两个文件本身豁免：它们内部的同步函数互相委托是**定义**，
 * 不是调用点（例如 `verifyUserPassword` 内部调 `verifySecret`）。
 */
const IMPL_FILES = new Set(['utils/crypto.ts', 'utils/accessPassword.ts']);

/**
 * 已知的、**尚未迁移**的同步调用点（显式登记，不许增长）。
 *
 * ## 这个清单现在是空的 —— 请让它保持空
 *
 * 它曾经登记了三处后台写入路径（`article.provider.ts` 的 createArticle / updateById、
 * `category.provider.ts` 的 updateCategoryByName），理由是"鉴权后可达、不构成匿名 DoS 放大链"。
 * 那个理由**不够**：这三处各自会阻塞事件循环约 63 ms，一个有写权限的协作者（钓鱼/撞库/内鬼
 * 都可能产生）反复保存加密文章就能持续拖慢整个 worker；而在"极端网络攻击环境"的威胁模型下，
 * **低权限账号应当被当作攻击者已经拿到**来设计。三处已全部迁移到 `resolveAccessPasswordWriteAsync`。
 *
 * ⚠️ 这个清单与下面的断言是**精确对齐**的（多一处少一处都红），所以：
 * - 新增任何同步 scrypt 调用点 ⇒ 这里必须显式登记 + 写清理由，而登记本身会在 review 里很扎眼；
 * - 迁移完一处 ⇒ 必须从这里删掉，否则"清单过期"会红（这是刻意的：过期的豁免清单等于没清单）。
 * ⚠️ 迁移时别漏 `await`：`passwordWrite.password` 会变成 `undefined`，落到"不修改密码"分支，
 *    于是**静默丢掉用户刚设的密码**（不报错、不抛异常）。下面的形状断言盯着这一点。
 */
const KNOWN_REMAINING_SYNC_CALLS: ReadonlyArray<{ file: string; fn: string; reason: string }> = [];

/** 同步版函数名（异步变体以 `Async` 结尾，不会被这个正则匹配到） */
const SYNC_FN_PATTERN =
  /(?<![\w.$])(verifySecret|verifyAccessPassword|verifyUserPassword|hashSecret|hashAccessPassword|hashAccessPasswordIdempotent|resolveAccessPasswordWrite)\s*\(/g;

interface Violation {
  file: string;
  line: number;
  fn: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) {
        continue;
      }
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找出"没有 await 的同步调用"。
 * @param source 已剥注释的源码
 * @param file 相对 `src/` 的路径（用于豁免实现文件与匹配已知清单）
 */
export function findUnawaitedSyncCryptoCalls(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const re = new RegExp(SYNC_FN_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const before = source.slice(Math.max(0, m.index - 40), m.index);
    // 紧邻前缀是 await（含 `return await` / `= await` / `!(await` / `, await` 等形状）就算合规
    if (/\bawait\s*$/.test(before)) {
      continue;
    }
    // 函数**定义**本身（`export function hashSecret(`）不是调用点
    if (/\bfunction\s+$/.test(before)) {
      continue;
    }
    const line = source.slice(0, m.index).split('\n').length;
    violations.push({
      file,
      line,
      fn: m[1],
      text: source.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20).replace(/\s+/g, ' '),
    });
  }
  return violations;
}

describe('同步 scrypt 调用点的漂移守卫', () => {
  const files = walk(SRC_ROOT);
  const scanned = files
    .map((full) => relative(SRC_ROOT, full).split('\\').join('/'))
    .filter((rel) => !IMPL_FILES.has(rel));

  it('扫描本身没空转（真的扫到了源文件，且实现文件被正确豁免）', () => {
    // 空转的守卫比没有守卫更糟：本仓库有过 heredoc 参数写错位置导致检查从未执行的先例
    expect(files.length).toBeGreaterThan(150);
    expect(scanned.length).toBe(files.length - IMPL_FILES.size);
    expect(scanned).toContain('provider/article/article.provider.ts');
    expect(scanned).toContain('provider/user/user.provider.ts');
    expect(scanned).not.toContain('utils/crypto.ts');
  });

  it('除已登记的三处写入路径外，任何地方都不许裸调用同步 scrypt 系列函数', () => {
    const found: Violation[] = [];
    for (const full of files) {
      const rel = relative(SRC_ROOT, full).split('\\').join('/');
      if (IMPL_FILES.has(rel)) {
        continue;
      }
      const source = stripCommentsForAnchor(readFileSync(full, 'utf8'));
      found.push(...findUnawaitedSyncCryptoCalls(source, rel));
    }
    // 把发现的东西与已知清单对齐：既不许多（新出现的裸调用），也不许少（清单过期）
    const foundKeys = found.map((v) => `${v.file}::${v.fn}`).sort();
    const knownKeys = KNOWN_REMAINING_SYNC_CALLS.map((k) => `${k.file}::${k.fn}`).sort();
    if (foundKeys.join('|') !== knownKeys.join('|')) {
      // 失败信息里带上具体位置，否则只知道"数量不对"没法定位
      const unexpected = found.filter(
        (v) => !KNOWN_REMAINING_SYNC_CALLS.some((k) => k.file === v.file && k.fn === v.fn),
      );
      throw new Error(
        `同步 scrypt 调用点与登记清单不一致。\n` +
          `未登记的裸调用（必须改成 await *Async）：\n${unexpected
            .map((v) => `  ${v.file}:${v.line} ${v.fn} → ${v.text}`)
            .join('\n') || '  （无）'}\n` +
          `实际发现：${JSON.stringify(foundKeys)}\n` +
          `登记清单：${JSON.stringify(knownKeys)}`,
      );
    }
    expect(foundKeys).toEqual(knownKeys);
  });

  it('空转反证：事故现场那个确切形状必须被抓出来', () => {
    // 这就是修复前 article.provider.ts:1334 的原文形状
    const accident = `
      const supplied = asQueryString(password);
      if (!verifyAccessPassword(targetPassword, supplied)) {
        return null;
      }
    `;
    const hits = findUnawaitedSyncCryptoCalls(accident, 'provider/article/article.provider.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0].fn).toBe('verifyAccessPassword');
    expect(hits[0].line).toBe(3);
  });

  it('空转反证：其它几种"漏 await"的写法也都要被抓出来', () => {
    const shapes = [
      'const h = hashSecret(password);',
      'return verifySecret(stored, input);',
      'patch.password = hashAccessPasswordIdempotent(legacy);',
      'if (verifyUserPassword(a, b, c, d)) { ok(); }',
      'void runLater(resolveAccessPasswordWrite(dto, "create"));',
    ];
    for (const shape of shapes) {
      expect(findUnawaitedSyncCryptoCalls(shape, 'x/y.ts')).toHaveLength(1);
    }
  });

  it('合规形状不会被误报（await / 异步变体 / 定义本身）', () => {
    const ok = [
      'if (!(await verifyAccessPasswordAsync(a, b))) { return null; }',
      'const h = await hashSecretAsync(password);',
      'patch.password = await hashAccessPasswordIdempotentAsync(legacy);',
      'return await verifySecretAsync(stored, input);',
      'export function hashSecret(secret: string): string {',
      'const write = await resolveAccessPasswordWriteAsync(dto, "create");',
      // 属性名/字符串里出现同名片段也不算调用
      'const label = "verifyAccessPassword";',
    ];
    for (const shape of ok) {
      expect(findUnawaitedSyncCryptoCalls(shape, 'x/y.ts')).toEqual([]);
    }
  });
});

describe('匿名解锁路径的具体形状（事故现场必须保持修复后的样子）', () => {
  const article = stripCommentsForAnchor(
    readFileSync(resolve(SRC_ROOT, 'provider/article/article.provider.ts'), 'utf8'),
  );

  it('解锁判定用的是异步变体，并且**带 await**', () => {
    // 断言调用形状而不是"符号出现"：`!(await verifyAccessPasswordAsync(` 这个整体
    // 既证明了用的是异步版，也证明了没有漏 await（漏了就变成 `!(verifyAccessPasswordAsync(`）。
    expect(article).toMatch(/!\(\s*await\s+verifyAccessPasswordAsync\s*\(/);
  });

  it('article.provider 不再 import 同步版 verifyAccessPassword（防止有人改回去）', () => {
    const importLine = readFileSync(
      resolve(SRC_ROOT, 'provider/article/article.provider.ts'),
      'utf8',
    )
      .split('\n')
      .find((l) => l.includes("from 'src/utils/crypto'"));
    expect(importLine).toBeDefined();
    expect(importLine).toContain('verifyAccessPasswordAsync');
    expect(importLine || '').not.toMatch(/(?<!Async)\bverifyAccessPassword\b(?!Async)/);
  });

  it('登录路径用的是异步校验，且用户不存在时会跑 dummy 工作量', () => {
    const user = stripCommentsForAnchor(
      readFileSync(resolve(SRC_ROOT, 'provider/user/user.provider.ts'), 'utf8'),
    );
    expect(user).toMatch(/await\s+verifyUserPasswordAsync\s*\(/);
    // dummy 工作必须在 `return null` **之前**（否则等于没跑）
    const idxDummy = user.indexOf('await runDummyPasswordWork(');
    expect(idxDummy).toBeGreaterThan(0);
    const tail = user.slice(idxDummy);
    expect(tail.slice(0, tail.indexOf('return null'))).not.toContain('return null');
  });
});
