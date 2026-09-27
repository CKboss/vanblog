import { useCallback, useEffect, useRef } from 'react';
import { history, useIntl, useModel } from 'umi';
import './index.css';
const Footer = () => {
  // 🔴 期 6 第十二批：接上 i18n。⚠️ 下面那个 useEffect 会把**算好的字符串**写进 state
  //    ⇒ 依赖数组必须带 t，否则切语言后 footer 仍是旧译文（§7.144 B）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const { initialState } = useModel('@@initialState');
  const { current } = useRef({ hasInit: false });
  // const version = useMemo(() => {
  //   let v = initialState?.version || '获取中...';
  //   if (history.location.pathname == '/user/login') {
  //     v = '登录后显示';
  //   }
  //   return v;
  // }, [initialState, history]);
  useEffect(() => {
    if (!current.hasInit) {
      current.hasInit = true;
      let v = initialState?.version || t('footer.fetchingVersion', '获取中...');
      if (history.location.pathname == '/user/login') {
        v = t('footer.showAfterLogin', '登录后显示');
      }
      console.log('🚀欢迎使用 VanBlog 博客系统');
      console.log('当前版本：', v);
      console.log('项目主页：', 'https://vanblog.mereith.com');
      console.log('开源地址：', 'https://github.com/mereithhh/van-blog');
      console.log('喜欢的话可以给个 star 哦🙏');
    }
    // 🔴 依赖数组带 t（回调体里用了它）
  }, [initialState, history, t]);
  return null;
  // return (
  //   <>
  //     <div className="footer" style={{ textAlign: 'center', marginTop: 32 }}>
  //       <p>
  //         <span>Powered By </span>
  //         <a className="ua" href="https://vanblog.mereith.com" target="_blank" rel="noreferrer">
  //           VanBlog
  //         </a>
  //       </p>
  //       <p>
  //         <span>版本: </span>
  //         <span> {version}</span>
  //       </p>
  //     </div>
  //   </>
  // );
};

export default Footer;
