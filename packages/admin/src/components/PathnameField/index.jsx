import { PATHNAME_FIELD, pathnameField } from '@/services/van-blog/importPathname';
import { ProFormText } from '@ant-design/pro-form';
import { useIntl } from 'umi';

export default function PathnameField({ name = PATHNAME_FIELD.name, id, fieldProps }) {
  const fieldId = id || name;
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。`name` 的默认值仍用 identity 视图 PATHNAME_FIELD.name
  //    —— 那是**表单字段名**（与服务端 DTO 逐字一致的契约），本来就不该翻译。
  const intl = useIntl();
  const t = (id2, defaultMessage, values) => intl.formatMessage({ id: id2, defaultMessage }, values);
  const F = pathnameField(t);
  return (
    <ProFormText
      width="md"
      id={fieldId}
      name={name}
      label={F.label}
      tooltip={F.tooltip}
      placeholder={F.placeholder}
      fieldProps={fieldProps}
    />
  );
}
