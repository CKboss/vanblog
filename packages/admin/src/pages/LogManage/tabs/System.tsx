import { getLog } from '@/services/van-blog/api';
import { Alert, Button, Card, Space, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import TerminalDisplay from '@/components/TerminalDisplay';
export default function () {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const timerRef = useRef<any>();
  const domRef = useRef();

  const fetchLog = async () => {
    // ⚠️ 以前这里是 `catch (err) {}` + 空 finally：接口一挂（server 重启、token 过期、
    // 日志文件读不出来）页面就静默停在旧内容/空白上，用户以为"没有日志"，
    // 控制台也一个字节都不留 —— "请求失败"和"没有数据"渲染成同一个样子。
    try {
      const { data } = await getLog('system', 1, 1000);
      const lines = Array.isArray(data?.data) ? data.data : [];
      // reverse() 会原地改数组，先浅拷贝一份再翻
      setContent(lines.slice().reverse().join('\n'));
      setError('');
    } catch (err) {
      console.error('[系统日志] 拉取失败', err);
      setError('日志拉取失败（server 不可达或会话过期），每 5 秒会自动重试');
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
      title="系统日志（每5s自动刷新）"
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
            手动刷新
          </Button>
        </Space>
      }
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message={error}
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
