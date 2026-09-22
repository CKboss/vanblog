#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 🔴 CI 触发过滤器（`paths:`）覆盖度的守卫。
#
# 它钉住的不变量是：**每个 workflow 的 `paths:` 必须覆盖"会让它跑的守卫变红"的那些文件**。
#
# 🔴 为什么需要它（缺口在两轮里出现了三次，全是同一个形状）：
#    ① `docs-test.yml` 的 paths 不含 `CHANGELOG.md`，而它跑 `changelog-mirror-sync`
#       ⇒ "改了根 CHANGELOG 却忘了重新生成镜像"这个正是该守卫要抓的情形，根本不触发 workflow；
#    ② `server-test.yml` 的 pull_request 过滤器一个 workflow 都没列
#       ⇒ 改别的 workflow 摘掉守卫引用时，那条"每个守卫都被接入 CI"的常驻断言永远没机会红；
#    ③ 🔴 最大的一处：`server-test.yml` 的 paths 不含 `docs/**`，而 guards-core 里有 **10 个**
#       vanblog-* 守卫会读 docs/（多数是断言"文档不许教破坏性命令"或"文档片段与 compose 模板一致"），
#       而 docs-test.yml 不跑它们 ⇒ 改文档不会触发任何跑这些守卫的 workflow。
#       那个缺口此前还被一句注释正当化过（"只改文档时不用跑测试"），而那句前提是错的。
#    另：`CaddyfileTemplate` / `CaddyfileTemplateLocal` 是入库文件、被
#    `reverse-proxy-host-header.test.sh` 读取，此前不在任何 paths 里。
#
# 🔴 判定口径（刻意保守，避免变成天天误报的东西）：
#    - 一条依赖算"被覆盖"，只要**跑同一个守卫的任一 workflow**的 paths 匹配它
#      （同一个守卫常被多个 workflow 跑；只要有一个会触发，守卫就会跑）；
#    - 依赖只统计**入库文件**（`git ls-files`）⇒ git-ignored 的 `.tools/`、`vanblog_dev/`
#      自动被排除，不需要白名单（它们在 CI 里永远不会是"改动文件"）；
#    - 用 `paths-ignore:` 的 workflow 只报告不改判（那是相反语义，收窄它会反转行为）。
#
# ⚠️ 与 `server-test.yml` 里那条内联断言「Every guard script must be wired into some workflow」的分工：
#    那条管**"守卫有没有被接进 CI"**（以及反方向"引用的守卫是否存在"）；
#    本守卫管**"接进来了之后，改哪些文件会触发它"**。两件事不同，不重叠。
# ---------------------------------------------------------------------------
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

command -v python3 >/dev/null 2>&1 || { echo "NOTE: 没有 python3，本守卫无法解析 YAML，如实跳过（不假装通过）"; echo "passed=0 failed=0"; exit 0; }

