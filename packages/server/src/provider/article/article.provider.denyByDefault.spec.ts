import { ArticleProvider } from './article.provider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 🔴 **单文档读的 publish 过滤必须"默认拒绝"**（`VIEW_SKIPS_PUBLISH_FILTER` 登记表）。
 *
 * ## 这个文件防的是什么
 * 原来的形状是正向判断：只有 `'public'` 视图加 `visiblePublishFilter()`，**其它一律放行**。
 * 今天没有活的漏洞（所有非 public 的调用方都核实过非匿名），但它是**默认放行**：
 * **将来任何人加一个 `ArticleView` 成员，就自动跳过"未到发布时间"过滤，而且没有任何守卫会红。**
 * 同一个文件里的**列表读**恰好是相反且更好的形状（`getAll` 按 `includeHidden === false` 加过滤、
 * 与 view 名无关 ⇒ 新增视图在结构上不可能绕过）⇒ 一个文件里对同一个安全性质有两套门槛口径，
 * 这本身就是缺陷。现在两边都是"默认拒绝"。
 *
 * ## 判据为什么是"有没有 publishAt 子句"而不是"两个 filter 逐字相等"
 * `visiblePublishFilter()` 里带**墙上时钟**（`publishAt: { $lte: new Date() }`）⇒
 * 两次调用只要跨过一个毫秒，两个 filter 就不逐字相等。本仓库已栽过两次
 * （一次是既有安全守卫偶发红、症状与负载假红完全一致，差点被永久豁免）。
 * 所以这里一律用**存在性**判据（`hasPublishFilter`），从不比较 filter 全文。
 *
 * ## 替身的忠实性
 * `createCapturingModel` 复刻真实调用链 `findOne(query, projection).exec()`（少一层 `exec` 就会抛
 * TypeError，那会看起来像产品缺陷）。形状取自同目录 `article.provider.publishAt.spec.ts` 里
 * 已验证过的那份（它是模块私有的、没有导出，所以这里复刻而不是 import；下面有一条自检
 * 断言"替身确实被调用过"，防止替身悄悄失真后所有断言变成空转）。
 */

function hasPublishFilter(query: any): boolean {
  const json = JSON.stringify(query ?? null);
  return json.includes('"publishAt"') && json.includes('$lte');
}

function createCapturingModel(docs: any[] = []) {
  const captured: { method: string; query: any; projection: any }[] = [];
  const model: any = function FakeModel(dto: any) {
    Object.assign(this, dto);
    (this as any).save = async () => this;
  };
  model.findOne = (query: any, projection?: any) => {
    captured.push({ method: 'findOne', query, projection });
    const hit = docs[0] || null;
    return { exec: async () => (hit ? { ...hit } : null) };
  };
  model.find = (query: any, projection?: any) => {
    captured.push({ method: 'find', query, projection });
    const chain: any = {
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      exec: async () => docs.map((d) => ({ ...d })),
    };
    return chain;
  };
  model.countDocuments = () => ({ exec: async () => docs.length });
  model.aggregate = () => ({ allowDiskUse: () => ({ exec: async () => [] }) });
  model.updateOne = () => ({ exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) });
  model.deleteOne = () => ({ exec: async () => ({ deletedCount: 1 }) });
  model.bulkWrite = () => ({ exec: async () => ({ ok: 1 }) });
  return { model, captured };
}

