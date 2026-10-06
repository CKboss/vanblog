#!/usr/bin/env bash
# 🔴 镜像发布策略守卫（站长裁定 2026-10-06：`我主动要求你进行publish, 你再publish 镜像. 不用每次commit都要build镜像`）
#
# 这条裁定要变成**可判定的不变量**，否则下一个代理（或下一个我）很容易"顺手"把它改回去：
#   ① **发布镜像只能由 `v*` tag 或人工 `workflow_dispatch` 触发** —— 绝不能挂在分支 push / pull_request 上
#      （那就是"每次 commit 都构建并推送镜像"）；
#   ② **PR 档（每次 push/PR 都跑的那几个 workflow）里不许有真构建**：
#      `docker build` / `podman build` / `build-push-action` / 直接调 `build-image-local.sh` 都不行。
#      ⚠️ 跑它的**静态契约守卫**（`run-guard.sh …/build-image-local.test.sh`，只 grep 脚本）是允许且必要的；
#   ③ **nightly 里那次构建不许推送**（它只是"每天确认镜像还建得出来"，不是发布）。
#
# 为什么值得钉：`publish-ghcr.yml` 一旦被人加上 `branches: [dev/dsh]`，每次提交都会
# 构建 + 推 `ghcr.io/…:latest`（几十分钟的 runner 时间、把 `latest` 变成"任意一次提交的产物"，
# 而 README 明确写着 `latest` = **最近一次发布**）⇒ 那既是浪费，也是**语义污染**。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$(command -v python3 || command -v python)"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

echo "== 镜像发布策略（只有站长主动要求才 publish；不跟着每次 commit 构建）=="

if [[ -z "${PY}" ]]; then
  echo "NOTE: 没有 python，跳过"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi
if ! "${PY}" -c 'import yaml' >/dev/null 2>&1; then
  echo "NOTE: 没有 PyYAML，跳过（ci-paths-coverage.test.sh 也依赖它，那边会红）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

OUT="$("${PY}" - "${ROOT}" <<'PYPOLICY'
import glob, os, re, sys, yaml

root = sys.argv[1]
wf_dir = os.path.join(root, '.github', 'workflows')
files = sorted(glob.glob(os.path.join(wf_dir, '*.yml')))
print('WORKFLOWS=%d' % len(files))

# 真构建的特征（跑"静态契约守卫"不算：那是 run-guard.sh 调 *.test.sh，只 grep 脚本）
BUILD_PAT = re.compile(r'docker\s+build|podman\s+build|build-push-action|bash\s+scripts/build-image-local\.sh|\./scripts/build-image-local\.sh')
GUARD_ONLY = re.compile(r'run-guard\.sh\s+scripts/tests/build-image-local\.test\.sh')
PUSH_PAT = re.compile(r'docker\s+push|podman\s+push|push:\s*true|login-action')

for f in files:
    name = os.path.basename(f)
    try:
        d = yaml.safe_load(open(f, encoding='utf-8'))
    except Exception as e:
        print('PARSE_ERROR=%s:%s' % (name, e))
        continue
    if not isinstance(d, dict):
        continue
    on = d.get(True) if True in d else d.get('on')
    trig = list(on.keys()) if isinstance(on, dict) else ([on] if isinstance(on, str) else [])
    print('TRIG=%s:%s' % (name, ','.join(str(t) for t in trig)))
    if isinstance(on, dict):
        for t, cfg in on.items():
            if isinstance(cfg, dict):
                if cfg.get('branches'):
                    print('BRANCHTRIG=%s:%s:%s' % (name, t, ','.join(cfg['branches'])))
                if cfg.get('tags'):
                    print('TAGTRIG=%s:%s:%s' % (name, t, ','.join(cfg['tags'])))
    jobs = d.get('jobs') or {}
    for jn, job in jobs.items():
        runs = []
        uses = []
        for st in (job.get('steps') or []):
            if isinstance(st, dict):
                if st.get('run'):
                    runs.append(str(st['run']))
                if st.get('uses'):
                    uses.append(str(st['uses']))
        blob = '\n'.join(runs)
        usesblob = '\n'.join(uses)
        # 真构建 = 命令行里有构建命令，或用了 build-push-action
        real_build = bool(BUILD_PAT.search(blob)) or 'build-push-action' in usesblob
        if real_build:
            # 只跑静态契约守卫的不算（它形如 run-guard.sh …/build-image-local.test.sh，且不含构建命令）
            if GUARD_ONLY.search(blob) and not re.search(r'docker\s+build|podman\s+build|build-push-action', blob):
                real_build = False
        if real_build:
            print('BUILDS=%s:%s' % (name, jn))
            if PUSH_PAT.search(blob) or 'login-action' in usesblob or 'build-push-action' in usesblob:
                print('PUSHES=%s:%s' % (name, jn))
