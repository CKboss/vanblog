const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const core = require('../../src/components/RecycleBin/recycleCore');

/**
 * 草稿回收站的核心风险（server 侧明确指出的 footgun）：
 * **发布草稿成功 ⇒ 草稿被软删除进回收站**（既有上游语义）。于是回收站里
 * 「误删的草稿」和「发布后归档的草稿」混在一起，而 payload（id,title,category,
 * tags,author,createdAt,updatedAt,deletedAt）**没有任何字段能可靠区分两者**。
 * 恢复「发布归档」的草稿不会碰已发布的文章，只会复活一份发布前的旧草稿 ——
 * 所有文案必须对两种情况都说真话，UI 不许暗示「恢复=撤销发布」或只按误删场景承诺。
 */
describe('草稿回收站文案：对「误删」与「发布归档」两种情况都必须说真话', () => {
  it('恢复确认说清三件事：只作用于草稿、发布归档也会进回收站、恢复不影响已发布文章', () => {
    assert.equal(core.DRAFT_RESTORE_CONFIRM_TITLE, '确认恢复这个草稿吗？');
    assert.match(core.DRAFT_RESTORE_CONFIRM_TEXT, /恢复只作用于草稿本身/);
    assert.match(core.DRAFT_RESTORE_CONFIRM_TEXT, /发布成功的草稿也会自动进入回收站/);
    assert.match(core.DRAFT_RESTORE_CONFIRM_TEXT, /不会改动已发布的文章/);
    assert.match(core.DRAFT_RESTORE_CONFIRM_TEXT, /发布前的旧草稿/);
    assert.match(core.DRAFT_RESTORE_CONFIRM_TEXT, /重复的文章/);
  });

  it('恢复确认文案里不许出现「只按误删场景」的承诺（回归钉）', () => {
    // 危险文案长这样：「恢复后草稿会回到列表」就完事 —— 对发布归档的草稿是误导。
    // 草稿文案必须同时提到发布归档场景，缺一个关键词就红。
    for (const kw of ['发布', '已发布的文章', '旧草稿']) {
      assert.ok(core.DRAFT_RESTORE_CONFIRM_TEXT.includes(kw), `草稿恢复文案缺少关键说明：${kw}`);
    }
    // 文章版文案与草稿版必须不同（不能共用一句「恢复后回到列表」）
    assert.notEqual(core.DRAFT_RESTORE_CONFIRM_TEXT, core.RESTORE_CONFIRM_TEXT);
  });

  it('空状态解释「发布即归档」，且说明恢复的两种后果', () => {
    assert.match(core.DRAFT_RECYCLE_EMPTY_TEXT, /发布成功后也会自动进入这里/);
    assert.match(core.DRAFT_RECYCLE_EMPTY_TEXT, /恢复只作用于草稿本身/);
    assert.match(core.DRAFT_RECYCLE_EMPTY_TEXT, /不会改动已发布的文章/);
  });

  it('恢复成功提示：点名草稿 + 声明已发布文章不受影响', () => {
    const text = core.draftRestoreSuccessText({ title: '草稿A' });
    assert.match(text, /已恢复草稿「草稿A」/);
    assert.match(text, /已发布的文章不受影响/);
    assert.match(text, /发布前的旧草稿/);
    // 坏记录不炸：降级为「(无标题)」
    assert.match(core.draftRestoreSuccessText(null), /已恢复草稿「\(无标题\)」/);
  });

  it('草稿永久删除：明说不可撤销 + 不影响由它发布的文章', () => {
    assert.equal(core.draftPurgeConfirmTitle({ title: '草稿A' }), '永久删除草稿「草稿A」？');
    assert.match(core.DRAFT_PURGE_CONFIRM_CONTENT, /不可撤销/);
    assert.match(core.DRAFT_PURGE_CONFIRM_CONTENT, /不影响那篇已发布的文章/);
    assert.match(core.draftPurgeSuccessText({ title: '草稿A' }), /已永久删除草稿「草稿A」/);
  });
});

describe('草稿回收站数据形状', () => {
  it('drafts 键与契约字段（id,title,category,tags,author,createdAt,updatedAt,deletedAt）', () => {
    const { articles, total } = core.normalizeDeletedList({
      statusCode: 200,
      data: {
        drafts: [
          {
            id: 5,
            title: '未写完的想法',
            category: '随笔',
            tags: ['想法'],
            author: 'me',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            deletedAt: '2026-09-15T00:00:00.000Z',
          },
        ],
        total: 1,
      },
    });
    assert.equal(total, 1);
    assert.equal(articles[0].id, 5);
    assert.equal(articles[0].author, 'me');
    assert.equal(articles[0].deletedAt, '2026-09-15T00:00:00.000Z');
    // 草稿契约没有 wordCount/pathname：归一化后是 null/'' 而不是 undefined
    assert.equal(articles[0].wordCount, null);
    assert.equal(articles[0].pathname, '');
  });
});

describe('草稿回收站入口与相关文案接线（源码断言，已剔除注释）', () => {
  it('草稿管理工具栏有「回收站」按钮，抽屉是 type="draft"，动作后刷新主列表', () => {
    const page = codeOnly(read('src/pages/Draft/index.jsx'));
    assert.match(page, /import RecycleBin from '@\/components\/RecycleBin'/);
    assert.match(page, /key="draftRecycleBinBtn"/);
    assert.match(page, /回收站/);
    assert.match(page, /type="draft"/);
    assert.match(page, /onChanged=\{\(\) => actionRef\?\.current\?\.reload\(\)\}/);
  });

  it('RecycleBin 草稿模式：作者列替换别名/字数列，警示 Alert 常驻', () => {
    const comp = codeOnly(read('src/components/RecycleBin/index.jsx'));
    assert.match(comp, /isDraft\s*\?/);
    assert.match(comp, /data-recycle-draft-warning/);
    const authorIdx = comp.indexOf(`title: '作者'`);
    assert.ok(authorIdx > 0);
    // 警示 description 说清「无法区分误删与发布归档」——这是 server 要求的诚实性
    assert.match(comp, /无法区分「误删」与「发布后归档」/);
  });

  it('草稿列表删除确认说清去向（回收站、可恢复）', () => {
    const cols = codeOnly(read('src/pages/Draft/columes.jsx'));
    assert.match(cols, /删除后草稿会移入本页工具栏的「回收站」/);
    assert.match(cols, /删除成功，已移入回收站（可恢复）/);
  });

  it('发布草稿的成功 toast 说明草稿是「归档进回收站」而不是消失了', () => {
    const modal = codeOnly(read('src/components/PublishDraftModal/index.jsx'));
    assert.match(modal, /发布成功！原草稿已自动移入草稿回收站/);
    assert.match(modal, /恢复它不会影响这篇已发布的文章/);
  });

  it('编辑器删除草稿的确认也指向草稿回收站', () => {
    const editor = codeOnly(read('src/pages/Editor/index.jsx'));
    assert.match(editor, /删除后草稿会移入「草稿管理 → 回收站」/);
    assert.match(editor, /删除草稿成功，已移入回收站（可恢复）/);
  });
});
