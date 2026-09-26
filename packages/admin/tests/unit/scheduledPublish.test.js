const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

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

const schedule = require('../../src/services/van-blog/schedule');
const { formatDateTime } = require('../../src/services/van-blog/formatTime');

const NOW = Date.UTC(2026, 8, 17, 0, 0, 0); // 固定的「现在」，用例不随时间腐烂
const FUTURE_ISO = new Date(NOW + 3 * 24 * 3600 * 1000).toISOString();
const PAST_ISO = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString();

describe('schedule.parsePublishAt：各种来源都要能解析，坏值 → NaN', () => {
  it('ISO 串 / Date / 数字时间戳', () => {
    assert.equal(schedule.parsePublishAt(FUTURE_ISO), Date.parse(FUTURE_ISO));
    assert.equal(schedule.parsePublishAt(new Date(NOW)), NOW);
    assert.equal(schedule.parsePublishAt(NOW), NOW);
  });

  it('naive 串（pro-form dateFormatter="string" 提交的形状）按本地时间解析', () => {
    const ms = schedule.parsePublishAt('2026-09-20 09:00:00');
    assert.equal(ms, new Date(2026, 8, 20, 9, 0, 0).getTime());
    assert.ok(!Number.isNaN(ms));
  });

  it('moment 形状（有 valueOf 的对象）', () => {
    const momentLike = { valueOf: () => NOW };
    assert.equal(schedule.parsePublishAt(momentLike), NOW);
  });

  it('空值 / 坏值 → NaN', () => {
    for (const bad of [null, undefined, '', '   ', 'nope', NaN, Infinity, { valueOf: () => 'x' }]) {
      assert.ok(Number.isNaN(schedule.parsePublishAt(bad)), `should be NaN: ${String(bad)}`);
    }
  });
});

describe('schedule.isScheduled：以 publishAt 是否严格晚于 now 为准（契约要求前端自行推导）', () => {
  it('未来 → true；过去 / 恰好等于 now / 坏值 / 空 → false', () => {
    assert.equal(schedule.isScheduled(FUTURE_ISO, NOW), true);
    assert.equal(schedule.isScheduled(PAST_ISO, NOW), false);
    assert.equal(schedule.isScheduled(new Date(NOW).toISOString(), NOW), false, '边界：等于 now 不算定时中');
    assert.equal(schedule.isScheduled(null, NOW), false);
    assert.equal(schedule.isScheduled('garbage', NOW), false);
    assert.equal(schedule.isScheduled(undefined), false);
  });

  it('isPastSchedule 与 isScheduled 互补（有效日期二者必居其一）', () => {
    assert.equal(schedule.isPastSchedule(PAST_ISO, NOW), true);
    assert.equal(schedule.isPastSchedule(FUTURE_ISO, NOW), false);
    assert.equal(schedule.isPastSchedule(new Date(NOW).toISOString(), NOW), true);
    assert.equal(schedule.isPastSchedule(null, NOW), false);
    assert.equal(schedule.isPastSchedule('garbage', NOW), false);
  });
});

