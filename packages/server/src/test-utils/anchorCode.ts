/**
 * 源码级锚点断言用的"剥注释"工具（**只给 spec 用**：`tsconfig.build.json` 已把本目录排除，不进 dist）。
 *
 * ## 为什么需要它
 *
 * 本仓库有一大类测试是"源码钉子"：把某个 `.ts` 读进来，断言里面**确实写着**某段代码
 * （`expect(code(read('provider/caddy/caddy.provider.ts'))).toContain('清空 caddy.log 失败')`）。
 * 断言前必须先把注释剥掉，否则"注释里提过这句话"也会让钉子变绿 —— 那就什么都钉不住了。
 *
 * ## 为什么不能用正则一把梭（同一类雷已经踩了四次）
 *
 * 曾经的实现是三步正则：删整行 `//` 注释 → 删行尾 `//` 注释 → 删 `/* … *\/`。
 * 它分不清"注释里的斜杠"和"字符串里的斜杠"，于是**任何出现在字符串 / 模板字符串 / 正则字面量里的
 * `/*` 两个字节都会开启一个假块注释，把后面几十上百行真代码一起吃掉**，钉子变成假红：
 *
 * 1. `main.ts` 的说明文字里有 `/static/img/*.{webp,png,…}` ⇒ 静态目录守卫只找到 1 个目录（实际 ≥6）；
 * 2. 同一处 ⇒ `main.ts` 的 primary 守卫钉子找不到那行代码；
 * 3. `caddy.provider.ts` 的尾随注释里有 `/static/img/<file>.{webp,…}` ⇒ keepAliveTimeout / clearLog 两条钉子假红；
 * 4. **`caddy.provider.ts` 的日志文案（模板字符串）里有 `/page/* /category/* /tag/*`** ⇒
 *    从那里开一个假块注释，一路吞到 138 行外下一个真的 `*\/`，把整个 `clearLog()` 吃掉，
 *    "caddy 的 clearLog 不再是空 catch"这条钉子因此假红（2026-09-17 实测，就是本文件诞生的原因）。
 *
 * 前三次的修法都是"调整三步正则的顺序"，那只是把雷换个位置埋：**只要源码里能写出 `/*` 这两个字节
 * （日志文案、路径 glob、正则字面量都会写），裸正则就永远会误判**。所以这里换成单遍扫描，
 * 真正跟踪上下文：行注释、块注释、单/双引号字符串、模板字符串（含 `${}` 递归嵌套）、正则字面量。
 *
 * ## 输出形状与旧实现在"旧实现判断正确的输入"上逐字节一致
 *
 * 为了不逼着几十条既有钉子改写法，删除规则刻意照抄旧实现：
 * - **整行注释** ⇒ 连缩进带换行一起删（旧：`.filter((l) => !/^\s*\/\//.test(l))`）；
 * - **行尾注释** ⇒ 删掉 `//` 及其后内容，保留它前面的空白（旧：`.replace(/(\s|^)\/\/.*$/, '$1')`）；
 * - **块注释** ⇒ 整个删掉，**包括里面的换行**（旧：`.replace(/\/\*[\s\S]*?\*\//g, '')`）。
 *
 * 只有两处与旧实现不同，且都是旧实现错的地方：
 * - 字符串 / 模板 / 正则字面量里的 `//` 与 `/*` 不再被当注释（假块注释的根因）；
 * - `foo();// bar` 这种斜杠前**没有空白**的行尾注释，旧的三步正则匹配不上（`(\s|^)` 要求前置空白），
 *   注释会留在"已剥注释"的文本里；本实现照样剥掉。
 *
 * ⚠️ 不支持 JSX/TSX（本包没有）与 HTML 注释（`<!--` 会当普通文本原样留下）。
 */

/** 扫描上下文栈帧。`code` 帧记录花括号深度，只用于从模板字符串的 `${` 插值里出来。 */
interface Frame {
  kind: 'code' | 'template';
  braceDepth: number;
}

/** 前一个有效 token 是这些**单字符**时，`/` 更可能是正则字面量而不是除号。 */
const REGEX_ALLOWED_AFTER_CHAR = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
]);

