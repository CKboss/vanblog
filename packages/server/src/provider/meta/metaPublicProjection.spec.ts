import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Logger } from '@nestjs/common';

import { DEFAULT_ARTICLES_PER_PAGE } from 'src/utils/articlesPerPage';

import { MetaProvider, PUBLIC_SITE_INFO_FIELDS, projectPublicSiteInfo } from './meta.provider';

/**
 * 匿名 `/api/public/meta` 的 `siteInfo` **白名单投影**守卫。
 *
 * 修复前的形状是 `{ ...(metaDoc?.siteInfo || {}) }` 全量展开，而写入侧是
 * `nextSiteInfo = { ...oldSiteInfo, ...updateDto }` ⇒ **任何被写进 siteInfo 的键都自动匿名可读**，
 * 新增字段时没有人需要"决定它是否公开"，默认就是公开。
 * `UpdateSiteInfoDto` 又是 `Partial<SiteInfo> | Partial<updateUserDto>`（后者含 `username`/`password`），
 * 而 `updateSiteInfo` 只剥了 `name` 与 `password`、**没剥 `username`** ⇒ 一次带 `username` 的后台 PUT
 * 就能把管理员用户名写进 siteInfo 并公开出去。
 *
 * 实测证据（一份恢复了真实生产数据的栈）：`siteInfo` 有 19 个键，其中恰好一个前台不用 ——
 * `allowOpenHiddenPostByUrl='false'`。它对攻击者是有价值的侦察信息：值为 `'true'` 就等于告诉对方
 * "枚举文章 id / 路径就能拿到隐藏正文"。
 */

/** 前台实际读取的字段（与白名单必须一致；下面有一条守卫用 grep 持续核对） */
const WEBSITE_ROOT = resolve(__dirname, '../../../../website');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.umi' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(spec|test)\.(ts|tsx)$/.test(entry) &&
      !full.includes('__tests__')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** 前台源码里所有 `siteInfo.x` / `siteInfo?.x` 的字段名 */
function collectWebsiteSiteInfoFields(): Set<string> {
  const fields = new Set<string>();
  for (const file of walk(WEBSITE_ROOT)) {
    const src = readFileSync(file, 'utf8');
    const re = /siteInfo\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      fields.add(m[1]);
    }
  }
  return fields;
}

function makeProvider(siteInfo: Record<string, unknown>) {
  const provider: any = Object.create(MetaProvider.prototype);
  const warn = jest.fn();
  const debug = jest.fn();
  provider.logger = { log: jest.fn(), warn, error: jest.fn(), debug, verbose: jest.fn() };
  // `getPublicSiteInfo()` 取**原始** siteInfo（与控制器同源），`updateSiteInfo()` 取 `getSiteInfo()`
  provider.getAll = jest.fn(async () => ({ siteInfo }));
  provider.getSiteInfo = jest.fn(async () => siteInfo);
  provider.metaModel = { updateOne: jest.fn(async () => ({ acknowledged: true })) };
  return { provider, warn, debug };
}

/** 一份"什么都往里塞"的 siteInfo：包含前台要的全部字段，外加三个不该公开的 */
function noisySiteInfo(extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {};
  for (const field of PUBLIC_SITE_INFO_FIELDS) {
    base[field] = `value-of-${field}`;
  }
  return {
    ...base,
    // 服务端内部开关：前台不读，但对攻击者有侦察价值
    allowOpenHiddenPostByUrl: 'true',
    // 凭据类：任何情况下都不该出现在匿名响应里
    username: 'JiangOil',
    password: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    name: 'admin',
    // 将来某天有人新加的字段：默认必须是**私有**
    futureInternalField: 'should-not-leak',
    ...extra,
  };
}

