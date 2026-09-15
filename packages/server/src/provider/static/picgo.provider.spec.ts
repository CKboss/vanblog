import * as fs from 'fs';
import { PicgoProvider } from './picgo.provider';
import {
  isPicgoPluginsAllowed,
  normalizePluginList,
  picgoPluginsBlockedReason,
  PICGO_PLUGIN_ENV,
} from 'src/utils/picgoPlugins';

/**
 * picgo 插件安装的开关。
 *
 * 背景：picgo 1.5.6 依赖的 `git-clone@0.1.0`（命令注入）与 `decompress`（解压路径穿越）
 * 都**没有修复版本**，而插件名来自后台「图床设置」——拿到一个后台会话就等于容器内 root。
 * 这里钉住：**默认不装**、开关显式打开才装、并且**上传路径完全不受影响**。
 */

/** 去掉注释再断言：仓库里踩过十次"断言匹配到了记录这个坑的注释" */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function createProvider(settingValue: any, picgoStub?: any) {
  const model: any = {
    findOne: jest.fn(() => ({
      exec: async () => (settingValue === undefined ? null : { value: settingValue }),
    })),
  };
  const provider = Object.create(PicgoProvider.prototype) as PicgoProvider;
  const logs: Array<{ level: string; msg: string }> = [];
  // 绕过构造函数（它会 new PicGo() 并读库），所以实例字段要自己补上
  (provider as any).logger = {
    log: (m: string) => logs.push({ level: 'log', msg: String(m) }),
    warn: (m: string) => logs.push({ level: 'warn', msg: String(m) }),
    error: (m: string) => logs.push({ level: 'error', msg: String(m) }),
  };
  const installed: string[][] = [];
  provider.picgo =
    picgoStub ||
    ({
      setConfig: jest.fn(),
      pluginHandler: {
        install: jest.fn(async (plugins: string[]) => {
          installed.push(plugins);
          return { success: true, body: 'ok' };
        }),
      },
      upload: jest.fn(async () => [{ imgUrl: 'https://cdn.example.com/a.webp' }]),
    } as any);
  (provider as any).settingModel = model;
  return { provider, installed, model, logs };
}

const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
  const saved = process.env[PICGO_PLUGIN_ENV];
  if (value === undefined) delete process.env[PICGO_PLUGIN_ENV];
  else process.env[PICGO_PLUGIN_ENV] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[PICGO_PLUGIN_ENV];
    else process.env[PICGO_PLUGIN_ENV] = saved;
  }
};

describe('picgo 插件开关', () => {
  it('默认（不设环境变量）是关的', () => {
    expect(isPicgoPluginsAllowed({})).toBe(false);
    expect(isPicgoPluginsAllowed({ [PICGO_PLUGIN_ENV]: undefined } as any)).toBe(false);
  });

  it('只有显式 true / 1 才算打开，拼错或空串一律按关处理', () => {
    expect(isPicgoPluginsAllowed({ [PICGO_PLUGIN_ENV]: 'true' } as any)).toBe(true);
    expect(isPicgoPluginsAllowed({ [PICGO_PLUGIN_ENV]: 'TRUE' } as any)).toBe(true);
    expect(isPicgoPluginsAllowed({ [PICGO_PLUGIN_ENV]: ' 1 ' } as any)).toBe(true);
    for (const bad of ['', 'false', '0', 'yes', 'on', 'tru', 'enabled']) {
      expect(isPicgoPluginsAllowed({ [PICGO_PLUGIN_ENV]: bad } as any)).toBe(false);
    }
  });

  it('normalizePluginList 去掉空白项（后台那串是逗号分隔的）', () => {
    expect(normalizePluginList('picgo-plugin-a, picgo-plugin-b ,, '.split(','))).toEqual([
      'picgo-plugin-a',
      'picgo-plugin-b',
    ]);
    expect(normalizePluginList([])).toEqual([]);
    expect(normalizePluginList(undefined)).toEqual([]);
  });
});

