/**
 * 守卫：每一条 `/api/admin/**` 的路由方法都必须被鉴权守卫覆盖。
 *
 * 为什么需要它：本仓库的 `AdminGuard` **不是一个 guard 类**（`grep -rn "class AdminGuard"` 零命中），
 * 而是 `provider/auth/auth.guard.ts` 里导出的一个**常量数组** `[AuthGuard('jwt'), TokenGuard, AccessGuard]`，
 * 管理端路由靠在 `@UseGuards(...AdminGuard)` 里引用它来获得鉴权。
 * 🔴 这意味着"忘记挂守卫"是一种**静默**的失败：新增一个管理端控制器或方法时漏写 `@UseGuards`，
 * 什么都不会红，而那条路由就是**未认证可达**的。本仓库历史上已经出过一次未认证的管理员接管，
 * 所以这条性质值得一份穷举式的守卫，而不是"逐处发现"。
 *
 * 口径：用 TypeScript 的 compiler API 解析（不是正则），因为装饰器与方法的归属关系用正则很容易错。
 * ⚠️ 一个实测踩过的坑：TS 5.x 的 `Decorator.expression` **不含前导的 at 符号**，
 * 所以匹配装饰器名时必须自己补上，否则所有断言都会因为"零命中"而恒真。
 *
 * Nest 的守卫可以挂在三个层级：方法（`@UseGuards`）、控制器类（类上的 `@UseGuards`）、以及全局
 * （通过 `APP_GUARD` provider）。本守卫三层都查：类级与方法级从装饰器读出，
 * 全局级则**断言它当前不存在** —— 如果将来有人加了全局守卫，这条断言会红，
 * 迫使他来更新这里（而不是让本守卫在"其实有全局守卫"的前提下继续按无全局守卫判定）。
 */
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../..');
const ADMIN_PREFIX = '/api/admin';
const HTTP_VERBS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'All', 'Head', 'Options'];

interface RouteRow {
  file: string;
  line: number;
  cls: string;
  methodName: string;
  verb: string;
  route: string;
  classGuards: string[];
  methodGuards: string[];
}

