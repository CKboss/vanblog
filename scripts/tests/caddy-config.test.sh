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
#           others0=srv0 上「那四个既有安全响应头」的个数（改 HSTS 不该伤到别的头；⚠️ 按名字数，
#                    不按「除 HSTS 外的全部键」数，否则以后每加一个安全头都会误伤这条断言）｜
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
  // ⚠️ others0 必须**按名字**数这四个头，不能数「除 HSTS 外的全部 set 键」。
  //    这条断言的原意是「改 HSTS 没有把别的头顶掉」，而「数全部键」会让**任何新增安全头**都把它打红
  //    （本轮加站点级 CSP 时就是这么红的：4 → 5）。按名字数才能既保住原意、又不与新增头耦合。
  //    ⚠️ 新增安全头时**不要**顺手往这个清单里加：它的语义是「HSTS 改动之前就已存在的那四个」。
  const OTHER_SECURITY_HEADERS = [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
  ];
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
            } else if (op === 'set' && OTHER_SECURITY_HEADERS.includes(k)) {
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

# ---------- 站点级 CSP：默认 Report-Only，可按路径分档，且不允许头注入 ----------
# 为什么落在这里而不是应用层：`securityHeadersMiddleware` 只覆盖 4 个 pre-Nest 前缀，而
# **前台是独立 Next 进程、后台是 caddy 直接 file_server 的静态产物**，两者都不经过它
# ⇒ 在这一层之前全站页面没有任何 CSP。
# ⚠️ 实测（真 caddy v2.11.4 + 一个也设 CSP 的上游）：`reverse_proxy` **不覆盖**上游的头，
#    响应里会同时出现两条 CSP，浏览器按规范**同时执行**（等效交集）⇒ 所以这里那三条与应用层
#    取值相同的指令必须**逐字一致**，下面有一条跨文件断言专门钉它。
# ⚠️ 默认 report 而不是 enforce：Report-Only **不阻断任何东西**，`script-src` 又必须带
#    `'unsafe-inline'`（admin 有 2 个 umi 裸内联脚本、前台有 5 个 Next 自己的裸内联脚本，
#    而 HTML 是被 caddy 直发的 ISR 缓存文件 ⇒ nonce 会被烤进缓存、hash 每次构建都变）。
#    所以断言里**不许**出现"已启用 CSP 防护"这类措辞，也不许悄悄加 `upgrade-insecure-requests`
#    （那会打坏纯 HTTP 站点）。
echo "== 站点级 CSP =="

CSP_EXTRACTOR="$(mktemp)"
cat > "${CSP_EXTRACTOR}" <<'CSPJS'
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
  const ENF = 'Content-Security-Policy';
  const RO = 'Content-Security-Policy-Report-Only';
  // 判据是"全局那个 headers handler"：set 里含 X-Content-Type-Options（与实现同源）
  const pick = (srv) => {
    for (const r of (srv && srv.routes) || []) {
      for (const h of r.handle || []) {
        const st = (h.handler === 'headers' && h.response && h.response.set) || null;
        if (st && Object.prototype.hasOwnProperty.call(st, 'X-Content-Type-Options')) {
          return { enf: (st[ENF] || []).join('|') || '-', ro: (st[RO] || []).join('|') || '-',
                   others: Object.keys(st).filter((k) => k !== ENF && k !== RO).length };
        }
      }
    }
    return { enf: '-', ro: '-', others: -1 };
  };
  const a = pick(servers.srv0);
  const b = pick(servers.srv1);
  console.log('SRV0_ENF=' + a.enf);
  console.log('SRV0_RO=' + a.ro);
  console.log('SRV0_OTHERS=' + a.others);
  console.log('SRV1_ENF=' + b.enf);
  console.log('SRV1_RO=' + b.ro);
});
CSPJS

csp_run() { # tpl env... -> 提取器输出
  local tpl="$1"; shift
  env "$@" "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>/dev/null \
    | "${NODE_BIN}" "${CSP_EXTRACTOR}"
}
csp_get() { printf '%s\n' "${CSP_REPORT}" | sed -n "s/^$1=//p"; }

# --- 默认（未设任何变量）⇒ Report-Only，且**不发**强制头 ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=)"
assert_eq "$(csp_get SRV0_ENF)" "-" "默认**不发**强制 CSP 头（Report-Only 阶段绝不阻断任何资源）"
[[ "$(csp_get SRV0_RO)" == "default-src 'self'; script-src "* ]] \
  && pass "默认下发 Content-Security-Policy-Report-Only，且以 default-src 'self'; script-src 开头" \
  || fail "默认应下发 Report-Only 策略（得到 '$(csp_get SRV0_RO)'）"
assert_eq "$(csp_get SRV0_OTHERS)" "5" "原有 5 个安全响应头一个没少（加 CSP 没把它们顶掉）"
for frag in "object-src 'none'" "base-uri 'none'" "frame-ancestors 'self'" "form-action 'self'" \
            "img-src * data: blob:" "script-src 'self' 'unsafe-inline'" "frame-src 'self' https:"; do
  case "$(csp_get SRV0_RO)" in
    *"${frag}"*) pass "默认策略含 ${frag}" ;;
    *) fail "默认策略缺少 ${frag}（得到 '$(csp_get SRV0_RO)'）" ;;
  esac
done
case "$(csp_get SRV0_RO)" in
  *upgrade-insecure-requests*) fail "默认策略**不该**含 upgrade-insecure-requests（会打坏纯 HTTP 站点）" ;;
  *) pass "默认策略不含 upgrade-insecure-requests（纯 HTTP 站点不被打坏）" ;;
esac
case "$(csp_get SRV0_RO)" in
  *report-uri*) fail "未设 VANBLOG_CSP_REPORT_URI 时不该出现 report-uri" ;;
  *) pass "未设报告端点时不发 report-uri（默认不在本项目内收报告）" ;;
esac
# 80 端口也要有：与 HSTS 不同，CSP 在明文页面上是有意义的（保护被渲染的内容本身）
[[ "$(csp_get SRV1_RO)" == "default-src 'self'; script-src "* ]] \
  && pass "srv1(:80) 同样下发 CSP（与 HSTS 的决定相反：CSP 在明文页面上仍有意义）" \
  || fail "srv1(:80) 也应下发 CSP（得到 '$(csp_get SRV1_RO)'）"

# --- off ⇒ 两个头都不发 ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=off)"
assert_eq "$(csp_get SRV0_ENF)" "-" "mode=off 时不发强制头"
assert_eq "$(csp_get SRV0_RO)" "-" "mode=off 时也不发 Report-Only 头（off 就是完全不发）"
assert_eq "$(csp_get SRV0_OTHERS)" "5" "mode=off 时原有 5 个安全头仍在（关 CSP 不该连带关掉别的）"

# --- enforce ⇒ 换成强制头名，且 Report-Only 必须消失 ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=enforce)"
[[ "$(csp_get SRV0_ENF)" == "default-src 'self'; script-src "* ]] \
  && pass "mode=enforce 下发 Content-Security-Policy（强制头）" \
  || fail "mode=enforce 应下发强制头（得到 '$(csp_get SRV0_ENF)'）"
assert_eq "$(csp_get SRV0_RO)" "-" "mode=enforce 时 Report-Only 头必须被删掉（否则两条策略同时执行）"

# --- 垃圾值 ⇒ 回落默认 report，**绝不是 off** ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=abc)"
[[ "$(csp_get SRV0_RO)" == "default-src 'self'; script-src "* ]] \
  && pass "垃圾值 VANBLOG_CSP_MODE=abc 回落到默认 report（拼错不等于关掉安全头）" \
  || fail "垃圾值应回落默认 report（得到 ro='$(csp_get SRV0_RO)' enf='$(csp_get SRV0_ENF)'）"
