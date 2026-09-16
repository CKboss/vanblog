import "@waline/client/dist/waline.css";
import { useEffect } from "react";
import { init, commentCount } from "@waline/client";
import {
  buildWalineInitOptions,
  WalineCommentSetting,
} from "../../utils/walineClient";
import { startWalineSession } from "./lifecycle";

async function loadCommentSetting(): Promise<WalineCommentSetting> {
  try {
    const res = await fetch("/api/public/comment-setting");
    const json = await res.json();
    return json?.data ?? {};
  } catch {
    // Keep Waline default when the setting endpoint is unavailable.
  }
  return {};
}

/**
 * ⚠️ 生命周期契约见 ./lifecycle.ts 顶部注释（旧实现有「父组件重渲染一次，
 * 评论区就被销毁且永不重建」+「设置请求在飞时重渲染 → 永不初始化」两个竞态）。
 * 这个组件现在只做两件事：把 (enable, visible) 两个**值**映射成一个 session，
 * 值不变就不动它；值变了/卸载了就 teardown。
 */
export default function (props: {
  enable: "true" | "false";
  visible: boolean;
}) {
  const enabled = Boolean(props.enable) && props.enable !== "false";
  const visible = props.visible === true;
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return startWalineSession({
      visible,
      serverURL: `${window.location.protocol}//${window.location.host}`,
      loadSetting: loadCommentSetting,
      // buildWalineInitOptions 返回 Record<string, unknown>，直接展开会让 TS
      // 认为对象字面量的每个字段都可能是 unknown（`next build` 会因此失败），
      // 所以收窄成 waline 认的值类型再展开（与旧实现同一手法）
      buildOptions: (setting) =>
        buildWalineInitOptions(setting) as Record<
          string,
          string | boolean | number
        >,
      init: (base, extra) => init({ ...base, ...extra }),
      commentCount: (options) => commentCount(options),
    });
  }, [enabled, visible]);
  if (!enabled) {
    return null;
  }
  return (
    <div
      id="waline"
      className="mt-2"
      style={{
        display: visible ? "block" : "none",
      }}
    ></div>
  );
}
