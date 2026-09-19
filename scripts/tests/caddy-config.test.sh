#!/usr/bin/env bash
# scripts/caddyConfig.js 的单元测试 + entrypoint 的自适应逻辑契约。
#
# 背景：Caddy 2.11 把 on-demand TLS 的 `ask` 换成了 `permission` 模块，
# 用旧写法 caddy 会拒绝加载**整份**配置（"cannot be enabled without a permission module"），
# 结果就是 HTTPS 全废、只能靠降级配置跑 HTTP。镜像里的 caddy 是 apk 装的、版本会漂，
# 所以不猜版本：两种形式都生成，让 caddy 自己 validate 挑。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="${ROOT}/scripts/caddyConfig.js"
TEMPLATE="${ROOT}/caddyTemplate.json"
FALLBACK="${ROOT}/caddyFallbackTemplate.json"
ENTRY="${ROOT}/entrypoint.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

NODE_BIN=""
for cand in "${ROOT}/.tools/node20/bin/node" node; do
  if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "NOTE: 没有 node，跳过 caddyConfig.js 的测试"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

echo "== caddyConfig.js =="

run_helper() { # mode email -> stdout
  "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" "$1" "$2"
}

# --- permission 形式（Caddy ≥2.11）---
OUT="$(run_helper permission 'me@example.com')"
assert_eq "$(printf '%s' "${OUT}" | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const od=JSON.parse(s).apps.tls.automation.on_demand;
  console.log(JSON.stringify(od));
});')" '{"permission":{"module":"http","endpoint":"http://127.0.0.1:3000/api/admin/caddy/ask"}}' \
  "permission 模式产出 caddy 2.11 认的结构（module=http + endpoint）"

# --- ask 形式（老 caddy）---
assert_eq "$(run_helper ask 'me@example.com' | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const od=JSON.parse(s).apps.tls.automation.on_demand;
  console.log(JSON.stringify(od));
});')" '{"ask":"http://127.0.0.1:3000/api/admin/caddy/ask"}' \
  "ask 模式产出老版本 caddy 认的结构"

# --- 两种模式都必须是合法 JSON，且路由数量与模板一致 ---
for m in permission ask; do
  RES="$(run_helper "${m}" 'me@example.com' | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s);
  const t=require("fs").readFileSync(process.argv[1],"utf8");
  const n0=JSON.parse(t).apps.http.servers.srv0.routes.length;
  console.log(c.apps.http.servers.srv0.routes.length===n0 ? "ok" : "routes-mismatch");
});' "${TEMPLATE}")"
  assert_eq "${RES}" "ok" "${m} 模式：输出是合法 JSON 且路由数与模板一致"
done

# --- 邮箱替换是在对象上做的，不是文本替换 ---
assert_eq "$(run_helper permission 'a&b@x.com' | grep -o 'a&b@x.com' | head -1)" "a&b@x.com" \
  "邮箱里的 & 原样保留（sed 会把它展开成整个匹配）"
assert_eq "$(run_helper permission 'a"b@x.com' >/dev/null 2>&1; echo $?)" "0" \
  "邮箱里有引号也不会把 JSON 写坏（退出码 0）"
run_helper permission 'a"b@x.com' | "${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s);console.log("ok")})' \
  | grep -q ok && pass "带引号的邮箱产出的仍是合法 JSON" || fail "带引号的邮箱产出的不是合法 JSON"
assert_eq "$(run_helper permission '' | grep -c 'VAN_BLOG_EMAIL')" "0" \
  "空邮箱也会把占位符换掉（caddy 的 acme issuer 允许没有联系邮箱）"

# --- 参数校验 ---
"${NODE_BIN}" "${HELPER}" >/dev/null 2>&1
assert_eq "$?" "2" "参数不对时退出码 2（不会静默产出空配置）"
"${NODE_BIN}" "${HELPER}" "${TEMPLATE}" bogus 'a@b.c' >/dev/null 2>&1
assert_eq "$?" "2" "未知模式被拒绝"

# --- 降级模板也能被处理（它没有 apps.tls，不该报错）---
"${NODE_BIN}" "${HELPER}" "${FALLBACK}" permission 'me@example.com' | "${NODE_BIN}" -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(c.apps.tls?"has-tls":"no-tls")})' \
  | grep -q "no-tls" && pass "降级模板（无 apps.tls）也能正常处理" \
  || fail "降级模板处理出错"