assert_eq "$(csp_get SRV0_ENF)" "-" "垃圾值不会意外变成 enforce"
# ⚠️ 这里必须真的把垃圾值传进去（第一版忘了设变量，于是"没有 WARN"是被自己造出来的假失败）
CSP_WARN="$(env VANBLOG_CSP_MODE=abc "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>&1 >/dev/null | grep -c "VANBLOG_CSP_MODE='abc'")"
[[ "${CSP_WARN}" -ge 1 ]] && pass "垃圾值会打 WARN 点名该变量（站长能发现自己拼错了）" \
  || fail "垃圾值应打 WARN"

# --- 报告端点：合法值追加，非法值忽略 ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=report VANBLOG_CSP_REPORT_URI=https://log.example.invalid/csp)"
case "$(csp_get SRV0_RO)" in
  *"; report-uri https://log.example.invalid/csp"*) pass "设了合法 report-uri 时追加到策略末尾" ;;
  *) fail "合法 report-uri 应被追加（得到 '$(csp_get SRV0_RO)'）" ;;
esac
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=report "VANBLOG_CSP_REPORT_URI=javascript:alert(1)")"
case "$(csp_get SRV0_RO)" in
  *report-uri*) fail "非 http(s) 的 report-uri 必须被忽略，不能进策略" ;;
  *) pass "report-uri=javascript:… 被忽略（报告端点不能变成注入点）" ;;
esac

# --- 站长扩展入口：追加来源 / 整条改写 / 头注入 ---
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=enforce VANBLOG_CSP_EXTRA_SCRIPT_SRC=https://sdk.example.invalid)"
case "$(csp_get SRV0_ENF)" in
  *"script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://hm.baidu.com https://sdk.example.invalid"*)
    pass "EXTRA_SCRIPT_SRC 被追加进 script-src（站长自己的统计域名有出路）" ;;
  *) fail "EXTRA_SCRIPT_SRC 应追加进 script-src（得到 '$(csp_get SRV0_ENF)'）" ;;
esac
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=enforce "VANBLOG_CSP_EXTRA_SCRIPT_SRC=https://a.example; script-src *")"
case "$(csp_get SRV0_ENF)" in
  *"script-src *"*) fail "含分号的 EXTRA 必须整条忽略（同策略内重复指令只有第一条生效，追加会被静默忽略）" ;;
  *) pass "含分号的 EXTRA_SCRIPT_SRC 被整条忽略（不给'看起来配上了其实没生效'的旋钮）" ;;
esac
CSP_REPORT="$(csp_run "${TEMPLATE}" VANBLOG_CSP_MODE=enforce "VANBLOG_CSP_OVERRIDE=default-src 'none'; img-src 'self'")"
assert_eq "$(csp_get SRV0_ENF)" "default-src 'none'; img-src 'self'" "OVERRIDE 原样使用站长的策略（逃生口不'帮'站长改）"
CSP_INJECT="$(env VANBLOG_CSP_MODE=enforce "VANBLOG_CSP_EXTRA_SCRIPT_SRC=https://a.example
Set-Cookie: pwned=1" "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>/dev/null)"
case "${CSP_INJECT}" in
  *"Set-Cookie"*) fail "CRLF 头注入必须被拒（产出里出现了 Set-Cookie）" ;;
  *) pass "含 CR/LF 的 EXTRA 被整条忽略（这些值会进响应头，不允许头注入形状）" ;;
esac

# --- 降级模板也下发 CSP（与 HSTS 的决定相反，理由要写清）---
CSP_REPORT="$(csp_run "${FALLBACK}" VANBLOG_CSP_MODE=)"
[[ "$(csp_get SRV0_RO)" == "default-src 'self'; script-src "* ]] \
  && pass "降级模板同样下发 CSP（它服务的是同一份站点内容；HSTS 不加是因为自签证书+HSTS 会把站长锁在站外，CSP 没有这个失败模式）" \
  || fail "降级模板也应下发 CSP（得到 '$(csp_get SRV0_RO)'）"

# --- 恰好改写 2 处：0 处 = CSP 静默失效，3 处 = 挂错了地方 ---
CSP_COUNT="$(env VANBLOG_CSP_MODE=enforce "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>&1 >/dev/null \
  | sed -n 's/.*改写 \([0-9]*\) 处.*/\1/p' | head -1)"
assert_eq "${CSP_COUNT}" "2" "CSP 恰好挂到 2 处（srv0+srv1）；0 处意味着静默失效、3 处意味着挂错地方"

# --- 模板里**已经有**一条强制 CSP 时：off 必须摘掉它、report 必须换成 Report-Only ---
# 为什么单列一组：当前模板里没有任何 CSP 头，所以"切换模式时删掉另一个头"这段代码在
# 正常路径上是 no-op —— 变异对照删掉它时**一条都不红**（本轮实测过，M6 = 0 红）。
# 但它不是死代码：防的是"将来有人往模板里塞了一条强制 CSP"，那时 off/report 必须把它摘掉，
# 否则同一个响应上会**同时**挂着强制策略与 Report-Only 策略，浏览器两条都执行 ⇒
# 站长以为自己在"观察期"，其实已经在阻断资源了。⚠️ 这正是"0 红必须先解释"的用途：
# 这次 0 红不是变异没生效，而是**守卫没覆盖这个场景**，所以要补场景，不是丢掉变异。
CSP_PRESET="$(mktemp)"
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let n = 0;
for (const s of Object.values(d.apps.http.servers)) {
  for (const r of s.routes || []) for (const h of r.handle || []) {
    const st = h.handler === "headers" && h.response && h.response.set;
    if (st && Object.prototype.hasOwnProperty.call(st, "X-Content-Type-Options")) {
      st["Content-Security-Policy"] = ["BOGUS-PRESET-ENFORCED"];
      n += 1;
    }
  }
}
if (n !== 2) { console.error("预置失败：改写了 " + n + " 处，应为 2 处"); process.exit(1); }
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${CSP_PRESET}"
csp_run_tpl() { # tpl env... -> 提取器输出
  local tpl="$1"; shift
  env "$@" "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>/dev/null \
    | "${NODE_BIN}" "${CSP_EXTRACTOR}"
}
CSP_REPORT="$(csp_run_tpl "${CSP_PRESET}" VANBLOG_CSP_MODE=off)"
assert_eq "$(csp_get SRV0_ENF)" "-" "模板里预置了强制 CSP 时，mode=off 会把它摘掉（off 就是完全不发）"
assert_eq "$(csp_get SRV0_RO)" "-" "mode=off 也不会凭空多出一条 Report-Only"
CSP_REPORT="$(csp_run_tpl "${CSP_PRESET}" VANBLOG_CSP_MODE=report)"
assert_eq "$(csp_get SRV0_ENF)" "-" "模板里预置了强制 CSP 时，mode=report 会把它换成 Report-Only（不会两条并存）"
[[ "$(csp_get SRV0_RO)" == "default-src 'self'; script-src "* ]] \
  && pass "mode=report 时下发的是本脚本生成的策略（预置值被整值替换掉）" \
  || fail "mode=report 应下发内置策略（得到 '$(csp_get SRV0_RO)'）"
case "$(csp_run_tpl "${CSP_PRESET}" VANBLOG_CSP_MODE=report)" in
  *BOGUS-PRESET-ENFORCED*) fail "预置的强制策略没被替换掉（会与 Report-Only 并存，两条都被执行）" ;;
  *) pass "预置的 BOGUS 值确实被整值替换（不是追加）" ;;
