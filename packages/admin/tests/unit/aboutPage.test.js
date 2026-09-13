const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
/** 断言前剔除注释：注释里正好会引用「以前指向上游」这件事 */
const code = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('后台「关于」页指向本分支，同时保留对原始项目的致谢', () => {
  const src = code(read('packages/admin/src/pages/About.tsx'));

  it('本分支的仓库 / 分支 / Issue / 日志 / 文档都在', () => {
    assert.match(src, /https:\/\/github\.com\/CKboss\/vanblog/);
    assert.match(src, /dev\/dsh/);
    assert.match(src, /FORK_ISSUES/);
    assert.match(src, /FORK_CHANGELOG/);
    assert.match(src, /FORK_DOCS/);
    // 「提交BUG」必须指向本分支的 issues，不能把本分支的问题报到上游去
    const issueHref = src.match(/href=\{FORK_ISSUES\}/);
    assert.ok(issueHref, '提交BUG 要指向本分支 issues');
  });

  it('明确标注这是增强修改版，并列出主要增强点', () => {
    assert.match(src, /增强修改版/);
    assert.match(src, /FORK_HIGHLIGHTS/);
    assert.match(src, /GPL v3/);
    // 至少列出这些能力，避免「增强修改版」变成一句空话
    for (const keyword of ['内置评论', 'Markdown 语法', '整站备份', '图片管线', 'SEO', '安装脚本']) {
      assert.ok(src.includes(keyword), `增强点里缺少：${keyword}`);
    }
  });

  it('原始项目的致谢与入口保留（许可要求，也是该有的礼貌）', () => {
    assert.match(src, /原始项目/);
    assert.match(src, /https:\/\/github\.com\/Mereithhh\/van-blog/);
    assert.match(src, /@Mereithhh/);
    assert.match(src, /感谢原作者/);
    assert.match(src, /打赏原作者/);
    // 并且提醒上游文档描述的是官方镜像的行为
    assert.match(src, /官方镜像/);
  });

  it('不再有「把本分支的问题指到上游」的链接（提交BUG/案例都改到本分支）', () => {
    // 上游 issues/new/choose 这个「提交BUG」入口以前出现了两次，现在一次都不该有
    assert.doesNotMatch(src, /Mereithhh\/van-blog\/issues\/new/);
  });

  it('外链都带 rel="noreferrer" 且新窗口打开', () => {
    const externals = src.match(/<a\s+target="_blank"[^>]*>/g) || [];
    assert.ok(externals.length >= 10, `外链数量异常：${externals.length}`);
    for (const tag of externals) {
      assert.match(tag, /rel="noreferrer"/);
    }
  });

  it('后台里不许再有上游文档深链（一半已经 404，且描述的是官方镜像的行为）', () => {
    // 上游文档站改过结构：/feature/basic/editor.html、/feature/advance/collaborator.html、
    // /feature/advance/isr.html、/feature/advance/customizing.html、/feature/basic/comment.html、
    // /guide/https.html 实测全是 404。现在统一指向本分支仓库里的 docs/（与运行的代码同版本）。
    const walk = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.umi' || entry.name === '.umi-production' || entry.name === 'node_modules') {
            continue;
          }
          out.push(...walk(full));
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders = [];
    for (const file of walk(path.join(repoRoot, 'packages/admin/src'))) {
      if (file.endsWith('pages/About.tsx')) {
        continue; // 「关于」页保留上游入口是刻意的（致谢 + 官方文档站）
      }
      const body = code(fs.readFileSync(file, 'utf8'));
      if (/vanblog\.mereith\.com\/[a-z]/.test(body)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('指向本分支文档的链接都真实存在（别把死链换成另一批死链）', () => {
    const base = 'https://github.com/CKboss/vanblog/blob/dev/dsh/';
    const walk = (dir) => {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.umi' || entry.name === '.umi-production' || entry.name === 'node_modules') {
            continue;
          }
          out.push(...walk(full));
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const seen = new Set();
    for (const file of walk(path.join(repoRoot, 'packages/admin/src'))) {
      const body = fs.readFileSync(file, 'utf8');
      for (const m of body.matchAll(new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^"\'\\s)]+)', 'g'))) {
        seen.add(m[1].split('#')[0]);
      }
    }
    assert.ok(seen.size >= 8, `本分支文档链接数量异常：${seen.size}`);
    for (const rel of seen) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, rel)),
        `链接指向的文件不存在：${rel}`,
      );
    }
  });

  it('编辑器里指向文档的链接不再用已失效的上游深链', () => {
    const editor = code(read('packages/admin/src/pages/Editor/index.jsx'));
    assert.doesNotMatch(editor, /vanblog\.mereith\.com\/feature\/basic\/editor\.html/);
    assert.match(editor, /CKboss\/vanblog\/blob\/dev\/dsh\/docs\/features\/editor\.md/);
  });
});
