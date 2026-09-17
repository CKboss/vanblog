const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
/** 服务端包：跨包契约钉子要读它的 DTO / utils */
const serverRoot = path.join(adminRoot, '..', 'server');
const read = (rel, root = adminRoot) => readFileSync(path.join(root, rel), 'utf8');

/** 断言前剔除注释：注释里经常引用旧写法/契约原文，不剔除会自己匹配自己 */
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

const {
  PASSWORD_UNRECOVERABLE_WARNING,
  CLEAR_PASSWORD_LABEL,
  buildAccessPasswordPatch,
  buildSubmitValues,
  hasPasswordFromRecord,
  sanitizeRecordForForm,
  passwordHelp,
  passwordPlaceholder,
  shouldShowClearOption,
  clearConfirmContent,
  clearConfirmTitle,
} = require('../../src/services/van-blog/accessPassword');

// ---------------------------------------------------------------------------
// 1) 纯逻辑：三态契约（留空=不修改 / 填了=改 / 勾清除=解除）
// ---------------------------------------------------------------------------

describe('访问密码表单：buildAccessPasswordPatch 的三态契约', () => {
  it('编辑 + 留空 ⇒ 不带任何密码相关的键（= 服务端"不修改"）', () => {
    for (const password of [undefined, null, '', '   ', '\t']) {
      const res = buildAccessPasswordPatch({
        password,
        hasPassword: true,
        isCreate: false,
        isPrivate: true,
      });
      assert.equal(res.error, null);
      assert.deepEqual(res.patch, {});
      assert.ok(!('password' in res.patch), '留空绝不能发 password 键');
      assert.ok(!('clearPassword' in res.patch), '留空绝不能被解释成清除');
    }
  });

  it('编辑 + 填了新密码 ⇒ 只发 password（明文上行，服务端负责哈希）', () => {
    const res = buildAccessPasswordPatch({
      password: 'new-pw',
      hasPassword: true,
      isCreate: false,
    });
    assert.equal(res.error, null);
    assert.deepEqual(res.patch, { password: 'new-pw' });
  });

  it('编辑 + 勾「清除密码」⇒ 只发 clearPassword: true', () => {
    const res = buildAccessPasswordPatch({
      password: '',
      clearRequested: true,
      hasPassword: true,
      isCreate: false,
    });
    assert.equal(res.error, null);
    assert.deepEqual(res.patch, { clearPassword: true });
  });

  it('又填新密码又勾清除 ⇒ 报错拦住，不发请求（两种意图冲突）', () => {
    const res = buildAccessPasswordPatch({
      password: 'abc',
      clearRequested: true,
      hasPassword: true,
    });
    assert.ok(res.error, '必须给出错误');
    assert.match(res.error, /不能同时/);
    assert.deepEqual(res.patch, {});
  });

  it('没设过密码却勾清除 ⇒ 报错（避免用户以为解除了什么）', () => {
    const res = buildAccessPasswordPatch({
      password: '',
      clearRequested: true,
      hasPassword: false,
      isCreate: false,
    });
    assert.ok(res.error);
    assert.match(res.error, /本来就没有设置密码/);
  });

  it('勾了加密却没有可用密码 ⇒ 报错「如若加密，请填写密码！」', () => {
    // 编辑一个从来没设过密码的分类/文章，把「是否加密」切成"加密"却留空
    const editing = buildAccessPasswordPatch({
      password: '',
      hasPassword: false,
      isCreate: false,
      isPrivate: true,
    });
    assert.match(editing.error, /如若加密，请填写密码/);
    // 新建同理
    const creating = buildAccessPasswordPatch({
      password: '  ',
      hasPassword: false,
      isCreate: true,
      isPrivate: true,
    });
    assert.match(creating.error, /如若加密，请填写密码/);
  });

  it('勾了加密但**已经设过密码**、这次留空 ⇒ 放行（这就是"不修改"）', () => {
    const res = buildAccessPasswordPatch({
      password: '',
      hasPassword: true,
      isCreate: false,
      isPrivate: true,
    });
    assert.equal(res.error, null);
    assert.deepEqual(res.patch, {});
  });

  it('没勾加密时留空 ⇒ 放行，且不会顺手清掉已有密码（取消加密 ≠ 删密码）', () => {
    const res = buildAccessPasswordPatch({
      password: '',
      hasPassword: true,
      isCreate: false,
      isPrivate: false,
    });
    assert.equal(res.error, null);
    assert.deepEqual(res.patch, {});
  });

  it('新建（isCreate）留空 ⇒ 不加密，不报错', () => {
    const res = buildAccessPasswordPatch({ password: '', isCreate: true, isPrivate: false });
    assert.equal(res.error, null);
    assert.deepEqual(res.patch, {});
  });

  it('新建时不需要「清除」开关（本来就是空的）', () => {
    assert.equal(shouldShowClearOption({ hasPassword: true, isCreate: true }), false);
    assert.equal(shouldShowClearOption({ hasPassword: true, isCreate: false }), true);
    assert.equal(shouldShowClearOption({ hasPassword: false, isCreate: false }), false);
  });
});