describe('公开 siteInfo 投影：白名单之外的字段一律不下发', () => {
  it('白名单里的字段原样保留（前台不会因为收口而缺数据）', async () => {
    const input = noisySiteInfo();
    const { provider } = makeProvider(input);
    const projected = await provider.getPublicSiteInfo();
    for (const field of PUBLIC_SITE_INFO_FIELDS) {
      if (field === 'articlesPerPage') {
        // 唯一会被**夹取**的字段（修复前就在展开之外单独净化，属既有契约）
        expect(projected[field]).toBeDefined();
        continue;
      }
      expect(projected[field]).toBe(input[field]);
    }
    expect(Object.keys(projected)).toHaveLength(PUBLIC_SITE_INFO_FIELDS.length);
  });

  it('🔴 内部开关与凭据类字段被挡掉（含"将来新加的字段默认私有"）', async () => {
    const { provider } = makeProvider(noisySiteInfo());
    const projected = await provider.getPublicSiteInfo();
    for (const forbidden of [
      'allowOpenHiddenPostByUrl',
      'username',
      'password',
      'name',
      'futureInternalField',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(projected, forbidden)).toBe(false);
    }
    // 值也不许以任何形式出现在序列化结果里
    const json = JSON.stringify(projected);
    expect(json).not.toContain('JiangOil');
    expect(json).not.toContain('scrypt$');
    expect(json).not.toContain('should-not-leak');
  });

  it('未在白名单里的字段会 WARN 一次（每进程每字段一次，不在热路径刷日志）', async () => {
    // ⚠️ "每字段一次"的去重集合是**模块级**的，跨用例共享 ⇒ 这里必须用本用例独有的字段名，
    //    否则前面的用例已经把这些字段消费掉，WARN 计数会是 0（我第一版就这么栽了）。
    // ⚠️ WARN 现在走**模块级 logger**（投影是纯函数，控制器直接调它、拿不到 provider 的
    //    logger），所以要 spy 在 Logger.prototype 上，而不是假 provider 的 logger 上。
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const probeA = `warnProbeA${Date.now()}`;
    const probeB = `warnProbeB${Date.now()}`;
    const { provider } = makeProvider(
      noisySiteInfo({ [probeA]: 'a', [probeB]: 'b', allowOpenHiddenPostByUrl: 'true' }),
    );
    const projected = await provider.getPublicSiteInfo();
    const texts = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes(probeA))).toBe(true);
    expect(texts.some((t) => t.includes(probeB))).toBe(true);
    // WARN 里要写清"怎么改成公开"，否则运维不知道下一步做什么
    expect(texts.join('\n')).toContain('PUBLIC_SITE_INFO_FIELDS');
    // 被挡掉的字段一个都不许出现在投影结果里
    expect(Object.prototype.hasOwnProperty.call(projected, probeA)).toBe(false);
    // 再调一次：同名字段不重复 WARN（去重生效）
    const before = warnSpy.mock.calls.length;
    await provider.getPublicSiteInfo();
    expect(warnSpy.mock.calls.length).toBe(before);
    warnSpy.mockRestore();
  });

  it('🔴 siteInfo 整个缺失时仍然返回对象，且 articlesPerPage 是默认值（既有契约 #207）', async () => {
    // 修复前控制器的形状是 `{ ...(siteInfo || {}), articlesPerPage: sanitize(...) }`
    // —— articlesPerPage 在展开**之外**补，所以它一定存在。投影必须保持这一点，
    // 否则前台分页拿到 undefined，会与站点设置脱钩。
    const { provider } = makeProvider(undefined as any);
    provider.getAll = jest.fn(async () => ({}));
    const projected = await provider.getPublicSiteInfo();
    expect(projected).toBeDefined();
    expect(typeof projected).toBe('object');
    expect(projected!.articlesPerPage).toBe(DEFAULT_ARTICLES_PER_PAGE);
  });

  it('与控制器路径同源：provider 方法与纯函数给出**完全相同**的键集合（白名单只有一份真相）', async () => {
    const input = noisySiteInfo({ siteName: 'same-source' });
    const { provider } = makeProvider(input);
    const viaProvider = await provider.getPublicSiteInfo();
    const viaPure = projectPublicSiteInfo(input);
    expect(Object.keys(viaProvider!).sort()).toEqual(Object.keys(viaPure!).sort());
    expect(viaProvider!.siteName).toBe(viaPure!.siteName);
    // 且取的是**原始** siteInfo（不走会补默认值的 getSiteInfo），两条路径才不会漂移
    expect(provider.getAll).toHaveBeenCalled();
  });
});

