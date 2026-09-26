import { createDraft, getAllCategories } from '@/services/van-blog/api';
import { ModalForm, ProFormDateTimePicker, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { Button } from 'antd';
import moment from 'moment';
import { stopMenuKeydown } from '@/services/van-blog/editableKeyboard';
import AuthorField from '../AuthorField';
import TagSelectField from '../TagSelectField';
import { useIntl } from 'umi';
export default function (props) {
  const { onFinish } = props;
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件的 t **没有**进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <ModalForm
      title={t('draft.newTitle', '新建草稿')}
      trigger={
        <Button key="button" type="primary">
          {t('draft.newTitle', '新建草稿')}
        </Button>
      }
      width={450}
      autoFocusFirstInput
      modalProps={{
        onKeyDown: stopMenuKeydown,
      }}
      submitTimeout={3000}
      onFinish={async (values) => {
        const washedValues = {};
        for (const [k, v] of Object.entries(values)) {
          washedValues[k.replace('C', '')] = v;
        }

        const { data } = await createDraft(washedValues);
        if (onFinish) {
          onFinish(data);
        }
        return true;
      }}
      layout="horizontal"
      labelCol={{ span: 6 }}
      // wrapperCol: { span: 14 },
    >
      <div onKeyDown={stopMenuKeydown}>
      <ProFormText
        width="md"
        required
        id="titleC"
        name="titleC"
        label={t('common.articleTitle', '文章标题')}
        placeholder={t('common.titlePlaceholder', '请输入标题')}
        rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
      />
      <AuthorField />
      <TagSelectField name="tagsC" />
      <ProFormSelect
        width="md"
        required
        id="categoryC"
        name="categoryC"
        label={t('common.colCategory', '分类')}
        tooltip={t('common.categoryTooltip', '首次使用请先在站点管理-数据管理-分类管理中添加分类')}
        placeholder={t('common.categoryPlaceholder', '请选择分类')}
        rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
        request={async () => {
          const { data: categories } = await getAllCategories();
          return categories?.map((e) => {
            return {
              label: e,
              value: e,
            };
          });
        }}
      />
      <ProFormDateTimePicker
        width="md"
        name="createdAtC"
        id="createdAtC"
        label={t('common.createdAt', '创建时间')}
        placeholder={t('common.createdAtPlaceholder', '不填默认为此刻')}
        showTime={{
          defaultValue: moment('00:00:00', 'HH:mm:ss'),
        }}
      />
      </div>
    </ModalForm>
  );
}