describe('访问密码表单：提交体绝不含服务端给的字段', () => {
  it('buildSubmitValues 摘掉 password/hasPassword/clearPassword，再 merge 算出来的键', () => {
    const out = buildSubmitValues(
      {
        title: '标题',
        private: true,
        password: 'stale-echo', // 万一 store 里残留了回填值
        hasPassword: true, // 服务端下发的布尔，不是表单字段
        clearPassword: false, // 开关的原始值，不能直接发
      },
      { password: 'typed-pw' },
    );
    assert.deepEqual(out, { title: '标题', private: true, password: 'typed-pw' });
  });

  it('留空提交时，提交体里根本没有 password 这个键', () => {
    const out = buildSubmitValues({ title: 'x', password: '', clearPassword: false }, {});
    assert.deepEqual(out, { title: 'x' });
    assert.ok(!('password' in out));
  });

  it('清除提交时，只多一个 clearPassword: true', () => {
    const out = buildSubmitValues({ title: 'x', clearPassword: true }, { clearPassword: true });
    assert.deepEqual(out, { title: 'x', clearPassword: true });
  });

  it('sanitizeRecordForForm 把服务端记录里的密码相关键全部摘掉（永不回填）', () => {
    const record = {
      id: 1,
      title: 't',
      password: 'scrypt$16384$8$1$aa==$bb==', // 旧服务端可能还在回传
      hasPassword: true,
      clearPassword: false,
      publishAt: null,
    };
    assert.deepEqual(sanitizeRecordForForm(record), {
      id: 1,
      title: 't',
      publishAt: null,
    });
    assert.deepEqual(sanitizeRecordForForm(undefined), {});
    assert.deepEqual(sanitizeRecordForForm(null), {});
  });
});

describe('访问密码表单：hasPassword 的读法（含旧服务端兜底）', () => {
  it('新版服务端：只认 hasPassword 布尔', () => {
    assert.equal(hasPasswordFromRecord({ hasPassword: true }), true);
    assert.equal(hasPasswordFromRecord({ hasPassword: false }), false);
  });
  it('对着还没升级的旧服务端（响应里还有 password）也能判断，但绝不返回原值', () => {
    assert.equal(hasPasswordFromRecord({ password: 'plain' }), true);
    assert.equal(hasPasswordFromRecord({ password: '' }), false);
    assert.equal(hasPasswordFromRecord({ password: 'scrypt$x' }), true);
  });
  it('老分类文档整个键都不存在 ⇒ false（不是 undefined，不给 NaN/空白渲染的机会）', () => {
    assert.equal(hasPasswordFromRecord({ id: 1, name: '老分类' }), false);
    assert.equal(hasPasswordFromRecord(undefined), false);
    assert.equal(hasPasswordFromRecord(null), false);
  });
});