esac
rm -f "${CSP_PRESET}"

# --- 跨文件不变量：与应用层那三条指令**逐字一致**（两条头会被浏览器同时执行）---
RL="${ROOT}/packages/server/src/utils/rateLimit.ts"
if [[ -f "${RL}" ]]; then
  RL_CSP="$(sed '/^[[:space:]]*#/d; s://.*$::' "${RL}" | grep -oE "frame-ancestors 'self'; object-src 'none'; base-uri 'none'" | head -1)"
  if [[ -z "${RL_CSP}" ]]; then
    fail "应用层 rateLimit.ts 里找不到那三条 CSP 指令的字面量（口径可能已变，请同步这里的断言）"
  else
    for frag in "frame-ancestors 'self'" "object-src 'none'" "base-uri 'none'"; do
      case "$(csp_get SRV0_RO)" in
        *"${frag}"*) pass "caddy 侧与应用层逐字一致的指令：${frag}" ;;
        *) fail "caddy 侧缺少 ${frag}（应用层有，两条头并存时会出现意外收紧）" ;;
      esac
    done
  fi
else
  echo "NOTE: 找不到 ${RL}，跳过跨文件一致性断言"
fi

# --- 反证：把 CSP 从产出里摘掉，提取器必须读出 '-'（否则上面那些 '-' 断言全是恒真）---
CSP_MUT="$(mktemp)"
env VANBLOG_CSP_MODE=enforce "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" permission 'me@example.com' 2>/dev/null > "${CSP_MUT}.json"
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const s of Object.values(d.apps.http.servers)) {
  for (const r of s.routes || []) for (const h of r.handle || []) {
    const st = h.handler === "headers" && h.response && h.response.set;
    if (st && Object.prototype.hasOwnProperty.call(st, "X-Content-Type-Options")) {
      delete st["Content-Security-Policy"];
      delete st["Content-Security-Policy-Report-Only"];
    }
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${CSP_MUT}.json" "${CSP_MUT}"
CSP_MUT_REPORT="$("${NODE_BIN}" "${CSP_MUT}" < /dev/null 2>/dev/null; "${NODE_BIN}" "${CSP_EXTRACTOR}" < "${CSP_MUT}")"
case "${CSP_MUT_REPORT}" in
  *"SRV0_ENF=-"*"SRV0_RO=-"*) pass "（反证）摘掉 CSP 后提取器确实读到 '-' —— 上面那些 '-' 断言不是恒真" ;;
  *) fail "（反证失败）摘掉 CSP 后提取器仍报有值（得到 '${CSP_MUT_REPORT}'）" ;;
esac
# 反证 2：把一条策略塞进"没有 X-Content-Type-Options 的 handler"，提取器**不该**认它
#         （证明判据真的是"全局那个 handler"，而不是"随便哪个 headers handler"）
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const r1 = d.apps.http.servers.srv0.routes[1];
r1.handle.unshift({ handler: "headers", response: { set: { "Content-Security-Policy": ["BOGUS-SENTINEL"] } } });
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${CSP_MUT}"
CSP_MUT2="$("${NODE_BIN}" "${CSP_EXTRACTOR}" < "${CSP_MUT}")"
case "${CSP_MUT2}" in
  *BOGUS-SENTINEL*) fail "（反证失败）提取器把非全局 handler 上的 CSP 也当成了结果" ;;
  *) pass "（反证）提取器只认全局那个 headers handler（挂在别处的 CSP 不会被误当成已生效）" ;;
esac
rm -f "${CSP_MUT}" "${CSP_MUT}.json" "${CSP_EXTRACTOR}"

# ─────────────────────────────────────────────────────────────────────────────
# VANBLOG_CADDY_HTML_PAGES_DIR：caddy 直服 ISR HTML 的产物目录
#
# 🔴 这一节钉的是一个**曾经静默失效**的旋钮：服务端 `provider/caddy/caddy.provider.ts`
#    用它决定哨兵文件写到哪个目录，而生成器以前对它命中 0 次、模板各自硬编码路径 ⇒
#    设了它，哨兵写到别处、caddy 仍在老地方找，`VANBLOG_CADDY_SERVE_HTML` 一声不响地失效。
#    站长已把"数据库不可达进入降级驻留时自动开直服"押在这个机制上，所以它必须真的生效。
#
# ⚠️ 断言一律跑**生成器的产物**（解析 JSON 后读 `vars.root` 的实际值），
#    不是 grep 模板里有没有这个变量名 —— 后者是空断言（import/注释就能让它通过）。
# ─────────────────────────────────────────────────────────────────────────────
echo "== VANBLOG_CADDY_HTML_PAGES_DIR（caddy 直服 HTML 的产物目录）=="

PD_EXTRACTOR="$(mktemp)"
cat > "${PD_EXTRACTOR}" <<'PDJS'
// 从 stdin 读一份生成好的 caddy 配置，报出：
//   groups      = group 为 vanblog-serve-html 的路由条数（期望 2：srv0+srv1）
//   pd_n        = 这些路由里 vars.root 的个数（期望 2）
//   pd_roots    = 这些 root 的去重值（逗号连接）
//   outside     = **该 group 之外**所有 vars.root 的去重排序值（竖线连接）
//                 ⚠️ 这一项是"没有误伤别处"的判据：静态图那条路由也有一个 vars handler
//                 （root=/app），它在**别的** group 里，所以不在 pd_roots 里、而在 outside 里。
//                 用"与基线逐字相同"来断言，而不是写死个数 —— 模板将来多一个 vars 也不必改断言，
//                 而任何被误改的 root 都会让它变。
//   sentinels   = 两个哨兵文件名是否都还在配置里（直服闸门靠 try_files 查它们的存在）
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(0, 'utf8'));
const roots = [];
const outside = [];
let groups = 0;
const collectVars = (n, sink) => {
  if (Array.isArray(n)) return n.forEach((x) => collectVars(x, sink));
  if (!n || typeof n !== 'object') return;
  if (n.handler === 'vars' && typeof n.root === 'string') sink.push(n.root);
  for (const k of Object.keys(n)) collectVars(n[k], sink);
};
const walk = (n, inside) => {
  if (Array.isArray(n)) return n.forEach((x) => walk(x, inside));
  if (!n || typeof n !== 'object') return;
  if (n.group === 'vanblog-serve-html') groups += 1;
  const nowInside = inside || n.group === 'vanblog-serve-html';
  if (n.handler === 'vars' && typeof n.root === 'string') (nowInside ? roots : outside).push(n.root);
  for (const k of Object.keys(n)) walk(n[k], nowInside);
};
walk(cfg, false);
const flat = JSON.stringify(cfg);
const sentinels =
  (flat.includes('.vanblog-caddy-serve-html-dynamic') ? 1 : 0) +
  (flat.includes('.vanblog-caddy-serve-html') ? 1 : 0);
console.log(
  `groups=${groups} pd_n=${roots.length} pd_roots=${[...new Set(roots)].sort().join(',') || '-'} ` +
    `outside=${[...new Set(outside)].sort().join('|') || '-'} sentinels=${sentinels}`,
);
PDJS

# 用某个取值（或 __unset__）跑生成器；$2 可换模板；stderr 走 $3（给了就存下来）
run_pd() {
  local tpl="${2:-$TEMPLATE}" errf="${3:-/dev/null}"
  if [[ "$1" == "__unset__" ]]; then
    env -u VANBLOG_CADDY_HTML_PAGES_DIR "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>"${errf}"
  else
    VANBLOG_CADDY_HTML_PAGES_DIR="$1" "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>"${errf}"
  fi
}

