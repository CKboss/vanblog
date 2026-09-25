import {
  clearCaddyLog,
  getCaddyConfig,
  getCaddyLog,
  getHttpsConfig,
  setHttpsConfig,
} from '@/services/van-blog/api';
import ProForm, { ProFormSwitch } from '@ant-design/pro-form';
import { Alert, Button, Card, Input, message, Modal, Row, Space, Spin } from 'antd';
// 只用到 isEqual，整包 `import lodash from 'lodash'` 会把 lodash 全家桶拖进这个路由包
import isEqual from 'lodash/isEqual';
import { useMemo, useState } from 'react';
import { useIntl, useModel } from 'umi';

export default function (props) {
  const [loading, setLoading] = useState(false);
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 运行时还没初始化）。
  //    ⚠️ 本文件没有把 t 放进任何 useCallback/useEffect/useMemo 的依赖数组；将来若要放，
  //    🔴 必须先把 t 用 useCallback([intl]) 包起来（否则无限渲染/请求循环，见手册 §7.144 A、§7.145 A）。
  const [curData, setCurData] = useState(null);
  const [form] = ProForm.useForm();
  const { initialState } = useModel('@@initialState');
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const cls = useMemo(() => {
    if (initialState?.settings?.navTheme != 'light') {
      return 'dark-switch';
    } else {
      return '';
    }
  }, [initialState]);
  const updateHttpsConfig = async (data) => {
    setLoading(true);
    try {
      // 以前这两个 setTimeout 排在 `await setHttpsConfig` 之前，而且 catch 里也没取消：
      // 更新失败（比如 caddy 没起、配置写不进去）浏览器照样在 2 秒后 reload / 切协议，
      // 用户被甩到另一个协议上，还以为是自己点成功了。必须等接口真的成功再跳。
      await setHttpsConfig(data);
      setTimeout(() => {
        if (data.redirect) {
          window.location.reload();
        } else {
          window.location.replace(`http://${location.host}${location.pathname}`);
        }
      }, 2000);
      message.success(t('sysconf.caddy.changedOk', '更改成功！将自动刷新至新协议'));
      // let text = '关闭成功，现在可以通过 http 访问了。';
      // if (data.redirect) {
      //   text =
      //     '开启成功，现在通过 http 的访问将自动重定向到 https，这可能会导致无法通过 https + ip 访问本站。';
      // }
      // Modal.success({
      //   title: '更新成功！',
      //   content: text,
      // });
      return true;
    } catch (err) {
      message.error(t('sysconf.caddy.updateFailed', '更新失败！'));
      return false;
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card title={t('sysconf.caddy.card', 'HTTPS 相关配置')}>
      <Alert
        type="info"
        message={
          <div>
            <p>
              {/* 🔴 "文本 + 链接 + 文本"这种形状拆成 prefix/suffix 两个 key：
                  英文的语序与中文不同（VanBlog uses Caddy for …），只有让两侧各自成句才翻得对。 */}
              {t('sysconf.caddy.introPrefix', 'VanBlog 是通过')}{' '}
              <a target={'_blank'} rel="noreferrer" href="https://caddyserver.com/">
                Caddy
              </a>{' '}
              {t('sysconf.caddy.introSuffix', '实现的证书全自动按需申请。')}
              <a
                target={'_blank'}
                rel="noreferrer"
                // 上游这个地址已经 404
                href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/https.md"
              >
                {t('common.relatedDocs', '相关文档')}
              </a>
            </p>
            <p>{t('sysconf.caddy.advancedHint', '高级玩家可点击按钮查看 Caddy 运行日志或配置排查错误。')}</p>
            <p>{t('sysconf.caddy.accessLogHint', 'access 日志可进入容器 /var/log/vanblog-access.log 查看')}</p>
          </div>
        }
        style={{ marginBottom: 20 }}
      />
      <Alert
        type="warning"
        message={
          <div>
            <p>{t('sysconf.caddy.portsHint', '请确保 80/443 端口处于开放状态。')}</p>
            <p>
              {t(
                'sysconf.caddy.firstVisitHint',
                '第一次通过某域名 https 访问时，如果没有证书会自动申请证书的。你也可以点击下面的按钮手动触发证书申请。',
              )}
            </p>
            <p>
              {t(
                'sysconf.caddy.stableHint',
                '稳定后可打开 https 自动重定向功能，开启通过 http 访问将自动跳转至 https。开启后请用无痕窗口访问 http://你的域名 确认会跳到 https；也可点「查看 Caddy 配置」，srv1 的 listener_wrappers 应含 http_redirect。',
              )}
            </p>
            <p>
              {t(
                'sysconf.caddy.reverseProxyWarn',
                '如果你用了 80 端口反代，请不要开启 https 自动重定向！否则你的反代可能会失效。',
              )}
            </p>
            <p>
              {t('sysconf.caddy.stuckPrefix', '如果不小心开启了此选项后关不掉，可以参考：')}
              {/* 🔴 下面这个 href 里的中文锚点**刻意不翻**：它必须逐字对上 `docs/faq/usage.md` 里的中文标题
                  （站长已裁定文档暂不做 i18n ⇒ 文档仍是中文）。🔴 所以本文件在棘轮里的预算是 **1**（不是 0），
                  那 1 条就是这个 URL —— 它是**永久例外**，不是欠账。链接**文字**照翻（那才是给用户看的）。 */}
              <a
                href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/faq/usage.md#开启了-https-重定向后关不掉"
                target="_blank"
              >
                {t('sysconf.caddy.stuckLink', '开启了 https 重定向后关不掉')}
              </a>
            </p>
          </div>
        }
        style={{ marginBottom: 20 }}
      />

      <Spin spinning={loading}>
        <ProForm
          form={form}
          request={async () => {
            setLoading(true);
            try {
              const { data: res } = await getHttpsConfig();
              setLoading(false);
              if (!res) {
                setCurData({
                  redirect: false,
                });
                return {
                  redirect: false,
                };
              }
              setCurData(res);

              return res;
            } catch (err) {
              setLoading(false);
            }
          }}
          layout="horizontal"
          onFinish={async (data) => {
            if (location.hostname == 'blog-demo.mereith.com') {
              Modal.warning({
                title: t('sysconf.caddy.demoBlocked', '演示站不可修改此选项，不然怕 k8s ingress 失效'),
              });
              setLoading(false);
              return;
            }
            const eq = isEqual(curData, data);

            if (eq) {
              Modal.warning({
                title: t('sysconf.caddy.noChange', '未修改任何信息，无需保存！'),
              });
              setLoading(false);
              return;
            }
            let text = t(
              'sysconf.caddy.confirmOff',
              '确定关闭 https 自动重定向吗？关闭后可通过 http 进行访问。点击确定后 2 秒将自动切换到 http 访问',
            );
            if (data.redirect) {
              text = t(
                'sysconf.caddy.confirmOn',
                '开启 https 自动重定向之前，请确保通过域名可正常用 https 访问本站。开启将无法使用 http 访问本站。点击确定后 2 秒将自动切换到 https 访问。注意如果是自己反代了 80 端口的话，请务必不要开启此项！',
              );
            }
            Modal.confirm({
              title: text,
              onOk: () => {
                updateHttpsConfig(data);
              },
            });
          }}
          submitter={{
            searchConfig: {
              submitText: t('common.save', '保存'),
            },
            render: (props, doms) => {
              return (
                <>
                  <Row>
                    <Space>
                      <>{doms}</>
                      <Button
                        onClick={async () => {
                          setLoading(true);
                          try {
                            const { data: res } = await getCaddyConfig();
                            if (res) {
                              Modal.info({
                                title: t('sysconf.caddy.configTitle', 'Caddy 配置'),
                                content: (
                                  <Input.TextArea
                                    autoSize={{ maxRows: 20, minRows: 15 }}
                                    value={res}
                                  />
                                ),
                              });
                            }
                          } catch (err) {
                            message.error(t('sysconf.caddy.configError', '获取 Caddy 配置错误！'));
                          } finally {
                            setLoading(false);
                          }
                        }}
                        type="primary"
                      >
                        {t('sysconf.caddy.viewConfig', '查看 Caddy 配置')}
                      </Button>
                    </Space>
                  </Row>
                  <Row style={{ marginTop: 10 }}>
                    <Space>
                      <Button
                        type="primary"
                        onClick={async () => {
                          setLoading(true);
                          try {
                            const { data: res } = await getCaddyLog();
                            if (res || res == '') {
                              Modal.info({
                                title: t('sysconf.caddy.logTitle', 'Caddy 运行日志'),
                                content: (
                                  <Input.TextArea
                                    autoSize={{ maxRows: 20, minRows: 15 }}
                                    value={res}
                                  />
                                ),
                              });
                            } else {
                              message.error(t('sysconf.caddy.logError', '获取 Caddy 日志错误！'));
                            }
                          } catch (err) {
                            message.error(t('sysconf.caddy.logError', '获取 Caddy 日志错误！'));
                          } finally {
                            setLoading(false);
                          }
                        }}
                      >
                        {t('sysconf.caddy.viewLog', '查看 Caddy 日志')}
                      </Button>
                      <Button
                        danger
                        type="primary"
                        onClick={async () => {
                          Modal.confirm({
                            title: t(
                              'sysconf.caddy.clearLogConfirm',
                              '确定清除 Caddy 运行日志吗？清除后将无法恢复！',
                            ),
                            onOk: async () => {
                              await clearCaddyLog();
                              message.success(t('sysconf.caddy.clearLogOk', '清除 Caddy 运行日志成功！'));
                            },
                          });
                        }}
                      >
                        {t('sysconf.caddy.clearLog', '清除 Caddy 日志')}
                      </Button>
                    </Space>
                  </Row>
                  <Row style={{ marginTop: 10 }}>
                    <Button
                      type="primary"
                      onClick={async () => {
                        Modal.confirm({
                          title: t('sysconf.caddy.triggerCertTitle', '触发证书按需申请'),
                          content: t(
                            'sysconf.caddy.triggerCertContent',
                            '点击确认后将打开新窗口并用 https 访问当前网址以触发证书按需申请。触发请后稍等一会（申请时间取决于网络环境），申请完成后弹出页面将通过 https 正常加载。',
                          ),
                          onOk: () => {
                            window.open(`https://${window.location.host}`, '_blank');
                          },
                        });
                      }}
                    >
                      {t('sysconf.caddy.triggerCertBtn', '使用当前访问域名触发按需申请')}
                    </Button>
                  </Row>
                </>
              );
            },
          }}
        >
          <ProFormSwitch
            label={t('sysconf.caddy.redirectLabel', 'HTTPS 自动重定向')}
            name="redirect"
            tooltip={t('sysconf.caddy.redirectTooltip', '开启后通过 http 访问本站将自动重定向至 https')}
            fieldProps={{
              className: cls,
            }}
          ></ProFormSwitch>
          {/* <ProFormSelect
            name="domains"
            mode="tags"
            disabled
            width={'lg'}
            label="自动 HTTPS 域名"
            tooltip="开启自动 HTTPS 域名，内置的 Caddy 会自动申请证书并应用"
            placeholder={'添加后，内置的 Caddy 会自动申请证书并应用'}
          /> */}
          {/* <ProFormTextArea
            disabled
            name="caddyConfig"
            label={
              <a
                href="https://picgo.github.io/PicGo-Core-Doc/zh/guide/config.html#%E8%87%AA%E5%8A%A8%E7%94%9F%E6%88%90"
                target={'_blank'}
                rel="norefferrer"
              >
                Caddy 配置
              </a>
            }
            tooltip={'内置 Caddy2 配置，不懂忽略就行'}
            placeholder="内置 Caddy2 配置，不懂忽略就行"
            fieldProps={{
              autoSize: {
                minRows: 10,
                maxRows: 30,
              },
            }}
          /> */}
        </ProForm>
      </Spin>
    </Card>
  );
}
