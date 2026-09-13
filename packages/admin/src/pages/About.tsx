import ProCard from '@ant-design/pro-card';
import { PageContainer } from '@ant-design/pro-layout';
import { Divider, Image, Space, Spin, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { useModel } from 'umi';

/**
 * 「关于」页。
 *
 * ⚠️ 这一页以前整页都指向**上游**（Mereithhh/van-blog 与作者的文档站），
 * 但这个后台跑的其实是本 fork 的代码：点「提交BUG」会开到上游仓库，报的却是本分支才有的问题；
 * 点「更新日志」看到的是上游的发版记录，本分支的改动一条都不在里面。
 * 所以现在分成两块：上面是**本分支**（Issue、日志、文档都在这儿），
 * 下面单独一块**原始项目**（致谢 + 上游入口，并注明上游文档描述的是官方镜像的行为）。
 */
const FORK_REPO = 'https://github.com/CKboss/vanblog';
const FORK_BRANCH = 'dev/dsh';
const FORK_COMMITS = `${FORK_REPO}/commits/${FORK_BRANCH}`;
const FORK_CHANGELOG = `${FORK_REPO}/blob/${FORK_BRANCH}/CHANGELOG.md`;
const FORK_README = `${FORK_REPO}/blob/${FORK_BRANCH}/README.md#本分支新增内容`;
const FORK_DOCS = `${FORK_REPO}/tree/${FORK_BRANCH}/docs`;
const FORK_ISSUES = `${FORK_REPO}/issues`;
const FORK_RUNBOOK = `${FORK_REPO}/blob/${FORK_BRANCH}/AGENTS.md`;

const UPSTREAM_REPO = 'https://github.com/Mereithhh/van-blog';
const UPSTREAM_SITE = 'https://vanblog.mereith.com';
const UPSTREAM_CHANGELOG = `${UPSTREAM_SITE}/changelog.html`;
const UPSTREAM_GROUP = 'https://jq.qq.com/?_wv=1027&k=5NRyK2Sw';
const UPSTREAM_SPONSOR = `${UPSTREAM_REPO}#%E6%89%93%E8%B5%8F`;

/** 本分支相对上游的主要增强（只写一句话能说清的，细节在 README 与 CHANGELOG） */
const FORK_HIGHLIGHTS = [
  '内置评论系统（可替代外挂 Waline，支持从 Waline 导入）',
  '补齐 6 种 Markdown 语法，编辑器与前台用同一套插件',
  '整站备份 / 恢复，单篇导出 .md 与带图 .mdz',
  '图片管线：自动缩放、缩略图、隐写水印、原地替换',
  '拼音文章别名，旧链接不失效',
  'Apple 风格前台皮肤（可一键切回默认）',
  'SEO：canonical 与 301、JSON-LD、sitemap lastmod、动态 robots.txt',
  '前后台性能优化，三轮 bug 与安全加固',
  '一键安装脚本改为构建本分支源码（上游脚本装的是官方镜像）',
];

const linkStyle = { whiteSpace: 'nowrap' as const };

export default function (props) {
  const { initialState } = useModel('@@initialState');
  const version = useMemo(() => {
    let v = initialState?.version || '获取中';
    return v;
  }, [initialState, history]);

  return (
    <PageContainer title={null} extra={null} header={{ title: null, extra: null, ghost: true }}>
      <Spin spinning={version == '获取中'}>
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
                <Tag color="cyan">{version}</Tag>
              </div>
              <div style={{ marginBottom: 4 }}>
                {/* 明确标出来：这不是上游原版 */}
                <Tag color="gold">增强修改版</Tag>
              </div>
            </div>
            <p align="center">一款简洁实用优雅的高性能个人博客系统</p>

            <Typography.Paragraph
              type="secondary"
              style={{ maxWidth: 660, textAlign: 'center', marginBottom: 4 }}
            >
              当前后台运行的是{' '}
              <a target="_blank" rel="noreferrer" href={FORK_REPO} style={linkStyle}>
                CKboss/vanblog
              </a>{' '}
              的 <Tag style={{ marginInlineEnd: 0 }}>{FORK_BRANCH}</Tag> 分支，
              在原作者的 VanBlog 之上做了增强与加固，遵循上游的 GPL v3 许可。
              遇到问题请在<b>本分支</b>提 Issue —— 上游仓库不认识这里的改动。
            </Typography.Paragraph>

            <div style={{ maxWidth: 700, margin: '4px 0 12px', textAlign: 'center' }}>
              {FORK_HIGHLIGHTS.map((item) => (
                <Tag key={item} style={{ marginBottom: 6 }}>
                  {item}
                </Tag>
              ))}
            </div>

            <Space wrap style={{ justifyContent: 'center' }}>
              <a target="_blank" rel="noreferrer" href={FORK_REPO} style={linkStyle}>
                Github（本分支）
              </a>
              <a target="_blank" rel="noreferrer" href={FORK_COMMITS} style={linkStyle}>
                提交历史
              </a>
              <a target="_blank" rel="noreferrer" href={FORK_CHANGELOG} style={linkStyle}>
                更新日志
              </a>
              <a target="_blank" rel="noreferrer" href={FORK_README} style={linkStyle}>
                改动总览
              </a>
              <a target="_blank" rel="noreferrer" href={FORK_DOCS} style={linkStyle}>
                功能文档
              </a>
              <a target="_blank" rel="noreferrer" href={FORK_RUNBOOK} style={linkStyle}>
                开发手册
              </a>
              <a target="_blank" rel="noreferrer" href="/swagger" style={linkStyle}>
                API文档
              </a>
            </Space>
            <Space style={{ marginTop: 8 }} wrap>
              <a target="_blank" rel="noreferrer" href={FORK_ISSUES} style={linkStyle}>
                提交BUG / 建议
              </a>
            </Space>

            <Divider style={{ maxWidth: 520, margin: '20px 0 12px' }} plain>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                原始项目
              </Typography.Text>
            </Divider>

            <Typography.Paragraph
              type="secondary"
              style={{ maxWidth: 660, textAlign: 'center', marginBottom: 8, fontSize: 12 }}
            >
              本分支的全部工作都建立在原作者{' '}
              <a target="_blank" rel="noreferrer" href={UPSTREAM_REPO} style={linkStyle}>
                @Mereithhh
              </a>{' '}
              的 VanBlog 之上，感谢原作者。下面是上游项目的入口 —— 注意上游文档与更新日志
              描述的是**官方镜像**的行为，与本分支不完全一致。
            </Typography.Paragraph>

            <Space wrap style={{ justifyContent: 'center' }}>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_REPO} style={linkStyle}>
                上游 Github
              </a>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_SITE} style={linkStyle}>
                官方文档站
              </a>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_CHANGELOG} style={linkStyle}>
                上游更新日志
              </a>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_GROUP} style={linkStyle}>
                官方交流群
              </a>
              <a target="_blank" rel="noreferrer" href={UPSTREAM_SPONSOR} style={linkStyle}>
                打赏原作者
              </a>
            </Space>
          </div>
        </ProCard>
      </Spin>
    </PageContainer>
  );
}
