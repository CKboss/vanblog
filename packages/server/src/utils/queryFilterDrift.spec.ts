import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 漂移守卫：Mongoose **写操作**的查询条件必须是"可证明非空且不含会消失的值"。
 *
 * ## 为什么需要它
 * 同一个缺陷在本仓库已经出现**四次**，严重度递增：
 *   1. `token.provider.ts` 的 `checkToken` ⇒ `findOne({token: undefined, disabled:false})` 退化成
 *      "任意一个未吊销 token" ⇒ **未认证管理员接管**；
 *   2. `user.provider.ts` 的 `updateCollaborator` ⇒ `findOne({name: undefined, type:'collaborator'})`
 *      退化成"任意一个协作者" ⇒ 不带用户名的更新改掉**某个**协作者的口令与权限；
 *   3. `customPage.provider.ts` 的 `updateCustomPage` ⇒ `updateOne({path: undefined})` 退化成 `{}`
 *      ⇒ 改写**任意一个**自定义页面，而自定义页面是公开渲染的原始 HTML；
 *   4. 同文件的 `deleteByPath` ⇒ `deleteOne({})` **删掉任意一页**，folder 类型还会连带删磁盘目录。
 * 四次都靠人发现。这条守卫的目的是让第五次**在 CI 里就红**。
 *
 * ## 判据（两层，缺一不可）
 * - **A 清单层**：扫出所有"filter 不是纯常量字面量"的写操作调用点，这个集合必须与下面
 *   `AUDITED_WRITE_FILTER_SITES` **精确相等**（多一处少一处都红）。⇒ 新增一处未审计的写操作会红。
 * - **B 保护证据层**：每个已审计条目都声明它靠什么保护（共用助手 / 本地校验 / 上游抛错），
 *   并给出必须在源码里出现的**标记**。⇒ 把某处修复撤掉，标记消失，这一层就红。
 *
 * ⚠️ 只有 A 层是不够的：撤掉修复不会改变调用点清单，A 层照样绿 —— 那就是空转守卫。
 * ⚠️ 只有 B 层也是不够的：新增一处无校验的写操作不会有任何标记可查，B 层无从红起。
 */

const WRITE_METHODS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
  'replaceOne',
] as const;

/** 只认 Mongoose model 上的调用（本仓库的注入名一律以 Model / Modal 结尾，例如 customPageModal）。 */
const RECEIVER_RE = /\b[A-Za-z_$][\w$]*(?:Model|Modal)\b\s*\.\s*/;

export interface WriteFilterSite {
  /** 相对 `packages/server/src` 的路径 */
  file: string;
  method: string;
  /** 第一个实参的原文（已压缩空白），用于人读与清单键 */
  filter: string;
}

/** 取出调用点第一个实参的原文（正确处理嵌套的 `{}` / `()` / `[]` 与字符串）。 */
function readFirstArgument(source: string, openParenIndex: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, i);
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1);
}

/** 纯常量字面量：所有值都是字符串/数字/布尔/正则，或 `$op` 且其值是常量。这种 filter 不可能退化。 */
function isConstantObjectLiteral(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') {
    // `{}` 是"匹配任意一条"—— 对写操作而言这正是要拦的形状，不算安全常量。
    return false;
  }
  // 逐个顶层 `key: value` 检查；用深度计数切分，避免把 `{a:{$in:[1,2]}}` 切碎。
  const pairs: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (inString) {
      current += char;
      if (char === '\\') {
        current += inner[++i] ?? '';
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      current += char;
      continue;
    }
    if ('{[('.includes(char)) {
      depth += 1;
    } else if ('}])'.includes(char)) {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      pairs.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    pairs.push(current);
  }
  const CONSTANT_VALUE = /^(?:'[^']*'|"[^"]*"|`[^`]*`|-?\d+(?:\.\d+)?|true|false|null|\/.*\/[a-z]*)$/;
  return pairs.every((pair) => {
    const colon = pair.indexOf(':');
    if (colon === -1) {
      // 简写属性 `{ name }` ⇒ 值来自变量，不是常量。
      return false;
    }
    const value = pair.slice(colon + 1).trim();
    if (CONSTANT_VALUE.test(value)) {
      return true;
    }
    // `{ $ne: excludeId }` / `{ $in: [...] }` 这类：$op 里装变量，同样不是常量。
    return false;
  });
}

