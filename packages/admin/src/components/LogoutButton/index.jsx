import { logout } from '@/services/van-blog/api';
import { message } from 'antd';
import { history, useModel } from 'umi';
const loginOut = async () => {
  // 登出接口本身就可能失败：token 早就失效时服务端返回 401，
  // 以前这个 await 会把异常一路抛出去，下面的跳转和 removeItem('token') 全被跳过 ——
  // 结果是「半登出」：initialState 里的 user 已经清了，token 还留在 localStorage，
  // 页面也没跳到登录页，只能手动刷新。所以不管接口成功与否都要清本地态 + 跳转。
  // skipErrorHandler：这是用户主动登出，不需要再弹一条「登录失效」。
  let ok = true;
  try {
    await logout({ skipErrorHandler: true });
  } catch (err) {
    ok = false;
  }

  const { pathname } = history.location;

  window.localStorage.removeItem('token');
  if (pathname !== '/user/login') {
    history.replace({
      pathname: '/user/login',
      // search: stringify({
      //   redirect: pathname + search,
      // }),
    });
  }
  return ok;
};
export default function (props) {
  const { setInitialState } = useModel('@@initialState');
  const { trigger } = props;
  return (
    <div
      onClick={() => {
        setInitialState((s) => ({ ...s, user: undefined }));
        loginOut()
          .then((ok) => {
            // 服务端可能本来就没这个会话了，但本地确实已经登出，仍然要给一个明确反馈
            message.success(ok ? '登出成功！' : '已退出登录（服务端会话已失效）');
          })
          .catch(() => {
            message.success('已退出登录');
          });
      }}
    >
      {trigger}
    </div>
  );
}
