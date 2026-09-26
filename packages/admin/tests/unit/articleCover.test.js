const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('admin article cover field (#288)', () => {
  it('adds an optional 题头图 field on new / edit article meta', () => {
    const field = read('src/components/CoverImageField/index.jsx');
    const update = read('src/components/UpdateModal/index.tsx');
    const create = read('src/components/NewArticleModal/index.jsx');

    // 🔴 期 5 第七批起 `COVER_FIELD` 改成 `coverField(t)` 函数（对象字面量常量的标准接法）
    //    ⇒ 锚点换成新形状（key + zh-CN defaultMessage 一起钉），性质没放
    assert.match(field, /label: t\('cover\.label', '题头图'\)/);
    assert.match(field, /name:\s*'cover'/);
    assert.match(field, /data-article-cover-input/);
    assert.match(field, /data-article-cover-clear/);
    assert.match(field, /\/api\/admin\/img\/upload/);
    assert.match(field, /清除题头图/);

    assert.match(update, /CoverImageField/);
    assert.match(create, /CoverImageField/);
    assert.match(create, /name="coverC"/);
    assert.match(read('src/components/ImportArticleModal/index.jsx'), /CoverImageField/);
  });

  it('imports and exports cover from Markdown Front Matter', () => {
    const parse = read('src/services/van-blog/parseMarkdownFile.jsx');
    assert.match(parse, /attributes\?\.cover \|\| attributes\?\.image/);
    assert.match(parse, /vals\.cover/);
    assert.match(parse, /'cover'/);
  });

  it('documents the optional cover on article, FAQ, and SEO pages', () => {
    const articleDocs = readRepo('docs/features/article.md');
    const faq = readRepo('docs/faq/usage.md');
    const seo = readRepo('docs/advanced/seo.md');
    assert.match(articleDocs, /题头图/);
    assert.match(faq, /如何为文章设置题头图/);
    assert.match(seo, /og:image/);
  });
});
