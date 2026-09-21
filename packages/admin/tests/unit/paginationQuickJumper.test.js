// ---------------------------------------------------------------------------
// 防漂移守卫：后台**每一处**分页都必须提供"输入页码跳转"
//
// 为什么要有它（2026-09-21，站长要求）：站长要求"所有可以点『下一页』的地方都要提供
// 『输入页码跳转』的功能"，特别是文章管理与图片管理。antd 4 的实现是 `showQuickJumper`
// （`Pagination.d.ts` 里是 `showQuickJumper?: boolean | { goButton }`）。
// 当时一次性给 **18 处**加上了它。但本仓库反复出现同一个失败模式：
// **同一个判断散落在很多处，然后悄悄漂移** —— 新增一个带分页的页面时忘了加，
// 没有任何测试会红，站长要的功能就在新页面上消失了。
// 所以这条守卫的意义**不是**证明"今天 18 处都有"，而是**让将来漏加的那一处立刻变红**。
//
// 🔴 关于 `simple` 模式的一条实测语义（写在代码里，避免下一个人误判）：
// rc-pagination 3.2.0 的 `Pagination.js` 在 `if (simple) { … return … }` 里**提前返回**，
// 那个分支自己就渲染了一个 `<input type="text" value={currentInputValue}>`（带
// handleKeyDown/handleKeyUp/handleBlur）⇒ **simple 模式本来就支持输入页码跳转**，
// 而 `showQuickJumper` 由 `Options` 渲染、在 simple 分支里**根本不会执行**（惰性属性）。
// 本仓库有 5 处是 `simple: true`、2 处是 `simple: simplePage`（默认 false、用户可切换）。
// ⇒ 仍然**统一要求写 `showQuickJumper`**：①统一形状便于扫描与审查；
// ②如果将来有人把 `simple: true` 改成 `false`（例如想显示完整分页器），
//   跳转能力**不会**因此静默消失。
// 另外 `shouldDisplayQuickJumper()` 在 `total <= pageSize`（只有一页）时返回 false ⇒
// **单页不显示跳转框是 antd 的正确行为**，不是漏加；同理 `hideOnSinglePage: true` 的那几处
// 在只有一页时整个分页器都不显示，也是正确的（不要为了让它总显示而去掉 hideOnSinglePage）。
// 超范围页码由 rc-pagination 的 `handleChange` **夹取到边界**（`page > currentPage` 时取
// currentPage），不是忽略。
// ---------------------------------------------------------------------------
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '../../src');
const EXTS = new Set(['.jsx', '.tsx', '.js', '.ts']);
// ⚠️ 必须排除 umi 的构建缓存目录：`src/.umi/**` 里是 antd/rc-pagination **自己的源码**，
// 父代理第一次 grep `showQuickJumper` 时命中的全在那里 —— 数进来会让守卫既假绿又假红。
const SKIP_DIRS = new Set(['.umi', '.umi-production', 'node_modules']);

/**
 * 剥掉注释与字符串字面量的内容，但**保留位置**（换成空格），这样后续既能按行号报告，
 * 又不会被注释/字符串里的 `pagination=` 或 `showQuickJumper` 误导。
 *
 * 🔴 为什么用单趟字符扫描而不是"先 replace 块注释再 replace 行注释"：
 * 后者在本仓库已经吃过两次亏 —— ①行注释里含 `/*`（例如写了一个 glob `src/**`）时，
 * "先剥块注释"会把**真实代码**一起吃掉；②在块注释里写了块注释终止符的字面量时，
 * 注释会提前结束、把下面的代码变成语法错。单趟扫描按状态机走，不存在顺序问题。
 */
function maskCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && d === '/') {
        out += '  ';
        i += 2;
        state = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        out += '  ';
        i += 2;
        state = 'block';
        continue;
      }
      if (c === "'") {
        out += ' ';
        i += 1;
        state = 'sq';
        continue;
      }
      if (c === '"') {
        out += ' ';
        i += 1;
        state = 'dq';
        continue;
      }
      if (c === '`') {
        out += ' ';
        i += 1;
        state = 'tpl';
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        out += '\n';
        i += 1;
        state = 'code';
        continue;
      }
      out += ' ';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        out += '  ';
        i += 2;
        state = 'code';
        continue;
      }
      // 保留换行，行号才准
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // 字符串与模板串：整体抹掉（保留换行以维持行号）
    if (c === '\\') {
      out += '  ';
      i += 2;
      continue;
    }
    const endChar = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === endChar) {
      out += ' ';
      i += 1;
      state = 'code';
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

/** 从 `start`（指向 `{`）开始按括号配平取出对象体，返回 { text, end }；不平衡返回 null。 */
function balancedFrom(masked, start) {
  if (masked[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: masked.slice(start, i + 1), end: i };
    }
  }
  return null;
}

