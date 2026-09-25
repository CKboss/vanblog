import { getStaticSetting, updateStaticSetting } from '@/services/van-blog/api';
import { ProForm, ProFormSelect, ProFormText, ProFormTextArea } from '@ant-design/pro-form';
import { message, Modal } from 'antd';
import { useState } from 'react';
import { useIntl } from 'umi';
export default function (props: {}) {
  const [storageType, setStorageType] = useState<any>('local');
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。`values` 用 `Record<string, any>`：
  //    写 `unknown` 会报 **TS2769**（这个形状在仓库里复制过 4 次、各背一条类型错误，期 4 已一并清掉）。
  //    ⚠️ 本文件没有把 t 放进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      <ProForm
        grid={true}
        layout={'horizontal'}
        labelCol={{ span: 6 }}
        request={async (params) => {
          const { data } = await getStaticSetting();
          setStorageType(data?.storageType || 'local');
          if (!data) {
            return {
              storageType: 'local',
            };
          }
          return {
            ...data,
            picgoConfig: JSON.stringify(data?.picgoConfig || '', null, 2),
          };
        }}
        syncToInitialValues={true}
        onFinish={async (data) => {
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({ title: t('storage.demoBlocked', '演示站禁止修改图床配置！') });
            return;
          }
          setStorageType(data?.storageType || 'local');
          // 验证一下 json 格式
          let picgoConfig = null;
          let toUpload = data;
          if (data?.storageType == 'picgo' && data?.picgoConfig != '') {
            try {
              picgoConfig = JSON.parse(data?.picgoConfig);
              toUpload = { ...data, picgoConfig };
            } catch (err) {
              message.error(t('storage.picgoJsonInvalid', 'picgoConfig 格式错误，无法解析成 json'));
            }
          }
          await updateStaticSetting(toUpload);
          message.success(t('common.updateSuccess', '更新成功！'));
        }}
      >
        <ProFormSelect
          fieldProps={{
            onChange: (target) => {
              setStorageType(target);
            },
          }}
          name="storageType"
          required
          label={t('storage.storageType.label', '存储策略')}
          placeholder={t('storage.storageType.placeholder', '请选择存储策略')}
          valueEnum={{
            local: t('storage.storageType.local', '本地存储'),
            picgo: t('storage.storageType.picgo', 'OSS 图床'),
          }}
          tooltip={t('storage.storageType.tooltip', '本地存储之前请确保映射了永久目录以防丢失哦')}
          rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
        ></ProFormSelect>
        {storageType == 'picgo' && (
          <>
            <ProFormTextArea
              name="picgoConfig"
              label={
                <a
                  href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/image-storage.md"
                  target={'_blank'}
                  rel="norefferrer"
                >
                  {t('storage.picgoConfig.label', 'picgo 配置')}
                </a>
              }
              tooltip={t('storage.picgoConfig.tooltip', 'OSS 图床后端采用了 picgo')}
              placeholder={t('storage.picgoConfig.placeholder', '请输入 picgo 配置 (json)')}
              fieldProps={{
                autoSize: {
                  minRows: 10,
                  maxRows: 30,
                },
              }}
            />
            <ProFormText
              name="picgoPlugins"
              label={t('storage.picgoPlugins.label', '自定义 picgo 插件')}
              tooltip={t('storage.picgoPlugins.tooltip', '请填写插件名（如 s3），多个请用英文逗号分隔')}
              placeholder={t('storage.picgoPlugins.placeholder', '看不懂的话请忽略')}
            />
          </>
        )}
      </ProForm>
    </>
  );
}
