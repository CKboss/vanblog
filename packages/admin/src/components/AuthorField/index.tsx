import { ProFormSelect } from '@ant-design/pro-form';
import { getAllCollaboratorsList } from '@/services/van-blog/api';
import { useIntl } from 'umi';

// 🔴 原来是**隐式返回**的箭头组件（`() => (<ProFormSelect …/>)`）⇒ 要用 hook 就必须改成块体 + 显式 return
//    （与 CustomPageModal 同一处结构改动）。
export default () => {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。`values` 用 `Record<string, any>`（写 unknown 会报 TS2769）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
  <ProFormSelect
    width="md"
    id="author"
    name="author"
    // 🔴 `common.colAuthor` 是从 `recycle.colAuthor` **提升**上来的（回收站的作者列与这里的表单标签
    //    是同一个性质 ⇒ 一个 key）
    label={t('common.colAuthor', '作者')}
    placeholder={t('common.authorPlaceholder', '不填默认为登录者本人')}
    request={async () =>
      (await getAllCollaboratorsList())?.data?.map(({ name, nickname = name }) => ({
        label: nickname,
        value: nickname,
      })) || []
    }
  />
  );
};
