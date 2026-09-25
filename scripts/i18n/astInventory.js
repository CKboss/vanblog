/**
 * 🔴 i18n 盘点的**唯一权威 AST 实现**（共享模块，CommonJS）。
 *
 * ## 为什么这个文件存在（不要把它内联回各个消费方）
 * 此前有两份各自为政的 AST/正则逻辑：
 *   ① `packages/admin/tests/unit/i18nHardcodedRatchet.test.js` 里的裸中文计数；
 *   ② 一次性的分类脚本（产出 `vanblog_dev/i18n-classification/admin-zh-inventory.tsv`）。
 * 🔴 **两处实现同一件事就一定会漂移**（本仓库的核心教训之一：「一个性质只留一处权威口径」）。
 * 所以现在：**守卫与 CLI 工具都 require 这一份**，并由
 * `packages/admin/tests/unit/i18nSharedImpl.test.js` 钉住"两处确实共用同一实现"。
 *
 * ## 为什么必须用 AST 而不是正则
 * 🔴 **正则数结构化数据会错，而且错得很像真的**：
 *   - 用「带引号的字面量」正则盘点 UI 文案，会**漏掉 JSX 文本节点**
 *     （有一次因此漏了约 19 条，语言包从 63 key 补到 82 key）；
 *   - 用 `grep -c "^\s*'"` 数语言包 key，得到 **128/117/116 三份不等**（真值 105/105/105，
 *     因为文件开头有大段注释、且值会跨行）；
 *   - 用 `grep -A2 '<key>' | tail -1` 取语言包的值，会**整体错位一个 key**
 *     （值跨行时抓到的是下一条的内容）。
 * ⇒ 🔴 **本模块一律解析后再取值。**
 *
 * ## fail-loud 约定
 * 🔴 **解析失败必须抛错，绝不能当成"0 条"**（0 会被读成"这个文件很干净"，那是最坏的假阴性）。
 * 🔴 **babel 插件列表必须含 `optionalChaining`**（漏了它 `src/app.jsx` 会解析失败）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 🔴 汉字范围（含扩展 A 与兼容表意文字）。⚠️ `grep -E` 不支持 `\x{}`，所以本仓库找中文一律走这里或 `grep -P`。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 🔴 解析出 `@babel/parser`：先走正常解析，失败再向上逐级找 pnpm 的真实目录。
 * ⚠️ 不能只依赖 `require('@babel/parser')`：`scripts/` 下没有自己的 `node_modules`，
 *    而 pnpm 的目录名带 peer 后缀（例如 `@babel+parser@7.23.4`），
 *    🔴 **凭记忆猜目录名会失败**（本项目已因此栽过：`@babel+core@7.23.2` vs 真实 `7.23.3`）。
 * 🔴 找不到就抛错，**不静默返回 null**。
 */
function loadParser() {
  try {
    return require('@babel/parser');
  } catch (e) {
    /* 落到 pnpm 扫描 */
  }
  // 从本文件位置逐级向上找 node_modules/.pnpm（本文件在 <root>/scripts/i18n/）
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const pnpmRoot = path.join(dir, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmRoot)) {
      let entries = [];
      try {
        entries = fs.readdirSync(pnpmRoot);
      } catch (e) {
        entries = [];
      }
      for (const d of entries) {
        if (!d.startsWith('@babel+parser@')) continue;
        const cand = path.join(pnpmRoot, d, 'node_modules/@babel/parser');
        if (fs.existsSync(cand)) return require(cand);
      }
    }
    const direct = path.join(dir, 'node_modules/@babel/parser');
    if (fs.existsSync(direct)) return require(direct);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    'astInventory: 找不到 @babel/parser。这条实现拒绝静默跳过 —— ' +
      '请确认依赖已安装（不要为了绕过它而把断言放宽）。',
  );
}

let PARSER = null;
function parser() {
  if (!PARSER) PARSER = loadParser();
  return PARSER;
}

/** 🔴 babel 插件列表：必须覆盖本仓库真实用到的语法。缺 `optionalChaining` 时 `src/app.jsx` 会解析失败。 */
const BABEL_PLUGINS = [
  'jsx',
  'typescript',
  ['decorators', { decoratorsBeforeExport: true }],
  'classProperties',
  'classPrivateProperties',
  'optionalChaining',
  'nullishCoalescingOperator',
  'objectRestSpread',
  'dynamicImport',
  'logicalAssignment',
  'optionalCatchBinding',
  'topLevelAwait',
];