PYPOLICY
)"

if [[ -z "${OUT}" ]]; then
  fail "分析器没有输出（workflow 目录读不到？PyYAML 坏了？）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi

NWF="$(printf '%s\n' "${OUT}" | sed -n 's/^WORKFLOWS=//p')"
if [[ "${NWF:-0}" -ge 5 ]]; then
  pass "反空转：解析到 ${NWF} 个 workflow（下界 5）"
else
  fail "只解析到 ${NWF:-0} 个 workflow（下界 5）⇒ 解析口径可能坏了，下面的结论都不可信"
fi
if printf '%s\n' "${OUT}" | grep -q '^PARSE_ERROR='; then
  fail "有 workflow 解析失败：$(printf '%s\n' "${OUT}" | grep '^PARSE_ERROR=' | head -2 | tr '\n' ' ')"
else
  pass "所有 workflow 都能被 YAML 解析（解析不了就没法判触发条件）"
fi

# ── ① 发布镜像的 workflow 只能由 tag / 人工触发 ─────────────────────────────
# 🔴 取的是 `PUSHES=<workflow>:<job>` 里的 **workflow 文件名**（第一版用 `cut -d: -f2` 取到了 **job 名**
#    `build-and-push` ⇒ 后面拿它去匹配 `TAGTRIG=…` 全部落空，报出"不由 tag 触发"的**假红**）。
PUB="$(printf '%s\n' "${OUT}" | sed -n 's/^PUSHES=\([^:]*\):.*/\1/p' | sort -u)"
if [[ -z "${PUB}" ]]; then
  fail "找不到任何「会推送镜像」的 workflow ⇒ 尺子没抓到 publish-ghcr（口径坏了，不是「没有推送」）"
else
  pass "尺子抓到了会推送镜像的 workflow：$(printf '%s' "${PUB}" | tr '\n' ' ')"
fi
for w in ${PUB}; do
  f="${ROOT}/.github/workflows/${w}"
  # 该 workflow 不许有"分支触发"
  if printf '%s\n' "${OUT}" | grep -q "^BRANCHTRIG=${w}:"; then
    fail "🔴 ${w} 会推送镜像，却挂在**分支**触发上：$(printf '%s\n' "${OUT}" | grep "^BRANCHTRIG=${w}:" | cut -d: -f3- | tr '\n' ' ') ⇒ 那就是「每次 commit 都 publish」（站长裁定不许）"
  else
    pass "${w}（推送镜像）没有分支触发 ⇒ 不会跟着每次 commit 发布"
  fi
  if printf '%s\n' "${OUT}" | grep -q "^TAGTRIG=${w}:"; then
    TAGS="$(printf '%s\n' "${OUT}" | grep "^TAGTRIG=${w}:" | cut -d: -f3- | tr '\n' ' ')"
    pass "${w} 由 tag 触发（${TAGS}）—— 发布是**显式动作**（打 tag）"
  else
    fail "${w} 会推送镜像却不由 tag 触发 ⇒ 发布不再是显式动作"
  fi
done

# ── ② PR 档（每次 push/PR 都跑）里不许有真构建 ──────────────────────────────
for w in server-test.yml admin-e2e.yml docs-test.yml; do
  [[ -f "${ROOT}/.github/workflows/${w}" ]] || { fail "PR 档 workflow 不见了：${w}"; continue; }
  if printf '%s\n' "${OUT}" | grep -q "^BRANCHTRIG=${w}:"; then
    # 它确实是每次 push 都跑的 ⇒ 不许真构建
    if printf '%s\n' "${OUT}" | grep -q "^BUILDS=${w}:"; then
      fail "🔴 ${w} 每次 push 都跑，却包含**真镜像构建**：$(printf '%s\n' "${OUT}" | grep "^BUILDS=${w}:" | sed 's/^[^:]*://' | tr '\n' ' ') ⇒ 违反「不用每次 commit 都 build 镜像」（跑静态契约守卫是允许的，真构建不允许）"
    else
      pass "${w}（每次 push 都跑）里没有真镜像构建 —— 只跑静态契约守卫"
    fi
  else
    pass "${w} 不是分支触发（不需要检查构建）"
  fi
done

