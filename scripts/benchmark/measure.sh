#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# VanBlog 访问性能实测驱动脚本
#
# 为什么要有它：docs/advanced/benchmark.md 里的每个数字都要能被别人重跑出来。
# 这个脚本把"一轮完整实测"固化成一条命令 —— 环境事实、单请求延迟、页面重量、
# 并发扫描、静态直服吞吐、C10K、以及容器资源占用，全部按同一套协议采集。
#
# 用法：
#   scripts/benchmark/measure.sh                       # 默认打 http://127.0.0.1:18080
#   scripts/benchmark/measure.sh --base http://127.0.0.1:18080 --engine podman --container vb-app
#   scripts/benchmark/measure.sh --out /tmp/bench.md   # 同时写一份到文件
#   scripts/benchmark/measure.sh --no-kcounters        # 不采容器内内核计数器（没给 --container 时自动跳过）
#   scripts/benchmark/measure.sh --no-load             # 跳过节 6 的持续加压（只验证工具、或机器上还有别的实测在跑）
#
# 前置条件：
#   1) 目标站点已经**恢复过真实数据**（空库测出来的数字没有意义：没有文章就没有 ISR 页面、
#      没有图片就没有静态流量）。用 ./vanblog.sh reset 或初始化页的"上传整站备份恢复"。
#   2) 本机能跑 node（脚本用仓库自带的 .tools/node*，找不到就退回 PATH 里的 node）。
#   3) 要采集容器资源占用就得给出 --engine 与 --container（不给就跳过这一节，不报错）。
#
# 失败分类（loadtest.cjs 打出来的 `[分类]`/`[明细]` 两行）——为什么必须有：
#   "失败=4967" 这一个数字里混着四种指向**完全不同根因**的东西，分开才谈得上修：
#     http_502/503/504        caddy 连不上上游（日志是 `dial tcp 127.0.0.1:3000: i/o timeout`）
#     connect_err_ETIMEDOUT   建连阶段 SYN 被静默丢弃 ⇒ **listen backlog 溢出**（tcp_abort_on_overflow=0）
#     connect_err_ECONNRESET  建连阶段被重置 ⇒ backlog 溢出且 tcp_abort_on_overflow=1，或对端崩
#     connect_err_CLIENT_TIMEOUT  我们等不下去了（内核重传还没耗尽）——与上面两类要分开读
#     request_err_*           连接已建立、请求阶段才失败 ⇒ 不是内核不收连接，是应用/上游的问题
#     err_EADDRNOTAVAIL       **压测机**临时端口耗尽（客户端侧约束，不是服务端的）
#   所以每条都带阶段前缀：backlog 溢出只可能发生在建连阶段，这个区分是唯一能把
#   "内核不肯接受连接"与"应用不肯处理请求"分开的证据。
#   `[分类]` 行还会给出 `未归类` —— 既没有状态码也没有错误码的请求（挂着不响应被总超时截断），
#   旧版工具会把这一类**静默吞掉**，总数对不上都看不出来。
#
# 内核计数器（容器内 netns）——为什么必须在容器里读：
#   ListenOverflows / ListenDrops / TCPBacklogDrop 这些计数器是 **per-netns** 的，
#   在宿主机上读到的是另一个 netns 的数字，与容器里发生的事无关（本轮就靠容器内的
#   TcpExtListenOverflows=3745 才把"502 是上游超时"与"backlog 溢出"对上号）。
#   字段序号随内核版本变 ⇒ 一律按 `/proc/net/netstat` 的**表头名字**定位，不写死列号。
#   采不到时打印"未采集到"，**绝不打印 0**（0 会被读成"没有溢出"，是最坏的假阴性）。
#
# ⚠️ 诚实性约定（报告里必须照抄）：客户端与服务端在**同一台机器**上时，两者抢 CPU，
#    所以绝对数字偏保守；这类数字只能用于**同一台机器上的前后对比**，不能当成"公网能扛多少"。
#    走 loopback 也意味着没有真实网卡、没有 TLS 握手开销。
# ⚠️ 还有一条同样要照抄：压测脚手架（run-image-stack.sh / vanblog-drill.sh）走 `podman run`，
#    **不套** compose 模板里的 `ulimits.nofile: 65536`，所以压测时的 fd 上限与生产不一致。
#    本脚本会把容器内**实际**的 ulimit 打进报告，结论必须建立在那个数字上。
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="http://127.0.0.1:18080"
ENGINE=""
CONTAINER=""
OUT=""
KCOUNTERS=1     # 采集容器内内核计数器（--no-kcounters 关掉；没给 --container 时自动跳过）
SWEEP_C="50,200,500,1000"
SWEEP_N="3000"
STATIC_N="800"
LAT_N="20"
C10K_HOLD="10000"
LOAD_SECTION=1  # 节 6 的持续加压（--no-load 跳过）

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --sweep-c) SWEEP_C="$2"; shift 2 ;;
    --sweep-n) SWEEP_N="$2"; shift 2 ;;
    --static-n) STATIC_N="$2"; shift 2 ;;
    --latency-n) LAT_N="$2"; shift 2 ;;
    --c10k) C10K_HOLD="$2"; shift 2 ;;
    --no-kcounters) KCOUNTERS=0; shift ;;
    # 跳过节 6 那段"持续加压 30 秒"（硬编码 20000 个请求）。用途：只想验证工具本身能不能跑通、
    # 新字段有没有值，或者机器上还有别的实测在跑、不想互相污染时。默认仍然跑（口径不变）。
    --no-load) LOAD_SECTION=0; shift ;;
    # ⚠️ 帮助按"连续注释块"打印，而不是写死行号区间：头部注释一变长，写死的 `2,30p`
    #    就会把代码行当帮助打出来（这个脚本以前就是这么干的）。
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# --- node：优先用仓库自带的那份（与 dev/CI 同一个大版本） ---
# ⚠️ 取**版本号最大**的那份，而不是 glob 的第一个：`.tools/node20` 排在 `.tools/node24` 前面，
# 按字典序会选中旧的，于是报告里"压测器用的 node"与生产镜像不一致（第一版就是这么错的）。
NODE=""
for cand in $(ls -d "$ROOT"/.tools/node*/bin/node 2>/dev/null | sort -V); do
  [[ -x "$cand" ]] && NODE="$cand"
