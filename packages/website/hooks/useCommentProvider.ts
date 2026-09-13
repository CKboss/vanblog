import { useEffect, useState } from "react";
import { CommentProviderKind, loadCommentSetting } from "../utils/commentApi";

/**
 * 当前站点用哪一套评论系统。
 *
 * 首次渲染（含 SSR）一律返回 null，等客户端取到设置再更新，
 * 所以不会出现「服务端渲染一种、客户端水合成另一种」的不一致。
 */
export default function useCommentProvider(): CommentProviderKind | null {
  const [provider, setProvider] = useState<CommentProviderKind | null>(null);

  useEffect(() => {
    let alive = true;
    loadCommentSetting()
      .then((setting) => {
        if (alive && setting) {
          setProvider(setting.provider);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return provider;
}