# 分析器：给定一个"仓库根"，输出每行 `workflow<TAB>trigger<TAB>guard<TAB>dep<TAB>COVERED|MISSING`
# ⚠️ 抽成函数以便同一份逻辑既能跑真实仓库、也能跑合成沙箱（尺子有效性反证）。
analyze() {
  python3 - "$1" <<'PYEOF'
import sys, os, re, glob, subprocess, fnmatch
import yaml

root = sys.argv[1]

def tracked_prefixes():
    """🔴 返回 None 表示"无法判定" ⇒ 调用方按"全部算入库"处理。
    这一条踩过两个坑：
    ① 沙箱里没有 .git，`git ls-files` **不抛异常**、只是返回空 ⇒ 若把空集合当成
       "没有任何入库文件"，所有依赖都会被过滤掉，于是"0 缺口"变成一个**空的绿**；
    ② 反过来，若因此改成"全部算入库"，沙箱又会把 git-ignored 的 `.tools/`、`vanblog_dev/`
       当成依赖 ⇒ 产生一堆假缺口、基线仍然不忠实。
    ⇒ 所以沙箱通过 PATHS_COV_TRACKED_FILE 复用真实仓库的入库清单，两个坑都不踩。"""
    tf = os.environ.get('PATHS_COV_TRACKED_FILE')
    if tf and os.path.isfile(tf):
        files = [x.strip() for x in open(tf, encoding='utf-8') if x.strip()]
        return set(files) if files else None
    try:
        out = subprocess.run(['git','ls-files'], cwd=root, capture_output=True, text=True, timeout=120)
        if out.returncode != 0:
            return None
        files = [x for x in out.stdout.splitlines() if x.strip()]
        return set(files) if files else None
    except Exception:
        return None

TRACKED = tracked_prefixes()

def is_tracked(dep):
    """依赖是否指向入库文件（git-ignored 的目录永远不会是 CI 的改动文件）"""
    if TRACKED is None:
        return True
    base = dep.split('/')[0]
    if dep.endswith('/**') or dep.endswith('/*'):
        base = dep.rstrip('/*').rstrip('/')
    for f in TRACKED:
        if f == dep or f.startswith(base + '/') or f == base:
            return True
    return False

def guard_deps(gpath):
    src = open(gpath, encoding='utf-8', errors='replace').read()
    # 剥掉整行注释：注释里提到的路径不算"读取"
    body = '\n'.join(l for l in src.splitlines() if not re.match(r'^\s*#', l))
    deps = set()
    for m in re.finditer(r'\$\{?ROOT\}?/([A-Za-z0-9._/*-]+)', body):
        d = m.group(1).rstrip('/')
        top = d.split('/')[0]
        if not top or top.startswith('-'):
            continue
        base = os.path.basename(d)
        if '*' in d:
            deps.add(d)                      # 本来就是 glob，原样保留
        elif '.' in base:
            deps.add(d)                      # 🔴 具体文件：保留完整路径，不要塌成 top/**
        elif '/' in d:
            deps.add(d + '/**')              # 具体目录
        else:
            deps.add(d)                      # 顶层名字（可能是目录，match() 会按前缀匹配）
    return sorted(x for x in deps if is_tracked(x))

def match(dep, pat):
    if pat.endswith('/**'):
        pre = pat[:-3]
        return dep == pre or dep.startswith(pre + '/') or dep.split('/')[0] == pre
    if pat.endswith('/*'):
        pre = pat[:-2]
        return dep.split('/')[0] == pre
    return dep == pat or dep.split('/')[0] == pat

wf = {}
for f in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))):
    d = yaml.safe_load(open(f, encoding='utf-8'))
    if not isinstance(d, dict):
        continue
    guards = set()
    for jn, job in (d.get('jobs') or {}).items():
        for st in (job.get('steps') or []):
            run = st.get('run') or ''
            for g in re.findall(r'scripts/tests/([A-Za-z0-9._-]+\.sh)', run):
                if g != 'run-guard.sh':
                    guards.add(g)
    on = d.get(True) if True in d else d.get('on')
    trig = {}
    if isinstance(on, dict):
        for t, cfg in on.items():
            trig[t] = cfg if isinstance(cfg, dict) else {}
    wf[os.path.basename(f)] = {'guards': guards, 'trig': trig}

# 每个守卫被哪些 workflow 跑（用于"任一 workflow 触发即算覆盖"的并集口径）
runners = {}
for b, w in wf.items():
    for g in w['guards']:
        runners.setdefault(g, set()).add(b)

STATS = {'wf': len(wf), 'guards': len(runners), 'deps': 0, 'covered': 0, 'missing': 0,
         'ignore': [], 'notrig': [], 'asym': []}

for g in sorted(runners):
    gp = os.path.join(root, 'scripts/tests', g)
    if not os.path.exists(gp):
        continue
    for dep in guard_deps(gp):
        STATS['deps'] += 1
        for trig in ('push', 'pull_request'):
            # 并集：跑这个守卫的所有 workflow 里，任一在该触发器下覆盖了这个依赖 ⇒ 覆盖
            cov = False
            anyfilt = False
            for b in sorted(runners[g]):
                cfg = wf[b]['trig'].get(trig)
                if cfg is None:
                    continue
                if 'paths' in cfg and cfg['paths']:
                    anyfilt = True
                    if any(match(dep, p) for p in cfg['paths']):
                        cov = True
                elif 'paths-ignore' in cfg and cfg['paths-ignore']:
                    anyfilt = True
                    if not any(match(dep, p) for p in cfg['paths-ignore']):
                        cov = True
            if not anyfilt:
                STATS['notrig'].append(f'{g}/{trig}')
                continue
            if cov:
                STATS['covered'] += 1
            else:
                STATS['missing'] += 1
                for b in sorted(runners[g]):
                    print(f'{b}\t{trig}\t{g}\t{dep}\tMISSING')

