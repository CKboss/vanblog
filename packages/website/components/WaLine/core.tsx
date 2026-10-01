import "@waline/client/dist/waline.css";
import { useEffect } from "react";
import { init, commentCount } from "@waline/client";
// 🔴 **站长裁定（2026-10-01）：只翻译我们自己的部分，先不要把站点语种透传给 waline。**
//    ⇒ 这里**刻意不**给 waline 传 `locale` 选项：waline 是**外挂子进程 + 它自己的前端**，
//    它的界面文案由它自己的 locale 配置决定（不归我们翻，也不该由我们替它决定）。
//    ⚠️ 已知代价（裁定接受的）：站点语种切到英文时，waline 那套评论区**仍然是它自己的默认语言**。
//    👉 将来若要透传，要先解决"waline 支持的语种集合与我们的 {zh-CN, zh-TW, en-US} 不一致"
//    （映射表 + 不支持时的回落），并且要有真浏览器证据 —— 🔴 不是加一行 `locale: getLocale()` 就完事。
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