describe('PicgoProvider.installPlugins', () => {
  it('开关关着时不调用 picgo 的 pluginHandler.install，并给出可读的原因', async () => {
    await withEnv(undefined, async () => {
      const { provider, installed, logs } = createProvider({
        storageType: 'aliyun',
        picgoConfig: { aliyun: { accessKeyId: 'x' } },
        picgoPlugins: 'picgo-plugin-evil',
      });
      const res = await provider.installPlugins(['picgo-plugin-evil']);
      expect(res.allowed).toBe(false);
      expect(logs).toEqual([]); // installPlugins 自己不写日志，由 initDriver 决定怎么记
      expect(res.requested).toEqual(['picgo-plugin-evil']);
      expect(res.reason).toContain(PICGO_PLUGIN_ENV);
      expect(res.reason).toContain('git-clone');
      expect(installed).toEqual([]);
    });
  });

  it('空列表不算"被拦下"（没有要装的东西）', async () => {
    await withEnv(undefined, async () => {
      const { provider, installed } = createProvider(null);
      const res = await provider.installPlugins(['', '  ']);
      expect(res).toEqual({ allowed: true, requested: [] });
      expect(installed).toEqual([]);
    });
  });

  it('开关打开时才会真的去装', async () => {
    await withEnv('true', async () => {
      const { provider, installed, logs } = createProvider(null);
      const res = await provider.installPlugins(['picgo-plugin-web']);
      expect(res.allowed).toBe(true);
      // install() 是被同步调用的，但结果回调在微任务里，等一拍再看日志
      await new Promise((r) => setTimeout(r, 10));
      expect(installed).toEqual([['picgo-plugin-web']]);
      expect(logs.some((l) => l.msg.includes('picgo 安装插件成功'))).toBe(true);
    });
  });

  it('装插件抛异常也不会冒到调用方（保存图床设置不能因为插件失败而 500）', async () => {
    await withEnv('true', async () => {
      const { provider } = createProvider(null, {
        setConfig: jest.fn(),
        pluginHandler: { install: jest.fn(async () => { throw new Error('npm boom'); }) },
      } as any);
      await expect(provider.installPlugins(['picgo-plugin-x'])).resolves.toMatchObject({
        allowed: true,
      });
    });
  });
});

describe('initDriver：上传路径不受插件开关影响', () => {
  it('开关关着时仍然把 uploader 配置交给 picgo，只是不装插件', async () => {
    await withEnv(undefined, async () => {
      const { provider, installed, logs } = createProvider({
        storageType: 'aliyun',
        picgoConfig: { aliyun: { accessKeyId: 'x', bucket: 'b' } },
        picgoPlugins: 'picgo-plugin-evil',
      });
      await provider.initDriver();
      expect((provider.picgo.setConfig as jest.Mock)).toHaveBeenCalledWith({
        aliyun: { accessKeyId: 'x', bucket: 'b' },
      });
      expect(installed).toEqual([]);
      // 被拦下来这件事必须在日志里看得见，不能静默
      expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1);
      expect(logs[0].msg).toContain('已跳过 picgo 插件安装');
    });
  });

  it('没有任何设置时安静返回', async () => {
    await withEnv(undefined, async () => {
      const { provider } = createProvider(undefined);
      await expect(provider.initDriver()).resolves.toBeUndefined();
    });
  });

  it('saveFile 走的还是 picgo.upload（插件开关完全不参与）', async () => {
    await withEnv(undefined, async () => {
      const { provider } = createProvider({ picgoPlugins: 'picgo-plugin-evil' });
      const src = stripComments(
        fs.readFileSync(require.resolve('./picgo.provider.ts'), 'utf8'),
      );
      // 上传路径没有任何插件开关分支
      expect(src).toContain('await this.picgo.upload([srcPath])');
      const uploadIdx = src.indexOf('async saveFile(');
      const gateIdx = src.indexOf('isPicgoPluginsAllowed()', uploadIdx);
      expect(gateIdx).toBe(-1);
      expect(typeof provider.saveFile).toBe('function');
    });
  });

  it('源码里插件安装确实被开关挡住（去掉注释后再断言）', () => {
    const src = stripComments(fs.readFileSync(require.resolve('./picgo.provider.ts'), 'utf8'));
    const gateIdx = src.indexOf('if (!isPicgoPluginsAllowed())');
    const installIdx = src.indexOf('this.picgo.pluginHandler.install(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(installIdx);
  });

  it('拦下来时的解释里说清了怎么打开', () => {
    const reason = picgoPluginsBlockedReason(['picgo-plugin-x']);
    expect(reason).toContain('VANBLOG_ALLOW_PICGO_PLUGINS=true');
    expect(reason).toContain('picgo-plugin-x');
  });
});
