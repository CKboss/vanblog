import {
  activeISR,
  getISRConfig,
  getLoginConfig,
  updateISRConfig,
  updateLoginConfig,
} from '@/services/van-blog/api';
import { ProForm, ProFormDigit, ProFormSelect } from '@ant-design/pro-form';
import { Alert, Button, Card, message, Modal } from 'antd';
import { useState } from 'react';
import { useIntl } from 'umi';
export default function (props) {
  const [isrLoading, setIsrLoading] = useState(false);
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 运行时还没初始化）。
  //    t() 的第二个实参是 defaultMessage，必须与 zh-CN 语言包逐字相同（localePackParity 钉住）。
  //    ⚠️ 本文件没有把 t 放进任何 useCallback/useEffect 的依赖数组；将来若要放，
  //    🔴 必须先把 t 用 useCallback([intl]) 包起来（否则会造成无限渲染/请求循环，见手册 §7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      <Card title={t('sysconf.advance.loginCard', '登录安全策略')}>
        <Alert
          type="warning"
          message={t(
            'sysconf.advance.retryLockedAlert',
            '开启最大登录失败次数限制目前还不稳定！暂时先不可配置，稳定后开放。',
          )}
          style={{ marginBottom: 8 }}
        />
        <ProForm
          grid={true}
          layout={'horizontal'}
          request={async (params) => {
            try {
              const { data } = await getLoginConfig();
              return data || { enableMaxLoginRetry: false };
            } catch (err) {
              console.log(err);
              return { enableMaxLoginRetry: false };
            }
          }}
          syncToInitialValues={true}
          onFinish={async (data) => {
            if (location.hostname == 'blog-demo.mereith.com') {
              Modal.info({ title: t('sysconf.advance.demoBlockedLogin', '演示站禁止修改登录安全策略！') });
              return;
            }
            await updateLoginConfig(data);
            message.success(t('common.updateSuccess', '更新成功！'));
          }}
        >
          <ProFormSelect
            disabled={true}
            name={'enableMaxLoginRetry'}
            label={t('sysconf.advance.maxRetryLabel', '开启最大登录失败次数限制')}
            fieldProps={{
              options: [
                {
                  label: t('common.enabled', '开启'),
                  value: true,
                },
                {
                  label: t('common.disabled', '关闭'),
                  value: false,
                },
              ],
            }}
            placeholder={t('common.disabled', '关闭')}
            tooltip={t(
              'sysconf.advance.maxRetryTooltip',
              '设置里没有显式关掉时是开启的：同一访客 IP 连续登录失败 5 次后要等 5 分钟才能再试（服务端默认值；此项在界面里是锁定的）',
            )}
          ></ProFormSelect>
          <ProFormDigit
            name={'expiresIn'}
            label={t('sysconf.advance.expiresInLabel', '登录凭证(Token)有效期(秒)')}
            placeholder={t('sysconf.advance.expiresInPlaceholder', '默认为 7 天')}
            tooltip={t(
              'sysconf.advance.expiresInTooltip',
              '默认为 7 天。最小 60 秒：这个值会原样进 JWT 的 expiresIn，0/负数会让签出来的 token 立刻过期（登录看起来成功、下一个请求就被踢回登录页），所以在表单这一层就夹住。',
            )}
            min={60}
            fieldProps={{ precision: 0 }}
          />
        </ProForm>
      </Card>

      <Card title={t('sysconf.advance.isrCard', '静态页面更新策略')} style={{ marginTop: 8 }}>
        <Alert
          type="info"
          message={
            <a
              rel="noreferrer"
              target="_blank"
              // 上游这个地址已经 404
              href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/isr.md"
            >
              {t('init.wizard.helpDoc', '帮助文档')}
            </a>
          }
          style={{ marginBottom: 8 }}
        />
        <ProForm
          grid={true}
          layout={'horizontal'}
          request={async (params) => {
            try {
              const { data } = await getISRConfig();
              console.log(data);
              return data;
            } catch (err) {
              console.log(err);
              return {};
            }
          }}
          syncToInitialValues={true}
          onFinish={async (data) => {
            if (location.hostname == 'blog-demo.mereith.com') {
              Modal.info({ title: t('sysconf.advance.demoBlockedIsr', '演示站禁止修改静态页面更新策略！') });
              return;
            }
            await updateISRConfig(data);
            message.success(t('common.updateSuccess', '更新成功！'));
          }}
        >
          <ProFormSelect
            name={'mode'}
            label={t('sysconf.advance.isrCard', '静态页面更新策略')}
            fieldProps={{
              options: [
                {
                  label: t('sysconf.advance.isrModeDelay', '延时自动'),
                  value: 'delay',
                },
                {
                  label: t('sysconf.advance.isrModeOnDemand', '按需自动'),
                  value: 'onDemand',
                },
              ],
            }}
            tooltip={t(
              'sysconf.advance.isrModeTooltip',
              '默认「按需自动」：后台有改动时由后端立刻触发重渲染，实时性高、可能需要更多性能。改成「延时自动」则按下面的秒数周期性重建。',
            )}
          ></ProFormSelect>
          <ProFormDigit
            name={'delay'}
            label={t('sysconf.advance.delayLabel', '延时自动更新时间(秒)')}
            tooltip={t(
              'sysconf.advance.delayTooltip',
              '仅在「延时自动更新」模式下生效：每隔这么多秒，前台会尝试用最新的后端数据重新生成静态页面。\n\n前台会把这个值夹到最小 60 秒（填更小也按 60 算），填非数字会被忽略而不是让构建失败。\n\n默认的「按需更新」模式不看这个值：改文章时由后端主动触发重渲染，另外有一个 24 小时的兜底周期，万一某次触发丢了也能自愈。',
            )}
            min={1}
            fieldProps={{ precision: 0 }}
          />
        </ProForm>
      </Card>
      <Card title={t('sysconf.advance.isrManualCard', '手动触发静态页面更新')} style={{ marginTop: 8 }}>
        <Alert
          type="info"
          message={t(
            'sysconf.advance.isrManualAlert',
            '通常来说你不需要这样做，但某些情况下你也可以手动触发增量渲染。这会让后端尝试重新验证/渲染已知所有路由（触发完成后需要一些时间生效）。',
          )}
          style={{ marginBottom: 8 }}
        />
        <Button
          type="primary"
          onClick={async () => {
            setIsrLoading(true);
            try {
              await activeISR();
              message.success(t('sysconf.advance.isrManualOk', 'ISR 手动触发成功！'));
            } catch (err) {
              message.error(t('sysconf.advance.isrManualFail', 'ISR 触发失败！'));
            }
            setIsrLoading(false);
          }}
          loading={isrLoading}
        >
          {t('sysconf.advance.isrManualBtn', '手动触发')}
        </Button>
      </Card>
    </>
  );
}
