import Image from "next/image";
import Head from "next/head";
import Link from "next/link";

import useT from "../hooks/useT";
export default function (props: { name?: string }) {
  // 🔴 期 10 第十一批：404 页的标题/句子/按钮走 i18n 接缝
  const t = useT();
  return (
    <>
      <Head>
        <title>
          {t("notFound.missingSentence", "此{thing}不存在", {
            thing: props?.name ? props.name : t("notFound.pageWord", "页面"),
          })}
        </title>
        <link rel="icon" href={"/logo.svg"}></link>
      </Head>
      <div
        className="flex items-center justify-center"
        style={{ top: 0, left: 0, bottom: 0, right: 0, position: "absolute" }}
      >
        <div
          className="flex flex-col items-center justify-center select-none vanblog-notfound"
          style={{ transform: "translateY(-30%)" }}
        >
          <Image alt="logo" src="/logo.svg" width={200} height={200} />
          <div className="mt-4 text-gray-600 font-base text-xl dark:text-dark">
            {t("notFound.missingSentence", "此{thing}不存在", {
              thing: props?.name ? props.name : t("notFound.pageWord", "页面"),
            })}
          </div>
          <Link href="/">
            <div className="mt-4 ua ua-link text-base text-gray-600 dark:text-dark">
              {t("notFound.backHome", "返回主页")}
            </div>
          </Link>
        </div>
      </div>
    </>
  );
}
