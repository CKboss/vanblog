/**
 * multipart 的文本字段也要过净化：`SanitizeBodyPipe` 的行为 + 覆盖面守卫。
 *
 * ## 缺口是怎么形成的
 * `sanitizeRequestPayloads` 是 Express 中间件，跑在 `express.json()` 之后；但 multer 是 Nest 的
 * **方法级拦截器**（`@UseInterceptors(FileInterceptor('file'))`），它在中间件**之后**才把表单字段
 * 写进 `req.body`（`req.body = Object.create(null)` 然后逐字段 `appendField`）。
 * 所以中间件那一趟对 multipart 的文本字段是空转的。今天逐条核过没有"multipart 字段进 Mongo 查询"
 * 的路径（`/init/upload` 只用 `@Query('favicon')` 做字符串比较、`/init/restore` 的 `setupKey`
 * 只参与 `safeEqual`），但形状摆在那儿等着被踩 —— 下一个人加一个"multipart + 按字段查询"的接口
 * 就会绕过全局净化。
 *
 * ## 为什么用全局 Pipe
 * Nest 的执行顺序是：中间件 → 守卫 → 拦截器（前置） → **管道** → 处理器。
 * 管道正好跑在 FileInterceptor 之后、处理器之前，是唯一能统一兜住这一半的位置：
 *  - 全局**拦截器**不行：它的前置阶段跑在方法级 FileInterceptor **之前**；
 *  - 全局**中间件**更不行：那时 multer 还没跑。
 */
import { SanitizeBodyPipe, stripOperatorKeys } from './sanitizeRequest';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const code = stripCommentsForAnchor;
const pipe = new SanitizeBodyPipe();
const bodyMeta = { type: 'body' } as any;
const queryMeta = { type: 'query' } as any;

describe('SanitizeBodyPipe：剥掉 Mongo 操作符键与原型污染键', () => {
  it('经典的 $ne / $gt 注入形状被剥成空对象（与中间件同一套规则）', () => {
    const out: any = pipe.transform({ name: { $ne: null }, pass: { $gt: '' } }, bodyMeta);
    expect(out).toEqual({ name: {}, pass: {} });
  });

  it('嵌套与数组里的操作符键同样被剥掉', () => {
    const out: any = pipe.transform(
      { a: [{ $where: 'x' }, { ok: 1 }], b: { c: { $regex: '.*' } } },
      bodyMeta,
    );
    expect(out).toEqual({ a: [{}, { ok: 1 }], b: { c: {} } });
  });

  it('__proto__ / constructor / prototype 被剥掉，正常字段与含 $ 的**值**不受影响', () => {
    const out: any = pipe.transform(
      { __proto__: { admin: true }, constructor: 1, prototype: 2, title: 'a$b', path: '$PATH' },
      bodyMeta,
    );
    expect(out.title).toBe('a$b');
    expect(out.path).toBe('$PATH');
    expect(Object.keys(out).sort()).toEqual(['path', 'title']);
  });

  it('@Body("setupKey") 这种取单个字段的形状：字符串原样返回（不能被"净化"成 undefined）', () => {
    expect(pipe.transform('abc123==', bodyMeta)).toBe('abc123==');
    expect(pipe.transform('', bodyMeta)).toBe('');
  });

  it('非 body 参数（query/param/custom）不由这个管道处理', () => {
    const value = { $ne: 1 };
    expect(pipe.transform(value, queryMeta)).toBe(value);
  });

  it('文件缓冲与空值原样放过（别把上传的文件弄丢）', () => {
    const buf = Buffer.from('x');
    expect(pipe.transform(buf, bodyMeta)).toBe(buf);
    expect(pipe.transform(undefined, bodyMeta)).toBeUndefined();
    expect(pipe.transform(null, bodyMeta)).toBeNull();
  });

  it('对已经净化过的 JSON body 再跑一遍是幂等的（全局挂上不会改变既有 JSON 接口行为）', () => {
    const once: any = stripOperatorKeys({ a: { $ne: 1 }, b: 2 });
    const twice: any = pipe.transform(once, bodyMeta);
    expect(twice).toEqual(once);
  });
});

describe('覆盖面守卫：管道已在 main.ts 全局注册', () => {
  const main = code(read('../main.ts'));

  it('main.ts 里注册了全局管道（调用形状，不是只 import）', () => {
    expect(main).toMatch(/app\.useGlobalPipes\(new SanitizeBodyPipe\(\)\)/);
    expect(main).toMatch(/import \{ sanitizeRequestPayloads, SanitizeBodyPipe \} from '\.\/utils\/sanitizeRequest';/);
  });

  it('⚠️ 反证的反证：那条注册断言跑在"只 import 不用"的形状上必须不命中', () => {
    expect("import { SanitizeBodyPipe } from './utils/sanitizeRequest';").not.toMatch(
      /app\.useGlobalPipes\(new SanitizeBodyPipe\(\)\)/,
    );
  });

  it('既有的中间件注册没有被顶掉（两层都要在）', () => {
    expect(main).toMatch(/app\.use\(sanitizeRequestPayloads\)/);
  });
});

describe('覆盖面守卫：multipart 入口不许绕过管道去读 req.body', () => {
  const controllerRoot = join(__dirname, '../controller');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        out.push(...walk(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('每一个用 FileInterceptor 的控制器都没有直接读 req.body / request.body', () => {
    const offenders: string[] = [];
    let multipartFiles = 0;
    for (const file of walk(controllerRoot)) {
      const src = code(readFileSync(file, 'utf8'));
      if (!/FileInterceptor|FilesInterceptor|AnyFilesInterceptor/.test(src)) {
        continue;
      }
      multipartFiles += 1;
      // 只认"从 req/request 上取 body"的写法；`@Body()` 参数是管道能覆盖的，不算
      if (/\b(?:req|request)\s*\.\s*body\b/.test(src)) {
        offenders.push(file.replace(controllerRoot, 'controller'));
      }
    }
    // 空转防护：必须真的扫到了 multipart 控制器（本轮实测 8 个文件 / 10 个入口）
    expect(multipartFiles).toBeGreaterThanOrEqual(7);
    expect(offenders).toEqual([]);
  });

  it('⚠️ 反证的反证：那条形状正则跑在旧写法上必须命中', () => {
    expect('const key = req.body.setupKey;').toMatch(/\b(?:req|request)\s*\.\s*body\b/);
    expect('async up(@Body() body: any) {}').not.toMatch(/\b(?:req|request)\s*\.\s*body\b/);
  });
});
