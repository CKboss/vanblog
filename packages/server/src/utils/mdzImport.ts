import { BadRequestException } from '@nestjs/common';
import compressing from 'compressing';
import * as yaml from 'yaml';
import { findUnsafeArchiveMember } from 'src/utils/fullBackup';
import { hasFrontMatter, stripFrontMatter } from 'src/utils/frontMatter';
import { extractImageRefs, rewriteImageUrls, safeDecodeURIComponent } from 'src/utils/markdownExport';

/**
 * `.mdz` 导入：`provider/export/markdownExport.provider.ts` 导出的**精确逆操作**。
 *
 * `.mdz` = zip 包：`<标题>.md`（front matter + 正文，图片链接是 `<标题>.assets/<文件>` 相对路径）
 * + `<标题>.assets/` 图片目录（Typora 风格）。导入要做的事：
 *  1. 在**内存里**解包（不落盘 ⇒ 没有临时目录要清理，也没有解包路径可逃逸）；
 *  2. 拒绝 zip 炸弹（成员数 / 解压后总体积 / 单成员体积三道上限，边解压边数）；
 *  3. 拒绝 zip-slip（成员名绝对路径或含 `..` 段）—— 复用 `utils/fullBackup.ts` 的
 *     `findUnsafeArchiveMember`（**只 import，绝不编辑那个文件**），与整站恢复同一套判定；
 *     检查发生在「写入任何东西」之前：本模块解包阶段不碰磁盘、不碰图床，
 *     图片入库（ingest 回调）在整个包通过校验之后才开始；
 *  4. 确定性地挑出那个 markdown 成员（排除导出说明.md）；
 *  5. 解析 front matter（**白名单**字段，`password` 永远被丢弃且不进响应/日志，
 *     见 normalizeFrontMatter 的注释）；
 *  6. 把正文里引用到的 assets 成员交给调用方的 ingest 回调入图床
 *     （StaticProvider.upload：魔数校验、按 (sign,staticType) 去重、缩略图、AVIF 兄弟、
 *     webp 压缩、隐写水印，全部与手动上传同一管线），再把相对链接改写成返回的服务 URL。
 *
 * 链接识别与改写直接复用导出侧的 `extractImageRefs` / `rewriteImageUrls`：
 * 两个方向对「什么算图片引用」「代码块里的假链接不动」的判断因此**不可能漂移**。
 */

// ---------------------------------------------------------------------------
// 上限（zip 炸弹与内存防线）
// ---------------------------------------------------------------------------

/** multipart 上传的压缩态体积上限（multer fileSize，见 MDZ_IMPORT_UPLOAD_OPTIONS） */
export const MDZ_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 解压后总体积上限：超过立即中止（边解压边计数，不等解完） */
export const MDZ_MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024;
/** 成员数上限（一个 .mdz 正常只有 1 个 md + 几十张图） */
export const MDZ_MAX_ENTRIES = 2000;
/** markdown 成员单文件上限 */
export const MDZ_MAX_MD_BYTES = 20 * 1024 * 1024;
/** 单个图片成员上限（与 MAX_IMAGE_UPLOAD_BYTES 同量级） */
export const MDZ_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * multer 选项。⚠️ 装饰器在类实例化之前求值，所以必须是模块级常量。
 * 默认内存存储：包整体 ≤200MB、解压产物有独立上限，全程不落盘。
 * parts/fields/files 收紧与 RESTORE_UPLOAD_OPTIONS 同一思路（multer 的主要 DoS 面
 * 是不限数量的 parts）。
 */
export const MDZ_IMPORT_UPLOAD_OPTIONS = {
  limits: {
    fileSize: MDZ_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 8,
    parts: 64,
    headerPairs: 64,
  },
};

/** 导出说明的成员名（挑 markdown 成员时要排除它，见导出侧 renderReport） */
export const EXPORT_NOTE_BASENAME = '导出说明.md';

// ---------------------------------------------------------------------------
// 解包（内存）+ 安全校验
// ---------------------------------------------------------------------------

