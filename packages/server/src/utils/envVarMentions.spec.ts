/**
 * 守卫：**用户可见文案里提到的每一个环境变量名，都必须真的有人读。**
 *
 * ## 为什么需要这条
 *
 * 这是本仓库第二次踩同一类坑，两次的形状一模一样 —— 文案（或配置登记表）里写着一个
 * 环境变量名，而**没有任何代码读它**，于是用户照着做，什么也不会发生：
 *
 * 1. `VANBLOG_WATERMARK_FONT_MIN_PX` / `_MAX_PX`：登记在 `WATERMARK_ENV` 里、文档也写了，
 *    但渲染器用的是 `watermarkSvg.ts` 里的常量，那两个值从来没被读过（已删除）。
 * 2. `VANBLOG_CADDY_DATA_PATH`：整站恢复跳过 caddy 段时的提示叫用户"把它配上再恢复一次"。
 *    真实的名字是 `loadConfig('caddy.data.path')` 推导出的 **`VAN_BLOG_CADDY_DATA_PATH`**
 *    （差一个下划线），而且光有路径也没用 —— provider 的备份与恢复两处都是
 *    `backupIncludeCaddyEnabled() ? config.caddyDataPath : undefined`，
 *    `VANBLOG_BACKUP_INCLUDE_CADDY` 不开就永远是 undefined。
 *
 * 两次的共同点：**编译不报错、测试不报错、文档守卫也查不到**（`docs-consistency` 只查
 * "文档 → 代码"这个方向，而这次错的是代码自己的文案）。所以要有一条从"文案"指向"真实读取点"的钉子。
 *
 * ## 判据
 *
 * "提到"= 出现在 server 源码（非 spec）的**字符串字面量**里 —— 也就是会被人看到的地方
 * （notes / 日志 / 异常消息 / 后台返回的提示）。注释与标识符不算，所以先剥注释
 * （用 `src/test-utils/anchorCode` 的 `stripCommentsForAnchor`，它对字符串/模板/正则安全）。
 *
 * "真的有人读"= 在**非 spec** 的代码里出现下列任一形态：
 *   - `process.env.NAME` / `process.env['NAME']`
 *   - helper 的第一个参数：`envBool('NAME')` / `envFlag('NAME')` / `envPositiveInt('NAME', …)` 等
 *   - `loadConfig('a.b.c')` ⇒ 推导出的 `VAN_BLOG_A_B_C`（见 utils/loadConfig.ts 的拼接规则）
 *   - 脚本 / Dockerfile / compose / workflow 里的**读取位置**：`${NAME`、`$NAME`、`NAME=`、`- NAME`、
 *     `ENV NAME`、`ARG NAME`、`NAME:`
 *     （⚠️ 只认读取位置、不认整份文件里的任意出现，否则"只在注释里被提过"也会被当成真实存在）
 *
 * 语料是全仓库而不只是 server：提示里合法地提到脚本侧变量是常见的
 * （例如 `VANBLOG_SETUP_KEY_WAIT` 只有一键脚本读）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages', 'server', 'src');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.git',
  'coverage',
  '.turbo',
  '.tools',
  'vanblog_dev',
  '.vuepress',
]);

/** 环境变量名的形状：两种前缀都算（`VAN_BLOG_` 来自 loadConfig，`VANBLOG_` 是后来加的）。 */
const ENV_NAME = /\b(?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+\b/g;

/** JS/TS 的字符串字面量（单引号、双引号、反引号；允许转义）。
 *  ⚠️ 不用 `s`(dotAll) 标志：本包 tsconfig 的 target 低于 es2018，编译会报 TS1501；
 *  而这里的字符类（`[^'\\]` 等）本来就能匹配换行，不需要它。 */
const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    // ⚠️ 跳过**所有点目录**：`packages/admin/src/.umi` 与 `.umi-production` 里是 umi 生成的
    //    巨型 bundle，扫进去会让这个 spec 直接挂死（第一版就是这样，jest 跑满 5 分钟没出来）。
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) {
      // 生成物/锁文件之类的大文件对本检查没有意义，而且剥注释是 O(n)
      try {
        if (fs.statSync(full).size > 1_500_000) continue;
      } catch {
        continue;
      }
      yield full;
    }
  }
}

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};

/** 剥注释很贵（单遍扫描整份文件），而三趟都要用 ⇒ 缓存。 */
const strippedCache = new Map<string, string>();
const stripped = (f: string) => {
  let v = strippedCache.get(f);
  if (v === undefined) {
    v = stripCommentsForAnchor(read(f));
    strippedCache.set(f, v);
  }
  return v;
};

