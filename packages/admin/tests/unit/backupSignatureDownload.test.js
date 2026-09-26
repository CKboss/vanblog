const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const repoRoot = path.join(adminRoot, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 剥掉整行 `//` 注释：JS 测试里不能用 TS 那把 stripCommentsForAnchor（它会把 https:// 吃掉） */
const noLineComments = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const apiSrc = noLineComments(read('src/services/van-blog/api.js'));
const pageSrc = noLineComments(read('src/pages/SystemConfig/tabs/Backup.jsx'));

describe('后台能下载归档旁边的 .sig（离线签名）', () => {
  it('api.js 有 downloadFullBackupSignature，且指向服务端真实存在的那条路由', () => {
    assert.match(apiSrc, /export async function downloadFullBackupSignature\(/);
    assert.match(apiSrc, /\/api\/admin\/backup\/full\/download-sig\?name=/);
    // 🔴 跨包核对：服务端必须真的有这条路由，否则后台改了名字就是静默 404
    const controller = noLineComments(
      readRepo('packages/server/src/controller/admin/backup/backup.controller.ts'),
    );
    assert.match(controller, /@(Get|Post)\('full\/download-sig'\)/);
  });

  it('用 responseType text 而不是 blob（.sig 是几百字节的 JSON，要能在出错时读出解释）', () => {
    const fn = apiSrc.slice(
      apiSrc.indexOf('export async function downloadFullBackupSignature('),
      apiSrc.indexOf('export async function importAll('),
    );
    assert.ok(fn.length > 40, '截取到的函数体太短，锚点可能失效');
    assert.match(fn, /responseType:\s*'text'/);
    assert.ok(!/responseType:\s*'blob'/.test(fn), '不该用 blob');
    // 名字要 encodeURIComponent（归档名含时间戳与点号，但这条纪律对所有 query 参数都适用）
    assert.match(fn, /encodeURIComponent\(name\)/);
  });

  it('页面接上了这个调用，并且操作列里有一个「签名」动作', () => {
    assert.match(pageSrc, /downloadFullBackupSignature,/);
    assert.match(pageSrc, /const handleDownloadSignature = async \(name\) => \{/);
    assert.match(pageSrc, /await downloadFullBackupSignature\(name\)/);
    // ⚠️ 标签文字在 JSX 里换行缩进写着（`>\n            签名`），所以尺子必须容忍空白：
    //    第一版写成 />签名/ 匹配不到，那是**我的正则错**，不是产品缺动作。
    assert.match(
      pageSrc,
      // 🔴 期 6 第六批起按钮文字走 t() ⇒ 锚点从"文本节点里就是签名"换成"t() 的 defaultMessage 是签名"
      /handleDownloadSignature\(record\.name\)[\s\S]{0,160}?>\s*\{t\('[^']+', '签名'\)\}\s*</,
    );
  });

  it('下载下来的文件名必须是 <归档名>.sig（验签器按"归档路径 + .sig"找 sidecar）', () => {
    const fn = pageSrc.slice(
      pageSrc.indexOf('const handleDownloadSignature'),
      pageSrc.indexOf('const handleInspect'),
    );
    assert.ok(fn.length > 80, '截取到的函数体太短，锚点可能失效');
    assert.match(fn, /link\.download = `\$\{name\}\.sig`/);
  });

  it('🔴 404 被翻译成「从没被签过」，而且**在**通用失败提示之前 return', () => {
    const fn = pageSrc.slice(
      pageSrc.indexOf('const handleDownloadSignature'),
      pageSrc.indexOf('const handleInspect'),
    );
    const i404 = fn.indexOf('status === 404');
    const iWarn = fn.indexOf('从没被签过');
    // 🔴 期 6 第六批起这条兜底文案走 t() ⇒ 锚点换成"包含那句 defaultMessage 的 message.error 调用"
    //    （性质没放：仍然要求"通用失败提示"存在，而且**在** 404 分支之后 ⇒ 顺序判据照旧有效）
    const iErr = fn.indexOf("message.error(err?.message || t(");
    assert.ok(i404 > 0, '没有对 404 做判断');
    assert.ok(iWarn > 0, '404 的文案没有说清"从没被签过"');
    assert.ok(iErr > 0, '通用失败提示不见了');
    // 顺序：404 分支必须在通用 error 之前，且分支里有 return（否则会同时弹两条）
    assert.ok(i404 < iErr, '404 判断出现在通用失败提示之后 ⇒ 会先弹"下载失败"');
    assert.ok(iWarn < iErr, '404 的文案出现在通用失败提示之后');
    const branch = fn.slice(i404, iErr);
    assert.match(branch, /return;/);
    assert.match(branch, /message\.warning\(/);
    // 文案必须明说"不是下载失败"，否则站长会在灾难现场一直重试
    assert.match(branch, /不是下载失败/);
  });

  it('尺子有效性反证：这些尺子量得到坏形状（不是恒真）', () => {
    // 去掉 404 分支 ⇒ 上面那条必须红
    const noBranch = pageSrc.replace(/if \(status === 404\) \{[\s\S]*?\n      \}\n/, '');
    assert.ok(noBranch !== pageSrc, '替换没有发生 ⇒ 锚点失效');
    assert.ok(!/status === 404/.test(noBranch));
    // 改成 blob ⇒ responseType 那条必须红
    const asBlob = apiSrc.replace(/responseType: 'text'/, "responseType: 'blob'");
    assert.ok(asBlob !== apiSrc);
    assert.match(asBlob, /responseType: 'blob'/);
    // 改名 ⇒ 跨包核对那条必须红
    const renamed = apiSrc.replace('/api/admin/backup/full/download-sig', '/api/admin/backup/full/sig');
    assert.ok(renamed !== apiSrc);
    assert.ok(!/download-sig/.test(renamed));
    // 剥注释器在工作：原文里有整行注释，剥完不该有
    const rawApi = read('src/services/van-blog/api.js');
    assert.match(rawApi, /^\s*\/\//m);
    assert.ok(!/^\s*\/\//m.test(apiSrc));
  });
});
