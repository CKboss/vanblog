const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

// 断言前剔除注释：注释里经常引用旧写法/契约原文，不剔除会自己匹配自己
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const core = require('../../src/pages/InitPage/restoreCore');

describe('init 页整站恢复：契约常量', () => {
  it('端点、字段名、accept、登录路径与契约一致', () => {
    assert.equal(core.INIT_RESTORE_ENDPOINT, '/api/admin/init/restore');
    assert.equal(core.INIT_RESTORE_FILE_FIELD, 'file');
    assert.equal(core.INIT_RESTORE_ACCEPT, '.zst,.xz,.gz,.tgz,.tar');
    assert.equal(core.INIT_RESTORE_LOGIN_PATH, '/user/login');
    assert.equal(core.INIT_RESTORE_TOKEN_KEY, 'token');
  });

  it('accept 与后台「上传备份并恢复」完全一致（同一类归档）', () => {
    const backup = read('src/pages/SystemConfig/tabs/Backup.jsx');
    assert.ok(backup.includes(`accept="${core.INIT_RESTORE_ACCEPT}"`));
  });
});

describe('parseRestoreResponse：每种失败形状都要有可读信息', () => {
  it('标准成功信封 → ok + data', () => {
    const r = core.parseRestoreResponse(
      200,
      JSON.stringify({ statusCode: 200, data: { seconds: 42 } }),
    );
    assert.deepEqual(r, { ok: true, data: { seconds: 42 } });
  });

  it('成功信封缺 data → ok + 空对象（不因形状漂移崩掉）', () => {
    const r = core.parseRestoreResponse(200, JSON.stringify({ statusCode: 200 }));
    assert.deepEqual(r, { ok: true, data: {} });
  });

  it('HTTP 200 但信封不是 200 → 失败，带服务端 message', () => {
    const r = core.parseRestoreResponse(
      200,
      JSON.stringify({ statusCode: 500, message: '站点已初始化，拒绝恢复' }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.message, '站点已初始化，拒绝恢复');
  });

  it('Nest HttpException body（message 数组 / data.message）', () => {
    const r1 = core.parseRestoreResponse(
      400,
      JSON.stringify({ statusCode: 400, message: ['扩展名不支持', '请上传 tar 归档'] }),
    );
    assert.equal(r1.ok, false);
    assert.equal(r1.message, '扩展名不支持；请上传 tar 归档');
    const r2 = core.parseRestoreResponse(
      409,
      JSON.stringify({ statusCode: 409, data: { message: '已有恢复在进行中' } }),
    );
    assert.equal(r2.ok, false);
    assert.equal(r2.message, '已有恢复在进行中');
  });

  it('非 JSON 的网关错误页 / 空响应 → 带 HTTP 状态码的兜底信息', () => {
    const r1 = core.parseRestoreResponse(502, '<html><body>Bad Gateway</body></html>');
    assert.equal(r1.ok, false);
    assert.ok(r1.message.includes('HTTP 502'));
    const r2 = core.parseRestoreResponse(500, '');
    assert.equal(r2.ok, false);
    assert.ok(r2.message.includes('HTTP 500'));
  });

  it('HTTP 非 2xx 即使信封是 200 也算失败（网关改写不算成功）', () => {
    const r = core.parseRestoreResponse(
      504,
      JSON.stringify({ statusCode: 200, data: {} }),
    );
    assert.equal(r.ok, false);
  });
});

describe('describeFileSize', () => {
  it('常见归档大小', () => {
    assert.equal(core.describeFileSize(66 * 1024 * 1024), '66.0 MB');
    assert.equal(core.describeFileSize(1023), '1023 B');
    assert.equal(core.describeFileSize(2048), '2.0 KB');
    assert.equal(core.describeFileSize(3 * 1024 * 1024 * 1024), '3.00 GB');
  });
  it('坏值不给 NaN', () => {
    assert.equal(core.describeFileSize(0), '未知大小');
    assert.equal(core.describeFileSize(NaN), '未知大小');
    assert.equal(core.describeFileSize(undefined), '未知大小');
  });
});

describe('RestoreFromBackup 组件接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/pages/InitPage/RestoreFromBackup.tsx'));

  it('打契约端点，FormData 字段名 file，不带 token 头（免登录入口）', () => {
    assert.ok(comp.includes('form.append(INIT_RESTORE_FILE_FIELD, file)'));
    assert.ok(comp.includes("xhr.open('POST', INIT_RESTORE_ENDPOINT)"));
    assert.ok(!comp.includes('setRequestHeader'));
    assert.ok(!comp.includes('tokenHeader'));
  });

  it('上传前必须确认，确认不需要任何输入', () => {
    assert.ok(comp.includes('beforeUpload'));
    assert.ok(comp.includes('Modal.confirm'));
    assert.ok(comp.includes("okText: '我确定，恢复'"));
    // beforeUpload 返回 false 拦截 antd 的自动上传，确认后才手动传
    assert.ok(/return false;\s*\}/.test(comp));
    assert.ok(comp.includes('startUpload(file'));
  });

  it('in-flight 期间按钮禁用（双击发不出第二个恢复）', () => {
    assert.ok(comp.includes('disabled={busy}'));
    assert.ok(comp.includes('loading={busy}'));
    assert.ok(comp.includes('if (busy) {'));
  });

  it('有真实上传进度条与「正在恢复」阶段（不能看起来像卡死）', () => {
    assert.ok(comp.includes('xhr.upload.onprogress'));
    assert.ok(comp.includes('<Progress'));
    assert.ok(comp.includes("setPhase('restoring')"));
    assert.ok(comp.includes('请不要关闭或刷新页面'));
  });

  it('成功（initialized 分支）：清 token（与登出路径一致）→ 跳登录页 → 告知凭据来自备份', () => {
    assert.ok(comp.includes('window.localStorage.removeItem(INIT_RESTORE_TOKEN_KEY)'));
    assert.ok(comp.includes('history.replace(INIT_RESTORE_LOGIN_PATH)'));
    assert.ok(comp.includes('备份文件里的那套账号密码'));
    assert.ok(comp.includes('Modal.success'));
    // 不调用登出接口（init 场景没有会话，打了就是 401）
    assert.ok(!comp.includes('logout('));
  });

  it('失败：服务端 message 原样透出，提示由 describeRestoreFailure 按状态码给出', () => {
    assert.ok(comp.includes('{result.message}'));
    assert.ok(comp.includes('describeRestoreFailure(xhr.status, result.message)'));
    assert.ok(comp.includes('{hints.map((hint) => ('));
    assert.ok(comp.includes('parseRestoreResponse(xhr.status, xhr.responseText)'));
    // 原来写死在组件里的「两个最常见误操作提示」搬进了 restoreCore 的默认分支，
    // 由下面 describeRestoreFailure 的用例逐字钉住（等价且更强：行为断言）
  });

  it('挂载时不发任何请求（不与「已初始化 → 重定向」抢跑）', () => {
    assert.ok(!comp.includes('useEffect'));
  });
});

