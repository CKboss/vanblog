const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const packagesRoot = path.join(adminRoot, '..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');
const readPackages = (rel) => readFileSync(path.join(packagesRoot, rel), 'utf8');

// 新加的注释里会引用旧写法 / 服务端文案，断言前先把注释行去掉，不然自己匹配自己。
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

const MODAL = 'src/components/CoverBackfillModal/index.jsx';
const HELPER = 'src/services/van-blog/coverBackfill.js';
const API = 'src/services/van-blog/api.js';

const {
  EMPTY_RESULT_TEXT,
  PREVIEW_LIMIT,
  normalizeBackfillItems,
  summarizeBackfill,
  toRevertPayload,
  toThumbUrl,
} = require('../../src/services/van-blog/coverBackfill');

// 服务端 items 的真实形状（cover / previousCover 都是图床相对地址）
const ITEM_A = {
  id: 1,
  title: '第一篇',
  cover: '/static/img/aaaa.first.webp',
  previousCover: '',
};
const ITEM_B = {
  id: 2,
  title: '第二篇',
  cover: '/static/img/bbbb.second.webp',
  previousCover: '/static/img/old.webp',
};

function previewPayload(items = [ITEM_A, ITEM_B]) {
  return {
    scanned: 53,
    matched: items.length,
    changed: 0,
    skippedNoImage: 20,
    skippedHasCover: 30,
    dryRun: true,
    items,
  };
}

describe('coverBackfill 纯函数：缩略图地址', () => {
  it('本站图床地址换成 /static/img/thumb/ 下的同名缩略图', () => {
    assert.equal(toThumbUrl('/static/img/aaaa.first.webp'), '/static/img/thumb/aaaa.first.webp');
    // 子目录里的图也要保持在 thumb 下的相对结构
    assert.equal(toThumbUrl('/static/img/2024/b.png'), '/static/img/thumb/2024/b.png');
  });

  it('已经是缩略图的原样返回（不能变成 thumb/thumb）', () => {
    const url = '/static/img/thumb/aaaa.first.webp';
    assert.equal(toThumbUrl(url), url);
  });

  it('外链、其它路径与空值不改写（交给调用方的 onError 兜底）', () => {
    // 老文章正文里有绝对域名的图片，本站没有它们的缩略图
    assert.equal(
      toThumbUrl('https://example.invalid/a/b.webp'),
      'https://example.invalid/a/b.webp',
    );
    assert.equal(toThumbUrl('/static/attachment/x.pdf'), '/static/attachment/x.pdf');
    assert.equal(toThumbUrl(''), '');
    assert.equal(toThumbUrl(undefined), '');
    assert.equal(toThumbUrl(null), '');
    assert.equal(toThumbUrl(123), '');
    // 前后空格要 trim，否则 startsWith 判断不出来
    assert.equal(toThumbUrl('  /static/img/a.webp  '), '/static/img/thumb/a.webp');
  });

  it('规范化 items 时顺手算好 thumb，并丢掉没有 id / 没有 cover 的条目', () => {
    const items = normalizeBackfillItems({
      items: [ITEM_A, { id: 'x', cover: '/static/img/c.webp' }, { id: 3 }, { id: 4, cover: ' ' }],
    });
    assert.deepEqual(
      items.map((i) => i.id),
      [1],
      '没有 id 写不进去也撤销不了，没有 cover 写进去等于清空封面，都必须丢掉',
    );
    assert.equal(items[0].thumb, '/static/img/thumb/aaaa.first.webp');
    assert.equal(items[0].previousCover, '');
    // 直接传数组也认（组件里两个阶段的 items 来源不同）
    assert.equal(normalizeBackfillItems([ITEM_B])[0].id, 2);
    assert.deepEqual(normalizeBackfillItems(undefined), []);
    assert.deepEqual(normalizeBackfillItems({}), []);
  });

  it('items 超过服务端上限时按 PREVIEW_LIMIT 截断，标题缺失时兜底', () => {
    const many = Array.from({ length: PREVIEW_LIMIT + 50 }, (_, i) => ({
      id: i,
      title: i === 0 ? '   ' : `t${i}`,
      cover: `/static/img/${i}.webp`,
      previousCover: '',
    }));
    const items = normalizeBackfillItems({ items: many });
    assert.equal(items.length, PREVIEW_LIMIT);
    assert.equal(items[0].title, '文章 0', '标题为空时用「文章 <id>」，否则预览里是一行空白');
  });
});