# push 与 pull_request 的 paths 必须同口径（否则 PR 上验不到、合并后才第一次红）
for b, w in sorted(wf.items()):
    p = (w['trig'].get('push') or {}).get('paths')
    q = (w['trig'].get('pull_request') or {}).get('paths')
    if p and q and sorted(p) != sorted(q):
        STATS['asym'].append(b)
    for t, cfg in w['trig'].items():
        if isinstance(cfg, dict) and cfg.get('paths-ignore'):
            STATS['ignore'].append(f'{b}/{t}')

print(f"__STATS__\t{STATS['wf']}\t{STATS['guards']}\t{STATS['deps']}\t{STATS['covered']}\t{STATS['missing']}\t{';'.join(STATS['ignore'])}\t{';'.join(sorted(set(STATS['asym'])))}")
PYEOF
}

T="$(mktemp -d "${TMPDIR:-/tmp}/ci-paths-XXXXXX")"
trap 'rm -rf "${T}"' EXIT INT TERM

# ---------------------------------------------------------------------------
# 1) 真实仓库：不许有任何 MISSING
# ---------------------------------------------------------------------------
analyze "${ROOT}" >"${T}/real.txt" 2>"${T}/real.err"
rc=$?
# 🔴 导出真实仓库的入库文件清单，供沙箱复用（沙箱没有 .git，见 analyze 里 tracked_prefixes 的注释）
( cd "${ROOT}" && git ls-files ) >"${T}/tracked.txt" 2>/dev/null || true
export PATHS_COV_TRACKED_FILE="${T}/tracked.txt"
if [[ -s "${T}/tracked.txt" ]]; then
  pass "取到了真实仓库的入库文件清单（$(wc -l <"${T}/tracked.txt" | tr -d ' ') 条），沙箱将复用它"
else
  fail "🔴 没能取到入库文件清单 ⇒ 沙箱会退化成"全部算入库"、把 git-ignored 的路径当成依赖而产生假缺口"
fi
assert_eq "${rc}" "0" "分析器在真实仓库上正常退出"
MISS_LINES="$(grep -c 'MISSING' "${T}/real.txt" 2>/dev/null || true)"
if [[ "${MISS_LINES}" -gt 0 ]]; then
  echo "--- 未覆盖的 (workflow / trigger / guard / dep) ---"
  grep 'MISSING' "${T}/real.txt" | head -20
  fail "🔴 有 ${MISS_LINES} 处「守卫读的文件不在跑它的那个 workflow 的 paths 里」⇒ 改那些文件不会触发守卫（修法：把该路径补进对应 workflow 的 push **与** pull_request 两处 paths；⚠️ GitHub 用改动前的 workflow 判定 paths，所以补完要等下一次触发才生效）"
else
  pass "所有守卫读取的入库文件都被「跑它的某个 workflow」的 paths 覆盖"
fi

STATS="$(grep '^__STATS__' "${T}/real.txt" || true)"
if [[ -z "${STATS}" ]]; then
  fail "反空转：分析器没有输出统计行（说明它根本没跑起来 ⇒ 上面那条「无缺口」是空的绿）"
