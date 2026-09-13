const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const adminPkg = JSON.parse(read('packages/admin/package.json'));

describe('admin 生产构建的堆内存设置（镜像构建 OOM 的修复）', () => {
  // 背景：Dockerfile 的 admin_builder 里有
  //   ENV NODE_OPTIONS='--max_old_space_size=4096 --openssl-legacy-provider'
  // 但 build 脚本是 `cross-env NODE_OPTIONS=--openssl-legacy-provider umi build`，
  // cross-env 是**整体替换**而不是追加 → --max_old_space_size 被丢掉 →
  // Node 按可用内存启发式给了个很小的堆 → 构建到 ~486MB 就
  // `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`。
  it('build 脚本自己带 --max_old_space_size，不依赖镜像的 ENV', () => {
    const build = adminPkg.scripts.build;
    assert.match(build, /NODE_OPTIONS=/);
    assert.match(build, /--max_old_space_size=\d{3,}/);
    assert.match(build, /--openssl-legacy-provider/);
    // 两个 flag 必须在**同一个** NODE_OPTIONS 赋值里（否则 cross-env 只会保留一个）
    const assigned = build.match(/NODE_OPTIONS=("?)([^"]*)\1/);
    assert.ok(assigned, 'NODE_OPTIONS 赋值解析不出来');
    assert.match(assigned[2], /--openssl-legacy-provider/);
    assert.match(assigned[2], /--max_old_space_size=/);
  });

  it('analyze 脚本同样带内存上限（它跑的是一样的 umi build）', () => {
    assert.match(adminPkg.scripts.analyze, /--max_old_space_size=\d{3,}/);
    assert.match(adminPkg.scripts.analyze, /ANALYZE=1/);
  });

  it('不许退回「只给 openssl-legacy-provider」那种写法', () => {
    assert.notEqual(
      adminPkg.scripts.build,
      'cross-env NODE_OPTIONS=--openssl-legacy-provider umi build',
    );
  });

  it('Dockerfile 保留了 ENV NODE_OPTIONS，并注明它会被 cross-env 覆盖', () => {
    const dockerfile = read('Dockerfile');
    const stage = dockerfile.slice(
      dockerfile.indexOf('AS admin_builder'),
      dockerfile.indexOf('FROM node:18 AS server_builder'),
    );
    assert.match(stage, /ENV NODE_OPTIONS='--max_old_space_size=4096 --openssl-legacy-provider'/);
    // 注释必须留着：不然下一个人会以为改 ENV 就能调构建内存
    assert.match(stage, /cross-env/);
    assert.match(stage, /整体替换/);
  });
});