const isSpec = (f: string) => /\.spec\.ts$/.test(f) || /(^|\/)test-utils\//.test(f) || /(^|\/)tests?\//.test(f);

/** 从一段代码里挑出"字符串字面量内部"出现的环境变量名。 */
export function mentionedInStrings(code: string): Set<string> {
  const out = new Set<string>();
  const stripped = stripCommentsForAnchor(code);
  for (const lit of stripped.match(STRING_LITERAL) ?? []) {
    for (const m of lit.match(ENV_NAME) ?? []) out.add(m);
  }
  return out;
}

/** 一段代码/脚本里"真的被读取"的环境变量名。 */
export function readPositions(text: string): Set<string> {
  const out = new Set<string>();
  const push = (n: string | undefined) => {
    if (n) out.add(n);
  };
  // process.env.NAME / process.env['NAME'] / process.env["NAME"]
  for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g)) {
    push(m[1] ?? m[2]);
  }
  // helper 的第一个参数：envBool('X') / envFlag("X") / envPositiveInt(`X`, …)
  for (const m of text.matchAll(/\benv[A-Za-z]*\(\s*['"`]((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)['"`]/g)) push(m[1]);
  // loadConfig('a.b.c') ⇒ VAN_BLOG_A_B_C（utils/loadConfig.ts:36-41 的拼接规则）
  for (const m of text.matchAll(/\bloadConfig\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
    push('VAN_BLOG_' + m[1].split('.').map((x) => x.toUpperCase()).join('_'));
  }
  // 脚本 / Dockerfile / compose / workflow 里的读取位置
  for (const m of text.matchAll(/\$\{((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)/g)) push(m[1]);
  for (const m of text.matchAll(/\$((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)/g)) push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s"'`(;])((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)=(?!=)/gm)) push(m[1]);
  for (const m of text.matchAll(/^\s*-\s*((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)/gm)) push(m[1]);
  for (const m of text.matchAll(/^\s*(?:ENV|ARG)\s+((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)/gm)) push(m[1]);
  for (const m of text.matchAll(/^\s*((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)\s*:/gm)) push(m[1]);
  return out;
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const OTHER_EXT = new Set(['.sh', '.yml', '.yaml', '.json', '.bash']);

const CORPUS_ROOTS = () => [
  path.join(REPO_ROOT, 'packages', 'server', 'src'),
  path.join(REPO_ROOT, 'packages', 'website'),
  path.join(REPO_ROOT, 'packages', 'admin', 'src'),
  path.join(REPO_ROOT, 'packages', 'cli'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'docker-compose'),
  path.join(REPO_ROOT, '.github', 'workflows'),
  REPO_ROOT, // 只取根上的 Dockerfile / entrypoint.sh，靠下面的白名单过滤
];

const ROOT_FILES = new Set(['Dockerfile', 'entrypoint.sh']);

function corpusFiles(): string[] {
  const out: string[] = [];
  for (const r of CORPUS_ROOTS()) {
    for (const f of walk(r)) {
      const base = path.basename(f);
      const ext = path.extname(f);
      const isRootFile = path.dirname(f) === REPO_ROOT && ROOT_FILES.has(base);
      if (!isRootFile && !CODE_EXT.has(ext) && !OTHER_EXT.has(ext) && !/Dockerfile/.test(base)) continue;
      if (isSpec(f)) continue; // ⚠️ 只有测试读的变量不算"真实存在"
      out.push(f);
    }
  }
  return out;
}

/**
 * 收集"标识符（或成员表达式）→ 环境变量名"的映射。
 *
 * 本项目的名字**很少**直接写在读取点上，主流是三种间接形态，只认字面量会大批误报
 * （第一版就是这么把 20 多个真变量判成"没人读"的）：
 *   1. `export const SEARCH_INDEX_MAX_DOCS_ENV = 'VANBLOG_SEARCH_INDEX_MAX_DOCS';`
 *      → `positiveIntFromEnv(env, SEARCH_INDEX_MAX_DOCS_ENV, …)`
 *   2. `export const ENV_ADMIN_PASSWORD_FILE = 'VANBLOG_ADMIN_PASSWORD_FILE';`
 *      → `env[ENV_ADMIN_PASSWORD_FILE]`
 *   3. `export const WATERMARK_ENV = { style: 'VANBLOG_WATERMARK_STYLE', … } as const;`
 *      → `env[WATERMARK_ENV.style]` / `envFloatInRange(WATERMARK_ENV.scale, …)`
 */
function collectNameIdents(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    const text = stripped(f);
    // 形态 1/2：const IDENT = 'NAME'
    for (const m of text.matchAll(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"`]((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)['"`]/g,
    )) {
      map.set(m[1], m[2]);
    }
    // 形态 3：const OBJ = { key: 'NAME', … }  ⇒ 记成 OBJ.key
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{([^{}]*)\}/g)) {
      const obj = m[1];
      for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*['"`]((?:VAN_BLOG|VANBLOG)_[A-Z0-9_]+)['"`]/g)) {
        map.set(`${obj}.${p[1]}`, p[2]);
      }
    }
  }
  return map;
}

/** 标识符形态的读取点（第二趟，因为常量可能定义在别的文件里）。 */
function collectIdentReads(files: string[], nameByIdent: Map<string, string>): Set<string> {
  const real = new Set<string>();
  // ⚠️ 只允许**一层**成员访问（够覆盖 `WATERMARK_ENV.style`）：写成 (?:\.ident)* 会让
  //    外层 * 与内层 [\w$]* 形成嵌套量词，在大文件上回溯爆炸（第一版就是这么把 jest 挂死的）。
  const IDENT = '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)';
  const patterns = [
    // env[IDENT] / process.env[IDENT]
    new RegExp(`\\b(?:process\\.)?env\\[\\s*${IDENT}\\s*\\]`, 'g'),
    // helper(env, IDENT, …) —— 例如 positiveIntFromEnv(env, SEARCH_INDEX_MAX_DOCS_ENV, …)
    new RegExp(`\\b[A-Za-z_$][\\w$]*\\(\\s*(?:env|process\\.env)\\s*,\\s*${IDENT}`, 'g'),
    // 函数名里带 env/flag/bool/int/number/range 的调用，第一个实参就是名字
    //   envBool('X') / envFlag(X) / envFloatInRange(WATERMARK_ENV.scale, …) / envPositiveInt(X, …)
    // ⚠️ 前缀必须是 `[\w$]*`（可为空）而不是 `[A-Za-z_$][\w$]*`：后者要求 env 前面至少一个字符，
    //    于是 `positiveIntFromEnv(` 能匹配、而 `envPositiveInt(` / `envBool(` 匹配不上
    //    （VANBLOG_ISR_REAP_INTERVAL_MS 就是这么被误报成"没人读"的）。
    new RegExp(`\\b[\\w$]*(?:[Ee]nv|ENV)[\\w$]*\\(\\s*${IDENT}`, 'g'),
    new RegExp(`\\b[\\w$]*(?:FromEnv|InRange|Flag|Bool)[\\w$]*\\(\\s*${IDENT}`, 'g'),
  ];
  for (const f of files) {
    const text = stripped(f);
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const n = nameByIdent.get(m[1]);
        if (n) real.add(n);
      }
    }
  }
  return real;
}

function collectRealNames(): Set<string> {
  const real = new Set<string>();
  const files = corpusFiles();

  // 第一趟：字面量形态的读取点（process.env.NAME、envBool('NAME')、脚本里的 ${NAME}、
  // loadConfig('a.b.c') 推导出的 VAN_BLOG_A_B_C、Dockerfile/compose 的声明等）
  for (const f of files) {
    for (const n of readPositions(read(f))) real.add(n);
  }
  // 第二、三趟：间接形态（见 collectNameIdents 的注释）
  const nameByIdent = collectNameIdents(files);
  for (const n of collectIdentReads(files, nameByIdent)) real.add(n);
  return real;
}

function collectMentions(): { name: string; file: string; line: number }[] {
  const out: { name: string; file: string; line: number }[] = [];
  // ⚠️ 不止 server：后台表单的 tooltip 与前台文案里也会写环境变量名
  //    （`WaterMarkForm` 写着 VANBLOG_WATERMARK_STYLE / _POSITION，`InstallRecordBanner` 写着
  //    VANBLOG_ADMIN_USER）。这些地方打错一个字母，用户照着设了不会有任何效果，
  //    而**编译、单测、文档守卫都发现不了** —— 与本文件顶部记的两个事故同一类。
  //    "真有人读"的语料本来就是全仓库的，所以跨包扫描不会带来误报。
  const scanRoots = [
    SERVER_SRC,
    path.join(REPO_ROOT, 'packages', 'admin', 'src'),
    path.join(REPO_ROOT, 'packages', 'website'),
  ];
  const seen = new Set<string>();
  for (const root of scanRoots) {
    for (const f of walk(root)) {
      if (!CODE_EXT.has(path.extname(f)) || isSpec(f) || seen.has(f)) continue;
      seen.add(f);
      const text = stripped(f);
      const names = mentionedInStrings(text);
      if (names.size === 0) continue;
      const lines = text.split('\n');
      for (const name of names) {
        // 报第一处出现的行号，方便定位（可能命中同名的注释行，按名字搜即可）
        const idx = lines.findIndex((l) => l.includes(name));
        out.push({ name, file: path.relative(REPO_ROOT, f), line: idx + 1 });
      }
    }
  }
  return out;
}

describe('用户可见文案里提到的环境变量名都必须真有人读', () => {
  const real = collectRealNames();
  const mentions = collectMentions();

  it('扫描本身没空转（真的扫到了文件与名字，且三个包都覆盖到）', () => {
    // ⚠️ 空转的守卫比没有守卫更糟：本仓库有过 heredoc 参数写错位置导致 python 直接 IndexError、
    //    stdout 为空、于是"检查通过"的先例（docs-consistency 的裸尖括号那条）。
    expect(real.size).toBeGreaterThan(80);
    expect(mentions.length).toBeGreaterThan(20);
    // 跨包覆盖也要钉住：实测 server 字符串里提到 74 个不同变量名、admin 7 个、website 8 个。
    // 如果哪天 walk 的跳过规则（点目录、体积上限）把 admin 的 `.umi` 之外的东西也一起跳了，
    // 这条会红 —— 否则守卫会悄悄退回"只扫 server"，而没人会发现。
    for (const pkg of ['packages/server/src', 'packages/admin/src', 'packages/website']) {
      const hit = mentions.filter((m) => m.file.startsWith(pkg));
      expect(hit.length).toBeGreaterThan(0);
    }
  });

  it('每一个被提到的名字都能在代码里找到读取点', () => {
    const unknown = mentions.filter((m) => !real.has(m.name));
    expect(
      unknown.map((u) => `${u.name}（${u.file}:${u.line}）`),
    ).toEqual([]);
  });

  it('回归钉子：恢复提示里的 caddy 变量名是真的（曾经差一个下划线）', () => {
    const src = read(path.join(SERVER_SRC, 'utils', 'fullBackup.ts'));
    const said = mentionedInStrings(src);
    // 真实存在的两个旋钮
    expect(said.has('VANBLOG_BACKUP_INCLUDE_CADDY')).toBe(true);
    expect(said.has('VAN_BLOG_CADDY_DATA_PATH')).toBe(true);
    expect(real.has('VANBLOG_BACKUP_INCLUDE_CADDY')).toBe(true);
    expect(real.has('VAN_BLOG_CADDY_DATA_PATH')).toBe(true);
    // 那个没人读的名字不许回来（⚠️ 断言前先剥注释：本文件里就有解释这件事的注释，
    //    而注释里必然写着这个错名字 —— 本仓库已经六次踩到"断言匹配到解释性注释"）
    const stringsOnly = [...mentionedInStrings(src)].join(' ');
    expect(stringsOnly).not.toContain('VANBLOG_CADDY_DATA_PATH');
  });

  it('负向对照：编造的名字一定会被抓到（证明这条检查不是空的）', () => {
    const fake = `notes.push('请把 VANBLOG_TOTALLY_MADE_UP_KNOB=true 配上再试一次');`;
    const said = mentionedInStrings(fake);
    expect(said.has('VANBLOG_TOTALLY_MADE_UP_KNOB')).toBe(true);
    expect(real.has('VANBLOG_TOTALLY_MADE_UP_KNOB')).toBe(false);
  });

  it('负向对照：只在注释里出现的名字不算"被提到"（否则守卫会被注释喂饱而失效）', () => {
    const commented = `// 设 VANBLOG_TOTALLY_MADE_UP_KNOB=true 即可\nconst a = 1;`;
    expect(mentionedInStrings(commented).has('VANBLOG_TOTALLY_MADE_UP_KNOB')).toBe(false);
  });

  it('负向对照：只被测试读的变量不算"真实存在"', () => {
    // readPositions 本身能认出读取形态，但 collectRealNames 跳过了 spec 文件
    expect(readPositions(`process.env.VANBLOG_ONLY_IN_SPECS`).has('VANBLOG_ONLY_IN_SPECS')).toBe(true);
    expect(real.has('VANBLOG_ONLY_IN_SPECS')).toBe(false);
  });
});