echo "== entrypoint 的自适应逻辑 =="
ENTRY_CODE="$(sed 's|^[[:space:]]*#.*||' "${ENTRY}")"
if printf '%s' "${ENTRY_CODE}" | grep -q "for MODE in permission ask"; then
  pass "两种形式都会试（不按版本号猜）"
else
  fail "没有遍历 permission/ask 两种形式"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q "caddyConfig.js"; then
  pass "用 caddyConfig.js 生成配置（而不是文本 sed）"
else
  fail "没有用 caddyConfig.js 生成配置"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q -- "--adapter json"; then
  fail "又加回了 --adapter json（这个 caddy 不认，会让主配置永远校验失败）"
else
  pass "validate 没有画蛇添足地指定 --adapter"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q "caddy validate --config /app/caddy.json"; then
  pass "每种形式都先 validate 再 start"
else
  fail "没有先 validate 就 start"
fi
if grep -q "COPY ./scripts/caddyConfig.js /app/caddyConfig.js" "${ROOT}/Dockerfile"; then
  pass "Dockerfile 把 caddyConfig.js 拷进了镜像"
else
  fail "Dockerfile 没有 COPY caddyConfig.js，entrypoint 会找不到它"
fi

# ---------- HSTS：只加在 443 那个 server 上，降级模板故意不加 ----------
# 模板里有两个 server：srv0 = :443、srv1 = :80。
#   ① 明文 HTTP 上发 HSTS 浏览器会**忽略**（RFC 6797 §8.1），只是噪音 ⇒ srv1 不许有；
#   ② 降级模板是"主配置 validate 不过"时用的那份，它**没有 apps.tls**，HTTPS 会变自签证书。
#      在证书本来就不可信的路径上告诉浏览器"一年内必须只用 HTTPS"，等于把站长锁在自己站外面
#      （浏览器不给"仍然前往"的选项）⇒ 降级模板故意不加。
# ⚠️ 代价（要写进文档）：带 HSTS 的域名在 max-age 窗口内无法回退纯 HTTP，证书续签失败时浏览器
#    会硬失败。所以 caddy 的数据目录必须持久化 —— compose 模板挂了两个 caddy 卷；
#    k8s 清单没挂（那是另一条待修的问题，会让每次重建 pod 都重签证书）。
HSTS_REPORT="$("${NODE_BIN}" -e '
const fs = require("fs");
function hdr(file, srv) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const s = d.apps && d.apps.http && d.apps.http.servers && d.apps.http.servers[srv];
  if (!s) return { listen: "?", set: null };
  const r = (s.routes || [])[0] || {};
  const h = (r.handle || [])[0] || {};
  return { listen: (s.listen || ["?"])[0], set: (h.response && h.response.set) || null };
}
const main = process.argv[1], fb = process.argv[2];
const a = hdr(main, "srv0"), b = hdr(main, "srv1");
const f = fb && fs.existsSync(fb) ? hdr(fb, "srv0") : { listen: "?", set: null };
const hsts = (x) => (x.set && x.set["Strict-Transport-Security"] || []).join(",") || "none";
console.log("SRV0_LISTEN=" + a.listen);
console.log("SRV1_LISTEN=" + b.listen);
console.log("SRV0_HSTS=" + hsts(a));
console.log("SRV1_HSTS=" + hsts(b));
console.log("FB_HSTS=" + hsts(f));
const need = ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"];
console.log("SRV0_OTHERS=" + (a.set ? need.filter((k) => a.set[k]).length : 0));
' "${TEMPLATE}" "${FALLBACK}")"
hsts_get() { printf '%s\n' "${HSTS_REPORT}" | sed -n "s/^$1=//p"; }

assert_eq "$(hsts_get SRV0_LISTEN)" ":443" "模板里 srv0 确实是 443（HSTS 该加在它上面）"
assert_eq "$(hsts_get SRV1_LISTEN)" ":80" "模板里 srv1 确实是 80"
assert_eq "$(hsts_get SRV0_HSTS)" "max-age=31536000" "443 的响应带 HSTS（max-age 一年，不含 includeSubDomains/preload）"
assert_eq "$(hsts_get SRV1_HSTS)" "none" "80 的响应**不带** HSTS（明文上发浏览器会忽略，只是噪音）"
assert_eq "$(hsts_get FB_HSTS)" "none" "降级模板**不带** HSTS（那份没有 apps.tls、证书自签，硬要求 HTTPS 会把站长锁在外面）"
assert_eq "$(hsts_get SRV0_OTHERS)" "4" "原有四个安全响应头一个没少（加 HSTS 时没把它们顶掉）"

