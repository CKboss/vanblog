const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  ANALYSIS_ADMIN_PATH,
  GA_ANALYSIS_FIELD,
  BAIDU_ANALYSIS_FIELD,
} = require('../../src/utils/analysisFields');

const repoRoot = path.join(__dirname, '../../../..');
const formSrc = readFileSync(
  path.join(__dirname, '../../src/components/SiteInfoForm/index.tsx'),
  'utf8',
);
const visitorDocs = readFileSync(path.join(repoRoot, 'docs/features/visitor.md'), 'utf8');
const usageFaq = readFileSync(path.join(repoRoot, 'docs/faq/usage.md'), 'utf8');
const customizingDocs = readFileSync(
  path.join(repoRoot, 'docs/advanced/customizing.md'),
  'utf8',
);
const configDocs = readFileSync(path.join(repoRoot, 'docs/reference/config.md'), 'utf8');

describe('analytics field copy (#350)', () => {
  it('keeps site-info field names aligned with SiteInfo / layout props', () => {
    assert.equal(GA_ANALYSIS_FIELD.name, 'gaAnalysisId');
    assert.equal(BAIDU_ANALYSIS_FIELD.name, 'baiduAnalysisId');
  });

  it('states the GA4 G- measurement ID format and where to paste it', () => {
    assert.match(ANALYSIS_ADMIN_PATH, /站点配置/);
    assert.match(ANALYSIS_ADMIN_PATH, /高级设置/);
    assert.match(GA_ANALYSIS_FIELD.label, /Google Analytics/);
    assert.match(GA_ANALYSIS_FIELD.label, /测量 ID/);
    assert.match(GA_ANALYSIS_FIELD.placeholder, /G-XXXXXXXXX/);
    assert.match(GA_ANALYSIS_FIELD.tooltip, /G-XXXXXXXXX/);
    assert.match(GA_ANALYSIS_FIELD.tooltip, /UA-/);
    assert.match(GA_ANALYSIS_FIELD.tooltip, /大陆|网络|地区/);
    assert.match(GA_ANALYSIS_FIELD.tooltip, /实时/);
    assert.match(GA_ANALYSIS_FIELD.tooltip, /Umami/);
  });

  it('wires SiteInfoForm through the shared field copy', () => {
    // 🔴 期 6 第八批：字段常量改成了**函数版**（模块级常量拿不到 hook ⇒ 消费方注入 t）
    //    ⇒ 锚点从"引用大写常量"换成"调用函数版并把 t 传进去"。性质没放：仍然要求走**共享**字段文案。
    assert.match(formSrc, /gaAnalysisField\(t\)/);
    assert.match(formSrc, /baiduAnalysisField\(t\)/);
    assert.match(formSrc, /name=\{GA\.name\}/);
    assert.match(formSrc, /name=\{BAIDU\.name\}/);
    // 🔴 反证：不许再读 identity 视图（那样文案会永远中文，而且看不出来）
    assert.doesNotMatch(formSrc, /GA_ANALYSIS_FIELD\./);
    assert.doesNotMatch(formSrc, /BAIDU_ANALYSIS_FIELD\./);
    assert.doesNotMatch(formSrc, /label="Google Analysis ID"/);
    assert.doesNotMatch(formSrc, /label="Baidu 分析 ID"/);
  });

  it('documents G- format, mainland no-data, admin path, and Umami via 定制化', () => {
    for (const doc of [visitorDocs, usageFaq, configDocs]) {
      assert.match(doc, /G-XXXXXXXXX/);
      assert.match(doc, /高级设置/);
      assert.match(doc, /测量 ID|Google Analytics/);
    }
    assert.match(usageFaq, /尚未收到数据|没有数据/);
    assert.match(usageFaq, /大陆/);
    assert.match(usageFaq, /实时/);
    assert.match(usageFaq, /Umami/);
    assert.match(visitorDocs, /Umami/);
    assert.match(customizingDocs, /umami/i);
    assert.match(customizingDocs, /data-website-id/);
    assert.match(customizingDocs, /自定义 HTML \(head\)|自定义 HTML（head）|定制化/);
  });
});
