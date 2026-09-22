#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 在 CI 里跑一个守卫脚本，失败时把要点转成 GitHub Actions 的 ::error annotations。
#
# 🔴 为什么需要它：job 日志用 deploy key 读不到（`/actions/jobs/<id>/logs` 返回
#    403 "Must have admin rights to Repository"），但 `/check-runs/<job-id>/annotations`
#    是**公开可读**的 ⇒ 把"哪几条断言失败 + passed=/failed= 汇总"写进 annotation，
#    下次红就能直接定位，而不必像本轮这样靠仿真环境去猜。
#    ⚠️ 本仓库已有先例：演练守卫的一条夹具空操作就是靠 annotations 一次性定位的。
#
# 🔴 退出码必须**原样透传**：wrapper 吞掉非 0 退出码 = 所有守卫静默失效。
#    用 `tee` + `PIPESTATUS[0]` 取守卫自己的 rc（管道的 rc 默认是最后一个命令的）。
#
# 用法：bash scripts/tests/run-guard.sh scripts/tests/<name>.test.sh
# ---------------------------------------------------------------------------
set -u

guard="${1:-}"
if [ -z "${guard}" ]; then
  echo "::error::run-guard.sh 需要一个守卫脚本路径参数"
  exit 9
fi
if [ ! -f "${guard}" ]; then
  echo "::error::run-guard.sh 找不到守卫脚本 ${guard}"
  exit 9
fi

log="${RUNNER_TEMP:-/tmp}/run-guard-$(basename "${guard}").log"

# ⚠️ 不用 set -e：本脚本里有多处 grep 可能无匹配（退出码 1），
#    在 -e 下会就地中止、annotation 永远打不出来（这正是既有 wrapper 注释里记过的坑）。
set +e
bash "${guard}" 2>&1 | tee "${log}"
rc=${PIPESTATUS[0]}
set -e 2>/dev/null || true

if [ "${rc}" -ne 0 ]; then
  # 失败的断言行（去重、限 20 条，避免淹没有用信息）
  grep -aE '^FAIL' "${log}" 2>/dev/null | sort -u | head -20 | while IFS= read -r l; do
    [ -n "${l}" ] && echo "::error::${guard} 断言失败 ${l}"
  done
  sum="$(grep -aoE 'passed=[0-9]+ failed=[0-9]+' "${log}" 2>/dev/null | tail -1)"
  if [ -n "${sum}" ]; then
    echo "::error::${guard} 汇总 ${sum}"
  else
    echo "::error::${guard} 没有输出 passed=/failed= 汇总行（脚本本身崩了？），rc=${rc}"
  fi
  echo "---- ${guard} 日志尾部 40 行 ----"
  tail -40 "${log}" 2>/dev/null
fi

exit "${rc}"
