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

describe('后台「关于」页只讲当前这个版本，同时保留对原始项目的署名', () => {
  const src = code(read('packages/admin/src/pages/About.tsx'));

  it('本仓库的仓库 / Issue / 日志 / 文档都在', () => {
    assert.match(src, /https:\/\/github\.com\/CKboss\/vanblog/);
    assert.match(src, /dev\/dsh/); // 只用于拼仓库里文档/日志的链接地址
    assert.match(src, /FORK_ISSUES/);
    assert.match(src, /FORK_CHANGELOG/);
    assert.match(src, /FORK_DOCS/);
    // 「提交BUG」必须指向本仓库的 issues，不能把本版本的问题报到上游去
    const issueHref = src.match(/href=\{FORK_ISSUES\}/);
    assert.ok(issueHref, '提交BUG 要指向本仓库 issues');
  });

  it('不拿"上游 vs 本分支"当叙事，也**不许断言运行中的是某个分支**', () => {
    // 站长定的口径：只说当前这个版本的事。而"跑的是 dev/dsh 分支"这句与同页的版本标签
    // 并排矛盾 —— 发布镜像里标签是 `v2026.9.2@23f2e9c` 这类 tag+commit，只有源码构建才是分支。
    // ⚠️ 钉的是"分支名没有被当成文本渲染出来"，不是钉某句话的措辞（否则每次改文案都红）。
    assert.doesNotMatch(src, /<Tag[^>]*>\s*\{FORK_BRANCH\}/);
    assert.doesNotMatch(src, /\{FORK_BRANCH\}\s*<\/Tag>/);
    // 版本这件事交给同页的版本标签：文案必须把用户指过去
    assert.match(src, /版本标签/);
    // 反馈渠道指向本仓库
    assert.match(src, /本仓库/);
    // 增强点里不许再写死"第 N 轮"（每加一轮就得改一次数字，已经错过一次：写着三轮时其实已经是第四轮+）
    // ⚠️ 正则里的 \s* 是必须的：旧文案写的是「三轮 bug」（数字与"轮"之间没有空格），
    //    只允许空格的版本连旧文本都匹配不上 ⇒ 反证空转，回归照样溜过去（本机实测过这个坑）。
    assert.doesNotMatch(src, /[一二三四五六七八九十0-9]+\s*轮\s*bug/);
    assert.match(src, /多轮 bug 与安全加固/);
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

  it('原始项目的署名、仓库链接、打赏入口与许可证保留（GPL-3.0 要求，也是该有的礼貌）', () => {
    assert.match(src, /原始项目/);
    // ⚠️ 仓库名是 vanblog：旧名 van-blog 现在只是 301 跳过来（实测 301 → Mereithhh/vanblog）
    assert.match(src, /https:\/\/github\.com\/Mereithhh\/vanblog/);
    assert.doesNotMatch(src, /Mereithhh\/van-blog/);
    assert.match(src, /@Mereithhh/);
    assert.match(src, /感谢原作者/);
    assert.match(src, /打赏原作者/);
    assert.match(src, /GPL v3/);
    // 并且提醒上游文档描述的是官方镜像的行为（这句是"不再列上游入口"的前提）
    assert.match(src, /官方镜像/);
    assert.match(src, /与本版本不同/);
  });

  it('打赏链接指向真能落地的锚点（上游 README 已改成英文优先）', () => {
    // 实测：`<上游仓库首页>#打赏` 已经是死锚点 —— 英文 README 那一节叫 Support the project，
    // 中文的 `## 打赏` 在 README.zh-CN.md 里（第 211 行）。死锚点会停在仓库顶部，看着像链接坏了。
    assert.match(src, /README\.zh-CN\.md#%E6%89%93%E8%B5%8F/);
    assert.doesNotMatch(src, /UPSTREAM_REPO\}#%E6%89%93%E8%B5%8F/);
  });

  it('上游的文档站 / 更新日志 / 交流群不再作为入口列出（它们描述的不是这个版本）', () => {
    // 只装了这个版本的新用户点进去读到的是**官方镜像**的行为；"官方交流群"看着还像本版本的支援渠道。
    // ⚠️ 钉的是 **URL 与常量名**，不是标签文字：文案里解释"为什么不列这几个入口"时，
    //    必然会写到"文档站/更新日志/交流群"这些词，钉文字就会假红（本仓库踩过 5 次这个坑）。
    assert.doesNotMatch(src, /vanblog\.mereith\.com/);
    assert.doesNotMatch(src, /changelog\.html/);
    assert.doesNotMatch(src, /jq\.qq\.com/);
    assert.doesNotMatch(src, /UPSTREAM_SITE|UPSTREAM_GROUP|UPSTREAM_CHANGELOG/);
  });

  it('不再有「把本版本的问题指到上游」的链接（提交BUG/案例都改到本仓库）', () => {
    // 上游 issues/new/choose 这个「提交BUG」入口以前出现了两次，现在一次都不该有
    // （写成 van-?blog 是为了不管上游仓库叫什么都能钉住）
    assert.doesNotMatch(src, /Mereithhh\/van-?blog\/issues\/new/);
  });

  it('每个外链都带 rel="noreferrer" 且新窗口打开', () => {
    const externals = src.match(/<a\s+target="_blank"[^>]*>/g) || [];
    // ⚠️ 不再钉外链**数量下限**：那是比实现更严的锚点 —— 增删一个入口就红，
    //    而它真正要保证的是"每个外链都带 noreferrer"。必须保留的入口改成点名检查。
    assert.ok(externals.length > 0, '一个外链都没匹配到，八成是正则没跟上写法');
    for (const tag of externals) {
      assert.match(tag, /rel="noreferrer"/);
    }
    for (const required of [
      'FORK_ISSUES',
      'FORK_CHANGELOG',
      'FORK_DOCS',
      'UPSTREAM_REPO',
      'UPSTREAM_SPONSOR',
    ]) {
      assert.ok(src.includes(`href={${required}}`), `缺少必须保留的入口：${required}`);
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
      // ⚠️ 以前这里对 `pages/About.tsx` 开了豁免（"关于页保留上游文档站入口是刻意的"）。
      // 豁免已经取消：那一页现在也不再链上游文档站了（只保留署名、上游仓库与打赏入口），
      // 所以整个 admin 里一条上游文档深链都不该有 —— 豁免留着就是给下一次回潮留门。
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