/**
 * 解析源码。🔴 **失败必须抛错**（不能当成"0 条"）。
 * @param {string} src 源码文本
 * @param {string} label 出错时用于定位的标签（相对路径）
 */
function parseSource(src, label) {
  try {
    return parser().parse(src, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: BABEL_PLUGINS,
    });
  } catch (e) {
    throw new Error(
      `astInventory: ${label || '<unknown>'} 解析失败（不能当成 0 条）：${String(e && e.message).split('\n')[0]}`,
    );
  }
}

/**
 * 通用遍历：对 AST 里每个节点调用 `visit(nd, parentChain)`。
 * 🔴 `loc` 一律跳过（它含大量位置对象，遍历它没有意义且很慢）。
 */
function walkAst(root, visit) {
  const walk = (nd) => {
    if (!nd || typeof nd !== 'object') return;
    if (nd.type) visit(nd);
    for (const k of Object.keys(nd)) {
      if (k === 'loc') continue;
      const v = nd[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && walk(x));
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(root);
}

/**
 * 🔴 收集一份源码里的全部中文，**按口径分开**（这是本模块存在的核心理由）。
 *
 * 返回四个互不重叠的桶：
 *   - `literals`   ：`StringLiteral`（去重）
 *   - `templates`  ：`TemplateElement` 的 raw（去重，前缀 `TPL:`）
 *   - `jsxTexts`   ：`JSXText`（去重，前缀 `JSX:`，空白折叠）
 *   - `comments`   ：注释里的中文行数（🔴 **注释不翻译**，所以必须单独计数，
 *                    否则"含中文行数"会把工作量虚高 —— 实测 3,441 行里含 1,816 行注释）
 *
 * ⚠️ **`excludeDefaultMessage`**：
 *   🔴 为 true 时排除 `t()`/`formatMessage()` 的**第 2 个实参**（defaultMessage 位）
 *   以及对象字面量里 key 名为 `defaultMessage` 的属性值 —— 那是**刻意保留的中文**，
 *   不是"未翻译"。这正是 `i18nHardcodedRatchet` 需要的语义（"裸中文"）。
 *   🔴 那个 `index === 1` 极易写反（写成 0 就会把 id 跳过、把 defaultMessage 算进来，
 *   第一版就这么错过，把 `ThemeButton` 报成 3 条而真值是 0）。
 *
 * @returns {{literals:Set<string>, templates:Set<string>, jsxTexts:Set<string>, comments:number}}
 */
function collectChinese(src, label, options) {
  const opts = options || {};
  const excludeDefaultMessage = opts.excludeDefaultMessage === true;
  const ast = parseSource(src, label);

  const literals = new Set();
  const templates = new Set();
  const jsxTexts = new Set();

  const visit = (nd) => {
    if (excludeDefaultMessage) {
      // 排除 { id, defaultMessage } 形式
      if (
        nd.type === 'ObjectProperty' &&
        nd.key &&
        (nd.key.name === 'defaultMessage' || nd.key.value === 'defaultMessage')
      ) {
        return;
      }
      // 排除 t()/formatMessage() 的第 2 个实参
      if (nd.type === 'CallExpression') {
        const cn = nd.callee && (nd.callee.name || (nd.callee.property && nd.callee.property.name));
        if (cn === 't' || cn === 'formatMessage') {
          (nd.arguments || []).forEach((a, i) => {
            if (i === 1) return;
            if (a && typeof a === 'object') collectFromNode(a);
          });
          return;
        }
      }
    }
    collectFromNode(nd);
  };

  // 单节点采集（不递归；递归由 walkAst 负责）
  const collectFromNode = (nd) => {
    if (!nd || typeof nd !== 'object') return;
    if (nd.type === 'StringLiteral' && typeof nd.value === 'string' && HAN.test(nd.value)) {
      literals.add(nd.value);
    } else if (nd.type === 'TemplateElement' && nd.value && HAN.test(nd.value.raw || '')) {
      templates.add('TPL:' + (nd.value.raw || '').trim());
    } else if (nd.type === 'JSXText' && typeof nd.value === 'string' && HAN.test(nd.value)) {
      jsxTexts.add('JSX:' + nd.value.replace(/\s+/g, ' ').trim());
    }
  };

  // 🔴 excludeDefaultMessage 时需要"跳过子树"的语义，所以这里手写递归而不是用 walkAst
  if (excludeDefaultMessage) {
    const walkSkip = (nd) => {
      if (!nd || typeof nd !== 'object') return;
      if (
        nd.type === 'ObjectProperty' &&
        nd.key &&
        (nd.key.name === 'defaultMessage' || nd.key.value === 'defaultMessage')
      ) {
        return; // 整个子树跳过
      }
      if (nd.type === 'CallExpression') {
        const cn = nd.callee && (nd.callee.name || (nd.callee.property && nd.callee.property.name));
        if (cn === 't' || cn === 'formatMessage') {
          (nd.arguments || []).forEach((a, i) => {
            if (i === 1) return; // 🔴 第 2 个实参 = defaultMessage 位
            walkSkip(a);
          });
          // callee 与其它字段照常
          if (nd.callee) walkSkip(nd.callee);
          return;
        }
      }
      collectFromNode(nd);
      for (const k of Object.keys(nd)) {
        if (k === 'loc') continue;
        const v = nd[k];
        if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && walkSkip(x));
        else if (v && typeof v === 'object' && v.type) walkSkip(v);
      }
    };
    walkSkip(ast.program);
  } else {
    walkAst(ast.program, collectFromNode);
  }

  // 🔴 注释单独计数（AST 的 comments 不在 program 遍历里）
  let comments = 0;
  for (const c of ast.comments || []) {
    const text = c && c.value ? c.value : '';
    for (const line of String(text).split('\n')) {
      if (HAN.test(line)) comments += 1;
    }
  }

  return { literals, templates, jsxTexts, comments };
}

/**
 * 🔴 `i18nHardcodedRatchet` 需要的语义：一个文件里"裸中文"的去重条数集合。
 * = literals ∪ templates ∪ jsxTexts，**排除注释、排除 defaultMessage 位**。
 * @returns {Set<string>}
 */
function bareChinese(src, label) {
  const r = collectChinese(src, label, { excludeDefaultMessage: true });
  const out = new Set();
  for (const v of r.literals) out.add(v);
  for (const v of r.templates) out.add(v);
  for (const v of r.jsxTexts) out.add(v);
  return out;
}

/** 读文件后调用 `bareChinese`（守卫用的便捷入口，含"文件必须存在"的 fail-loud）。 */
function bareChineseFromFile(abs, label) {
  if (!fs.existsSync(abs)) {
    throw new Error(`astInventory: 清单里的文件不存在：${label || abs}（清单已过期，请更新而不是放宽断言）`);
  }
  return bareChinese(fs.readFileSync(abs, 'utf8'), label);
}

/**
 * 🔴 抽出一个文件里所有 i18n 调用点的 `{ id, defaultMessage }`（**AST，不是正则**）。
 *
 * ## 为什么它必须在共享模块里
 * `localePackParity` 原本自己拿正则抽 `t()` 调用、并且**手维护一份"哪些文件接了 i18n"的清单**。
 * 🔴 后果实测到了：期 3 第一批翻完的 `ImgTab.jsx`/`WalineTab.jsx` **忘了加进那份清单** ⇒
 * 它们的 31 个 defaultMessage 与语言包是否一致**从来没被检查过**（守卫全绿，覆盖面是假的）。
 * 👉 这与本仓库最高频的自伤同族：**手维护的覆盖面清单一定会漏**
 * （"只找 `*.spec.ts` 而漏掉 admin 的 `.test.js`" 已犯过 6 次）。
 * 现在的形状是：调用方**遍历源码目录自动发现**，判据就是"本函数在这个文件里抽得到调用点"，
 * 而"什么算一个调用点"只有这一处定义 ⇒ 覆盖面跟着代码走，不再跟着清单走。
 *
 * ## 认哪些形状
 *   - `t('a.b', '默认文案')`                    → id + defaultMessage
 *   - `t('a.b', '默认文案', { n: 1 })`           → 同上（第三个实参是插值，忽略）
 *   - `intl.formatMessage({ id: 'a.b', defaultMessage: '默认文案' })` → 同上
 * 🔴 **不认**动态 id（`t(key)`）与非字面量 defaultMessage（例如 `t` 这个 helper 自己的定义处
 *   `intl.formatMessage({ id, defaultMessage }, values)`，那是简写属性、没有文本可对账）：
 *   这类调用点**跳过而不报错** ⇒ 调用方必须用"抽到的条数下界"做反空转断言，
 *   🔴 否则"一条都没抽到"与"确实没有调用点"就分不开了。
 *
 * @returns {Array<{id:string, defaultMessage:string|null, callee:string, line:number|null}>}
 */
function collectTCalls(src, label) {
  const ast = parseSource(src, label);
  const out = [];
  walkAst(ast.program, (nd) => {
    if (nd.type !== 'CallExpression' || !nd.callee) return;
    const callee = nd.callee;
    const name =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression' && callee.property
          ? callee.property.name || callee.property.value
          : null;
    if (name !== 't' && name !== 'formatMessage') return;
    const args = nd.arguments || [];
    const first = args[0];
    let id = null;
    let defaultMessage = null;
    if (first && first.type === 'StringLiteral' && typeof first.value === 'string') {
      id = first.value;
      const second = args[1];
      if (second && second.type === 'StringLiteral' && typeof second.value === 'string') {
        defaultMessage = second.value;
      }
    } else if (first && first.type === 'ObjectExpression') {
      for (const p of first.properties || []) {
        if (!p || p.type !== 'ObjectProperty' || !p.key) continue;
        const k = p.key.name || p.key.value;
        if (k === 'id' && p.value && p.value.type === 'StringLiteral') id = p.value.value;
        if (k === 'defaultMessage' && p.value && p.value.type === 'StringLiteral') {
          defaultMessage = p.value.value;
        }
      }
    }
    if (id === null) return; // 动态 id ⇒ 没有可对账的文本
    out.push({ id, defaultMessage, callee: name, line: nd.loc ? nd.loc.start.line : null });
  });
  return out;
}

/** 读文件后调用 `collectTCalls`（含"文件必须存在"的 fail-loud）。 */
function collectTCallsFromFile(abs, label) {
  if (!fs.existsSync(abs)) {
    throw new Error(`astInventory: 文件不存在：${label || abs}`);
  }
  return collectTCalls(fs.readFileSync(abs, 'utf8'), label);
}

/**
 * 🔴 数出一份源码里「**带中文的 `throw` 站点**」（期 9 服务端错误码棘轮的判据）。
 *
 * ## 口径（必须写清，否则数字没法对账）
 * 一个站点 = 一条 `ThrowStatement`，其**实参子树里**至少有一个含汉字的 `StringLiteral`
 * 或 `TemplateElement`。⇒ 模板字符串拼接的消息也算（实测占 97 + 9 处，漏掉它们会把工作量低估四成）。
 * 🔴 **迁移到 `codedError('<code>')` 之后就不再被计入** —— 这正是棘轮想要的方向：
 * 存量慢慢还、**增量立刻止住**（新增裸中文 throw 会让计数超过预算而红）。
 *
 * ## 🔴 为什么判据放在共享模块里
 * 守卫（`packages/admin/tests/unit/i18nServerErrorCodes.test.js`）与将来可能的 CLI 报数
 * 必须用**同一份**实现，否则又会出现"两个工具报出不同数字、无法判断哪个对"。
 *
 * @returns {Array<{line:number|null, texts:string[]}>}
 */
function collectChineseThrows(src, label) {
  const ast = parseSource(src, label);
  const out = [];
  const sub = (nd, texts) => {
    if (!nd || typeof nd !== 'object') return;
    if (nd.type === 'StringLiteral' && typeof nd.value === 'string' && HAN.test(nd.value)) {
      texts.push(nd.value);
    } else if (nd.type === 'TemplateElement' && nd.value && HAN.test(nd.value.raw || '')) {
      texts.push('TPL:' + (nd.value.raw || '').trim());
    }
    for (const k of Object.keys(nd)) {
      if (k === 'loc') continue;
      const v = nd[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && sub(x, texts));
      else if (v && typeof v === 'object' && v.type) sub(v, texts);
    }
  };
  walkAst(ast.program, (nd) => {
    if (nd.type !== 'ThrowStatement') return;
    const texts = [];
    sub(nd.argument, texts);
    if (texts.length > 0) out.push({ line: nd.loc ? nd.loc.start.line : null, texts });
  });
  return out;
}

/**
 * 🔴 数出一份源码里「**`message:` 属性带中文**」的站点（返回体那一族），并标出它**在不在 `throw` 里**。
 *
 * ## 为什么单列一个口径
 * 服务端的用户可见错误有**两种形状**：`throw new XException('中文')` 与 `return { statusCode, message: '中文' }`。
 * 棘轮如果只数 `throw`，🔴 **后一种就能随便新增而没有任何守卫会红** —— 而实测后者有 **100 处**
 * （"演示站禁止…"那一族几乎全是这个形状），比 throw 那一族的一半还多。
 * ⇒ 两个口径都要有棘轮（`i18nServerErrorCodes.test.js` 里各一条预算）。
 *
 * @returns {Array<{line:number|null, text:string, inThrow:boolean}>}
 */
function collectChineseMessageProps(src, label) {
  const ast = parseSource(src, label);
  const throwRanges = [];
  walkAst(ast.program, (nd) => {
    if (nd.type === 'ThrowStatement' && nd.loc) throwRanges.push([nd.loc.start.line, nd.loc.end.line]);
  });
  const out = [];
  walkAst(ast.program, (nd) => {
    if (nd.type !== 'ObjectProperty' || !nd.key) return;
    const k = nd.key.name || nd.key.value;
    if (k !== 'message') return;
    if (!nd.value || nd.value.type !== 'StringLiteral' || typeof nd.value.value !== 'string') return;
    if (!HAN.test(nd.value.value)) return;
    const line = nd.loc ? nd.loc.start.line : null;
    out.push({
      line,
      text: nd.value.value,
      inThrow: line === null ? false : throwRanges.some(([a, b]) => line >= a && line <= b),
    });
  });
  return out;
}

/**
 * 🔴 解析**服务端错误码登记表**（`packages/server/src/utils/serverErrorCodes.ts` 里的
 * `export const SERVER_ERROR_CODES = { <code>: entry('<中文>', <Ctor>[, <status>]) }`）。
 *
 * ## 为什么它在共享模块里
 * admin 的守卫跑在 `node --test` 下，🔴 **不能 `require()` 那个 TS 文件** ⇒ 只能 AST 解析；
 * 而"登记表长什么样"只能有**一处**口径（两处实现必然漂移）。
 *
 * ## 🔴 fail-loud（这条比解析本身更重要）
 * 解析出 **0 个码**时抛错：否则"每个码都有三语译文"与"每个码都被抛出"这两条会**同时恒真**
 * （空集合上的全称命题），而那是本仓库最怕的假绿形状（已有先例：枚举出 0 条路由 ⇒"未覆盖清单为空"恒真）。
 *
 * @returns {Record<string, {zh:string, ctor:string, status:number|null}>}
 */
function collectServerErrorCodes(src, label) {
  const ast = parseSource(src, label);
  const out = {};
  let found = false;
  walkAst(ast.program, (nd) => {
    if (nd.type !== 'VariableDeclarator' || !nd.id || nd.id.name !== 'SERVER_ERROR_CODES') return;
    found = true;
    const obj = nd.init;
    if (!obj || obj.type !== 'ObjectExpression') {
      throw new Error(`astInventory: ${label || '<registry>'} 里的 SERVER_ERROR_CODES 不是对象字面量（形状变了？请更新解析器，不要放宽断言）`);
    }
    for (const prop of obj.properties) {
      if (!prop || prop.type !== 'ObjectProperty' || !prop.key) continue;
      const code = prop.key.name || prop.key.value;
      const call = prop.value;
      if (!call || call.type !== 'CallExpression') {
        throw new Error(`astInventory: 错误码 ${code} 的值不是 entry(...) 调用（形状变了？）`);
      }
      const args = call.arguments || [];
      const zh = args[0] && args[0].type === 'StringLiteral' ? args[0].value : null;
      const ctor = args[1] && args[1].type === 'Identifier' ? args[1].name : null;
      const status = args[2] && args[2].type === 'NumericLiteral' ? args[2].value : null;
      if (typeof zh !== 'string' || !ctor) {
        throw new Error(`astInventory: 错误码 ${code} 的 entry() 参数形状不认识（zh=${JSON.stringify(zh)} ctor=${JSON.stringify(ctor)}）`);
      }
      out[code] = { zh, ctor, status };
    }
  });
  if (!found) {
    throw new Error(`astInventory: ${label || '<registry>'} 里找不到 SERVER_ERROR_CODES（文件路径错了？还是登记表被改名了？）`);
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`astInventory: ${label || '<registry>'} 解析出 0 个错误码（登记表被清空 ⇒ 所有对账断言会恒真，这是尺子坏了）`);
  }
  return out;
}

