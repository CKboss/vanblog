/**
 * 版本号判断与比较（后台「有新版本」横幅用）。
 *
 * 为什么要有这个文件：原来 app.jsx 里是
 *     if (version && latestVersion && version != 'dev') { if (version >= latestVersion) {} else {弹横幅} }
 * 三个问题：
 * 1. **源码构建的版本号不是 `dev` 而是 `dev/dsh@1a2b3c4`**（本仓库的 vanblog.sh 与 dev-env.sh
 *    都会注入这种标签），于是 `version != 'dev'` 拦不住它；
 * 2. `'dev/dsh@1a2b3c4' >= 'v0.54.0'` 是**字符串比较**，首字符 'd' < 'v' → 结论是「有新版本」，
 *    每次进后台都弹一个假警报；
 * 3. 就算是正式发布号，字符串比较也是错的：`0.9.0` 会被判成比 `0.10.0` 新。
 *
 * 所以现在：只有**两边都是正式发布号**才比较，比较时按数字段逐段比。
 */

/** 正式发布号：`v0.54.0`、`0.54.0`、`v1.2.3-beta.1` 这类；`dev`、`dev/dsh@1a2b3c4`、`test-x` 都不算 */
function isReleaseVersion(version) {
  return /^v?\d+\.\d+/.test(String(version == null ? '' : version).trim());
}

/** 取出前三个数字段（major/minor/patch），忽略 v 前缀与 -beta/+build 之类的后缀 */
function parseSegments(version) {
  const text = String(version == null ? '' : version).trim().replace(/^v/i, '');
  const parts = text.split(/[.\-+]/);
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const n = parseInt(parts[i], 10);
    out.push(Number.isFinite(n) ? n : 0);
  }
  return out;
}

/** a > b 返回正数，a < b 返回负数，相等返回 0 */
function compareVersions(a, b) {
  const pa = parseSegments(a);
  const pb = parseSegments(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

/**
 * 该不该弹「有新版本」横幅。
 * 任一边不是正式发布号就不弹 —— 拿源码构建标签去和 release 比没有任何意义。
 */
function shouldNotifyNewVersion(current, latest) {
  if (!isReleaseVersion(current) || !isReleaseVersion(latest)) {
    return false;
  }
  return compareVersions(current, latest) < 0;
}

module.exports = { isReleaseVersion, parseSegments, compareVersions, shouldNotifyNewVersion };
