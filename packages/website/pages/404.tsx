import Image from "next/image";
import Head from "next/head";
import Link from "next/link";

import useT from "../hooks/useT";
/**
 * 🔴 **站长裁定（2026-10-01）：404 页不要语言切换按钮。**
 *
 * 背景：期 10 第十一批的浏览器探针实测发现这一页**没有 NavBar**（它只渲染自己那段内容）⇒
 * 于是"访客最容易撞到的那一页恰恰是唯一不能切语言的页面"。当时把两条路都摆出来请站长裁定：
 * ① 给这一页加一个极简语种按钮；② 什么都不做、靠 cookie。
 * 👉 **裁定：②（保持现状）**。所以这一页**刻意不引入** `LocaleSwitcher`，
 * 语种完全依赖 cookie（在别的页面切过就跟着走；探针已实测过跨页持久化是有效的）。
 * ⚠️ 探针 `vanblog_dev/verify-chrome-i18n.cjs` 里有一条断言钉住"404 页**没有**切换按钮"——
 * 🔴 那条断言现在表达的是**站长的裁定**，不只是"当前状态"；将来若要改，先改裁定再改断言。
 */
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
          {/* 🔴 **站长裁定（2026-10-01）：补一个醒目的「404」**，让**所有语言**的访客都能立刻看懂这是 404。
              背景：这一页刻意**没有**语言切换按钮（同一条裁定，见文件头注释），
              所以非中文访客撞进来时，唯一能确定的信息就是这个**数字**。
              ⚠️ 它**刻意不过 i18n 接缝**：`404` 是**语言中立**的技术标识符
              （三份"译文"完全一样）⇒ 塞进词典只会多一份永远不会有差异、却要维护的条目，
              而且会让"词典覆盖率"这个指标虚高（🔴 指标要反映真实工作量，不能靠这种条目撑数字）。
              🔴 也**不加** `aria-hidden`：数字对读屏同样有意义（各语言读屏都念 "four hundred four"/"四百零四" 之类，
              配合下面那句已翻译的说明就够了）；刻意不加 `aria-label`，避免与可见文本不一致。
              🎨 视觉上：字号 96px、字重 800、字间距略宽，放在 logo 与说明文字之间
              ⇒ 一眼就能看到，且不抢"返回主页"那个出口。 */}
          <div
            className="vanblog-notfound-code mt-2 text-gray-800 dark:text-dark-100 select-none"
            style={{ fontSize: 96, lineHeight: 1, fontWeight: 800, letterSpacing: "0.04em" }}
          >
            404
          </div>
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
