import { RobotsController } from './robots.controller';

function fakeRes() {
  const out: any = { status: 0, body: '', headers: {} as Record<string, string> };
  return {
    out,
    setHeader(k: string, v: string) {
      out.headers[k] = v;
    },
    status(code: number) {
      out.status = code;
      return this;
    },
    send(body: string) {
      out.body = body;
      return this;
    },
  } as any;
}

describe('robots.txt（动态生成）', () => {
  it('带绝对地址的 Sitemap 行（静态文件做不到，因为它不知道域名）', async () => {
    const controller = new RobotsController({
      getSiteInfo: async () => ({ baseUrl: 'https://blog.example.com/' }),
    } as any);
    const res = fakeRes();
    await controller.robots(res);
    expect(res.out.status).toBe(200);
    expect(res.out.headers['Content-Type']).toContain('text/plain');
    expect(res.out.body).toContain('Sitemap: https://blog.example.com/sitemap.xml');
    // 尾斜杠要收敛，不能出现 .com//sitemap.xml
    expect(res.out.body).not.toContain('com//sitemap');
  });

  it('挡住 API、后台、swagger 与导出/临时目录，但放开静态资源', async () => {
    const controller = new RobotsController({
      getSiteInfo: async () => ({ baseUrl: 'https://blog.example.com' }),
    } as any);
    const res = fakeRes();
    await controller.robots(res);
    for (const line of [
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /swagger',
      'Disallow: /static/export/',
      'Disallow: /static/tmp/',
      'Allow: /static/',
    ]) {
      expect(res.out.body).toContain(line);
    }
  });

  it('没配站点 URL 时不写错误的 Sitemap 行，而是留一条说明', async () => {
    const controller = new RobotsController({ getSiteInfo: async () => ({}) } as any);
    const res = fakeRes();
    await controller.robots(res);
    expect(res.out.body).not.toMatch(/^Sitemap: /m);
    expect(res.out.body).toContain('# Sitemap:');
  });

  it('读站点信息失败也要能返回（robots.txt 500 会让爬虫拿不到任何规则）', async () => {
    const controller = new RobotsController({
      getSiteInfo: async () => {
        throw new Error('db down');
      },
    } as any);
    const res = fakeRes();
    await controller.robots(res);
    expect(res.out.status).toBe(200);
    expect(res.out.body).toContain('User-agent: *');
  });

  it('带缓存头：robots.txt 会被爬虫高频请求', async () => {
    const controller = new RobotsController({
      getSiteInfo: async () => ({ baseUrl: 'https://blog.example.com' }),
    } as any);
    const res = fakeRes();
    await controller.robots(res);
    expect(res.out.headers['Cache-Control']).toContain('max-age=3600');
  });
});
