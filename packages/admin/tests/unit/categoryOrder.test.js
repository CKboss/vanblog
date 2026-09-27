const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

describe('admin category order (#152)', () => {
  it('shows 上移 / 下移 and calls reorderCategories', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/pages/DataManage/tabs/Category.jsx'),
      'utf8',
    );
    const api = readFileSync(path.join(__dirname, '../../src/services/van-blog/api.js'), 'utf8');
    // 🔴 期 6 第九批起这些文案走 t() ⇒ 锚点改成**两种形状都认**（硬编码 或 t('<key>', '中文')），性质没放。
    assert.match(src, /title:\s*(t\('[^']+', )?'排序'/);
    assert.match(src, /上移/);
    assert.match(src, /下移/);
    assert.match(src, /data-category-move-up/);
    assert.match(src, /data-category-move-down/);
    assert.match(src, /reorderCategories\(/);
    assert.match(api, /\/api\/admin\/category\/all\/order/);
    assert.match(src, /title:\s*(t\('[^']+', )?'是否隐藏'/);
  });

  it('documents category display order in category docs and FAQ', () => {
    const tagDocs = readFileSync(path.join(__dirname, '../../../../docs/features/tag.md'), 'utf8');
    const faq = readFileSync(path.join(__dirname, '../../../../docs/faq/usage.md'), 'utf8');
    assert.match(tagDocs, /分类排序|上移|下移/);
    assert.match(faq, /如何调整分类显示顺序/);
  });
});
