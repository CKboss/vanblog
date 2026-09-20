import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { stripCommentsForAnchor } from './anchorCode';

/**
 * `stripCommentsForAnchor` 自己的钉子。
 *
 * 这个函数是几十条"源码钉子"的地基：它错了，钉子就会**假红**（把真代码当注释吃掉，
 * 于是 `toContain('某段代码')` 找不到）或**假绿**（把注释当代码留下，于是"注释里提过"也算数）。
 * 假红尤其阴险 —— 它会让人以为产品代码坏了，去改本来没坏的代码。本仓库已经因此浪费过三轮。
 */

/** 旧实现（三步正则），只用于对拍"在旧实现判断正确的输入上输出必须逐字节一致"。 */
const naiveStrip = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/(\s|^)\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

describe('stripCommentsForAnchor：注释真的被剥掉了', () => {
  it('整行注释连缩进带换行一起删（与旧实现的 .filter 逐字节一致）', () => {
    const src = ['const a = 1;', '   // 整行注释', 'const b = 2;'].join('\n');
    expect(stripCommentsForAnchor(src)).toBe('const a = 1;\nconst b = 2;');
    expect(stripCommentsForAnchor(src)).toBe(naiveStrip(src));
  });

  it('行尾注释删掉 //…，但保留它前面那个空白（与旧实现的 replace(…, "$1") 一致）', () => {
    const src = 'const a = 1; // 尾随说明\nconst b = 2;';
    expect(stripCommentsForAnchor(src)).toBe('const a = 1; \nconst b = 2;');
    expect(stripCommentsForAnchor(src)).toBe(naiveStrip(src));
  });

  it('块注释整个删掉，包括里面的换行（与旧实现一致）', () => {
    const src = ['/**', ' * JSDoc 三行', ' */', 'const a = 1;'].join('\n');
    expect(stripCommentsForAnchor(src)).toBe('\nconst a = 1;');
    expect(stripCommentsForAnchor(src)).toBe(naiveStrip(src));
  });

  it('注释里的关键字不会留下来骗过 not.toContain 类钉子', () => {
    const src = '// catch (err) {\n// }\nconst a = 1;';
    expect(stripCommentsForAnchor(src)).not.toContain('catch');
    expect(stripCommentsForAnchor(src)).toBe('const a = 1;');
  });
});