function createProvider(model: any) {
  return new ArticleProvider(
    model,
    { find: () => ({ exec: async () => [] }) } as any,
    { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
    {} as any,
  );
}

/**
 * 只剥注释、**保留字符串字面量**。
 * ⚠️ 剥多少取决于要断言什么：钉"类型声明的形状"必须保留字符串（`ArticleView` 的成员
 * 本身就是字符串字面量，连字符串一起剥会让断言恒假 —— 本仓库踩过这个坑）；
 * 而钉"代码里还有没有某个正向判断"则要剥掉注释，否则为解释这个坑而写的注释会自己触发断言。
 */
function stripCommentsOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j += 1;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function readSource(): string {
  return fs.readFileSync(path.join(__dirname, 'article.provider.ts'), 'utf8');
}

function unionMembers(stripped: string): string[] {
  const m = stripped.match(/export type ArticleView = ([^;]+);/);
  expect(m).not.toBeNull();
  return (m as RegExpMatchArray)[1]
    .split('|')
    .map((x) => x.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

function registryEntries(stripped: string): { keys: string[]; block: string } {
  const start = stripped.indexOf('const VIEW_SKIPS_PUBLISH_FILTER');
  expect(start).toBeGreaterThan(-1);
  const braceOpen = stripped.indexOf('{', start);
  const braceClose = stripped.indexOf('};', braceOpen);
  expect(braceOpen).toBeGreaterThan(-1);
  expect(braceClose).toBeGreaterThan(braceOpen);
  const block = stripped.slice(braceOpen + 1, braceClose);
  const keys = [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]);
  return { keys, block };
}

/** 取出某个方法的函数体（按大括号配平），用于把断言限制在该方法内。 */
function methodBody(stripped: string, signature: string): string {
  const start = stripped.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const braceOpen = stripped.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < stripped.length; i += 1) {
    if (stripped[i] === '{') depth += 1;
    else if (stripped[i] === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(braceOpen, i + 1);
    }
  }
  throw new Error('unbalanced braces for ' + signature);
}

const VIEWS = ['admin', 'public', 'list', 'listSlim', 'tagsOnly'] as const;

/** 登记表里"跳过过滤"的成员（与产品代码保持一致；下面有一条守卫钉住两边同步）。 */
const EXPECTED_SKIP = new Set(['admin', 'list']);

describe('单文档读的 publish 过滤：默认拒绝（未登记的 view 一律过滤）', () => {
  it('替身自检：getById/getByPathName 确实各发了一次 findOne（否则下面的断言全是空转）', async () => {
    const { model, captured } = createCapturingModel([]);
    const p = createProvider(model);
    await p.getById(1, 'public');
    await p.getByPathName('some-pathname', 'public');
    const ones = captured.filter((c) => c.method === 'findOne');
    expect(ones.length).toBe(2);
    // 真实链路是 findOne(query, projection).exec() ⇒ 投影必须真的传下去了
    expect(ones[0].projection).toBeTruthy();
    expect(ones[1].projection).toBeTruthy();
  });

  it('尺子有效性：hasPublishFilter 分得清"有过滤"与"没过滤"', () => {
    expect(hasPublishFilter({ $and: [{ publishAt: { $lte: new Date() } }] })).toBe(true);
    expect(hasPublishFilter({ $and: [{ deleted: false }] })).toBe(false);
    expect(hasPublishFilter(null)).toBe(false);
    expect(hasPublishFilter(undefined)).toBe(false);
  });

  it('🔴 五个登记视图 × 两个入口：过滤与否逐个符合登记表', async () => {
    for (const view of VIEWS) {
      const a = createCapturingModel([]);
      await createProvider(a.model).getById(1, view);
      const gotA = hasPublishFilter(a.captured[0]?.query);
      expect({ view, method: 'getById', hasFilter: gotA }).toEqual({
        view,
        method: 'getById',
        hasFilter: !EXPECTED_SKIP.has(view),
      });

      const b = createCapturingModel([]);
      await createProvider(b.model).getByPathName('p', view);
      const gotB = hasPublishFilter(b.captured[0]?.query);
      expect({ view, method: 'getByPathName', hasFilter: gotB }).toEqual({
        view,
        method: 'getByPathName',
        hasFilter: !EXPECTED_SKIP.has(view),
      });
    }
  });

  it("公开视图必须带过滤（这是匿名详情读的唯一入口）", async () => {
    const { model, captured } = createCapturingModel([]);
    await createProvider(model).getByIdOrPathname('p', 'public');
    expect(captured.length).toBeGreaterThan(0);
    expect(hasPublishFilter(captured[0].query)).toBe(true);
  });

  it('🔴 核心：未登记的 view（any 强转 / JS 调用方 / 将来新增）一律**加过滤**', async () => {
    const bogus = ['__probe_view__', '', 'PUBLIC', 'Admin', 'adminView', 'listview'];
    for (const v of bogus) {
      const a = createCapturingModel([]);
      await (createProvider(a.model) as any).getById(1, v);
      expect({ bogus: v, hasFilter: hasPublishFilter(a.captured[0]?.query) }).toEqual({
        bogus: v,
        hasFilter: true,
      });

      const b = createCapturingModel([]);
      await (createProvider(b.model) as any).getByPathName('p', v);
      expect({ bogus: v, hasFilter: hasPublishFilter(b.captured[0]?.query) }).toEqual({
        bogus: v,
        hasFilter: true,
      });
    }
    // undefined / null 同样必须落在"加过滤"这一侧
    for (const v of [undefined, null]) {
      const c = createCapturingModel([]);
      await (createProvider(c.model) as any).getById(1, v);
      expect(hasPublishFilter(c.captured[0]?.query)).toBe(true);
    }
  });

  it('🔴 登记表覆盖 union 的每一个成员，且不多不少（新成员未登记 ⇒ 编译期就红）', () => {
    const stripped = stripCommentsOnly(readSource());
    const members = unionMembers(stripped);
    const { keys } = registryEntries(stripped);
    // 反空转：union 真的有 5 个成员，解析器没有解析出一个空集合
    expect(members.length).toBe(5);
    expect(keys.length).toBe(5);
    expect([...members].sort()).toEqual([...keys].sort());
    // 双向：任何一个方向漏了都要红
    for (const m of members) expect(keys).toContain(m);
    for (const k of keys) expect(members).toContain(k);
  });

  it('🔴 登记表的内容与本 spec 的预期一致（改产品代码必须同时改这里，反之亦然）', () => {
    const stripped = stripCommentsOnly(readSource());
    const { block } = registryEntries(stripped);
    for (const v of VIEWS) {
      const m = block.match(new RegExp('^\\s*' + v + '\\s*:\\s*(true|false)\\s*,?\\s*$', 'm'));
      expect({ view: v, declared: m ? m[1] : null }).toEqual({
        view: v,
        declared: EXPECTED_SKIP.has(v) ? 'true' : 'false',
      });
    }
  });

  it('🔴 读取处必须是 === true（表外的值不能被判成"跳过过滤"）', () => {
    const stripped = stripCommentsOnly(readSource());
    const fn = methodBody(stripped, 'function singleDocReadSkipsPublishFilter');
    expect(fn).toMatch(/VIEW_SKIPS_PUBLISH_FILTER\[view\] === true/);
  });

  it('🔴 两个单文档入口都走登记表，且方法体内不再有正向的公开视图判断', () => {
    const stripped = stripCommentsOnly(readSource());
    for (const sig of [
      'async getByPathName(pathname: string, view: ArticleView)',
      'async getById(id: number | string, view: ArticleView)',
    ]) {
      const body = methodBody(stripped, sig);
      expect({ sig, usesRegistry: body.includes('singleDocReadSkipsPublishFilter(view)') }).toEqual({
        sig,
        usesRegistry: true,
      });
      // 正向判断的形状是"等于公开视图才过滤"；它一旦回来，默认放行就回来了
      expect(body.includes("=== 'public'")).toBe(false);
    }
  });

  it('⚠️ 详情 payload 增强那一处**故意**保留正向判断（不是安全门，不许"顺手统一"）', () => {
    const stripped = stripCommentsOnly(readSource());
    const body = methodBody(stripped, 'async getByIdOrPathnameWithPreNext(id: string | number, view: ArticleView)');
    // 那一处控制的是 readingMinutes / relatedArticles 这两个**增强字段**要不要加，
    // 失败方向是"少给字段"（安全），与 publish 过滤无关 ⇒ 不能换成登记表。
    expect(body.includes("=== 'public'")).toBe(true);
    expect(body.includes('readingMinutes')).toBe(true);
    expect(body.includes('relatedArticles')).toBe(true);
    expect(body.includes('singleDocReadSkipsPublishFilter')).toBe(false);
  });

  it('🔴 解锁口的两道显式检查仍在（过滤器帮不到它，靠这两道挡）', () => {
    const stripped = stripCommentsOnly(readSource());
    const body = methodBody(stripped, 'async getByIdWithPassword(id: number | string, password: string)');
    expect(body.includes('isFuturePublish(article.publishAt)')).toBe(true);
    expect(body.includes('if (article.hidden)')).toBe(true);
    // 它用 admin 视图取文（要读 password/private），所以登记表里 admin 是 true
    expect(body.includes("'admin'")).toBe(true);
  });
});
