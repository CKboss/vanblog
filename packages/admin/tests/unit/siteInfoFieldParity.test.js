const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * 站点设置字段的三处口径对账（2026-09-23 字段级审计的产物）。
 *
 * 背景：`docs/reference/config.md` 文档化的是**后台「站点管理 / 系统设置」的站点配置项**
 * （落库在 `Meta.siteInfo`），**不是** server 的 `config.yaml`（那个文件名的暗示是错的，
 * 曾让一次字段普查扫错对象、只得到 3 个字段）。审计当时手工核出三方是 45 / 45 / 45 的
 * 一一对应，本文件把这个不变量钉住，免得新增一个设置项时只改了两处。
 *
 * 🔴 刻意**不**做「文档 label ↔ DTO 字段名」的逐字段对账：label 是中文散文、字段名是 camelCase，
 * 两者之间没有可机械推导的对应关系，要做就必须在守卫里硬编码一张映射表 —— 那等于**新造一处
 * 会漂移的口径**（本仓库对「同一性质两处口径」已吃过多次亏）。所以这里只对账**能机械推导的**：
 *   ① 表单字段集合 ↔ DTO 字段集合（两侧都是代码，可精确解析）；
 *   ② 文档的字段行数 ↔ DTO 字段数（**只比数量**，作为「加了字段忘了写文档」的绊线）。
 * ②比①弱，但它不需要映射表，因此不会自己腐烂；数量对不上时人会去看是哪一条，这就够了。
 */

/** 断言前剔除注释：注释里常引用旧写法，不剥掉的话 doesNotMatch 会被自己的注释满足。 */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const stripLineComments = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
const code = (src) => stripLineComments(stripBlockComments(src));

