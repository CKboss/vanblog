const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');
/**
 * 断言前剔除注释：新代码的注释里正好引用了旧写法（"以前这里写的是 …"），
 * 不剥掉的话 doesNotMatch 会被自己的注释满足 —— 这个坑本仓库已经踩过七次了。
 */
const code = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

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
  it('siteInfo 类型里有 uiStyle，且放宽成 string（要能放自定义主题 id）', () => {
    const dto = readRepo('packages/server/src/types/site.dto.ts');
    assert.match(dto, /uiStyle\?: string;/);
    // default / apple 仍然是内置的两个，文档注释里要写清楚
    assert.match(dto, /自定义主题 id/);
  });

  it('getSiteInfo 保留自定义主题 id，缺省仍是 apple', () => {
    const provider = code(readRepo('packages/server/src/provider/meta/meta.provider.ts'));
    // ⚠️ 不能再用「非 default 一律压成 apple」那种写法，否则上传的主题一启用就被吃掉
    assert.doesNotMatch(provider, /uiStyle: siteInfo\.uiStyle === 'default' \? 'default' : 'apple'/);
    assert.match(provider, /uiStyle: String\(siteInfo\.uiStyle \?\? ''\)\.trim\(\) \|\| 'apple'/);
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
