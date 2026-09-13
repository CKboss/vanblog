#!/usr/bin/env bash
# 文档死链检查。
#
# vuepress 构建**不会**报相对路径写错（`./init.md` 打错成 `./initt.md` 照样构建成功，
# 用户点进去才是 404），所以这里自己查一遍：
#   1. 相对链接指向的 .md / .html 文件存在
#   2. 带 #锚点 的链接，目标文件里真的有那个标题（宽松匹配，避开各版本 slugify 规则差异）
#   3. `<!-- @include: ./xxx.snippet.md -->` 引用的片段存在
#   4. 站内图片 `/img/...` 在 docs/.vuepress/public 下存在
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$(command -v python3 || command -v python)"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

echo "== 文档死链检查 =="

if [[ -z "${PY}" ]]; then
  echo "NOTE: 没有 python，跳过"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

OUT="$("${PY}" - "${ROOT}" <<'PYLINKS'
import os, re, subprocess, sys, unicodedata

root = sys.argv[1]
docs = os.path.join(root, "docs")
public = os.path.join(docs, ".vuepress", "public")

files = subprocess.run(["git", "ls-files", "docs/**/*.md", "docs/*.md", "README.md", "CHANGELOG.md", "AGENTS.md"],
                       capture_output=True, text=True, cwd=root).stdout.split()
files = [f for f in files if os.path.isfile(os.path.join(root, f))]

fence = re.compile(r"^\s*(```|~~~)")
link_re = re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
include_re = re.compile(r"<!--\s*@include:\s*([^>]+?)\s*-->")
img_re = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")
heading_re = re.compile(r"^#{1,6}\s+(.*?)\s*$")


def norm(text):
    """把标题/锚点都压成"只留字母数字与 CJK"的形式再比，避开 slugify 规则差异。"""
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"`([^`]*)`", r"\1", text)          # 行内代码
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # 链接文字
    text = re.sub(r"<[^>]+>", "", text)               # HTML 标签
    keep = []
    for ch in text:
        if ch.isalnum():
            keep.append(ch)
    return "".join(keep)


_heading_cache = {}


def headings_of(path, depth=0):
    """目标文件里所有标题的规范化形式。

    ⚠️ 必须把 `<!-- @include: ./x.snippet.md -->` 引进来的片段也算进去：
    get-started.md 的一半标题（包括「调整 nginx 缓存」）都在 snippet 里，
    不算的话别处链过去的锚点会被误判成死链。
    """
    if path in _heading_cache:
        return _heading_cache[path]
    out = set()
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError:
        _heading_cache[path] = out
        return out
    in_code = False
    for line in lines:
        if fence.match(line):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = heading_re.match(line)
        if m:
            out.add(norm(m.group(1)))
        if depth < 3:
            for inc in include_re.findall(line):
                inc = inc.strip()
                if inc.startswith("@/"):
                    inc_path = os.path.normpath(os.path.join(docs, inc[2:]))
                else:
                    inc_path = os.path.normpath(os.path.join(os.path.dirname(path), inc))
                if os.path.isfile(inc_path):
                    out |= headings_of(inc_path, depth + 1)
    _heading_cache[path] = out
    return out


def resolve(base_file, target):
    """把文档里的相对/绝对路径解析成仓库内文件路径；解析不了返回 None。"""
    # 仓库根的 README/CHANGELOG/AGENTS 是 GitHub 渲染的，不是文档站页面：
    # 它们里面的 `/img/x.png` 指仓库根的 img/，而不是 docs/.vuepress/public/img/
    root_md = base_file in ("README.md", "CHANGELOG.md", "AGENTS.md")
    if target.startswith("/") and root_md:
        return os.path.join(root, target.lstrip("/"))
    if target.startswith("/"):
        # 站点绝对路径：/guide/init.html -> docs/guide/init.md，/ -> docs/README.md
        rel = target.lstrip("/")
        if rel in ("", "index.html"):
            return os.path.join(docs, "README.md")
        cand = os.path.join(docs, rel)
        if cand.endswith(".html"):
            cand = cand[: -len(".html")] + ".md"
        if os.path.isdir(cand):
            cand = os.path.join(cand, "README.md")
        return cand
    if target.startswith("@/"):
        # vuepress 的 @ 别名 = docs 根目录
        return os.path.normpath(os.path.join(docs, target[2:]))
    base_dir = os.path.dirname(base_file)
    cand = os.path.normpath(os.path.join(base_dir, target))
    if cand.endswith(".html"):
        cand = cand[: -len(".html")] + ".md"
    return os.path.join(root, cand)


