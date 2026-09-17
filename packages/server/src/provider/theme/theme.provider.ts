import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Model } from 'mongoose';
import { config } from 'src/config';
import { Setting, SettingDocument } from 'src/scheme/setting.schema';
import { MetaProvider } from '../meta/meta.provider';
import { ISRProvider } from '../isr/isr.provider';
import {
  BUILTIN_THEMES,
  THEME_ID_RE,
  THEME_MAX_BYTES,
  ThemeMeta,
  ThemeSetting,
  slugifyThemeId,
  validateThemeCss,
} from 'src/types/theme.dto';

/** 上传的主题 CSS 放在图床目录下的 themes/，由 caddy 直接服务，URL 是 /static/themes/... */
const THEME_SUBDIR = 'themes';

const hash8 = (buf: Buffer) => createHash('sha1').update(buf).digest('hex').slice(0, 8);

/**
 * 把库里存的 `theme.url` 收敛成 `<static>/themes/` 里的一个绝对路径；越界一律返回 null。
 *
 * ⚠️ 为什么读侧也要收敛（第四轮审计 B4）：`theme.url` 来自数据库，而**写侧的校验
 * 管不住所有入口** —— `POST /api/admin/init/restore` 走原生驱动（insertMany + rename），
 * mongoose schema 根本不跑；未初始化站点上它是匿名的，已初始化站点上
 * 「恢复一份来路不明的归档」（换机迁移、别人给的备份）同样能把任意值塞进
 * settings{type:'theme'} 与 metas.siteInfo.uiStyle。而 `getActive()` 读的又是
 * `metaProvider.getAll()` 的原始 siteInfo（不经过会收敛 uiStyle 的 getSiteInfo()）。
 * 于是 `path.join(staticPath, url)` 上的 `..` 段就成了**匿名可达的任意文本文件读**
 * （`GET /api/public/theme.css`），`remove()`/上传清理里的同款拼接则是任意文件**删除**。
 *
 * 收敛规则（与写侧服务端拼出来的形状对齐）：合法 url 永远是
 * `/static/themes/<id>-<hash8>.css`，所以只接受 resolve 之后仍落在
 * `<static>/themes/` **内部**的路径；空值、绝对路径、`..` 逃逸、恰好等于根目录，
 * 一律 null。调用方拿到 null 必须回 204 —— 与「内置主题」「文件丢了」完全同形，
 * 不新增可区分的响应。合法站点的行为零变化（blast radius 为零，有往返测试钉住）。
 */