# 模板里的默认产物目录（从模板本身读，不写死在这里 ⇒ 模板改了这条断言自动跟着走）
PD_DEFAULT="$(run_pd __unset__ | "${NODE_BIN}" -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = [];
const wv = (n) => { if (Array.isArray(n)) return n.forEach(wv); if (!n || typeof n !== "object") return;
  if (n.handler === "vars" && typeof n.root === "string" && n.root !== "/app") out.push(n.root);
  for (const k of Object.keys(n)) wv(n[k]); };
const w = (n) => { if (Array.isArray(n)) return n.forEach(w); if (!n || typeof n !== "object") return;
  if (n.group === "vanblog-serve-html") { wv(n); return; } for (const k of Object.keys(n)) w(n[k]); };
w(c); console.log([...new Set(out)].join(","));')"
PD_ERR="$(mktemp)"

# 基线：未设置该变量时，serve-html **之外**的所有 vars.root（后面每个用例都必须与它逐字相同）
PD_OUTSIDE_BASE="$(run_pd __unset__ | "${NODE_BIN}" "${PD_EXTRACTOR}" | sed -n 's/.* outside=\([^ ]*\) .*/\1/p')"
if [[ -z "${PD_OUTSIDE_BASE}" ]]; then
  fail "取不到 outside 基线（提取器失效）⇒ 后面"没有误伤别处"那些断言都不可信"
else
  pass "取到 outside 基线='${PD_OUTSIDE_BASE}'（serve-html 之外的 vars.root，含静态图那条 root=/app）"
fi

# --- 未设置 = 完全沿用模板默认（本轮之前的行为，零变化）---
assert_eq "$(run_pd __unset__ | "${NODE_BIN}" "${PD_EXTRACTOR}")" \
  "groups=2 pd_n=2 pd_roots=${PD_DEFAULT} outside=${PD_OUTSIDE_BASE} sentinels=2" \
  "未设置 VANBLOG_CADDY_HTML_PAGES_DIR 时两个 server 都沿用模板默认目录，静态图的 root=/app 不受影响，两个哨兵闸门都还在"
assert_eq "$(run_pd __unset__ '' "${PD_ERR}" >/dev/null; grep -c '已被忽略' "${PD_ERR}")" "0" \
  "未设置时不打任何"已忽略"的 WARN（未设置是正常状态，不是错误）"

# --- 空串等同未设置（compose 里写 VAR= 很常见）---
assert_eq "$(run_pd '' | "${NODE_BIN}" "${PD_EXTRACTOR}")" \
  "groups=2 pd_n=2 pd_roots=${PD_DEFAULT} outside=${PD_OUTSIDE_BASE} sentinels=2" \
  "空串等同未设置：沿用模板默认，不做任何改写"

# --- 合法绝对路径：两个 server 都要改到（漏一个 = 一半流量直服失效）---
for tpl in "${TEMPLATE}" "${FALLBACK}"; do
  assert_eq "$(run_pd '/custom/pages/dir' "${tpl}" | "${NODE_BIN}" "${PD_EXTRACTOR}")" \
    "groups=2 pd_n=2 pd_roots=/custom/pages/dir outside=${PD_OUTSIDE_BASE} sentinels=2" \
    "$(basename "${tpl}")：合法绝对路径被应用到**两个** server，且没有误伤静态图那条 root=/app"
done

# --- 前后空白要被吃掉（compose 里手写 env 很容易带空格）---
assert_eq "$(run_pd '  /trimmed/dir  ' | "${NODE_BIN}" -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8")); const o = [];
const wv = (n) => { if (Array.isArray(n)) return n.forEach(wv); if (!n || typeof n !== "object") return;
  if (n.handler === "vars" && typeof n.root === "string" && n.root !== "/app") o.push(n.root);
  for (const k of Object.keys(n)) wv(n[k]); };
const w = (n) => { if (Array.isArray(n)) return n.forEach(w); if (!n || typeof n !== "object") return;
  if (n.group === "vanblog-serve-html") { wv(n); return; } for (const k of Object.keys(n)) w(n[k]); };
w(c); console.log([...new Set(o)].join(","));')" \
  "/trimmed/dir" "值两端的空白被吃掉（'/trimmed/dir' 而不是 '  /trimmed/dir  '）"

# --- 规范化：重复斜杠与结尾斜杠 ---
assert_eq "$(run_pd '/a//b///' | "${NODE_BIN}" "${PD_EXTRACTOR}" | grep -o 'pd_roots=[^ ]*')" \
  "pd_roots=/a/b" "'/a//b///' 被规范化成 '/a/b'（结尾斜杠会让 caddy 的 try_files 拼出 '//x.html' 这种形状）"
assert_eq "$(run_pd '/a//b///' '' "${PD_ERR}" >/dev/null; grep -c '已规范化' "${PD_ERR}")" "1" \
  "规范化会打一条 WARN 说明改了什么（不静默改写站长给的值）"

# --- 含空格的合法路径要接受（不是所有部署路径都没有空格）---
assert_eq "$(run_pd '/tmp/has space/pages' | "${NODE_BIN}" "${PD_EXTRACTOR}" | grep -o 'pd_n=[0-9]*')" "pd_n=2" \
  "含空格的绝对路径被接受（JSON 里不需要转义，caddy 实测也 validate 通过）"

# --- 🔴 拒绝的形状：全部回落到模板默认 + 大声 WARN（绝不是"关掉直服功能"）---
#    每一条的拒绝理由都有实测依据，写在生成器的注释里：
#    caddy validate 对 '/'、'{env.HOME}/x'、'/tmp/a/../b' **全部通过**（它只查 JSON 结构），
#    而 {env.X} 会在运行时被真展开（实测正对照 200 / 负对照 404）⇒ 只能在这里拦。
# ⚠️ 每条规则都必须有一个**只会被这条规则拦住**的取值，否则规则之间会互相掩盖：
#    变异对照实测过这个坑 —— 去掉"拒绝花括号"那条规则时守卫**一条都没红**，因为
#    '{env.HOME}/x' 根本不以 / 开头，早被"必须绝对路径"拦下了 ⇒ 那条用例证明不了花括号规则存在。
#    所以下面既有 'relative/path'（只测绝对路径规则），也有 '/pages/{env.SECRET}'
#    与 $'/evil\r\npath'（都是合法绝对路径，只可能被花括号/控制字符规则拦住）。
for bad in 'relative/path' './rel' '/tmp/a/../b' '{env.HOME}/x' '/pages/{env.SECRET}' '/' '///' \
           $'evil\r\nX' $'/evil\r\npath' $'evil\tname' $'/tab\there'; do
  label="$(printf '%s' "${bad}" | tr -d '\r\n\t' | cut -c1-24)"
  assert_eq "$(run_pd "${bad}" | "${NODE_BIN}" "${PD_EXTRACTOR}" | grep -o 'pd_roots=[^ ]*')" \
    "pd_roots=${PD_DEFAULT}" \
    "拒绝 '${label}'：root 回落模板默认（这个值会成为 file_server 的根，垃圾值有安全后果）"
  assert_eq "$(run_pd "${bad}" '' "${PD_ERR}" >/dev/null; grep -c '已被忽略' "${PD_ERR}")" "1" \
    "拒绝 '${label}' 时打一条 WARN，并说清"服务端仍会按这个值写哨兵 ⇒ 两侧不一致、直服不生效""
done

