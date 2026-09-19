/**
 * `showFriends` 是一条**贯通四层却在最后一层被丢掉**的死设置，现已整条删除。这里钉住两件事：
 * 它不许回潮；以及"删掉它不会让用户失去能力"这个前提仍然成立。
 *
 * ## 它以前长什么样
 *
 *   server DTO 声明 → website `getLayoutProps` 计算并下发 → `Layout` 当 prop 传给
 *   NavBar / NavBarMobile → 两个组件**只在 props 接口里声明、JSX 从不读它**
 *
 * 于是把 `siteInfo.showFriends` 设成 `"false"` 前台毫无变化；而 admin 里 0 处出现 ⇒ 界面上
 * 根本没有控件能设它，只能直接改库 —— 一个既改不动、改了也没用的字段。
 *
 * ## 为什么选"删干净"而不是"接上"
 *
 * 判据是：**隐藏友链这个能力用户已经有了，而且是在一个能发现的地方**。
 * `NavBar` 的导航项是从 `props.menus` 渲染的（后台「数据管理 → 导航配置」可增删排序），
 * 友链只是默认菜单里的一项 ⇒ 想隐藏就去导航配置里删掉那一项。
 * 这跟 `showRSS` 不一样：RSS 那个入口是 NavBar 里**硬编码**的元素（`props.showRSS == "true" && …`），
 * 不在 menus 里，所以它必须有自己的开关。
 * 再给友链加一个开关，等于同一件事有两个入口，其中一个是新加的、还得配一个后台控件 ——
 * 活动部件更多，收益为零。所以选删除。
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

// __dirname = <root>/packages/server/src ⇒ 到仓库根是 3 层
const REPO_ROOT = path.resolve(__dirname, '../../..');
const src = (p: string) => stripCommentsForAnchor(readFileSync(path.join(REPO_ROOT, p), 'utf-8'));

/** 这条死设置曾经出现过的全部位置（四层）。 */
const LAYERS = [
  'packages/server/src/types/site.dto.ts', // ① DTO 声明
  'packages/website/utils/getLayoutProps.ts', // ② 计算并下发
  'packages/website/components/Layout/index.tsx', // ③ 当 prop 传下去
  'packages/website/components/NavBar/index.tsx', // ④ 声明了却从不读
  'packages/website/components/NavBarMobile/index.tsx', // ④ 同上
  'packages/website/api/getAllData.ts', // 类型 + 兜底默认值
];

describe('showFriends 死设置已整条删除', () => {
  it.each(LAYERS)('%s 里不许再出现 showFriends', (file) => {
    // ⚠️ 断言"不存在"必须在**剥注释之后**做：这些文件里都留着解释这次删除的注释，
    //    注释里必然写着 showFriends。本仓库已经六次踩到"断言匹配到解释性注释"。
    expect(src(file)).not.toContain('showFriends');
  });

  it('后台也从来没有过这个控件（所以没有"删掉一个能用的开关"这回事）', () => {
    expect(src('packages/admin/src/components/SiteInfoForm/index.tsx')).not.toContain('showFriends');
  });

  it('空转反证：同一把尺子量**旧形状**必须命中（否则上面几条什么都没证明）', () => {
    const legacy = stripCommentsForAnchor(
      [
        'export class SiteInfo {',
        "  showFriends: 'true' | 'false';",
        '}',
        'const layout = { showFriends };',
        '<NavBar showFriends={props.option.showFriends} />',
      ].join('\n'),
    );
    expect(legacy).toContain('showFriends');
    // ⚠️ 4 处，不是 3：`<NavBar showFriends={props.option.showFriends} />` 一行就占两处。
    //    这里原本写 3，是这条反证自己把父代理的算术错误抓出来的 —— 反证的价值正在于此。
    expect(legacy.match(/showFriends/g)!.length).toBe(4);
  });
});

describe('删除的前提仍然成立：隐藏友链走导航配置，而 showRSS 那个真开关没被误删', () => {
  it('NavBar 的导航项是从 menus 渲染的（后台「导航配置」可增删）', () => {
    const nav = src('packages/website/components/NavBar/index.tsx');
    expect(nav).toContain('props.menus.map');
  });

  it('默认菜单里确实有「友链」这一项（所以它可被删掉，而不是硬编码在组件里）', () => {
    const all = src('packages/website/api/getAllData.ts');
    expect(all).toContain('defaultMenu');
    expect(all).toContain('友链');
  });

  it('对照：showRSS 是 NavBar 里**硬编码**元素的开关，必须留着且真的被读', () => {
    const nav = src('packages/website/components/NavBar/index.tsx');
    expect(nav).toContain('showRSS');
    // 真的在 JSX 里被用作条件（不是只声明在 props 接口里 —— 那正是 showFriends 的病）
    expect(nav).toMatch(/props\.showRSS\s*==\s*"true"\s*&&/);
    expect(src('packages/admin/src/components/SiteInfoForm/index.tsx')).toContain('showRSS');
  });

  it('DTO 里 showRSS 仍在（这次只删了 showFriends，没有顺手删别的）', () => {
    const dto = src('packages/server/src/types/site.dto.ts');
    expect(dto).toContain('showRSS');
    expect(dto).not.toContain('showFriends');
  });
});
