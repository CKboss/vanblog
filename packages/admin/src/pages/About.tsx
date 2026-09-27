import ProCard from '@ant-design/pro-card';
import { PageContainer } from '@ant-design/pro-layout';
import { Divider, Image, Space, Spin, Tag, Typography } from 'antd';
import { useCallback, useMemo } from 'react';
import { useIntl, useModel } from 'umi';

/**
 * 「关于」页。
 *
 * 口径（2026-09 起，站长定的）：**只说当前这个版本的事**，不再以"与上游对照"来描述自己。
 * 这一页以前整页指向原作者的上游项目（仓库、文档站、更新日志、交流群），而这个后台跑的是
 * 本仓库的代码 —— 点「提交BUG」会开到上游仓库，报的却是本版本才有的问题；点「更新日志」
 * 看到的是上游的发版记录，本版本的改动一条都不在里面。
 *
 * 现在：功能 / 日志 / 文档 / 反馈全部指向本仓库；上游只保留 **GPL-3.0 的署名要求与本该有的礼节**
 * （原作者署名、上游仓库链接、打赏原作者、许可证说明），并明说上游的文档与日志描述的是
 * **官方镜像**的行为、与本版本不同，问题请到本仓库提 Issue。
 *
 * ⚠️ 文案里**不要断言"运行的是某个分支"**：发布镜像里上方版本标签显示的是 `v2026.9.2@23f2e9c`
 * 这类 tag+commit，写"跑的是 dev/dsh 分支"会与它并排矛盾（源码构建时才是 `dev/dsh@<短sha>`）。
 * `FORK_BRANCH` 只用来拼仓库里文档/日志的链接地址，与"运行的是哪个版本"无关。
 */
const FORK_REPO = 'https://github.com/CKboss/vanblog';
const FORK_BRANCH = 'dev/dsh';
const FORK_COMMITS = `${FORK_REPO}/commits/${FORK_BRANCH}`;
const FORK_CHANGELOG = `${FORK_REPO}/blob/${FORK_BRANCH}/CHANGELOG.md`;
// ⚠️ 这个锚点必须与 README 里真实存在的标题一致：改本节标题会让它变成死锚点（页面能打开，
//    但停在仓库顶部，看着像链接坏了）。已由 tests/unit/aboutPage.test.js 钉住"目标锚点真实存在"。
const FORK_README = `${FORK_REPO}/blob/${FORK_BRANCH}/README.md#出处与许可`;
const FORK_DOCS = `${FORK_REPO}/tree/${FORK_BRANCH}/docs`;
const FORK_ISSUES = `${FORK_REPO}/issues`;
const FORK_RUNBOOK = `${FORK_REPO}/blob/${FORK_BRANCH}/AGENTS.md`;

const UPSTREAM_REPO = 'https://github.com/Mereithhh/vanblog';
// ⚠️ 仓库名是 `vanblog`：旧名 `van-blog` 现在只是 301 跳过来（实测 301 → Mereithhh/vanblog）。
// ⚠️ 打赏锚点跟上游 README 走：上游已改成英文优先（`## Support the project`），中文的 `## 打赏`
// 在 README.zh-CN.md 里（两份都实测 200，`## 打赏` 在其第 211 行）。以前那个
// `<仓库首页>#打赏` 是**死锚点** —— 页面能打开，但会停在顶部而不是打赏那一节。
const UPSTREAM_SPONSOR = `${UPSTREAM_REPO}/blob/master/README.zh-CN.md#%E6%89%93%E8%B5%8F`;

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这份能力清单是模块级常量，拿不到 hook
 * ⇒ 改成函数版，由组件在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前逐字相同。
 * ⚠️ 上一批（Backup.jsx 的 `FORMAT_LABELS`）就是直接给模块级常量包了 t ⇒ 模块加载期 ReferenceError、整页白屏。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type AboutT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

// 🔴 「获取中」原来是**既当显示文案又当内部哨兵**（`version == '获取中'` 决定 Spin 转不转）
//    ⇒ 按"线路字面量 vs 显示文案"那条规矩拆开：哨兵用不会与真实版本号撞车的 ASCII 常量，
//    显示走语言包。🔴 直接翻译那个字面量也能work（两边同一个 key），但哨兵一旦是译文，
//    哪天有人只改其中一处就会静默失效（Spin 永远转 / 永不转），而且看不出来。
const VERSION_LOADING = '__version_loading__';