# ── ③ nightly 的构建不许推送（它只是"每天确认还建得出来"）────────────────────
if [[ -f "${ROOT}/.github/workflows/nightly.yml" ]]; then
  if printf '%s\n' "${OUT}" | grep -q '^BUILDS=nightly.yml:'; then
    pass "nightly 里确实有一次构建（每天确认镜像还建得出来 —— 这不是「每次 commit」，是定时）"
    if printf '%s\n' "${OUT}" | grep -q '^PUSHES=nightly.yml:'; then
      fail "🔴 nightly 的构建**推送**了镜像 ⇒ 定时任务变成了发布通道（未经站长要求就 publish）"
    else
      pass "nightly 的构建**不推送**（只构建 + 冒烟，产物随 runner 销毁）"
    fi
  else
    fail "nightly 里没有构建 job 了？（尺子口径可能坏了：它应当能识别 build-image-local.sh 的调用）"
  fi
  if printf '%s\n' "${OUT}" | grep -q '^BRANCHTRIG=nightly.yml:'; then
    fail "🔴 nightly 挂在分支触发上 ⇒ 每次 commit 都会跑一次完整构建（站长裁定不许）"
  else
    pass "nightly 只由 schedule / workflow_dispatch 触发（不跟着 commit 跑）"
  fi
fi

# ── ④ 尺子有效性反证：合成一个"分支触发 + 构建 + 推送"的 workflow，必须被点名 ──
SB="$(mktemp -d)"
mkdir -p "${SB}/.github/workflows"
cat > "${SB}/.github/workflows/zz-bad.yml" <<'BADWF'
name: zz-bad
on:
  push:
    branches: ['dev/dsh']
jobs:
  leak:
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t x . && docker push x
BADWF
# 再放一个"只跑静态契约守卫"的合法样本，确认它**不会**被误判成真构建
cat > "${SB}/.github/workflows/zz-ok.yml" <<'OKWF'
name: zz-ok
on:
  push:
    branches: ['dev/dsh']
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/tests/run-guard.sh scripts/tests/build-image-local.test.sh
OKWF
SYN="$("${PY}" - "${SB}" <<'PYSYN'
import glob, os, re, sys, yaml
root = sys.argv[1]
BUILD_PAT = re.compile(r'docker\s+build|podman\s+build|build-push-action|bash\s+scripts/build-image-local\.sh|\./scripts/build-image-local\.sh')
GUARD_ONLY = re.compile(r'run-guard\.sh\s+scripts/tests/build-image-local\.test\.sh')
PUSH_PAT = re.compile(r'docker\s+push|podman\s+push|push:\s*true|login-action')
for f in sorted(glob.glob(os.path.join(root, '.github', 'workflows', '*.yml'))):
    name = os.path.basename(f)
    d = yaml.safe_load(open(f, encoding='utf-8'))
    on = d.get(True) if True in d else d.get('on')
    if isinstance(on, dict):
        for t, cfg in on.items():
            if isinstance(cfg, dict) and cfg.get('branches'):
                print('BRANCHTRIG=%s:%s:%s' % (name, t, ','.join(cfg['branches'])))
    for jn, job in (d.get('jobs') or {}).items():
        blob = '\n'.join(str(st.get('run') or '') for st in (job.get('steps') or []) if isinstance(st, dict))
        usesblob = '\n'.join(str(st.get('uses') or '') for st in (job.get('steps') or []) if isinstance(st, dict))
        real = bool(BUILD_PAT.search(blob)) or 'build-push-action' in usesblob
        if real and GUARD_ONLY.search(blob) and not re.search(r'docker\s+build|podman\s+build|build-push-action', blob):
            real = False
        if real:
            print('BUILDS=%s:%s' % (name, jn))
            if PUSH_PAT.search(blob) or 'login-action' in usesblob or 'build-push-action' in usesblob:
                print('PUSHES=%s:%s' % (name, jn))
PYSYN
)"
rm -rf "${SB}"
if printf '%s\n' "${SYN}" | grep -q '^PUSHES=zz-bad.yml:' && printf '%s\n' "${SYN}" | grep -q '^BRANCHTRIG=zz-bad.yml:'; then
  pass "尺子有效性 A：合成的「分支触发 + 构建 + 推送」workflow 会被同时点名（⇒ 上面①②不是空转）"
else
  fail "尺子失效：合成的违规 workflow 没被点名（$(printf '%s' "${SYN}" | tr '\n' ' ')）⇒ 上面①②的绿是假的"
fi
if printf '%s\n' "${SYN}" | grep -q '^BUILDS=zz-ok.yml:'; then
  fail "尺子过严：只跑**静态契约守卫**的 workflow 被误判成真构建 ⇒ PR 档会永远红，人就会去改判据"
else
  pass "尺子有效性 B：只跑静态契约守卫（run-guard.sh …/build-image-local.test.sh）**不算**真构建"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]]
