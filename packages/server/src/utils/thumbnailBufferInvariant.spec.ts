/**
 * "缩略图生成成功就必须有 buffer" 这个不变量：
 * 由 `requireThumbnailBuffer()` **一处**集中承担，破坏时**抛错**而不是让下游写出坏图片。
 *
 * 🔴 为什么不是撒 `?.`：下游是 `localProvider.saveThumb(name, buffer, ext)`，
 * `buffer` 为 undefined 时会**写出一个空的/坏的图片文件** —— 图床列表里看着正常、点开是坏图，
 * 属于**静默数据损坏，比崩溃更糟**。所以失败方向必须是"这张图的 AVIF 没生成"，而不是"写了个坏文件"。
 *
 * 🔴 也**不是**可辨识联合（那才是理论上的正解）：实测把 `ThumbnailResult` 改成
 * `ThumbnailOk | ThumbnailFailure` 之后，在**项目实际配置**（`strictNullChecks: false`）下
 * `static.provider.ts` 会冒出 **5 条 TS2339**（`Property 'reason' does not exist on type 'ThumbnailOk'`），
 * **构建直接挂**；而开 `--strictNullChecks` 时那 5 条 **0 命中**（判别式收窄生效）。
 * ⇒ 判别式收窄依赖 strictNullChecks，本项目它是关的。联合类型是**将来打开开关后的终态**。
 */
import fs from 'fs';
import path from 'path';
import { requireThumbnailBuffer } from './thumbnail';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

const BUF = Buffer.from([1, 2, 3, 4]);

describe('requireThumbnailBuffer：一处集中断言，破坏不变量时大声抛错', () => {
  it('正常成功结果 ⇒ 原样返回 buffer 与 ext', () => {
    const out = requireThumbnailBuffer({ ok: true, buffer: BUF, ext: '.avif' }, 'ctx');
    expect(out.buffer).toBe(BUF);
    expect(out.ext).toBe('.avif');
  });

  it('🔴 声明 ok:true 却没有 buffer ⇒ 抛错（这就是"会写出坏图片"的那个形状）', () => {
    expect(() =>
      requireThumbnailBuffer({ ok: true, ext: '.avif' } as any, 'StaticProvider 上传'),
    ).toThrow(/不变量被破坏/);
    expect(() =>
      requireThumbnailBuffer({ ok: true, ext: '.avif' } as any, 'StaticProvider 上传'),
    ).toThrow(/StaticProvider 上传/);
  });

  it('声明 ok:true 却没有 ext ⇒ 同样抛错（ext 决定落盘文件名，缺了会写出无扩展名的文件）', () => {
    expect(() => requireThumbnailBuffer({ ok: true, buffer: BUF } as any, 'ctx')).toThrow(
      /不变量被破坏/,
    );
  });

  it('ok:false 的结果被误当成成功传进来 ⇒ 抛错，并把 reason 带出来', () => {
    expect(() =>
      requireThumbnailBuffer({ ok: false, reason: 'no-engine' } as any, 'ctx'),
    ).toThrow(/no-engine/);
  });

  it('⚠️ 空 Buffer 也算"有 buffer"（长度 0 是上游的问题，不是这里的判据）', () => {
    // 钉住判据是"存在性"而不是"非空"，避免将来有人把它改成 !buffer.length 而误伤合法的空结果
    const out = requireThumbnailBuffer({ ok: true, buffer: Buffer.alloc(0), ext: '.webp' }, 'ctx');
    expect(out.buffer.length).toBe(0);
  });
});

describe('static.provider：4 处 AVIF 落盘都必须走 requireThumbnailBuffer', () => {
  const src = stripCommentsForAnchor(
    fs.readFileSync(path.join(__dirname, '../provider/static/static.provider.ts'), 'utf-8'),
  );

  it('🔴 剥注释后不允许再出现 avif.buffer / avifThumb.buffer 的直接解引用', () => {
    // ⚠️ 必须剥注释：static.provider.ts 里我自己写的解释性注释就含 "avifThumb.buffer" 字样，
    //    不剥就会假红（本仓库已踩 10 次"断言匹配到解释性注释"）。
    expect(src).not.toMatch(/avifThumb\.buffer/);
    expect(src).not.toMatch(/avif\.buffer/);
    // 反证：原文（未剥注释）里确实有这个词组 ⇒ 剥注释这一步不是空操作
    const raw = fs.readFileSync(path.join(__dirname, '../provider/static/static.provider.ts'), 'utf-8');
    expect(raw).toMatch(/avifThumb\.buffer/);
  });

  it('4 处落盘各自先取 requireThumbnailBuffer（计数钉死，少一处就说明有一处又裸解引用了）', () => {
    expect((src.match(/requireThumbnailBuffer\(/g) || []).length).toBe(4);
  });

  it('requireThumbnailBuffer 确实从 utils/thumbnail 导入（不是本地重名的另一个函数）', () => {
    expect(src).toMatch(/import \{[^}]*requireThumbnailBuffer[^}]*\} from 'src\/utils\/thumbnail'/);
  });

  it('⚠️ 负向对照：saveThumb 的调用点仍然存在（证明上面不是在空文件上恒真）', () => {
    expect((src.match(/saveThumb\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('thumbnail.ts：ThumbnailResult 的形状与"为什么不是联合"的记录', () => {
  const src = fs.readFileSync(path.join(__dirname, 'thumbnail.ts'), 'utf-8');

  it('三个 ok:true 的返回点都带着 buffer 与 ext（不变量的来源）', () => {
    const okBlocks = src.split('ok: true,').slice(1);
    expect(okBlocks.length).toBe(3);
    for (const b of okBlocks) {
      const head = b.slice(0, 220);
      expect(head).toMatch(/buffer,/);
      expect(head).toMatch(/ext: '\.(webp|jpg|avif)'/);
    }
  });

  it('记录了"判别式联合在本项目编译不过"这个实测结论（防止后人再来一遍）', () => {
    expect(src).toContain('strictNullChecks');
    expect(src).toContain('TS2339');
  });
});