describe('访问密码表单：文案把"不可找回"讲清楚', () => {
  it('编辑 + 已设密码的 placeholder 明说"留空表示不修改"', () => {
    assert.match(passwordPlaceholder({ hasPassword: true }), /已设置密码，留空表示不修改/);
    assert.match(passwordPlaceholder({ hasPassword: false }), /留空表示不加密/);
    assert.match(passwordPlaceholder({ isCreate: true }), /留空表示不加密/);
  });
  it('help 文案里带上了不可找回的警告', () => {
    assert.ok(PASSWORD_UNRECOVERABLE_WARNING.includes('无法找回'));
    assert.ok(passwordHelp({ hasPassword: true }).includes(PASSWORD_UNRECOVERABLE_WARNING));
    assert.ok(passwordHelp({ isCreate: true }).includes(PASSWORD_UNRECOVERABLE_WARNING));
    assert.match(passwordHelp({ hasPassword: true }), /留空 = 保持原密码不变/);
    assert.match(passwordHelp({ hasPassword: true }), /清除密码/);
  });
  it('清除的二次确认文案说清了后果，并指了"只想换密码"的出路', () => {
    assert.match(clearConfirmTitle('这篇文章'), /确定清除这篇文章的访问密码吗/);
    assert.match(clearConfirmContent('这篇文章'), /无法恢复/);
    assert.match(clearConfirmContent('这篇文章'), /直接在密码框里填新密码/);
    assert.equal(CLEAR_PASSWORD_LABEL, '清除密码');
  });
});

// ---------------------------------------------------------------------------
// 2) 源码钉子：组件真的按上面的契约接线了（防止"逻辑模块写了但没人用"）
// ---------------------------------------------------------------------------