done
[[ -z "$NODE" ]] && NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "找不到 node（既没有 .tools/node*/bin/node，PATH 里也没有）" >&2
  exit 1
fi

LOADTEST="$ROOT/scripts/benchmark/loadtest.cjs"
[[ -f "$LOADTEST" ]] || { echo "缺 $LOADTEST" >&2; exit 1; }

# 输出：同时进 stdout 和（可选）文件
emit() {
  printf '%s\n' "$*"
  [[ -n "$OUT" ]] && printf '%s\n' "$*" >> "$OUT"
  return 0
}
[[ -n "$OUT" ]] && : > "$OUT"

say() { printf '\n'; emit "## $*"; }

# ---------------------------------------------------------------------------
# 容器内内核计数器采集
#
# 为什么必须有这一节：本轮定位 C10K 失败时，"502 是上游超时"与"listen backlog 溢出"
# 这两种解释在客户端看起来**一模一样**（都是失败），只有容器 netns 里的
# `TcpExtListenOverflows` 能分辨 —— 实测到 3745 次溢出，才把结论钉死在 backlog 上。
# ⚠️ 这些计数器是 per-netns 的：在宿主机读等于读另一个网络命名空间，与容器里发生的事无关。
# ⚠️ 采不到时打印"未采集到"，**绝不打印 0** —— 0 会被读成"没有溢出"，那是最坏的假阴性。
# ---------------------------------------------------------------------------
KSNAP_SH=""
KBEFORE="$(mktemp "${TMPDIR:-/tmp}/vb-kbefore.XXXXXX")"
KAFTER="$(mktemp "${TMPDIR:-/tmp}/vb-kafter.XXXXXX")"
trap 'rm -f "$KBEFORE" "$KAFTER" ${KSNAP_SH:+"$KSNAP_SH"}' EXIT

