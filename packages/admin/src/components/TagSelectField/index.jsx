import { getTags } from '@/services/van-blog/api';
import {
  TAG_TOKEN_SEPARATORS,
  tagFieldPlaceholder,
  tagFieldTooltip,
} from '@/services/van-blog/tagTokens';
import { ProFormSelect } from '@ant-design/pro-form';
import { useIntl } from 'umi';

export default function TagSelectField({ name, ...rest }) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。
  // 🔴 placeholder / tooltip 来自服务层 `tagTokens.js` 的**函数版**（`tagFieldPlaceholder(t)` / `tagFieldTooltip(t)`）：
  //   那个模块是纯逻辑、模块加载期拿不到 umi 运行时 ⇒ 翻译器由这里（渲染期）注入。
  //   ⚠️ 不要改回 `TAG_FIELD_PLACEHOLDER` / `TAG_FIELD_TOOLTIP` 那两个 identity 常量 ——
  //   它们永远是中文，而 localePackParity 有一条判据专门盯"已接 i18n 的文件不许用 identity 常量取文案"。
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
      placeholder={tagFieldPlaceholder(t)}
      tooltip={tagFieldTooltip(t)}
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
