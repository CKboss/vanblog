import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ARTIFACT_SUFFIXES,
  DYNAMIC_ARTIFACT_DIRS,
  reconcileArtifacts,
  reapPathArtifacts,
  safeArtifactPath,
  urlPathToArtifactRel,
} from './artifactReaper';

/**
 * ISR 产物清道夫的纯 fs 单测（真文件系统，tmp 目录；不 mock fs —— mock 出来的
 * existsSync/unlink 语义与真盘总有出入，而这个模块的全部风险都在 fs 边界上）。
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-reaper-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const touch = (rel: string, content = 'x') => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

describe('urlPathToArtifactRel：只认四个动态前缀的两段路径', () => {
  it('动态路径 → 相对产物路径（含 CJK 与空格名）', () => {
    // 正向对照：这些必须都解析出来，防止一个永远返回 null 的实现假绿
    expect(urlPathToArtifactRel('/post/hello-world')).toBe('post/hello-world.html');
    expect(urlPathToArtifactRel('/post/5')).toBe('post/5.html');
    expect(urlPathToArtifactRel('/page/2')).toBe('page/2.html');
    expect(urlPathToArtifactRel('/category/博客')).toBe('category/博客.html');
    expect(urlPathToArtifactRel('/tag/my tag')).toBe('tag/my tag.html');
    expect(urlPathToArtifactRel('/post/x?utm=1#frag')).toBe('post/x.html');
    expect(urlPathToArtifactRel('/post/x/')).toBe('post/x.html'); // 尾斜杠归一
  });

  it('固定页 / 更深路径 / 前缀之外 / 非法输入 → null（这些路径永远不许被 reap）', () => {
    const bad: unknown[] = [
      '/',
      '/about',
      '/link',
      '/timeline',
      '/category', // 固定分类索引页（一段），不是 /category/<名>
      '/tag',
      '/post/a/b', // 三段：不是合法路由，也不该有产物
      '/api/public/meta',
      '/static/img/a.webp',
      '/c/custom',
      '/admin/x',
      '',
      'post/x', // 没有前导斜杠
      null,
      undefined,
      42,
      {},
    ];
    // 数组对数组：失败时 diff 直接指出是第几个向量（= bad 里的哪一项）出的问题
    expect(bad.map((b) => urlPathToArtifactRel(b as any))).toEqual(bad.map(() => null));
  });

  it('.. 段构造不出可删的相对路径', () => {
    // '/post/..' 两段 → name='..' → 'post/...html'（字面三个点，resolve 后仍在目录内）
    expect(urlPathToArtifactRel('/post/..')).toBe('post/...html');
    expect(safeArtifactPath(root, 'post/...html')).toBe(path.resolve(root, 'post/...html'));
    // 三段以上直接被上一条挡掉
    expect(urlPathToArtifactRel('/post/../../etc/passwd')).toBeNull();
  });
});

describe('safeArtifactPath：resolve + 前缀检查', () => {
  it('目录内的相对路径放行（正向对照）', () => {
    expect(safeArtifactPath(root, 'post/a.html')).toBe(path.join(path.resolve(root), 'post/a.html'));
  });

  it('越界一律 null：..、绝对路径、空值', () => {
    expect(safeArtifactPath(root, '../secret.html')).toBeNull();
    expect(safeArtifactPath(root, 'post/../../secret.html')).toBeNull();
    expect(safeArtifactPath(root, '/etc/passwd')).toBeNull();
    expect(safeArtifactPath(root, '')).toBeNull();
    expect(safeArtifactPath(root, null as any)).toBeNull();
  });
});

describe('reapPathArtifacts：按 URL 删三件套', () => {
  it('html/json/meta 一起删，返回删除清单；再跑一次幂等', () => {
    touch('post/gone.html');
    touch('post/gone.json');
    touch('post/gone.meta');
    const removed = reapPathArtifacts(root, '/post/gone');
    expect(removed).toHaveLength(3);
    expect(exists('post/gone.html')).toBe(false);
    expect(exists('post/gone.json')).toBe(false);
    expect(exists('post/gone.meta')).toBe(false);
    expect(reapPathArtifacts(root, '/post/gone')).toEqual([]); // 幂等
  });

  it('固定页与非法路径：什么都不删（连碰都不碰）', () => {
    touch('about.html');
    touch('index.html');
    expect(reapPathArtifacts(root, '/about')).toEqual([]);
    expect(reapPathArtifacts(root, '/')).toEqual([]);
    expect(reapPathArtifacts(root, '/post/a/b')).toEqual([]);
    expect(exists('about.html')).toBe(true);
    expect(exists('index.html')).toBe(true);
  });

  it('只有部分兄弟文件存在时删存在的、不报错', () => {
    touch('post/half.html');
    const removed = reapPathArtifacts(root, '/post/half');
    expect(removed).toHaveLength(1);
    expect(exists('post/half.html')).toBe(false);
  });
});

describe('reconcileArtifacts：只删「不在可公开集合里」的动态产物', () => {
  const buildTree = () => {
    // 动态产物（qualified 之外的是待删目标）
    touch('post/keep.html');
    touch('post/keep.json');
    touch('post/keep.meta');
    touch('post/gone.html');
    touch('post/gone.json');
    touch('post/gone.meta');
    touch('post/orphan.json'); // 孤儿 json（没有同名 html）：不扫、不删
    touch('post/[id].js'); // 路由 bundle：不是产物，永远不碰
    touch('page/1.html');
    touch('page/1.json');
    touch('page/99.html');
    touch('page/99.json');
    touch('page/99.meta');
    touch('category/博客.html');
    touch('category/博客.json');
    touch('category/old-cat.html');
    touch('category/old-cat.json');
    touch('category/old-cat.meta');
    touch('tag/a b.html');
    touch('tag/a b.json');
    touch('tag/gone-tag.html');
    // 固定页（根级）：任何情况下都不许被碰
    touch('index.html');
    touch('index.json');
    touch('about.html');
    touch('404.html');
    touch('500.html');
  };
  const QUALIFIED = new Set([
    '/post/keep',
    '/page/1',
    '/category/博客', // 解码后的 CJK
    '/tag/a b', // 带空格的名字
  ]);

  it('删掉过期的、留下合格的、固定页与 bundle 分毫不动（CJK/空格名按解码路径匹配）', () => {
    buildTree();
    const r = reconcileArtifacts(root, QUALIFIED);
    // 过期三件套：post/gone(3) + page/99(3) + category/old-cat(3) + tag/gone-tag(1) = 10
    expect(r.deleted.sort()).toEqual(
      [
        'post/gone.html',
        'post/gone.json',
        'post/gone.meta',
        'page/99.html',
        'page/99.json',
        'page/99.meta',
        'category/old-cat.html',
        'category/old-cat.json',
        'category/old-cat.meta',
        'tag/gone-tag.html',
      ].sort(),
    );
    expect(r.errors).toEqual([]);
    expect(r.scanned).toBe(8); // 8 个 .html：post2 + page2 + category2 + tag2
    // 合格的还在（失败时 diff 直接列出丢了的文件名）
    const keepFiles = ['post/keep.html', 'post/keep.json', 'post/keep.meta', 'page/1.html', 'category/博客.html', 'tag/a b.html'];
    expect(keepFiles.filter((f) => !exists(f))).toEqual([]);
    // 不该碰的分毫不动
    const untouchables = ['post/orphan.json', 'post/[id].js', 'index.html', 'index.json', 'about.html', '404.html', '500.html'];
    expect(untouchables.filter((f) => !exists(f))).toEqual([]);
  });

  it('幂等：第二轮 0 删除、0 错误', () => {
    buildTree();
    reconcileArtifacts(root, QUALIFIED);
    const second = reconcileArtifacts(root, QUALIFIED);
    expect(second.deleted).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.scanned).toBe(4); // 只剩合格产物的 html
  });

  it('pages 目录不存在 = no-op（dev 机 / 分离部署）', () => {
    const r = reconcileArtifacts(path.join(root, 'no-such-dir'), QUALIFIED);
    expect(r).toEqual({ deleted: [], errors: [], scanned: 0 });
  });

  it('某个前缀目录不存在 = 跳过且不算错误（新站点还没有任何产物）', () => {
    touch('post/a.html');
    const r = reconcileArtifacts(root, new Set(['/post/a']));
    expect(r.errors).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it('目录在却读不了 → errors 里有记录（静默失败的清道夫 = 已删文章继续公开）', () => {
    buildTree();
    fs.chmodSync(path.join(root, 'post'), 0o000);
    try {
      const r = reconcileArtifacts(root, QUALIFIED);
      expect(r.errors.some((e) => e.includes('读取 post/ 失败'))).toBe(true);
      // 其它目录照常工作
      expect(r.deleted).toContain('page/99.html');
    } finally {
      fs.chmodSync(path.join(root, 'post'), 0o755);
    }
  });

  it('空集合会删光全部动态产物但仍不碰固定页 —— 所以「集合形状异常就不删」的闸门必须留在调用方（isr.provider 有对应测试）', () => {
    buildTree();
    const r = reconcileArtifacts(root, new Set());
    expect(r.deleted.length).toBeGreaterThan(0);
    expect(exists('index.html')).toBe(true);
    expect(exists('about.html')).toBe(true);
    expect(exists('post/[id].js')).toBe(true);
  });

  it('常量钉子：动态前缀与三件套后缀就是这四个/这三个（改它们等于改 caddy 路由的允许集）', () => {
    expect([...DYNAMIC_ARTIFACT_DIRS]).toEqual(['post', 'page', 'category', 'tag']);
    expect([...ARTIFACT_SUFFIXES]).toEqual(['.html', '.json', '.meta']);
  });
});