describe('InitPage 布局：恢复卡在向导之前，向导行为不变', () => {
  const page = codeOnly(read('src/pages/InitPage/index.tsx'));

  it('卡片渲染在 StepsForm/第一个表单字段之前，中间有分隔', () => {
    const restoreIdx = page.indexOf('<RestoreFromBackup');
    const stepsIdx = page.indexOf('<StepsForm');
    const firstFieldIdx = page.indexOf('<ProFormText');
    assert.ok(restoreIdx > -1, '页面里没有 <RestoreFromBackup />');
    assert.ok(stepsIdx > -1);
    assert.ok(firstFieldIdx > -1);
    assert.ok(restoreIdx < stepsIdx, '恢复卡必须在向导之前');
    assert.ok(restoreIdx < firstFieldIdx, '恢复卡必须在第一个表单字段之前');
    assert.ok(page.includes('—— 或者，手动初始化 ——'));
    assert.ok(page.includes('已有整站备份？直接恢复'));
  });

  it('恢复卡不依赖向导的任何字段/表单实例', () => {
    const comp = codeOnly(read('src/pages/InitPage/RestoreFromBackup.tsx'));
    for (const token of ['ProForm', 'formRef', 'StepsForm', 'formMapRef', 'SiteInfoForm']) {
      assert.ok(!comp.includes(token), `恢复组件不应该引用 ${token}`);
    }
  });

  it('原初始化向导流程原样保留（4 步 + fetchInit + 已初始化兜底）', () => {
    assert.ok(page.includes('fetchInit(newData)'));
    assert.ok(page.includes('encryptPwd(name, password)'));
    assert.ok((page.match(/<StepsForm\.StepForm/g) || []).length === 4);
    assert.ok(page.includes("history.push('/user/login')"));
    assert.ok(page.includes('已初始化'));
  });
});