bad_links, bad_anchors, bad_includes, bad_images, checked = [], [], [], [], 0
for f in files:
    abs_f = os.path.join(root, f)
    try:
        lines = open(abs_f, encoding="utf-8").read().split("\n")
    except OSError:
        continue
    in_code = False
    for n, line in enumerate(lines, 1):
        if fence.match(line):
            in_code = not in_code
            continue
        if in_code:
            continue
        # 去掉行内代码，避免把示例里的链接当成真链接
        scan = re.sub(r"`[^`]*`", "", line)

        for m in include_re.finditer(scan):
            inc = m.group(1).strip()
            if inc.startswith("@/"):
                p = os.path.normpath(os.path.join(docs, inc[2:]))
            else:
                p = os.path.normpath(os.path.join(os.path.dirname(abs_f), inc))
            if not os.path.isfile(p):
                bad_includes.append("%s:%d @include %s" % (f, n, inc))

        for m in img_re.finditer(scan):
            src = m.group(1)
            if src.startswith(("http://", "https://", "data:")):
                continue
            if src.startswith("/"):
                base = root if f in ("README.md", "CHANGELOG.md", "AGENTS.md") else public
                p = os.path.join(base, src.lstrip("/"))
                if not os.path.isfile(p):
                    bad_images.append("%s:%d %s" % (f, n, src))
            elif not src.startswith(("/", "http")) and f in ("README.md", "CHANGELOG.md", "AGENTS.md"):
                if not os.path.isfile(os.path.join(root, src)):
                    bad_images.append("%s:%d %s" % (f, n, src))

        for m in link_re.finditer(scan):
            target = m.group(1)
            if target.startswith(("http://", "https://", "mailto:", "tel:", "data:")):
                continue
            if target.startswith("#"):
                # 同页锚点
                if norm(target[1:]) not in headings_of(abs_f):
                    bad_anchors.append("%s:%d %s (同页)" % (f, n, target))
                continue
            path_part, _, anchor = target.partition("#")
            if not path_part:
                continue
            resolved = resolve(f, path_part)
            checked += 1
            if resolved is None or not os.path.exists(resolved):
                bad_links.append("%s:%d %s" % (f, n, target))
                continue
            if anchor and os.path.isfile(resolved):
                if norm(anchor) not in headings_of(resolved):
                    bad_anchors.append("%s:%d %s" % (f, n, target))

print("checked=%d" % checked)
for label, items in (("LINK", bad_links), ("ANCHOR", bad_anchors),
                     ("INCLUDE", bad_includes), ("IMAGE", bad_images)):
    for it in items[:40]:
        print("%s %s" % (label, it))
    if len(items) > 40:
        print("%s ... 还有 %d 条" % (label, len(items) - 40))
PYLINKS
)"

checked="$(printf '%s\n' "${OUT}" | sed -n 's/^checked=//p')"
if [[ -n "${checked}" && "${checked}" -gt 50 ]]; then
  pass "扫描了 ${checked} 条站内链接"
else
  fail "只扫到 ${checked:-0} 条站内链接，检查器可能没生效"
fi

for kind in LINK ANCHOR INCLUDE IMAGE; do
  hits="$(printf '%s\n' "${OUT}" | grep -c "^${kind} " || true)"
  case "${kind}" in
    LINK) label="相对链接都指向存在的文件" ;;
    ANCHOR) label="带 #锚点 的链接在目标文件里都有对应标题" ;;
    INCLUDE) label="@include 引用的片段都存在" ;;
    IMAGE) label="站内图片都在 docs/.vuepress/public 下" ;;
  esac
  if [[ "${hits}" == "0" ]]; then
    pass "${label}"
  else
    fail "${label}（${hits} 处有问题）"
    printf '%s\n' "${OUT}" | grep "^${kind} " | head -8 | sed 's/^/      /'
  fi
done

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
