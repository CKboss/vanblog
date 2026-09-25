const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

// 新加的注释里会引用旧写法（否则看不出「以前错在哪」），断言前先把注释行去掉，
// 不然自己匹配自己。
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到起始标记：${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `找不到结束标记：${endMarker}`);
  return text.slice(start, end);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (
      name === '.umi' ||
      name === '.umi-production' ||
      name === 'node_modules' ||
      name === 'dist'
    ) {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
  }
  return out;
}

function createMessageApi() {
  const calls = [];
  return {
    calls,
    error(text) {
      calls.push({ type: 'error', text });
    },
    success(text) {
      calls.push({ type: 'success', text });
    },
  };
}

describe('后台健壮性：请求失败也要把 loading 收掉', () => {
  it('首页三个统计 tab：catch + finally，不再只有 .then()', () => {
    for (const tab of ['overview', 'viewer', 'article']) {
      const code = read(`src/pages/Welcome/tabs/${tab}.jsx`);
      // 只有 .then() 时接口一失败就没人关 Spin，整页永远转圈
      assert.match(
        code,
        /fetchData\(\)\s*\.catch\(\(err\) => reportRequestError\(message, err,/,
        `${tab}.jsx 要有 catch`,
      );
      assert.match(code, /\.finally\(\(\) => setLoading\(false\)\);/, `${tab}.jsx 要有 finally`);
      assert.doesNotMatch(codeOnly(code), /fetchData\(\)\.then\(/);
      assert.match(code, /import \{ message, Spin \} from 'antd';/);
    }
  });

  it('UpdateModal：Editor 传进来的 setLoading 一定会被清掉', () => {
    const code = codeOnly(read('src/components/UpdateModal/index.tsx'));
    // 服务端拒绝（pathname 重复 → 400）时以前直接抛出去，编辑器的 Spin 永远不关
    assert.equal(
      (code.match(/setLoading\(false\)/g) || []).length,
      1,
      'setLoading(false) 只应该出现在 finally 里',
    );
    assert.match(code, /\} finally \{\s*setLoading\(false\);\s*\}/);
    assert.match(code, /reportRequestError\(message, err, '修改失败/);
    // 失败时要让弹窗留着（返回 false），用户改完能直接再提交
    assert.match(code, /\} catch \(err\) \{[\s\S]{0,300}?return false;/);
  });

  it('Code 页：读文件 / 读数据 / 保存（Ctrl+S 也走这条）都有 finally', () => {
    const code = read('src/pages/Code/index.tsx');
    const fetchFileData = slice(
      code,
      'const fetchFileData = async',
      'const fetchData = useCallback',
    );
    assert.match(fetchFileData, /try \{/);
    assert.match(fetchFileData, /reportRequestError\(message, err, '读取文件内容失败！'\)/);
    assert.match(fetchFileData, /\} finally \{\s*setEditorLoading\(false\);\s*\}/);

    const fetchData = slice(code, 'const fetchData = useCallback', 'const handleSave = async');
    assert.match(fetchData, /reportRequestError\(message, err, '获取数据失败！'\)/);
    // 目录树与编辑器两个 loading 都要收
    assert.match(
      fetchData,
      /\} finally \{\s*setTreeLoading\(false\);\s*setEditorLoading\(false\);/,
    );

    const handleSave = slice(code, 'const handleSave = async', 'const actionMenu = (');
    assert.match(handleSave, /reportRequestError\(message, err, '保存失败！'\)/);
    assert.match(handleSave, /\} finally \{\s*setEditorLoading\(false\);\s*\}/);
    assert.equal((code.match(/setEditorLoading\(false\)/g) || []).length, 3);

    // 拉流水线配置以前也没有 catch：失败就是一个未处理的 promise rejection
    assert.match(code, /setPipelineConfig\(data \|\| \[\]\)/);
    assert.match(code, /\.catch\(\(\) => \{\s*setPipelineConfig\(\[\]\);\s*\}\)/);
  });

  it('备份页的旧版 JSON 导出：try/catch/finally + 释放 objectURL', () => {
    const code = read('src/pages/SystemConfig/tabs/Backup.jsx');
    const fn = slice(code, 'const handleOutPut = async () => {', 'const handleFullExport');
    // exportAll 带 skipErrorHandler，全局不弹提示，以前异常直接抛出去 → 卡在 Spin 上
    assert.match(
      fn,
      /try \{[\s\S]*?\} catch \(err\) \{[\s\S]*?\} finally \{\s*setLoading\(false\);/,
    );
    assert.match(fn, /message\.error\('导出失败！'\)/);
    assert.match(fn, /URL\.revokeObjectURL\(url\)/);
    assert.equal((codeOnly(fn).match(/setLoading\(false\)/g) || []).length, 1);
  });

  it('图床页：没有空 catch，导出用的 saveExportArchive 真的有 import', () => {
    const code = read('src/pages/SystemConfig/tabs/ImgTab.jsx');
    // 空 catch 会把 TypeError / 接口失败整个吞掉，用户只看到按钮转完圈什么都没发生
    assert.doesNotMatch(codeOnly(code), /catch\s*(\([^)]*\))?\s*\{\s*\}/);
    // 少 import 时点「导出全部本地图床内容」必然 ReferenceError
    assert.match(
      code,
      /import \{ saveExportArchive \} from '@\/services\/van-blog\/downloadArchive';/,
    );
    // 🔴 性质未变：扫描失败必须走 `reportRequestError` **上报**（三个实参：message / err / 用户可见消息），
    //    而不是被空 catch 吞掉。2026-09-25 期 3 第一批把第三个实参换成了 `t()`（i18n），
    //    所以这里钉的是**同一条性质的新形状**：调用形状 + 那条消息的 key + 中文兜底文案仍在。
    //    ⚠️ 刻意不放宽成「只要有 reportRequestError 就行」—— 那会丢掉「第三个实参是用户可见消息」这一维。
    //    🔴 「那个 key 在三份语言包里都存在」由 localePackParity 统一钉（它扫全部 t() 调用），这里不重复。
    assert.match(
      code,
      /reportRequestError\(message, err, t\('sysconf\.img\.scanFailed', '扫描失败！'\)\)/,
    );
    assert.match(code, /const \{ errorLinks \} = data \|\| \{\};/);
  });
});

describe('后台健壮性：登出、深链与本地存储 key', () => {
  it('登出接口 401 时也要清 token 并跳登录页', () => {
    const code = read('src/components/LogoutButton/index.jsx');
    // 主动登出不该再弹一条「登录失效」，失败也只是服务端那边没这个会话了
    assert.match(code, /await logout\(\{ skipErrorHandler: true \}\)/);
    assert.match(code, /try \{\s*await logout/);
    const clearIdx = code.indexOf("window.localStorage.removeItem('token')");
    const redirectIdx = code.indexOf("if (pathname !== '/user/login')");
    assert.ok(clearIdx > -1 && redirectIdx > -1, 'token 清理与跳转都还在');
    assert.ok(
      clearIdx < redirectIdx,
      'removeItem 必须在跳转判断之外：以前 401 会让两步都被跳过，停在半登出状态',
    );
    assert.doesNotMatch(codeOnly(code), /^ {2}await logout\(\);$/m);
  });

  it('umi base 是 /admin/，<Link> 里不能再带 /admin 前缀', () => {
    const cfg = read('config/config.js');
    assert.match(cfg, /base: '\/admin\//);
    const viewer = read('src/pages/Welcome/tabs/viewer.jsx');
    assert.equal(
      (viewer.match(/to=\{`\/site\/setting\?tab=siteInfo&siteInfoTab=more`\}/g) || []).length,
      2,
    );
    // 全仓库兜底：`/admin/xxx` 会被渲染成 /admin/admin/xxx，直接落到 404 兜底页
    const offenders = walk(path.join(adminRoot, 'src')).filter((f) =>
      /to=\{?['"`]\/admin\//.test(codeOnly(readFileSync(f, 'utf8'))),
    );
    assert.deepEqual(
      offenders.map((f) => path.relative(adminRoot, f)),
      [],
    );
  });

  it('「布局配置」深链用 SystemConfig / SiteInfo 真正读的 query key', () => {
    for (const rel of ['src/pages/Article/columns.jsx', 'src/pages/Editor/index.jsx']) {
      const code = read(rel);
      assert.match(code, /history\.push\('\/site\/setting\?tab=siteInfo&siteInfoTab=layout'\)/);
      // subTab 这个 key 没人读，点进去只会停在默认的「基本设置」
      assert.doesNotMatch(codeOnly(code), /subTab=layout/);
    }
    assert.match(read('src/pages/SystemConfig/index.jsx'), /useTab\('siteInfo', 'tab'\)/);
    const siteInfo = read('src/pages/SystemConfig/tabs/SiteInfo.tsx');
    assert.match(siteInfo, /useTab\('basic', 'siteInfoTab'\)/);
    assert.match(siteInfo, /key: 'layout'/);
  });

  it('标签搜索不再凭空造一行不存在的标签', () => {
    const code = read('src/pages/DataManage/tabs/Tag.jsx');
    // 以前任何搜索词都会被塞成 [{ key: 输入, name: 输入 }]，
    // 那一行的重命名/删除打到服务端匹配不到东西，却照样 toast 成功
    assert.doesNotMatch(
      codeOnly(code),
      /data = \[\{ key: params\?\.name, name: params\?\.name \}\]/,
    );
    assert.match(
      code,
      /data\.filter\(\(item\) => String\(item\.name\)\.toLowerCase\(\)\.includes\(keyword\)\)/,
    );
    assert.match(code, /emptyText: '没有匹配的标签'/);
  });

  it('useNum：每个调用方一个 key，老 key 的值迁移一次', () => {
    const hook = read('src/services/van-blog/useNum.js');
    // 三个 tab 都不传 token 时 key 全是 ...-undefined，改一个 tab 会连带改另外两个
    assert.match(hook, /LEGACY_SHARED_KEY = 'van-blog-admin-num-undefined'/);
    assert.match(hook, /removeItem\(LEGACY_SHARED_KEY\)/);
    const tokens = ['overview', 'viewer', 'article'].map((tab) => {
      const code = read(`src/pages/Welcome/tabs/${tab}.jsx`);
      assert.doesNotMatch(codeOnly(code), /useNum\(\s*\d+\s*\)/, `${tab}.jsx 不能再裸调 useNum`);
      const m = code.match(/useNum\(\d+, '([^']+)'\)/);
      assert.ok(m, `${tab}.jsx 要给 useNum 传唯一 token`);
      return m[1];
    });
    assert.equal(new Set(tokens).size, 3, `token 必须互不相同：${tokens.join(', ')}`);
    // 列表页的每页条数本来就有 token，不能被迁移逻辑串味
    assert.match(read('src/pages/Article/index.jsx'), /useNum\(10, 'article-page-size'\)/);
  });
});

describe('后台健壮性：HTTPS 页 / 初始化页 / 接口地址', () => {
  it('Caddy：只有更新成功才切协议，lodash 按需引入', () => {
    const code = read('src/pages/SystemConfig/tabs/Caddy.jsx');
    const fn = slice(
      code,
      'const updateHttpsConfig = async (data) => {',
      'return (\n    <Card title="HTTPS 相关配置">',
    );
    const awaitIdx = fn.indexOf('await setHttpsConfig(data);');
    const timerIdx = fn.indexOf('setTimeout(');
    assert.ok(awaitIdx > -1 && timerIdx > -1, 'await 与延时跳转都还在');
    assert.ok(
      awaitIdx < timerIdx,
      '跳转必须排在 await 之后：以前失败也会在 2 秒后 reload / 换协议',
    );
    assert.match(code, /import isEqual from 'lodash\/isEqual';/);
    assert.doesNotMatch(codeOnly(code), /^import lodash from 'lodash';$/m);
    assert.doesNotMatch(codeOnly(code), /lodash\./);
    assert.match(code, /const eq = isEqual\(curData, data\);/);
  });

  it('InitPage：HTTP 500「已初始化」是异常，不是成功', () => {
    const code = read('src/pages/InitPage/index.tsx');
    // 服务端是 throw new HttpException('已初始化', 500)：请求会 reject，
    // 以前 `statusCode == 500` 也算成功，那段分支永远走不到
    assert.doesNotMatch(codeOnly(code), /res\?\.statusCode == 200 \|\| res\?\.statusCode == 500/);
    assert.match(code, /try \{\s*const res = await fetchInit\(newData\);/);
    assert.match(code, /if \(res\?\.statusCode == 200\) \{/);
    assert.match(code, /\} catch \(err\) \{/);
    assert.match(
      code,
      /status == 500 && String\(info\?\.message \|\| ''\)\.includes\('已初始化'\)/,
    );
    assert.ok((code.match(/goLogin/g) || []).length >= 4, '两个分支都要把人送到登录页');
    // 服务端契约（只读，别改 server）
    assert.match(
      readRepo('server/src/controller/admin/init/init.controller.ts'),
      /throw new HttpException\('已初始化', 500\)/,
    );
  });

  it('createCustomFolder 打的是 folder 路由（唯一调用方是注释掉的死代码）', () => {
    const api = read('src/services/van-blog/api.js');
    const folderFn = api.match(/export async function createCustomFolder[\s\S]*?\n\}/)[0];
    assert.match(folderFn, /\/api\/admin\/customPage\/folder\?path=/);
    assert.doesNotMatch(folderFn, /customPage\/file/);
    // 顺手钉住建文件的那个别被改坏
    const fileFn = api.match(/export async function createCustomFile[\s\S]*?\n\}/)[0];
    assert.match(fileFn, /\/api\/admin\/customPage\/file\?path=/);
    assert.match(
      readRepo('server/src/controller/admin/customPage/customPage.controller.ts'),
      /@Post\('folder'\)/,
    );
    // 调用方确实只在 Code 页那段被 {/* */} 注释掉的工具栏里（所以地址写错也没人发现）
    const codePage = read('src/pages/Code/index.tsx');
    const toolbar = slice(codePage, '{/* <div className="toolbar">', '</div> */}');
    assert.match(toolbar, /await createCustomFolder\(path, pathPrefix\);/);
    const imports = slice(codePage, 'import CodeEditor from', 'const { DirectoryTree }');
    assert.doesNotMatch(imports, /createCustomFolder/);
  });

  it('useEditorCache 的 getCache 真的有返回值', () => {
    const code = read('src/services/van-blog/useEditorCache.js');
    assert.match(code, /return window\.localStorage\.getItem\(key\);/);
  });

  it('评论管理页的 iframe 不再写死内网地址', () => {
    const code = read('src/pages/CommentManage/index.jsx');
    // 入库文件里不许出现任何 IP 字面量（写死的是某台机器的私网地址，换环境就白屏）
    assert.doesNotMatch(code, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    assert.match(code, /const \{ protocol, hostname \} = window\.location;/);
    assert.match(code, /return `\$\{protocol\}\/\/\$\{hostname\}:8360\/ui`;/);
    // 非 dev 仍然走同源的 /ui/
    assert.match(code, /return '\/ui\/';/);
  });
});

describe('requestError：兜底提示不与全局提示重复', () => {
  const {
    reportRequestError,
    DEFAULT_ERROR_MESSAGE,
  } = require('../../src/services/van-blog/requestError');

  it('全局已经弹过服务端原因时不再叠加', () => {
    const messageApi = createMessageApi();
    const err = { message: 'Bad Request', data: { statusCode: 400, message: 'pathname 已存在' } };
    assert.equal(reportRequestError(messageApi, err, '修改失败！'), false);
    assert.deepEqual(messageApi.calls, []);
  });

  it('skipErrorHandler 的接口全局不弹，必须用兜底文案', () => {
    const messageApi = createMessageApi();
    const err = { message: 'boom', request: { options: { skipErrorHandler: true } } };
    assert.equal(reportRequestError(messageApi, err, '导出失败！'), true);
    assert.deepEqual(messageApi.calls, [{ type: 'error', text: '导出失败！' }]);
  });

  it('没给文案时用默认文案；没有 messageApi 也不能抛', () => {
    const messageApi = createMessageApi();
    const err = { message: 'boom', request: { options: { skipErrorHandler: true } } };
    assert.equal(reportRequestError(messageApi, err), true);
    assert.deepEqual(messageApi.calls, [{ type: 'error', text: DEFAULT_ERROR_MESSAGE }]);
    assert.equal(reportRequestError(undefined, err, '导出失败！'), true);
  });
});

describe('后台文档外壳：语言标签', () => {
  it('document.ejs 的 lang 必须是规范的 zh-CN（原来是 cn，根本不是语言子标签）', () => {
    // document.ejs 是 HTML 外壳，注释形式是 <!-- -->，不适用这里剥 // 注释的辅助函数，直接读原文
    const ejs = read('src/pages/document.ejs');
    assert.match(ejs, /<html lang="zh-CN">/);
    assert.doesNotMatch(ejs, /<html lang="cn">/);
    // 别退回到只有 zh：BCP 47 里 zh 是宏语言，简繁与发音规则都不明确
    assert.doesNotMatch(ejs, /<html lang="zh">/);
  });

  it('前台也一致（两个包的 html 语言标签不该各写各的）', () => {
    // 注意 readRepo 的根是 packages/（不是仓库根），路径别多写一层 packages
    const doc = readRepo('website/pages/_document.tsx');
    assert.match(doc, /<Html lang="zh-CN"/);
  });
});