export function resolveThemeCssPath(url: unknown): string | null {
  const raw = String(url ?? '');
  if (!raw) return null;
  const root = path.resolve(config.staticPath, THEME_SUBDIR);
  const abs = path.resolve(config.staticPath, raw.replace(/^\/static\//, ''));
  const rel = path.relative(root, abs);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

/**
 * 主题管理（插件式前台皮肤）。
 *
 * 为什么不用「打包进前台」的方式做自定义主题：前台是 Next 的 standalone 产物，
 * 改样式就得重新 build 整个网站（几十秒到几分钟），而且镜像是只读的 ——
 * 用户在后台传一份 CSS 就想立刻生效，只能走「静态文件 + <link>」这条路。
 * 内置的 apple 主题仍然打包在前台里（它是仓库代码的一部分，享受构建期优化），
 * 上传的主题则存在 `<static>/themes/`，两者用同一套 id 与 `data-ui` 作用域约定。
 */
@Injectable()
export class ThemeProvider {
  private readonly logger = new Logger(ThemeProvider.name);

  constructor(
    @InjectModel(Setting.name) private readonly settingModel: Model<SettingDocument>,
    private readonly metaProvider: MetaProvider,
    private readonly isrProvider: ISRProvider,
  ) {}

  private get themeDir() {
    return path.join(config.staticPath, THEME_SUBDIR);
  }

  /** 已上传主题的元数据（内置的不入库，每次现拼） */
  private async readUploaded(): Promise<ThemeMeta[]> {
    const doc: any = await this.settingModel.findOne({ type: 'theme' }).exec();
    const value = (doc?.value || {}) as Partial<ThemeSetting>;
    const list = Array.isArray(value.themes) ? value.themes : [];
    return list.filter((t) => t && typeof t.id === 'string');
  }

  private async writeUploaded(themes: ThemeMeta[]) {
    const value: ThemeSetting = { themes };
    const existing = await this.settingModel.findOne({ type: 'theme' }).exec();
    if (existing) {
      await this.settingModel.updateOne({ type: 'theme' }, { value }).exec();
    } else {
      await this.settingModel.create({ type: 'theme', value } as any);
    }
  }

  /** 全部主题：内置在前，上传的按更新时间倒序 */
  async list(): Promise<ThemeMeta[]> {
    const uploaded = await this.readUploaded();
    const sorted = [...uploaded].sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    return [...BUILTIN_THEMES, ...sorted];
  }

  async findOne(id: string): Promise<ThemeMeta | undefined> {
    const all = await this.list();
    return all.find((t) => t.id === id);
  }

  /**
   * 当前生效的主题。前台用它决定：
   *   - `data-ui` 写什么（所有主题都写，包括 default）
   *   - 要不要额外挂一个 <link>（只有上传主题需要；apple 是打包进去的）
   */
  async getActive(): Promise<{ uiStyle: string; theme: ThemeMeta | null }> {
    const siteInfo: any = (await this.metaProvider.getAll())?.siteInfo || {};
    const uiStyle = String(siteInfo.uiStyle || 'apple');
    const theme = (await this.findOne(uiStyle)) || null;
    return { uiStyle, theme };
  }

  /**
   * 上传（或覆盖）一个主题。
   * @param file  multer 的文件对象（memoryStorage，拿 buffer）
   * @param meta  表单里的 name/description/author/version/id
   */
  async upload(
    file: { buffer?: Buffer; originalname?: string; size?: number } | undefined,
    meta: { id?: string; name?: string; description?: string; author?: string; version?: string },
  ): Promise<{ theme: ThemeMeta; warnings: string[] }> {
    if (!file || !file.buffer || !file.buffer.length) {
      throw new BadRequestException('没有收到文件（表单字段名要是 file）');
    }
    if (file.buffer.byteLength > THEME_MAX_BYTES) {
      throw new BadRequestException(
        `文件太大（${(file.buffer.byteLength / 1024).toFixed(1)}KB），主题 CSS 上限 ${
          THEME_MAX_BYTES / 1024
        }KB`,
      );
    }
    const originalName = String(file.originalname || '');
    // multer/busboy 按 latin1 解码文件名，中文名会变乱码（附件那条路径早有同样的处理）
    const decodedName = (() => {
      try {
        const fixed = Buffer.from(originalName, 'latin1').toString('utf8');
        return fixed.includes('\ufffd') ? originalName : fixed;
      } catch {
        return originalName;
      }
    })();
    if (!/\.css$/i.test(decodedName)) {
      throw new BadRequestException('只接受 .css 文件（主题就是一份样式表）');
    }

    const checked = validateThemeCss(file.buffer);
    if (!checked.ok || !checked.css) {
      throw new BadRequestException(checked.reason || 'CSS 校验没通过');
    }

    // id：表单给了就用，否则从文件名推；内置 id 是保留字
    const requested = String(meta?.id || '').trim();
    const id = slugifyThemeId(requested || decodedName);
    if (!id || !THEME_ID_RE.test(id)) {
      throw new BadRequestException(
        '主题 id 不合法：只能是小写字母、数字、- 和 _，2-40 位，且以字母或数字开头',
      );
    }
    if (BUILTIN_THEMES.some((t) => t.id === id)) {
      throw new BadRequestException(`「${id}」是内置主题的名字，换一个 id`);
    }

    const css = checked.css;
    const buf = Buffer.from(css, 'utf8');
    const hash = hash8(buf);
    const fileName = `${id}-${hash}.css`;
    const relUrl = `/static/${THEME_SUBDIR}/${fileName}`;

    // 写文件：先把目录建出来，再写新文件，最后删掉同一主题的旧文件
    // （顺序很重要：先删后写的话，中途失败会把正在用的主题弄没）
    await fs.mkdir(this.themeDir, { recursive: true });
    const absPath = path.join(this.themeDir, fileName);
    await fs.writeFile(absPath, buf, 'utf8');

    const uploaded = await this.readUploaded();
    const now = new Date();
    const prev = uploaded.find((t) => t.id === id);
    const record: ThemeMeta = {
      id,
      name: String(meta?.name || '').trim() || id,
      description: String(meta?.description || '').trim() || undefined,
      author: String(meta?.author || '').trim() || undefined,
      version: String(meta?.version || '').trim() || undefined,
      source: 'upload',
      url: relUrl,
      hash,
      size: buf.byteLength,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    const next = uploaded.filter((t) => t.id !== id).concat([record]);
    await this.writeUploaded(next);

    // 清掉旧文件（同名不同 hash 的那些）。
    // ⚠️ unlink 的目标必须过 resolveThemeCssPath：prev.url 来自数据库，
    // 恢复进来的恶意值（../ 或绝对路径）不能变成任意文件删除（第四轮审计 B4）。
    if (prev?.url && prev.url !== relUrl) {
      const oldAbs = resolveThemeCssPath(prev.url);
      if (oldAbs) {
        await fs.unlink(oldAbs).catch(() => undefined);
      }
    }

    // 如果改的正是当前生效的主题，前台要重新渲染才会拿到新的 URL（hash 变了）
    const active = await this.getActive();
    if (active.uiStyle === id) {
      this.isrProvider
        .activeAll(`主题 ${id} 更新，触发全量渲染`, undefined, { forceActice: true })
        .catch((err) => this.logger.error(`触发渲染失败：${err?.message}`));
    }

    return { theme: record, warnings: checked.warnings || [] };
  }

  /** 切换生效的主题（写进 siteInfo.uiStyle，然后触发全量渲染） */
  async activate(id: string): Promise<{ uiStyle: string; theme: ThemeMeta | null }> {
    const theme = await this.findOne(id);
    if (!theme) {
      throw new BadRequestException(`没有这个主题：${id}`);
    }
    await this.metaProvider.updateSiteInfo({ uiStyle: id } as any);
    // 主题只影响样式，但前台是静态生成的，必须重新渲染才看得到
    this.isrProvider
      .activeAll(`切换主题到 ${id}，触发全量渲染`, undefined, { forceActice: true })
      .catch((err) => this.logger.error(`触发渲染失败：${err?.message}`));
    return { uiStyle: id, theme };
  }

  /** 删除一个上传的主题（内置的、正在用的都不给删） */
  async remove(id: string): Promise<{ deleted: string }> {
    if (BUILTIN_THEMES.some((t) => t.id === id)) {
      throw new BadRequestException('内置主题不能删除');
    }
    const uploaded = await this.readUploaded();
    const target = uploaded.find((t) => t.id === id);
    if (!target) {
      throw new BadRequestException(`没有这个上传主题：${id}`);
    }
    const active = await this.getActive();
    if (active.uiStyle === id) {
      throw new BadRequestException('这个主题正在使用中，先切换到别的主题再删');
    }
    // ⚠️ 同 upload 的清理：target.url 是库里的值，收敛不通过就只删元数据、绝不 unlink
    if (target.url) {
      const abs = resolveThemeCssPath(target.url);
      if (abs) {
        await fs.unlink(abs).catch(() => undefined);
      }
    }
    await this.writeUploaded(uploaded.filter((t) => t.id !== id));
    return { deleted: id };
  }
}