function toBadRequest(err: unknown, fallback: string): BadRequestException {
  if (err instanceof BadRequestException) {
    return err;
  }
  const msg = (err as Error)?.message || String(err || '');
  return new BadRequestException(`${fallback}：${msg.slice(0, 200)}`);
}

/**
 * 在内存里解开 zip，逐成员执行安全与体积校验。
 * 任何一项不过 ⇒ 抛 400，**此时没有写入任何东西**（既不落盘也不进图床）。
 *
 * compressing 底层是 yauzl（decodeStrings:false，官方注释明说"支持绝对路径"），
 * 也就是说 compressing.zip.uncompress 自己**不设防** zip-slip —— 名字必须在这里查。
 * 符号链接成员同理不设防，但本函数从不落盘（只收 Buffer），软链成员只是一段普通字节，
 * 后续图片入库还有魔数校验兜底，构不成逃逸。
 */
/**
 * `StreamCtor` 参数只是测试缝（默认 compressing 的 UncompressStream）：
 * compressing 读包时会先自己归一化成员名（去掉前导 `/`、`\`→`/`、消掉 `..` 段），
 * 所以真字节造不出能到达下面 findUnsafeArchiveMember 的不安全名 ——
 * 那道检查是**纵深防御**（上游归一化行为若变化仍兜底），用假流直接测。
 */
export async function readMdzEntries(
  buffer: Buffer,
  StreamCtor?: any,
): Promise<{ entries: Map<string, Buffer>; notes: string[] }> {
  if (!buffer || !buffer.length) {
    throw new BadRequestException('上传内容为空：请选择一个 .mdz 文件');
  }
  const entries = new Map<string, Buffer>();
  const notes: string[] = [];
  let totalBytes = 0;

  return await new Promise((resolve, reject) => {
    let stream: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      stream = new (StreamCtor || (compressing.zip as any).UncompressStream)({ source: buffer });
    } catch (err) {
      reject(toBadRequest(err, '这不是一个有效的 zip 包（.mdz 本质是 zip）'));
      return;
    }
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        stream.destroy();
      } catch {
        // destroy 失败不影响报错
      }
      reject(toBadRequest(err, '无法解压这个 .mdz（文件可能已损坏，或它根本不是 zip）'));
    };

    stream.on('error', fail);
    stream.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve({ entries, notes });
      }
    });
    stream.on('entry', (header: any, entryStream: any, next: () => void) => {
      if (settled) {
        return;
      }
      const name = String(header?.name ?? '');
      const isDir = header?.type === 'directory' || name.endsWith('/');
      // zip-slip：绝对路径 / Windows 盘号 / 任何一段是 `..` —— 与整站恢复同一判定。
      // 目录成员也要查（它的名字同样描述了解包目标）。
      const unsafe = findUnsafeArchiveMember([name]);
      if (unsafe !== null) {
        fail(
          new BadRequestException(
            `压缩包里有可能写到解包目录之外的成员（${unsafe}），已拒绝导入`,
          ),
        );
        try {
          entryStream.destroy();
        } catch {
          // 同上
        }
        return;
      }
      if (entries.size + 1 > MDZ_MAX_ENTRIES) {
        fail(new BadRequestException(`压缩包成员数超过上限（${MDZ_MAX_ENTRIES} 个），已拒绝导入`));
        try {
          entryStream.destroy();
        } catch {
          // 同上
        }
        return;
      }
      if (isDir) {
        entryStream.resume();
        entryStream.on('end', next);
        entryStream.on('error', fail);
        return;
      }
      const perEntryCap = /\.md$/i.test(name) ? MDZ_MAX_MD_BYTES : MDZ_MAX_IMAGE_BYTES;
      const chunks: Buffer[] = [];
      let size = 0;
      entryStream.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        size += chunk.length;
        totalBytes += chunk.length;
        if (size > perEntryCap) {
          fail(
            new BadRequestException(
              `成员 ${name} 解压后超过单文件上限（${perEntryCap} 字节），已拒绝导入`,
            ),
          );
          try {
            entryStream.destroy();
          } catch {
            // 同上
          }
          return;
        }
        if (totalBytes > MDZ_MAX_UNCOMPRESSED_BYTES) {
          fail(
            new BadRequestException(
              `解压后总体积超过上限（${MDZ_MAX_UNCOMPRESSED_BYTES} 字节），疑似 zip 炸弹，已拒绝导入`,
            ),
          );
          try {
            entryStream.destroy();
          } catch {
            // 同上
          }
          return;
        }
        chunks.push(chunk);
      });
      entryStream.on('error', fail);
      entryStream.on('end', () => {
        if (settled) {
          return;
        }
        if (entries.has(name)) {
          // 重名成员：保留第一个（zip 允许重名，行为要确定），其余忽略并记录
          notes.push(`压缩包里有重名成员 ${name}，只导入了第一个`);
        } else {
          entries.set(name, Buffer.concat(chunks, size));
        }
        next();
      });
    });
  });
}

