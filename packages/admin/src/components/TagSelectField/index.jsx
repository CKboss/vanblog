import { getTags } from '@/services/van-blog/api';
import {
  TAG_FIELD_PLACEHOLDER,
  TAG_FIELD_TOOLTIP,
  TAG_TOKEN_SEPARATORS,
} from '@/services/van-blog/tagTokens';
import { ProFormSelect } from '@ant-design/pro-form';
import { useIntl } from 'umi';

export default function TagSelectField({ name, ...rest }) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。
  // ⚠️ 下面 placeholder / tooltip 用的 `TAG_FIELD_PLACEHOLDER` / `TAG_FIELD_TOOLTIP` 来自
  //    `services/van-blog/tagTokens`（**服务层常量**，被 tagTokens.test.js 钉着）⇒ 本轮**不动**，
  //    🔴 所以切到英文时这个字段的占位符与提示仍然是中文（已知中间态，随"期 7 services"那批闭合）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <ProFormSelect
      mode="tags"
      tokenSeparators={TAG_TOKEN_SEPARATORS}
      width="md"
      name={name}
      id={name}
      label={t('common.colTags', '标签')}
      placeholder={TAG_FIELD_PLACEHOLDER}
      tooltip={TAG_FIELD_TOOLTIP}
      request={async () => {
        const msg = await getTags();
        return msg?.data?.map((item) => ({ label: item, value: item })) || [];
      }}
      fieldProps={{
        tokenSeparators: TAG_TOKEN_SEPARATORS,
        id: name,
      }}
      {...rest}
    />
  );
}