describe('stripCommentsForAnchor：字符串 / 模板 / 正则里的斜杠不是注释（四次假红的根因）', () => {
  it('★ 真实回归：模板字符串里的 `/page/* /category/*` 不再开假块注释吃掉后面的代码', () => {
    // 这就是 caddy.provider.ts 里让 "clearLog 不是空 catch" 钉子假红的那段形状：
    // 日志文案里的 `/*` 被裸正则当成块注释开头，一路吞到 138 行外下一个真的 `*/`。
    const src = [
      'this.logger.log(',
      "  `直服范围：${all ? '/post/* /page/* /category/* /tag/*' : '仅 6 个固定页'}`,",
      ');',
      'clearLog() {',
      '  try {',
      "    fs.writeFileSync('/var/log/caddy.log', '');",
      '  } catch (err) {',
      '    this.logger.debug(`清空 caddy.log 失败（忽略）：${(err as Error)?.message}`);',
      '  }',
      '}',
      '/** 后面某个真的 JSDoc */',
      'addSubject() {}',
    ].join('\n');
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain('清空 caddy.log 失败');
    expect(stripped).toContain("fs.writeFileSync('/var/log/caddy.log', '')");
    expect(stripped).not.toMatch(/catch \(err\) \{\s*\}/);
    // 反证：旧实现在同一份输入上确实把这段代码吃掉了（说明这条钉子钉的是真差异，不是空断言）
    expect(naiveStrip(src)).not.toContain('清空 caddy.log 失败');
  });

  it('普通字符串里的 `//` 不被当行尾注释删掉', () => {
    const src = "const note = 'see // 这不是注释'; // 这才是真注释";
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain("'see // 这不是注释'");
    expect(stripped).not.toContain('这才是真注释');
    // 反证：旧实现从字符串里那个 ` //` 就开始删，把字符串后半段一起吃掉（于是引号都不配对）
    expect(naiveStrip(src)).not.toContain('这不是注释');
    expect(naiveStrip(src)).toBe("const note = 'see ");
  });

  it('URL 里的 `://` 两个实现都不误判（这一类本来就安全，钉住免得改坏）', () => {
    const src = "const url = 'https://example.com/a'; // 删我";
    expect(stripCommentsForAnchor(src)).toBe("const url = 'https://example.com/a'; ");
    expect(stripCommentsForAnchor(src)).toBe(naiveStrip(src));
  });

  it('双引号与转义引号都认', () => {
    const src = 'const s = "a \\" b // c";\nconst t = 1; // 删我';
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain('"a \\" b // c"');
    expect(stripped).toContain('const t = 1;');
    expect(stripped).not.toContain('删我');
  });

  it('模板字符串里的 `/*` 与 `//` 都是文本，而 `${}` 插值里的注释照样剥', () => {
    const src = [
      'const a = `路径 /static/img/*.{webp,png} 与 // 双斜杠都是文本`;',
      'const b = `${x /* 插值里的块注释要删 */ + 1}`; // 插值外的行注释也要删',
      'const c = 2;',
    ].join('\n');
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain('`路径 /static/img/*.{webp,png} 与 // 双斜杠都是文本`');
    expect(stripped).not.toContain('插值里的块注释要删');
    expect(stripped).not.toContain('插值外的行注释也要删');
    expect(stripped).toContain('const b = `${x  + 1}`;');
    expect(stripped).toContain('const c = 2;');
  });

  it('嵌套模板：`${ `里层 ${x}` }` 解析完还能回到真代码', () => {
    const src = 'const a = `外 ${`内 ${y} 层`} 完`; // 删我\nconst b = 1;';
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain('`外 ${`内 ${y} 层`} 完`');
    expect(stripped).not.toContain('删我');
    expect(stripped).toContain('const b = 1;');
  });

  it('正则字面量里的 `/*` 不开假块注释，flags 一并保留', () => {
    const src = ['const re = /\\/\\*|\\//g;', 'const path = /static\\/img\\/*/;', 'const z = 1; // 删我'].join(
      '\n',
    );
    const stripped = stripCommentsForAnchor(src);
    expect(stripped).toContain('const z = 1;');
    expect(stripped).not.toContain('删我');
    expect(stripped).toMatch(/\/g;/);
  });

  it('除号不会被误判成正则（`a / b / c` 原样留下）', () => {
    const src = 'const q = total / count / 2;\nconst w = 1;';
    expect(stripCommentsForAnchor(src)).toBe(src);
  });

  it('未闭合的块注释只吞到文件尾，未闭合的字符串只吞到行尾（绝不抛异常）', () => {
    expect(() => stripCommentsForAnchor('const a = 1;\n/* 没闭合')).not.toThrow();
    expect(stripCommentsForAnchor('const a = 1;\n/* 没闭合')).toBe('const a = 1;\n');
    expect(stripCommentsForAnchor("const s = '没闭合\nconst b = 2;")).toContain('const b = 2;');
  });
});