/**
 * 确定性地挑 markdown 成员：
 * - 候选 = 所有 `*.md`（大小写不敏感），排除 `导出说明.md`（导出侧的报告文件，不是正文）；
 * - 0 个 ⇒ null（调用方回 400）；
 * - 多个 ⇒ 根目录优先 > 名字更短优先 > 字节序靠前（导出产物永远只有一个根目录 md，
 *   出现多个说明包被第三方工具动过 —— 选哪一个都要写进 notes，绝不静默）。
 */
export function selectMarkdownMember(
  names: Iterable<string>,
): { name: string | null; notes: string[] } {
  const notes: string[] = [];
  const candidates = [...names].filter((n) => {
    if (!/\.md$/i.test(n)) {
      return false;
    }
    const base = n.split('/').pop() || '';
    return base !== EXPORT_NOTE_BASENAME;
  });
  if (!candidates.length) {
    return { name: null, notes };
  }
  candidates.sort((a, b) => {
    const aDepth = a.includes('/') ? 1 : 0;
    const bDepth = b.includes('/') ? 1 : 0;
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (candidates.length > 1) {
    notes.push(
      `压缩包里有 ${candidates.length} 个 Markdown 文件，按「根目录 > 名字更短 > 字节序」选择了 ${candidates[0]}`,
    );
  }
  return { name: candidates[0], notes };
}

// ---------------------------------------------------------------------------
// front matter
// ---------------------------------------------------------------------------

/**
 * 与 `utils/frontMatter.ts` 的 FRONT_MATTER_RE **逐字符一致**（那个正则没有导出，
 * 而 frontMatter.ts 禁止编辑；两边是否同步由 mdzImport.spec.ts 的钉子用例守着：
 * buildFrontMatter 的产物必须同时被 hasFrontMatter 认出来、被这里解析出来）。
 */
const FRONT_MATTER_BLOCK_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface ParsedMdzMarkdown {
  attrs: Record<string, any>;
  body: string;
  notes: string[];
}

/**
 * 拆 markdown：front matter（YAML）+ 正文。
 * 认不认 front matter 以 `utils/frontMatter.ts` 的 `hasFrontMatter` 为准（防"正文以 ---
 * 开头"的误伤），正文剥离用 `stripFrontMatter`（顺带吃掉紧随的空行）——
 * 与 RSS/摘要看到的是同一段逻辑。
 * YAML 解析失败不致命：按"没有元信息"处理，整段原文保留为正文，记一条 notes。
 */
export function parseMdzMarkdown(text: string): ParsedMdzMarkdown {
  const notes: string[] = [];
  if (!hasFrontMatter(text)) {
    return { attrs: {}, body: String(text ?? ''), notes };
  }
  const matched = FRONT_MATTER_BLOCK_RE.exec(text);
  let attrs: Record<string, any> = {};
  if (matched) {
    try {
      const parsed = yaml.parse(matched[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        attrs = parsed as Record<string, any>;
      } else {
        notes.push('front matter 不是键值对，已按无元信息处理');
      }
    } catch (err) {
      notes.push(
        `front matter 解析失败（${(err as Error)?.message?.slice(0, 80) || 'YAML 错误'}），已按无元信息处理，原文保留在正文里`,
      );
      return { attrs: {}, body: String(text ?? ''), notes };
    }
  }
  return { attrs, body: stripFrontMatter(text), notes };
}

/** 导入响应里允许的 front matter 字段（白名单 —— password 不在其中，也永远不可能混进来） */
const FRONT_MATTER_WHITELIST = [
  'title',
  'pathname',
  'slug',
  'url',
  'abbrlink',
  'category',
  'categories',
  'tags',
  'top',
  'hidden',
  'private',
  'createdAt',
  'updatedAt',
  'cover',
] as const;

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export interface NormalizedFrontMatter {
  frontMatter: Record<string, any>;
  /** 原文带非空 password 字段（值本身绝不外传，只报布尔） */
  passwordDropped: boolean;
  notes: string[];
}

/**
 * 把解析出来的 attrs 归一化成编辑器「修改信息」表单认识的字段。
 *
 * ⚠️ password 的处理（与 utils/accessPassword.ts 的现状对齐）：
 * 导出的 front matter 里 password 是 **scrypt 哈希**（几小时前刚迁移的，明文已不存在）。
 * 三种候选里选「丢弃 + 明确提示」：
 *  - 原样导入哈希 ⇒ 文章锁在一个**没有任何人知道明文**的密码上（哈希不可逆），
 *    而且把哈希塞进新库等于鼓励离线爆破；
 *  - 当成新明文再哈希 ⇒ 存进去的是"哈希的哈希"，同样永久锁死；
 *  - 丢弃 ⇒ 唯一可恢复的选项。`private: true` **原样保留**（fail-closed：
 *    private 且密码为空的文章谁都解不开 —— verifyAccessPassword 对空目标恒 false ——
 *    内容绝不会静默变公开），notes 里明确要求重新设置密码。
 * 哈希值本身绝不进响应体、绝不进日志：这里只输出一个布尔 passwordDropped。
 */
export function normalizeFrontMatter(attrs: Record<string, any>): NormalizedFrontMatter {
  const notes: string[] = [];
  const out: Record<string, any> = {};
  for (const key of FRONT_MATTER_WHITELIST) {
    if (!Object.prototype.hasOwnProperty.call(attrs || {}, key)) {
      continue;
    }
    const value = (attrs || {})[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (key === 'tags') {
      const list = Array.isArray(value) ? value : [value];
      const tags = list
        .filter((t) => typeof t === 'string' || typeof t === 'number')
        .map((t) => String(t).trim())
        .filter(Boolean);
      if (tags.length) {
        out.tags = tags;
      }
      continue;
    }
    if (key === 'categories') {
      if (Array.isArray(value)) {
        const cats = value.filter((c) => typeof c === 'string').map((c) => (c as string).trim()).filter(Boolean);
        if (cats.length) {
          out.categories = cats;
        }
      }
      continue;
    }
    if (key === 'createdAt' || key === 'updatedAt') {
      const iso = toIsoOrNull(value);
      if (iso) {
        out[key] = iso;
      } else {
        notes.push(`front matter 里的 ${key} 不是可识别的时间，已忽略`);
      }
      continue;
    }
    if (key === 'top') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        out.top = value;
      } else if (value === true || value === 'true') {
        out.top = 1;
      } else if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        out.top = Number(value);
      }
      continue;
    }
    if (key === 'hidden' || key === 'private') {
      out[key] = value === true || value === 'true' ? true : Boolean(value) && value !== 'false';
      continue;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) {
        out[key] = text;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }

  let passwordDropped = false;
  const rawPassword = (attrs || {})['password'];
  if (rawPassword !== undefined && rawPassword !== null && String(rawPassword).trim() !== '') {
    passwordDropped = true;
    notes.push('原文设置了访问密码，导入后需要重新设置（出于安全，密码不会随文件迁移）');
  }
  return { frontMatter: out, passwordDropped, notes };
}

// ---------------------------------------------------------------------------
// 图片链接解析（导出的逆映射）
// ---------------------------------------------------------------------------

export interface MdzImagePlanItem {
  /** 正文里的原 url 文本 */
  url: string;
  /** kind=import：对应的 zip 成员名（根相对，'/' 分隔） */
  memberName?: string;
  /** kind=skip：不导入/没导入的原因（进 skippedImages） */
  reason?: string;
  kind: 'import' | 'skip';
}

function basenameOf(name: string): string {
  return name.split('/').pop() || name;
}

function isAbsoluteRef(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(url)
  );
}

/**
 * 把相对链接解析成包内成员名（导出侧 toRelativeLink 的逆：`<dir>.assets/<file>`，
 * 不转义不编码 —— 但第三方工具打的包可能带百分号编码，所以按
 * 「原文 → decodeURIComponent」两个形态各查一次，与导出侧 safeDecodeURIComponent 对称）。
 */
export function resolveAssetMember(
  url: string,
  entryNames: ReadonlySet<string>,
): string | null {
  let rel = url.trim();
  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }
  if (!rel || rel.startsWith('/')) {
    return null;
  }
  if (entryNames.has(rel)) {
    return rel;
  }
  const decoded = safeDecodeURIComponent(rel);
  if (decoded !== rel && entryNames.has(decoded)) {
    return decoded;
  }
  return null;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|tif|tiff|heic|heif|ico)$/i;

