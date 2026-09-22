/**
 * 把根目录的 `CHANGELOG.md` 生成文档站的「更新日志」页：`docs/changelog.md`。
 *
 * 用法：`pnpm release-doc`（等价于 `node scripts/releaseDoc.js`），在仓库根目录跑。
 *
 * ## `--out <file>`：只生成、不落地（2026-09-22 加）
 *
 * 🔴 **为什么需要它**：`docs/changelog.md` 是本脚本的产物，而 `scripts/tests/docs-consistency.test.sh`
 *    **刻意排除了它**（镜像会按设计重写链接，与根 `CHANGELOG.md` 永远不会逐字节相同）
 *    ⇒ **两者不同步不会有任何东西变红**。本周期已经因此出过一次事故：一次 python 编辑 `assert` 失败
 *    ⇒ 根文件根本没被写，而同一条命令链里后面的本脚本**照跑** ⇒ 产生了一个**假的 `doc-version` bump**。
 *    要加一条"镜像与根文件同步"的守卫，唯一可靠的判定办法是**真的跑一次生成器再比对**，
 *    而生成器默认会写 `docs/changelog.md` 与 `doc-version` ⇒ **守卫本身会有副作用**。
 *    `--out` 就是为解开这个自指而加的：把内容写到指定路径，**一个字节都不碰仓库**。
 *
 * ⚠️ **默认行为（不带参数）必须逐字节不变** —— 它被 `scripts/tests/changelog-mirror-sync.test.sh` 钉着。
 * 🔴 **参数错误一律 fail-loud（退出码 9）**，绝不静默回退到默认行为：静默回退会让守卫以为
 *    "我验过了"，而实际上它验的是"生成器又把仓库改了一遍"。
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

// 🔴 抽出来的唯一原因：`--out` 模式与默认模式必须生成**完全相同**的内容，
//    否则"用 --out 比对"验的就不是真实产物。默认路径的写盘顺序与输出文案一律未改。
function buildMirrorContent() {
  const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
  const log = fs.readFileSync(changelogPath, { encoding: 'utf-8' });
  return FRONT_MATTER + rewriteLinksForDocsSite(log.replace('# Changelog', '', 1));
}

// 解析参数。🔴 任何不认识的形状都 exit 9（fail-loud），绝不静默回退到默认行为。
function parseArgs(argv) {
  const args = argv.slice(2);
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--out') {
      const v = args[i + 1];
      // ⚠️ 以 `-` 开头的"值"一律当成缺值：合法的目标路径不会这么写，
      //    而把它当文件名会让后面的 shell 用法出各种意外。
      if (v === undefined || v === '' || v.startsWith('-')) {
        console.error('错误：--out 需要一个目标文件路径（例如 --out /tmp/mirror.md）');
        process.exit(9);
      }
      outPath = v;
      i += 1;
    } else if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (v === '' || v.startsWith('-')) {
        console.error('错误：--out= 后面需要一个目标文件路径（例如 --out=/tmp/mirror.md）');
        process.exit(9);
      }
      outPath = v;
    } else {
      console.error(`错误：未知参数 ${a}（本脚本只认 --out <file>；不带参数就是原来的行为）`);
      process.exit(9);
    }
  }
  return { outPath };
}

function main() {
  const { outPath } = parseArgs(process.argv);

  // 🔴 --out 模式：只写指定路径，**不碰 docs/changelog.md、不碰 doc-version**。
  //    写失败（目录不存在、不可写）时 fs 会抛 ⇒ 非 0 退出，🔴 不静默回退。
  if (outPath !== null) {
    const content = buildMirrorContent();
    fs.writeFileSync(outPath, content, { encoding: 'utf-8' });
    console.log(`已把镜像内容写到 ${outPath}（${Buffer.byteLength(content, 'utf-8')} 字节）；未改 docs/changelog.md，也未改 doc-version。`);
    return;
  }

  const outPathDefault = path.join(REPO_ROOT, 'docs', 'changelog.md');
  const docVersionPath = path.join(REPO_ROOT, 'doc-version');

  const content = buildMirrorContent();
  fs.writeFileSync(outPathDefault, content, { encoding: 'utf-8' });

  // doc-version：文档修订号（三段，最后一段自增）。以前它同时被用来打 doc-<v> 标签，
  // 现在只是记录"文档站内容更新过多少次"。
  let version = fs.readFileSync(docVersionPath, { encoding: 'utf-8' }).split('\n')[0].trim();
  const arr = version.split('.');
  arr.push(String(parseInt(arr.pop(), 10) + 1));
  const newVersion = arr.join('.');
  fs.writeFileSync(docVersionPath, newVersion + '\n', { encoding: 'utf-8' });

  const bytes = fs.statSync(outPathDefault).size;
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
