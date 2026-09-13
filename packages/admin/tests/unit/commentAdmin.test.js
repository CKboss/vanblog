const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

// 新加的注释里会引用旧写法 / 描述服务端行为，断言前先把注释行去掉，不然自己匹配自己。
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
    if (name === '.umi' || name === '.umi-production' || name === 'node_modules' || name === 'dist') {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full);
  }
  return out;
}

const API_NAMES = [
  'getCommentSetting',
  'updateCommentSetting',
  'getComments',
  'getCommentCounts',
  'updateComment',
  'deleteComment',
];

describe('内置评论：api.js 的六个接口函数', () => {
  const api = read('src/services/van-blog/api.js');
  const fn = (name) => {
    const m = api.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `api.js 必须导出 ${name}`);
    return m[0];
  };

  it('评论设置：GET / PUT /api/admin/setting/comment', () => {
    assert.match(fn('getCommentSetting'), /request\('\/api\/admin\/setting\/comment', \{/);
    assert.match(fn('getCommentSetting'), /method: 'GET'/);
    assert.match(fn('updateCommentSetting'), /request\('\/api\/admin\/setting\/comment', \{/);
    assert.match(fn('updateCommentSetting'), /method: 'PUT'/);
    assert.match(fn('updateCommentSetting'), /data: body/);
  });

  it('评论列表：GET /api/admin/comment，query 支持 page/pageSize/status/path/keyword 且跳过空值', () => {
    const code = fn('getComments');
    assert.match(code, /new URLSearchParams\(\)/);
    assert.match(code, /v !== undefined && v !== null && v !== ''/);
    assert.match(code, /request\(`\/api\/admin\/comment\$\{qs \? `\?\$\{qs\}` : ''\}`/);
    assert.match(code, /method: 'GET'/);
    // 空值不进 query：keyword/path 清空后必须真的摘掉参数，否则服务端会按空串过滤
  });

  it('计数：GET /api/admin/comment/counts', () => {
    assert.match(fn('getCommentCounts'), /request\('\/api\/admin\/comment\/counts', \{/);
    assert.match(fn('getCommentCounts'), /method: 'GET'/);
  });

  it('改 / 删：PUT 与 DELETE /api/admin/comment/:id', () => {
    assert.match(fn('updateComment'), /request\(`\/api\/admin\/comment\/\$\{id\}`, \{/);
    assert.match(fn('updateComment'), /method: 'PUT'/);
    assert.match(fn('updateComment'), /data: body/);
    assert.match(fn('deleteComment'), /request\(`\/api\/admin\/comment\/\$\{id\}`, \{/);
    assert.match(fn('deleteComment'), /method: 'DELETE'/);
  });

  it('六个函数都不带 skipErrorHandler：失败由全局 errorHandler 弹服务端的具体原因', () => {
    for (const name of API_NAMES) {
      assert.doesNotMatch(fn(name), /skipErrorHandler/, `${name} 不该跳过全局错误处理`);
    }
  });
});

describe('评论管理页：先读设置，再按 provider 分三个分支', () => {
  const page = read('src/pages/CommentManage/index.jsx');
  const panel = read('src/pages/CommentManage/BuiltinComments.jsx');

  it('进页面先拉 GET /api/admin/setting/comment，失败给重试而不是误判成「已关闭」', () => {
    assert.match(page, /import \{ getCommentSetting \} from '@\/services\/van-blog\/api';/);
    assert.match(page, /const \{ data \} = await getCommentSetting\(\);/);
    assert.match(page, /reportRequestError\(message, err, '读取评论设置失败！'\)/);
    // setting 为 null（拉取失败）时渲染重试入口；不能掉进 off 分支
    assert.match(page, /if \(!setting\) \{/);
    assert.match(page, /onClick=\{fetchSetting\}/);
  });

  it('waline 分支：iframe 行为原样保留（含 dev 直连 URL 的推导）', () => {
    assert.match(page, /provider === 'waline'/);
    assert.match(page, /const \{ protocol, hostname \} = window\.location;/);
    assert.match(page, /return `\$\{protocol\}\/\/\$\{hostname\}:8360\/ui`;/);
    assert.match(page, /return '\/ui\/';/);
    assert.match(page, /<iframe/);
    assert.match(page, /title="waline 后台"/);
    assert.match(page, /src=\{src\}/);
  });

  it('builtin 分支渲染管理面板；off 分支给 Result + 跳设置页', () => {
    assert.match(page, /provider === 'builtin'/);
    assert.match(page, /import BuiltinComments from '\.\/BuiltinComments';/);
    assert.match(page, /<BuiltinComments \/>/);
    assert.match(page, /评论系统已关闭/);
    assert.match(codeOnly(page), /history\.push\(`\/site\/setting\?tab=waline`\)/);
    assert.match(page, /status="info"/);
  });

  it('页面里没有写死的内网 IP，也没有省协议的 //host 地址', () => {
    for (const code of [page, panel]) {
      assert.doesNotMatch(code, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
      // 省协议的 //host:8360 在 file:// 或非常规部署下会解析错，waline 地址必须带 protocol
      assert.doesNotMatch(codeOnly(code), /['"`]\/\/[a-zA-Z0-9.-]+:\d+/);
    }
  });
});

describe('评论管理面板：写操作 try/catch/finally + reportRequestError', () => {
  const code = read('src/pages/CommentManage/BuiltinComments.jsx');

  it('列表加载：catch 里 reportRequestError，finally 里一定收掉 loading', () => {
    const fetchFn = slice(code, 'const fetchList = useCallback', 'const runMutation = async');
    assert.match(fetchFn, /try \{/);
    assert.match(fetchFn, /reportRequestError\(message, err, '加载评论失败！'\)/);
    assert.match(fetchFn, /\} finally \{\s*setLoading\(false\);\s*\}/);
  });

  it('所有写操作统一走 runMutation：finally 收 mutating，失败走 reportRequestError', () => {
    const fn = slice(code, 'const runMutation = async', 'const changeStatus =');
    assert.match(fn, /try \{/);
    assert.match(fn, /reportRequestError\(message, err, '操作失败，请稍后重试！'\)/);
    assert.match(fn, /\} finally \{\s*setMutating\(false\);\s*\}/);
    assert.equal(
      (codeOnly(code).match(/setMutating\(false\)/g) || []).length,
      1,
      'setMutating(false) 只应出现在 runMutation 的 finally 里',
    );
    // 通过 / 待审 / 垃圾 / 删除 / 批量×2 / 编辑保存 都必须经过 runMutation（5 个入口）
    assert.ok((code.match(/runMutation\(/g) || []).length >= 5, '每个写操作入口都要走 runMutation');
    // 谁都不许直接 await 写接口：只有 runMutation 里的 `await mutation()` 一处收口
    assert.doesNotMatch(codeOnly(code), /await (updateComment|deleteComment)\(/);
  });

  it('删除有 Popconfirm 确认；编辑失败时弹窗留着可以改完再提交', () => {
    assert.match(code, /<Popconfirm/);
    assert.match(code, /确认删除这条评论吗？删除顶层评论会连带删除它的全部回复/);
    assert.match(code, /if \(ok\) \{\s*setEditTarget\(null\);\s*\}/);
    // 编辑弹窗只提交 content / nick 两个字段（服务端 UpdateCommentDto 的约定）
    assert.match(code, /updateComment\(editTarget\.id, \{ nick: values\.nick, content: values\.content \}\)/);
  });

  it('表格列齐全：昵称(作者/回复)、内容、文章、状态、提交时间(相对+绝对)、IP、操作', () => {
    for (const title of ['昵称', '内容', '文章', '状态', '提交时间', 'IP', '操作']) {
      assert.match(code, new RegExp(`title: '${title}'`), `缺少「${title}」列`);
    }
    assert.match(code, /record\.isAuthor \? <Tag color="blue">作者<\/Tag>/);
    assert.match(code, /回复 @\{record\.replyToNick/);
    assert.match(code, /<a href=\{record\.path\} target="_blank" rel="noreferrer">/);
    assert.match(code, /#\{record\.articleId\}/);
    assert.match(code, /statusMeta\(record\.status\)/);
    assert.match(code, /<Tooltip title=\{record\.createdAt \? new Date\(record\.createdAt\)\.toLocaleString\(\) : '-'\}>/);
    assert.match(code, /formatTimeAgo\(record\.createdAt\)/);
    // 内容是匿名访客提交的 markdown 源码，只能按纯文本展示，渲染成 HTML 就是存储型 XSS
    assert.doesNotMatch(codeOnly(code), /dangerouslySetInnerHTML/);
    assert.match(code, /ellipsis=\{\{ rows: 2, expandable: true, symbol: '展开' \}\}/);
    // 状态页签带计数（counts 跟着列表接口回来）
    assert.match(code, /statusTabs\(counts\)\.map/);
  });
});

describe('评论隐私字段（email/ip/ua）只出现在后台管理页', () => {
  const allowed = [
    'src/services/van-blog/api.js',
    'src/pages/CommentManage/index.jsx',
    'src/pages/CommentManage/BuiltinComments.jsx',
    'src/pages/SystemConfig/tabs/CommentSystem.jsx',
  ];

  it('除评论管理相关文件外，src 下没有别处引用这些接口', () => {
    const pattern = new RegExp(API_NAMES.join('|'));
    const offenders = walk(path.join(adminRoot, 'src'))
      .map((f) => path.relative(adminRoot, f).split(path.sep).join('/'))
      .filter((rel) => !allowed.includes(rel))
      .filter((rel) => pattern.test(codeOnly(read(rel))));
    assert.deepEqual(offenders, [], `这些文件不该碰评论接口：${offenders.join(', ')}`);
  });

  it('评论相关页面不打 console（email/ip/ua 不能顺带漏进控制台）', () => {
    for (const rel of allowed.slice(1)) {
      assert.doesNotMatch(codeOnly(read(rel)), /console\.(log|info|warn|error|debug)/, `${rel} 不许打 console`);
    }
  });
});

describe('「评论系统」设置卡片：七个字段全量提交，保存后回读', () => {
  const code = read('src/pages/SystemConfig/tabs/CommentSystem.jsx');

  it('payload 覆盖 CommentSetting 的全部七个字段（PUT 是整体覆盖语义）', () => {
    const payload = slice(code, 'const payload = {', '};');
    for (const field of [
      'provider',
      'moderation',
      'keywords',
      'requireEmail',
      'pendingOnLink',
      'maxContentLength',
      'rateLimitPer10Min',
    ]) {
      assert.match(payload, new RegExp(`${field}:`), `payload 缺少 ${field}`);
    }
  });

  it('保存成功后 message.success + 重新 getCommentSetting 回读', () => {
    const saveIdx = code.indexOf('await updateCommentSetting(payload);');
    const successIdx = code.indexOf("message.success('更新成功！');");
    const reloadIdx = code.indexOf('await load();', successIdx);
    assert.ok(saveIdx > -1, '必须调用 updateCommentSetting');
    assert.ok(saveIdx < successIdx, '成功提示要在保存之后');
    assert.ok(successIdx < reloadIdx, '保存成功后必须回读一次设置（服务端会夹取/规范化）');
    assert.match(code, /const \{ data \} = await getCommentSetting\(\);/);
    // 保存同样要 try/catch/finally：saving 不许卡死
    const onFinish = slice(code, 'const onFinish = async (values) => {', 'return (');
    assert.match(onFinish, /reportRequestError\(message, err, '保存失败！'\)/);
    assert.match(onFinish, /\} finally \{\s*setSaving\(false\);\s*\}/);
  });

  it('演示站拦截与 WalineForm 同款；数字上限与关键词上限写进表单', () => {
    assert.match(code, /location\.hostname == 'blog-demo\.mereith\.com'/);
    assert.match(code, /演示站禁止修改此项！/);
    assert.match(code, /max=\{MAX_CONTENT_LENGTH_CAP\}/);
    assert.match(code, /max=\{RATE_LIMIT_CAP\}/);
    assert.match(code, /mode="tags"/);
    assert.match(code, /validateKeywords\(payload\.keywords\)/);
    // 切到内置不迁移 Waline 数据的提示必须在
    assert.match(code, /不会迁移已有的 Waline 评论/);
    // 三种审核策略的文案都在
    assert.match(code, /先发后审/);
    assert.match(code, /先审后发/);
    assert.match(code, /不审核/);
  });

  it('挂在「系统设置 → 评论设置」页签里，原 Waline 表单原样保留', () => {
    const tab = read('src/pages/SystemConfig/tabs/WalineTab.jsx');
    assert.match(tab, /import CommentSystem from '\.\/CommentSystem';/);
    assert.match(tab, /<CommentSystem \/>/);
    assert.match(tab, /<WalineForm \/>/);
    // walineEmailFields.test 盯着的邮件通知文案不能丢
    assert.match(tab, /自定义域名邮箱/);
    assert.match(tab, /博主邮箱/);
    assert.match(tab, /发件地址/);
    const configPage = read('src/pages/SystemConfig/index.jsx');
    assert.match(configPage, /key: 'waline'/);
  });
});

describe('commentAdmin 纯函数（行为测试）', () => {
  const {
    statusMeta,
    statusTabs,
    normalizeCommentSetting,
    validateKeywords,
    MAX_KEYWORDS,
    MAX_KEYWORD_LENGTH,
    MAX_CONTENT_LENGTH_CAP,
    RATE_LIMIT_CAP,
  } = require('../../src/services/van-blog/commentAdmin');

  it('statusMeta：四个状态的标签/颜色，未知状态兜底不崩', () => {
    assert.deepEqual(
      ['pending', 'approved', 'spam', 'deleted'].map((s) => statusMeta(s).label),
      ['待审核', '已通过', '垃圾', '已删除'],
    );
    assert.equal(statusMeta('pending').color, 'orange');
    assert.equal(statusMeta('approved').color, 'green');
    assert.equal(statusMeta('spam').color, 'red');
    assert.equal(statusMeta('deleted').color, 'default');
    // 服务端将来加状态 / 脏数据：给个能渲染的兜底，不能抛
    assert.equal(statusMeta('weird').color, 'default');
    assert.equal(statusMeta('weird').label, 'weird');
    assert.equal(statusMeta(undefined).label, '未知状态');
  });

  it('statusTabs：计数缺失按 0，「全部」= 待审+已通过+垃圾（不含已删除，与服务端 all 过滤一致）', () => {
    const tabs = statusTabs({ pending: 3, approved: 5, deleted: 7 });
    assert.deepEqual(
      tabs.map((t) => t.key),
      ['pending', 'approved', 'spam', 'deleted', 'all'],
    );
    assert.equal(tabs.find((t) => t.key === 'pending').count, 3);
    assert.equal(tabs.find((t) => t.key === 'spam').count, 0);
    assert.equal(tabs.find((t) => t.key === 'deleted').count, 7);
    assert.equal(tabs.find((t) => t.key === 'all').count, 8);
    assert.equal(statusTabs(undefined).find((t) => t.key === 'all').count, 0);
    assert.equal(statusTabs({ pending: '4' }).find((t) => t.key === 'pending').count, 4);
  });

  it('normalizeCommentSetting：缺省补默认、枚举非法回退、数字夹到服务端上限', () => {
    const defaults = normalizeCommentSetting(undefined);
    assert.equal(defaults.provider, 'builtin');
    assert.equal(defaults.moderation, 'post');
    assert.deepEqual(defaults.keywords, []);
    assert.equal(defaults.requireEmail, false);
    assert.equal(defaults.pendingOnLink, true);
    const dirty = normalizeCommentSetting({
      provider: 'nope',
      moderation: 'whatever',
      keywords: 'not-an-array',
      maxContentLength: 999999,
      rateLimitPer10Min: 0,
    });
    assert.equal(dirty.provider, 'builtin');
    assert.equal(dirty.moderation, 'post');
    assert.deepEqual(dirty.keywords, []);
    assert.equal(dirty.maxContentLength, MAX_CONTENT_LENGTH_CAP);
    assert.equal(dirty.rateLimitPer10Min, 1);
    // pendingOnLink 字段缺失时必须回默认的 true，Boolean(undefined) 会错成 false
    assert.equal(normalizeCommentSetting({}).pendingOnLink, true);
    assert.equal(normalizeCommentSetting({ pendingOnLink: false }).pendingOnLink, false);
    assert.equal(normalizeCommentSetting({ rateLimitPer10Min: 5000 }).rateLimitPer10Min, RATE_LIMIT_CAP);
    assert.equal(normalizeCommentSetting({ maxContentLength: '500' }).maxContentLength, 500);
  });

  it('validateKeywords：超过个数/单条长度上限给可读错误，合法返回 null', () => {
    assert.equal(validateKeywords([]), null);
    assert.equal(validateKeywords(Array.from({ length: MAX_KEYWORDS }, (_, i) => `k${i}`)), null);
    assert.match(
      validateKeywords(Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `k${i}`)),
      /最多 200 个/,
    );
    assert.match(validateKeywords(['x'.repeat(MAX_KEYWORD_LENGTH + 1)]), /不能超过 30 字符/);
    assert.equal(validateKeywords(['x'.repeat(MAX_KEYWORD_LENGTH)]), null);
  });
});