# --- 数量不对时要大声说（模板形状变了 ⇒ 旋钮可能只应用到一半）---
PD_MUT="$(mktemp)"
"${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rs = d.apps.http.servers.srv0.routes;
d.apps.http.servers.srv0.routes = rs.filter((r) => r.group !== "vanblog-serve-html");
fs.writeFileSync(process.argv[2], JSON.stringify(d));
' "${TEMPLATE}" "${PD_MUT}.json"
assert_eq "$(VANBLOG_CADDY_HTML_PAGES_DIR=/x "${NODE_BIN}" "${HELPER}" "${PD_MUT}.json" permission a@b.c 2>&1 >/dev/null | grep -c '模板形状变了')" "1" \
  "serve-html 路由少了一条时生成器会 WARN"模板形状变了"（旋钮只生效一半比完全不生效更难查）"
rm -f "${PD_MUT}.json"

# --- 🔴 跨文件不变量：TS 常量 == 两份模板里的 4 处 root ---
#    这是本缺陷的**真正根因**：同一个路径在 3 个地方（TS 1 处 + 模板 4 处）各写一遍，
#    而生成器一份都不写（它按结构定位，所以不可能与模板漂移 —— 下面单独钉住这一点）。
#    ⚠️ 跨语言（TS 源码 vs JSON 模板）所以只能在这里用文本提取，提取失败必须 fail 而不是跳过。
PD_TS_CONST="$(sed -n "s/^export const DEFAULT_WEBSITE_PAGES_DIR = '\([^']*\)';.*$/\1/p" \
  "${ROOT}/packages/server/src/provider/caddy/caddy.provider.ts" | head -1)"
if [[ -z "${PD_TS_CONST}" ]]; then
  fail "取不到 caddy.provider.ts 里的 DEFAULT_WEBSITE_PAGES_DIR（提取正则失效了，不是常量被删就是形状变了）"
else
  pass "取到 TS 常量 DEFAULT_WEBSITE_PAGES_DIR='${PD_TS_CONST}'（提取器有效，下面的一致性断言不是恒真）"
  assert_eq "${PD_DEFAULT}" "${PD_TS_CONST}" \
    "跨文件一致：两份模板里 serve-html 的 root（去重后）== TS 的 DEFAULT_WEBSITE_PAGES_DIR"
  PD_TPL_N="$("${NODE_BIN}" -e '
const fs = require("fs");
let n = 0; const vals = new Set();
for (const f of process.argv.slice(1)) {
  const wv = (x) => { if (Array.isArray(x)) return x.forEach(wv); if (!x || typeof x !== "object") return;
    if (x.handler === "vars" && typeof x.root === "string" && x.root !== "/app") { n += 1; vals.add(x.root); }
    for (const k of Object.keys(x)) wv(x[k]); };
  const w = (x) => { if (Array.isArray(x)) return x.forEach(w); if (!x || typeof x !== "object") return;
    if (x.group === "vanblog-serve-html") { wv(x); return; } for (const k of Object.keys(x)) w(k === "x" ? x[k] : x[k]); };
  w(JSON.parse(fs.readFileSync(f, "utf8")));
}
console.log(`${n} ${vals.size}`);' "${TEMPLATE}" "${FALLBACK}")"
  assert_eq "${PD_TPL_N}" "4 1" \
    "两份模板里恰好 4 处 root（每份 2 个 server）且**只有 1 个不同值**（4 处逐字相同）"
  # ⚠️ 负向对照：故意让一份模板漂移，上面的检测器必须报出来（否则"4 1"这条是恒真的）
  "${NODE_BIN}" -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const wv = (x) => { if (Array.isArray(x)) return x.forEach(wv); if (!x || typeof x !== "object") return;
  if (x.handler === "vars" && x.root === process.argv[3]) { x.root = "/DRIFTED/pages"; return; }
  for (const k of Object.keys(x)) wv(x[k]); };
const w = (x) => { if (Array.isArray(x)) return x.forEach(w); if (!x || typeof x !== "object") return;
  if (x.group === "vanblog-serve-html") { wv(x); return; } for (const k of Object.keys(x)) w(x[k]); };
w(d); fs.writeFileSync(process.argv[2], JSON.stringify(d));' "${TEMPLATE}" "${PD_MUT}.json" "${PD_TS_CONST}"
  PD_DRIFT="$("${NODE_BIN}" -e '
const fs = require("fs"); const vals = new Set();
const wv = (x) => { if (Array.isArray(x)) return x.forEach(wv); if (!x || typeof x !== "object") return;
  if (x.handler === "vars" && typeof x.root === "string" && x.root !== "/app") vals.add(x.root);
  for (const k of Object.keys(x)) wv(x[k]); };
const w = (x) => { if (Array.isArray(x)) return x.forEach(w); if (!x || typeof x !== "object") return;
  if (x.group === "vanblog-serve-html") { wv(x); return; } for (const k of Object.keys(x)) w(x[k]); };
w(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
console.log([...vals].sort().join(","));' "${PD_MUT}.json")"
  case "${PD_DRIFT}" in
    *DRIFTED*) pass "（反证）把模板里的 root 改掉后检测器确实读到了漂移值 —— 上面的一致性断言不是恒真" ;;
    *) fail "（反证失败）模板漂移了但检测器没读到（得到 '${PD_DRIFT}'）⇒ 一致性断言是空转的" ;;
  esac
  rm -f "${PD_MUT}.json"
fi

# --- 🔴 哨兵与 root 必须在**同一条**路由子树里（这正是本缺陷的机制核心）---
#    caddy 的闸门是 `file: {try_files: ["/.vanblog-caddy-serve-html"]}`，而 try_files 是
#    **相对当前 root 解析**的 ⇒ 哨兵必须在 root 指向的那个目录里。所以"服务端把哨兵写到 A、
#    caddy 的 root 指着 B"就等于功能没了，而且没有任何报错。
#    ⚠️ 顺带钉住一个实测结论：caddy 只判断哨兵**存不存在**，从不解析它的内容
#    （内容 `level=all; ...` 是给人看的），所以哨兵的**文件名**才是跨文件契约，内容格式不是。
assert_eq "$(run_pd '/sentinel/check/dir' | "${NODE_BIN}" -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
let ok = 0, bad = 0;
const w = (n) => {
  if (Array.isArray(n)) return n.forEach(w);
  if (!n || typeof n !== "object") return;
  if (n.group === "vanblog-serve-html") {
    const flat = JSON.stringify(n);
    const rootHere = flat.includes("\"root\":\"/sentinel/check/dir\"");
    const gates = flat.includes("/.vanblog-caddy-serve-html-dynamic") && flat.includes("/.vanblog-caddy-serve-html");
    if (rootHere && gates) ok += 1; else bad += 1;
    return;
  }
  for (const k of Object.keys(n)) w(n[k]);
};
w(c); console.log(`same_subtree=${ok} mismatched=${bad}`);')" \
  "same_subtree=2 mismatched=0" \
  "两个 server 的 serve-html 路由里，被改写的 root 与两个哨兵闸门在**同一条子树**（哨兵是相对 root 解析的 ⇒ 分开就等于直服失效）"