ksnap_script() {
  [[ -n "$KSNAP_SH" && -s "$KSNAP_SH" ]] && return 0
  KSNAP_SH="$(mktemp "${TMPDIR:-/tmp}/vb-ksnap.XXXXXX.sh")"
  cat > "$KSNAP_SH" <<'EOS'
# 在容器内跑：输出 key=value。POSIX sh + busybox awk（Alpine 里没有 gawk，
# 所以不能用 strtonum 之类的 GNU 扩展，十六进制转换自己写）。
readproc() {
  if [ -r "$2" ]; then
    v=$(tr '\n\t' '  ' < "$2" 2>/dev/null | tr -s ' ')
    v=${v# }; v=${v% }
    if [ -n "$v" ]; then echo "$1=$v"; else echo "$1=未采集到"; fi
  else
    echo "$1=未采集到"
  fi
}

# /proc/net/netstat 与 /proc/net/snmp 都是"表头行 + 数值行"成对出现，字段序号随内核版本变
# ⇒ 按表头名字定位，绝不写死列号（写死会在换内核时静默取到别的计数器，那比取不到更糟）。
awk '
  {
    k = $1; sub(/:$/, "", k)
    if (!(k in seen)) { seen[k] = 1; for (i = 2; i <= NF; i++) nm[k, i] = $i; next }
    for (i = 2; i <= NF; i++) if (nm[k, i] != "") printf "%s.%s=%s\n", k, nm[k, i], $i
  }
' /proc/net/netstat /proc/net/snmp 2>/dev/null

awk '{ p = $1; sub(/:$/, "", p); for (i = 2; i + 1 <= NF; i += 2) printf "sockstat.%s.%s=%s\n", p, $i, $(i+1) }' /proc/net/sockstat 2>/dev/null

readproc sysctl.somaxconn /proc/sys/net/core/somaxconn
readproc sysctl.tcp_max_syn_backlog /proc/sys/net/ipv4/tcp_max_syn_backlog
readproc sysctl.ip_local_port_range /proc/sys/net/ipv4/ip_local_port_range
readproc sysctl.tcp_abort_on_overflow /proc/sys/net/ipv4/tcp_abort_on_overflow
readproc sysctl.tcp_tw_reuse /proc/sys/net/ipv4/tcp_tw_reuse
readproc sysctl.nf_conntrack_count /proc/sys/net/netfilter/nf_conntrack_count
readproc sysctl.nf_conntrack_max /proc/sys/net/netfilter/nf_conntrack_max

# fd 上限：⚠️ 压测脚手架走 `podman run`，**不套** compose 模板里的 nofile: 65536，
# 所以每次都要把容器内实际上限记下来，否则"fd 够不够"的结论建立在错误前提上。
echo "ulimit.nofile_soft=$(ulimit -Sn 2>/dev/null || echo 未采集到)"
echo "ulimit.nofile_hard=$(ulimit -Hn 2>/dev/null || echo 未采集到)"

# 监听 socket 的队列：① ss（busybox 的 ss 对 `state` 过滤不可靠 —— `ss -tan state time-wait`
# 会返回空 —— 所以只用不带过滤的 -ltn，再自己按端口取列）
if command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | awk '
    NR > 1 {
      for (i = 1; i <= NF; i++) if ($i ~ /:[0-9]+$/) {
        n = split($i, a, ":")
        printf "ss.port_%s.recvq_sendq=%s/%s\n", a[n], $(i-2), $(i-1)
        break
      }
    }'
else
  echo "ss=未采集到（容器内没有 ss）"
fi

# ② 监听端口清单（/proc/net/tcp{,6}，不依赖任何外部命令）。
#    ⚠️ 这里**只能**列出"哪些端口在听"，读不到 backlog。本内核的 /proc/net/tcp 对 LISTEN
#    socket 打的 tx_queue/rx_queue 是 write_seq-snd_una 与 rcv_nxt-copied_seq（恒为 0），
#    accept 队列深度与 backlog 上限只有 inet_diag netlink 才暴露 —— 那是 `ss` 的数据来源，
#    而这个镜像里没有 ss（上面会打印"未采集到"）。
#    实测确认：所有监听端口都读成 0/0 ⇒ **绝不能**把它当"backlog=0"输出，那是比缺数据
#    更糟的假读数（会让人以为内核配置坏了）。backlog 的实际生效值只能：① 看代码
#    （Node 的 listen() 不传 backlog 时默认 511）；② 用 TcpExt.ListenOverflows 的增量间接证明。
awk '
  function h2d(s,   i, c, n) { n = 0; s = toupper(s); for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); n = n * 16 + index("0123456789ABCDEF", c) - 1 } return n }
  $4 == "0A" { split($2, L, ":"); printf "proc_tcp.listening_port_%s=1\n", h2d(L[2]) }
' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u
EOS
}

# 采一次快照。任何失败都写成 __unavailable=<原因>，让报告里留下痕迹而不是静默少一节。
ksnap() {
  local out="$1"
  : > "$out"
  if [[ "$KCOUNTERS" != "1" ]]; then echo "__unavailable=--no-kcounters" >> "$out"; return 0; fi
  if [[ -z "$ENGINE" || -z "$CONTAINER" ]]; then echo "__unavailable=没给 --engine/--container" >> "$out"; return 0; fi
  if ! "$ENGINE" exec "$CONTAINER" true >/dev/null 2>&1; then
    echo "__unavailable=容器 exec 不可用（容器名不对？rootless 没导出 XDG_RUNTIME_DIR/HOME？）" >> "$out"
    return 0
  fi
  ksnap_script
  # ⚠️ 用 `exec -i` + stdin 把脚本喂进去：awk 程序里有大量单引号与 `$`，
  #    塞进 `sh -c '...'` 会变成引号地狱（这类错误还会静默产生空输出）。
  "$ENGINE" exec -i "$CONTAINER" sh -s < "$KSNAP_SH" >> "$out" 2>/dev/null
  [[ -s "$out" ]] || echo "__unavailable=容器内脚本没有输出" >> "$out"
  return 0
}

kget() { # kget <file> <key> → 值，取不到就打印"未采集到"
  local v
  v="$(grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2-)"
  printf '%s' "${v:-未采集到}"
}

# 静态事实（不随时间变的那些）：一次采集，写进报告的环境事实一节
kfacts() {
  local f="$1" k q
  if grep -q '^__unavailable=' "$f" 2>/dev/null; then
    emit "  容器内网络事实：未采集到（$(grep -m1 '^__unavailable=' "$f" | cut -d= -f2-)）"
    return 0
  fi
  for k in ulimit.nofile_soft ulimit.nofile_hard sysctl.somaxconn sysctl.tcp_max_syn_backlog \
           sysctl.ip_local_port_range sysctl.tcp_abort_on_overflow sysctl.tcp_tw_reuse \
           sysctl.nf_conntrack_count sysctl.nf_conntrack_max; do
    emit "  ${k} = $(kget "$f" "$k")"
  done
  q="$(grep -E '^proc_tcp\.listening_port_' "$f" 2>/dev/null | cut -d= -f1 | sed 's/^proc_tcp\.listening_port_//' | sort -n | tr '\n' ' ')"
  emit "  容器内监听端口：${q:-未采集到}"
  emit "  accept 队列深度 / backlog 上限：$(grep -m1 '^ss=' "$f" 2>/dev/null | cut -d= -f2- || true)"
  emit "  ⚠️ 上面这一栏读不到就是读不到，**不要**拿 /proc/net/tcp 的 0/0 当 backlog（那是 LISTEN socket 的 write_seq/rcv_nxt 差值，恒为 0，不是队列信息）。"
  emit "  ⚠️ 所以 backlog 只有两条间接证据：① 代码里 Node \`listen()\` 没传 backlog ⇒ 内核默认 **511**；② 下面 TcpExt.ListenOverflows 的增量 —— 涨了就说明确实溢出过。"
}

