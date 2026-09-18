/**
 * 把根目录的 `CHANGELOG.md` 生成文档站的「更新日志」页：`docs/changelog.md`。
 *
 * 用法：`pnpm release-doc`（等价于 `node scripts/releaseDoc.js`），在仓库根目录跑。
 *
 * ## 两件这个脚本**不再**做的事（2026-09 改）
 *
 * 1. ⚠️ 以前它结尾会自动执行：
 *    `git add . && git commit -m 'docs: 更新文档' && git tag doc-<v> && git push --follow-tags origin master && git push --tags`
 *    这三件事都不是"生成一份文档"该做的：
 *    - `git add .` 会把**整个工作树**一起提交（包括你还没想提交的东西）；
 *    - `origin` 在开发环境里指向**上游** `Mereithhh/vanblog`，而本仓库的规矩是只推自己的 fork
 *      `ckboss`、**永不推 origin、不打上游 tag**（见 AGENTS.md「给 AI 代理的额外提示」）；
 *    - 顺带打一个 `doc-<v>` 标签并推出去。
 *    现在只生成文件、bump `doc-version`，然后**打印**接下来该怎么提交，由你自己决定。
 *
 * 2. 直接照抄 CHANGELOG 会产生**死链**：CHANGELOG 里的相对链接是按仓库根写的
 *    （`docs/guide/update.md`、`README.md`、`AGENTS.md`），复制到 `docs/changelog.md` 之后
 *    会变成 `docs/docs/guide/update.md` 这种不存在的路径，`scripts/tests/docs-links.test.sh`
 *    会红。所以这里做两次改写：`docs/xxx` → `./xxx`；仓库根的其它 `.md` → GitHub 上的绝对地址。
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const GH_BLOB = 'https://github.com/CKboss/vanblog/blob/dev/dsh/';

const FRONT_MATTER = `---
title: 更新日志
icon: clock
order: 8
redirectFrom: /ref/changelog.html
---
`;

function rewriteLinksForDocsSite(body) {
  // 1) 文档站内部链接：docs/xxx.md → ./xxx.md（docs/changelog.md 与它们同级目录树的根）
  let out = body.replace(/\]\(docs\//g, '](./');
  // 2) 仓库根的 .md（README / CHANGELOG / AGENTS …）不在文档站里 → 改成 GitHub 绝对地址
  out = out.replace(/\]\((?!https?:\/\/|#|mailto:|\.\/)([^)/#\s]+\.md)/g, `](${GH_BLOB}$1`);
  return out;
}

function main() {
  const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
  const outPath = path.join(REPO_ROOT, 'docs', 'changelog.md');
  const docVersionPath = path.join(REPO_ROOT, 'doc-version');

  const log = fs.readFileSync(changelogPath, { encoding: 'utf-8' });
  const body = rewriteLinksForDocsSite(log.replace('# Changelog', '', 1));
  fs.writeFileSync(outPath, FRONT_MATTER + body, { encoding: 'utf-8' });

  // doc-version：文档修订号（三段，最后一段自增）。以前它同时被用来打 doc-<v> 标签，
  // 现在只是记录"文档站内容更新过多少次"。
  let version = fs.readFileSync(docVersionPath, { encoding: 'utf-8' }).split('\n')[0].trim();
  const arr = version.split('.');
  arr.push(String(parseInt(arr.pop(), 10) + 1));
  const newVersion = arr.join('.');
  fs.writeFileSync(docVersionPath, newVersion + '\n', { encoding: 'utf-8' });

  const bytes = fs.statSync(outPath).size;
  console.log(`已生成 docs/changelog.md（${bytes} 字节），doc-version: ${version} → ${newVersion}`);
  console.log('');
  console.log('接下来自己提交（这个脚本不再替你 git add/commit/tag/push）：');
  console.log('  bash scripts/tests/docs-links.test.sh        # 死链守卫，必须 5/5');
  console.log('  (cd docs && pnpm run docs:build)             # 文档站构建');
  console.log('  git add docs/changelog.md doc-version');
  console.log("  git commit -m 'docs(changelog): regenerate the docs-site changelog page'");
  console.log('  git push ckboss dev/dsh                      # ⚠️ 推自己的 fork，不要推 origin（上游）');
}

main();