describe('coverBackfill 纯函数：摘要与撤销载荷', () => {
  it('dryRun 时「将写入」取 matched（服务端 changed 恒为 0）', () => {
    const s = summarizeBackfill(previewPayload());
    assert.equal(s.dryRun, true);
    assert.equal(s.willChange, 2);
    assert.deepEqual(
      s.rows.map((r) => r.label),
      ['扫描', '有首图', '将写入', '已有封面跳过', '无图跳过'],
    );
    assert.deepEqual(
      s.rows.map((r) => r.value),
      [53, 2, 2, 30, 20],
    );
    assert.deepEqual(s.ids, [1, 2]);
    assert.equal(s.emptyText, '');
  });

  it('真正写入后「已写入」取 changed', () => {
    const s = summarizeBackfill({ ...previewPayload(), dryRun: false, changed: 2 });
    assert.equal(s.dryRun, false);
    assert.equal(s.willChange, 2);
    assert.equal(s.rows.find((r) => r.key === 'willChange').label, '已写入');
  });

  it('字段缺失 / 脏数据一律按 0 算，一条都没匹配上时给出明确文案', () => {
    const empty = summarizeBackfill({ dryRun: true });
    assert.deepEqual(
      empty.rows.map((r) => r.value),
      [0, 0, 0, 0, 0],
    );
    assert.deepEqual(empty.items, []);
    assert.equal(empty.emptyText, EMPTY_RESULT_TEXT);
    assert.equal(EMPTY_RESULT_TEXT, '所有文章都已有封面，或正文里没有可用图片');
    const junk = summarizeBackfill({ scanned: 'x', matched: null, items: 'nope' });
    assert.equal(junk.scanned, 0);
    assert.deepEqual(junk.items, []);
  });

  it('撤销载荷把 previousCover 填进 cover 字段（服务端按 {id, cover} 写回旧值）', () => {
    assert.deepEqual(toRevertPayload([ITEM_A, ITEM_B]), [
      { id: 1, cover: '' },
      { id: 2, cover: '/static/img/old.webp' },
    ]);
    // 原来没封面 → 写回空串，不能因为「falsy」就把这条丢掉
    assert.equal(toRevertPayload([ITEM_A]).length, 1);
    assert.deepEqual(toRevertPayload([{ id: NaN, previousCover: 'x' }]), []);
    assert.deepEqual(toRevertPayload(undefined), []);
    // previousCover 缺失时兜底成空串，不能把 undefined 发给服务端
    assert.deepEqual(toRevertPayload([{ id: 7 }]), [{ id: 7, cover: '' }]);
  });

  it('一次完整流程：预览全选 → 勾掉一篇 → 只撤销写入过的那几篇', () => {
    const preview = summarizeBackfill(previewPayload());
    const kept = preview.ids.filter((id) => id !== 2); // 用户在预览里取消了第二篇
    const written = summarizeBackfill({
      ...previewPayload([ITEM_A]),
      dryRun: false,
      changed: 1,
      matched: 1,
      scanned: 53,
    });
    assert.deepEqual(kept, [1]);
    assert.deepEqual(toRevertPayload(written.items), [{ id: 1, cover: '' }]);
  });
});

