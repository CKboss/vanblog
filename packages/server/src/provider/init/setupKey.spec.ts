import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BadRequestException, HttpException } from '@nestjs/common';
import {
  SETUP_KEY_FILE_NAME,
  SETUP_KEY_REMIND_DEFAULT_MINUTES,
  SETUP_KEY_REMIND_ENV,
  SETUP_KEY_REQUIRE_ENV,
  buildSetupKeyBlock,
  clearSetupKey,
  currentSetupKey,
  enforceSetupKey,
  generateSetupKey,
  readSetupKey,
  resolveSetupKeyRemindMinutes,
  resolveSetupKeyRequirement,
  setupKeyFailureMessage,
  setupKeyFilePath,
  setupKeyRequired,
  verifySetupKey,
} from './setupKey';
import { makeSalt, safeEqual } from 'src/utils/crypto';

/**
 * setup key（初始化密钥）：`VANBLOG_INIT_REQUIRE_SETUP_KEY=true` 时，
 * 匿名的 POST /api/admin/init 与 /init/restore 必须携带的密钥。
 *
 * 这里钉住的是模块级契约：
 *  - 开关解析（默认关；垃圾值 → 关 + recognized:false，绝不静默）；
 *  - 生成（makeSalt 形状、0600、写进 <log>/setup.key、镜像 restore.key 的容错）；
 *  - 校验（常量时间、trim、内存优先/文件回落 —— cluster worker 靠文件）；
 *  - 清理（初始化成功后删文件清内存 —— 挂载日志卷里不留"看着像活密钥"的文件）；
 *  - 400 文案（必须指路：启动日志那一行 + 文件路径；绝不回显密钥）。
 *
 * ⚠️ 所有用例都传**临时目录**当 logDir，绝不碰 config.log 指到的真实日志目录。
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-setupkey-'));
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  delete process.env[SETUP_KEY_REMIND_ENV];
  // 清掉模块内存里可能残留的密钥（上一个用例生成的）
  clearSetupKey(tmp);
});

afterEach(() => {
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  delete process.env[SETUP_KEY_REMIND_ENV];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('VANBLOG_INIT_REQUIRE_SETUP_KEY 的解析：默认必须是"开"（站长拍板的翻转）', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'on'])('"%s" → 开', (raw) => {
    expect(resolveSetupKeyRequirement(raw)).toEqual({ enabled: true, recognized: true });
    expect(setupKeyRequired(raw)).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'FALSE', 'Off'])(
    '"%s" → 显式关（逃生口，recognized）',
    (raw) => {
      expect(resolveSetupKeyRequirement(raw)).toEqual({ enabled: false, recognized: true });
      expect(setupKeyRequired(raw)).toBe(false);
    },
  );

  it('未设置/空串 → **开**（新默认：首次安装必须用密钥）', () => {
    expect(setupKeyRequired(undefined)).toBe(true);
    expect(resolveSetupKeyRequirement(undefined)).toEqual({ enabled: true, recognized: true });
    expect(setupKeyRequired('')).toBe(true);
    expect(setupKeyRequired('   ')).toBe(true);
  });

  it('垃圾值（打错的 flase）→ **开** + recognized:false（打错的值绝不静默关掉保护，调用方 WARN 点名）', () => {
    expect(resolveSetupKeyRequirement('flase')).toEqual({ enabled: true, recognized: false });
    expect(resolveSetupKeyRequirement('ture')).toEqual({ enabled: true, recognized: false });
    expect(resolveSetupKeyRequirement('maybe')).toEqual({ enabled: true, recognized: false });
    expect(setupKeyRequired('flase')).toBe(true);
  });

  it('值前后的空白不影响解析', () => {
    expect(setupKeyRequired('  true  ')).toBe(true);
    expect(setupKeyRequired('  false  ')).toBe(false);
  });
});

describe('VANBLOG_SETUP_KEY_REMIND_MINUTES：打错的字绝不能把提醒静音掉', () => {
  it('未设置/空 → 默认 10 分钟', () => {
    expect(resolveSetupKeyRemindMinutes(undefined)).toBe(SETUP_KEY_REMIND_DEFAULT_MINUTES);
    expect(resolveSetupKeyRemindMinutes('')).toBe(10);
    expect(SETUP_KEY_REMIND_DEFAULT_MINUTES).toBe(10);
  });

  it('显式 0 → 0（只在启动时印一次 —— 唯一能得到 0 的输入）', () => {
    expect(resolveSetupKeyRemindMinutes('0')).toBe(0);
    expect(resolveSetupKeyRemindMinutes(' 0 ')).toBe(0);
    expect(resolveSetupKeyRemindMinutes('0.0')).toBe(0);
  });

  it('垃圾/负数 → 默认 10（绝不回落成 0）', () => {
    expect(resolveSetupKeyRemindMinutes('abc')).toBe(10);
    expect(resolveSetupKeyRemindMinutes('-5')).toBe(10);
    expect(resolveSetupKeyRemindMinutes('NaN')).toBe(10);
  });

  it('(0,1) 的小数 → 1 分钟（floor 之后也不许变成 0）', () => {
    expect(resolveSetupKeyRemindMinutes('0.2')).toBe(1);
    expect(resolveSetupKeyRemindMinutes('0.9')).toBe(1);
  });

  it('正常值向下取整', () => {
    expect(resolveSetupKeyRemindMinutes('5')).toBe(5);
    expect(resolveSetupKeyRemindMinutes('2.7')).toBe(2);
  });
});

describe('buildSetupKeyBlock：未初始化期间反复打印的视觉块（站长验收的就是这段文案）', () => {
  const base = {
    key: 'FIXTURE-KEY-VALUE=',
    filePath: '/var/log/setup.key',
    required: true,
    recognized: true,
    rawFlag: '',
  };

  it('必含六要素：未初始化事实、密钥、文件路径、docker logs 配方、重启重新生成、逃生口', () => {
    const block = buildSetupKeyBlock(base);
    expect(block).toContain('尚未完成初始化');
    expect(block).toContain(base.key);
    expect(block).toContain('/var/log/setup.key');
    expect(block).toContain('docker logs <容器名> 2>&1 | grep 初始化密钥');
    expect(block).toContain('每次重启 vanblog 都会重新生成');
    expect(block).toContain('VANBLOG_INIT_REQUIRE_SETUP_KEY=false');
    expect(block).toContain('setupKey'); // 接口字段名
    expect(block).toContain(SETUP_KEY_REMIND_ENV); // 重印间隔也可调
  });

  it('显式关闭时块里写明"不要求密钥"（逃生口状态如实呈现）', () => {
    const block = buildSetupKeyBlock({ ...base, required: false });
    expect(block).toContain('不要求');
    expect(block).toContain('VANBLOG_INIT_REQUIRE_SETUP_KEY=false');
  });

  it('无法识别的值：块里点名原值并说明按【要求密钥】处理', () => {
    const block = buildSetupKeyBlock({ ...base, recognized: false, rawFlag: 'flase' });
    expect(block).toContain('无法识别');
    expect(block).toContain('flase');
    expect(block).toContain('要求密钥');
  });

  it('块是纯函数：同输入逐字节相同（provider 缓存它，重印零拼接）', () => {
    expect(buildSetupKeyBlock(base)).toBe(buildSetupKeyBlock(base));
  });
});

describe('enforceSetupKey：控制器闸门的 wire 契约（400/500 的 body 形状）', () => {
  it('flag 显式关 → 直接放行（一个布尔判断，不读文件不比较）', () => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
    try {
      expect(() => enforceSetupKey(undefined, tmp)).not.toThrow();
    } finally {
      delete process.env[SETUP_KEY_REQUIRE_ENV];
    }
  });

  it('默认（env 未设置）+ 没带密钥 → BadRequest，body 带 setupKeyRequired/reason 且指路', () => {
    const { key } = generateSetupKey(tmp);
    delete process.env[SETUP_KEY_REQUIRE_ENV]; // 默认 = 开
    let err: any;
    try {
      enforceSetupKey(undefined, tmp);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    const body = err.getResponse();
    expect(body.statusCode).toBe(400);
    expect(body.setupKeyRequired).toBe(true);
    expect(body.reason).toBe('setupKeyMissing');
    expect(body.message).toContain('docker logs');
    expect(body.message).not.toContain(key);
  });

  it('带错 → reason:setupKeyWrong；带对（含尾部换行）→ 放行', () => {
    const { key } = generateSetupKey(tmp);
    let err: any;
    try {
      enforceSetupKey('wrong-key-value', tmp);
    } catch (e) {
      err = e;
    }
    expect(err.getResponse().reason).toBe('setupKeyWrong');
    expect(() => enforceSetupKey(`${key}\n`, tmp)).not.toThrow();
  });

  it('服务端没有密钥 → 500 setupKeyUnavailable（填了也没用，不骗人）', () => {
    clearSetupKey(tmp);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-setupkey-nokey-'));
    let err: any;
    try {
      enforceSetupKey('anything', empty);
    } catch (e) {
      err = e;
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse().setupKeyUnavailable).toBe(true);
  });
});

describe('generateSetupKey：镜像 restore.key 的生成方式', () => {
  it('生成 makeSalt 形状的密钥（32 随机字节的 base64），写进 <log>/setup.key，mode 0600', () => {
    const { key, filePath, written } = generateSetupKey(tmp);
    expect(written).toBe(true);
    expect(filePath).toBe(path.join(tmp, SETUP_KEY_FILE_NAME));
    // makeSalt() = randomBytes(32).toString('base64') → 44 字符、以 = 结尾
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(key);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600); // 日志目录是挂载卷：0644 等于宿主机人人可读
    expect(currentSetupKey()).toBe(key);
  });

  it('每次生成都换一把新密钥（镜像 restore.key 的"每次重启重新生成"）', () => {
    const a = generateSetupKey(tmp);
    const b = generateSetupKey(tmp);
    expect(a.key).not.toBe(b.key);
    expect(fs.readFileSync(a.filePath, 'utf-8')).toBe(b.key);
  });

  it('日志目录不可写 → written:false，但内存里仍有密钥（本进程还能校验；启动路径会 ERROR 点名）', () => {
    const bad = path.join(tmp, 'does-not-exist', 'deep');
    const { key, written } = generateSetupKey(bad);
    expect(written).toBe(false);
    expect(currentSetupKey()).toBe(key);
  });
});

describe('verifySetupKey：常量时间、trim、内存优先/文件回落', () => {
  it('正确密钥 → ok（提交值带首尾空白/换行也对 —— 从文件或日志里复制最容易带上）', () => {
    const { key } = generateSetupKey(tmp);
    expect(verifySetupKey(key, tmp)).toEqual({ ok: true, filePath: setupKeyFilePath(tmp) });
    expect(verifySetupKey(`  ${key}\n`, tmp).ok).toBe(true);
  });

  it('错误密钥 → reason:wrong；没带 → reason:missing；两者都不回显密钥', () => {
    const { key } = generateSetupKey(tmp);
    const wrong = verifySetupKey(makeSalt(), tmp);
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe('wrong');
    expect(JSON.stringify(wrong)).not.toContain(key);
    const missing = verifySetupKey(undefined, tmp);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('missing');
    expect(verifySetupKey('   ', tmp).reason).toBe('missing');
  });

  it('等长但不同的密钥也是 wrong（safeEqual 是常量时间比较，不是前缀比较）', () => {
    const { key } = generateSetupKey(tmp);
    const flipped = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
    expect(flipped.length).toBe(key.length);
    expect(verifySetupKey(flipped, tmp).reason).toBe('wrong');
  });

  it('服务端既没有内存密钥也没有文件 → reason:unavailable（配置坏了，不是用户的错）', () => {
    clearSetupKey(tmp);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-setupkey-empty-'));
    try {
      const verdict = verifySetupKey('anything', empty);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('unavailable');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('cluster worker 路径：本进程内存没有密钥时回落读文件（主实例生成、worker 校验）', () => {
    const { key } = generateSetupKey(tmp);
    // 换一个"刚启动、没生成过密钥"的模块实例：内存为空，只能靠文件
    let fresh: typeof import('./setupKey') | undefined;
    jest.isolateModules(() => {
      fresh = require('./setupKey');
    });
    expect(fresh!.currentSetupKey()).toBe(null);
    expect(fresh!.readSetupKey(tmp)).toBe(key);
    expect(fresh!.verifySetupKey(key, tmp).ok).toBe(true);
    expect(fresh!.verifySetupKey('nope', tmp).reason).toBe('wrong');
  });

  it('文件尾部被编辑器加了换行也能对上（读文件时 trim）', () => {
    clearSetupKey(tmp);
    const key = makeSalt();
    fs.writeFileSync(path.join(tmp, SETUP_KEY_FILE_NAME), `${key}\n`);
    let fresh: typeof import('./setupKey') | undefined;
    jest.isolateModules(() => {
      fresh = require('./setupKey');
    });
    expect(fresh!.verifySetupKey(key, tmp).ok).toBe(true);
  });

  it('源码级钉子：比较必须走 utils/crypto 的 safeEqual（常量时间），文件必须是 0600', () => {
    const src = fs.readFileSync(path.join(__dirname, 'setupKey.ts'), 'utf-8');
    expect(src).toContain("import { makeSalt, safeEqual } from 'src/utils/crypto'");
    expect(src).toContain('safeEqual(given, expected)');
    expect(src).not.toMatch(/given === expected/);
    expect(src).toContain('mode: 0o600');
    expect(src).toContain('fs.chmodSync(filePath, 0o600)');
  });
});

describe('clearSetupKey：初始化成功后密钥文件必须消失', () => {
  it('删文件 + 清内存；文件不存在也不抛（force）', () => {
    generateSetupKey(tmp);
    expect(clearSetupKey(tmp).removed).toBe(true);
    expect(fs.existsSync(setupKeyFilePath(tmp))).toBe(false);
    expect(currentSetupKey()).toBe(null);
    expect(() => clearSetupKey(tmp)).not.toThrow();
  });
});

describe('400 文案：站长把自己锁在全新安装外面时，消息是唯一的帮助', () => {
  it('missing：说明开关、字段名、密钥在哪（启动日志 + 文件路径），并说明每次重启重新生成', () => {
    const msg = setupKeyFailureMessage('missing', '/var/log/setup.key');
    expect(msg).toContain('VANBLOG_INIT_REQUIRE_SETUP_KEY');
    expect(msg).toContain('默认开启');
    expect(msg).toContain('setupKey'); // 字段名（前端/运维都要知道）
    expect(msg).toContain('/var/log/setup.key'); // 文件路径
    expect(msg).toContain('docker logs'); // 去哪看启动日志
    expect(msg).toContain('初始化密钥'); // 日志里 grep 的关键词
    expect(msg).toContain('重新生成');
  });

  it('wrong：同样指路，且提醒"重启后旧密钥失效"', () => {
    const msg = setupKeyFailureMessage('wrong', '/data/logs/setup.key');
    expect(msg).toContain('不正确');
    expect(msg).toContain('/data/logs/setup.key');
    expect(msg).toContain('docker logs');
  });

  it('两种文案都绝不包含任何密钥值（消息是匿名可见的）', () => {
    const { key } = generateSetupKey(tmp);
    expect(setupKeyFailureMessage('missing', setupKeyFilePath(tmp))).not.toContain(key);
    expect(setupKeyFailureMessage('wrong', setupKeyFilePath(tmp))).not.toContain(key);
  });
});

describe('readSetupKey / setupKeyFilePath 的默认目录', () => {
  it('默认路径 = config.log（与 restore.key 同目录），config.log 为空时回落 /var/log', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('src/config');
    const expectedBase = config.log || '/var/log';
    expect(setupKeyFilePath()).toBe(path.join(expectedBase, 'setup.key'));
  });
});