/** 扫描一份源码，返回所有"filter 不是纯常量"的写操作调用点。 */
export function scanWriteFilters(source: string, file: string): WriteFilterSite[] {
  const code = stripCommentsForAnchor(source);
  const sites: WriteFilterSite[] = [];
  for (const method of WRITE_METHODS) {
    const re = new RegExp(`(${RECEIVER_RE.source})${method}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      const openParen = match.index + match[0].length - 1;
      const rawFilter = readFirstArgument(code, openParen);
      const filter = rawFilter.replace(/\s+/g, ' ').trim();
      if (isConstantObjectLiteral(filter)) {
        continue;
      }
      sites.push({ file, method, filter });
    }
  }
  return sites.sort((a, b) => `${a.file}:${a.filter}`.localeCompare(`${b.file}:${b.filter}`));
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) {
        continue;
      }
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) {
      continue;
    }
    out.push(full);
  }
  return out;
}

const SRC_ROOT = resolve(__dirname, '..');

function scanRepository(): WriteFilterSite[] {
  const sites: WriteFilterSite[] = [];
  for (const full of collectSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, full).split('\\').join('/');
    sites.push(...scanWriteFilters(readFileSync(full, 'utf-8'), rel));
  }
  return sites.sort((a, b) => `${a.file}:${a.filter}`.localeCompare(`${b.file}:${b.filter}`));
}

/**
 * 高风险形状的判据（**只**盯这两类，否则守卫会被当噪音删掉 —— 全仓库有 79 处动态 filter 写操作，
 * 其中 74 处的值来自内部（`parseNumericId()` 对垃圾输入直接抛错、或取自刚查出来的文档），
 * 结构上不可能变成 undefined）：
 * - **裸变量 filter**：`updateOne(filter, …)`。空与"含 undefined"都看不见，是最危险的形状，
 *   本轮修的四处里有三处是它。
 * - **值直接来自请求对象**：`{ path: dto.path }`。今天是 0 处，但将来最容易被人这么写。
 */
function isBareVariableFilter(filter: string): boolean {
  return !filter.trim().startsWith('{');
}

const REQUEST_DERIVED = /\b(?:dto|body|option|options|req|request|params|query)\s*\./;
function isRequestDerivedFilter(filter: string): boolean {
  return filter.trim().startsWith('{') && REQUEST_DERIVED.test(filter);
}

/**
 * 已审计清单。**这是审计记录，不是豁免**：每条都写了"靠什么保护"，以及保护消失时会红的 `markers`。
 * ⚠️ 只有清单而没有 markers 就是空转守卫 —— 撤掉修复不会改变调用点清单，A 层照样绿。
 */
const AUDITED_HIGH_RISK_SITES: Array<{
  file: string;
  method: string;
  filter: string;
  protection: string;
  /** 必须在**该文件**出现（可以在别处也出现）—— 证明这一层保护存在 */
  fileMarkers: string[];
  /** 必须在**全仓库只出现在该文件**—— 证明保护落在**这个调用点**，而不是同文件的另一处 */
  siteMarkers: string[];
}> = [
  {
    file: 'provider/customPage/customPage.provider.ts',
    method: 'updateOne',
    filter: 'filter',
    protection:
      '入口要求 _id 或 path 至少一个可用（否则 400），落库前再过 assertSafeWriteFilter',
    // ⚠️ marker 必须**站点唯一**：`assertSafeWriteFilter(filter, ` 这种前缀在同文件里会出现两次
    //    （updateCustomPage 与 deleteByPath），只钉前缀的话删掉其中一处仍然命中 ⇒ 变异对照 0 红。
    //    第二个参数就是站点标签，所以连标签一起钉。
    fileMarkers: ['isUsableFilterValue('],
    siteMarkers: ["assertSafeWriteFilter(filter, 'CustomPageProvider.updateCustomPage')"],
  },
  {
    file: 'provider/customPage/customPage.provider.ts',
    method: 'deleteOne',
    filter: 'filter',
    protection: '入口要求 path 可用（否则 400），落库前再过 assertSafeWriteFilter',
    fileMarkers: ['isUsableFilterValue(path)'],
    siteMarkers: ["assertSafeWriteFilter(filter, 'CustomPageProvider.deleteByPath')"],
  },
  {
    file: 'provider/category/category.provider.ts',
    method: 'deleteOne',
    filter: 'filter',
    protection:
      '入口要求 name 可用（否则 NotAcceptable），落库前再过 assertSafeWriteFilter；' +
      '**不**依赖后面那次"分类已有文章"检查兜底（空库时它拦不住）',
    fileMarkers: ['isUsableFilterValue(name)'],
    siteMarkers: ["assertSafeWriteFilter(filter, 'CategoryProvider.deleteOne')"],
  },
  {
    file: 'provider/stats/statsMaintenance.provider.ts',
    method: 'deleteMany',
    filter: 'plan.filter as any',
    protection:
      '（同一段保护覆盖两个调用点：visitModel 与 viewerModel 的 deleteMany）' +
      '调用点前有 `if (!plan.enabled || !plan.filter)` 提前返回，且 plan.filter 由保留期配置' +
      '（日期区间）在内部构造，不接受请求输入。⚠️ 残余风险：`{}` 是 truthy，所以那个检查拦不住' +
      '"空对象"，只拦得住 null/undefined —— 已记为待办，本轮不动（不在授权范围，且是内部构造）。',
    fileMarkers: [],
    siteMarkers: ['if (!plan.enabled || !plan.filter)'],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateReward')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateReward')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.deleteReward')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.deleteReward')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.deleteSocial')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.deleteSocial')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateSocial')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateSocial')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateLink')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.addOrUpdateLink')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.deleteLink')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前这里是 `updateOne({}, …)`：集合为空则匹配 0 条（管理员点保存后静默无事发生），'
      + '不止一条则命中自然顺序里的任意一条（改错文档）。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.deleteLink')"],
  },
  // ---- 2026-09-21 第二批：清掉仓库里最后 4 处空字面量 filter `{}` ----
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(existing, 'MetaProvider.update')",
    protection:
      'existing 来自 getAll()；为 null 或缺 _id 时**不写也不 upsert**，记一条去重 WARN 并返回 null，'
      + '所以走到 updateOne 时 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 这一处的降级口径与同文件另外 8 个写方法**不同**（不抛 404）：它被启动期的 '
      + "updateTotalWords('首次启动') 与每次增删改文章调用，而未初始化站点的 metas 本来就是空的"
      + '（init.provider 的 metaModel.create 才建这份文档），抛错会让每次启动都产生一条 ERROR、'
      + '淹掉 ./vanblog.sh doctor 的 24h ERROR 计数。',
    fileMarkers: ['private missingMetaWarnedFor?', 'this.warnMissingMetaOnce('],
    siteMarkers: ["this.metaWriteFilter(existing, 'MetaProvider.update')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(meta, 'MetaProvider.updateAbout')",
    protection:
      'meta 来自 requireMetaDocument()：为 null 或缺 _id 时抛 404（文案指向 doctor / restore --offline-full），'
      + '所以走到这里 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前是 `updateOne({}, …)`：后台"关于页"点保存时，集合为空 ⇒ 界面提示成功而什么都没写进去。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(meta, 'MetaProvider.updateAbout')"],
  },
  {
    file: 'provider/meta/meta.provider.ts',
    method: 'updateOne',
    filter: "this.metaWriteFilter(metaDoc, 'MetaProvider.updateSiteInfo')",
    protection:
      'metaDoc 来自 requireMetaDocument()（**不是**上面那个 oldSiteInfo：getSiteInfo() 是读侧口径，'
      + '会补 uiStyle/净化文案，且返回加工后的普通对象、拿不到 _id）；为 null 或缺 _id 时抛 404，'
      + '所以 filter 必然是 { _id: <非空> }；metaWriteFilter 内部再过 assertSafeWriteFilter。'
      + '⚠️ 改之前是 `updateOne({}, …)`：后台"站点设置"点保存时同样会静默无事发生或改错文档。',
    fileMarkers: ['private async requireMetaDocument(', 'assertSafeWriteFilter(filter, context)'],
    siteMarkers: ["this.metaWriteFilter(metaDoc, 'MetaProvider.updateSiteInfo')"],
  },
  {
    file: 'provider/stats/viewStats.provider.ts',
    method: 'findOneAndUpdate',
    filter: 'filter',
    protection:
      'filter = { _id: metaId }，metaId 来自 resolveMetaId()（每进程一次 _id-only 读，refreshBase 顺手缓存，'
      + 'invalidateBase 会作废 —— 整站恢复会整份替换 metas，_id 可能变）；'
      + '解析不到文档时**跳过这次 $inc**（不 upsert：那会造出只有计数字段、没有 siteInfo 的残缺文档），'
      + '落库前再过 assertSafeWriteFilter。'
      + '⚠️ 改之前是 `findOneAndUpdate({}, { $inc: … })`：集合为空 ⇒ 这一轮攒的站点计数静默丢掉；'
      + '不止一条 ⇒ 把访问量累加到**任意一条**上，而读侧 refreshBase 读的是 findOne() 那一条，'
      + '于是读写可能落在两份不同文档上（计数看起来"少了"或"不涨"，且无任何报错）。',
    fileMarkers: ['private async resolveMetaId(', 'private metaIdResolved = false;'],
    siteMarkers: ["assertSafeWriteFilter(filter, 'ViewStatsProvider.doFlush')"],
  },
];

/**
 * 动态 filter 写操作的**总数棘轮**：只许减不许增。
 * 这不是精确审计（74 处内部来源的 filter 逐条写理由会把守卫变成没人读的清单），
 * 但它能保证"批量新增动态 filter 写操作"这件事**一定会被注意到**，而不是静默发生。
 */
// 79 → 85（2026-09-21）：meta.provider 的 6 个后台写方法从 `updateOne({}, …)` 改成
// `updateOne(this.metaWriteFilter(meta, …), …)`，即 `{ _id: meta._id }`。6 处都已加进下面的已审计清单。
//
// 🔴 更正（2026-09-21，实测）：上面那次改动原本记的理由是"`{}` 是常量形状、A2 的棘轮**根本数不到它**"，
//    **这句话是错的**。`isConstantObjectLiteral('{}')` 里 `inner === ''` 那一支**明确 return false**
//    （注释还写着"`{}` 是'匹配任意一条'……不算安全常量"），所以 `{}` 一直都被 `scanWriteFilters`
//    收进 `allSites`、一直被 A2 计数 —— 本文件下面那条既有合成用例
//    「不误报也不会漏报 `{}`：空条件对写操作**算危险**，必须被扫出来」正是这件事的证明。
//    ⇒ 那 6 处改前改后**都在计数里**，A2 的总数并没有因为它们而变多。
//    ⚠️ 真正的盲区不是"A2 数不到 `{}`"，而是**A2 只约束总数、不约束形状**：
//    总数低于基线时，新增若干处 `{}` 也不会红。所以补了下面的 **C 层**（专门断言空字面量 filter 的
//    集合与显式白名单**精确相等**），并且把基线**收紧到实测值**（松的基线等于给未来的漂移留额度）。
// 85 → 71（2026-09-21，实测收紧）：`scanRepository().length` 实测就是 71，基线却写着 85 ⇒
//    白送了 14 处的额度。⚠️ 规矩：这个常量应当**等于实测值**，新增一处就 +1 并说明，而不是留余量。
const DYNAMIC_WRITE_FILTER_BASELINE = 71;

/**
 * 🔴 C 层：空字面量 filter（`{}`）的**接收者无关**扫描器。
 *
 * 为什么需要它、它补的是哪个盲区：上面的 `scanWriteFilters` 只认接收者以 `Model`/`Modal` 结尾的调用
 * （`RECEIVER_RE`），所以 `utils/fullBackup.ts` 里 `tmp.deleteMany({})` 这种**临时集合变量**上的调用
 * **它根本扫不到**（实测：全仓 4 处在扫描器视野内，第 5 处 `tmp.deleteMany({})` 在视野外）。
 * 这一层不限接收者，把所有 `.deleteMany({})` 形状都数出来，再与显式白名单**精确相等**比对。
 * ⚠️ 两把尺子是**互补**的，不是重复：C1 用既有扫描器盯 model 调用（顺带覆盖多行写法），
 *    C2 用这把盯"接收者不是 model"的漏网形状（原始 driver / 临时集合变量）。
 */
const EMPTY_WRITE_CALL_RE = new RegExp(
  // ⚠️ 方法名那一组**必须捕获**（不是 `(?:…)`）：`m[1]` 是接收者、`m[2]` 是方法名，
  //    白名单键两者都要。第一版写成非捕获组，于是 method 全是 undefined、白名单永远对不上。
  `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${WRITE_METHODS.join('|')})\\s*\\(\\s*\\{\\s*\\}\\s*[,)]`,
  'g',
);

export interface EmptyFilterSite {
  file: string;
  /** 点号前的那个标识符（`tmp` / `metaModel`），用于白名单键 */
  receiver: string;
  method: string;
}

/** 扫一份源码里所有"空字面量 filter 的写操作"，不限接收者。 */
export function scanEmptyLiteralWriteFilters(source: string, file: string): EmptyFilterSite[] {
  const code = stripCommentsForAnchor(source);
  const out: EmptyFilterSite[] = [];
  EMPTY_WRITE_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMPTY_WRITE_CALL_RE.exec(code)) !== null) {
    out.push({ file, receiver: m[1], method: m[2] });
  }
  return out;
}

function scanRepositoryEmptyFilters(): EmptyFilterSite[] {
  const out: EmptyFilterSite[] = [];
  for (const full of collectSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, full).split('\\').join('/');
    out.push(...scanEmptyLiteralWriteFilters(readFileSync(full, 'utf-8'), rel));
  }
  return out.sort((a, b) => `${a.file}|${a.receiver}|${a.method}`.localeCompare(`${b.file}|${b.receiver}|${b.method}`));
}

/**
 * 空字面量 filter 的**显式白名单**。**这是审计记录，不是豁免**：每条都必须写明为什么这里 `{}` 是本意。
 * ⚠️ 往里加条目等于承认"这里故意匹配整个集合"，所以理由必须能回答："如果这个集合里将来有了
 *    不该被动的文档，这条语句会不会把它一起动掉？"
 */
const ALLOWED_EMPTY_FILTER_SITES: Array<{ file: string; receiver: string; method: string; why: string }> = [
  {
    file: 'utils/fullBackup.ts',
    receiver: 'tmp',
    method: 'deleteMany',
    // 恢复流程里的 `<coll>__vanblog_restore` 临时集合：`{}` 正是本意（清空这一份临时集合，
    // 好让接下来的 insertMany 从干净状态开始）。它**不可能**碰到用户数据 —— 集合名带
    // RESTORE_SUFFIX，而且 `reportAbsentCollections` 那一侧明确"system.* 与 *__vanblog_restore 一律不碰"。
    why: '清空恢复用的临时集合（名字带 __vanblog_restore），`{}` 就是"全清"的本意，碰不到用户数据',
  },
];

describe('Mongoose 写操作的查询条件不许退化成"任意一条"', () => {
  const allSites = scanRepository();
  const highRisk = allSites.filter(
    (site) => isBareVariableFilter(site.filter) || isRequestDerivedFilter(site.filter),
  );
  const highRiskKeys = highRisk.map((site) => `${site.file} | ${site.method} | ${site.filter}`);
  const auditedKeys = AUDITED_HIGH_RISK_SITES.map(
    (entry) => `${entry.file} | ${entry.method} | ${entry.filter}`,
  );

  it('A 层：高风险形状（裸变量 / 值来自请求）的集合与已审计清单**精确相等**', () => {
    // 多了 ⇒ 有人新加了一处未审计的高风险写操作；少了 ⇒ 清单腐了（或某处被删而没人更新记录）。
    const unaudited = highRiskKeys.filter((key) => !auditedKeys.includes(key));
    const stale = auditedKeys.filter((key) => !highRiskKeys.includes(key));
    expect({ unaudited, stale }).toEqual({ unaudited: [], stale: [] });
  });

  it('A 层的尺子没空转：真的扫到了东西，而且扫到的都是写操作', () => {
    expect(highRisk.length).toBeGreaterThan(0);
    // ⚠️ 比的是**去重后的键**，不是行数：statsMaintenance 那一处保护覆盖两个 model
    //    （`visitModel.deleteMany(plan.filter)` 与 `viewerModel.deleteMany(plan.filter)`），
    //    扫出 5 行但只需要 1 条审计记录。用行数相等会把"同一个保护覆盖多个调用点"误判成漏审计。
    expect(new Set(highRiskKeys).size).toBe(AUDITED_HIGH_RISK_SITES.length);
    expect(new Set(auditedKeys).size).toBe(AUDITED_HIGH_RISK_SITES.length);
    for (const site of highRisk) {
      expect((WRITE_METHODS as readonly string[]).includes(site.method)).toBe(true);
      expect(site.file).toMatch(/\.ts$/);
      expect(site.file).not.toMatch(/\.spec\.ts$/);
    }
  });

  it(`A2 层：动态 filter 写操作总数不超过基线 ${DYNAMIC_WRITE_FILTER_BASELINE}（只许减不许增）`, () => {
    // ⚠️ 如果你合法地新增了一处，请把基线 +1 **并**在提交信息里说明它的值为什么不可能为 undefined；
    //    如果它是"裸变量"或"值来自请求"形状，还必须加进上面的已审计清单。
    expect(allSites.length).toBeLessThanOrEqual(DYNAMIC_WRITE_FILTER_BASELINE);
    expect(allSites.length).toBeGreaterThan(0);
  });

  it('A2 层：基线必须**等于**实测值，不许留余量（松的基线等于给未来的漂移发额度）', () => {
    // 🔴 这条是 2026-09-21 加的：当时基线写着 85，而 `scanRepository().length` 实测只有 71
    //    ⇒ 白送 14 处额度，也就是说"新增 14 处未审计的动态 filter 写操作"都不会红。
    //    棘轮的意义在于**紧贴**实测值：合法新增时 +1 并在提交信息里说明，而不是留缓冲。
    expect(allSites.length).toBe(DYNAMIC_WRITE_FILTER_BASELINE);
  });

  it('C1 层：model 上的写操作**不许**用空字面量 filter `{}`（那会命中集合里的任意一条）', () => {
    // `{}` 在写操作上有两种坏形状，都不报错：集合为空 ⇒ 匹配 0 条 ⇒ 静默无事发生；
    // 集合不止一条 ⇒ 命中自然顺序里的第一条 ⇒ **改错文档**（比崩溃更糟：数据悄悄错了）。
    // ⚠️ 白名单里 receiver 以 Model/Modal 结尾的条目才算这一层的豁免（当前为空）。
    const allowed = ALLOWED_EMPTY_FILTER_SITES.filter((e) => /(?:Model|Modal)$/.test(e.receiver));
    const actual = allSites
      .filter((site) => site.filter.replace(/\s+/g, '') === '{}')
      .map((site) => `${site.file} | ${site.method}`);
    const expected = allowed.map((e) => `${e.file} | ${e.method}`);
    expect(actual).toEqual(expected);
  });

  it('C2 层：**接收者无关**地扫，空字面量 filter 的集合必须与显式白名单精确相等', () => {
    // 补 C1 的盲区：既有扫描器只认 `*Model`/`*Modal` 接收者，所以 `tmp.deleteMany({})`
    // 这类临时集合变量上的调用它看不见（实测全仓有 1 处这种）。
    const actual = scanRepositoryEmptyFilters().map((s) => `${s.file} | ${s.receiver} | ${s.method}`);
    const expected = ALLOWED_EMPTY_FILTER_SITES.map((e) => `${e.file} | ${e.receiver} | ${e.method}`);
    // 多了 ⇒ 有人新加了一处 `{}` 写操作却没审计；少了 ⇒ 白名单腐了（或某处被删而没人更新记录）。
    expect({ extra: actual.filter((k) => !expected.includes(k)), stale: expected.filter((k) => !actual.includes(k)) }).toEqual({ extra: [], stale: [] });
  });

  it('C2 层的白名单不是空的、而且每条都写了理由（空白名单会让这层退化成"只要没有 `{}` 就绿"）', () => {
    expect(ALLOWED_EMPTY_FILTER_SITES.length).toBeGreaterThan(0);
    for (const entry of ALLOWED_EMPTY_FILTER_SITES) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.file).toMatch(/\.ts$/);
    }
    // 尺子没空转：这把接收者无关的尺子在真实仓库里**确实**扫到了东西（白名单那 1 处 + 修好前的 4 处）。
    expect(scanRepositoryEmptyFilters().length).toBeGreaterThan(0);
  });

  it('B 层前置：每个 marker 在**整个仓库**里只出现在它所属的那个文件（否则 marker 不具站点唯一性）', () => {
    // 这条是防"marker 太宽 ⇒ 删掉一处修复仍命中"的元守卫。变异对照 M2 就是这么被抓出来的：
    // 原来钉的是 `assertSafeWriteFilter(filter, ` 这个前缀，而同文件两处都匹配它。
    const allFiles = collectSourceFiles(SRC_ROOT);
    for (const entry of AUDITED_HIGH_RISK_SITES) {
      for (const marker of entry.siteMarkers) {
        const hits = allFiles
          .map((full) => relative(SRC_ROOT, full).split('\\').join('/'))
          .filter((rel) =>
            stripCommentsForAnchor(readFileSync(join(SRC_ROOT, rel), 'utf-8')).includes(marker),
          );
        expect({ marker, hits }).toEqual({ marker, hits: [entry.file] });
      }
    }
  });

  it('B 层：每个已审计条目的保护标记都真的在源码里（撤掉修复就会红）', () => {
    const missing: string[] = [];
    for (const entry of AUDITED_HIGH_RISK_SITES) {
      const code = stripCommentsForAnchor(readFileSync(join(SRC_ROOT, entry.file), 'utf-8'));
      for (const marker of [...entry.fileMarkers, ...entry.siteMarkers]) {
        if (!code.includes(marker)) {
          missing.push(`${entry.file} 缺少 ${marker}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('B 层（读侧）：这一族已修的两处**未认证级**缺陷，其守卫也还在', () => {
    // 这两处是 findOne（读侧），不在写操作扫描范围内，但它们是本族最严重的两例，
    // 撤掉就会重现"未认证管理员接管"与"改掉任意协作者口令"，所以单独钉住。
    const token = stripCommentsForAnchor(
      readFileSync(join(SRC_ROOT, 'provider/token/token.provider.ts'), 'utf-8'),
    );
    expect(token).toContain("if (typeof token !== 'string' || !token.trim())");
    const user = stripCommentsForAnchor(
      readFileSync(join(SRC_ROOT, 'provider/user/user.provider.ts'), 'utf-8'),
    );
    expect(user).toContain('assertCollaboratorName(collaboratorDto?.name)');
    // 空转反证：这两把尺子在缺陷版形状上必须**不**命中
    expect("const result = await this.tokenModel.findOne({ token, disabled: false });").not.toContain(
      "typeof token !== 'string'",
    );
    expect('const { name } = collaboratorDto;').not.toContain('assertCollaboratorName(');
  });

  it('共用助手确实存在并被这些文件引用（不是只在清单里写了个名字）', () => {
    const helper = stripCommentsForAnchor(
      readFileSync(join(SRC_ROOT, 'utils/queryFilter.ts'), 'utf-8'),
    );
    expect(helper).toMatch(/export function isUsableFilterValue\(/);
    expect(helper).toMatch(/export function assertSafeWriteFilter\(/);
    const users = Array.from(
      new Set(
        AUDITED_HIGH_RISK_SITES.filter((entry) =>
          [...entry.fileMarkers, ...entry.siteMarkers].some((marker) =>
            marker.includes('assertSafeWriteFilter'),
          ),
        ).map((entry) => entry.file),
      ),
    );
    expect(users.length).toBeGreaterThanOrEqual(2);
    for (const file of users) {
      const code = stripCommentsForAnchor(readFileSync(join(SRC_ROOT, file), 'utf-8'));
      expect(code).toMatch(/from 'src\/utils\/queryFilter'/);
    }
  });
});

describe('扫描器的通用性（用合成源码证明，不碰文件系统）', () => {
  const MODEL = 'this.thingModel';

  it('会抓住"变量 filter + 无任何校验"的新增写操作', () => {
    const sample = `
      async bad(dto: any) {
        const filter = dto.id ? { _id: dto.id } : { path: dto.path };
        return await ${MODEL}.updateOne(filter, { $set: { html: dto.html } });
      }
    `;
    const found = scanWriteFilters(sample, 'provider/sample/sample.provider.ts');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ method: 'updateOne', filter: 'filter' });
  });

  it('会抓住简写属性 `{ name }`（值来自变量，与字面量常量不同）', () => {
    const found = scanWriteFilters(
      `await ${MODEL}.deleteOne({ name });`,
      'provider/sample/sample.provider.ts',
    );
    expect(found).toHaveLength(1);
    expect(found[0].filter).toBe('{ name }');
  });

  it('会抓住 `{ path: dto.path }` 这种"内联字面量但值是变量"的形状', () => {
    const found = scanWriteFilters(
      `await ${MODEL}.updateOne({ path: dto.path }, update);`,
      'provider/sample/sample.provider.ts',
    );
    expect(found).toHaveLength(1);
  });

  it('会抓住 `$op` 里装变量（`{ id: { $ne: excludeId } }`）', () => {
    const found = scanWriteFilters(
      `await ${MODEL}.deleteMany({ id: { $ne: excludeId } });`,
      'provider/sample/sample.provider.ts',
    );
    expect(found).toHaveLength(1);
  });

  it('不误报：纯常量 filter、读操作、以及非 model 上的同名方法', () => {
    const safe = `
      await ${MODEL}.deleteOne({ deleted: true });
      await ${MODEL}.updateMany({ type: 'file', order: 3 }, { $set: { ok: false } });
      await ${MODEL}.findOne(filter);
      await ${MODEL}.countDocuments(query);
      const rows = await ${MODEL}.find(query, view);
      await this.tagProvider.deleteOne(name);
      await someService.updateOne(filter, patch);
    `;
    expect(scanWriteFilters(safe, 'provider/sample/sample.provider.ts')).toEqual([]);
  });

  it('不误报也不会漏报 `{}`：空条件对写操作**算危险**，必须被扫出来', () => {
    const found = scanWriteFilters(
      `await ${MODEL}.deleteMany({});`,
      'provider/sample/sample.provider.ts',
    );
    expect(found).toHaveLength(1);
    expect(found[0].filter).toBe('{}');
  });

  it('C 层尺子有效性：`{}` 的空白/多行变体都能数到，非空 filter 不误报', () => {
    const F = 'provider/sample/sample.provider.ts';
    // ⚠️ 这四种形状必须**都**被数到：上一轮就栽在多行写法上 ——
    //    `updateAbout()` 的 `updateOne(\n {},\n {…})` 让裸正则 `updateOne\(\{\}` 少数了一处。
    const variants = `
      await ${MODEL}.deleteMany({});
      await ${MODEL}.deleteMany({ });
      await ${MODEL}.updateOne(
        {
        },
        { $set: { a: 1 } },
      );
      await ${MODEL}
        .findOneAndUpdate({}, { $inc: { n: 1 } });
    `;
    const found = scanEmptyLiteralWriteFilters(variants, F);
    expect(found).toHaveLength(4);
    expect(found.map((x) => x.method).sort()).toEqual([
      'deleteMany',
      'deleteMany',
      'findOneAndUpdate',
      'updateOne',
    ]);
    // 不误报：非空 filter、读操作、以及非 model 上的同名方法都不该被算进来
    const safe = `
      await ${MODEL}.deleteOne({ deleted: true });
      await ${MODEL}.updateMany({ type: 'file' }, { $set: { ok: false } });
      await ${MODEL}.findOne({});
      await ${MODEL}.countDocuments({});
      await someService.updateOne(filter, patch);
    `;
    expect(scanEmptyLiteralWriteFilters(safe, F)).toEqual([]);
    // 读操作的 `{}` 是**合法**的（`findOne({})` = 取第一条，没有写入风险）⇒ 必须不被计入。
    // 空转反证：把 WRITE_METHODS 里的方法名当普通词出现在注释里，不该被数到。
    const commented = `
      // 这里以前是 ${MODEL}.deleteMany({})，已经改成按 _id 删了
      await ${MODEL}.deleteOne({ _id: id });
    `;
    expect(scanEmptyLiteralWriteFilters(commented, F)).toEqual([]);
    // 反证的反证：同一把尺子在**未剥注释**时确实会命中注释里那句（证明"剥注释"这一步真的在起作用，
    // 而不是因为正则本身匹配不到才显得干净）
    expect(commented).toContain('deleteMany({})');
  });

  it('剥注释是真的剥了（否则"常量 filter"可能只是注释里的假象）', () => {
    const withComment = `
      // await ${MODEL}.deleteOne(filter);  ← 这是注释，不该被算成调用点
      await ${MODEL}.deleteOne({ deleted: true });
    `;
    expect(scanWriteFilters(withComment, 'provider/sample/sample.provider.ts')).toEqual([]);
    // 空转反证：同一把尺子在未剥注释时会命中注释里的调用
    expect(stripCommentsForAnchor(withComment)).not.toContain('← 这是注释');
  });
});
