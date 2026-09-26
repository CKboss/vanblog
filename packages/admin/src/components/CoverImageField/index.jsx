import { getImgLink } from '@/pages/Static/img/tools';
import { errorImg } from '@/pages/Static/img';
import UploadBtn from '@/components/UploadBtn';
import { ProFormText } from '@ant-design/pro-form';
import { Button, Form, Image, Space, message } from 'antd';
import { useIntl } from 'umi';

/**
 * 🔴 "**导出对象字面量**"这类常量的接法（§7.156 A 里留的设计题，这批定了第一种形状）：
 * 改成 `coverField(t)` 函数，同时**保留** `COVER_FIELD` 作为它的 identity 视图
 * （`coverField()` 不传 t ⇒ 走 IDENTITY_T ⇒ 与改造前逐字相同）。
 * 🔴 中文只有一份（在函数的 defaultMessage 里）⇒ 不是两处口径；
 * 已接 i18n 的消费方用 `coverField(t)`，还没接的（以及 `COVER_FIELD.name` 这种取字段名的）继续用常量。
 * ⚠️ 为什么不用 `{ id, defaultMessage }` 对：那样 `collectTCalls` 看到的是**非字面量** defaultMessage
 * ⇒ 🔴 "defaultMessage↔语言包逐字对账"那条核心守卫会失效（见 §7.156 A）。
 */
const IDENTITY_T = (id, defaultMessage, values) => {
  if (!values) return String(defaultMessage);
  return String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
};

export const coverField = (t = IDENTITY_T) => ({
  name: 'cover',
  label: t('cover.label', '题头图'),
  placeholder: t('cover.placeholder', '可选，图片 URL，留空不显示题头图'),
  tooltip: t(
    'cover.tooltip',
    '可选。设置后显示在文章页顶部，并作为分享到其他应用时的预览图（Open Graph / Twitter）。可上传到现有图床或填写图片 URL。留空则不显示，已有文章不受影响。',
  ),
});

/** identity 视图：给还没接 i18n 的消费方与 `COVER_FIELD.name` 这类"只取字段名"的用法 */
export const COVER_FIELD = coverField();

export default function CoverImageField({ name = COVER_FIELD.name, id, fieldProps }) {
  const fieldId = id || name;
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）
  const intl = useIntl();
  const t = (id2, defaultMessage, values) => intl.formatMessage({ id: id2, defaultMessage }, values);
  const F = coverField(t);
  const form = Form.useFormInstance();
  const cover = Form.useWatch(name, form);
  const preview = typeof cover === 'string' ? cover.trim() : '';

  return (
    <div data-article-cover-field={name}>
      <ProFormText
        width="md"
        id={fieldId}
        name={name}
        label={F.label}
        tooltip={F.tooltip}
        placeholder={F.placeholder}
        fieldProps={{
          ...fieldProps,
          'data-article-cover-input': name,
        }}
        extra={
          <div style={{ display: 'flex', marginTop: 10, alignItems: 'flex-start' }}>
            <Image src={preview || ''} fallback={errorImg} height={80} width={120} />
            <Space style={{ marginLeft: 10 }} direction="vertical">
              <UploadBtn
                setLoading={() => {}}
                muti={false}
                crop={false}
                text={t('img.uploadBtn', '上传图片')}
                onFinish={(info) => {
                  if (info?.response?.data?.isNew) {
                    // 🔴 与图片管理页那两条（`img.uploadNew` / `img.uploadExists`）**不是同一句**：
                    //    那两条尾部有一个空格（因为后面还要拼"已复制…链接"），这里没有 ⇒ 各自一个 key，
                    //    不为了少一个 key 去改任一侧的可见文案。
                    message.success(t('cover.uploadedOk', '{name} 上传成功!', { name: info.name }));
                  } else if (info?.response?.data?.src) {
                    message.warning(t('cover.uploadedExists', '{name} 已存在!', { name: info.name }));
                  }
                  const src = getImgLink(info?.response?.data?.src);
                  form?.setFieldsValue({ [name]: src });
                }}
                url="/api/admin/img/upload"
                accept=".png,.jpg,.jpeg,.webp,.avif,.jiff,.gif"
              />
              <Button
                data-article-cover-clear={name}
                disabled={!preview}
                onClick={() => {
                  form?.setFieldsValue({ [name]: '' });
                }}
              >
                {t('cover.clear', '清除题头图')}
              </Button>
            </Space>
          </div>
        }
      />
    </div>
  );
}
