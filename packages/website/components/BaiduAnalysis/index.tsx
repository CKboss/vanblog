import Script from "next/script";
import { useEffect, useRef } from "react";
export default function (props: { id: string }) {
  const { current } = useRef<any>({ hasInit: false });
  useEffect(() => {
    if (!current.hasInit && props.id != "") {
      current.hasInit = true;
      var _hmt: any = _hmt || [];
    }
  }, [current, props]);
  return (
    <>
      {props.id != "" && (
        // lazyOnload：第三方统计不该和水合/首屏渲染抢资源（load 之后再加载）
        <Script
          src={`https://hm.baidu.com/hm.js?${encodeURIComponent(props.id)}`}
          strategy="lazyOnload"
        ></Script>
      )}
    </>
  );
}
