const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const serverRoot = path.join(adminRoot, '../server');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readServer = (rel) => readFileSync(path.join(serverRoot, rel), 'utf8');

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

const setupKeyCore = require('../../src/pages/InitPage/setupKeyCore');
const restoreCore = require('../../src/pages/InitPage/restoreCore');

describe('setupKeyCore：字段名与提示（与服务端 wire 契约对齐）', () => {
  it('字段名固定 setupKey（两条初始化路由共用）', () => {
    assert.equal(setupKeyCore.SETUP_KEY_FIELD, 'setupKey');
  });

  it('提示第一条先讲"新版默认要求密钥"，再指路 docker logs / setup.key / 重启重新生成；逃生口只作次要说明', () => {
    const hints = setupKeyCore.SETUP_KEY_HINTS;
    const joined = hints.join('\n');
    assert.ok(hints[0].includes('默认要求初始化密钥'));
    assert.ok(hints[0].includes('每 10 分钟重印一次')); // 未初始化期间反复打印（站长要求）
    assert.ok(joined.includes('docker logs'));
    assert.ok(joined.includes('setup.key'));
    assert.ok(joined.includes('重新生成'));
    assert.ok(joined.includes('VANBLOG_SETUP_KEY_REMIND_MINUTES'));
    // 逃生口是**最后一条**（次要说明，不喧宾夺主）
    assert.ok(hints[hints.length - 1].includes('VANBLOG_INIT_REQUIRE_SETUP_KEY=false'));
    assert.ok(hints[hints.length - 1].includes('不推荐'));
  });
});

describe('isSetupKeyRejectionPayload：机器标志优先，文案匹配只作兜底', () => {
  it('body.setupKeyRequired === true → 命中', () => {
    assert.equal(
      setupKeyCore.isSetupKeyRejectionPayload({
        statusCode: 400,
        message: '随便什么话',
        setupKeyRequired: true,
      }),
      true,
    );
  });

  it('400 + 服务端指路文案（老形状/标志被网关吃掉）→ 兜底命中', () => {
    // 用的是服务端 setupKeyFailureMessage 的**真实全文**（不是随手编的短文案）
    assert.equal(
      setupKeyCore.isSetupKeyRejectionPayload({
        statusCode: 400,
        message:
          '本站开启了初始化保护（VANBLOG_INIT_REQUIRE_SETUP_KEY=true），但请求里没有初始化密钥（字段名 setupKey）：请在「初始化密钥」一栏填入后重试。',
      }),
      true,
    );
    assert.equal(
      setupKeyCore.isSetupKeyRejectionPayload({ statusCode: 400, message: '请填入 /var/log/setup.key 的内容' }),
      true,
    );
  });

  it('其它 400 / 非 400 / 空值 → 不命中（绝不把普通校验错误当成要密钥）', () => {
    assert.equal(
      setupKeyCore.isSetupKeyRejectionPayload({ statusCode: 400, message: '读不出这个备份的清单' }),
      false,
    );
    assert.equal(
      setupKeyCore.isSetupKeyRejectionPayload({ statusCode: 500, message: '初始化密钥不正确' }),
      false,
    );
    assert.equal(setupKeyCore.isSetupKeyRejectionPayload(null), false);
    assert.equal(setupKeyCore.isSetupKeyRejectionPayload('boom'), false);
    assert.equal(setupKeyCore.isSetupKeyRejectionPayload({ setupKeyRequired: 'true' }), false); // 字符串不算
  });
});