/**
 * 🔴 高频「简体专用字」表：这些字在繁体里**一定**是另一个字形 ⇒
 *    只要 zh-TW 语言包的值里出现其中任何一个，就说明有人**直接把简体复制过来当繁中**。
 *
 * ## 为什么它在共享模块里（而不是留在守卫里）
 * 消费方有两个：`packages/admin/tests/unit/localePackParity.test.js`（守卫）与
 * `scripts/i18n/inventory.js --zh-tw-audit`（每批翻译后的人工审计工具）。
 * 🔴 两处各存一份就一定会漂移 —— 本仓库已为"同一性质两处口径"反复付过学费。
 *
 * ## 🔴 这张表**天生不可能完备**，别把它当安全网
 * 本机没有任何简繁映射数据源（也不许装新依赖）⇒ 表只能逐字人工核实来扩。已实测两次教训：
 *  - 期 3 第一批：表里漏「现」⇒ zh-TW 写出「掃描现有…」而守卫全绿（是浏览器活体证据发现的）；
 *  - 期 3 第二批：表里漏「点」⇒ zh-TW 写出「站点配置」而守卫全绿（这次是**逐字审计 zh-TW 值里
 *    出现过的全部 454 个不同汉字**发现的；审计工具：`node scripts/i18n/inventory.js --zh-tw-audit`；
 *    核实依据：上游繁中语料 antd `lib/locale/zh_TW.js` 用「點」2 处、「点」0 处）。
 * 🔴 而"凭看着像简体批量加"同样有害：期 3 第一批曾一次加 158 字，立刻误伤 4 条
 *    （量 / 限 在繁体里合法：數量、限制）⇒ **假阳性比漏报更糟，它会训练下一个人忽略红灯。**
 * ⚠️ 刻意**不收**：准 别 云 余 只 台 强 松 核 没 量 限 里 黑 静 降 填 目 粘 包 含 不 文 章
 *    （简繁同形，或在繁体里同样合法）。
 * 🔴 规矩：**每翻译完一批繁中，就跑一次 `--zh-tw-audit` 把该批用字逐个过一遍**，别指望这张表替你兜住。
 */