# 反证：把 HSTS 从模板副本里摘掉，检测器必须读出 none —— 否则上面那条断言只是恒真
HSTS_MUTANT="$(mktemp)"
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const set = d.apps.http.servers.srv0.routes[0].handle[0].response.set;
delete set["Strict-Transport-Security"];
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${HSTS_MUTANT}"
MUT_REPORT="$("${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const set = d.apps.http.servers.srv0.routes[0].handle[0].response.set;
console.log((set["Strict-Transport-Security"] || []).join(",") || "none");
' "${HSTS_MUTANT}")"
assert_eq "${MUT_REPORT}" "none" "（反证）摘掉 HSTS 后检测器确实读到 none —— 上面那条不是恒真断言"
rm -f "${HSTS_MUTANT}"

echo "== HSTS max-age 可配置（VANBLOG_HSTS_MAX_AGE，默认一年）=="
# ⚠️ 这一节全部解析 caddyConfig.js 的**产出**，不 grep 模板：模板里写着默认值不代表
#    生成器会照办（上面那节钉的是模板侧，这节钉的是"运行时真的按变量走"）。
#
# 判定形状：hsts0=srv0(:443) 的头值（没有就 '-'）｜hsts1=srv1(:80) 的头值｜
#           others0=srv0 除 HSTS 外的安全响应头个数（改 HSTS 不该伤到别的头）｜
#           subdom/preload=产出里是否出现这两个指令（出现即违规）
HSTS_EXTRACTOR="$(mktemp)"
cat > "${HSTS_EXTRACTOR}" <<'HSTSJS'
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  let d;
  try {
    d = JSON.parse(s);
  } catch (e) {
    console.log('INVALID_JSON');
    return;
  }
  const servers = (d.apps && d.apps.http && d.apps.http.servers) || {};
  const HEADER = 'Strict-Transport-Security';
  const readServer = (name) => {
    const sv = servers[name];
    if (!sv) return { value: 'NO_SERVER', others: 0 };
    let value = '-';
    let others = 0;
    for (const r of sv.routes || []) {
      for (const h of r.handle || []) {
        if (h.handler !== 'headers' || !h.response) continue;
        for (const op of ['set', 'add']) {
          const bag = h.response[op];
          if (!bag || typeof bag !== 'object') continue;
          for (const k of Object.keys(bag)) {
            if (k === HEADER) {
              const v = bag[k];
              value = Array.isArray(v) ? v.join('; ') : String(v);
            } else if (op === 'set') {
              others += 1;
            }
          }
        }
      }
    }
    return { value, others };
  };
  const s0 = readServer('srv0');
  const s1 = readServer('srv1');
  const low = s.toLowerCase();
  console.log(
    `hsts0=${s0.value} hsts1=${s1.value} others0=${s0.others} subdom=${low.includes('includesubdomains') ? 1 : 0} preload=${low.includes('preload') ? 1 : 0}`,
  );
});
HSTSJS

# 用某个 HSTS 取值（或 __unset__）跑生成器；第二个参数可换模板
run_hsts() {
  local tpl="${2:-$TEMPLATE}"
  if [[ "$1" == "__unset__" ]]; then
    env -u VANBLOG_HSTS_MAX_AGE "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>/dev/null
  else
    VANBLOG_HSTS_MAX_AGE="$1" "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>/dev/null
  fi
}

# --- 默认值：未设置 = 一年 = 本轮之前的行为（零变化）---
assert_eq "$(run_hsts __unset__ | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
  "hsts0=max-age=31536000 hsts1=- others0=4 subdom=0 preload=0" \
  "未设置 VANBLOG_HSTS_MAX_AGE 时仍是 max-age=31536000（一年）：只在 :443 上、:80 没有、另外 4 个安全头不受影响"

