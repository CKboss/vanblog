#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 `CHANGELOG.md` 里取出**某个 tag 对应的那一节**，作为 GitHub Release 的发布说明。

用法：
    python3 scripts/releaseNotes.py <tag> <repo-slug> [--limit N] [--changelog PATH]

行为（与 `.github/workflows/release-fork.yml` 里原来那段内联 python 逐条一致，只是搬进了仓库 ⇒
🔴 **可以在本机被守卫跑起来**，而不是等发版那天才知道它坏没坏）：
  1. 按 `## [xxx]` 切段，取 `sections[tag]`；没有就退回 `sections['Unreleased']`；再没有就打印一句说明
     （workflow 那边会退回"自动生成的提交列表"）。
  2. 把正文里的**相对链接**改写成指向该 tag 的绝对地址（Release 页面上相对链接是死的）。
  3. 🔴 **超长就压缩成摘要**（见下面 LIMIT 那段注释）—— 这是本脚本存在的第二个理由。

🔴 为什么要第 3 条（2026-10-06 发版前实测）：
   当前 `[Unreleased]` 一节有 **126,276 字符 / 241 KB**（47 个批次小节，从 v2026.9.6 之后一路累积）。
   而 GitHub 对 Release 正文有长度上限（业界常引用 **124,000 字符**；本机网络取不到 docs.github.com 核实，
   所以这里取**保守值 100,000**）⇒ 照原样发，创建 Release 那一步很可能直接被 API 拒（422），
   或者就算发出去也是一篇 24 万字节的"发布说明"（读者根本不会看，还会把移动端页面撑爆）。
   👉 所以超限时**不截断成半句话**，而是压成"每个批次一行标题 + 该批第一句要点 + 指向完整 CHANGELOG 的链接"，
   完整内容仍在仓库与文档站里（一个字都不丢）。
"""

import argparse
import re
import sys

# 🔴 保守阈值（字符数，不是字节数）：GitHub 常引用的上限是 124,000 字符，
#    这里留 20% 余量 —— 因为后面还会追加"镜像"小节与摘要脚注。
DEFAULT_LIMIT = 100_000


def split_sections(text):
    """按 `## [xxx]` 切段 → {标题里的 key: 正文}。与原内联实现同一口径。"""
    parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
    sections = {}
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i].strip()] = parts[i + 1].strip()
    return sections


def rewrite_links(body, base):
    """相对链接 → 指向该 tag 的绝对地址（`http(s)`/`#`/`mailto` 原样保留）。"""
    def fix(m):
        target = m.group(1)
        if target.startswith(('http://', 'https://', '#', 'mailto:')):
            return m.group(0)
        return '](' + base + target.lstrip('/') + ')'
    return re.sub(r'\]\(([^)\s]+)\)', fix, body)


def condense(body, limit, changelog_url):
    """
    🔴 把过长的发布说明压成摘要：
      · 保留第一个 `### ` 之前的**引言**（如果有的话）；
      · 每个 `### ` 批次保留**标题** + 该批正文的前若干条要点（`-`/`·`/数字开头的行，最多 6 条、每条 ≤200 字）；
      · 末尾附一条指向完整 CHANGELOG 的链接，并说明"因为长度上限做了摘要"。
    压完仍超限就硬截断，并**明说被截断了多少**（🔴 不许静默截断）。
    """
    head, *rest = re.split(r'(?m)^(?=### )', body)
    out = [head.strip()] if head.strip() else []
    out.append(
        '> 🔴 这一版累积了 **%d** 个批次的改动，全文超过 GitHub Release 正文的长度上限，'
        '所以下面是**每批一段的摘要**；\n> 完整逐条记录（含每批的根因、实测数字与踩过的坑）见 '
        '[CHANGELOG.md](%s)。' % (len(rest), changelog_url)
    )
    for block in rest:
        lines = block.split('\n')
        title = lines[0].strip()
        out.append('')
        out.append(title)
        picked = 0
        for ln in lines[1:]:
            t = ln.strip()
            if not t:
                continue
            # 只要"要点行"（列表项 / 以标记开头的行），跳过表格与代码块内部
            if not re.match(r'^([-·*]|\d+\.|🔴|⚠️|✅|📈|👉)', t):
                continue
            if t.startswith(('|', '```')):
                continue
            out.append(t if len(t) <= 200 else t[:197] + '…')
            picked += 1
            if picked >= 6:
                break
        if picked == 0:
            # 那一批没有列表式要点（例如整段散文）⇒ 取第一段的前 200 字，别让它变成"只有标题"
            prose = ' '.join(x.strip() for x in lines[1:] if x.strip())
            if prose:
                out.append(prose[:197] + ('…' if len(prose) > 200 else ''))
    text = '\n'.join(out).strip() + '\n'
    if len(text) > limit:
        dropped = len(text) - limit
        text = text[:limit].rstrip() + '\n\n……（🔴 还有 %d 字符因 Release 正文长度上限被截断，完整内容见上面的 CHANGELOG 链接）\n' % dropped
    return text


def main(argv=None):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('tag')
    ap.add_argument('repo')
    ap.add_argument('--limit', type=int, default=DEFAULT_LIMIT)
    ap.add_argument('--changelog', default='CHANGELOG.md')
    a = ap.parse_args(argv)

    with open(a.changelog, encoding='utf-8') as f:
        text = f.read()
    sections = split_sections(text)
    body = sections.get(a.tag) or sections.get('Unreleased') or ''
    if not body:
        print('（CHANGELOG 里没有找到 %s 或 Unreleased 一节，下面用自动生成的提交列表）' % a.tag)
        return 0

    base = 'https://github.com/%s/blob/%s/' % (a.repo, a.tag)
    body = rewrite_links(body, base)
    if len(body) > a.limit:
        sys.stderr.write(
            'releaseNotes: %s 一节有 %d 字符，超过阈值 %d ⇒ 压成摘要（完整内容仍在 CHANGELOG.md）\n'
            % (a.tag if sections.get(a.tag) else 'Unreleased', len(body), a.limit)
        )
        body = condense(body, a.limit, base + 'CHANGELOG.md')
    print(body)
    return 0


if __name__ == '__main__':
    sys.exit(main())