describe('白名单本身的正确性', () => {
  it('🔴 明确排除的字段不许被"顺手"加进白名单', () => {
    const list = PUBLIC_SITE_INFO_FIELDS as readonly string[];
    for (const forbidden of ['allowOpenHiddenPostByUrl', 'username', 'password', 'name']) {
      expect(list).not.toContain(forbidden);
    }
  });

  it('白名单与前台实际用量一致（前台新用了一个字段却没加白名单 ⇒ 这里会红）', () => {
    const used = collectWebsiteSiteInfoFields();
    // 空转反证：扫描本身必须真的扫到东西，否则"一致"是假的
    expect(used.size).toBeGreaterThan(20);
    const list = new Set<string>(PUBLIC_SITE_INFO_FIELDS as readonly string[]);
    const missing = [...used].filter((field) => !list.has(field)).sort();
    if (missing.length > 0) {
      throw new Error(
        `前台在读这些 siteInfo 字段，但它们不在公开白名单里（会导致前台静默缺数据）：\n` +
          `  ${missing.join(', ')}\n` +
          `修法：确认它们确实该公开后加进 meta.provider.ts 的 PUBLIC_SITE_INFO_FIELDS。`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('白名单没有冗余到失去意义（不许把内部字段也塞进来充数）', () => {
    const used = collectWebsiteSiteInfoFields();
    const list = PUBLIC_SITE_INFO_FIELDS as readonly string[];
    // 允许白名单略大于前台用量（例如预留给主题的字段），但不许大出一截
    expect(list.length).toBeLessThanOrEqual(used.size + 8);
    // 且不许有重复项（重复会让"清单长度"这类断言失真）
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('写入侧：updateSiteInfo 不许把凭据字段写进 siteInfo', () => {
  it('username / password / name 三个键都被剥掉（读侧白名单之外的第二道防线）', async () => {
    const { provider } = makeProvider({ siteName: 'old', baseUrl: 'https://old.example/' });
    await provider.updateSiteInfo({
      siteName: 'new',
      // 这三个都是 `UpdateSiteInfoDto` 联合类型里能塞进来的
      username: 'JiangOil',
      password: 'browser-derived-value',
      name: 'admin',
    } as any);
    expect(provider.metaModel.updateOne).toHaveBeenCalledTimes(1);
    const written = provider.metaModel.updateOne.mock.calls[0][1].siteInfo;
    expect(written.siteName).toBe('new');
    for (const forbidden of ['username', 'password', 'name']) {
      expect(Object.prototype.hasOwnProperty.call(written, forbidden)).toBe(false);
    }
    // 旧字段保留（是合并而不是替换）
    expect(written.baseUrl).toBe('https://old.example/');
  });

  it('空转反证：不剥 username 时上面的断言会失败（证明判据有区分力）', async () => {
    // 直接把"旧实现"的解构算一遍，确认它确实会把 username 带进 siteInfo
    const dto: any = { siteName: 'new', username: 'JiangOil', password: 'p', name: 'n' };
    const oldImpl = (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { name, password, ...rest } = dto;
      return rest;
    })();
    expect(Object.prototype.hasOwnProperty.call(oldImpl, 'username')).toBe(true);
    const newImpl = (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { name, password, username, ...rest } = dto;
      return rest;
    })();
    expect(Object.prototype.hasOwnProperty.call(newImpl, 'username')).toBe(false);
  });
});

describe('projectPublicSiteInfo：控制器直接用的**纯函数**（不读库、不多一次往返）', () => {
  it('不依赖任何 provider 状态：传数据进去就出结果', () => {
    const input = noisySiteInfo();
    const out = projectPublicSiteInfo(input);
    expect(out).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(out!, 'username')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out!, 'allowOpenHiddenPostByUrl')).toBe(false);
    expect(out!.siteName).toBe('value-of-siteName');
  });

  it('不改入参（调用方后面还要用原对象写库/派发事件）', () => {
    const input = noisySiteInfo();
    const snapshot = JSON.stringify(input);
    projectPublicSiteInfo(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('🔴 articlesPerPage 的夹取在投影里就做了（调用方不必再单独调 sanitizeArticlesPerPage）', () => {
    const out = projectPublicSiteInfo({ siteName: 'x', articlesPerPage: 999999 });
    // 越界的每页篇数不会原样下发，否则前台一页要渲染十万篇
    expect(out.articlesPerPage).not.toBe(999999);
    expect(typeof out.articlesPerPage).toBe('number');
  });

  it('🔴 除 articlesPerPage 外**不补任何默认值**（补默认值会破坏前台自己的回落逻辑）', () => {
    // uiStyle：前台是 `uiStyle === "apple"` 判定。给"从未设过皮肤"的站点补 'apple'
    // 会让它突然开始预加载 apple 字体 —— 那是行为变更，不是净化。
    const out = projectPublicSiteInfo({ siteName: 'x', uiStyle: '   ' });
    expect(out.uiStyle).toBe('   '); // 原样透传
    expect(Object.prototype.hasOwnProperty.call(projectPublicSiteInfo({ siteName: 'x' }), 'uiStyle')).toBe(
      false,
    );
    // 三段页面文案：库里没有就必须**键都不存在**（#373 的契约），不能变成空串
    const bare = projectPublicSiteInfo({ siteName: 'x' });
    for (const key of ['friendLinkIntro', 'friendLinkApplyContent', 'aboutTitle']) {
      expect(Object.prototype.hasOwnProperty.call(bare, key)).toBe(false);
    }
  });

  it('接受 mongoose 文档形状（有 toObject 就先转），也接受普通对象', () => {
    const docLike = { toObject: () => noisySiteInfo({ siteName: 'from-doc' }) };
    const out = projectPublicSiteInfo(docLike);
    expect(out!.siteName).toBe('from-doc');
    expect(Object.prototype.hasOwnProperty.call(out!, 'password')).toBe(false);
  });

  it('🔴 非对象入参也返回**对象**，且带被夹取过的 articlesPerPage（既有契约 #207）', () => {
    for (const input of [undefined, null, 'x', 42, NaN]) {
      const out = projectPublicSiteInfo(input);
      expect(out).toBeDefined();
      expect(typeof out).toBe('object');
      expect(out!.articlesPerPage).toBe(DEFAULT_ARTICLES_PER_PAGE);
      // 除了这个既有契约键，不该凭空多出任何字段
      expect(Object.keys(out!)).toEqual(['articlesPerPage']);
    }
    // 展开形状与修复前一致（`{ ...(siteInfo || {}) }` ⇒ `{}`，再补 articlesPerPage）
    expect({ ...projectPublicSiteInfo(undefined) }).toEqual({
      articlesPerPage: DEFAULT_ARTICLES_PER_PAGE,
    });
  });

  it('🔴 空对象不产生幽灵键（用 hasOwnProperty 判，`toEqual` 会把 `{a:undefined}` 当 `{}`）', () => {
    const out = projectPublicSiteInfo({});
    expect(Object.keys(out)).toEqual(['articlesPerPage']);
    for (const key of ['friendLinkIntro', 'friendLinkApplyContent', 'aboutTitle', 'uiStyle']) {
      expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(false);
    }
  });

  it('显式空串原样保留（站长主动清空 ≠ 从未设置，两者不能互相转换）', () => {
    const out = projectPublicSiteInfo({
      friendLinkIntro: '',
      friendLinkApplyContent: '',
      aboutTitle: '',
      siteDesc: '',
    });
    expect(Object.prototype.hasOwnProperty.call(out, 'friendLinkIntro')).toBe(true);
    expect(out.friendLinkIntro).toBe('');
    expect(out.aboutTitle).toBe('');
    expect(out.siteDesc).toBe('');
  });

  it('🔴 键集合对齐：投影结果 ⊆ 白名单，且白名单里"库里没有的键"不会凭空出现', () => {
    const stored = { siteName: 'n', baseUrl: 'https://x/', username: 'admin', secretField: 1 };
    const out = projectPublicSiteInfo(stored);
    const allowed = new Set<string>(PUBLIC_SITE_INFO_FIELDS as readonly string[]);
    for (const key of Object.keys(out)) {
      expect(allowed.has(key)).toBe(true);
    }
    // 只有 articlesPerPage 是"库里没有也补"的既有契约键
    expect(Object.keys(out).sort()).toEqual(['articlesPerPage', 'baseUrl', 'siteName']);
  });

  it('provider 方法与纯函数**同源**（白名单只有一份真相，两条路径不会漂移）', async () => {
    const input = noisySiteInfo({ siteName: 'same-source' });
    const { provider } = makeProvider(input);
    const viaProvider = await provider.getPublicSiteInfo();
    const viaPure = projectPublicSiteInfo(input);
    expect(Object.keys(viaProvider!).sort()).toEqual(Object.keys(viaPure!).sort());
    expect(viaProvider!.siteName).toBe(viaPure!.siteName);
  });
});