describe('stripCommentsForAnchor：与旧实现在全仓库源码上对拍（不许弄丢任何一行真代码）', () => {
  const root = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'test-utils') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);

  it('扫到了足够多的源文件（对拍不是空的）', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('旧实现保留下来的**每一行真代码**，新实现都还在（迁移不许弄丢钉子）', () => {
    // 判据必须是"真源码行"：旧实现把字符串在 `/*`、` //` 处截断之后，会产生一批
    // 源文件里根本不存在的残渣行（例如 `return paths.includes('/api);`），
    // 那些不是代码，新实现正确地不留它们。所以只比对同时出现在原始源文件里的行。
    const lost: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const realLines = new Set(
        src
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      const mine = new Set(
        stripCommentsForAnchor(src)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      for (const line of naiveStrip(src).split('\n')) {
        const t = line.trim();
        if (t && realLines.has(t) && !mine.has(t)) lost.push(`${f.replace(root, 'src')} :: ${t.slice(0, 90)}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('新实现确实救回了被旧实现吃掉的代码（对拍不是两边都错的空比较）', () => {
    // caddy.provider.ts 是那个真实事故现场：日志文案里的 `/post/* /page/*` 让旧实现
    // 开了个假块注释，把后面 130 多行真代码（含 clearLog()）一起吃掉。
    const f = join(root, 'provider/caddy/caddy.provider.ts');
    const src = readFileSync(f, 'utf8');
    const countReal = (stripped: string) => {
      const realLines = new Set(
        src
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      return new Set(
        stripped
          .split('\n')
          .map((l) => l.trim())
          .filter((t) => t && realLines.has(t)),
      ).size;
    };
    const before = countReal(naiveStrip(src));
    const after = countReal(stripCommentsForAnchor(src));
    // ⚠️ 这里**不再**用"活文件上差多少行"当判据：那个差值与 `caddy.provider.ts` 的注释布局
    //    耦合 —— 任何人在那条日志行之后新增一段文档注释，就会给朴素实现提供一个更早的 `*/`，
    //    差值随之塌陷（实测：HEAD 上 118→170 差 52，只比阈值 50 多 2；加了一段注释后变成
    //    218→233 差 15，于是这条"防空转对照"红了，而剥注释器其实**更好了**：多救回 63 行真代码）。
    //    ⚠️ 修法是换成固定 fixture，**不是把阈值调小** —— 调小等于承认这条对照可以不敏感。
    expect(after).toBeGreaterThanOrEqual(before);
    // 真块注释必须被剥掉（否则就是"什么都不剥"的假实现）；跨行也要能吃掉。
    const blockFixture = "const a = 1;\n/* 真的块注释\n   跨两行 */\nconst tail = 'AFTER_BLOCK';";
    expect(stripCommentsForAnchor(blockFixture)).not.toContain('真的块注释');
    expect(stripCommentsForAnchor(blockFixture)).toContain('AFTER_BLOCK');
    // ⚠️ 这两条以前钉在 `caddy.provider.ts` 的一行日志文案上（那正是当初的"事故现场"：
    //    文案里的 `/post/*` 会让朴素实现开一个假块注释、把后面的真代码全吃掉）。
    //    但**活文件的注释布局一变，事故现场就不再复现** —— 本轮 `caddy.provider.ts` 新增了
    //    文档注释，给朴素实现提供了一个更早的 `*/`，于是这两条同时失效（一条红、另一条失去意义），
    //    而剥注释器其实变得**更好**了。⇒ 陷阱的复现必须用固定 fixture（见下），
    //    活文件只保留"不会因布局变化而失效"的性质断言（`after >= before`，逐文件成立）。
    expect(stripCommentsForAnchor(src)).toContain('清空 caddy.log 失败');
    // 固定 fixture：字符串里含 `/*` 与 `//`，朴素实现会从这里开一个假块注释、吃掉后面的真代码。
    // ⚠️ fixture 必须**同时**具备两个要素才复现得了当初的事故：
    //    ① 字符串里有一个 `/*`（朴素实现在这里开一个假块注释）；
    //    ② 后面某处有一个真的 `*/`（假块注释到这里才闭合）。
    //    少了 ② 就什么都不会被吃掉（我第一版就漏了，于是断言恒红）。
    const trap = [
      "const url = 'https://example.com/a'; // 协议里的 // 不是注释",
      "const pat = '/*'; // 字符串里的 /* 不是块注释开始",
      "const sentinel = 'TRAP_SENTINEL_LINE';",
      '/* 真的块注释 */',
      "const tail = 'AFTER_BLOCK';",
    ].join('\n');
    expect(naiveStrip(trap)).not.toContain('TRAP_SENTINEL_LINE'); // 朴素实现把它吃了
    expect(stripCommentsForAnchor(trap)).toContain('TRAP_SENTINEL_LINE'); // 新实现救回来了
    expect(stripCommentsForAnchor(trap)).toContain('AFTER_BLOCK');
    expect(stripCommentsForAnchor(trap)).not.toContain('真的块注释'); // 真注释仍然要剥掉
  });

  it('幂等：剥两次与剥一次结果相同（不会把代码越剥越少）', () => {
    for (const f of files.slice(0, 60)) {
      const once = stripCommentsForAnchor(readFileSync(f, 'utf8'));
      expect(stripCommentsForAnchor(once)).toBe(once);
    }
  });
});