const SIMPLIFIED_ONLY_ZH =
  '设备复务网页图导录账号评论处动进级单击确认时间题误报读压缩数据库静态档称随机闭开启传输应该这会说请试频简护贴载键运显实个为来对过还现点';

/**
 * 🔴 zh-TW 里**刻意保留简体**的字（与上面那张表互补）：必须是"有理由的例外"，不是"漏网"。
 * 每个字都要写清理由 —— 没有理由的例外就是缺陷。
 */
const SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW = [
  {
    ch: '钥',
    why:
      '「初始化密钥」是要照着敲进 shell 的命令与启动日志标签（服务端输出的就是简体），' +
      '翻译了 grep 就抓不到东西 ⇒ 那两条 zh-TW 值里刻意保留简体。' +
      '同族的反向断言（"这个字面量必须仍然存在"）在 i18nHardcodedRatchet 的 REQUIRED_EXCEPTIONS 里。',
  },
];

/**
 * 🔴 解析一份语言包（`export default { 'a.b': '值', … }`）为 key → value 映射。
 * ⚠️ **不要用正则**：值会跨行，`grep -A2 | tail -1` 会整体错位一个 key（实测踩过）。
 * 🔴 解析不到任何 key 时抛错（fail-loud），因为"0 个 key"会让所有集合断言恒真。
 */