describe('补封面接口：api.js', () => {
  const api = read(API);
  const fn = (name) => {
    const m = api.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `api.js 必须导出 ${name}`);
    return m[0];
  };

  it('backfillCoversFromContent：POST /api/admin/article/covers/from-content，透传 body', () => {
    const code = fn('backfillCoversFromContent');
    assert.match(code, /request\('\/api\/admin\/article\/covers\/from-content', \{/);
    assert.match(code, /method: 'POST'/);
    assert.match(code, /data: body/);
  });

  it('revertBackfilledCovers：POST /api/admin/article/covers/revert，body 是 { items }', () => {
    const code = fn('revertBackfilledCovers');
    assert.match(code, /request\('\/api\/admin\/article\/covers\/revert', \{/);
    assert.match(code, /method: 'POST'/);
    assert.match(code, /data: \{ items \}/);
  });

  it('两个接口都不带 skipErrorHandler：演示站的 statusCode:401 要靠全局 handler 弹出来', () => {
    for (const name of ['backfillCoversFromContent', 'revertBackfilledCovers']) {
      assert.doesNotMatch(codeOnly(fn(name)), /skipErrorHandler/);
      // 也不能写死协议 / 域名 / IP：这两个地址必须是同源的相对路径
      assert.doesNotMatch(codeOnly(fn(name)), /https?:\/\//);
      assert.doesNotMatch(codeOnly(fn(name)), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    }
  });

  it('演示站的 {statusCode:401} 由全局 handler 弹一次，业务侧不再叠加第二条', () => {
    const {
      reportRequestError,
      shouldShowRequestError,
    } = require('../../src/services/van-blog/requestError');
    // umi 的 errorAdaptor 会把 statusCode != 200 的响应变成 BizError（error.data = 原始响应体）
    const demoErr = {
      name: 'BizError',
      message: '演示站禁止修改此项！',
      data: { statusCode: 401, message: '演示站禁止修改此项！' },
    };
    assert.equal(shouldShowRequestError(demoErr), true, '全局 errorHandler 应该弹这句话');
    const messageApi = createMessageApi();
    assert.equal(reportRequestError(messageApi, demoErr, '写入失败！'), false);
    assert.deepEqual(messageApi.calls, [], '同一次失败不许弹两条 toast');
    // 反过来：接口万一被改成 skipErrorHandler，兜底文案必须能弹出来
    const silent = { message: 'boom', request: { options: { skipErrorHandler: true } } };
    const api2 = createMessageApi();
    assert.equal(reportRequestError(api2, silent, '写入失败！'), true);
    assert.deepEqual(api2.calls, [{ type: 'error', text: '写入失败！' }]);
  });

  it('服务端契约（只读，别改 server）：两个路由都在文章控制器上', () => {
    const controller = readPackages('server/src/controller/admin/article/article.controller.ts');
    assert.match(controller, /@Post\('covers\/from-content'\)/);
    assert.match(controller, /@Post\('covers\/revert'\)/);
  });
});

describe('补封面弹窗：dryRun 预览 → 勾选 → 写入 → 撤销', () => {
  const code = read(MODAL);
  const only = codeOnly(code);

  it('入口按钮在文章管理工具栏，文案是「从正文首图补封面」', () => {
    assert.match(code, /从正文首图补封面/);
    assert.match(code, /onClick=\{handleOpen\}/);

    const page = read('src/pages/Article/index.jsx');
    assert.match(page, /import CoverBackfillModal from '@\/components\/CoverBackfillModal';/);
    const toolbar = slice(page, 'toolBarRender={() => [', ']}');
    assert.match(toolbar, /<CoverBackfillModal/);
    assert.match(toolbar, /key="coverBackfillBtn"/);
    // 写完 / 撤销完都要刷新列表，否则新封面要等手动刷新才看得见
    assert.match(toolbar, /actionRef\?\.current\?\.reload\(\)/);
    // 和「生成拼音路径」并排，别把批量按钮拆到别处
    assert.ok(toolbar.indexOf('生成拼音路径') < toolbar.indexOf('<CoverBackfillModal'));
  });

  it('打开弹窗先跑 dryRun，确认写入才发 dryRun:false + 选中的 ids', () => {
    const preview = slice(only, 'const runPreview = async () => {', 'const handleOpen');
    assert.match(preview, /backfillCoversFromContent\(\{ dryRun: true, onlyMissing: true \}\)/);
    // 🔴 期 5 第九批起 summarizeBackfill 收注入式翻译器（尾参 t）⇒ 锚点换形状，性质没放
    assert.match(preview, /summarizeBackfill\(res\?\.data, t\)/);
    // 默认全选，用户只做减法
    assert.match(preview, /setSelectedIds\(data\.ids\);/);

    const write = slice(only, 'const handleConfirm = async () => {', 'const handleRevert');
    assert.match(write, /dryRun: false/);
    assert.match(write, /onlyMissing: true/);
    assert.match(write, /ids: selectedIds/);

    // 顺序：dryRun 在前（打开即预览），真正写库在后
    assert.ok(
      only.indexOf('dryRun: true') < only.indexOf('dryRun: false'),
      'dryRun 预览必须排在写入之前',
    );
    assert.ok(
      only.indexOf('runPreview();') < only.indexOf('dryRun: false'),
      '打开弹窗（handleOpen → runPreview）必须排在写入之前',
    );
    // 写入成功之前不许 setResult / 报成功，否则失败也会进「可撤销」阶段
    const writeIdx = write.indexOf('await backfillCoversFromContent');
    assert.ok(writeIdx > -1 && write.indexOf('setResult(data);') > writeIdx);
    assert.ok(write.indexOf('message.success(') > writeIdx);
  });

  it('确认按钮：没选中或请求在飞时禁用，文案带选中篇数', () => {
    assert.match(only, /const busy = previewLoading \|\| writing \|\| reverting;/);
    const footer = slice(only, 'const footer = result ? (', 'return (\n    <>');
    assert.match(footer, /disabled=\{!selectedIds\.length \|\| busy\}/);
    assert.match(footer, /loading=\{writing\}/);
    // 🔴 期 5 第九批起文案走 t() + ICU ⇒ 锚点换形状，🔴 仍然钉住「篇数来自 selectedIds.length」
    assert.match(footer, /t\('cover\.confirmWrite', '确认写入（\{count\} 篇）', \{ count: selectedIds\.length \}\)/);
    assert.match(footer, /取消/);
    // 一条都没匹配上时 selectedIds 必为空 → 同一个 disabled 条件就把确认按钮关掉了，
    // 并且要把原因说清楚
    assert.match(code, /description=\{summary\.emptyText\}/);
    assert.match(code, /data-cover-backfill-empty/);
  });

  it('预览图走缩略图，并有 onError 退回原图（只退一次）', () => {
    assert.match(code, /src=\{item\.thumb \|\| item\.cover\}/);
    assert.match(code, /onError=\{\(e\) => \{/);
    assert.match(code, /img\.src = item\.cover;/);
    // 原图也 404 时再赋值会无限触发 onError，必须有一次性标记
    assert.match(code, /coverBackfillFallback === '1'/);
    assert.match(code, /img\.dataset\.coverBackfillFallback = '1';/);
    // 几十张图：懒加载 + 异步解码（与图片管理页一致）
    assert.match(code, /loading="lazy"/);
    assert.match(code, /decoding="async"/);
    // 预览列表可滚动，不能把弹窗撑爆
    assert.match(code, /maxHeight: 320/);
    assert.match(code, /overflowY: 'auto'/);
    // thumb 由纯函数算（组件里不再手拼字符串）
    assert.match(only, /summarizeBackfill/);
    assert.doesNotMatch(only, /\/static\/img\/thumb\//);
  });

  it('每条预览有独立勾选框，另有全选 / 反选与已选计数', () => {
    assert.match(code, /checked=\{selectedIds\.includes\(item\.id\)\}/);
    assert.match(code, /onChange=\{\(e\) => toggleOne\(item\.id, e\.target\.checked\)\}/);
    assert.match(code, /全选/);
    assert.match(code, /反选/);
    assert.match(code, /indeterminate=\{selectedIds\.length > 0 && !allSelected\}/);
    assert.match(code, /setSelectedIds\(e\.target\.checked \? allIds : \[\]\)/);
    assert.match(
      code,
      /setSelectedIds\(allIds\.filter\(\(id\) => !selectedIds\.includes\(id\)\)\)/,
    );
    // 🔴 同上：已选计数走 t() + ICU，两个计数都必须还在
    assert.match(code, /t\('cover\.selectedCount', '已选 \{selected\} \/ \{total\} 篇'/);
    assert.match(code, /data-cover-backfill-count/);
  });

  it('写入成功后提供「撤销本次改动」，回传 previousCover，撤销完刷新列表', () => {
    const revert = slice(
      only,
      'const handleRevert = async () => {',
      'const renderRows = (rows) => (',
    );
    assert.match(revert, /revertBackfilledCovers\(toRevertPayload\(writtenItems\)\)/);
    assert.match(revert, /if \(!writtenItems\.length \|\| busy\) \{/);
    assert.match(revert, /res\?\.data\?\.reverted/);
    assert.match(revert, /onFinish\(\);/);
    // writtenItems 来自写入响应的 items（带 previousCover），不是预览时那份
    assert.match(only, /const writtenItems = result\?\.items \|\| \[\];/);
    const footer = slice(only, 'const footer = result ? (', 'return (\n    <>');
    assert.match(footer, /撤销本次改动/);
    assert.match(footer, /disabled=\{!writtenItems\.length \|\| reverted\}/);
    assert.match(footer, /loading=\{reverting\}/);
    // 撤销载荷的字段映射由纯函数钉住：cover 位置填的是 previousCover
    assert.deepEqual(
      toRevertPayload([{ id: 9, cover: '/static/img/new.webp', previousCover: '' }]),
      [{ id: 9, cover: '' }],
    );
  });

  it('三个请求都是 try/catch/finally + reportRequestError，loading 一定收得掉', () => {
    assert.equal((only.match(/try \{/g) || []).length, 3);
    assert.equal((only.match(/\} catch \(err\) \{/g) || []).length, 3);
    assert.equal((only.match(/\} finally \{/g) || []).length, 3);
    assert.equal((only.match(/reportRequestError\(message, err, /g) || []).length, 3);
    for (const text of ['预览失败！', '写入失败！', '撤销失败！']) {
      // 🔴 期 5 第九批起兜底文案走 t()：仍然要求"这三句话逐字还在"（只是多包了一层 t + key）
      assert.match(only, new RegExp(`reportRequestError\\(message, err, t\\('[a-zA-Z.]+', '${text}'\\)\\)`));
    }
    // 每个 loading 只在 finally 里清一次
    for (const setter of ['setPreviewLoading(false)', 'setWriting(false)', 'setReverting(false)']) {
      assert.equal(
        (only.match(new RegExp(setter.replace(/[()]/g, '\\$&'), 'g')) || []).length,
        1,
        `${setter} 只应该出现在 finally 里`,
      );
      assert.match(
        only,
        new RegExp(`\\} finally \\{\\s*${setter.replace(/[()]/g, '\\$&')};\\s*\\}`),
      );
    }
    // 不许自己造第二条 toast 路径
    assert.doesNotMatch(only, /message\.error\(/);
    assert.match(
      code,
      /import \{ reportRequestError \} from '@\/services\/van-blog\/requestError';/,
    );
  });

  it('入库文件里没有私密的机器信息（域名 / IP / 绝对家目录），也不许出现 skipErrorHandler', () => {
    for (const rel of [MODAL, HELPER]) {
      const text = read(rel);
      assert.doesNotMatch(text, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, `${rel} 不许写死 IP`);
      assert.doesNotMatch(text, /https?:\/\//, `${rel} 不许写死协议与域名`);
      assert.doesNotMatch(text, /\/home\/|blog-demo/, `${rel} 不许出现本机路径或演示站域名`);
      assert.doesNotMatch(codeOnly(text), /skipErrorHandler/, `${rel} 不该绕过全局错误处理`);
    }
    // 组件不许直接引 pro-components 桶（AGENTS.md §7.13）
    assert.doesNotMatch(only, /@ant-design\/pro-components/);
  });
});