# 关键计数器的增量。只挑与"连接被丢/被拒"有关的，否则几百行噪音会淹没结论；
# Δ=0 的也照打 —— "溢出计数没涨"本身就是排除 backlog 的证据。
KDELTA_KEYS="TcpExt.ListenOverflows TcpExt.ListenDrops TcpExt.TCPBacklogDrop TcpExt.TCPReqQFullDoCookies TcpExt.TCPReqQFullDrop TcpExt.TCPTimeouts TcpExt.TCPSynRetrans TcpExt.EmbryonicRsts Tcp.AttemptFails Tcp.EstabResets Tcp.RetransSegs Tcp.OutRsts Tcp.InErrs Tcp.CurrEstab sockstat.TCP.tw sockstat.TCP.inuse sockstat.TCP.orphan sockstat.TCP.alloc"
kdelta() {
  local label="$1" before="$2" after="$3" k b a d
  if grep -q '^__unavailable=' "$after" 2>/dev/null; then
    emit "  内核计数器增量（$label）：未采集到（$(grep -m1 '^__unavailable=' "$after" | cut -d= -f2-)）"
    return 0
  fi
  emit "  内核计数器增量（容器内 netns，$label）："
  for k in $KDELTA_KEYS; do
    b="$(kget "$before" "$k")"; a="$(kget "$after" "$k")"
    if [[ "$b" == "未采集到" || "$a" == "未采集到" ]]; then
      emit "    ${k}: 未采集到"
    elif [[ "$a" =~ ^-?[0-9]+$ && "$b" =~ ^-?[0-9]+$ ]]; then
      d=$((a - b))
      if [[ "$d" -ne 0 ]]; then emit "    ${k}: ${b} → ${a}  **Δ=${d}**"; else emit "    ${k}: ${b} → ${a}  Δ=0"; fi
    else
      emit "    ${k}: ${b} → ${a}（非数值，不给增量）"
    fi
  done
  # 白名单之外**也涨了**的计数器（上限 12 条）：内核换版本会改字段名，
  # 只盯白名单就会漏掉新的溢出计数器 —— 这一条是防"白名单过时"的保险。
  awk -v wl="$KDELTA_KEYS" '
    BEGIN { n = split(wl, W, " "); for (i = 1; i <= n; i++) keep[W[i]] = 1 }
    FNR == NR { if (index($0, "=")) { p = index($0, "="); v[substr($0, 1, p-1)] = substr($0, p+1) } next }
    {
      if (!index($0, "=")) next
      p = index($0, "="); k = substr($0, 1, p-1); nv = substr($0, p+1)
      if (k ~ /^(sysctl|ulimit|ss|proc_tcp|__unavailable)/) next
      if (k in keep) next
      if ((k in v) && v[k] ~ /^[0-9]+$/ && nv ~ /^[0-9]+$/ && v[k] != nv) {
        cnt++
        if (cnt <= 12) printf "    （白名单外）%s: %s → %s  Δ=%d\n", k, v[k], nv, nv - v[k]
      }
    }
    END { if (cnt > 12) printf "    （白名单外还有 %d 个计数器有变化，已省略）\n", cnt - 12 }
  ' "$before" "$after"
  return 0
}

# loadtest 输出里要保留进报告的行。
# ⚠️ 两类行的行首刻意错开：历史数据行是 `^ *数字 |`（列顺序与含义都不能动，
# docs/advanced/benchmark.md 的历史表格要能与新输出逐列对照），新增的分类行以 `[` 开头，
# 所以两边互不误抓。少写一个分支就会**静默丢掉**新字段（报告看着正常，信息却没了）。
PASS_GREP='^ *[0-9]+ \||\[分类\]|\[明细\]|\[警告\]|\[预热异常\]|^ *预热：'
C10K_GREP='目标连接数|成功建立|连接上发请求|建连错误|请求路径|\[分类\]|\[明细\]|\[警告\]'

# ---------------------------------------------------------------------------
say "0. 环境事实"
# ---------------------------------------------------------------------------
emit "- 目标：\`$BASE\`"
emit "- 采集时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
emit "- 压测机：$(uname -srmo)，CPU $(nproc 2>/dev/null || echo '?') 核，内存 $(free -m 2>/dev/null | awk '/^Mem:/{print $2"MB 总 / "$7"MB 可用"}' || echo '?')"
emit "- node（压测器）：$("$NODE" -v)"
emit "- fd 软限制：$(ulimit -n)，somaxconn：$(cat /proc/sys/net/core/somaxconn 2>/dev/null || echo '?')"
# ⚠️ 用 podman 时调用方必须先导出它的 rootless 环境（XDG_RUNTIME_DIR / HOME / TMPDIR），
# 否则 inspect/stats/exec 全部静默失败、这一节只会打印 '?'。
if [[ -n "$ENGINE" && -n "$CONTAINER" ]]; then
  img="$("$ENGINE" inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo '?')"
  emit "- 容器：\`$CONTAINER\` 镜像 \`$img\`（$("$ENGINE" images --format '{{.Size}}' "$img" 2>/dev/null | head -1 || echo '?')）"
  emit "- 容器内 node：$("$ENGINE" exec "$CONTAINER" node -v 2>/dev/null || echo '?')"
  emit "- 容器内关键版本：$("$ENGINE" exec "$CONTAINER" node -e '
