import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 🔴 **横切守卫：被 `@Optional()` 注入的类型，绝不能用类型专用导入引入。**
 *
 * 为什么这条守卫存在（2026-09-22 的一条真实缺陷，在真实镜像里活体确证）：
 * `controller/public/health.controller.ts` 曾用类型专用导入引入 `WebsiteProvider`。
 * 类型导入在编译期被**完全擦除** ⇒ 不给 Nest 的 DI 提供任何运行时值 ⇒ 发射的
 * `design:paramtypes` 里那一项退化成 `Function`，Nest 无法把它当 provider token。
 * 🔴 **而 `@Optional()` 让这件事完全静默**：解析不到不报错、不启动失败，只注入 `undefined`
 * ⇒ 那个 `website` 字段恒为 `unknown`、状态码恒 200，**而它本来要修的 k8s/HEALTHCHECK 盲区一点没被修掉**。
 *
 * 🔴 **`@Optional()` + 类型专用导入是最危险的组合**，所以本守卫只钉这个组合，而不是所有类型导入：
 * 没有 `@Optional()` 时同样的错误会让应用**启动失败**（fail-loud，立刻被发现）；
 * 只做类型用途（例如 express 的 `Request`/`Response`）时类型导入是**正确**写法，不该报。
 *
 * ⚠️ **口径与假阳性评估**（横切守卫最常见的死法是误报太多 ⇒ 被人加白名单加到失效）：
 * 全仓非 spec 源码里 `@Optional()` **构造参数**共 **11** 处（⚠️ 不是 `grep -c "@Optional()"` 的 17 —— 
 * 那 17 处里有 6 处只是注释提及）、类型专用导入共 **9** 条，
 * 两者的交集在修复前**恰好 1 处**（就是 health 那条）、修复后 **0 处** ⇒ 扫描面很小、误报风险低，
 * 不需要白名单机制。若将来交集里出现**有意**的例外，应当在这里加一条**带理由**的白名单，
 * 并仿 `queryFilterDrift` 加防腐锚点（指向已不存在的 `文件:锚点` 就红）。
 *
 * ⚠️ **本守卫只覆盖"类型专用导入"这一个成因**。DI 解析不到还有别的成因（provider 没注册进模块、
 * 模块没被 import、token 写错），那些由 `health.controller.di.spec.ts` 用**真实 Nest 容器**解析来钉住。
 */

const SRC_ROOT = join(__dirname, '..');

/** 剥掉注释与字符串，只留真实代码 —— 判"代码里有没有某个形状"必须剥，否则会被注释喂饱。 */
const BLOCK_OPEN = ['/', '*'].join('');
const BLOCK_CLOSE = ['*', '/'].join('');
const TYPE_IMPORT = ['import', 'type'].join(' ');

function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (two === BLOCK_OPEN) {
      const end = src.indexOf(BLOCK_CLOSE, i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      walk(full, acc);
      continue;
    }
    if (!full.endsWith('.ts')) continue;
    if (full.endsWith('.spec.ts')) continue;
    acc.push(full);
  }
  return acc;
}

/** 取出所有 `@Optional()` 构造参数的类型名。 */
function optionalParamTypes(code: string): string[] {
  const out: string[] = [];
  // @Optional() 之后可能还有别的装饰器（如 @Inject(X)）、访问性修饰符、参数名、可选标记，最后才是类型。
  const re = /@Optional\(\)[^,)\n]*?([A-Z][A-Za-z0-9_]*)\s*(?:[,)]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** 该文件里用类型专用导入引入的名字集合。 */
