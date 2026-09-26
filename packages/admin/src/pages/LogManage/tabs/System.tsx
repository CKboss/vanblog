import { getLog } from '@/services/van-blog/api';
import { Alert, Button, Card, Space, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import TerminalDisplay from '@/components/TerminalDisplay';
import { useIntl } from 'umi';
export default function () {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  // 🔴 这里存的是**布尔标记**而不是文案：`fetchLog` 被 `setInterval(fetchLog, 5000)` 抓住，
  //    而 `useEffect(..., [])` 只跑一次 ⇒ interval 里的 fetchLog 永远是**首次渲染的闭包**，
  //    如果把 t() 的结果存进 state，🔴 切语言之后新出现的错误提示仍然是旧语言（§7.144 B 的陈旧语言闭包）。
  //    ⇒ 只存"出错了"，文案在渲染期由 t() 现取。
  const [error, setError] = useState(false);
  const timerRef = useRef<any>();
  const domRef = useRef();
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  //    `values` 用 `Record<string, any>`：写 `unknown` 会报 **TS2769**（这个形状在仓库里复制过 4 次）。
  // ⚠️ 🔴 本文件的 `fetchLog` 会被 `setInterval(fetchLog, 5000)` 抓住，而 `useEffect(..., [])` 只跑一次 ⇒
  //    那个 interval 里的 `fetchLog` 是**首次渲染时的闭包**（🔴 切语言后它仍然用旧语言写 setError，
  //    这就是 §7.144 B 说的"陈旧语言闭包"）。本文件的处理：错误文案**不存进 state**，
  //    而是存一个"出错了"的布尔标记，文案在渲染期由 t() 现取（见下面 error 的用法）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);

  const fetchLog = async () => {
    // ⚠️ 以前这里是 `catch (err) {}` + 空 finally：接口一挂（server 重启、token 过期、
    // 日志文件读不出来）页面就静默停在旧内容/空白上，用户以为"没有日志"，
    // 控制台也一个字节都不留 —— "请求失败"和"没有数据"渲染成同一个样子。
    try {
      const { data } = await getLog('system', 1, 1000);
      const lines = Array.isArray(data?.data) ? data.data : [];
      // reverse() 会原地改数组，先浅拷贝一份再翻
      setContent(lines.slice().reverse().join('\n'));
      setError(false);
    } catch (err) {
      // 🔴 这句 console.error 的中文**刻意不翻**：控制台/日志是**开发者界面**，
      //    翻了会让日志文本跟着界面语言漂（按文本 grep 日志、以及 leakAndErrorHardening 那条
      //    "这个文件必须打 console.error" 的钉子都会失效）。它已经被 bareChinese 的口径排除（§7.153 A）。
      console.error('[系统日志] 拉取失败', err);
      setError(true);
    }
  };
  useEffect(() => {
    setLoading(true);
    fetchLog()
      .then(() => {
        setTimeout(() => {
          if (domRef.current) {
            domRef.current.scrollTop = domRef.current?.scrollHeight;
          }
        }, 10);
      })
      .finally(() => {
        setLoading(false);
      });
    timerRef.current = setInterval(fetchLog, 5000);
    return () => {
      clearInterval(timerRef.current);
    };
  }, []);
  return (
    <Card
      title={t('log.systemCardTitle', '系统日志（每5s自动刷新）')}
      extra={
        <Space>
          <Button
            type="primary"
            onClick={() => {
              setLoading(true);
              fetchLog().finally(() => {
                setLoading(false);
                setTimeout(() => {
                  if (domRef.current) {
                    domRef.current.scrollTop = domRef.current?.scrollHeight;
                  }
                }, 10);
              });
            }}
          >
            {t('common.manualRefresh', '手动刷新')}
          </Button>
        </Space>
      }
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message={t(
            'log.systemFetchFailed',
            '日志拉取失败（server 不可达或会话过期），每 5 秒会自动重试',
          )}
        />
      ) : null}
      <Spin spinning={loading}>
        <pre
          ref={domRef}
          style={{
            maxHeight: 'calc(100vh - 250px)',
            height: 'calc(100vh - 250px)',
            minHeight: 'calc(100vh - 250px)',
            overflowY: 'auto',
          }}
        >
          <TerminalDisplay content={content} />
        </pre>
      </Spin>
    </Card>
  );
}