else
  NWF="$(printf '%s' "${STATS}" | cut -f2)"
  NGUARD="$(printf '%s' "${STATS}" | cut -f3)"
  NDEP="$(printf '%s' "${STATS}" | cut -f4)"
  NCOV="$(printf '%s' "${STATS}" | cut -f5)"
  NMISS="$(printf '%s' "${STATS}" | cut -f6)"
  IGN="$(printf '%s' "${STATS}" | cut -f7)"
  ASYM="$(printf '%s' "${STATS}" | cut -f8)"
  # 🔴 反空转：枚举到 0 个 workflow / 0 个守卫 ⇒ "无缺口"恒真（本仓库已因此写出过恒真守卫）
  if [[ "${NWF}" -ge 6 ]]; then pass "反空转：解析到 ${NWF} 个 workflow（下界 6）"; else fail "反空转：只解析到 ${NWF} 个 workflow（下界 6）⇒ 枚举坏了，不是「没有缺口」"; fi
  if [[ "${NGUARD}" -ge 25 ]]; then pass "反空转：分析到 ${NGUARD} 个被 CI 跑的守卫（下界 25）"; else fail "反空转：只分析到 ${NGUARD} 个守卫（下界 25）⇒ 枚举坏了"; fi
  if [[ "${NDEP}" -ge 40 ]]; then pass "反空转：抽取到 ${NDEP} 条守卫依赖（下界 40），其中 ${NCOV} 条被覆盖"; else fail "反空转：只抽取到 ${NDEP} 条依赖（下界 40）⇒ 依赖解析坏了（🔴 解析不到 ≠ 不存在）"; fi
  assert_eq "${NMISS}" "0" "统计行的缺口计数与逐行判定一致（都应为 0）"
  if [[ -z "${IGN}" ]]; then pass "没有 workflow 用 paths-ignore（若有，本守卫会按相反语义判定，需要人工复核）"; else echo "NOTE: 用 paths-ignore 的触发器：${IGN}"; pass "paths-ignore 的触发器已按相反语义处理：${IGN}"; fi
  if [[ -z "${ASYM}" ]]; then pass "每个 workflow 的 push 与 pull_request 的 paths 同口径（否则 PR 上验不到、合并后才第一次红）"; else fail "🔴 push 与 pull_request 的 paths 不一致：${ASYM}（两个触发器必须同口径）"; fi
fi