const p=(m)=>{try{return require("/app/server/node_modules/"+m+"/package.json").version}catch(e){return "?"}};
console.log("express="+p("express")+" mongoose="+p("mongoose")+" @nestjs/core="+p("@nestjs/core")+" sharp="+p("sharp"));
' 2>/dev/null || echo '?')"
  # 压测**之前**先把容器内的网络事实与计数器基线采一份：
  # 后面每一段的增量都以它为参照，而且 backlog / fd 上限这些静态值只在这里报一次。
  ksnap "$KBEFORE"
  emit "- 容器内网络事实（压测前基线）："
  kfacts "$KBEFORE"
fi
# 站点数据规模：数字必须与结论一起给出，否则"快"没有意义
meta="$(curl -sS -m 30 "$BASE/api/public/meta" 2>/dev/null)"
emit "- 站点规模：$(printf '%s' "$meta" | "$NODE" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const d=JSON.parse(s);const data=d.data||{};const si=((data.meta||{}).siteInfo||{});
  console.log(`文章 ${data.totalArticles ?? "?"} 篇（公开）、标签 ${(data.tags||[]).length} 个、总字数 ${data.totalWordCount ?? "?"}、每页 ${si.articlesPerPage ?? "?"} 篇、皮肤 ${si.uiStyle ?? "?"}`);}
  catch(e){console.log("读不到 meta（站点未初始化？）");}
});' 2>/dev/null)"
first="$(curl -sS -m 30 "$BASE/api/public/article?page=1&pageSize=1&toListView=true&withExcerpt=true" 2>/dev/null)"
SLUG="$(printf '%s' "$first" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.articles[0].pathname||"")}catch(e){console.log("")}});' 2>/dev/null)"
IMG="$(printf '%s' "$first" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.articles[0].firstImage||"")}catch(e){console.log("")}});' 2>/dev/null)"
THUMB="${IMG/\/static\/img\///static/img/thumb/}"
emit "- 取样文章：\`/post/${SLUG:-?}\`；取样图片：\`${IMG:-?}\`（缩略图 \`${THUMB:-?}\`）"

# ---------------------------------------------------------------------------
say "1. 单请求延迟（每路径 $LAT_N 次，identity 与 gzip 各一轮）"
# ---------------------------------------------------------------------------
PATHS="/,/post/${SLUG},/api/public/meta,/api/public/article?page=1&pageSize=5&toListView=true&withExcerpt=true,/api/public/comments/setting,/api/public/theme.css,/static/img/...,/feed.xml,/sitemap.xml,/admin,/robots.txt"
# 图片路径单独拼（可能为空）
[[ -n "$IMG" ]] && PATHS="$PATHS,$IMG"
[[ -n "$THUMB" && "$THUMB" != "$IMG" ]] && PATHS="$PATHS,$THUMB"
PATHS="${PATHS//,\/static\/img\/\.\.\.,/,}"
"$NODE" "$LOADTEST" --base "$BASE" --profile latency --n "$LAT_N" --paths "$PATHS" 2>&1 | while IFS= read -r line; do emit "$line"; done

# ---------------------------------------------------------------------------
say "2. 页面重量（HTML 原始 / gzip，以及 __NEXT_DATA__ 占比）"
# ---------------------------------------------------------------------------
emit "页面 | HTTP | HTML 原始 | HTML gzip | __NEXT_DATA__ 原始 | 占比"
for p in "/" "/post/${SLUG}" "/timeline" "/link" "/tag" "/page/2"; do
  [[ "$p" == "/post/" ]] && continue
  raw="$(curl -sS -m 90 "$BASE$p" -o /tmp/bench-page.html -w '%{http_code} %{size_download}' 2>/dev/null)"
  gz="$(curl -sS -m 90 -H 'accept-encoding: gzip' "$BASE$p" -o /tmp/bench-page.gz -w '%{size_download}' 2>/dev/null)"
  nd="$("$NODE" -e '