/** 这个版本的主要能力（只写一句话能说清的，细节在文档与 CHANGELOG） */
const forkHighlights = (t: AboutT = IDENTITY_T) => [
  t('about.hlComments', '内置评论系统（可替代外挂 Waline，支持从 Waline 导入）'),
  t('about.hlMarkdown', '补齐 6 种 Markdown 语法，编辑器与前台用同一套插件'),
  t('about.hlBackup', '整站备份 / 恢复，单篇导出 .md 与带图 .mdz'),
  t('about.hlImagePipeline', '图片管线：自动缩放、缩略图、隐写水印、原地替换'),
  t('about.hlPathname', '拼音文章别名，旧链接不失效'),
  t('about.hlAppleTheme', 'Apple 风格前台皮肤（可一键切回默认）'),
  t('about.hlSeo', 'SEO：canonical 与 301、JSON-LD、sitemap lastmod、动态 robots.txt'),
  t('about.hlPerf', '前后台性能优化，多轮 bug 与安全加固'),
  t('about.hlInstaller', '一键安装脚本：默认拉本仓库镜像，拉不到自动回退源码构建'),
];

/** identity 视图（给还没接 i18n 的调用方 / 单测用） */
const FORK_HIGHLIGHTS = forkHighlights();

const linkStyle = { whiteSpace: 'nowrap' as const };