/**
 * 纯函数：扫正文里的图片引用（与导出同一套 extractImageRefs，代码块里的假链接天然跳过），
 * 决定每个引用是「包内有成员可导入」还是「跳过（带原因）」。
 * 另外报告：包里有、但正文没引用的成员（不导入 —— 与导出侧"只打包被引用的图"对称）。
 */
export function planImageImports(
  body: string,
  entryNames: Iterable<string>,
): { plan: MdzImagePlanItem[]; notes: string[] } {
  const notes: string[] = [];
  const names = new Set(entryNames);
  const plan: MdzImagePlanItem[] = [];
  const seen = new Set<string>();
  const referenced = new Set<string>();
  for (const ref of extractImageRefs(body)) {
    const url = ref.url;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    if (/^data:/i.test(url.trim())) {
      plan.push({ url, kind: 'skip', reason: 'data URI（图片已内嵌在正文里），原样保留' });
      continue;
    }
    if (isAbsoluteRef(url.trim())) {
      plan.push({
        url,
        kind: 'skip',
        reason: '绝对地址（外链或原站点图床），原样保留；如需转存请用「转移外链图片」',
      });
      continue;
    }
    const member = resolveAssetMember(url, names);
    if (!member) {
      plan.push({ url, kind: 'skip', reason: '包里找不到对应的图片文件，链接原样保留' });
      continue;
    }
    referenced.add(member);
    plan.push({ url, memberName: member, kind: 'import' });
  }
  const unreferenced = [...names].filter(
    (n) => !referenced.has(n) && !/\.md$/i.test(n) && IMAGE_EXT_RE.test(basenameOf(n)),
  );
  if (unreferenced.length) {
    notes.push(
      `包里有 ${unreferenced.length} 个图片文件未被正文引用，没有导入（${unreferenced
        .slice(0, 3)
        .map((n) => basenameOf(n))
        .join('、')}${unreferenced.length > 3 ? ' 等' : ''}）`,
    );
  }
  return { plan, notes };
}