/** DTO 侧：`export class SiteInfo { ... }` 里的字段名（含可选的 `?`）。 */
function dtoFields() {
  const src = code(readRepo('packages/server/src/types/site.dto.ts'));
  const start = src.indexOf('export class SiteInfo');
  assert.notEqual(start, -1, 'site.dto.ts 里找不到 export class SiteInfo —— 解析口径失效了');
  const rest = src.slice(start);
  const end = rest.indexOf('export interface updateUserDto');
  assert.notEqual(end, -1, 'site.dto.ts 里找不到 SiteInfo 之后的 updateUserDto —— 类边界口径失效了');
  const body = rest.slice(0, end);
  const names = [...body.matchAll(/^\s{2}([A-Za-z]\w*)\??:/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

/** 表单侧：`name="x"` 与 `name={'x'}` 两种形状，外加从共享常量模块引入的两个统计 ID 字段。 */
function formFields() {
  const form = code(read('src/components/SiteInfoForm/index.tsx'));
  const inline = [...form.matchAll(/name=[{"]'?([A-Za-z]\w*)'?["}]/g)].map((m) => m[1]);
  // gaAnalysisId / baiduAnalysisId 的 name 来自 `@/utils/analysisFields`，不是字面量
  const shared = [];
  if (/GA_ANALYSIS_FIELD/.test(form)) {
    const af = read('src/utils/analysisFields.js');
    const m = af.match(/GA_ANALYSIS_FIELD\s*=\s*Object\.freeze\(\{[\s\S]*?name:\s*'(\w+)'/);
    assert.ok(m, 'analysisFields.js 里解析不出 GA_ANALYSIS_FIELD.name —— 解析口径失效了');
    shared.push(m[1]);
  }
  if (/BAIDU_ANALYSIS_FIELD/.test(form)) {
    const af = read('src/utils/analysisFields.js');
    const m = af.match(/BAIDU_ANALYSIS_FIELD\s*=\s*Object\.freeze\(\{[\s\S]*?name:\s*'(\w+)'/);
    assert.ok(m, 'analysisFields.js 里解析不出 BAIDU_ANALYSIS_FIELD.name —— 解析口径失效了');
    shared.push(m[1]);
  }
  return [...new Set([...inline, ...shared])];
}

/** 文档侧：三张表里的字段行数（排除表头与分隔行）。 */
function docFieldRows() {
  const doc = readRepo('docs/reference/config.md');
  return doc
    .split('\n')
    .filter((line) => /^\|/.test(line.trim()))
    .map((line) => line.trim())
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line)) // 分隔行 |---|---|
    .filter((line) => !line.startsWith('| 设置名称')) // 表头
    .filter((line) => line.split('|').length >= 4); // 至少三列
}

describe('站点设置字段：表单 ↔ DTO ↔ 文档 三方对账', () => {
  it('反空转：三方都真的解析出了东西（否则集合相等会是空的绿）', () => {
    const dto = dtoFields();
    const form = formFields();
    const rows = docFieldRows();
    assert.ok(dto.length >= 40, `DTO 只解析出 ${dto.length} 个字段，疑似解析口径失效`);
    assert.ok(form.length >= 40, `表单只解析出 ${form.length} 个字段，疑似解析口径失效`);
    assert.ok(rows.length >= 40, `文档只解析出 ${rows.length} 行字段，疑似解析口径失效`);
  });

  it('表单里的每个字段都在 SiteInfo DTO 里存在（没有孤儿表单项）', () => {
    const dto = new Set(dtoFields());
    const orphans = formFields().filter((f) => !dto.has(f));
    assert.deepEqual(
      orphans,
      [],
      `表单有而 DTO 没有的字段：${orphans.join(', ')} —— 存进去也不会有类型约束，且服务端读不到`,
    );
  });

  it('SiteInfo DTO 里的每个字段都在表单里可编辑（没有只能在库里手改的设置项）', () => {
    const form = new Set(formFields());
    const unreachable = dtoFields().filter((f) => !form.has(f));
    assert.deepEqual(
      unreachable,
      [],
      `DTO 有而表单没有的字段：${unreachable.join(', ')} —— 用户无法在后台配置它`,
    );
  });

  it('文档的字段行数与 DTO 字段数一致（加了设置项就要写文档）', () => {
    const dtoCount = dtoFields().length;
    const rowCount = docFieldRows().length;
    assert.equal(
      rowCount,
      dtoCount,
      `docs/reference/config.md 有 ${rowCount} 行字段，而 SiteInfo 有 ${dtoCount} 个字段。` +
        '（这里只比数量：label 是中文散文、字段名是 camelCase，两者无法机械对应，' +
        '硬编码一张映射表只会新造一处会漂移的口径。数量对不上时人工看一眼是哪条即可。）',
    );
  });

  it('尺子有效性反证：一个不在 DTO 里的合成字段名必须被上面的对账点名', () => {
    const dto = new Set(dtoFields());
    const synthetic = 'zzFieldThatDoesNotExistInDto';
    assert.ok(!dto.has(synthetic), '合成字段名居然真的存在于 DTO —— 换个名字重做这条反证');
    // 用与上面完全相同的判定逻辑跑一遍，确认它真的会把它算成孤儿
    const orphans = [...formFields(), synthetic].filter((f) => !dto.has(f));
    assert.ok(
      orphans.includes(synthetic),
      '对账逻辑没有把合成字段识别成孤儿 —— 说明上面那条断言是恒真的',
    );
  });

  it('尺子有效性反证：文档行数解析器对分隔行与表头不计数', () => {
    const syntheticDoc = [
      '| 设置名称 | 必填 | 说明 |',
      '| --- | --- | --- |',
      '| 甲 | 是 | 一条 |',
      '| 乙 | 否 | 两条 |',
    ].join('\n');
    const rows = syntheticDoc
      .split('\n')
      .filter((line) => /^\|/.test(line.trim()))
      .map((line) => line.trim())
      .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
      .filter((line) => !line.startsWith('| 设置名称'))
      .filter((line) => line.split('|').length >= 4);
    assert.equal(rows.length, 2, '文档行解析器把表头或分隔行也算成了字段行');
  });
});
