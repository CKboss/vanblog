import { createArticle, getAllCategories } from '@/services/van-blog/api';
import { parseMarkdownFile } from '@/services/van-blog/parseMarkdownFile';
import { ModalForm, ProFormDateTimePicker, ProFormSelect, ProFormText, ProFormTextArea } from '@ant-design/pro-form';
import { stopMenuKeydown } from '@/services/van-blog/editableKeyboard';
import { Button, Form, Upload } from 'antd';
import moment from 'moment';
import { useState } from 'react';
import CoverImageField from '../CoverImageField';
import PathnameField from '../PathnameField';
import TagSelectField from '../TagSelectField';
import { useIntl } from 'umi';
export default function (props) {
  const { onFinish } = props;
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm();
  const handleUpload = async (file) => {
    const vals = await parseMarkdownFile(file, undefined, t);
    if (vals) {
      await createArticle(vals);
    }
  };
  const beforeUpload = async (file, files) => {
    if (files.length > 1) {
      await handleUpload(file);
      if (files[files.length - 1] == file) {
        if (onFinish) {
          onFinish();
        }
      }
    } else {
      const vals = await parseMarkdownFile(file, undefined, t);
      form.setFieldsValue(vals);
      setVisible(true);
    }
  };
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件的 t **没有**进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      <Upload showUploadList={false} multiple={true} accept={'.md'} beforeUpload={beforeUpload}>
        <Button key="button" type="primary" title={t('common.importHint', '从 markdown 文件导入，可多选')}>
          {t('common.importBtn', '导入')}
        </Button>
      </Upload>
      <ModalForm
        form={form}
        title={t('article.importTitle', '导入文章')}
        visible={visible}
        onVisibleChange={(v) => {
          setVisible(v);
        }}
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

          await createArticle(washedValues);
          if (onFinish) {
            onFinish();
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
          id="title"
          name="title"
          label={t('common.articleTitle', '文章标题')}
          placeholder={t('common.titlePlaceholder', '请输入标题')}
          rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
        />
        <ProFormText
          width="md"
          id="top"
          name="top"
          label={t('common.topPriority', '置顶优先级')}
          placeholder={t(
            'common.topPriorityPlaceholder',
            '留空或0表示不置顶，其余数字越大表示优先级越高',
          )}
        />
        <PathnameField />
        <TagSelectField name="tags" />
        <ProFormSelect
          width="md"
          required
          id="category"
          name="category"
          label={t('common.colCategory', '分类')}
          placeholder={t('common.categoryPlaceholder', '请选择分类')}
          tooltip={t('common.categoryTooltip', '首次使用请先在站点管理-数据管理-分类管理中添加分类')}
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
          showTime={{
            defaultValue: moment('00:00:00', 'HH:mm:ss'),
          }}
          width="md"
          name="createdAt"
          id="createdAt"
          label={t('common.createdAt', '创建时间')}
        />
        <ProFormSelect
          width="md"
          name="private"
          id="private"
          label={t('common.encrypted', '是否加密')}
          placeholder={t('common.encrypted', '是否加密')}
          request={async () => {
            return [
              {
                label: t('common.no', '否'),
                value: false,
              },
              {
                label: t('common.yes', '是'),
                value: true,
              },
            ];
          }}
        />
        <ProFormText.Password
          label={t('common.password', '密码')}
          width="md"
          id="password"
          name="password"
          autocomplete="new-password"
          placeholder={t('common.passwordInputPlaceholder', '请输入密码')}
          dependencies={['private']}
        />
        <ProFormSelect
          width="md"
          name="hidden"
          id="hidden"
          label={t('common.hiddenField', '是否隐藏')}
          placeholder={t('common.hiddenField', '是否隐藏')}
          request={async () => {
            return [
              {
                label: t('common.no', '否'),
                value: false,
              },
              {
                label: t('common.yes', '是'),
                value: true,
              },
            ];
          }}
        />
        <CoverImageField />
        <ProFormTextArea
          name="content"
          label={t('common.content', '内容')}
          id="content"
          fieldProps={{ autoSize: { minRows: 3, maxRows: 5 } }}
        />
        </div>
      </ModalForm>
    </>
  );
}