# --- 服务端三处解析点必须都在调**共用解析函数**（升级自"三处都是 env || DEFAULT"）---
#    这条守卫原本钉的是"三处都写成 `process.env[X] || DEFAULT`"，并在注释里写明
#    "如果是有意收敛成共用函数，请同步改这条守卫"。现在已经收敛了，所以按那句话升级：
#    判据从"三份表达式长得一样"变成"三份都在调同一个函数"——后者更强，因为它连
#    "校验规则只加在一处"这种漂移也一起挡住了（那正是本次修复前的缺陷形状）。
#    ⚠️ 规则本身的跨语言一致性由另外两处负责，别在这里重复实现：
#       - packages/server/src/provider/caddy/pagesDirParity.spec.ts（真跑 TS 与生成器两侧比对）
#       - scripts/tests/caddy-pages-dir-parity.test.sh（真跑生成器，验证可观测后果）
PD_SITES=0
for f in packages/server/src/provider/caddy/caddy.provider.ts \
         packages/server/src/utils/degradedServeHtml.ts \
         packages/server/src/provider/isr/artifactReaper.ts; do
  if grep -q 'resolveWebsitePagesDir(' "${ROOT}/${f}" \
     && ! grep -q 'SERVE_HTML_PAGES_DIR_ENV\] *|| *DEFAULT_WEBSITE_PAGES_DIR' "${ROOT}/${f}"; then
    PD_SITES=$((PD_SITES + 1))
  else
    fail "${f} 不再通过共用函数 resolveWebsitePagesDir 解析产物目录（或又出现了裸回落 env || DEFAULT）：三处会对同一个环境变量得出不同目录 ⇒ 哨兵写 A、file_server 读 B、产物删 C，直服静默失效"
  fi
done
assert_eq "${PD_SITES}" "3" \
  "服务端三处产物目录解析点都在调共用函数 resolveWebsitePagesDir（caddy.provider / degradedServeHtml / artifactReaper）"

# --- 生成器**不复制**那个路径字面量（所以它不可能与模板漂移）---
#    ⚠️ 断言的是**完整绝对路径**，不是 ".next/server/pages" 这个片段：
#    生成器的注释里确实提到过相对形状的 .next/server/pages（讲 CSP 内联脚本时），
#    用片段会把注释误判成"复制了字面量"。
assert_eq "$(grep -c '/app/website/packages/website/\.next/server/pages' "${HELPER}")" "0" \
  "生成器里 0 处硬编码那个绝对路径：改写点按 group 结构定位、默认值从模板里读 ⇒ 少一份需要人肉同步的副本"

rm -f "${PD_EXTRACTOR}" "${PD_ERR}"

# ══════════════════════════════════════════════════════════════════════════════
# 降级期直服 RSS / sitemap（生成期注入）
#
# 为什么要这件事：活体实测到「数据库启动期不可达 ⇒ 进入降级驻留」时，页面已经能由 caddy
# 按哨兵直发磁盘 HTML，但 `/rss/feed.xml` 与 `/sitemap.xml` 是 **503** ⇒ 「被打瘫时仍能发布
# 内容」这条能力**不含订阅源**，而 RSS 恰恰是敌意环境下最省流量、最难被阻断的发布通道。
# `/rss/*` 与 `/sitemap/*` 在 server 侧本来就是 `useStaticAssets` 静态目录（不是每请求动态生成），
# 所以直服的就是正常模式下 express 会发的同一批字节 ⇒ 没有引入新的陈旧度取舍。
#
# 🔴 必须覆盖别名路由：前台交给读者的地址是 `/feed.xml`（AuthorCard 的 href、RssButton 复制到
#    剪贴板的都是它），只门控 `/rss/*` 的话读者手里那个 URL 仍然 503 ⇒ 等于没修。
# ══════════════════════════════════════════════════════════════════════════════
FEED_EXTRACTOR="$(mktemp)"
cat > "${FEED_EXTRACTOR}" <<'NODE_EOF'
// 从生成产物里提取「降级直服 feed」这一层的可观测事实，压成一行 key=value 便于 shell 断言。
// ⚠️ 全部是**结构事实**（谁在谁前面、root 是什么、有没有 terminal），不是"文件里出现了某个词"。
const c = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const FEED = new Set(['/rss/*', '/sitemap.xml', '/feed.xml', '/feed.json', '/atom.xml']);
const gates = [];        // 每个门控子路由
const feedRoutes = [];   // 每条 feed 路由的顺序事实
const sentRoots = new Set();
const fileRoots = new Set();
const hdrs = new Set();
const sentinels = new Set();
let term = 0, proxyTail = 0, orderBad = 0, rewriteBeforeGateBad = 0, varsLeak = 0;

const walkHandlers = (arr, fn) => (Array.isArray(arr) ? arr.forEach((x) => fn(x)) : undefined);

const inspectGate = (el) => {
  const m = (el.match || [])[0] || {};
  const tf = (m.file || {}).try_files || [];
  tf.forEach((t) => sentinels.add(t));
  if (el.terminal === true) term += 1;
  const deep = (n) => {
    if (Array.isArray(n)) return n.forEach(deep);
    if (!n || typeof n !== 'object') return;
    if (n.handler === 'vars' && typeof n.root === 'string') fileRoots.add(n.root);
    if (n.handler === 'headers' && n.response && n.response.set) Object.keys(n.response.set).forEach((k) => hdrs.add(k));
    for (const k of Object.keys(n)) deep(n[k]);
  };
  deep(el.handle);
  gates.push(el);
};

const walkRoutes = (routes) => {
  if (!Array.isArray(routes)) return;
  for (const r of routes) {
    const paths = ((r.match || [])[0] || {}).path || [];
    const isFeed = paths.some((p) => FEED.has(p));
    if (isFeed) {
      const sub = ((r.handle || [])[0] || {}).routes || [];
      const seq = [];
      sub.forEach((el, i) => {
        const hs = (el.handle || []).map((h) => h && h.handler);
        if (el.match && (el.match[0] || {}).file) { seq.push('GATE'); inspectGate(el); }
        else if (hs.includes('rewrite') && hs.includes('reverse_proxy')) seq.push('REWRITE+PROXY');
        else if (hs.includes('rewrite')) seq.push('REWRITE');
        else if (hs.includes('reverse_proxy')) seq.push('PROXY');
        else if (hs.includes('vars')) seq.push('VARS');
        else seq.push(hs.join('|') || 'EMPTY');
      });
      feedRoutes.push(seq.join('>'));
      if (seq[seq.length - 1] === 'PROXY' || seq[seq.length - 1] === 'REWRITE+PROXY') proxyTail += 1;
      // 🔴 feed 路由内**不许**出现"root == serve-html 那个 pages 目录"的路由级 vars：
      //    哨兵 root 只能写在 file matcher 上，否则 pages 目录会泄漏给同一路由后面的
      //    reverse_proxy 分支，而且每次加功能都会改变 pages-dir 守卫统计的 root 集合。
      //    （第一版把这条写成对整份配置 grep，结果把 serve-html 路由**自己合法的** vars 也算进去了 ⇒ 假红。）
      for (const el of sub) {
        for (const h of (el.handle || [])) {
          if (h && h.handler === 'vars' && typeof h.root === 'string' && /\.next\/server\/pages$/.test(h.root)) varsLeak += 1;
        }
      }
      const gi = seq.indexOf('GATE'), pi = seq.lastIndexOf('PROXY'), ri = seq.indexOf('REWRITE');
      if (!(gi >= 0 && pi > gi)) orderBad += 1;                       // 门控必须在反代之前
      if (ri >= 0 && !(ri < gi)) rewriteBeforeGateBad += 1;           // 有 rewrite 时必须在门控之前
      // 哨兵目录来自 **file matcher 自己的 root 字段**（不是路由级 vars）：
      // try_files 相对 root 解析，而 matcher 的 root 只作用于这次存在性判断，
      // 不会把 pages 目录泄漏给同一路由后面的 reverse_proxy 分支。
      for (const el of sub) {
        const fm = ((el.match || [])[0] || {}).file;
        if (fm && typeof fm.root === 'string') sentRoots.add(fm.root);
      }
    }
    const inner = ((r.handle || [])[0] || {}).routes;
    if (Array.isArray(inner)) walkRoutes(inner);
    if (Array.isArray(r.handle)) r.handle.forEach((h) => h && h.handler === 'subroute' && walkRoutes(h.routes));
  }
};
const servers = ((c.apps || {}).http || {}).servers || {};
for (const sn of Object.keys(servers)) walkRoutes((servers[sn] || {}).routes);

