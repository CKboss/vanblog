import { useEffect, useMemo, useState } from "react";
import CopyToClipboard from "react-copy-to-clipboard";
import toast from "react-hot-toast";

import useT from "../../hooks/useT";
export default function (props: {
  author: string;
  id: number | string;
  showDonate: boolean;
  copyrightAggreement: string;
  customCopyRight: string | null;
}) {
  // 🔴 期 10 第十一批：版权块的 6 处文案走 i18n 接缝
  const t = useT();
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl(`${location.protocol}//${location.host}${location.pathname}`);
  }, [setUrl]);

  const text = useMemo(() => {
    if (props.customCopyRight) return props.customCopyRight;
    // 🔴 期 10 第十一批：这是**整句模板**（原来是"前半句 + 协议名 + 换行 + 后半句"的拼接）⇒
    //    英文语序不同（`licensed under {license}`），只翻片段拼不出来。
    //    ⚠️ `{license}` 的值是**技术标识符**（例如 `CC BY-NC-SA 4.0`）⇒ 三份逐字相同、不翻。
    //    🔴 原文里那个换行 + 4 空格缩进是**模板串的产物**（会渲染成一个空格）⇒ 新文案里用一个空格，
    //    渲染结果与今天**逐字相同**（HTML 会把连续空白折叠成一个空格）。
    return t("copyright.licenseNotice", "本博客所有文章除特别声明外，均采用 {license} 许可协议。转载请注明出处！", {
      license: props.copyrightAggreement,
    });
  }, [props.customCopyRight, props.copyrightAggreement]);

  return (
    <div
      className={`bg-gray-100 px-5 border-l-4 border-red-500  py-2 text-sm space-y-1 dark:text-dark  dark:bg-dark ${
        !props.showDonate ? "mt-8" : ""
      }`}
    >
      <p>
        <span className="mr-2">{t("copyright.authorLabel", "本文作者:")}</span>
        <span>{props.author}</span>
      </p>
      <p>
        <span className="mr-2">{t("copyright.linkLabel", "本文链接:")}</span>
        <CopyToClipboard
          text={decodeURIComponent(url)}
          onCopy={() => {
            toast.success(t("copyright.copied", "复制成功！"), {
              className: "toast",
            });
          }}
        >
          <span
            className="cursor-pointer border-b border-gray-100 hover:border-gray-500 dark:text-dark dark-border-hover dark:border-nav-dark"
            style={{ wordBreak: "break-all" }}
          >
            {decodeURIComponent(url)}
          </span>
        </CopyToClipboard>
      </p>
      <p>
        <span className="mr-2">{t("copyright.declarationLabel", "版权声明:")}</span>
        <span>{text}</span>
      </p>
    </div>
  );
}