/** 前一个有效 token 是这些**关键字**时，`/` 也是正则字面量（`return /x/.test(s)`）。 */
const REGEX_ALLOWED_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/** 取已输出文本末尾最近一个"有效 token"（跳过空白），用来判断 `/` 是正则还是除号。 */
function lastSignificantToken(out: string): string {
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1])) end -= 1;
  if (end === 0) return '';
  const ch = out[end - 1];
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let start = end;
    while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1])) start -= 1;
    return out.slice(start, end);
  }
  return ch;
}

function isRegexStart(out: string): boolean {
  const tok = lastSignificantToken(out);
  if (tok.length > 1) return REGEX_ALLOWED_AFTER_KEYWORD.has(tok);
  return REGEX_ALLOWED_AFTER_CHAR.has(tok);
}

/**
 * 剥掉 TS/JS 源码里的注释，字符串 / 模板 / 正则字面量原样保留。
 * 纯函数、无状态、不抛异常：未闭合的注释或字符串按"吞到行尾/文件尾"处理，绝不吃掉后面的真代码。
 */
export function stripCommentsForAnchor(src: string): string {
  const stack: Frame[] = [{ kind: 'code', braceDepth: 0 }];
  let out = '';
  /** 当前行在 `out` 里的起始下标（判断"整行注释"用）。 */
  let lineStart = 0;
  let i = 0;

  const emit = (text: string) => {
    out += text;
  };
  const emitNewline = () => {
    out += '\n';
    lineStart = out.length;
  };
  /** 当前行已经写出的内容。 */
  const lineSoFar = () => out.slice(lineStart);

  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const next = src[i + 1];

    // ---------------- 模板字符串内部：除了 ` 与 ${ 之外都不是语法 ----------------
    if (top.kind === 'template') {
      if (c === '\\') {
        emit(i + 1 < src.length ? src.slice(i, i + 2) : c);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        emit(c);
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        stack.push({ kind: 'code', braceDepth: 1 });
        emit('${');
        i += 2;
        continue;
      }
      if (c === '\n') emitNewline();
      else emit(c);
      i += 1;
      continue;
    }

    // ---------------- code 上下文 ----------------

    // 行注释
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      if (lineSoFar().trim() === '') {
        // 整行注释：连缩进带换行一起删（这一行当作从来没存在过）
        out = out.slice(0, lineStart);
        i = src[j] === '\n' ? j + 1 : j;
      } else {
        // 行尾注释：`//` 之前的内容（含那个空白）已经原样在 out 里了，只需跳过注释本身
        i = j;
      }
      continue;
    }

    // 块注释（含 JSDoc）：整个删掉，包括里面的换行
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    // 单/双引号字符串
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j += 1;
          break;
        }
        if (src[j] === '\n') break; // 未闭合：按行结束处理，别把整份源码吞掉
        j += 1;
      }
      j = Math.min(j, src.length);
      const text = src.slice(i, j);
      const parts = text.split('\n');
      emit(parts.shift() as string);
      for (const p of parts) {
        emitNewline();
        emit(p);
      }
      i = j;
      continue;
    }

    // 模板字符串开始
    if (c === '`') {
      stack.push({ kind: 'template', braceDepth: 0 });
      emit(c);
      i += 1;
      continue;
    }

    // 正则字面量（必须与除号区分开，否则 `/` 之后的 `*` 会被当成块注释开头）
    if (c === '/' && isRegexStart(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === '\\') {
          j += 2;
          continue;
        }
        if (rc === '\n') break; // 不跨行 ⇒ 不是正则字面量，回头按除号处理
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < src.length && /[dgimsuvy]/.test(src[j])) j += 1; // flags
        emit(src.slice(i, j));
        i = j;
        continue;
      }
    }

    if (c === '\n') {
      emitNewline();
      i += 1;
      continue;
    }

    if (c === '{') {
      top.braceDepth += 1;
      emit(c);
      i += 1;
      continue;
    }

    if (c === '}' && stack.length > 1) {
      top.braceDepth -= 1;
      emit(c);
      if (top.braceDepth === 0) stack.pop(); // 插值结束，回到模板字符串
      i += 1;
      continue;
    }

    emit(c);
    i += 1;
  }

  return out;
}