function typeImportedNames(code: string): Set<string> {
  const names = new Set<string>();
  const re = new RegExp('^' + TYPE_IMPORT + '\\s*\\{([^}]*)\\}', 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  return names;
}

interface Finding {
  file: string;
  type: string;
}

function scan(root: string = SRC_ROOT): { findings: Finding[]; params: number; files: number } {
  const files = walk(root);
  const findings: Finding[] = [];
  let params = 0;
  for (const f of files) {
    const code = stripCommentsAndStrings(readFileSync(f, 'utf8'));
    const types = optionalParamTypes(code);
    params += types.length;
    if (types.length === 0) continue;
    const typeImports = typeImportedNames(code);
    for (const t of types) {
      if (typeImports.has(t)) findings.push({ file: relative(root, f), type: t });
    }
  }
  return { findings, params, files: files.length };
}

describe('横切：@Optional() 注入的类型不能用类型专用导入（会让 Nest DI 静默注入 undefined）', () => {
  it('🔴 全仓扫描：@Optional() 注入的类型没有一个是用类型专用导入引入的', () => {
    const { findings } = scan();
    // 失败时把确切位置打出来，便于直接定位。
    expect(findings.map((f) => `${f.file} → ${f.type}`)).toEqual([]);
  });

  it('🔴 反空转：扫描面确实覆盖到了出过问题的那一处，且参数量与文件量都不为 0', () => {
    const { findings, params, files } = scan();
    // 反空转：如果扫描面塌成 0，上面那条"findings 为空"就会恒真。
    expect(files).toBeGreaterThan(100);
    // ⚠️ **这个下界是 10 而不是 `grep -c "@Optional()"` 的 17** —— 两者差在**注释**：
    //    那 17 处里有 6 处只是注释里提到 `@Optional()`（分别在 `init.provider.ts`、`isr.provider.ts`、
    //    `fullBackup.provider.ts` 的构造器注释里，以及 `health.controller.ts` 里解释这条缺陷的 3 行），
    //    **真正的构造参数是 11 处**（meta/pipeline/article×2/statsMaintenance/init/comment/isr/fullBackup/
    //    health/article.controller）。本守卫剥掉注释后数的正是那 11 处。
    //    ⚠️ 这里刻意**按符号名而不是行号**指路：行号必然漂移，而漂移后的行号看起来仍然像个引用、
    //    不会有任何守卫报红。
    //    🔴 顺带一个教训：**给"计数类"断言定下界时，不能直接拿 grep 的行数当权威值** ——
    //    注释里的提及会让它虚高，而"写一条注释"就会改变这个数（本轮就正好加了 2 行注释）。
    expect(params).toBeGreaterThanOrEqual(10);
    expect(params).toBeLessThanOrEqual(40);
    expect(Array.isArray(findings)).toBe(true);
    // 🔴 **尺子必须真的扫到 health 那个控制器**（它就是出过问题的文件）——
    //    否则"没有发现"可能只是"根本没扫到那里"。
    const health = scan(join(SRC_ROOT, 'controller', 'public'));
    expect(health.params).toBeGreaterThanOrEqual(1);
    expect(health.findings).toEqual([]);
  });

  it('🔴 尺子有效性：坏形状（@Optional + 类型专用导入）必须被抓到', () => {
    const synth = [
      TYPE_IMPORT + " { Widget } from './widget.provider';",
      'import { Other } from "./other.provider";',
      'export class C {',
      '  constructor(',
      '    private readonly a: Other,',
      '    @Optional() private readonly w?: Widget,',
      '  ) {}',
      '}',
    ].join('\n');
    const code = stripCommentsAndStrings(synth);
    const types = optionalParamTypes(code);
    expect(types).toContain('Widget');
    // 🔴 只钉 @Optional 的那个类型，不误伤只做类型用途的导入
    expect(types).not.toContain('Other');
    expect(typeImportedNames(code).has('Widget')).toBe(true);
    expect(typeImportedNames(code).has('Other')).toBe(false);
  });

  it('🔴 尺子有效性：好形状（@Optional + 值导入）不被误报', () => {
    const synth = [
      "import { Widget } from './widget.provider';",
      'export class C {',
      '  constructor(@Optional() private readonly w?: Widget) {}',
      '}',
    ].join('\n');
    const code = stripCommentsAndStrings(synth);
    expect(optionalParamTypes(code)).toContain('Widget');
    expect(typeImportedNames(code).has('Widget')).toBe(false);
  });

  it('尺子有效性：只做类型用途的类型专用导入（没有 @Optional）不算命中', () => {
    const synth = [
      TYPE_IMPORT + ' { Request, Response } from "express";',
      'export class C {',
      '  async h(req: Request, res: Response) { return 1; }',
      '}',
    ].join('\n');
    const code = stripCommentsAndStrings(synth);
    expect(optionalParamTypes(code)).toEqual([]);
    expect(typeImportedNames(code).has('Request')).toBe(true);
  });

  it('注释与字符串里出现同样字样不算命中（剥离器真的在工作）', () => {
    const synth = [
      '// ' + TYPE_IMPORT + ' { Widget } from "./w";',
      'const s = "' + TYPE_IMPORT + ' { Widget }";',
      "import { Widget } from './w';",
      'export class C { constructor(@Optional() private readonly w?: Widget) {} }',
    ].join('\n');
    const code = stripCommentsAndStrings(synth);
    expect(typeImportedNames(code).has('Widget')).toBe(false);
    expect(optionalParamTypes(code)).toContain('Widget');
    // 反空转：剥离确实发生了
    expect(code.length).toBeLessThan(synth.length);
  });
});