describe('classifyRestoreSuccess：按 data.initialized 分支（不是按 HTTP 200）', () => {
  it('initialized:true + 完整字段', () => {
    const info = core.classifyRestoreSuccess({
      initialized: true,
      adminUserFromArchive: true,
      seconds: 12.3,
      notes: ['a', null, 3, undefined],
      counts: { articles: 59, statics: 93, visits: 8746 },
      databases: { vanBlog: { collections: 8 } },
      static: { img: { files: 90 } },
    });
    assert.equal(info.initialized, true);
    assert.equal(info.adminUserFromArchive, true);
    assert.equal(info.seconds, 12.3);
    assert.deepEqual(info.notes, ['a', '3']);
    assert.equal(info.countsText, '文章 59 · 图片 93 · 访问记录 8746');
    assert.deepEqual(info.databases, { vanBlog: { collections: 8 } });
    assert.deepEqual(info.static, { img: { files: 90 } });
  });

  it('initialized:false 与字段缺失（老 server 不发它）都按未初始化处理', () => {
    assert.equal(core.classifyRestoreSuccess({ initialized: false }).initialized, false);
    assert.equal(core.classifyRestoreSuccess({ initialized: 'true' }).initialized, false);
    assert.equal(core.classifyRestoreSuccess({}).initialized, false);
    assert.equal(core.classifyRestoreSuccess(undefined).initialized, false);
    assert.equal(core.classifyRestoreSuccess(null).initialized, false);
    assert.equal(core.classifyRestoreSuccess('x').initialized, false);
  });

  it('细节字段缺失时全部安全降级（形状再变也只是少显示几行）', () => {
    const info = core.classifyRestoreSuccess({ initialized: true });
    assert.equal(info.countsText, '');
    assert.deepEqual(info.notes, []);
    assert.equal(info.seconds, null);
    assert.equal(info.databases, null);
    assert.equal(info.static, null);
    assert.equal(info.adminUserFromArchive, false);
  });
});

describe('formatRestoreCounts', () => {
  it('固定顺序渲染全部字段', () => {
    assert.equal(
      core.formatRestoreCounts({
        total: 8946,
        settings: 6,
        viewers: 794,
        visits: 8746,
        users: 1,
        statics: 93,
        articles: 59,
      }),
      '文章 59 · 图片 93 · 用户 1 · 访问记录 8746 · 访客 794 · 设置 6 · 合计 8946',
    );
  });
  it('跳过缺失、非数字与未知键；空对象给空串', () => {
    assert.equal(core.formatRestoreCounts({ statics: 93, articles: 'x', unknown: 5 }), '图片 93');
    assert.equal(core.formatRestoreCounts({}), '');
    assert.equal(core.formatRestoreCounts(null), '');
    assert.equal(core.formatRestoreCounts(undefined), '');
  });
});