# ---------------------------------------------------------------------------
# 2) 尺子有效性反证（合成沙箱，🔴 不碰真实 workflow 文件）
#    ⚠️ 先跑沙箱基线证明它是忠实的 —— 上一轮有代理的沙箱只建了 *.test.sh，
#       结果反方向对账把 run-guard.sh 报成悬空、基线直接红，差点被误读成"守卫有 bug"。
# ---------------------------------------------------------------------------
SB="${T}/sandbox"
mkdir -p "${SB}/.github/workflows" "${SB}/scripts/tests"
cp "${ROOT}"/.github/workflows/*.yml "${SB}/.github/workflows/" 2>/dev/null || true
cp "${ROOT}"/scripts/tests/*.sh "${SB}/scripts/tests/" 2>/dev/null || true
# 沙箱没有 .git ⇒ git ls-files 会失败；分析器在 TRACKED 为 None 时按"全部算入库"处理，
# 这正是沙箱需要的（否则会因为没有 git 而把依赖全过滤掉 ⇒ 假绿）。
analyze "${SB}" >"${T}/sb-base.txt" 2>/dev/null
BASE="$(grep '^__STATS__' "${T}/sb-base.txt" || true)"
BASE_MISS="$(grep -c 'MISSING' "${T}/sb-base.txt" 2>/dev/null || true)"
if [[ -z "${BASE}" ]]; then
  fail "沙箱基线没有统计行 ⇒ 沙箱不忠实，下面两条反证无效"
else
  B_WF="$(printf '%s' "${BASE}" | cut -f2)"; B_GUARD="$(printf '%s' "${BASE}" | cut -f3)"; B_DEP="$(printf '%s' "${BASE}" | cut -f4)"
  # 🔴 沙箱基线必须"真的分析出了东西"，否则 0 缺口是空的绿（这正是第一版踩的坑：
  #    沙箱没有 .git ⇒ git ls-files 返回空 ⇒ 依赖被全过滤 ⇒ 基线假通过、两条反证随之失效）
  if [[ "${B_WF}" -ge 6 && "${B_GUARD}" -ge 25 && "${B_DEP}" -ge 40 ]]; then
    pass "沙箱基线忠实：解析到 ${B_WF} 个 workflow / ${B_GUARD} 个守卫 / ${B_DEP} 条依赖（与真实仓库同量级）"
  else
    fail "🔴 沙箱基线不忠实：只解析到 ${B_WF} workflow / ${B_GUARD} 守卫 / ${B_DEP} 依赖 ⇒ 下面的反证会假通过"
  fi
  assert_eq "${BASE_MISS}" "0" "🔴 沙箱基线：未改动的副本应当 0 缺口（否则反证红的是沙箱本身而不是变异）"
fi

# 反证 A：从 server-test.yml 的两处 paths 里摘掉 'docs/**' ⇒ 必须报出缺口
python3 - "${SB}" <<'PYEOF'
import sys, re
p = sys.argv[1] + '/.github/workflows/server-test.yml'
s = open(p, encoding='utf-8').read()
n = s.count("      - 'docs/**'\n")
assert n == 2, f'expected 2 docs entries, got {n}'
s = s.replace("      - 'docs/**'\n", '')
open(p, 'w', encoding='utf-8').write(s)
PYEOF
if [[ $? -ne 0 ]]; then
  fail "反证 A 的变异脚本没有真的改动沙箱文件（🔴 编辑脚本 assert 失败时后续命令仍会照跑 ⇒ 必须核实文件真的被写过）"
else
  A_MISS="$(analyze "${SB}" 2>/dev/null | grep -c 'MISSING' || true)"
  if [[ "${A_MISS}" -gt 0 ]]; then
    # ⚠️ 判据是"缺口的依赖以 docs 开头"，不是字面量 docs/** ——
    #    依赖抽取现在是精确路径（例如 docs/guide/script.snippet.md），塌不成 docs/** 那个字符串。
    if analyze "${SB}" 2>/dev/null | grep 'MISSING' | awk -F'\t' '{print $4}' | grep -q '^docs'; then
      pass "尺子有效性 A：摘掉 server-test.yml 的 docs 过滤后，守卫点名了 docs 下的依赖缺口（共 ${A_MISS} 处）"
    else
      fail "尺子有效性 A：报了 ${A_MISS} 处缺口，但没有一处的依赖在 docs 下 ⇒ 判定逻辑指错了对象"
    fi
  else
    fail "🔴 尺子有效性 A 失败：摘掉 docs/** 之后守卫仍然全绿 ⇒ 这条守卫是恒真的"
  fi
fi

# 反证 B：造一个"只存在于沙箱"的守卫 + 引用它但 paths 不覆盖它的 workflow
cp "${ROOT}"/.github/workflows/*.yml "${SB}/.github/workflows/" 2>/dev/null || true
printf '%s\n' '#!/usr/bin/env bash' 'X="${ROOT}/patches/probe-target.json"' 'echo "passed=0 failed=0"' >"${SB}/scripts/tests/zz-synth-probe.test.sh"
python3 - "${SB}" <<'PYEOF'
import sys
p = sys.argv[1] + '/.github/workflows/docs-test.yml'
s = open(p, encoding='utf-8').read()
anchor = "      - name: Docs internal links"
assert s.count(anchor) == 1, 'anchor not unique'
inject = ("      - name: Synthetic probe step\n"
          "        run: bash scripts/tests/run-guard.sh scripts/tests/zz-synth-probe.test.sh\n")
s = s.replace(anchor, inject + anchor)
open(p, 'w', encoding='utf-8').write(s)
PYEOF
if [[ $? -ne 0 ]]; then
  fail "反证 B 的变异脚本没有真的改动沙箱文件"
else
  B_OUT="$(analyze "${SB}" 2>/dev/null)"
  if printf '%s' "${B_OUT}" | grep 'MISSING' | grep -qF 'zz-synth-probe'; then
    pass "尺子有效性 B：一个 paths 未覆盖其依赖的新守卫会被点名（合成输入，未碰真实文件）"
  else
    fail "🔴 尺子有效性 B 失败：新守卫的依赖未被 paths 覆盖，但守卫没有报出来"
  fi
fi

# 反证 C：把沙箱的 workflows 全部删掉 ⇒ 反空转必须红（不能因为"没解析到东西"而绿）
rm -f "${SB}"/.github/workflows/*.yml
C_STATS="$(analyze "${SB}" 2>/dev/null | grep '^__STATS__' || true)"
C_WF="$(printf '%s' "${C_STATS}" | cut -f2)"
if [[ "${C_WF}" == "0" ]]; then
  pass "尺子有效性 C：workflow 全部消失时枚举数归 0（真实仓库那条下界断言会因此变红，而不是空转的绿）"
else
  fail "尺子有效性 C：删光 workflow 后仍解析到 ${C_WF} 个 ⇒ 枚举没有真的依赖 workflow 文件"
fi

echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]] || exit 1
exit 0