function readPack(abs, label) {
  if (!fs.existsSync(abs)) throw new Error(`astInventory: 语言包不存在：${label || abs}`);
  const src = fs.readFileSync(abs, 'utf8');
  const ast = parseSource(src, label || abs);
  const out = {};
  let n = 0;
  walkAst(ast.program, (nd) => {
    if (nd.type !== 'ObjectProperty' || !nd.key) return;
    const k = nd.key.value || nd.key.name;
    if (typeof k !== 'string') return;
    let v = null;
    if (nd.value && nd.value.type === 'StringLiteral') v = nd.value.value;
    else if (nd.value && nd.value.type === 'TemplateLiteral' && nd.value.quasis.length === 1) {
      v = nd.value.quasis[0].value.cooked;
    }
    if (v === null) return; // 非字符串值（理论上不该有）⇒ 跳过，由调用方的计数断言兜住
    out[k] = v;
    n += 1;
  });
  if (n === 0) {
    throw new Error(`astInventory: ${label || abs} 解析出 0 个 key（尺子坏了，不是语言包真的空）`);
  }
  return out;
}

/**
 * 🔴 key 命名规范的**唯一权威实现**（守卫与文档都引用这里的常量，不复述）。
 *
 * 规范：**`<组>.<区域>.<项>`，最多三段**。
 * - 段数：2 或 3（`common.about` 这种两段是合法的；🔴 **4 段及以上不合法**）。
 * - 字符集：`A-Za-z0-9_-`（点只作分隔符）。
 * - 不以点开头/结尾、无空段。
 * - 🔴 **第一段必须属于已登记的组** ⇒ 新增组必须显式登记，防止命名空间失控。
 *
 * 🔴 **祖父条款**：存量里有 20 个 4 段 key（`init.restore.{count,err,detail}.*`），
 * 是第一期/第二期落地时按语义分组写的。**不为了让守卫绿而改它们的 key 名** ——
 * 改名会牵动所有引用点（组件里的 `t('…')` 与守卫的对账），风险远大于收益。
 * ⇒ **只对增量生效**：白名单里的 20 条豁免段数规则，但仍受"组必须已登记"约束。
 * ⚠️ 白名单必须**恰好等于**实际不合规的那一批（多一条少一条都要红），
 *    这是本仓库反复吃过亏的地方（"白名单必须恰好等于实际相同的那一批"）。
 */