describe('schedule.normalizePublishAtForSave：清空必须发 null，有效值发 ISO 串', () => {
  it('空值 → null（undefined 会在 JSON 序列化时丢键，服务端就永远清不掉定时）', () => {
    assert.equal(schedule.normalizePublishAtForSave(null), null);
    assert.equal(schedule.normalizePublishAtForSave(undefined), null);
    assert.equal(schedule.normalizePublishAtForSave(''), null);
  });

  it('Date / naive 串 / ISO 串 → UTC ISO', () => {
    assert.equal(schedule.normalizePublishAtForSave(new Date(NOW)), new Date(NOW).toISOString());
    assert.equal(schedule.normalizePublishAtForSave(FUTURE_ISO), FUTURE_ISO);
    const naive = schedule.normalizePublishAtForSave('2026-09-20 09:00:00');
    assert.equal(naive, new Date(2026, 8, 20, 9, 0, 0).toISOString());
  });

  it('moment 形状：有效 → toISOString；invalid → null（不是 "Invalid date" 串！）', () => {
    const good = { toISOString: () => FUTURE_ISO, isValid: () => true };
    assert.equal(schedule.normalizePublishAtForSave(good), FUTURE_ISO);
    const invalid = { toISOString: () => 'Invalid date', isValid: () => false };
    assert.equal(schedule.normalizePublishAtForSave(invalid), null);
    const thrower = {
      isValid: () => true,
      toISOString: () => {
        throw new Error('boom');
      },
    };
    assert.equal(schedule.normalizePublishAtForSave(thrower), null);
  });

  it('坏串 → null，绝不把 NaN/Invalid 发给服务端', () => {
    assert.equal(schedule.normalizePublishAtForSave('garbage'), null);
    assert.equal(schedule.normalizePublishAtForSave(new Date('nope')), null);
  });
});

describe('schedule 文案与徽标', () => {
  it('定时中 → 「定时待发布 · <时间>」；否则 null', () => {
    const text = schedule.describeScheduledTag(FUTURE_ISO, NOW);
    assert.equal(text, `${schedule.SCHEDULED_TAG_TEXT} · ${formatDateTime(FUTURE_ISO)}`);
    assert.equal(schedule.SCHEDULED_TAG_TEXT, '定时待发布');
    assert.equal(schedule.describeScheduledTag(PAST_ISO, NOW), null);
    assert.equal(schedule.describeScheduledTag(null, NOW), null);
    assert.equal(schedule.describeScheduledTag('garbage', NOW), null);
  });

  it('帮助文案说清：到点前前台不可见 + 服务端一分钟内发布 + 清空即取消', () => {
    assert.match(schedule.PUBLISH_AT_TOOLTIP, /不可见/);
    assert.match(schedule.PUBLISH_AT_TOOLTIP, /一分钟内自动发布/);
    assert.match(schedule.PUBLISH_AT_TOOLTIP, /清空此字段 = 取消定时/);
    assert.match(schedule.PUBLISH_AT_PLACEHOLDER, /留空 = 不定时/);
    assert.match(schedule.PUBLISH_AT_HELP, /前台完全不可见/);
  });

  it('过去时间的警告文案点名所选时间并说明后果（会被直接发布）', () => {
    const text = schedule.pastScheduleWarningText(PAST_ISO, NOW);
    assert.match(text, /早于当前时间/);
    assert.match(text, /直接发布/);
    assert.ok(text.includes(formatDateTime(PAST_ISO)));
    assert.equal(schedule.PAST_SCHEDULE_WARNING_TITLE, '定时时间早于当前时间');
  });
});