# --- 0 = 紧急逃生口：整个头不下发，但**别的安全头必须还在** ---
assert_eq "$(run_hsts 0 | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
  "hsts0=- hsts1=- others0=4 subdom=0 preload=0" \
  "VANBLOG_HSTS_MAX_AGE=0 时不下发 HSTS（紧急逃生口），但 nosniff/Referrer-Policy/XFO/Permissions-Policy 四个头一个不少"

# --- 正常取值原样生效（含 <300 的弱值：照办，只 WARN，不夹）---
for v in 86400 604800 300 299 1; do
  assert_eq "$(run_hsts "${v}" | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
    "hsts0=max-age=${v} hsts1=- others0=4 subdom=0 preload=0" \
    "VANBLOG_HSTS_MAX_AGE=${v} 原样生效（小于 300 也照办：既然 0 都能关，设下限就不是真边界，还会在紧急情况下改掉站长的明确意图）"
done

# --- 前后空白要能被吃掉（compose 里手写 env 很容易带空格）---
assert_eq "$(run_hsts '  604800  ' | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
  "hsts0=max-age=604800 hsts1=- others0=4 subdom=0 preload=0" \
  "值两端的空白被 trim 掉后照常生效"

# --- ⚠️ 最关键的一组：垃圾值必须回落**默认**，绝不能被当成 0 ---
# Number('') === 0，而 0 在本变量里是"关闭安全头"的合法指令 ⇒ "拼错一个字符就静默关掉
# HSTS"是最坏的失败方向。逐个钉住"回落默认"。
for bad in abc "1年" 86400.5 1e3 0x10 +86400 -1 "" "   " 86400abc "0.0" true null "31536000秒"; do
  R_BAD="$(run_hsts "${bad}" | "${NODE_BIN}" "${HSTS_EXTRACTOR}")"
  if [[ "${R_BAD}" == "hsts0=max-age=31536000 hsts1=- others0=4 subdom=0 preload=0" ]]; then
    pass "垃圾值 '${bad}' 回落到默认一年（**不是**被当成 0 关掉安全头）"
  elif [[ "${R_BAD}" == "INVALID_JSON" || -z "${R_BAD}" ]]; then
    fail "垃圾值 '${bad}' 让生成器产出了非法 JSON（stdout 被污染？）"
  else
    fail "垃圾值 '${bad}' 没有回落到默认一年（得到 '${R_BAD}'）—— 拼错的值不该改变安全头"
  fi
done

# --- 上界夹取：多打一个 0（十年）是现实手误，而 HSTS 发出去就撤回不了 ---
for big in 315360000 63072001 999999999999999999999; do
  assert_eq "$(run_hsts "${big}" | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
    "hsts0=max-age=63072000 hsts1=- others0=4 subdom=0 preload=0" \
    "VANBLOG_HSTS_MAX_AGE=${big} 被夹到上限 63072000（两年）：HSTS 不可撤回，这个方向的手误代价远大于'没照办'"
done
assert_eq "$(run_hsts 63072000 | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
  "hsts0=max-age=63072000 hsts1=- others0=4 subdom=0 preload=0" \
  "上限值本身（63072000）原样生效，没有被夹小"

# --- 降级模板：无论变量怎么设都**不发** HSTS ---
# 理由：那份没有 apps.tls、HTTPS 是自签证书；在证书本来就不可信的路径上要求"一年只用 HTTPS"
# 等于把站长锁在自己站外（浏览器不给"仍然前往"）。
for v in __unset__ 0 86400 31536000; do
  R_FB="$(run_hsts "${v}" "${FALLBACK}" | "${NODE_BIN}" "${HSTS_EXTRACTOR}")"
  case "${R_FB}" in
    "hsts0=- hsts1=-"*)
      pass "降级模板在 VANBLOG_HSTS_MAX_AGE='${v}' 下不发 HSTS（自签证书路径不该钉一年）" ;;
    *)
      fail "降级模板在 VANBLOG_HSTS_MAX_AGE='${v}' 下出现了 HSTS（得到 '${R_FB}'）—— 会把站长锁在自签证书的站外" ;;
  esac
done