const KEY_MAX_SEGMENTS = 3;
const KEY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
// 🔴 `sysconf` = 后台「系统设置」页（`pages/SystemConfig/**`）专用的组（2026-09-25 期 3 第一批登记）。
//   与 `common.*` 的边界：**只在本页组出现的用 `sysconf`，跨页共用的用 `common`**；
//   与 `menu.*` 的边界：`menu.*` 是方案 B 的专属命名空间，只允许被 `config/routes.js` 的 `locale` 字段使用。
// 🔴 `recycle` = 回收站抽屉（`components/RecycleBin/**`，2026-09-26 期 9 第四批登记）。
//   它是**第一个组件级命名空间**：跨页复用的组件用自己的名字做组（recycle / 将来的 editor / imgPicker…），
//   页面组用页面名（sysconf），真正通用的动作词才进 common。
// 🔴 `siteInfo` = 站点设置表单（`components/SiteInfoForm`，2026-09-26 期 4 登记）。
//   它同时被**初始化向导**与**系统设置→站点配置**复用 ⇒ 按"跨页复用的组件用自己的名字做组"归到组件名，
//   而不是塞进 `init.*` 或 `sysconf.*`（那两个都是**页面**组，塞进去会让另一侧的调用方跨组借 key）。
// 🔴 `watermark` = 图床设置里的压缩/水印/缩略图表单（`components/WaterMarkForm`，2026-09-26 期 5 第一批登记）。
//   ⚠️ 它被 `SystemConfig/tabs/ImgTab.jsx` 用，但**不能**放 `sysconf.img.*`：那会变成 **4 段**
//   （`sysconf.img.enableWebp.label`）⇒ 命名守卫不允许；组件级命名空间正好 3 段。
// 🔴 `storage` = 图床设置里的存储策略表单（`components/StaticForm`，与 `watermark` 同轮登记）。
const REGISTERED_KEY_GROUPS = ['common', 'error', 'init', 'login', 'logout', 'menu', 'recycle', 'siteInfo', 'storage', 'sysconf', 'theme', 'watermark'];
const GRANDFATHERED_KEYS = [
  'init.restore.count.articles',
  'init.restore.count.images',
  'init.restore.count.users',
  'init.restore.count.visits',
  'init.restore.count.viewers',
  'init.restore.count.settings',
  'init.restore.count.total',
  'init.restore.count.unknownSize',
  'init.restore.err.rejected',
  'init.restore.err.httpFailed',
  'init.restore.err.409',
  'init.restore.err.403',
  'init.restore.err.429',
  'init.restore.err.400',
  'init.restore.err.fallback1',
  'init.restore.err.fallback2',
  'init.restore.detail.seconds',
  'init.restore.detail.counts',
  'init.restore.detail.db',
  'init.restore.detail.static',
];

