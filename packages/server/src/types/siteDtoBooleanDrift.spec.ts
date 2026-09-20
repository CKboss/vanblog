import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';

/**
 * 跨包漂移守卫：`SiteInfo` 里那批布尔开关**必须保持字符串字面量类型** `'true' | 'false'`。
 *
 * 为什么：前台（`packages/website`）有 **57 处** `== "true"` / `== "false"` 比较
 * （`grep -rn '== *"true"\|== *"false"' packages/website --include=*.ts --include=*.tsx`，
 * 排除 node_modules 与 .next）。今天它们是对的，因为 DTO 把这些字段声明成字符串字面量、
 * 库里存的也确实是字符串。但**一旦有人把 DTO 改成 `boolean`**，这 57 处会**全部静默失效**：
 * `true == "true"` 是 **false**（松散比较会把两边转成数字：`1 == NaN`）。
 * ⚠️ 而且改成 `===` 也救不了 —— 那只是把"静默失效"变成"永远 false"。
 * 这类改动的诱因很现实：IDE 会提示"为什么布尔开关是字符串"，重构时顺手就改了。
 *
 * 所以这条守卫的作用是：**在 DTO 那一侧改动时立刻报警**，并把"另一侧有 57 处依赖"这个事实
 * 摆在改动人面前。它不阻止迁移，只阻止"无声地迁移一半"。
 */
const DTO_PATH = resolve(__dirname, 'site.dto.ts');
const WEBSITE_ROOT = resolve(__dirname, '../../../website');

/** 必须是字符串字面量类型的字段（逐个从 DTO 里核出来的，不是猜的） */
const STRING_BOOLEAN_FIELDS = [
  'enableComment',
  'showSubMenu',
  'showAdminButton',
  'showDonateInfo',
  'showCopyRight',
  'showDonateButton',
  'showDonateInAbout',
  'allowOpenHiddenPostByUrl',
  'enableCustomizing',
  'showRSS',
  'openArticleLinksInNewWindow',
  'showExpirationReminder',
  'showEditButton',
];

function websiteSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = resolve(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('SiteInfo 的字符串布尔字段不许悄悄改成 boolean', () => {
  const dto = readFileSync(DTO_PATH, 'utf-8');

  it.each(STRING_BOOLEAN_FIELDS)('%s 仍声明为 \'true\' | \'false\'', (field) => {
    const re = new RegExp(`^\\s*${field}\\??:\\s*'true'\\s*\\|\\s*'false'\\s*;`, 'm');
    expect({ field, declaredAsStringLiteral: re.test(dto) }).toEqual({
      field,
      declaredAsStringLiteral: true,
    });
  });

  it('尺子有效性反证：把其中一个字段改成 boolean，上面的断言必须抓到', () => {
    // ⚠️ 变异必须**真的发生**：`showRSS` 在 DTO 里不带 `?`，而别的字段带 ⇒
    //    正则要允许可选的 `?`。第一版写死了 `showRSS\?:`，replace 没命中、
    //    于是 `expect(mutated).not.toEqual(dto)` 红 —— 这条断言的价值正在于此：
    //    "变异对照 0 红"必须先排除"变异根本没生效"这个原因。
    const mutated = dto.replace(
      /^(\s*)showRSS(\??):\s*'true'\s*\|\s*'false'\s*;/m,
      '$1showRSS$2: boolean;',
    );
    expect(mutated).not.toEqual(dto); // 变异真的发生了
    const re = /^\s*showRSS\??:\s*'true'\s*\|\s*'false'\s*;/m;
    expect(re.test(dto)).toBe(true); // 改之前尺子能量到
    expect(re.test(mutated)).toBe(false); // 改之后量不到 ⇒ 上面那条 it.each 会红
  });

  it('前台仍然大量使用 == "true" / == "false" 比较（这是本守卫存在的前提）', () => {
    const files = websiteSourceFiles(WEBSITE_ROOT);
    expect(files.length).toBeGreaterThan(20); // 防空转：真的扫到了前台源码
    let hits = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      hits += (text.match(/==\s*["'](true|false)["']/g) || []).length;
    }
    // ⚠️ 阈值写"至少 30"而不是精确 57：新增/删除个别比较不该让这条红，
    //    但如果哪天全部迁移完了（hits 掉到 0），本守卫就该被**有意**删掉，
    //    而不是留着一个恒真的空壳 —— 所以它必须在归零时红。
    expect(hits).toBeGreaterThan(30);
  });
});
