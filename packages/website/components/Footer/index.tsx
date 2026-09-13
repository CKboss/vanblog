import ImageBox from "../ImageBox";
import RunningTime from "../RunningTime";
import Viewer from "../Viewer";

export default function ({
  ipcHref,
  ipcNumber,
  since,
  version,
  gaBeianLogoUrl,
  gaBeianNumber,
  gaBeianUrl,
}: {
  // 公安备案
  gaBeianNumber: string;
  gaBeianUrl: string;
  gaBeianLogoUrl: string;
  // ipc
  ipcNumber: string;
  ipcHref: string;
  since: string;
  version: string;
}) {
  return (
    <>
      <footer className="text-center text-sm space-y-1 mt-8 md:mt-12 dark:text-dark footer-icp-number">
        {Boolean(ipcNumber) && (
          <p className="">
            ICP 编号:&nbsp;
            <a
              href={ipcHref}
              target="_blank"
              className="hover:text-gray-900 hover:underline-offset-2 hover:underline dark:hover:text-dark-hover transition"
            >
              {ipcNumber}
            </a>
          </p>
        )}
        {Boolean(gaBeianNumber) && (
          <p className="flex justify-center items-center footer-gongan-beian">
            公安备案:&nbsp;
            {Boolean(gaBeianLogoUrl) && (
              <ImageBox
                src={gaBeianLogoUrl}
                lazyLoad={true}
                alt="公安备案 logo"
                width={20}
              />
            )}
            <a
              href={gaBeianUrl}
              target="_blank"
              className="hover:text-gray-900 hover:underline-offset-2 hover:underline dark:hover:text-dark-hover transition"
            >
              {gaBeianNumber}
            </a>
          </p>
        )}
        <RunningTime since={since}></RunningTime>
        <p className="footer-powered-by-vanblog">
          {/* 以前这里指向上游的文档站，但本站跑的是本 fork 的代码：
              访客点进去看到的说明与本站实际行为对不上（评论系统、皮肤、SEO 都不一样）。
              所以链接指向本分支仓库，并明确标出这是增强修改版；
              项目名仍然叫 VanBlog —— 它确实是 VanBlog，本分支遵循上游的 GPL v3，
              仓库 README / CHANGELOG / 后台「关于」页都有对原作者的致谢。 */}
          Powered By&nbsp;
          <a
            href="https://github.com/CKboss/vanblog"
            target={"_blank"}
            rel="noreferrer"
            title="VanBlog 增强修改版（CKboss/vanblog，分支 dev/dsh）"
            className="hover:text-gray-900 dark:hover:text-dark-hover transition ua ua-link"
          >
            VanBlog <span>{version}</span>
          </a>
          &nbsp;·&nbsp;
          <a
            href="https://github.com/CKboss/vanblog/blob/dev/dsh/README.md#本分支新增内容"
            target={"_blank"}
            rel="noreferrer"
            title="看看这个分支相对原版改了什么"
            className="hover:text-gray-900 dark:hover:text-dark-hover transition ua ua-link"
          >
            增强修改版
          </a>
        </p>

        <p className="select-none footer-copy-right">
          © {new Date(since).getFullYear()} - {new Date().getFullYear()}
        </p>
        <p className="select-none footer-viewer">
          <Viewer></Viewer>
        </p>
      </footer>
    </>
  );
}