/**
 * 校验一个 key 的形状。
 * @returns {{ok:boolean, reasons:string[]}} reasons 为空表示合规
 */
function validateKeyShape(key) {
  const reasons = [];
  if (typeof key !== 'string' || key === '') {
    return { ok: false, reasons: ['key 不是非空字符串'] };
  }
  if (key.startsWith('.')) reasons.push('以点开头');
  if (key.endsWith('.')) reasons.push('以点结尾');
  const segs = key.split('.');
  if (segs.some((s) => s === '')) reasons.push('含空段');
  for (const s of segs) {
    if (s !== '' && !KEY_SEGMENT_RE.test(s)) reasons.push(`段 "${s}" 含非法字符（只允许 A-Za-z0-9_-）`);
  }
  const grandfathered = GRANDFATHERED_KEYS.includes(key);
  if (segs.length < 2) reasons.push('段数少于 2');
  if (segs.length > KEY_MAX_SEGMENTS && !grandfathered) {
    reasons.push(`段数 ${segs.length} > ${KEY_MAX_SEGMENTS}（且不在祖父条款白名单里）`);
  }
  if (!REGISTERED_KEY_GROUPS.includes(segs[0])) {
    reasons.push(`第一段 "${segs[0]}" 不是已登记的组（已登记：${REGISTERED_KEY_GROUPS.join(', ')}）`);
  }
  return { ok: reasons.length === 0, reasons, grandfathered };
}