# --- 警告走 stderr，stdout 必须始终是纯 JSON（它要被重定向成 caddy.json）---
HSTS_ERR="$(VANBLOG_HSTS_MAX_AGE=abc "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>&1 >/dev/null)"
case "${HSTS_ERR}" in
  *"不是非负整数秒"*"回落到默认"*)
    pass "垃圾值会在 stderr 上 WARN 说明回落（stdout 仍是纯 JSON，可安全重定向成 caddy.json）" ;;
  *) fail "垃圾值没有 WARN（stderr='${HSTS_ERR}'）—— 站长不会知道自己拼错了" ;;
esac
HSTS_ERR0="$(VANBLOG_HSTS_MAX_AGE=0 "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>&1 >/dev/null)"
case "${HSTS_ERR0}" in
  *"不再下发"*) pass "显式关掉 HSTS 时也在 stderr 留痕（关闭一个安全头不该无声无息）" ;;
  *) fail "VANBLOG_HSTS_MAX_AGE=0 没有任何日志痕迹（stderr='${HSTS_ERR0}'）" ;;
esac

# --- includeSubDomains / preload 必须被丢掉（整值替换 ⇒ 结构上带不出去）---
HSTS_MUT="$(mktemp -d)"
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const set = d.apps.http.servers.srv0.routes[0].handle[0].response.set;
set["Strict-Transport-Security"] = ["max-age=31536000; includeSubDomains; preload"];
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${HSTS_MUT}/tpl-directives.json"
# 反证：提取器**能**看出这两个指令（否则上面那些 subdom=0/preload=0 就是恒真）
assert_eq "$("${NODE_BIN}" "${HSTS_EXTRACTOR}" < "${HSTS_MUT}/tpl-directives.json")" \
  "hsts0=max-age=31536000; includeSubDomains; preload hsts1=- others0=4 subdom=1 preload=1" \
  "（反证）提取器确实能识别 includeSubDomains/preload —— 上面那些 subdom=0/preload=0 不是恒真"
# 正证：经过 caddyConfig.js 之后这两个指令消失
assert_eq "$(VANBLOG_HSTS_MAX_AGE=86400 "${NODE_BIN}" "${HELPER}" "${HSTS_MUT}/tpl-directives.json" permission 'me@example.com' 2>/dev/null | "${NODE_BIN}" "${HSTS_EXTRACTOR}")" \
  "hsts0=max-age=86400 hsts1=- others0=4 subdom=0 preload=0" \
  "模板里被塞进 includeSubDomains/preload 时，生成器整值替换成 max-age=<N>，两个指令不会发到线上"

# --- 反证：提取器真的在读 srv1（否则所有 hsts1=- 都恒真）---
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
d.apps.http.servers.srv1.routes[0].handle[0].response.set["Strict-Transport-Security"] = ["max-age=999"];
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${HSTS_MUT}/tpl-srv1.json"
assert_eq "$("${NODE_BIN}" "${HSTS_EXTRACTOR}" < "${HSTS_MUT}/tpl-srv1.json")" \
  "hsts0=max-age=31536000 hsts1=max-age=999 others0=4 subdom=0 preload=0" \
  "（反证）提取器确实读 srv1 —— 上面所有 'hsts1=-' 断言不是恒真"
rm -rf "${HSTS_MUT}" "${HSTS_EXTRACTOR}"

# ─────────────────────────────────────────────────────────────────────────────
# 访问日志开关 VANBLOG_CADDY_ACCESS_LOG
#
# 为什么要有：① 访问日志含访客 IP，本身是隐私面；② 被攻击时每秒上千条 JSON 写盘是
# 实打实的 IO 成本，站长可能宁愿不要日志也要保住磁盘。
# ⚠️ 方向是"失败时保留日志"：只有明确的关闭字面量才关，未设置/空值/拼错一律保持开启
#    —— 一个拼错的值不该静默丢掉审计日志。
# ⚠️ 关闭时必须**整体替换** writer 为 {"output":"discard"}：Caddy 严格解码，
#    discard writer 上残留 filename/roll_* 会 `json: unknown field` ⇒ 整份配置被拒 ⇒
#    entrypoint 退回降级模板（自签证书、无 on-demand TLS）。caddy-perf.test.sh 里有
#    用真 caddy 二进制做的 validate 与反证，这里验的是 caddyConfig.js 的行为。
# ─────────────────────────────────────────────────────────────────────────────
echo "== 访问日志开关 =="

