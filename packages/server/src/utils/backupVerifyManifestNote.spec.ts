import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyFullBackup } from './backupVerify';

/**
 * 清单读不出来时，校验结论**不许声称"清单可解析"**。
 *
 * 以前 `manifest` 为 null（解不出 / JSON 解析失败 / 不是本功能认的清单）时，走的仍然是
 * "没有 integrity 块"那条文案，而那条文案明写着"只校验了解压读通、**清单可解析**、计数一致"。
 * 于是在灾难恢复路径上，站长拿一份可疑归档来验，得到的是一句**假的"这项没问题"** ——
 * 这比抛 TypeError 危险得多：他会拿着这份其实无法核验的归档去覆盖现有数据。
 *
 * ⚠️ 顺带钉住 `manifest?.totals?.archiveSha256` 那处防御性判空：487 行以前是裸
 * `manifest.totals`，虽然当轮逻辑上到不了 null（上面 `const block = manifest?.integrity`
 * 为假时已 return），但 `manifest` 是外层 `let`、本函数是闭包，TS 无法跨闭包收窄 ⇒
 * 既报 TS18047，也让下一个人无从判断那是"已证明非空"还是"漏了判空"。
 */
jest.setTimeout(120000);

function buildArchiveWithBrokenManifest(dir: string, manifestText: string, name = 'vanblog-full-20260920-000000.tar.gz') {
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(path.join(staging, 'db', 'vanBlog'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.ndjson'), '{"id":1}\n');
  fs.writeFileSync(path.join(staging, 'manifest.json'), manifestText);
  const archivePath = path.join(dir, name);
  execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | gzip -9 -c > '${archivePath}'`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return archivePath;
}

describe('verifyFullBackup：清单不可读时的结论', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-verify-note-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['JSON 语法坏掉', '{ "kind": "vanblog-full-backup", '],
    ['根本不是本功能的清单', JSON.stringify({ hello: 'world' })],
  ])('%s ⇒ 不抛异常，且 note 说清"清单读不出来"', async (_label, manifestText) => {
    const archivePath = buildArchiveWithBrokenManifest(dir, manifestText);
    const result = await verifyFullBackup(archivePath);
    const notes = result.integrity.notes.join(' ');
    expect(notes).toContain('manifest.json **读不出来**');
    // 🔴 核心断言：不许再声称"清单可解析"
    expect(notes).not.toContain('清单可解析');
    // 也不许把原因误报成"老归档"
    expect(notes).not.toContain('早于防损坏改动写出');
    // 真原因必须在 issues 里（note 要指过去）
    expect(result.issues.some((i) => i.check === 'manifestFromArchive')).toBe(true);
    // 给出可照做的下一步
    expect(notes).toMatch(/不要拿这份归档去覆盖现有数据/);
  });

  it('清单可读但没有 integrity 块（老归档）⇒ 仍然用原来那条文案，且仍然说"清单可解析"', async () => {
    // ⚠️ 这条是**负向对照**：证明上面的 `not.toContain('清单可解析')` 不是恒真，
    //    也证明修 manifest 缺失那一支没有顺手改掉老归档那一支的既有语义
    //    （`backupVerify.integrity.spec.ts` 与 `fullBackup.hardening.spec.ts` 都钉着它）。
    const manifest = {
      kind: 'vanblog-full-backup',
      version: 1,
      createdAt: '2026-09-20T00:00:00.000Z',
      format: 'gzip',
      compressor: 'gzip -9',
      databases: { vanBlog: { collections: { articles: { count: 1, bytes: 8, indexes: 0 } } } },
      static: {},
      totals: { databases: 1, collections: 1, documents: 1, files: 0, staticBytes: 0 },
    };
    const archivePath = buildArchiveWithBrokenManifest(dir, JSON.stringify(manifest, null, 2));
    const result = await verifyFullBackup(archivePath);
    const notes = result.integrity.notes.join(' ');
    expect(notes).toContain('没有 integrity 块');
    expect(notes).toContain('清单可解析');
    expect(notes).not.toContain('读不出来');
  });

  it('两种情况都**不抛**（TypeError 会变成 500，而校验接口是灾难恢复路径）', async () => {
    const broken = buildArchiveWithBrokenManifest(dir, 'not json at all');
    await expect(verifyFullBackup(broken)).resolves.toBeDefined();
  });
});