/**
 * 🔴 ICU 复数约定的判据（**收窄过的**，见下面的噪音实测）。
 *
 * 朴素判据「数字或占位符 + 复数名词」在现有 114 个 key 上命中 **4 条，其中 3 条是假阳性**
 * （`every 10 minutes`、`1–2 minutes`、`5 per 10 minutes` 都是**散文里的常量数字**，
 * 不是插值计数）⇒ **噪音 75%**。
 * 🔴 收窄成「**`{占位符}` 紧跟复数名词**」后命中 **恰好 1 条**（`init.restore.detail.db`
 * 的 `{collections} collections / {documents} documents`），就是真问题。
 * ⇒ **判据只认插值占位符，不认散文里的字面数字。**
 */
const PLACEHOLDER_PLURAL_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}\s+[A-Za-z]+s\b/;
/** ICU 复数语法是否已使用（`{name, plural, …}`）。 */
const ICU_PLURAL_RE = /\{[A-Za-z_][A-Za-z0-9_]*\s*,\s*plural\s*,/;

/**
 * 一个 en-US 值是否"该用 ICU plural 却没用"。
 * 🔴 已经用了 plural 的不再报（一条值里可能同时有 plural 段与普通占位符）。
 */
/**
 * 🔴 「`{占位符}` 后面那个以 s 结尾的词」里，**永远不可能是复数名词**的那一批（英语功能词/动词）。
 *
 * ## 为什么需要它（实测到的假阳性，2026-09-26 期 9 第四批）
 * `PLACEHOLDER_PLURAL_RE` 判的是"占位符 + 以 s 结尾的词"，而英语里以 s 结尾的**功能词**一大堆：
 * 新写的两条文案 `{label} is no longer in the recycle bin…` 与 `not allowed to {action} this {label}…`
 * 分别被 `is` 与 `this` 命中 ⇒ 🔴 **守卫报了 2 条假缺口**，而那两条根本不含计数。
 * 这与本仓库那条老经验同源：**假缺口比没守卫更糟 —— 它会训练下一个人忽略红灯。**
 *
 * ## 🔴 收词纪律
 * 只收"**绝不可能是复数名词**"的词（be/have 的变位、指示代词、比较连词、物主代词…）。
 * ⚠️ 刻意**不收** bus / gas / class / address 这类"以 s 结尾但真的是名词"的词 ——
 * 收了就会漏掉真缺陷（假阴性）。逐个词核实过，与"简体专用字表"是同一条纪律。
 */
const ICU_PLURAL_STOPWORDS = new Set([
  'is', 'was', 'as', 'has', 'this', 'that', 'thus', 'us', 'vs', 'his', 'its',
  'ours', 'yours', 'theirs', 'always', 'sometimes', 'perhaps', 'yes', 'plus', 'minus',
]);

/** 全局版（要逐个匹配来看命中词是不是功能词，`test()` 那种"有一个就算"的语义不够用）。 */
const PLACEHOLDER_PLURAL_GLOBAL_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}\s+([A-Za-z]+)s\b/g;

function needsIcuPlural(value) {
  if (typeof value !== 'string') return false;
  if (ICU_PLURAL_RE.test(value)) return false;
  PLACEHOLDER_PLURAL_GLOBAL_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_PLURAL_GLOBAL_RE.exec(value)) !== null) {
    const word = (m[1] + 's').toLowerCase();
    // 🔴 功能词（is / this / as …）不是复数名词 ⇒ 跳过；其它命中就是真缺陷
    if (!ICU_PLURAL_STOPWORDS.has(word)) return true;
  }
  return false;
}

module.exports = {
  HAN,
  BABEL_PLUGINS,
  loadParser,
  parseSource,
  walkAst,
  collectChinese,
  bareChinese,
  bareChineseFromFile,
  collectTCalls,
  collectTCallsFromFile,
  collectChineseThrows,
  collectChineseMessageProps,
  collectServerErrorCodes,
  SIMPLIFIED_ONLY_ZH,
  SIMPLIFIED_ZH_ALLOWED_IN_ZH_TW,
  readPack,
  KEY_MAX_SEGMENTS,
  KEY_SEGMENT_RE,
  REGISTERED_KEY_GROUPS,
  GRANDFATHERED_KEYS,
  validateKeyShape,
  PLACEHOLDER_PLURAL_RE,
  PLACEHOLDER_PLURAL_GLOBAL_RE,
  ICU_PLURAL_STOPWORDS,
  ICU_PLURAL_RE,
  needsIcuPlural,
};