describe('UpdateModal（文章「修改信息」）接线', () => {
  const src = codeOnly(read('src/components/UpdateModal/index.tsx'));

  it('不再把服务端给的记录原样灌进表单（必须过 sanitizeRecordForForm）', () => {
    assert.match(src, /sanitizeRecordForForm\(currObj\)/);
    // 以前是 `...(currObj || {})` 与 `initialValues={currObj || {}}` —— 那就是回填明文的地方
    assert.ok(!/\.\.\.\(currObj \|\| \{\}\)/.test(src), '不能再直接展开 currObj');
    assert.ok(!/initialValues=\{currObj \|\| \{\}\}/.test(src), 'initialValues 不能再是原始 currObj');
  });

  it('每次打开都显式清掉残留的 password / clearPassword（防止串台误清除）', () => {
    assert.match(src, /password: undefined/);
    assert.match(src, /clearPassword: false/);
  });

  it('用 buildAccessPasswordPatch / buildSubmitValues 决定提交体', () => {
    assert.match(src, /buildAccessPasswordPatch\(/);
    assert.match(src, /buildSubmitValues\(values, accessPatch\)/);
  });

  it('清除密码有独立开关 + 二次确认（antd4：用 content，不是 description）', () => {
    assert.match(src, /ProFormSwitch/);
    assert.match(src, /name="clearPassword"/);
    assert.match(src, /shouldShowClearOption/);
    assert.match(src, /Modal\.confirm\(/);
    assert.ok(!/description:/.test(src), 'antd4 的 Modal.confirm 没有 description');
  });

  it('密码框挡浏览器自动填充（自动填充 + "留空=不修改" = 悄悄改密码）', () => {
    assert.match(src, /autoComplete: 'new-password'/);
  });

  it('不可找回的警告出现在用户看得见的地方', () => {
    assert.match(src, /passwordHelp\(/);
    assert.match(src, /PRIVATE_TOGGLE_HINT/);
  });
});

describe('分类管理（DataManage/tabs/Category.jsx）接线', () => {
  const src = codeOnly(read('src/pages/DataManage/tabs/Category.jsx'));

  it('不再把 record.password 回填进表单', () => {
    assert.ok(!/password:\s*record\.password/.test(src), '分类表单不能再回填密码');
    assert.match(src, /hasPasswordFromRecord\(record\)/);
  });

  it('三态契约 + 二次确认 + 清除开关都在', () => {
    assert.match(src, /buildAccessPasswordPatch\(/);
    assert.match(src, /buildSubmitValues\(formValues, access\.patch\)/);
    assert.match(src, /ProFormSwitch/);
    assert.match(src, /name="clearPassword"/);
    assert.match(src, /shouldShowClearOption/);
    assert.match(src, /Modal\.confirm\(/);
    assert.ok(!/description:/.test(src), 'antd4 的 Modal.confirm 没有 description');
  });

  it('旧的"如若加密请填写密码"硬校验换成了统一逻辑（否则已加密分类再也存不了）', () => {
    assert.ok(
      !/if \(values\.private && !values\.password\)/.test(src),
      '这条老校验会让"已设密码 + 留空"永远报错',
    );
  });

  it('列表里能看到"设没设密码"，且 tooltip 讲了不可找回', () => {
    assert.match(src, /title: '访问密码'/);
    assert.match(src, /PASSWORD_UNRECOVERABLE_WARNING/);
  });
});

describe('新建/发布路径：加密却没密码时拦在表单里', () => {
  const newArticle = codeOnly(read('src/components/NewArticleModal/index.jsx'));
  const publishDraft = codeOnly(read('src/components/PublishDraftModal/index.jsx'));

  it('新建文章弹窗会校验（否则造出一篇谁也打不开、密码又找不回的文章）', () => {
    assert.match(newArticle, /buildAccessPasswordPatch\(/);
    assert.match(newArticle, /isCreate: true/);
    assert.match(newArticle, /message\.error\(access\.error\)/);
  });

  it('发布草稿弹窗同样校验', () => {
    assert.match(publishDraft, /buildAccessPasswordPatch\(/);
    assert.match(publishDraft, /isCreate: true/);
    assert.match(publishDraft, /message\.error\(access\.error\)/);
  });

  it('两个新建入口都写清了"留空 = 不加密"与不可找回', () => {
    assert.match(newArticle, /passwordPlaceholder\(\{ isCreate: true \}\)/);
    assert.match(newArticle, /passwordHelp\(\{ isCreate: true \}\)/);
    assert.match(publishDraft, /passwordPlaceholder\(\{ isCreate: true \}\)/);
    assert.match(publishDraft, /passwordHelp\(\{ isCreate: true \}\)/);
  });
});

// ---------------------------------------------------------------------------
// 3) 跨包契约钉子：前端字段名必须与服务端 DTO 逐字一致
// ---------------------------------------------------------------------------

describe('前后端字段名一致（clearPassword / hasPassword / password）', () => {
  const articleDto = read('src/types/article.dto.ts', serverRoot);
  const categoryDto = read('src/types/category.dto.ts', serverRoot);
  const accessUtil = read('src/utils/accessPassword.ts', serverRoot);
  const front = read('src/services/van-blog/accessPassword.js');

  it('服务端两个 DTO 都声明了 clearPassword', () => {
    assert.match(articleDto, /clearPassword\?: boolean/);
    assert.match(categoryDto, /clearPassword\?: boolean/);
  });

  it('服务端把 clearPassword 定义为"只认 true / \'true\'"，前端也只发 true', () => {
    assert.match(accessUtil, /value === true \|\| value === 'true'/);
    assert.match(front, /\[CLEAR_PASSWORD_FIELD\]: true/);
  });

  it('服务端用 hasPassword 下发布尔，前端按同名读取', () => {
    assert.match(accessUtil, /plain\.hasPassword = hasAccessPasswordValue\(value\)/);
    assert.match(accessUtil, /delete plain\.password/);
    assert.match(front, /HAS_PASSWORD_FIELD = 'hasPassword'/);
  });

  it('服务端"留空 = 不修改"的实现确实是从 patch 里删掉 password 键', () => {
    assert.match(accessUtil, /password: mode === 'create' \? '' : undefined/);
  });
});