describe('describeRestoreFailure：409/403/429/版本过新 各有专门提示，其余走通用两条', () => {
  it('409 = 已有恢复在跑 → 稍后重试（区别于 403）', () => {
    const hints = core.describeRestoreFailure(
      409,
      '已经有一个恢复正在进行，请等它结束（完成后刷新页面即可进入后台）',
    );
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes('已经有一个恢复在进行中'));
    assert.ok(!hints[0].includes('系统设置'));
  });

  it('403 = 已初始化 → 指路后台「备份与恢复」（区别于 409）', () => {
    const hints = core.describeRestoreFailure(
      403,
      '站点已经初始化过了：这条接口只对全新站点开放，请登录后到「备份与恢复」里恢复',
    );
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes('系统设置 → 备份与恢复'));
    assert.ok(!hints[0].includes('进行中'));
  });

  it('429 = init 限流桶（每 10 分钟 5 次）', () => {
    const hints = core.describeRestoreFailure(429, 'Too Many Requests');
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes('每 10 分钟 5 次'));
  });

  it('400 + 服务端「版本过新」原文 → 升级 server 镜像', () => {
    const hints = core.describeRestoreFailure(
      400,
      'manifest.json 校验失败：不是 VanBlog 整站备份，或版本过新',
    );
    assert.equal(hints.length, 1);
    assert.ok(hints[0].includes('升级 server 镜像'));
  });

  it('其余 400 / 未知状态 → 通用两条，原「数据管理」「已经初始化过」提示语逐字保留', () => {
    const cases = [
      [400, '请上传整站备份文件（multipart 字段名 file）'],
      [400, '文件名不像是本功能导出的整站备份（应形如 vanblog-full-20260913-140955.tar.zst），收到：x.tgz'],
      [400, '读不出这个备份的清单：文件损坏/不完整，或不是本功能导出的整站备份'],
      [500, 'boom'],
      [200, '演示站禁止修改此项！'],
    ];
    for (const [status, msg] of cases) {
      const hints = core.describeRestoreFailure(status, msg);
      assert.equal(hints.length, 2, `status=${status} 应给通用两条`);
      assert.ok(hints[0].includes('数据管理'), '第一条提示要指路「数据管理」（JSON 导入）');
      assert.ok(hints[0].includes('vanblog-full-'), '第一条提示要给出正确文件名形状');
      assert.ok(hints[1].includes('已经初始化过'), '第二条提示要覆盖「已初始化」场景');
      assert.ok(hints[1].includes('备份与恢复'));
    }
  });
});

describe('组件的成功分支接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/pages/InitPage/RestoreFromBackup.tsx'));

  it('按 info.initialized 分支；清 token / 跳登录只在 initialized 分支里', () => {
    assert.ok(comp.includes('const info = classifyRestoreSuccess(result.data);'));
    assert.ok(comp.includes('if (info.initialized) {'));
    const branchIdx = comp.indexOf('if (info.initialized) {');
    const tokenIdx = comp.indexOf('window.localStorage.removeItem(INIT_RESTORE_TOKEN_KEY)');
    assert.ok(branchIdx > -1 && tokenIdx > branchIdx, 'removeItem 必须在 initialized 分支内');
    // goLogin 只出现 3 次：定义 + initialized 分支 Modal 的 onOk/onCancel；
    // 未初始化分支一旦引用它就会多于 3 次
    assert.equal((comp.match(/goLogin/g) || []).length, 3);
    assert.equal((comp.match(/localStorage\.removeItem/g) || []).length, 1);
  });

  it('未初始化分支：留在本页、提示继续走向导，不碰 token 不跳转', () => {
    assert.ok(comp.includes("okText: '继续初始化'"));
    assert.ok(comp.includes('数据已恢复，但备份里没有管理员账号'));
    assert.ok(comp.includes('初始化向导创建管理员账号'));
    assert.ok(!comp.includes('location.href'), '不允许整页跳转绕过向导状态');
  });

  it('counts / notes / seconds 都渲染，counts 为空时整行不出现', () => {
    assert.ok(comp.includes('info.countsText ? <p>恢复进来：{info.countsText}</p> : null'));
    assert.ok(comp.includes('info.notes.map((note) => ('));
    assert.ok(comp.includes('info.seconds !== null'));
  });

  it('initialized 但归档没带用户记录时给恢复密钥提示（防御性组合）', () => {
    assert.ok(comp.includes('info.adminUserFromArchive ? null :'));
    assert.ok(comp.includes('忘记密码'));
  });
});