// ---------------------------------------------------------------------------
// 总装
// ---------------------------------------------------------------------------

export interface MdzSkippedImage {
  /** 正文里的链接文本（超长截断），或入库失败的成员名 */
  name: string;
  reason: string;
}

export interface MdzImportResult {
  title: string;
  /** front matter 已剥离、相对图片链接已改写成入库后服务 URL 的正文 */
  content: string;
  /** 白名单字段；绝不含 password */
  frontMatter: Record<string, any>;
  importedImages: number;
  /** 入库后与已有图片按内容去重命中的张数（upload 的 isNew=false） */
  dedupedImages: number;
  skippedImages: MdzSkippedImage[];
  notes: string[];
  passwordDropped: boolean;
  /** 选中的 markdown 成员名（前端展示/排障用） */
  markdownMember: string;
}

export interface MdzIngestResult {
  /** 图床服务 URL（/static/img/...），进正文 */
  src: string;
  /** false = 按内容 sign 命中已有图片（幂等导入靠它） */
  isNew?: boolean;
}

export type MdzIngestFn = (memberName: string, buffer: Buffer) => Promise<MdzIngestResult>;

function truncateUrl(url: string): string {
  const text = String(url || '');
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * 导入一个 .mdz（整包 Buffer）→ 编辑器需要的一切。**不创建文章**。
 *
 * ingest 回调在「整包通过 zip-slip / 体积 / 成员数校验」之后才会被调用 ——
 * 也就是说恶意包被拒绝时，图床与磁盘上一个字节都不会多。
 * 同一张图（同内容 sign）重复导入时 StaticProvider.upload 直接返回已有 URL
 * （isNew=false），所以同一个 .mdz 导两次不会在图床里留下重复文件。
 */
export async function importMdzBuffer(buffer: Buffer, ingest: MdzIngestFn): Promise<MdzImportResult> {
  const { entries, notes } = await readMdzEntries(buffer);
  const selected = selectMarkdownMember(entries.keys());
  notes.push(...selected.notes);
  if (!selected.name) {
    throw new BadRequestException(
      '压缩包里没有找到 Markdown 文件（*.md）：.mdz 应该是「一个 .md + 同名 .assets 图片目录」的 zip 包',
    );
  }
  const markdownMember = selected.name;
  const mdText = entries.get(markdownMember)!.toString('utf8');
  const parsed = parseMdzMarkdown(mdText);
  notes.push(...parsed.notes);
  const normalized = normalizeFrontMatter(parsed.attrs);
  notes.push(...normalized.notes);

  const title =
    (typeof normalized.frontMatter.title === 'string' && normalized.frontMatter.title) ||
    basenameOf(markdownMember).replace(/\.md$/i, '') ||
    'untitled';

  const { plan, notes: planNotes } = planImageImports(parsed.body, entries.keys());
  notes.push(...planNotes);

  const mapping = new Map<string, string>();
  const skippedImages: MdzSkippedImage[] = [];
  let importedImages = 0;
  let dedupedImages = 0;
  for (const item of plan) {
    if (item.kind === 'skip') {
      skippedImages.push({ name: truncateUrl(item.url), reason: item.reason || '跳过' });
      continue;
    }
    const memberBuffer = entries.get(item.memberName!);
    if (!memberBuffer) {
      skippedImages.push({ name: truncateUrl(item.url), reason: '包里找不到对应的图片文件' });
      continue;
    }
    try {
      const res = await ingest(item.memberName!, memberBuffer);
      if (!res?.src) {
        skippedImages.push({ name: truncateUrl(item.url), reason: '图片入库失败：没有返回服务地址' });
        continue;
      }
      mapping.set(item.url, res.src);
      importedImages += 1;
      if (res.isNew === false) {
        dedupedImages += 1;
      }
    } catch (err) {
      const reason = (err as Error)?.message || String(err || '');
      skippedImages.push({
        name: truncateUrl(item.url),
        reason: `图片入库失败：${reason.slice(0, 200)}`,
      });
    }
  }

  const content = rewriteImageUrls(parsed.body, mapping);
  return {
    title,
    content,
    frontMatter: normalized.frontMatter,
    importedImages,
    dedupedImages,
    skippedImages,
    notes,
    passwordDropped: normalized.passwordDropped,
    markdownMember,
  };
}
