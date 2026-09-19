import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * `app.listen()` **必须显式传 backlog**。
 *
 * 为什么值得一条守卫：Node 的默认 backlog 只有 **511**，而 caddy 反代到 Node 是"一个并发请求
 * 一条上游连接"（模板的空闲池 `max_idle_conns_per_host` 只有 32），瞬时高并发下 accept 队列
 * 溢出、SYN 被内核丢弃，caddy 侧看到的是 `dial tcp 127.0.0.1:3000: i/o timeout` → **502**。
 *
 * 实测（2026-09-20，C10K：先建 10000 条连接保持、再同时发 `/api/public/meta`）：
 *   - 经 Node 的路径：**200=6437 / 502=3563**，容器 netns `TcpExtListenOverflows`=**3745**（吻合）
 *   - caddy **直服**的静态图片：10000/10000 全 200（1.3s）
 *   ⇒ 瓶颈不在 TCP accept 能力或 fd（容器内 `Max open files` 1048576），而在 Node 的队列深度。
 *
 * ⚠️ 断言的是**调用形状**而不是"某个符号出现"：本仓库已经踩过 8 次"断言匹配到解释性注释"，
 *    也踩过"调用被 `if (false)` 短路后子串仍然匹配"，所以所有断言都在剥注释后的源码上做。
 */
const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, '../main.ts'), 'utf-8'));

describe('Node 的 listen backlog', () => {
  it('把 backlog 作为第三个参数传给 listen（不是只传 port/host）', () => {
    // 真实形状：await listenWithBacklog(port, host, listenBacklog);
    expect(SRC).toMatch(/await\s+listenWithBacklog\(\s*port\s*,\s*host\s*,\s*listenBacklog\s*\)/);
  });

  it('backlog 来自可配置的环境变量，默认 4096，并被夹在合法范围内', () => {
    expect(SRC).toMatch(/envInt\(\s*'VANBLOG_LISTEN_BACKLOG'\s*,\s*4096\s*,\s*1\s*,\s*65535\s*\)/);
  });

  it('不再出现"只传 port 与 host"的旧调用形状', () => {
    // 旧形状正是缺陷本身：app.listen(port, host) / app.listen(port) ⇒ 用 Node 默认的 511。
    expect(SRC).not.toMatch(/app\.listen\(\s*port\s*,\s*host\s*\)/);
    expect(SRC).not.toMatch(/app\.listen\(\s*port\s*\)\s*;/);
  });

  it('负向对照：这些断言真的能抓到旧形状（否则守卫是装饰）', () => {
    const oldShape = '  const { port, host } = getListenTarget();\n  await app.listen(port, host);\n';
    expect(oldShape).toMatch(/app\.listen\(\s*port\s*,\s*host\s*\)/);
    expect(oldShape).not.toMatch(/listenWithBacklog\(/);
    // 空转反证：剥注释器确实剥掉了注释（否则上面的 not.toMatch 可能只是匹配到注释里的旧写法）
    expect(stripCommentsForAnchor('// await app.listen(port, host);\nconst a = 1;')).not.toContain(
      'app.listen',
    );
  });

  it('类型断言只用于绕开 Nest 的 .d.ts，不绕过 Nest 的 listen 语义', () => {
    // Nest 的实现是 listen(port, ...args) 透传到 httpAdapter.listen ⇒ 运行时支持 backlog；
    // 直接 getHttpServer().listen() 会丢掉 init/flushLogs/错误处理，所以不许那样写。
    expect(SRC).toMatch(/app\.listen as unknown as \(/);
    expect(SRC).not.toMatch(/getHttpServer\(\)\.listen\(/);
  });
});
