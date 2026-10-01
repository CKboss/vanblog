import { useState, useEffect } from "react";
import CopyToClipboard from "react-copy-to-clipboard";
import toast from "react-hot-toast";
import RssLogo from "../RssLogo";
import {
  HEADER_ACTION_LABELS,
  ICON_ACTION_BUTTON_CLASS,
  headerActionLabel,
} from "../NavBar/a11y";
import useT from "../../hooks/useT";

export default function (props: { showAdminButton: boolean }) {
  // 🔴 期 10 第四批：aria-label / title 走 i18n 接缝（渲染期取）
  const t = useT();
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl(`${location.protocol}//${location.host}/feed.xml`);
  }, [setUrl]);
  return (
    <CopyToClipboard
      text={url}
      onCopy={() => {
        toast.success(t("rss.copied", "已复制 RSS 订阅地址到剪切板！"), {
          className: "toast",
        });
      }}
    >
      <button
        type="button"
        title={headerActionLabel("rss", t)}
        aria-label={headerActionLabel("rss", t)}
        className={`${ICON_ACTION_BUTTON_CLASS} flex items-center justify-center cursor-pointer hover:scale-125 transform transition-all ${
          props.showAdminButton
            ? "mr-4 md:mr-6 lg:mr-2 "
            : "mr-4 md:mr-4 lg:mr-4"
        }`}
      >
        <span className="dark:text-dark text-gray-600" aria-hidden="true">
          <RssLogo size={20} />
        </span>
      </button>
    </CopyToClipboard>
  );
}