describe('extractSetupKeyRejection：从 umi-request 的错误对象里取信号', () => {
  it('err.data 带 setupKeyRequired → required:true + 服务端原话', () => {
    const r = setupKeyCore.extractSetupKeyRejection({
      data: { statusCode: 400, message: '请填入初始化密钥…', setupKeyRequired: true },
    });
    assert.deepEqual(r, { required: true, unavailable: false, message: '请填入初始化密钥…' });
  });

  it('err.info 同样认（两种 umi 错误形状都照顾到）', () => {
    const r = setupKeyCore.extractSetupKeyRejection({
      info: { statusCode: 400, message: '初始化密钥不正确…', setupKeyRequired: true },
    });
    assert.equal(r.required, true);
    assert.equal(r.message, '初始化密钥不正确…');
  });

  it('setupKeyUnavailable（服务端 500）→ unavailable:true、required:false（显示输入框没有意义）', () => {
    const r = setupKeyCore.extractSetupKeyRejection({
      data: { statusCode: 500, message: '服务端当前没有可用的初始化密钥…', setupKeyUnavailable: true },
    });
    assert.equal(r.unavailable, true);
    assert.equal(r.required, false);
    assert.ok(r.message.includes('没有可用的初始化密钥'));
  });

  it('普通错误 / 空错误 → required:false（不误显示输入框）', () => {
    assert.equal(setupKeyCore.extractSetupKeyRejection({ data: { statusCode: 500, message: '已初始化' } }).required, false);
    assert.equal(setupKeyCore.extractSetupKeyRejection(undefined).required, false);
    assert.equal(setupKeyCore.extractSetupKeyRejection(new Error('network')).required, false);
  });
});

describe('parseRestoreResponse：setupKeyRequired 只条件性透传（旧形状逐字节不变）', () => {
  it('400 + setupKeyRequired:true → 失败结果带同名键 + 服务端原话', () => {
    const r = restoreCore.parseRestoreResponse(
      400,
      JSON.stringify({
        statusCode: 400,
        message: '本站开启了初始化保护…',
        setupKeyRequired: true,
        reason: 'setupKeyMissing',
      }),
    );
    assert.deepEqual(r, { ok: false, message: '本站开启了初始化保护…', setupKeyRequired: true });
  });

  it('没有该标志的失败 → 结果对象**不多任何键**（既有消费方与用例钉住的形状）', () => {
    const r = restoreCore.parseRestoreResponse(
      400,
      JSON.stringify({ statusCode: 400, message: '读不出这个备份的清单' }),
    );
    assert.deepEqual(r, { ok: false, message: '读不出这个备份的清单' });
    assert.equal('setupKeyRequired' in r, false);
  });

  it('成功路径不受影响', () => {
    const r = restoreCore.parseRestoreResponse(200, JSON.stringify({ statusCode: 200, data: { seconds: 1 } }));
    assert.deepEqual(r, { ok: true, data: { seconds: 1 } });
  });
});

describe('InitPage 接线（源码断言，已剔除注释）', () => {
  const page = codeOnly(read('src/pages/InitPage/index.tsx'));

  it('密钥输入框只在服务端真的要时出现（条件渲染，不是常摆一个空框）', () => {
    assert.ok(page.includes('{setupKeyRequired && ('));
    assert.ok(page.includes('useState(false)')); // 初始不显示
  });

  it('输入框是 type=password（Input.Password）且 autoComplete="off"', () => {
    assert.ok(page.includes('<Input.Password'));
    assert.ok(page.includes('autoComplete="off"'));
  });

  it('服务端 400 的原话被挂在面板上，提示里指路 docker logs / setup.key', () => {
    assert.ok(page.includes('markSetupKeyRequired(rejection.message)'));
    // 🔴 i18n 之后：提示通过 getSetupKeyHints(t) 取（不传 t 时逐字等于 SETUP_KEY_HINTS，
    //    所以本文件上面那些针对常量内容的断言依旧有效）。性质不变：提示确实被渲染成列表。
    assert.ok(page.includes('getSetupKeyHints(t)'));
    assert.ok(page.includes('setupKeyHints.map'));
  });

  it('向导提交只在真的有值时携带 setupKey（默认请求体与旧版逐字节一致）', () => {
    assert.ok(page.includes('...(trimmedKey ? { [SETUP_KEY_FIELD]: trimmedKey } : {})'));
    assert.ok(page.includes('fetchInit(newData)'));
  });

  it('与「用备份恢复」共享同一个密钥状态（一个输入框喂两条提交路径）', () => {
    assert.ok(page.includes('<RestoreFromBackup setupKey={setupKeyValue} onSetupKeyRequired={markSetupKeyRequired} />'));
  });

  it('页面加载时不发任何探测请求（不烧 /api/admin/init* 的 5 次/10 分钟限流预算）', () => {
    assert.ok(!page.includes('useEffect'));
  });
});