/**
 * 扫出一段源码里所有"分页落点"。
 * 返回 [{ line, kind, hasQuickJumper, snippet }]
 *   kind: 'object'  pagination={{…}} / pagination={…}
 *         'false'   pagination={false}（没有分页器 ⇒ 白名单）
 *         'jsx'     <Pagination …>（直接用组件）
 *         'opaque'  pagination={某个标识符/表达式}（静态看不出内容 ⇒ 必须显式白名单）
 */
function findPaginationSites(rawSrc) {
  const masked = maskCommentsAndStrings(rawSrc);
  const sites = [];
  const lineOf = (idx) => masked.slice(0, idx).split('\n').length;

  // A) pagination={…}
  const re = /pagination\s*=\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const braceIdx = m.index + m[0].length - 1; // 指向 `={` 的 `{`
    const bal = balancedFrom(masked, braceIdx);
    if (!bal) {
      sites.push({
        line: lineOf(m.index),
        kind: 'opaque',
        hasQuickJumper: false,
        snippet: 'UNBALANCED',
      });
      continue;
    }
    const inner = bal.text.slice(1, -1).trim();
    if (inner === 'false') {
      sites.push({
        line: lineOf(m.index),
        kind: 'false',
        hasQuickJumper: false,
        snippet: 'pagination={false}',
      });
    } else if (inner.startsWith('{')) {
      // pagination={{ … }}：在**配平取出的对象体**里找，而不是"往后 N 行里找"
      // —— 后者会漏掉跨行写法（本仓库多次栽在跨行锚点上），也会误吃到下一个组件的属性。
      const obj = balancedFrom(masked, braceIdx + inner.indexOf('{') + 1 - 1 + 1 - 1);
      const body = obj ? obj.text : inner;
      sites.push({
        line: lineOf(m.index),
        kind: 'object',
        hasQuickJumper: /showQuickJumper\s*:/.test(body),
        snippet: body.replace(/\s+/g, ' ').slice(0, 120),
      });
    } else {
      sites.push({
        line: lineOf(m.index),
        kind: 'opaque',
        hasQuickJumper: /showQuickJumper\s*:/.test(inner),
        snippet: inner.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
    re.lastIndex = bal.end + 1;
  }

  // B) <Pagination …>（直接用组件；属性写法是 showQuickJumper 或 showQuickJumper={…}）
  const reJsx = /<Pagination[\s>/]/g;
  while ((m = reJsx.exec(masked)) !== null) {
    // 取到该 JSX 元素的自闭合 `/>` 或开标签 `>` 为止（按括号/尖括号配平足够，因为属性里不会有裸 >）
    let end = -1;
    let depth = 0;
    for (let i = m.index + 1; i < masked.length; i += 1) {
      const c = masked[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    const attrs = end === -1 ? masked.slice(m.index, m.index + 600) : masked.slice(m.index, end + 1);
    sites.push({
      line: lineOf(m.index),
      kind: 'jsx',
      hasQuickJumper: /showQuickJumper(\s*=|\s|\/|>)/.test(attrs),
      snippet: attrs.replace(/\s+/g, ' ').slice(0, 120),
    });
    reJsx.lastIndex = end === -1 ? m.index + 11 : end + 1;
  }

  // 🔴 按行号排序后再返回。上面两个循环是"先收完所有 pagination={…}，再收所有 <Pagination>"，
  // 所以原始顺序**不是**源码顺序（实测 sites[2] 是 pagination={false} 而不是第 12 行的 <Pagination>）。
  // 排序不影响判定，但影响两件要紧的事：①失败信息里"第几处不合规"能与文件对得上；
  // ②按索引写的断言不会在将来新增一种落点形状时集体错位。
  // ⚠️ 用稳定排序语义：同行的两处（理论上可能）保持插入顺序。
  return sites
    .map((site, idx) => ({ site, idx }))
    .sort((a, b) => a.site.line - b.site.line || a.idx - b.idx)
    .map((x) => x.site);
}

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (EXTS.has(path.extname(name))) acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 显式白名单：`pagination={false}` 的三处 —— 它们**根本没有分页器**，所以谈不上"页码跳转"。
// ⚠️ 每条都必须写清"为什么是 false"，否则白名单会变成"看不见的例外"堆积处。
// ⚠️ 键是 `相对 src 的路径:行号`，行号变了守卫会红 —— 这是**故意的**：
//    它逼人确认"这处还是原来那处吗"，而不是让白名单悄悄跟着代码漂移。
// ---------------------------------------------------------------------------
const FALSE_WHITELIST = {
  // 主题列表：主题数量是个位数（内置几套 + 用户自己上传的），一次渲染全部比翻页更好用。
  'pages/SystemConfig/tabs/Theme.jsx:241':
    '主题列表，条目数量个位数，前端全量渲染，不需要分页',
  // 图片管理的**列表（表格）视图**：它不是"不分页"，而是分页交给了页面底部那个
  // 共用的 <Pagination>（在 listMode 三元之外，两种视图共用同一份 page/pageSize/total）。
  // ⚠️ 所以这一处**已经有**页码跳转（底部那个 Pagination 带 showQuickJumper），
  // 千万别"为了修守卫"给它再加一套分页器 —— 那会出现两个互相打架的分页控件。
  'pages/Static/img/index.tsx:660':
    '图片列表(表格视图)的分页由页面底部共用的 <Pagination> 负责（已带 showQuickJumper），此处再加一套会出现两个打架的分页器',
  // 分类管理：分类是树形/少量数据，前端全量渲染。
  'pages/DataManage/tabs/Category.jsx:342':
    '分类列表，条目少且需要一次看全（便于排序/展开），前端全量渲染',
};

// `pagination={标识符}` 这类静态看不出内容的写法，必须在这里显式登记并说明为什么可以放行。
const OPAQUE_WHITELIST = {};

describe('admin pagination quick jumper (站长要求：所有能翻页的地方都能输入页码跳转)', () => {
  const files = walk(SRC, []);
  const all = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    for (const s of findPaginationSites(readFileSync(f, 'utf8'))) {
      all.push({ ...s, rel });
    }
  }

  it('尺子有效性①：确实扫到了文件，且扫到的落点数不少于已知规模', () => {
    // 🔴 反空转：如果 walker 坏了（例如误把整个 src 当成 SKIP_DIRS、或扩展名集合写错），
    // 落点数会变成 0，而"每一处都合规"在 0 处时**恒真** ⇒ 守卫假绿。
    assert.ok(files.length > 100, `只扫到 ${files.length} 个源文件，walker 可能坏了`);
    assert.ok(
      all.length >= 21,
      `只扫到 ${all.length} 个分页落点（已知 20 处 pagination= + 1 处 <Pagination>），扫描器可能漏了形状`,
    );
  });

  it('尺子有效性②：没有把 umi 构建缓存数进来（那里是 antd 自己的源码）', () => {
    assert.equal(
      all.filter((s) => s.rel.startsWith('.umi')).length,
      0,
      '扫到了 src/.umi/** —— 那是 antd/rc-pagination 的源码，不是我们的代码',
    );

    // ---------------------------------------------------------------------
    // 🔴 (A) 合成正对照：**永远执行**，不依赖任何 git-ignored 的构建缓存。
    //
    // 为什么需要它（2026-09-21）：原来这里的正对照是直接 `statSync(path.join(SRC,'.umi'))`，
    // 而 `src/.umi` 是 umi 的构建缓存、**被 git-ignored** ⇒ 在**干净 checkout（CI）上必然 ENOENT**，
    // `statSync` 对缺失路径是**抛异常**而不是返回（那个 `if (…isDirectory())` 本意是保护，
    // 但抛发生在 `if` 求值之前）⇒ 整条用例在 CI 上 3 秒就红，而本机因为缓存存在所以绿。
    // 这就是"本机全绿、CI 长期红"的成因之一（由 d414bf76 引入）。
    //
    // ⚠️ 但"直接跳过"会**丢掉正对照**：上面那条"扫到 0 个 .umi 落点"在没有缓存的机器上会**恒真**
    //（根本没扫到任何东西 ⇒ 0 命中），于是"正确排除"与"扫描器坏了"变得不可区分。
    // ⇒ 所以正对照改成**在 os.tmpdir() 下合成一个 .umi 形状的树**：
    //    `walk(dir, acc)` 的 `dir` 本来就是入参，所以能把扫描器指向临时目录，
    //    这比依赖真实缓存**更强**（确定性、可控内容、干净 checkout 上也能跑）。
    // ---------------------------------------------------------------------
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'qj-skipdirs-'));
    try {
      // 自己的代码：一处**缺** showQuickJumper 的分页落点 ⇒ 必须被扫到（否则守卫假绿）
      writeFileSync(
        path.join(tmpRoot, 'own.jsx'),
        ['export default () => <Table pagination={{ pageSize: 10 }} />;', ''].join('\n'),
      );
      // 三个被 SKIP_DIRS 排除的目录，每个里面都放"会被数进来"的东西：
      // 既含 showQuickJumper（对应真实 .umi 里 antd 自己的源码），也含一处缺跳转的分页落点。
      for (const ignored of ['.umi', '.umi-production', 'node_modules']) {
        const d = path.join(tmpRoot, ignored, 'nested');
        mkdirSync(d, { recursive: true });
        writeFileSync(
          path.join(d, 'antd.jsx'),
          [
            '// 这里同时放两种"如果没被排除就会被数进来"的形状',
            'export const showQuickJumper = true;',
            'export default () => <Table pagination={{ pageSize: 20 }} />;',
          ].join('\n'),
        );
      }

      const scanned = walk(tmpRoot, []).map((f) => path.relative(tmpRoot, f).split(path.sep).join('/'));
      // ① 自己的文件必须被扫到 ⇒ 证明 walker 在这个临时树上真的工作（反空转）
      assert.deepEqual(scanned, ['own.jsx'], `walker 在合成树上的结果不对：${JSON.stringify(scanned)}`);
      // ② 合成树里确实存在"会被数进来"的东西 ⇒ 证明上面那条 0 命中不是"根本没扫到"
      const ignoredHits = ['.umi', '.umi-production', 'node_modules'].filter((d) =>
        readFileSync(path.join(tmpRoot, d, 'nested', 'antd.jsx'), 'utf8').includes('showQuickJumper'),
      );
      assert.equal(ignoredHits.length, 3, '合成正对照失效：被排除的目录里没有 showQuickJumper');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    // ---------------------------------------------------------------------
    // ⚠️ (B) 真实缓存正对照：**只在 src/.umi 存在时执行**。
    // 它证明的是"在这台机器上，真实缓存里确实有 showQuickJumper"，也就是排除它是有实际意义的
    //（antd/rc-pagination 的源码真的会被 grep 命中）。干净 checkout 上没有这个目录 ⇒ 如实打 NOTE，
    // 正对照的职责由上面 (A) 承担。🔴 断言本身**不放宽**：目录存在时 umiHits 仍必须 > 0。
    // ---------------------------------------------------------------------
    const umiDir = path.join(SRC, '.umi');
    if (existsSync(umiDir)) {
      assert.ok(statSync(umiDir).isDirectory(), 'src/.umi 存在但不是目录？请复核');
      let umiHits = 0;
      for (const f of walk(umiDir, []).slice(0, 400)) {
        // 这里**不剥注释**：只是要证明"那个目录里确实存在这个词"
        if (readFileSync(f, 'utf8').includes('showQuickJumper')) umiHits += 1;
      }
      assert.ok(
        umiHits > 0,
        'src/.umi 里居然找不到 showQuickJumper —— 说明"排除缓存目录"这条断言的正对照不成立，请复核 SKIP_DIRS',
      );
    } else {
      // 🔴 如实跳过并说明（不是静默跳过）：让读日志的人知道这条正对照在本机没执行、
      // 以及为什么"扫到 0 个 .umi 落点"在这台机器上是恒真的。
      console.log(
        'NOTE: 干净 checkout 上没有 src/.umi（umi 构建缓存、git-ignored），' +
          '所以"真实缓存里确实有 showQuickJumper"这条正对照本次未执行；' +
          '排除机制已由 os.tmpdir() 下的合成正对照验证（.umi/.umi-production/node_modules 三个都被跳过、' +
          '而自己的文件被扫到）。此时"扫到 0 个 .umi 落点"是恒真的，' +
          '但本文件其余断言（每一处分页都带 showQuickJumper）不依赖 .umi 是否存在。',
      );
    }
  });

  // 🔴 防复发守卫（2026-09-21）：本文件里对 `src/.umi` 的 statSync **必须**先 existsSync。
  // 起因就是上面那条：`statSync` 对缺失路径抛 ENOENT，而 `.umi` 是 git-ignored ⇒
  // 干净 checkout 上必然缺失 ⇒ CI 长期红。⚠️ 这是一条**源码文本级**守卫，
  // 作用范围只覆盖本文件（仓库级的同类检查属于 scripts/tests/**，不在本文件职责内）。
  it('防复发：对 git-ignored 的 src/.umi 做 statSync 之前必须先 existsSync', () => {
    // 🔴 口径：**必须连字符串一起剥**（用本文件已有的 maskCommentsAndStrings）。
    // 这正是手册里那条"剥多少取决于你要断言什么"：这里要钉的是"**代码里**有没有一次无保护的调用"，
    // 而下面几条断言的**消息字符串里就写着 `statSync(umiDir)` 这个字面量** ——
    // 只剥注释不剥字符串的话，守卫会把自己的提示语数成调用点（实测会是 3 处而不是 1 处），
    // 于是恒红；反过来若为了消红而放宽计数，守卫就废了。
    // ⚠️ maskCommentsAndStrings 把注释与字符串换成等长空格并**保留换行**，所以行号仍然可用。
    const masked = maskCommentsAndStrings(readFileSync(__filename, 'utf8')).split('\n');
    const code = masked.map((line, i) => ({ line, n: i + 1 }));

    const statLines = code.filter(({ line }) => line.includes('statSync(umiDir)'));
    assert.equal(
      statLines.length,
      1,
      '本文件里 statSync(umiDir) 的代码调用应当恰好 1 次（实际 ' +
        statLines.length +
        ' 次）；多出来的一处很可能没有 existsSync 保护，会在干净 checkout 上抛 ENOENT',
    );
    const guardLines = code.filter(({ line }) => line.includes('existsSync(umiDir)'));
    assert.equal(guardLines.length, 1, 'existsSync(umiDir) 的保护应当恰好有 1 处（实际 ' + guardLines.length + ' 处）');
    assert.ok(
      guardLines[0].n < statLines[0].n,
      'existsSync 的保护在第 ' + guardLines[0].n + ' 行，而 statSync 在第 ' + statLines[0].n + ' 行 —— 保护必须在前面',
    );

    // 🔴 更一般的一条：本文件里**任何** statSync/readdirSync 的直接实参都不许是
    //    含 git-ignored 目录名的字面量表达式（例如 path.join(SRC, '.umi')）。
    //    经变量间接传入的（如 walk 内部的 statSync(full)）由调用方负责先 existsSync。
    // ⚠️ 在剥过字符串的文本上，`path.join(SRC, '.umi')` 会变成 `path.join(SRC,      )`，
    //    所以这条要匹配的是"**标识符形态**的 ignored 名字"，字符串形态由上一条 existsSync 检查覆盖。
    const risky = code.filter(({ line }) =>
      /(statSync|readdirSync)\([^)]*\b(umiDir|umiProdDir)\b/.test(line),
    );
    // 允许恰好那一处（它有 existsSync 保护）；再多一处就是无保护的
    assert.ok(
      risky.length <= 1,
      '发现对 git-ignored 目录的额外 statSync/readdirSync 调用（' +
        risky.map((r) => r.n + ': ' + r.line.trim()).join(' | ') +
        '）—— 干净 checkout 上会 ENOENT，请改成先 existsSync',
    );
  });

  it('每一处分页都带 showQuickJumper，或在白名单里且写明了理由', () => {
    const bad = [];
    for (const s of all) {
      const key = `${s.rel}:${s.line}`;
      if (s.kind === 'false') {
        if (!FALSE_WHITELIST[key]) {
          bad.push(`${key} 是 pagination={false} 但不在白名单里（要么加分页跳转，要么登记理由）`);
        }
        continue;
      }
      if (s.kind === 'opaque') {
        if (!OPAQUE_WHITELIST[key]) {
          bad.push(
            `${key} 的 pagination 值静态看不出来（${s.snippet}）—— 请改成字面量对象，或登记白名单并说明`,
          );
        }
        continue;
      }
      if (!s.hasQuickJumper) {
        bad.push(`${key} 缺少 showQuickJumper —— ${s.snippet}`);
      }
    }
    assert.deepEqual(bad, [], `以下分页落点没有"输入页码跳转"能力：\n  ${bad.join('\n  ')}`);
  });

  it('白名单本身没有腐烂：每条都指向真实存在的落点，且理由非空', () => {
    // 🔴 反"白名单变垃圾场"：白名单里指向已经不存在的行号 = 过期的例外，必须清掉。
    const liveKeys = new Set(all.map((s) => `${s.rel}:${s.line}`));
    const stale = Object.keys(FALSE_WHITELIST).filter((k) => !liveKeys.has(k));
    assert.deepEqual(
      stale,
      [],
      `白名单里有已经失效的条目（代码已移动或删除）：${stale.join(', ')} —— 请删掉或更新行号`,
    );
    for (const [k, why] of Object.entries(FALSE_WHITELIST)) {
      assert.ok(typeof why === 'string' && why.trim().length >= 8, `${k} 的白名单理由太短，等于没写`);
    }
  });

  it('站长点名的两个页面确实在列：文章管理与图片管理', () => {
    // ⚠️ 这条不是"某符号出现"那种空断言：它钉的是**具体落点存在且合规**，
    // 如果有人把文章管理的分页整块删掉（或改成 pagination={false}），这里会红。
    const article = all.filter((s) => s.rel === 'pages/Article/index.jsx');
    assert.ok(article.length >= 1, '文章管理页扫不到分页落点');
    assert.ok(
      article.every((s) => s.kind === 'object' && s.hasQuickJumper),
      '文章管理页的分页缺少 showQuickJumper',
    );
    const img = all.filter((s) => s.rel === 'pages/Static/img/index.tsx');
    // 图片管理页有：被引用文章弹窗表格(object) + 列表视图表格(false，由底部 Pagination 负责) + 底部 <Pagination>(jsx)
    assert.ok(img.length >= 3, `图片管理页只扫到 ${img.length} 个落点，应当至少 3 个`);
    assert.ok(
      img.some((s) => s.kind === 'jsx' && s.hasQuickJumper),
      '图片管理页底部的 <Pagination> 缺少 showQuickJumper',
    );
  });

  it('图片管理页的共用分页器只有一个（防止将来加出两个打架的分页控件）', () => {
    const img = all.filter((s) => s.rel === 'pages/Static/img/index.tsx');
    assert.equal(
      img.filter((s) => s.kind === 'jsx').length,
      1,
      '图片管理页应当只有一个 <Pagination>（网格与列表两种视图共用）；' +
        '多于一个说明有人给列表视图又加了一套分页器，两个控件会互相打架',
    );
    // 另外两处：被引用文章弹窗表格(object，已带 showQuickJumper) + 列表视图表格(false，在白名单里)
    assert.equal(
      img.filter((s) => s.kind === 'false').length,
      1,
      '图片管理页应当恰好有一处 pagination={false}（列表视图，分页交给底部共用的 <Pagination>）',
    );
  });
});

// ---------------------------------------------------------------------------
// 尺子有效性反证：用**合成源码**证明 findPaginationSites 真的数得到、也真的分得清。
// 🔴 没有这一组，上面所有"0 个不合规"都可能是"扫描器根本没识别出任何形状"。
// ---------------------------------------------------------------------------
describe('pagination scanner 的尺子有效性（合成源码反证）', () => {
  it('识别得到：单行对象、多行对象、JSX 组件、pagination={false}、opaque', () => {
    const src = [
      'const A = () => <Table pagination={{ pageSize: 10, showQuickJumper: true }} />;',
      'const B = () => (',
      '  <Table',
      '    pagination={{',
      '      current: page,',
      '      total,',
      '      showTotal: (t) => `共 ${t} 条`,',
      '      onChange: (p) => setPage(p),',
      '    }}',
      '  />',
      ');',
      'const C = () => <Pagination total={total} current={page} showQuickJumper />;',
      'const D = () => <Table pagination={false} />;',
      'const E = () => <Table pagination={cfg} />;',
    ].join('\n');
    const sites = findPaginationSites(src);
    assert.equal(sites.length, 5, `应当扫到 5 处，实际 ${sites.length}：${JSON.stringify(sites)}`);
    assert.equal(sites[0].kind, 'object');
    assert.equal(sites[0].hasQuickJumper, true, '单行对象没识别出 showQuickJumper');
    assert.equal(sites[1].kind, 'object');
    // ⚠️ 合成源码里：第1行是 A(单行)、第2行 `const B = () => (`、第3行 `<Table`、
    //    第4行才是 `pagination={{` ⇒ 期望值是 **4**。这条断言最初写成 2 而变红，
    //    是**期望值算错了**而不是扫描器错 —— 但红得对：行号是白名单的索引键，
    //    错了会让"哪一处不合规"指向错误的地方，所以它值得被钉住。
    assert.equal(sites[1].line, 4, '多行写法的行号应当报在 pagination= 那一行（白名单按 路径:行号 索引）');
    assert.equal(
      sites[1].hasQuickJumper,
      false,
      '🔴 多行对象里**没有** showQuickJumper 却报成有 —— 说明配平取对象体的逻辑漏了跨行形状',
    );
    assert.equal(sites[2].kind, 'jsx');
    assert.equal(sites[2].hasQuickJumper, true, 'JSX 的裸属性写法（无 ={…}）没识别出来');
    assert.equal(sites[3].kind, 'false');
    assert.equal(sites[4].kind, 'opaque');
  });

  it('分得清：注释与字符串里出现 showQuickJumper **不算**合规', () => {
    // 🔴 这条防的是"守卫被注释喂饱"：本仓库已经多次因为断言匹配到解释性注释而假绿。
    const src = [
      '// 这里应当加 showQuickJumper: true（TODO）',
      'const A = () => <Table pagination={{ pageSize: 10 }} />;',
      '/* showQuickJumper 在块注释里 */',
      'const B = () => <Pagination total={100} />;',
      "const label = 'showQuickJumper';",
      'const C = () => <Table pagination={{ pageSize: 5 }} />;',
    ].join('\n');
    const sites = findPaginationSites(src);
    assert.equal(sites.length, 3, '注释/字符串里的 pagination= 被误当成落点了');
    assert.deepEqual(
      sites.map((s) => s.hasQuickJumper),
      [false, false, false],
      '注释或字符串里的 showQuickJumper 被当成了合规 —— 守卫会被注释喂饱',
    );
  });

  it('分得清：行注释里含 /* 不会吃掉真实代码（本仓库踩过的剥离顺序坑）', () => {
    // ⚠️ 如果用"先 replace 块注释再 replace 行注释"，下面第 1 行的 `src/*` 会让剥离器
    // 从那里开始一直吃到第 3 行的 `*/`，把**真实的 pagination 落点**一起吃掉 ⇒ 守卫假绿。
    const src = [
      '// 只扫 src/* 下的文件，别扫构建缓存 */',
      'const A = () => <Table pagination={{ pageSize: 10 }} />;',
      'const B = () => <Table pagination={{ pageSize: 10, showQuickJumper: true }} />;',
    ].join('\n');
    const sites = findPaginationSites(src);
    assert.equal(sites.length, 2, '行注释里的 /* 让剥离器吃掉了真实代码');
    assert.deepEqual(sites.map((s) => s.hasQuickJumper), [false, true]);
  });

  it('分得清：对象体里嵌套的 {{…}} 与箭头函数不会让配平提前结束', () => {
    const src = [
      'const A = () => (',
      '  <Table',
      '    pagination={{',
      '      style: { marginTop: 8 },',
      '      showTotal: (t) => ({ n: t }),',
      '      pageSize: 10,',
      '    }}',
      '  />',
      ');',
      'const B = () => <Table pagination={{ pageSize: 10, showQuickJumper: true }} />;',
    ].join('\n');
    const sites = findPaginationSites(src);
    assert.equal(sites.length, 2);
    assert.equal(
      sites[0].hasQuickJumper,
      false,
      '嵌套花括号让配平提前结束，于是把下一个组件的 showQuickJumper 误算到这一处',
    );
    assert.equal(sites[1].hasQuickJumper, true);
  });

  it('行号准确：报出来的行号能直接拿去打开文件', () => {
    const src = ['// 1', '// 2', 'const A = () => <Table pagination={false} />;', 'const B = () => <X />;'].join(
      '\n',
    );
    const sites = findPaginationSites(src);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].line, 3, '行号不准 —— 白名单是按 路径:行号 索引的，行号错就全错');
  });
});