/** 剥掉注释与字符串字面量，但保留换行（这样行号仍然可用）。 */
function maskCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const c2 = code.substr(i, 2);
    if (c2 === '//' || c2 === '/*') {
      const isLine = c2 === '//';
      out += '  ';
      i += 2;
      while (i < n) {
        if (isLine) {
          if (code[i] === '\n') break;
        } else if (code.substr(i, 2) === '*/') {
          out += '  ';
          i += 2;
          break;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += ' ';
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (code[i] === c) {
          out += ' ';
          i += 1;
          break;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(p, acc);
    } else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function joinRoute(prefix: string, sub: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = sub.replace(/^\/+/, '');
  const full = b.length ? a + '/' + b : a || '/';
  return full.replace(/\/{2,}/g, '/');
}

/**
 * 解析一个源文件，返回它里面所有带 HTTP 方法装饰器的路由。
 * 抽成独立函数是为了能做尺子有效性反证：喂一段合成源码，看它是否如实报告"没有守卫"。
 */
function parseRoutes(absFile: string, source?: string): RouteRow[] {
  const rel = path.relative(SRC, absFile);
  const src = source !== undefined ? source : fs.readFileSync(absFile, 'utf8');
  const sf = ts.createSourceFile(absFile, src, ts.ScriptTarget.Latest, true);
  const decoText = (d: any): string => {
    const inner = d && d.expression && d.expression.getText ? d.expression.getText(sf) : '';
    // 🔴 TS 5.x 的 Decorator.expression 不含前导 at 符号，必须自己补，否则永不匹配。
    return '@' + inner;
  };
  const rows: RouteRow[] = [];
  ts.forEachChild(sf, (node: any) => {
    if (!ts.isClassDeclaration(node)) return;
    const cls = node.name ? node.name.text : '(anonymous)';
    let prefix = '';
    const classGuards: string[] = [];
    const classDecos = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
    for (const d of classDecos) {
      const t = decoText(d).replace(/\s+/g, ' ');
      const m = t.match(/@Controller\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?/);
      if (m) prefix = m[1] || m[2] || m[3] || '';
      if (/@UseGuards/.test(t)) classGuards.push(t.slice(0, 200));
    }
    for (const mem of node.members) {
      if (!ts.isMethodDeclaration(mem)) continue;
      const memDecos = ts.canHaveDecorators(mem) ? ts.getDecorators(mem) || [] : [];
      let http: { verb: string; arg: string } | null = null;
      const methodGuards: string[] = [];
      for (const d of memDecos) {
        const t = decoText(d).replace(/\s+/g, ' ');
        const hm = t.match(new RegExp('^@(' + HTTP_VERBS.join('|') + ')\\s*\\(([^)]*)\\)?'));
        if (hm) {
          http = { verb: hm[1].toUpperCase(), arg: (hm[2] || '').trim() };
        }
        if (/@UseGuards/.test(t)) methodGuards.push(t.slice(0, 200));
      }
      if (!http) continue;
      const sub = (http as { arg: string }).arg.replace(/^['"`]/, '').replace(/['"`]$/, '');
      const name = mem.name && mem.name.getText ? mem.name.getText(sf) : '?';
      const line = sf.getLineAndCharacterOfPosition(mem.getStart(sf)).line + 1;
      rows.push({
        file: rel,
        line,
        cls,
        methodName: name,
        verb: (http as { verb: string }).verb,
        route: joinRoute(prefix, sub),
        classGuards,
        methodGuards,
      });
    }
  });
  return rows;
}

function allRoutes(): RouteRow[] {
  const out: RouteRow[] = [];
  for (const f of walkTs(SRC)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/@Controller\s*\(/.test(src)) continue;
    for (const r of parseRoutes(f, src)) out.push(r);
  }
  return out;
}

/**
 * 白名单：**故意**不挂 `@UseGuards` 的管理端路由。
 *
 * 🔴 每一条都读过代码确认它确实是故意的，并且有别的机制保护 —— 不是"没人注意到"。
 * `anchor` 必须在该文件当前内容里逐字存在（防腐机制）：文件被改动后锚点失配就会红，
 * 逼人确认"这处还是原来那处吗、豁免理由还成立吗"。
 */
const WHITELIST: Array<{ verb: string; route: string; file: string; anchor: string; reason: string }> = [
  {
    verb: 'POST',
    route: '/api/admin/auth/restore',
    file: 'controller/admin/auth/auth.controller.ts',
    anchor: 'bruteForceClientIp(request)',
    reason:
      '匿名且故意如此：这是恢复密钥流程（忘记管理员口令），成功一次就改写管理员的用户名与口令。' +
      '保护机制是专用的爆破计数桶（与 init 同档：5 次 / 10 分钟 / IP，用套接字地址而不是可信代理头计数，' +
      '因为防爆破计数的收益正是换一个 key 就重新开始），且恢复密钥是 32 字节随机、爆破不可行。' +
      '挂 JWT 守卫会让这条流程在拿不到凭证时完全不可用。',
  },
  {
    verb: 'GET',
    route: '/api/admin/caddy/ask',
    file: 'controller/admin/caddy/caddy.controller.ts',
    anchor: '拒绝为未登记的域名签发证书',
    reason:
      '必须无鉴权：这是 caddy 的 on_demand_tls 回调，是 caddy 自己来问的，不可能带本站的 JWT。' +
      '旧逻辑「只要不是 IPv4 就批准」是一个真漏洞（任何人都能把任意域名解析到这台机器让本站去申请证书，' +
      '耗掉 ACME 速率限制、还能拿去做钓鱼站），现在只放行本站自己的域名（siteInfo.baseUrl、' +
      'https 设置里的域名、caddy 已登记的 subjects），需要放开时显式设 VANBLOG_CADDY_ASK_ALLOW_ALL=true。',
  },
  {
    verb: 'POST',
    route: '/api/admin/init',
    file: 'controller/admin/init/init.controller.ts',
    anchor: "@Body('setupKey')",
    reason:
      '初始化之前站点还没有任何账号，JWT 鉴权在逻辑上不可能成立，所以这条必须匿名。' +
      '保护机制是 body 里的 setupKey 校验（开启时校验，值打错按开处理并 WARN），' +
      '以及"已初始化就拒绝"的判定；限流侧另有 /api/admin/init 前缀的 5 次 / 10 分钟 / IP 专用档。',
  },
  {
    verb: 'POST',
    route: '/api/admin/init/upload',
    file: 'controller/admin/init/init.controller.ts',
    anchor: "throw new HttpException('已初始化', 500)",
    reason:
      '初始化向导里的图片上传，同样发生在有账号之前，所以必须匿名。' +
      '保护机制是"已初始化就抛错拒绝"（避免初始化完成后这条匿名上传口仍然开着），' +
      '以及 init 前缀那个 5 次 / 10 分钟 / IP 的限流档。',
  },
  {
    verb: 'POST',
    route: '/api/admin/init/restore',
    file: 'controller/admin/init/init.controller.ts',
    anchor: 'RESTORE_UPLOAD_OPTIONS',
    reason:
      '从初始化页面做整站恢复，发生在有账号之前，所以必须匿名。' +
      '保护机制是 multipart 文本字段里的 setupKey、上传选项的字段与体积限额、' +
      '以及 init 前缀那个 5 次 / 10 分钟 / IP 的限流档；失败时不会留下"半恢复却被当成已初始化"的状态。',
  },
];

describe('管理端路由的鉴权覆盖：每一条 /api/admin/** 都必须挂守卫，否则必须进带理由的白名单', () => {
  const routes = allRoutes();
  const adminRoutes = routes.filter((r) => r.route.startsWith(ADMIN_PREFIX));
  const covered = adminRoutes.filter((r) => r.classGuards.length > 0 || r.methodGuards.length > 0);
  const bare = adminRoutes.filter((r) => !r.classGuards.length && !r.methodGuards.length);

  it('反空转：确实枚举到了路由，而不是扫到 0 条然后恒真通过', () => {
    // 🔴 如果解析口径坏了（例如装饰器名匹配不上），这里会先红，
    //    而不是让"未覆盖清单为空"这条断言变成一个空的绿。
    expect(routes.length).toBeGreaterThan(150);
    expect(adminRoutes.length).toBeGreaterThan(120);
    expect(covered.length).toBeGreaterThan(120);
    // 类级守卫与控制器的数量级也要对得上：绝大多数管理端控制器是在类上挂守卫的。
    const filesWithClassGuard = new Set(
      adminRoutes.filter((r) => r.classGuards.length > 0).map((r) => r.file),
    );
    expect(filesWithClassGuard.size).toBeGreaterThan(20);
  });

  it('尺子有效性：解析器能如实报告一段没有守卫的合成控制器', () => {
    // 🔴 这条证明"检测到守卫"与"检测到没有守卫"两种结果都可区分，
    //    否则上面的 covered/bare 划分可能是恒真的。
    const synthetic = [
      "import { Controller, Get, Post, UseGuards } from '@nestjs/common';",
      "@Controller('/api/admin/probe')",
      'export class ProbeController {',
      "  @Get('/bare')",
      '  bare() { return 1; }',
      '',
      '  @UseGuards()',
      "  @Post('/guarded')",
      '  guarded() { return 2; }',
      '}',
      '',
    ].join('\n');
    const rows = parseRoutes('/synthetic/probe.controller.ts', synthetic);
    expect(rows.length).toBe(2);
    const bareRow = rows.find((r) => r.methodName === 'bare');
    const guardedRow = rows.find((r) => r.methodName === 'guarded');
    expect(bareRow).toBeDefined();
    expect(guardedRow).toBeDefined();
    expect((bareRow as RouteRow).classGuards.length).toBe(0);
    expect((bareRow as RouteRow).methodGuards.length).toBe(0);
    expect((guardedRow as RouteRow).methodGuards.length).toBe(1);
    expect((bareRow as RouteRow).route).toBe('/api/admin/probe/bare');
  });

  it('尺子有效性：类级守卫也算覆盖（否则会把 25 个控制器全部误报成裸路由）', () => {
    const synthetic = [
      "import { Controller, Get, UseGuards } from '@nestjs/common';",
      'const AdminGuard = [];',
      '@UseGuards(...AdminGuard)',
      "@Controller('/api/admin/probe2')",
      'export class Probe2Controller {',
      "  @Get('/x')",
      '  x() { return 1; }',
      '}',
      '',
    ].join('\n');
    const rows = parseRoutes('/synthetic/probe2.controller.ts', synthetic);
    expect(rows.length).toBe(1);
    expect(rows[0].classGuards.length).toBe(1);
    expect(rows[0].methodGuards.length).toBe(0);
  });

  it('不存在全局守卫 provider：若将来改用全局守卫，必须来这里更新判定', () => {
    // ⚠️ 本守卫按"没有全局守卫"来判定覆盖。如果哪天引入了全局守卫，
    //    "裸路由"这个结论就不再成立，所以必须让这条断言红、逼人显式处理。
    const offenders: string[] = [];
    for (const f of walkTs(SRC)) {
      const masked = maskCommentsAndStrings(fs.readFileSync(f, 'utf8'));
      if (/APP_GUARD/.test(masked)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('核心：每一条 /api/admin/** 路由要么挂了守卫，要么在白名单里（白名单必须带足够具体的理由）', () => {
    const uncovered: string[] = [];
    const usedWhitelistEntries = new Set<number>();
    for (const r of bare) {
      const idx = WHITELIST.findIndex((w) => w.verb === r.verb && w.route === r.route);
      if (idx < 0) {
        uncovered.push(r.verb + ' ' + r.route + '  [' + r.file + ':' + r.line + '] ' + r.cls + '.' + r.methodName);
      } else {
        usedWhitelistEntries.add(idx);
      }
    }
    // 🔴 这是本守卫的核心断言：新增管理端路由却忘了挂守卫，会在这里被点名（含文件与行号）。
    expect(uncovered).toEqual([]);

    // 白名单不许有死条目：每条都必须真的被某条裸路由用到，
    // 否则白名单会随时间堆积成一份没人复核的豁免清单。
    const dead = WHITELIST.map((w, i) => ({ w, i })).filter((e) => !usedWhitelistEntries.has(e.i));
    expect(dead.map((d) => d.w.verb + ' ' + d.w.route)).toEqual([]);

    // 理由必须足够具体：一句话的豁免等于没有豁免。
    for (const w of WHITELIST) {
      expect(w.reason.length).toBeGreaterThan(60);
    }
  });

  it('防腐：白名单每一条的锚点都必须在对应文件的当前内容里逐字存在', () => {
    const stale: string[] = [];
    for (const w of WHITELIST) {
      const abs = path.join(SRC, w.file);
      if (!fs.existsSync(abs)) {
        stale.push('文件不存在: ' + w.file);
        continue;
      }
      const src = fs.readFileSync(abs, 'utf8');
      if (!src.includes(w.anchor)) {
        stale.push(w.verb + ' ' + w.route + ' 的锚点在 ' + w.file + ' 里已不存在');
      }
    }
    // 🔴 锚点失配说明那处代码已经变了 ⇒ 豁免理由可能不再成立，必须有人来复核。
    expect(stale).toEqual([]);
  });

  it('白名单恰好是这 5 条：豁免面不许悄悄扩大', () => {
    expect(WHITELIST.length).toBe(5);
    // 已挂守卫的路由必须是绝大多数：158 条里只允许 5 条豁免。
    expect(bare.length).toBe(WHITELIST.length);
    expect(covered.length).toBe(adminRoutes.length - WHITELIST.length);
  });

  it('挂守卫的路由只用这三种被复核过的形状（出现第四种就说明有人自己发明了一套鉴权口径）', () => {
    // 🔴 显式枚举而不是"数量不超过 N"：一个松散的界会随着新形状被悄悄加进来而失去意义，
    //    而枚举出来的清单逼人来更新这里、并说明新形状为什么是安全的。
    // 三种形状分别是：① 绝大多数管理端控制器在类上展开 AdminGuard；
    //    ② login 用本地策略（它本身就是认证入口，不可能要求已认证）；
    //    ③ logout 只需要 TokenGuard（它要做的是吊销手里这个 token）。
    const ALLOWED = [
      '@UseGuards(...AdminGuard)',
      "@UseGuards(LoginGuard, AuthGuard('local'))",
      '@UseGuards(TokenGuard)',
    ];
    const shapes = new Map<string, number>();
    for (const r of covered) {
      const g = (r.methodGuards[0] || r.classGuards[0] || '').replace(/\s+/g, ' ');
      shapes.set(g, (shapes.get(g) || 0) + 1);
    }
    const distinct = Array.from(shapes.keys()).sort();
    const unexpected = distinct.filter((s) => ALLOWED.indexOf(s) < 0);
    expect({ unexpected }).toEqual({ unexpected: [] });
    // 反方向也要钉住：三种被允许的形状都必须真的出现过，
    // 否则"清单里的某一种已经没人用了"这件事会被静默放过。
    const missing = ALLOWED.filter((a) => !shapes.has(a));
    expect({ missing }).toEqual({ missing: [] });
    // 绝大多数必须是 AdminGuard（login 与 logout 是仅有的两个例外）。
    const adminGuardCount = Array.from(shapes.entries())
      .filter(([k]) => /AdminGuard/.test(k))
      .reduce((a, [, v]) => a + v, 0);
    expect(adminGuardCount).toBeGreaterThan(140);
  });
});
