import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { BACKUP_STATIC_FOLDERS } from './utils/fullBackup';
import { ATTACHMENT_FOLDER } from './utils/attachment';
import { THUMB_FOLDER } from './types/setting.dto';
import { config } from './config';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 整站备份"哪些静态目录该进归档"的**分类守卫**。
 *
 * 为什么要有它：`BACKUP_STATIC_FOLDERS` 是一份手写清单，而静态目录下会出现什么子目录
 * 是由**别的文件**决定的（`main.ts` 的 checkOrCreate、`theme.provider` 的 THEME_SUBDIR、
 * multer 的临时目录…）。两边不同步就是静默的数据丢失 —— 已经真发生过一次：
 * 后台上传的主题 CSS 存在 `<static>/themes/`，而清单里只有 `img/file/customPage`，
 * 于是主题**从来不进归档**；又因为主题的元数据在 settings、启用状态在 metas（都随库备份），
 * 恢复之后后台显示"主题在、已启用"、`/api/public/theme` 照常列出它，
 * 只有 `/static/themes/<id>-<hash>.css` 没了 ⇒ `/api/public/theme.css` 404，
 * 前台静默退回默认皮肤。一次"看起来成功"的恢复。
 *
 * 所以这里的判据不是"清单长什么样"，而是：
 *  1. 代码里**所有会在 staticPath 下建目录的地方**都必须在下面两张清单之一里；
 *  2. 本机真实的静态目录（存在时）里的每个子目录也必须在两张清单之一里；
 *  3. 出现第三类（谁都没登记）⇒ 测试红，并且直接把这个目录名打出来。
 * 换句话说：**以后谁在静态目录下加一个新目录，就必须在这里表态它是不是用户数据。**
 */

/** 用户数据：删了就没了，必须进归档 */
const USER_DATA_DIRS: Record<string, string> = {
  img: '图床图片与缩略图（上传的原图不可再生）',
  file: '附件管理里的任意文件（ATTACHMENT_FOLDER）',
  customPage: '自定义页面的 HTML 与资源',
  themes: '后台上传的主题 CSS（theme.provider 的 THEME_SUBDIR）',
};

/** 可再生 / 临时 / 不该带走：故意不进归档，理由必须写在这里 */
const DERIVED_DIRS: Record<string, string> = {
  rss: 'rss.provider 在启动与每次改动后重新生成 feed.xml/json',
  sitemap: 'sitemap.provider 同样会重新生成 sitemap.xml',
  search: '可由服务端随时重新生成，与 rss/sitemap 同类',
  tmp: '整站备份/恢复的暂存目录（里面可能正躺着另一个整站归档）',
  'upload-tmp': 'multer 上传的临时目录（main.ts 对匿名请求 403）',
  export: '旧的导出归档目录，main.ts 已对匿名请求 403，内容按需重新导出',
};

const root = __dirname; // src/
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/**
 * 剥掉注释再匹配（否则注释里提到的目录名会被当成"代码会建的目录"）。
 *
 * ⚠️ **必须先剥整行注释、再剥块注释**，顺序反了会静默失效：main.ts 里有一行注释写着
 * "`/static/` 下除 `/static/img/` 里的图片由 caddy 直服外，附件/主题/自定义页面都反代到 Node"，
 * 原文里那个通配写法含有一个斜杠紧跟星号的序列（`img/` + 星号 + `.{webp,…}`），
 * 会被"先剥块注释"的正则当成块注释的开头，一路吃到 130 行之后真正的结束标记为止 ——
 * 于是 main.ts 里**所有** `checkOrCreate(path.join(globalConfig.staticPath, 'x'))`
 * 都被剥掉了，本用例只抽到 1 个目录（阈值是 >=6），守卫当场变红。
 * 这不是假设：2026-09-17 就真发生了（main.ts 改写之后），所以顺序写死在这里。
 */
const code = stripCommentsForAnchor;

/** `String.prototype.matchAll` 是 ES2020 的，而本项目 target 是 es2017 ⇒ 用 exec 循环 */
function allMatches(re: RegExp, text: string, group = 1): string[] {
  const out: string[] = [];
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const global = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = global.exec(text)) !== null) {
    if (m[group] !== undefined) out.push(m[group]);
    if (m[0] === '') global.lastIndex += 1; // 防零宽匹配死循环
  }
  return out;
}

