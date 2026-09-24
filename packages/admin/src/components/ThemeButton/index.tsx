import { useEffect, useMemo, useRef } from 'react';
import { useIntl, useModel } from 'umi';
import { beforeSwitchTheme } from '../../services/van-blog/theme';
import style from './index.less';
export default function (props: { showText: boolean }) {
  const { current: currentTimer } = useRef<any>({ timer: null });
  const { initialState, setInitialState } = useModel('@@initialState');
  const intl = useIntl();
  // 🔴 与第一期/第二期既有的 t() 保持**同一个形状**（id + defaultMessage），
  //    这样「defaultMessage 与 zh-CN 语言包逐字相同」这条约定只有一处口径，
  //    并由 localePackParity 守卫钉住。
  const t = (id: string, defaultMessage: string, values?: Record<string, unknown>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const setTheme = (newTheme: 'auto' | 'light' | 'dark') => {
    const navTheme = beforeSwitchTheme(newTheme);
    // 函数式更新：这个函数也会在 10s 轮询定时器里被调用，闭包里的 initialState
    // 可能是很多轮渲染前的旧快照，直接展开会把并发更新的其它状态盖回去
    setInitialState((prev: any) => ({
      ...prev,
      theme: newTheme,
      settings: {
        ...prev?.settings,
        navTheme,
      },
    }));
  };
  const theme = useMemo(() => {
    return initialState?.theme || 'auto';
  }, [initialState]);
  const sysTheme = useMemo(() => {
    return initialState?.settings?.navTheme || 'light';
  }, [initialState]);
  const clearTimer = () => {
    clearInterval(currentTimer.timer);
    currentTimer.timer = null;
  };
  // 自动模式的定时轮询：与前台 website 的 ThemeButton 修的是同一个死功能 ——
  // 旧实现的 effect 依赖里有 setTimer/clearTimer 这些**每次渲染都新建**的闭包，
  // 于是每次重渲染 cleanup 都把 interval 清掉，而 body 被 hasInit 门闩挡住不重建：
  // 「自动主题每 10s 重新评估（跟随系统深色/昼夜）」实际上从未生效，也没有任何报错。
  // 现在定时器由这个只依赖 theme 值的 effect 独立管理。
  useEffect(() => {
    if (!String(theme).includes('auto')) {
      clearTimer();
      return undefined;
    }
    clearTimer();
    currentTimer.timer = setInterval(() => {
      setTheme('auto');
    }, 10000);
    return () => {
      clearTimer();
    };
  }, [theme]);

  const handleSwitch = () => {
    if (theme == 'light') {
      setTheme('dark');
    } else if (theme == 'dark') {
      setTheme('auto');
    } else {
      setTheme('light');
    }
  };
  const iconSize = 18;
  const textStyle = { marginLeft: 4 };
  return (
    <a className={style['theme-button']} onClick={handleSwitch}>
      <div
        style={{
          display: theme == 'light' ? 'flex' : 'none',
          height: iconSize,
        }}
        className={sysTheme == 'light' ? style['theme-icon'] : style['theme-icon-dark']}
      >
        <svg
          className="fill-gray-600"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 1024 1024"
          fill="currentColor"
          aria-label="light icon"
          width={iconSize}
          height={iconSize}
        >
          <path d="M952 552h-80a40 40 0 0 1 0-80h80a40 40 0 0 1 0 80zM801.88 280.08a41 41 0 0 1-57.96-57.96l57.96-58a41.04 41.04 0 0 1 58 58l-58 57.96zM512 752a240 240 0 1 1 0-480 240 240 0 0 1 0 480zm0-560a40 40 0 0 1-40-40V72a40 40 0 0 1 80 0v80a40 40 0 0 1-40 40zm-289.88 88.08-58-57.96a41.04 41.04 0 0 1 58-58l57.96 58a41 41 0 0 1-57.96 57.96zM192 512a40 40 0 0 1-40 40H72a40 40 0 0 1 0-80h80a40 40 0 0 1 40 40zm30.12 231.92a41 41 0 0 1 57.96 57.96l-57.96 58a41.04 41.04 0 0 1-58-58l58-57.96zM512 832a40 40 0 0 1 40 40v80a40 40 0 0 1-80 0v-80a40 40 0 0 1 40-40zm289.88-88.08 58 57.96a41.04 41.04 0 0 1-58 58l-57.96-58a41 41 0 0 1 57.96-57.96z"></path>
        </svg>
        {props.showText ? (
          <span style={textStyle} className="theme-text">
            {t('theme.light', '亮色模式')}
          </span>
        ) : null}
      </div>
      <div
        className={sysTheme == 'light' ? style['theme-icon'] : style['theme-icon-dark']}
        style={{
          display: theme == 'dark' ? 'flex' : 'none',
          height: iconSize,
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 1024 1024"
          fill="currentColor"
          aria-label="dark icon"
          width={iconSize}
          height={iconSize}
        >
          <path d="M524.8 938.667h-4.267a439.893 439.893 0 0 1-313.173-134.4 446.293 446.293 0 0 1-11.093-597.334A432.213 432.213 0 0 1 366.933 90.027a42.667 42.667 0 0 1 45.227 9.386 42.667 42.667 0 0 1 10.24 42.667 358.4 358.4 0 0 0 82.773 375.893 361.387 361.387 0 0 0 376.747 82.774 42.667 42.667 0 0 1 54.187 55.04 433.493 433.493 0 0 1-99.84 154.88 438.613 438.613 0 0 1-311.467 128z"></path>
        </svg>
        {props.showText ? (
          <span style={textStyle} className="theme-text">
            {t('theme.dark', '暗色模式')}
          </span>
        ) : null}
      </div>
      <div
        className={sysTheme == 'light' ? style['theme-icon'] : style['theme-icon-dark']}
        style={{
          display: theme.includes('auto') ? 'flex' : 'none',
          height: iconSize,
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={iconSize}
          height={iconSize}
          viewBox="0 0 1024 1024"
          fill="currentColor"
          aria-label="auto icon"
        >
          <path d="M512 992C246.92 992 32 777.08 32 512S246.92 32 512 32s480 214.92 480 480-214.92 480-480 480zm0-840c-198.78 0-360 161.22-360 360 0 198.84 161.22 360 360 360s360-161.16 360-360c0-198.78-161.22-360-360-360zm0 660V212c165.72 0 300 134.34 300 300 0 165.72-134.28 300-300 300z"></path>
        </svg>
        {props.showText ? (
          <span style={textStyle} className="theme-text">
            {t('theme.auto', '自动模式')}
          </span>
        ) : null}
      </div>
    </a>
  );
}
