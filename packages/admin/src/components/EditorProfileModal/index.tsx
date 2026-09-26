import { ModalForm, ProFormSelect } from '@ant-design/pro-form';
import { Alert, message } from 'antd';
import { useIntl } from 'umi';
export default function (props: { setValue: any; value: any; trigger: any }) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。⚠️ `message.*` 是脱离 React 树的独立根（§7.151）
  //    ⇒ 传给它的是这里算好的字符串。values 的类型必须是 Record<string, any>（写 unknown 会撞 TS2769）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const { setValue, value, trigger } = props;
  return (
    <ModalForm
      title={t('editorProfile.title', '编辑器偏好设置')}
      trigger={trigger}
      width={450}
      autoFocusFirstInput
      submitTimeout={3000}
      initialValues={{
        afterSave: 'stay',
        useLocalCache: 'close',
        softLineBreaks: 'close',
        ...(value || {}),
      }}
      onFinish={async (vals) => {
        setValue({ ...value, ...vals });
        message.success(t('common.saveSuccess', '保存成功！'));
        return true;
      }}
      layout="horizontal"
      labelCol={{ span: 6 }}
      key="editForm"
    >
      <Alert
        type="info"
        message={t(
          'editorProfile.storageNote',
          '此配置保存在浏览器存储中，切换设备需重新设置。',
        )}
        style={{ marginBottom: 8 }}
      ></Alert>

      <ProFormSelect
        width="md"
        required
        id="afterSave"
        name="afterSave"
        label={t('editorProfile.afterSaveLabel', '保存后行为')}
        placeholder={t('editorProfile.afterSavePlaceholder', '请选择保存后行为，默认留在此页面')}
        request={async () => {
          return [
            {
              label: t('editorProfile.stayHere', '留在此页'),
              value: 'stay',
            },
            {
              label: t('editorProfile.goBack', '返回之前页面'),
              value: 'goBack',
            },
          ];
        }}
      />

      <ProFormSelect
        width="md"
        required
        id="useLocalCache"
        name="useLocalCache"
        label={t('editorProfile.localCacheLabel', '本地缓存')}
        tooltip={t(
          'editorProfile.localCacheTooltip',
          '默认关闭，开启后将在本地缓存编辑器内容，当本地内容比服务器内容更新时间更近时，将使用本地内容展示在编辑器中。',
        )}
        placeholder={t('editorProfile.localCachePlaceholder', '是否开启本地缓存')}
        request={async () => {
          return [
            {
              label: t('common.enabled', '开启'),
              value: 'open',
            },
            {
              label: t('common.disabled', '关闭'),
              value: 'close',
            },
          ];
        }}
      />

      <ProFormSelect
        width="md"
        required
        id="softLineBreaks"
        name="softLineBreaks"
        label={t('editorProfile.softWrapLabel', '软换行')}
        tooltip={t(
          'editorProfile.softWrapTooltip',
          '默认关闭，保持标准 Markdown：单独回车仍是同一段，需行末两个空格或空行才换行。开启后，按 Enter 或粘贴多行时会自动补两个空格写成软换行；已有文章不会在打开或保存时被改写。',
        )}
        placeholder={t('editorProfile.softWrapPlaceholder', '是否自动补行末空格')}
        request={async () => {
          return [
            {
              label: t('common.enabled', '开启'),
              value: 'open',
            },
            {
              label: t('common.disabled', '关闭'),
              value: 'close',
            },
          ];
        }}
      />
    </ModalForm>
  );
}