/** 从源码里把"会在 staticPath 下出现的子目录名"抠出来（剥掉注释再匹配） */
function dirsCreatedByCode(): string[] {
  const found = new Set<string>();
  // main.ts：checkOrCreate(path.join(globalConfig.staticPath, 'x')) / useStaticAssets(...'x')
  const main = code(read('main.ts'));
  for (const name of allMatches(/path\.join\(\s*globalConfig\.staticPath\s*,\s*'([^']+)'/, main)) {
    found.add(name);
  }
  // 变量形式（ATTACHMENT_FOLDER / THUMB_FOLDER），下面用常量值替换
  for (const name of allMatches(/path\.join\(\s*globalConfig\.staticPath\s*,\s*([A-Z_][A-Za-z_]*)\s*\)/, main)) {
    found.add(name);
  }
  // main.ts 的匿名 403 拦截里写死的 /static/<dir>/ 前缀
  for (const name of allMatches(/'\/static\/([a-zA-Z0-9_-]+)\//, main)) {
    found.add(name);
  }
  // theme.provider：const THEME_SUBDIR = 'themes'
  const theme = code(read('provider/theme/theme.provider.ts'));
  for (const name of allMatches(/THEME_SUBDIR\s*=\s*'([^']+)'/, theme)) {
    found.add(name);
  }
  // 变量名换成真实值
  const resolved = new Set<string>();
  for (const name of found) {
    if (name === 'ATTACHMENT_FOLDER') resolved.add(ATTACHMENT_FOLDER);
    else if (name === 'THUMB_FOLDER') resolved.add(THUMB_FOLDER);
    else resolved.add(name);
  }
  // 嵌套目录（img/thumb）归到它的顶层目录
  return Array.from(resolved).map((d) => d.split('/')[0]);
}

describe('整站备份的静态目录分类', () => {
  it('用户数据目录一个不少地都在归档清单里', () => {
    for (const dir of Object.keys(USER_DATA_DIRS)) {
      expect(BACKUP_STATIC_FOLDERS).toContain(dir);
    }
    // 反过来也成立：清单里不许有"没人认领"的目录
    for (const dir of BACKUP_STATIC_FOLDERS) {
      if (!USER_DATA_DIRS[dir]) {
        throw new Error(
          `BACKUP_STATIC_FOLDERS 里的 "${dir}" 既不是已登记的用户数据目录，` +
            '也没写进 DERIVED_DIRS —— 请先在分类里表态再改清单',
        );
      }
    }
  });

  it('可再生/临时目录一个都不在归档清单里（每条都带着理由）', () => {
    for (const [dir, why] of Object.entries(DERIVED_DIRS)) {
      expect(BACKUP_STATIC_FOLDERS).not.toContain(dir);
      expect(why.length).toBeGreaterThan(5); // 理由不能是空的
    }
  });

  it('代码里会建的每一个静态子目录都已分类（新增目录而没表态 ⇒ 这条会红）', () => {
    const created = dirsCreatedByCode();
    // 反证：这套抽取必须真的抽到了东西，否则这条断言是空的
    expect(created.length).toBeGreaterThanOrEqual(6);
    expect(created).toContain('themes');
    expect(created).toContain('img');
    const unknown = created.filter((d) => !USER_DATA_DIRS[d] && !DERIVED_DIRS[d]);
    if (unknown.length) {
      throw new Error(
        `静态目录下出现了未分类的子目录：${unknown.join(', ')}。` +
          '用户数据要加进 fullBackup.ts 的 BACKUP_STATIC_FOLDERS（并写进 USER_DATA_DIRS），' +
          '可再生/临时的要写进 DERIVED_DIRS 并注明理由 —— ' +
          '漏掉的后果是"恢复看起来成功了，但那份数据没了"（themes 就是这么漏的）。',
      );
    }
    // thumb 是 img 的嵌套子目录，随 img 一起进归档
    expect(THUMB_FOLDER).toBe('thumb');
  });

  it('本机真实的静态目录里也没有未分类的子目录（目录存在时才跑）', () => {
    const staticPath = config?.staticPath;
    if (!staticPath || !existsSync(staticPath)) {
      // eslint-disable-next-line no-console
      console.log(`（跳过：静态目录不存在 ${staticPath}）`);
      return;
    }
    const dirs = readdirSync(staticPath).filter((name) => {
      try {
        return statSync(join(staticPath, name)).isDirectory();
      } catch {
        return false;
      }
    });
    // eslint-disable-next-line no-console
    console.log(`（本机静态目录 ${staticPath}：${dirs.join(', ')}）`);
    const unknown = dirs.filter((d) => !USER_DATA_DIRS[d] && !DERIVED_DIRS[d]);
    if (unknown.length) {
      throw new Error(
        `本机静态目录里有未分类的子目录：${unknown.join(', ')}（同上一条的处理办法）`,
      );
    }
    // 用户数据目录里，真实存在的必须都在归档清单里
    for (const dir of dirs) {
      if (USER_DATA_DIRS[dir]) {
        expect(BACKUP_STATIC_FOLDERS).toContain(dir);
      }
    }
  });

  it('themes 确实是主题 CSS 的落地目录（改动 THEME_SUBDIR 会让这条红，提醒同步备份清单）', () => {
    const theme = read('provider/theme/theme.provider.ts');
    expect(theme).toContain("THEME_SUBDIR = 'themes'");
    expect(theme).toContain('path.join(config.staticPath, THEME_SUBDIR)');
    expect(BACKUP_STATIC_FOLDERS).toContain('themes');
  });
});