// serve-html 路由的 root（哨兵真正所在的目录）—— 用来证明门控查的是同一个目录
let serveHtmlRoot = '';
const findSH = (n) => {
  if (serveHtmlRoot || Array.isArray(n)) { if (Array.isArray(n)) n.forEach(findSH); return; }
  if (!n || typeof n !== 'object') return;
  if (n.group === 'vanblog-serve-html') {
    const g = (x) => { if (serveHtmlRoot || Array.isArray(x)) { if (Array.isArray(x)) x.forEach(g); return; }
      if (!x || typeof x !== 'object') return;
      if (x.handler === 'vars' && typeof x.root === 'string') serveHtmlRoot = x.root;
      for (const k of Object.keys(x)) g(x[k]); };
    g(n.handle); return;
  }
  for (const k of Object.keys(n)) findSH(n[k]);
};
findSH(c);

const uniq = (x) => [...new Set(x)].sort().join(',');
console.log(
  `routes=${feedRoutes.length} shapes=${uniq(feedRoutes)} gates=${gates.length} term=${term}` +
  ` proxyTail=${proxyTail} orderBad=${orderBad} rwBad=${rewriteBeforeGateBad} varsLeak=${varsLeak}` +
  ` fileRoots=${uniq(fileRoots)} sentRoots=${uniq(sentRoots)} serveHtmlRoot=${serveHtmlRoot}` +
  ` sentinels=${uniq(sentinels)} hdrs=${uniq(hdrs)}`,
);
NODE_EOF

run_feed() { # <staticPath值|__unset__> <模板> [stderr文件]
  local tpl="${2:-$TEMPLATE}" errf="${3:-/dev/null}"
  if [[ "$1" == "__unset__" ]]; then
    env -u VAN_BLOG_STATIC_PATH "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>"${errf}"
  else
    VAN_BLOG_STATIC_PATH="$1" "${NODE_BIN}" "${HELPER}" "${tpl}" permission 'me@example.com' 2>"${errf}"
  fi
}
feed_rep() { run_feed "$1" "${2:-$TEMPLATE}" "${3:-/dev/null}" | "${NODE_BIN}" "${FEED_EXTRACTOR}"; }
# ⚠️ 前面补一个空格：报告行的**第一个** key 前面没有空格，`s/.* key=` 会匹配不到它
#    （第一版就是这样，`routes=` 恒为空 ⇒ 那条"10 条路由都识别了"的断言 got '' want 10）。
feed_get() { printf ' %s\n' "$1" | sed -n "s/.* $2=\([^ ]*\).*/\1/p"; }

FEED_ERR="$(mktemp)"
FEED_BASE="$(feed_rep __unset__ '' "${FEED_ERR}")"
if [[ -z "${FEED_BASE}" ]]; then
  fail "取不到降级直服 feed 的基线报告（提取器失效）⇒ 后面所有断言都不可信"
else
  pass "取到基线报告：$(printf '%s' "${FEED_BASE}" | cut -c1-96)…"
fi

# --- 覆盖面：5 条路由 × 2 个 server = 10，两个模板都要 ---
for tpl in caddyTemplate.json caddyFallbackTemplate.json; do
  R="$(feed_rep __unset__ "${tpl}")"
  assert_eq "$(feed_get "${R}" routes)" "10" \
    "${tpl}：5 条 feed/sitemap 路由 × 2 个 server 都被识别（少一条就说明路由判据漏了，例如 /sitemap.xml 这种带点的）"
  assert_eq "$(feed_get "${R}" gates)" "10" \
    "${tpl}：10 处都注入了门控（注入数 == 候选数 ⇒ 没有静默跳过）"
  assert_eq "$(feed_get "${R}" orderBad)" "0" "${tpl}：每条路由的门控都在 reverse_proxy **之前**（否则正常模式也会被直服）"
  assert_eq "$(feed_get "${R}" rwBad)" "0" \
    "${tpl}：别名路由的 rewrite 都在门控**之前**（URI 先改写成 /rss/… 再 strip 前缀，否则靠巧合命中文件）"
  assert_eq "$(feed_get "${R}" proxyTail)" "10" \
    "${tpl}：10 条路由**仍然以 reverse_proxy 收尾** ⇒ 哨兵不存在时行为与改动前一致（正常模式不受影响）"
  assert_eq "$(feed_get "${R}" term)" "10" \
    "${tpl}：每个门控都带 terminal:true（否则命中后会继续走反代，同一个请求既直服又反代）"
  # 🔴 root 必须是**最窄**的产物子目录，绝不能是 staticPath 本身
  assert_eq "$(feed_get "${R}" fileRoots)" "/app/static/rss,/app/static/sitemap" \
    "${tpl}：file_server 的 root 只有 <static>/rss 与 <static>/sitemap 两个最窄目录"
  # ⚠️ 这里**故意没有**再单独写一条"root 不许是 staticPath 本身"的 if/else：
  #    上面那条 `fileRoots` **精确相等**断言已经覆盖了它（变异对照 M1 把 root 放宽成 staticDir
  #    本身 ⇒ 红 12 条）。曾经写过那条冗余检查，变异对照 M5 把它短路成 `if false` 后**仍然全绿**
  #    —— 因为它的 `else` 分支照样 pass。这不是"守卫空转"（性质确实被覆盖），而是**纯冗余**：
  #    它只会虚增 pass 计数、让人误以为多了一层防护。⇒ 删掉，把证据留在这条注释里。
  #    🔴 为什么这件事重要：宽 root 的后果是**真实的数据泄露**（真 caddy 实测：root=<static> 时
  #    `/broad/tmp/full-restore-secret.tar.zst` → 200 拿到内容，而 `staticPath/tmp` 放的是
  #    in-flight 的整站恢复归档；`export/`、`img/`、`customPage/` 同样在其下），
  #    所以这一条必须由**能独立失败**的断言守着，而不是由一条永远 pass 的装饰守着。
  # 哨兵目录必须与 serve-html 路由**同一个**（跨 root 的 try_files 只能靠先设 vars root）
  assert_eq "$(feed_get "${R}" sentRoots)" "$(feed_get "${R}" serveHtmlRoot)" \
    "${tpl}：门控查哨兵用的 root 与 serve-html 路由的 root **完全一致**（否则哨兵写 A、这里查 B ⇒ 静默失效）"
  assert_eq "$(feed_get "${R}" sentinels)" "/.vanblog-caddy-serve-html" \
    "${tpl}：门控用**主哨兵**（fixed 与 all 两档都会写它；dynamic 哨兵只在 all 档写）"
  assert_eq "$(feed_get "${R}" hdrs)" "Cache-Control,X-Vanblog-Static-Feed" \
    "${tpl}：门控只设 Cache-Control 与标记头 ⇒ 故意不覆盖 Content-Type（caddy 推断 text/xml，express 给 application/xml，两者阅读器都接受；降级期的对照是 503）"
  # 🔴 feed 路由内不许有"root == pages 目录"的路由级 vars（哨兵 root 只能在 file matcher 上）
  assert_eq "$(feed_get "${R}" varsLeak)" "0" \
    "${tpl}：feed 路由内 0 个路由级 vars root=<pages 目录> ⇒ 哨兵 root 只在 file matcher 上，不泄漏给同一路由的 reverse_proxy 分支"
  # 正对照：哨兵目录确实被写进了 file matcher（否则上面那条 0 是"根本没写"造成的假绿）
  if printf '%s' "$(feed_get "${R}" sentRoots)" | grep -qE '\.next/server/pages|/alt/pages'; then
    pass "${tpl}：file matcher 上确实带了哨兵目录 root=$(feed_get "${R}" sentRoots)（上面那条 0 不是空转）"
  else
    fail "${tpl}：file matcher 上取不到哨兵目录 root（got '$(feed_get "${R}" sentRoots)'）⇒ 上面那条 varsLeak=0 是假绿"
  fi
