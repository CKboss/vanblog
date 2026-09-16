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
#
# 前置条件：
#   1) 目标站点已经**恢复过真实数据**（空库测出来的数字没有意义：没有文章就没有 ISR 页面、
#      没有图片就没有静态流量）。用 ./vanblog.sh reset 或初始化页的"上传整站备份恢复"。
#   2) 本机能跑 node（脚本用仓库自带的 .tools/node*，找不到就退回 PATH 里的 node）。
#   3) 要采集容器资源占用就得给出 --engine 与 --container（不给就跳过这一节，不报错）。
#
# ⚠️ 诚实性约定（报告里必须照抄）：客户端与服务端在**同一台机器**上时，两者抢 CPU，
#    所以绝对数字偏保守；这类数字只能用于**同一台机器上的前后对比**，不能当成"公网能扛多少"。
#    走 loopback 也意味着没有真实网卡、没有 TLS 握手开销。
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="http://127.0.0.1:18080"
ENGINE=""
CONTAINER=""
OUT=""
SWEEP_C="50,200,500,1000"
SWEEP_N="3000"
STATIC_N="800"
LAT_N="20"
C10K_HOLD="10000"

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
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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
"$NODE" "$LOADTEST" --base "$BASE" --profile mixed --c "$SWEEP_C" --n "$SWEEP_N" 2>&1 \
  | grep -E '^ *[0-9]+ \|' | while IFS= read -r line; do emit "$line"; done

# ---------------------------------------------------------------------------
say "4. 静态资源吞吐（caddy 直服，不经过 Node）"
# ---------------------------------------------------------------------------
"$NODE" "$LOADTEST" --base "$BASE" --profile static --c 50 --n "$STATIC_N" 2>&1 \
  | grep -E '^ *[0-9]+ \|' | while IFS= read -r line; do emit "$line"; done

# ---------------------------------------------------------------------------
say "5. C10K（先建 $C10K_HOLD 条连接并保持，再一起发请求）"
# ---------------------------------------------------------------------------
for target in "$IMG" "/api/public/meta"; do
  [[ -z "$target" || "$target" == "?" ]] && continue
  emit "目标 \`$target\`："
  "$NODE" "$LOADTEST" --base "$BASE" --profile c10k --hold "$C10K_HOLD" --path "$target" 2>&1 \
    | grep -E '目标连接数|成功建立|连接上发请求|建连错误' | while IFS= read -r line; do emit "  $line"; done
done

# ---------------------------------------------------------------------------
say "6. 容器资源占用（空闲 / 加压 30 秒）"
# ---------------------------------------------------------------------------
if [[ -n "$ENGINE" && -n "$CONTAINER" ]]; then
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