export default function (props) {
  // 🔴 语言选择必须在**渲染期**。t 用 useCallback([intl]) 包成**稳定引用**：下面的 useMemo 依赖数组里有 t，
  //    不稳定 ⇒ 每轮渲染都变 ⇒ 重复计算（§7.144 A/B 两条一起满足）。
  const intl = useIntl();
  const t = useCallback(
    (id: string, defaultMessage: string, values?: Record<string, any>) =>
      intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const { initialState } = useModel('@@initialState');
  const version = useMemo(() => {
    const v = initialState?.version || VERSION_LOADING;
    return v;
    // 🔴 依赖数组必须带 t（回调体里用到了）—— 这里其实没用 t，但下面渲染处用了哨兵判断，
    //    保持一致：谁用 t 谁声明 t。
  }, [initialState, history]);

  return (
    <PageContainer title={null} extra={null} header={{ title: null, extra: null, ghost: true }}>
      <Spin spinning={version === VERSION_LOADING}>
        <ProCard>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexDirection: 'column',
              userSelect: 'none',
            }}
          >
            <Image width={200} src="/logo.svg" alt="logo" preview={false} />
            <div
              style={{
                fontSize: 26,
                fontWeight: 500,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <div>VanBlog</div>
              <div style={{ marginBottom: 4, marginLeft: 4 }}>
                <Tag color="cyan">
                  {version === VERSION_LOADING ? t('about.fetchingVersion', '获取中') : version}
                </Tag>
              </div>
              <div style={{ marginBottom: 4 }}>
                {/* 明确标出来：这不是上游原版 */}
                <Tag color="gold">{t('about.enhancedForkTag', '增强修改版')}</Tag>
              </div>
            </div>
            <p align="center">{t('about.slogan', '一款简洁实用优雅的高性能个人博客系统')}</p>

            <Typography.Paragraph
              type="secondary"
              style={{ maxWidth: 660, textAlign: 'center', marginBottom: 4 }}
            >
              {/* 🔴 "文字 + 链接 + 文字 + <b> + 文字" ⇒ react-intl 3.x 没有富文本占位符，只能拆成 prefix/suffix。
                  ⚠️ `{' '}` 是 JSX 里的**字面空格** ⇒ 英文值两端不要再带空格（否则双空格：§7.171 B）。 */}
              {t('about.currentRepoPrefix', '当前后台运行的是')}{' '}
              <a target="_blank" rel="noreferrer" href={FORK_REPO} style={linkStyle}>
                CKboss/vanblog
              </a>
              {t(
                'about.currentRepoSuffix',
                '，具体版本以上方的版本标签为准，遵循 GPL v3 许可。遇到问题请到',
              )}
              <b>{t('about.thisRepo', '本仓库')}</b>
              {t('about.currentRepoSuffix2', '提 Issue，这里才有本版本的改动记录。')}
            </Typography.Paragraph>

            <div style={{ maxWidth: 700, margin: '4px 0 12px', textAlign: 'center' }}>
              {forkHighlights(t).map((item) => (
                <Tag key={item} style={{ marginBottom: 6 }}>
                  {item}
                </Tag>
              ))}
            </div>

            <Space wrap style={{ justifyContent: 'center' }}>
              <a target="_blank" rel="noreferrer" href={FORK_REPO} style={linkStyle}>{t('about.linkRepo', '项目仓库')}</a>
              <a target="_blank" rel="noreferrer" href={FORK_COMMITS} style={linkStyle}>{t('about.linkCommits', '提交历史')}</a>
              <a target="_blank" rel="noreferrer" href={FORK_CHANGELOG} style={linkStyle}>{t('about.linkChangelog', '更新日志')}</a>
              <a target="_blank" rel="noreferrer" href={FORK_README} style={linkStyle}>{t('about.linkDiffOverview', '改动总览')}</a>
              <a target="_blank" rel="noreferrer" href={FORK_DOCS} style={linkStyle}>{t('about.linkFeatureDocs', '功能文档')}</a>
              <a target="_blank" rel="noreferrer" href={FORK_RUNBOOK} style={linkStyle}>{t('about.linkRunbook', '开发手册')}</a>
              {/* ⚠️ 不再深链 /swagger：它现在默认关闭（VANBLOG_SWAGGER=true 才开），
                  死链比没有链更糟。改成指向仓库里的 API 文档。 */}
              <a
                target="_blank"
                rel="noreferrer"
                href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/reference/api.md"
                style={linkStyle}
              >{t('about.linkApiDoc', 'API文档')}</a>
            </Space>
            <Space style={{ marginTop: 8 }} wrap>
              <a target="_blank" rel="noreferrer" href={FORK_ISSUES} style={linkStyle}>{t('about.linkIssues', '提交BUG / 建议')}</a>
            </Space>

            <Divider style={{ maxWidth: 520, margin: '20px 0 12px' }} plain>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('about.upstreamDivider', '原始项目')}</Typography.Text>
            </Divider>

            <Typography.Paragraph
              type="secondary"
              style={{ maxWidth: 660, textAlign: 'center', marginBottom: 8, fontSize: 12 }}
            >
              {/* 🔴 两条片段链：链接两侧都有 `{' '}` 字面空格 ⇒ 英文值两端**不带**空格（否则双空格）。 */}
              {t('about.builtOnPrefix', '本版本的全部工作都建立在原作者')}{' '}
              <a target="_blank" rel="noreferrer" href={UPSTREAM_REPO} style={linkStyle}>
                @Mereithhh
              </a>{' '}
              {t('about.builtOnSuffix', '的 VanBlog 之上，遵循 GPL v3 许可，感谢原作者。')}
              <br />
              {t(
                'about.upstreamWarningP1',
                '⚠️ 上游项目的文档站、更新日志与交流群描述的是',
              )}
              <b>{t('about.officialMirror', '官方镜像')}</b>
              {t(
                'about.upstreamWarningP2',
                '的行为，与本版本不同，所以这里不再列出入口；本版本的问题请到',
              )}{' '}
              <a target="_blank" rel="noreferrer" href={FORK_ISSUES} style={linkStyle}>
                {t('about.thisRepoIssue', '本仓库的 Issue')}
              </a>{' '}
              {t('about.upstreamWarningP3', '反馈（上游仓库不认识这里的改动）。')}
            </Typography.Paragraph>

            <Space wrap style={{ justifyContent: 'center' }}>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_REPO} style={linkStyle}>{t('about.linkUpstreamRepo', '原作者的仓库')}</a>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_SPONSOR} style={linkStyle}>{t('about.linkSponsor', '打赏原作者')}</a>
            </Space>
          </div>
        </ProCard>
      </Spin>
    </PageContainer>
  );
}
