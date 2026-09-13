const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  compareVersions,
  isReleaseVersion,
  parseSegments,
  shouldNotifyNewVersion,
} = require('../../src/services/van-blog/version.js');

const adminRoot = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(adminRoot, rel), 'utf8');
const codeOnly = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

describe('版本号判断', () => {
  it('只有正式发布号算 release；源码构建标签一律不算', () => {
    for (const v of ['v0.54.0', '0.54.0', 'v1.2.3-beta.1', '12.0', 'v2.0.0+build.5']) {
      assert.equal(isReleaseVersion(v), true, `${v} 应算发布号`);
    }
    for (const v of ['dev', 'dev/dsh@dd4414a3', 'test-v0.54.0', '', null, undefined, 'main']) {
      assert.equal(isReleaseVersion(v), false, `${v} 不该算发布号`);
    }
  });

  it('取前三段数字，忽略 v 前缀与后缀', () => {
    assert.deepEqual(parseSegments('v0.54.0'), [0, 54, 0]);
    assert.deepEqual(parseSegments('1.2.3-beta.1'), [1, 2, 3]);
    assert.deepEqual(parseSegments('v2'), [2, 0, 0]);
    assert.deepEqual(parseSegments('乱码'), [0, 0, 0]);
  });

  it('按数字段比较：0.9.0 要比 0.10.0 旧（字符串比较会判反）', () => {
    assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
    assert.ok(compareVersions('v0.54.0', '0.54.0') === 0);
    assert.ok(compareVersions('0.55.0', 'v0.54.9') > 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    // 对照：老的字符串比较在这里全都是错的
    assert.equal('0.9.0' >= '0.10.0', true, '字符串比较确实会判反（这正是要修的原因）');
  });

  it('该不该弹横幅：源码构建版本一律不弹（这就是假警报的修复点）', () => {
    assert.equal(shouldNotifyNewVersion('dev/dsh@dd4414a3', 'v0.54.0'), false);
    assert.equal(shouldNotifyNewVersion('dev', 'v0.54.0'), false);
    assert.equal(shouldNotifyNewVersion('v0.54.0', 'v0.54.0'), false);
    assert.equal(shouldNotifyNewVersion('v0.55.0', 'v0.54.0'), false);
    assert.equal(shouldNotifyNewVersion('v0.53.9', 'v0.54.0'), true);
    assert.equal(shouldNotifyNewVersion('0.53.9', 'v0.54.0'), true);
    assert.equal(shouldNotifyNewVersion('v0.54.0', ''), false);
    assert.equal(shouldNotifyNewVersion(undefined, 'v0.54.0'), false);
  });
});

describe('app.jsx 用的是新的判断，而不是字符串比较', () => {
  const app = codeOnly(read('src/app.jsx'));

  it('横幅条件换成 shouldNotifyNewVersion', () => {
    assert.match(app, /if \(shouldNotifyNewVersion\(version, latestVersion\)\) \{/);
    assert.match(app, /import \{ shouldNotifyNewVersion \} from '@\/services\/van-blog\/version'/);
  });

  it('老的字符串比较与 != \'dev\' 判断都不许再出现', () => {
    assert.doesNotMatch(app, /version >= latestVersion/);
    assert.doesNotMatch(app, /version != 'dev'/);
  });
});