const fs=require("fs");
try{
  const h=fs.readFileSync("/tmp/bench-page.html","utf8");
  const m=/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(h);
  console.log(m?m[1].length:0);
}catch(e){console.log(0)}' 2>/dev/null)"
  code="${raw%% *}"
  bytes="${raw##* }"
  pct="?%"
  [[ "${bytes:-0}" -gt 0 && "${nd:-0}" -gt 0 ]] && pct="$(( nd * 100 / bytes ))%"
  emit "\`$p\` | $code | ${bytes}B | ${gz}B | ${nd}B | $pct"
done

# ---------------------------------------------------------------------------
say "3. 混合流量并发扫描（页面 20 / meta 15 / 列表 40 / 其它 25 的配比）"
# ---------------------------------------------------------------------------
emit "并发 | 完成 | 秒 | rps | p50 | p95 | p99 | max | Mbps | 状态码 | socket 错误"
ksnap "$KBEFORE"
"$NODE" "$LOADTEST" --base "$BASE" --profile mixed --c "$SWEEP_C" --n "$SWEEP_N" 2>&1 \
  | grep -E "$PASS_GREP" | while IFS= read -r line; do emit "$line"; done
ksnap "$KAFTER"
emit ""
kdelta "并发扫描 $SWEEP_C × $SWEEP_N" "$KBEFORE" "$KAFTER"

# ---------------------------------------------------------------------------
say "4. 静态资源吞吐（caddy 直服，不经过 Node）"
# ---------------------------------------------------------------------------
"$NODE" "$LOADTEST" --base "$BASE" --profile static --c 50 --n "$STATIC_N" 2>&1 \
  | grep -E "$PASS_GREP" | while IFS= read -r line; do emit "$line"; done

# ---------------------------------------------------------------------------
say "5. C10K（先建 $C10K_HOLD 条连接并保持，再一起发请求）"
# ---------------------------------------------------------------------------
# ⚠️ 这一节的前后快照是**整份报告里最重要的一组数字**：C10K 失败时，客户端只能看到
# "失败=N"，而容器内的 ListenOverflows / ListenDrops 增量能直接说明是不是内核在丢连接。
ksnap "$KBEFORE"
for target in "$IMG" "/api/public/meta"; do
  [[ -z "$target" || "$target" == "?" ]] && continue
  emit "目标 \`$target\`："
  "$NODE" "$LOADTEST" --base "$BASE" --profile c10k --hold "$C10K_HOLD" --path "$target" 2>&1 \
    | grep -E "$C10K_GREP" | while IFS= read -r line; do emit "  $line"; done
done
ksnap "$KAFTER"
emit ""
kdelta "C10K（$C10K_HOLD 条连接 × 两个目标）" "$KBEFORE" "$KAFTER"

# ---------------------------------------------------------------------------
say "6. 容器资源占用（空闲 / 加压 30 秒）"
# ---------------------------------------------------------------------------
if [[ "$LOAD_SECTION" != "1" ]]; then
  emit "（跳过：--no-load。这一节会硬编码打 20000 个请求持续加压 30 秒，用来验证工具时不必跑）"
elif [[ -n "$ENGINE" && -n "$CONTAINER" ]]; then
  stats() { "$ENGINE" stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}}' 2>/dev/null | grep -v '^level='; }
  emit "空闲："
  stats | while IFS= read -r line; do emit "  $line"; done
  "$NODE" "$LOADTEST" --base "$BASE" --profile mixed --c 200 --n 20000 >/tmp/bench-load.log 2>&1 &
  loadpid=$!
  sleep 30
  emit "加压中（并发 200）："
  stats | while IFS= read -r line; do emit "  $line"; done
  wait "$loadpid" 2>/dev/null
  emit "这一轮加压的结果：$(tail -1 /tmp/bench-load.log)"
else
  emit "（跳过：没给 --engine/--container）"
fi

emit ""
emit "> 采集命令：\`scripts/benchmark/measure.sh --base $BASE${ENGINE:+ --engine $ENGINE}${CONTAINER:+ --container $CONTAINER} --sweep-c $SWEEP_C --sweep-n $SWEEP_N --static-n $STATIC_N --latency-n $LAT_N --c10k $C10K_HOLD\`"