done

# --- 哨兵文件名必须与服务端常量逐字相同（跨语言漂移绊线）---
TS_SENTINEL="$(sed -n "s/^export const CADDY_SERVE_HTML_SENTINEL = '\([^']*\)';.*$/\1/p" \
  "${ROOT}/packages/server/src/provider/caddy/caddy.provider.ts" | head -1)"
if [[ -z "${TS_SENTINEL}" ]]; then
  fail "从 caddy.provider.ts 提取不到 CADDY_SERVE_HTML_SENTINEL（提取器失效，不是"没有这条常量"）"
else
  assert_eq "$(feed_get "${FEED_BASE}" sentinels)" "/${TS_SENTINEL}" \
    "生成器写的哨兵文件名与服务端常量 CADDY_SERVE_HTML_SENTINEL 逐字相同（跨语言契约）"
fi

# --- VAN_BLOG_STATIC_PATH 生效（与 server 侧 loadConfig('static.path') 同一个 env、同一个默认值）---
R="$(feed_rep '/data/vanblog-static')"
assert_eq "$(feed_get "${R}" fileRoots)" "/data/vanblog-static/rss,/data/vanblog-static/sitemap" \
  "VAN_BLOG_STATIC_PATH 生效：两个 root 都跟着走（否则自定义 staticPath 的部署降级期直服会 404）"
assert_eq "$(feed_get "${R}" gates)" "10" "设了 VAN_BLOG_STATIC_PATH 时注入数不变（仍是 10）"

# --- 非法值一律回落默认 + WARN（失败方向必须是"保持能用"，绝不是让整份配置 validate 失败）---
for bad in 'relative/static' '/data/../etc' '/data/{env.HOME}/static' '/'; do
  R="$(feed_rep "${bad}" '' "${FEED_ERR}")"
  assert_eq "$(feed_get "${R}" fileRoots)" "/app/static/rss,/app/static/sitemap" \
    "VAN_BLOG_STATIC_PATH='${bad}' 被拒 ⇒ root 回落默认（绝不能是 ${bad}）"
  if [[ "${bad}" == '/' ]]; then
    if printf '%s' "$(feed_get "${R}" fileRoots)" | grep -qE '(^|,)/(rss|sitemap)(,|$)$'; then
      fail "root 变成了 /rss 或 /sitemap（文件系统根下）⇒ 拒绝规则没生效"
    else
      pass "VAN_BLOG_STATIC_PATH='/' 没有产出「文件系统根下的 rss/sitemap」这种 root"
    fi
  fi
  assert_eq "$(grep -c '已被忽略' "${FEED_ERR}")" "1" \
    "VAN_BLOG_STATIC_PATH='${bad}' 打了一条"已被忽略"的 WARN（静默回落会让运维以为生效了）"
done
# ⚠️ 逐层隔离：'{env.HOME}' 那条同时违反"必须绝对路径"，所以另配一个**只可能**被花括号规则拦住的取值
R="$(feed_rep '/data/{env.SECRET}/static' '' "${FEED_ERR}")"
assert_eq "$(feed_get "${R}" fileRoots)" "/app/static/rss,/app/static/sitemap" \
  "合法绝对路径里含 {} 占位符也被拒（caddy 运行时会展开 {env.X} ⇒ 等于把 file_server 的 root 交给环境变量）"
assert_eq "$(grep -c '占位符' "${FEED_ERR}")" "1" "拒绝理由点名了"占位符"（不是被"必须绝对路径"那条先拦下 ⇒ 规则逐层可辨）"
# 控制字符（CRLF 头注入形状）：值会进 JSON 配置
R="$(feed_rep $'/data/evil\r\nstatic' '' "${FEED_ERR}")"
assert_eq "$(feed_get "${R}" fileRoots)" "/app/static/rss,/app/static/sitemap" "含 CR/LF 的值被拒 ⇒ root 回落默认"
assert_eq "$(grep -c '控制字符' "${FEED_ERR}")" "1" "拒绝理由点名了"控制字符""
# 规范化：重复斜杠与结尾斜杠
R="$(feed_rep '//data//static//' '' "${FEED_ERR}")"
assert_eq "$(feed_get "${R}" fileRoots)" "/data/static/rss,/data/static/sitemap" \
  "重复斜杠与结尾斜杠被规范化（与 pages-dir 同一套规则；不规范化会让 root 字符串与 caddy 侧对不上）"
assert_eq "$(grep -c '规范化' "${FEED_ERR}")" "1" "规范化时打了 WARN 说明改了什么"
# 合法值不打"已被忽略"
run_feed '/data/ok-static' '' "${FEED_ERR}" >/dev/null
assert_eq "$(grep -c '已被忽略' "${FEED_ERR}")" "0" "合法的 VAN_BLOG_STATIC_PATH 不打任何"已被忽略"WARN（噪音会淹没真告警）"

# --- 与 pages-dir 联动：哨兵目录跟着 VANBLOG_CADDY_HTML_PAGES_DIR 走（两处必须始终同目录）---
R="$(VANBLOG_CADDY_HTML_PAGES_DIR='/alt/pages' run_feed __unset__ | "${NODE_BIN}" "${FEED_EXTRACTOR}")"
assert_eq "$(feed_get "${R}" sentRoots)" "/alt/pages" \
  "改了 VANBLOG_CADDY_HTML_PAGES_DIR 时，feed 门控查哨兵的 root 跟着变成同一个目录（哨兵与 root 必须同目录，try_files 才找得到）"
assert_eq "$(feed_get "${R}" sentRoots)" "$(feed_get "${R}" serveHtmlRoot)" \
  "联动之后两者仍然一致（这条是"半生效旋钮"那个缺陷的回归钉子）"

# --- 生成器里没有硬编码 /app/static（默认值来自常量，改写点按结构定位）---
# ⚠️ 必须**先剥 `//` 注释行**再数：常量定义上方那行注释里也写着 '/app/static'
#    （说明它与 server 侧 loadConfig 的默认值同源）。不剥注释就会数到 2 ⇒ 假红。
#    这是本仓库第 10 次踩"断言匹配到解释性注释"，方向是假红（之前几次多是假绿）。
# ⚠️ 剥注释要同时处理**两种**形状：`//` 行注释，以及 JSDoc 块注释（`/** … */` 单行形式、
#    和多行块里以 ` * ` 开头的行）。第一版只剥了 `//`，于是常量上方那句
#    `/** 与 server 侧 loadConfig('static.path','/app/static') … */` 被数成第二处 ⇒ 假红。
assert_eq "$(awk '{ line=$0; sub(/^[ \t]+/, "", line); if (line ~ /^\/\// || line ~ /^\/\*/ || line ~ /^\*/) next; print }' "${HELPER}" | grep -c "'/app/static'")" "1" \
  "生成器**代码**里 '/app/static' 只出现 1 次（= STATIC_DIR_DEFAULT 常量），没有散落的第二份字面量（已剥 // 与 JSDoc 块注释）"

rm -f "${FEED_EXTRACTOR}" "${FEED_ERR}"



echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