# 提取器写成临时文件而不是内联 node -e：这段要读 JSON 的键集合，内联引号太容易写错
# （本仓库有过"awk 程序里写了含单引号的中文注释，把外层单引号提前闭合"的先例）。
ALOG_EXTRACTOR="$(mktemp)"
cat > "${ALOG_EXTRACTOR}" <<'NODE_EOF'
// 输入：caddyConfig.js 生成的配置（stdin）。输出：一行紧凑报告，供 bash 断言。
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const d = JSON.parse(raw);
  const L = (d.logging && d.logging.logs) || {};
  const rep = (n) => {
    const w = (L[n] && L[n].writer) || {};
    // 键集合排序后拼起来：这是"discard 上有没有残留 file 字段"的唯一可靠判据
    return w.output + "{" + Object.keys(w).sort().join(",") + "}";
  };
  const routes = ((d.apps.http.servers.srv0 || {}).routes || []).length;
  console.log(
    "log0=" + rep("log0") + " log1=" + rep("log1") + " default=" + rep("default") + " routes=" + routes
  );
});
NODE_EOF

run_helper_accesslog() { # <env值|__unset__> -> 报告行
  local v="$1"
  if [[ "${v}" == "__unset__" ]]; then
    env -u VANBLOG_CADDY_ACCESS_LOG "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' \
      | "${NODE_BIN}" "${ALOG_EXTRACTOR}"
  else
    VANBLOG_CADDY_ACCESS_LOG="${v}" "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' \
      | "${NODE_BIN}" "${ALOG_EXTRACTOR}"
  fi
}

FILE_WRITER_KEYS="filename,output,roll_keep,roll_keep_days,roll_size_mb"

R_UNSET="$(run_helper_accesslog __unset__)"
assert_eq "${R_UNSET}" \
  "log0=file{${FILE_WRITER_KEYS}} log1=file{${FILE_WRITER_KEYS}} default=file{${FILE_WRITER_KEYS}} routes=25" \
  "未设置变量时访问日志保持开启，且 writer 带着显式钉住的滚动参数（100MB/10 份/90 天）"

for offval in false off 0 no OFF "FALSE " "  No  "; do
  R_OFF="$(run_helper_accesslog "${offval}")"
  assert_eq "${R_OFF}" \
    "log0=discard{output} log1=discard{output} default=file{${FILE_WRITER_KEYS}} routes=25" \
    "VANBLOG_CADDY_ACCESS_LOG='${offval}' 关闭两个访问日志（writer **只剩 output**，无残留 file 字段），运行日志 default 保留，路由数不变"
done

# ⚠️ 失败方向必须是"保留日志"：拼错的值不能把审计日志静默关掉
for typo in disabled fals disable FALSE_X yes please ""; do
  R_TYPO="$(run_helper_accesslog "${typo}")"
  case "${R_TYPO}" in
    *"log0=file{"*)
      pass "无法识别的值 '${typo}' 保持访问日志开启（失败方向是保留审计日志，不是静默丢弃）" ;;
    *)
      fail "无法识别的值 '${typo}' 竟然关掉了访问日志（得到 '${R_TYPO}'）—— 拼错一个值不该静默丢掉审计日志" ;;
  esac
done

# 反证：如果 discard writer 上残留了 file 专有字段，提取器必须能看出来（键集合会变长）。
# 没有这条，上面那些 "discard{output}" 断言可能只是提取器根本没在读键集合。
ALOG_MUT="$(mktemp)"
env -u VANBLOG_CADDY_ACCESS_LOG "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' > "${ALOG_MUT}"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
d['logging']['logs']['log0']['writer']={'output':'discard','filename':'/var/log/x.log','roll_size_mb':100}
json.dump(d,open(sys.argv[1],'w',encoding='utf-8'),ensure_ascii=False)
" "${ALOG_MUT}"
MUT_REP="$("${NODE_BIN}" "${ALOG_EXTRACTOR}" < "${ALOG_MUT}")"
case "${MUT_REP}" in
  *"log0=discard{filename,output,roll_size_mb}"*)
    pass "（反证）提取器确实能看出 discard writer 上残留的 file 字段 —— 上面那些断言不是恒真" ;;
  *)
    fail "（反证失败）故意在 discard writer 上留下 filename/roll_size_mb，提取器却没报出来（得到 '${MUT_REP}'）" ;;
esac
rm -f "${ALOG_MUT}" "${ALOG_EXTRACTOR}"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