describe('RestoreFromBackup 接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/pages/InitPage/RestoreFromBackup.tsx'));

  it('密钥随 multipart 一起发（文本字段 setupKey，文件字段照旧）', () => {
    assert.ok(comp.includes('form.append(INIT_RESTORE_FILE_FIELD, file)'));
    assert.ok(comp.includes('form.append(SETUP_KEY_FIELD, key)'));
  });

  it('400 setupKeyRequired → 通知父组件显示输入框 + 弹窗原样展示服务端 message + 指路提示', () => {
    assert.ok(comp.includes('if (result.setupKeyRequired) {'));
    assert.ok(comp.includes('onSetupKeyRequired(result.message)'));
    assert.ok(
      comp.includes(
        'setupKeyHints.concat(describeRestoreFailure(xhr.status, result.message, t))',
      ),
    );
    assert.ok(comp.includes('{result.message}'));
  });
});

describe('跨包契约钉子：前端读的字段/标志与服务端发的完全一致', () => {
  const controller = codeOnly(readServer('src/controller/admin/init/init.controller.ts'));
  const setupKeyMod = codeOnly(readServer('src/provider/init/setupKey.ts'));
  const provider = codeOnly(readServer('src/provider/init/init.provider.ts'));

  it('两条路由都从 body 的 setupKey 字段取值（JSON 顶层 / multipart 文本字段同名）', () => {
    assert.equal(controller.split("@Body('setupKey')").length - 1, 2);
  });

  it('两条路由都过闸门（经由 InitProvider.assertSetupKeyAllowed，生产 fail-closed）', () => {
    assert.equal(
      controller.split('runSetupKeyGate(this.initProvider, setupKey, this.logger)').length - 1,
      2,
    );
    assert.ok(provider.includes('assertSetupKeyAllowed(supplied: unknown): void'));
    assert.ok(provider.includes('enforceSetupKey(supplied)'));
  });

  it('400 body 带 setupKeyRequired:true 与 reason（前端 isSetupKeyRejectionPayload 读的就是它们）', () => {
    assert.ok(setupKeyMod.includes('setupKeyRequired: true'));
    assert.ok(setupKeyMod.includes("reason: reason === 'missing' ? 'setupKeyMissing' : 'setupKeyWrong'"));
  });

  it('开关默认翻转：未设置/空 = 开启；显式 falsy 才关；打错的值 = 开启 + recognized:false', () => {
    assert.ok(setupKeyMod.includes("if (value === '' || TRUTHY.has(value))"));
    assert.ok(setupKeyMod.includes('return { enabled: true, recognized: false };'));
  });

  it('服务端 400 文案与日志块都指路（docker logs + setup.key 文件），前端提示只是补充', () => {
    assert.ok(setupKeyMod.includes('docker logs'));
    assert.ok(setupKeyMod.includes('setup.key'));
    // 逃生口写进日志块文案（源码里是 ${SETUP_KEY_REQUIRE_ENV}=false 的模板拼接）
    assert.ok(setupKeyMod.includes('${SETUP_KEY_REQUIRE_ENV}=false'));
    assert.ok(setupKeyMod.includes("SETUP_KEY_REQUIRE_ENV = 'VANBLOG_INIT_REQUIRE_SETUP_KEY'"));
  });

  it('密钥绝不出现在任何响应里（服务端只回指路消息；比较用常量时间 safeEqual）', () => {
    assert.ok(setupKeyMod.includes('safeEqual(given, expected)'));
    assert.ok(!controller.includes('currentSetupKey'));
    assert.ok(!controller.includes('readSetupKey'));
  });
});
