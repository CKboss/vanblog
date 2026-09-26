import { ModalForm, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { Alert, Modal } from 'antd';

import { createCustomPage, updateCustomPage } from '@/services/van-blog/api';
import { useIntl } from 'umi';

export default ({
  onFinish,
  trigger,
  initialValues,
}: {
  onFinish: () => void;
  // FIXME: Add types
  trigger: any;
  // FIXME: Add types
  initialValues?: any;
}) => {
  // 🔴 原来是**隐式返回**的箭头组件（`() => (<ModalForm …/>)`）⇒ 要用 hook 就必须改成块体 + 显式 return。
  //    语言选择必须在渲染期（useIntl 是 hook）；values 用 Record<string, any>（写 unknown 会报 TS2769）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
    <ModalForm
    title={
      initialValues
        ? t('customPage.modalEditTitle', '修改自定义页面')
        : t('customPage.modalCreateTitle', '新建自定义页面')
    }
    trigger={trigger}
    width={520}
    autoFocusFirstInput
    submitTimeout={3000}
    initialValues={initialValues}
    key={initialValues?._id || 'create-custom-page'}
    modalProps={{ destroyOnClose: true }}
    onFinish={async (values) => {
      // FIXME: Should be refactor in to an env variable controlling "A demo state"
      if (location.hostname === 'blog-demo.mereith.com') {
        Modal.info({
          title: t('customPage.demoBlocked', '演示站不可修改此项！'),
        });
        return;
      }

      const path = values.path as string;

      if (path.substring(0, 1) != '/') {
        Modal.info({
          title: t('customPage.pathMustStartSlash', '路径必须以斜杠为开头！'),
        });
        return false;
      }

      if (path === '/' || path.slice(1).includes('/')) {
        Modal.info({
          title: t(
            'customPage.pathMustBeSingleLevel',
            '路径必须是单级，例如 /uptime（对应 /c/uptime/），不要写成 /foo/bar',
          ),
        });
        return false;
      }

      if (initialValues) {
        // Keep _id so the server can update this row after path changes (#453).
        await updateCustomPage({
          _id: initialValues._id,
          type: initialValues.type,
          ...values,
        });
      } else {
        await createCustomPage(values);
      }

      if (onFinish) {
        onFinish();
      }

      return true;
    }}
    layout="horizontal"
    labelCol={{ span: 6 }}
  >
    {!initialValues && (
      <>
        <Alert
          style={{ marginBottom: 8 }}
          type="info"
          message={t(
            'customPage.createAlert',
            '创建后到列表里编辑内容或上传文件。多文件页面只托管静态 HTML/CSS/JS，入口必须是根目录的 index.html（路径 /uptime 对应 /c/uptime/）。带 /static/... 绝对路径的 React 打包产物通常打不开，请改相对路径或用反代。',
          )}
        />
        <ProFormSelect
          width="md"
          name="type"
          required
          tooltip={t(
            'customPage.typeTooltip',
            '单文件：后台编辑一段 HTML。多文件：上传 HTML/CSS/JS 等静态文件；不支持 Node/PHP 后端。SPA 请用相对资源路径，并保证根目录有 index.html。',
          )}
          label={t('customPage.type', '类型')}
          placeholder={t('customPage.typePlaceholder', '请选择类型')}
          rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          initialValue={'folder'}
          request={async () => {
            return [
              { label: t('customPage.typeFile', '单文件页面'), value: 'file' },
              { label: t('customPage.typeFolder', '多文件页面'), value: 'folder' },
            ];
          }}
        />
      </>
    )}
    <ProFormText
      width="md"
      required
      id="name"
      name="name"
      label={t('common.colName', '名称')}
      placeholder={t('customPage.namePlaceholder', '请输入名称')}
      tooltip={t('customPage.nameTooltip', '自定义页面的名称')}
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
    />
    <ProFormText
      disabled={initialValues && initialValues.type == 'folder'}
      width="md"
      required
      id="path"
      name="path"
      label={t('customPage.colPath', '路径')}
      placeholder={t('customPage.pathPlaceholder', '例如 /uptime')}
      tooltip={t(
        'customPage.pathTooltip',
        '必须以 / 开头，且只能有一级，例如 /uptime。实际地址是 /c + 路径，即 /c/uptime/。多文件页面会读取该目录下的 index.html。',
      )}
      rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
    />
    </ModalForm>
  );
};