describe('UpdateModal 接线（源码断言，已剔除注释）', () => {
  const comp = codeOnly(read('src/components/UpdateModal/index.tsx'));

  it('文章表单里有定时发布选择器：可清空、有帮助文案（antd4 的 ProFormDateTimePicker）', () => {
    assert.match(comp, /name="publishAt"/);
    // 🔴 期 5 第六批起标签走 t()：锚点换成**新形状**（key + zh-CN defaultMessage 一起钉），性质没放
    assert.match(comp, /label=\{t\('common\.scheduledPublish', '定时发布'\)\}/);
    assert.match(comp, /placeholder=\{PUBLISH_AT_PLACEHOLDER\}/);
    assert.match(comp, /tooltip=\{PUBLISH_AT_TOOLTIP\}/);
    assert.match(comp, /extra: PUBLISH_AT_HELP/);
    assert.match(comp, /allowClear: true/);
    // 只在 type == 'article' 分支里渲染（草稿没有定时发布）
    const articleBlock = comp.slice(comp.indexOf("{type == 'article' && ("));
    assert.ok(articleBlock.includes('name="publishAt"'));
  });

  it('回显：ISO 串先转 moment（antd4 DatePicker 只吃 moment），坏值给 null', () => {
    assert.match(comp, /publishAt: type == 'article' \? toMomentOrNull\(currObj\?\.publishAt\) : undefined/);
    assert.match(comp, /function toMomentOrNull/);
    assert.match(comp, /m\.isValid\(\) \? m : null/);
  });

  it('保存：publishAt 走 normalizePublishAtForSave（清空 → null），文章提交的是 submitValues', () => {
    assert.match(comp, /submitValues\.publishAt = normalizePublishAtForSave\(values\?\.publishAt\)/);
    assert.match(comp, /await updateArticle\(currObj\?\.id, submitValues\)/);
    // 草稿路径保持原样，不误加 publishAt
    assert.match(comp, /await updateDraft\(currObj\?\.id, values\)/);
  });

  it('过去的时间：先 Modal.confirm 警告，用户取消则不保存（返回 false 弹窗留着）', () => {
    assert.match(comp, /if \(values\?\.publishAt && isPastSchedule\(values\?\.publishAt\)\)/);
    assert.match(comp, /title: PAST_SCHEDULE_WARNING_TITLE/);
    assert.match(comp, /content: pastScheduleWarningText\(values\?\.publishAt\)/);
    // 🔴 期 5 第六批起两个按钮文案走 t()：锚点换成新形状（key + 中文默认值一起钉），性质没放
    assert.match(comp, /okText: t\('common\.okSaveAnyway', '仍要保存'\)/);
    assert.match(comp, /cancelText: t\('common\.cancelGoBack', '回去改时间'\)/);
    assert.match(comp, /if \(!proceed\) \{\s*return false;/);
  });
});

describe('文章列表接线：定时文章必须显眼、不能被误认为已发布', () => {
  const cols = codeOnly(read('src/pages/Article/columns.jsx'));

  it('有「定时发布」列：定时中给橙色 Tag（含时间），否则 "-"', () => {
    // 🔴 期 5 第八批起列标题走 t()：锚点换成新形状（key + zh-CN defaultMessage 一起钉），性质没放
    assert.match(cols, /title: t\('common\.scheduledPublish', '定时发布'\)/);
    assert.match(cols, /dataIndex: 'publishAt'/);
    assert.match(cols, /describeScheduledTag\(record\?\.publishAt\)/);
    assert.match(cols, /<Tag color="orange" data-article-scheduled-tag=/);
    // 列在桌面与小屏的 keys 里都开着
    assert.match(cols, /articleKeys = \[[^\]]*'publishAt'/);
    assert.match(cols, /articleKeysSmall = \[[^\]]*'publishAt'/);
  });

  it('tooltip 说明到点前前台不可见、以 publishAt 为准', () => {
    assert.match(cols, /对所有前台页面不可见/);
    assert.match(cols, /以 publishAt 是否晚于当前时间为准/);
  });

  it('「查看」链接对定时文章先弹确认（现在打开是 404），与隐藏文章同款护栏', () => {
    assert.match(cols, /else if \(isScheduled\(record\?\.publishAt\)\)/);
    assert.match(cols, /此文章处于「定时待发布」状态/);
    assert.match(cols, /现在打开会是 404 页面/);
  });
});

describe('编辑器接线：标题栏一眼看出定时状态', () => {
  const editor = codeOnly(read('src/pages/Editor/index.jsx'));

  it('头部有定时 Tag（describeScheduledTag 推导，非服务端字段）', () => {
    assert.match(editor, /describeScheduledTag\(currObj\?\.publishAt\)/);
    assert.match(editor, /data-editor-scheduled-tag/);
    assert.match(editor, /<Tag color="orange"/);
  });

  it('「查看前台」对定时文章先弹确认', () => {
    assert.match(editor, /if \(isScheduled\(currObj\?\.publishAt\)\)/);
    assert.match(editor, /此文章处于「定时待发布」状态/);
    assert.match(editor, /「操作 → 修改信息 → 定时发布」/);
  });
});
