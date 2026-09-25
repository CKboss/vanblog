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
const REGISTERED_KEY_GROUPS = ['common', 'error', 'init', 'login', 'logout', 'menu', 'sysconf', 'theme'];
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
function needsIcuPlural(value) {
  if (typeof value !== 'string') return false;
  if (ICU_PLURAL_RE.test(value)) return false;
  return PLACEHOLDER_PLURAL_RE.test(value);
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
  readPack,
  KEY_MAX_SEGMENTS,
  KEY_SEGMENT_RE,
  REGISTERED_KEY_GROUPS,
  GRANDFATHERED_KEYS,
  validateKeyShape,
  PLACEHOLDER_PLURAL_RE,
  ICU_PLURAL_RE,
  needsIcuPlural,
};
