import { getWalineConfig, updateWalineConfig } from '@/services/van-blog/api';
import { walineEmailFields } from '@/utils/walineEmailFields';
import { useIntl } from 'umi';
import { parseWalineOtherConfigJson } from '@/utils/walineOtherConfig';
import { ProForm, ProFormDigit, ProFormSelect, ProFormText, ProFormTextArea } from '@ant-design/pro-form';
import { message, Modal } from 'antd';
import { useState } from 'react';
export default function (props: {}) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。⚠️ `message.*` / `Modal.*` 是脱离 React 树的独立根（§7.151）。
  // 🔴 字段文案来自 `walineEmailFields(t)`（**函数版**）：模块级常量拿不到 hook，只能由消费方注入 t；
  //    读 identity 视图（`WALINE_EMAIL_FIELDS`）的话文案会永远中文 —— localePackParity 有判据盯着这件事。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const F = walineEmailFields(t);
  const [enableEmail, setEnableEmail] = useState<any>(false);
  return (
    <>
      <ProForm
        grid={true}
        layout={'horizontal'}
        labelCol={{ span: 6 }}
        request={async (params) => {
          const { data } = await getWalineConfig();
          setEnableEmail(data?.['smtp.enabled'] || false);
          if (!data) {
            return {
              'smtp.enabled': false,
              forceLoginComment: 'false',
            };
          }
          return {
            ...data,
            forceLoginComment:
              data.forceLoginComment === true || data.forceLoginComment === 'true'
                ? 'true'
                : 'false',
          };
        }}
        syncToInitialValues={true}
        onFinish={async (data) => {
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({ title: t('waline.demoBlocked', '演示站禁止修改 waline 配置！') });
            return;
          }
          if (data.otherConfig) {
            try {
              parseWalineOtherConfigJson(data.otherConfig);
            } catch (err) {
              Modal.info({ title: t('waline.invalidJson', '自定义环境变量不是合法 JSON 格式！') });
              return;
            }
          }
          setEnableEmail(data?.['smtp.enabled'] || false);
          await updateWalineConfig({
            ...data,
            forceLoginComment: data.forceLoginComment === true || data.forceLoginComment === 'true',
          });
          message.success(t('common.updateSuccess', '更新成功！'));
        }}
      >
        <ProFormText
          name="webhook"
          label={t('waline.webhookLabel', '评论后的 webhook 地址')}
          tooltip={t('waline.webhookTooltip', '收到评论后会向此地址发送一条携带评论信息的 HTTP 请求')}
          placeholder={t('waline.webhookLabel', '评论后的 webhook 地址')}
        />
        <ProFormSelect
          fieldProps={{
            options: [
              {
                label: t('common.enabled', '开启'),
                value: 'true',
              },
              {
                label: t('common.disabled', '关闭'),
                value: 'false',
              },
            ],
          }}
          name="forceLoginComment"
          label={t('waline.loginRequiredLabel', '是否强制登录后评论')}
          tooltip={t('waline.loginRequiredTooltip', '开启后访客必须登录 Waline 评论账号才能发表评论，匿名提交会被拒绝')}
          placeholder={t('waline.loginRequiredPlaceholder', '是否强制登录后评论，默认关闭')}
        ></ProFormSelect>
        <ProFormSelect
          fieldProps={{
            onChange: (target) => {
              console.log(target);
              setEnableEmail(target);
            },
            options: [
              {
                label: t('common.enabled', '开启'),
                value: true as any,
              },
              {
                label: t('common.disabled', '关闭'),
                value: false as any,
              },
            ],
          }}
          name={F.smtpEnabled.name}
          label={F.smtpEnabled.label}
          tooltip={F.smtpEnabled.tooltip}
          placeholder={F.smtpEnabled.placeholder}
        ></ProFormSelect>
        {enableEmail && (
          <>
            <ProFormText
              name={F.smtpHost.name}
              label={F.smtpHost.label}
              tooltip={F.smtpHost.tooltip}
              placeholder={F.smtpHost.placeholder}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
            <ProFormDigit
              name={F.smtpPort.name}
              label={F.smtpPort.label}
              tooltip={F.smtpPort.tooltip}
              placeholder={F.smtpPort.placeholder}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
            <ProFormText
              name={F.smtpUser.name}
              label={F.smtpUser.label}
              tooltip={F.smtpUser.tooltip}
              placeholder={F.smtpUser.placeholder}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
            <ProFormText.Password
              name={F.smtpPassword.name}
              label={F.smtpPassword.label}
              tooltip={F.smtpPassword.tooltip}
              placeholder={F.smtpPassword.placeholder}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
            <ProFormText
              name={F.authorEmail.name}
              label={F.authorEmail.label}
              tooltip={F.authorEmail.tooltip}
              placeholder={F.authorEmail.placeholder}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
            <ProFormText
              name={F.senderName.name}
              label={F.senderName.label}
              tooltip={F.senderName.tooltip}
              placeholder={F.senderName.placeholder}
            />
            <ProFormText
              name={F.senderEmail.name}
              label={F.senderEmail.label}
              tooltip={F.senderEmail.tooltip}
              placeholder={F.senderEmail.placeholder}
            />
          </>
        )}
        <ProFormTextArea
          name="otherConfig"
          label={
            <a
              href="https://waline.js.org/reference/server.html"
              target={'_blank'}
              rel="norefferrer"
            >{t('waline.otherConfigLabel', '自定义环境变量')}</a>
          }
          tooltip={
            t('waline.otherConfigTooltip', 'JSON 对象。大写键（如 IPQPS）会作为环境变量传给内嵌 Waline 服务端；客户端选项（如 imageUploader: false）会传给前台评论组件。布尔请用 false/true，不要加引号。')
          }
          placeholder={'{\n  "imageUploader": false,\n  "IPQPS": 60\n}'}
          fieldProps={{
            autoSize: {
              minRows: 10,
              maxRows: 30,
            },
          }}
        />
      </ProForm>
    </>
  );
}
