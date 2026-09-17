import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 这一轮运行时审计落地的几处加固，用源码级断言钉住。
 * 都是"改回去也不会报错、只会在线上出事"的那种改动，所以必须有测试看着。
 */
// __dirname 就是 src/（jest 用 ts-jest 直接跑源码，没有 outDir 那一层）
const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/** 断言前剥掉注释：新写的注释里常常引用"以前是怎样的"，不剥会自己匹配自己 */
const code = (src: string) =>
  src
    // ⚠️ 顺序必须是"先行注释、后块注释"。反过来的话，任何注释里出现的 `/*` 字节对
    // （例如尾随注释 `// 只有 /static/img/<file>.{webp,…} 由 caddy 直服`）都会开启一个
    // **假块注释**，把后面几十上百行真实代码一起吃掉 —— 本仓库已因此误判三次：
    // 静态目录守卫只找到 1 个目录（实际 ≥6）、main.ts 的 primary 守卫钉子找不到那行、
    // 以及这里的 keepAliveTimeout / caddy clearLog 两条钉子。
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/(\s|^)\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

describe('恢复密钥写到配置里的日志目录', () => {
  it('不再写死 /var/log（裸机部署时那个目录不一定存在，密钥就一直写失败）', () => {
    const src = code(read('provider/init/init.provider.ts'));
    expect(src).toContain("path.join(logDir, 'restore.key')");
    expect(src).toContain('config.log');
    expect(src).not.toMatch(/path\.join\('\/var\/log\/',\s*'restore\.key'\)/);
    // 权限仍然是 0600（这个文件在挂载卷里，默认 0644 等于宿主机上人人可读）
    expect(src).toContain('0o600');
  });
});

describe('每 5 分钟刷字数的定时任务已经删掉', () => {
  it('文件不存在，也没有残留引用', () => {
    expect(existsSync(join(root, 'schedule/count.task.ts'))).toBe(false);
    // 它从来没在 app.module 注册过（死代码），而字数缓存本来就在启动与每次改动后刷新；
    // 真注册上去等于每 5 分钟把全部文章连正文捞一遍。
    const mod = code(read('app.module.ts'));
    expect(mod).not.toContain('CountTask');
  });
  it('其它两个定时任务还在', () => {
    const mod = read('app.module.ts');
    expect(mod).toContain('ViewerTask');
    expect(mod).toContain('ISRTask');
  });
});

describe('热查询有索引', () => {
  it('visits 有 {pathname, date:-1} 复合索引', () => {
    const src = code(read('scheme/visit.schema.ts'));
    // 「某路径最近一天」是每次文章浏览都会查的公开接口；只有单列索引时 planner 会选
    // date_1 倒着扫再过滤 pathname —— 实测 6 天没访问的路径要 examined=125，
    // 加索引后 examined=1。
    expect(src).toMatch(/VisitSchema\.index\(\{\s*pathname:\s*1,\s*date:\s*-1\s*\}\)/);
  });
  it('articles 的 viewer / visited / lastVisitedTime 都有索引', () => {
    const src = read('scheme/article.schema.ts');
    for (const field of ['viewer', 'visited']) {
      expect(src).toMatch(new RegExp(`@Prop\\(\\{ default: 0, index: true \\}\\)\\s*\\n\\s*${field}:`));
    }
    expect(src).toMatch(/@Prop\(\{ index: true \}\)\s*\n\s*lastVisitedTime:/);
  });
});

describe('Mongo 连接不再全用驱动默认值', () => {
  it('配了选择超时、连接超时、socket 超时与连接池', () => {
    const src = code(read('app.module.ts'));
    expect(src).toContain('serverSelectionTimeoutMS');
    expect(src).toContain('connectTimeoutMS');
    expect(src).toContain('socketTimeoutMS');
    expect(src).toContain('maxPoolSize');
    // socketTimeoutMS 默认 0 = 永不超时：网络黑洞时借出的连接一直卡着，
    // 连接池占满就是整站假死。默认给 120s，并且留了环境变量。
    expect(src).toContain('VANBLOG_MONGO_SOCKET_TIMEOUT_MS');
    expect(src).toContain('VANBLOG_MONGO_SERVER_SELECTION_TIMEOUT_MS');
    // autoIndex 必须留着：项目没有迁移工具，索引全靠启动时同步
    expect(src).toContain('autoIndex: true');
  });
  it('环境变量写错成非数字时会回落默认值，而不是把 NaN 传给驱动', () => {
    const src = code(read('app.module.ts'));
    expect(src).toMatch(/function num\(/);
    expect(src).toContain('Number.isFinite');
  });
});

describe('文章别名解码走安全函数', () => {
  it('article.provider 里没有裸的 decodeURIComponent', () => {
    const src = code(read('provider/article/article.provider.ts'));
    expect(src).not.toMatch(/[^e]decodeURIComponent\(/);
    expect(src).toContain('safeDecodeURIComponent');
  });
});

describe('上游 keep-alive 超时必须长于反代的空闲超时', () => {
  // Node 的 server.keepAliveTimeout 默认只有 **5 秒**，而 caddy 模板里上游连接的
  // 空闲超时是 60 秒 —— 反代把连接留在池里，Node 却在 5 秒后主动关掉，
  // 于是偶发 ECONNRESET / 502，且只在"流量有间歇"时出现，极难复现。
  it('main.ts 显式设置了 keepAliveTimeout / headersTimeout', () => {
    const src = code(read('main.ts'));
    expect(src).toContain('httpServer.keepAliveTimeout = keepAliveTimeout');
    expect(src).toContain('httpServer.headersTimeout = keepAliveTimeout + 1000');
    expect(src).toContain("envInt('VANBLOG_KEEP_ALIVE_TIMEOUT_MS', 65000");
  });

  it('默认值 65s 大于 caddy 模板里上游的 60s 空闲超时', () => {
    const main = read('main.ts');
    const m = /VANBLOG_KEEP_ALIVE_TIMEOUT_MS',\s*(\d+)/.exec(main);
    expect(m).not.toBeNull();
    const nodeMs = Number(m![1]);
    const caddy = JSON.parse(
      // root = packages/server/src，仓库根还要再上两级（这个 off-by-one 又踩了一次）
      readFileSync(join(root, '../../../caddyTemplate.json'), 'utf8'),
    ) as any;
    // 从模板里把上游 keep_alive.idle_timeout（纳秒）找出来
    let idleNs = 0;
    const walk = (routes: any[]) => {
      for (const r of routes) {
        for (const h of r.handle || []) {
          if (h.handler === 'reverse_proxy' && h.transport?.keep_alive?.idle_timeout) {
            idleNs = h.transport.keep_alive.idle_timeout;
          }
          if (h.handler === 'subroute') walk(h.routes || []);
        }
      }
    };
    for (const srv of Object.values(caddy.apps.http.servers) as any[]) walk(srv.routes);
    expect(idleNs).toBeGreaterThan(0);
    expect(nodeMs).toBeGreaterThan(idleNs / 1e6);
  });
});
