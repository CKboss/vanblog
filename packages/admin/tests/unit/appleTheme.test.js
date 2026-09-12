const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('Apple 界面风格：后台开关', () => {
  it('站点信息表单里有「界面风格」下拉，两个选项都在', () => {
    const form = read('src/components/SiteInfoForm/index.tsx');
    assert.match(form, /name=\{'uiStyle'\}/);
    assert.match(form, /label="界面风格"/);
    assert.match(form, /apple: 'Apple 风格（推荐）'/);
    assert.match(form, /default: '默认（原卡片风格）'/);
    assert.match(form, /fieldProps=\{\{ defaultValue: 'apple' \}\}/);
    // 说明清楚它只改样式、可随时切回
    assert.match(form, /只改样式不改结构/);
  });
});

describe('Apple 界面风格：服务端', () => {
  it('siteInfo 类型里有 uiStyle，且只有 default/apple 两种', () => {
    const dto = readRepo('packages/server/src/types/site.dto.ts');
    assert.match(dto, /uiStyle\?: 'default' \| 'apple';/);
  });

  it('getSiteInfo 归一化：只有显式 default 才不是 apple（老站点没这个字段也走新风格）', () => {
    const provider = readRepo('packages/server/src/provider/meta/meta.provider.ts');
    assert.match(
      provider,
      /uiStyle: siteInfo\.uiStyle === 'default' \? 'default' : 'apple',/,
    );
  });
});

describe('Apple 界面风格：前台', () => {
  it('皮肤文件存在，且被 globals.css 引入', () => {
    const css = readRepo('packages/website/styles/apple.css');
    assert.ok(css.length > 10000, 'apple.css 应该是一份完整的皮肤');
    assert.match(css, /\[data-ui="apple"\]/);
    assert.match(css, /#0071e3/);
    assert.match(css, /#2997ff/);
    assert.match(
      readRepo('packages/website/styles/globals.css'),
      /@import "\.\/apple\.css";/,
    );
  });

  it('文档写清了风格差异与设计令牌', () => {
    const doc = readRepo('docs/features/config.md');
    assert.match(doc, /## 界面风格（Apple 风格）/);
    assert.match(doc, /developer\.apple\.com\/news/);
    assert.match(doc, /--ap-accent/);
    assert.match(doc, /毛玻璃/);
    assert.match(doc, /发丝线/);
    assert.match(doc, /页首简介条/);
    assert.match(doc, /780px/);
  });
});
