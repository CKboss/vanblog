import { getAllCategories, updateArticle, updateDraft } from '@/services/van-blog/api';
import { reportRequestError } from '@/services/van-blog/requestError';
import {
  PAST_SCHEDULE_WARNING_TITLE,
  PUBLISH_AT_HELP,
  PUBLISH_AT_PLACEHOLDER,
  PUBLISH_AT_TOOLTIP,
  isPastSchedule,
  normalizePublishAtForSave,
  pastScheduleWarningText,
} from '@/services/van-blog/schedule';
import { ModalForm, ProFormDateTimePicker, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { Form, message, Modal } from 'antd';
import moment from 'moment';
import { useEffect } from 'react';
import { stopMenuKeydown } from '@/services/van-blog/editableKeyboard';
import AuthorField from '../AuthorField';
import CoverImageField from '../CoverImageField';
import PathnameField from '../PathnameField';
import TagSelectField from '../TagSelectField';

/** antd4 的 DatePicker 只吃 moment：服务端给的 ISO 串要先转，坏值/空值给 null（清空显示）。 */
function toMomentOrNull(value: any) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const m = moment(value);
  return m.isValid() ? m : null;
}

export default function (props: {
  currObj: any;
  setLoading: any;
  onFinish: any;
  type: 'article' | 'draft' | 'about';
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const { currObj, setLoading, type, onFinish, visible, onVisibleChange } = props;
  const controlled = typeof visible === 'boolean';
  const [form] = Form.useForm();
  useEffect(() => {
    // publishAt 从服务端来是 ISO 串（或 null）；DatePicker 需要 moment。
    // 不合法或缺失都回落成 null，清空后才真的是「不定时」。
    const values = {
      ...(currObj || {}),
      publishAt: type == 'article' ? toMomentOrNull(currObj?.publishAt) : undefined,
    };
    if (form && form.setFieldsValue) form.setFieldsValue(values);
  }, [currObj]);
  return (
    <ModalForm
      form={form}
      title="修改信息"
      trigger={
        controlled ? undefined : (
          <a key="button" type="link">
            修改信息
          </a>
        )
      }
      visible={visible}
      onVisibleChange={onVisibleChange}
      modalProps={{
        onKeyDown: stopMenuKeydown,
      }}
      width={450}
      autoFocusFirstInput
      submitTimeout={3000}
      initialValues={currObj || {}}
      onFinish={async (values) => {
        if (location.hostname == 'blog-demo.mereith.com' && type != 'draft') {
          Modal.info({
            title: '演示站禁止修改信息！',
            content: '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
          });
          return;
        }
        if (!currObj || !currObj.id) {
          return false;
        }
        // 定时发布（publishAt）保存前归一化：
        // - 清空必须真的发 **null**（undefined 会在 JSON 序列化时丢键 → 服务端永远清不掉定时）；
        // - moment/字符串 → ISO 串（UTC）。
        const submitValues: any = { ...values };
        if (type == 'article') {
          submitValues.publishAt = normalizePublishAtForSave(values?.publishAt);
          // 选了过去的时间：警告而不是静默照存（服务端会视为已到期、直接发布）
          if (values?.publishAt && isPastSchedule(values?.publishAt)) {
            const proceed = await new Promise<boolean>((resolve) => {
              Modal.confirm({
                title: PAST_SCHEDULE_WARNING_TITLE,
                content: pastScheduleWarningText(values?.publishAt),
                okText: '仍要保存',
                cancelText: '回去改时间',
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
              });
            });
            if (!proceed) {
              return false;
            }
          }
        }
        setLoading(true);
        // 这个 setLoading 是 Editor 页面传进来的（编辑器的 Spin）。以前服务端一拒绝
        // （比如 pathname 重复 → 400）await 直接抛出去，下面的 setLoading(false)
        // 永远执行不到 → 编辑器一直转圈、整个页面卡死，只能刷新。
        try {
          if (type == 'article') {
            await updateArticle(currObj?.id, submitValues);
            onFinish();
            message.success('修改文章成功！');
          } else if (type == 'draft') {
            await updateDraft(currObj?.id, values);
            onFinish();
            message.success('修改草稿成功！');
          } else {
            return false;
          }
          return true;
        } catch (err) {
          // 全局 errorHandler 弹过服务端原因时不再叠加提示；这里返回 false 让弹窗留着，
          // 用户改完能直接再提交一次。
          reportRequestError(message, err, '修改失败，请检查填写的内容！');
          return false;
        } finally {
          setLoading(false);
        }
      }}
      layout="horizontal"
      labelCol={{ span: 6 }}
      key="editForm"
      // wrapperCol: { span: 14 },
    >
      <div onKeyDown={stopMenuKeydown}>
      <ProFormText
        width="md"
        required
        id="title"
        name="title"
        label="文章标题"
        placeholder="请输入标题"
        rules={[{ required: true, message: '这是必填项' }]}
        fieldProps={{ onKeyDown: stopMenuKeydown }}
      />
      <AuthorField />
      <TagSelectField name="tags" />
      <ProFormSelect
        width="md"
        required
        id="category"
        tooltip="首次使用请先在站点管理-数据管理-分类管理中添加分类"
        name="category"
        label="分类"
        placeholder="请选择分类"
        rules={[{ required: true, message: '这是必填项' }]}
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
        name="createdAt"
        id="createdAt"
        label="创建时间"
        placeholder="不填默认为此刻"
        showTime={{
          defaultValue: moment('00:00:00', 'HH:mm:ss'),
        }}
      />
      {type == 'article' && (
        <>
          <ProFormText
            width="md"
            id="top"
            name="top"
            label="置顶优先级"
            placeholder="留空或0表示不置顶，其余数字越大表示优先级越高"
          />
          <PathnameField fieldProps={{ onKeyDown: stopMenuKeydown }} />
          <ProFormSelect
            width="md"
            name="private"
            id="private"
            label="是否加密"
            placeholder="是否加密"
            request={async () => {
              return [
                {
                  label: '否',
                  value: false,
                },
                {
                  label: '是',
                  value: true,
                },
              ];
            }}
          />
          <ProFormText.Password
            label="密码"
            width="md"
            id="password"
            name="password"
            placeholder="请输入密码"
            dependencies={['private']}
          />
          <ProFormSelect
            width="md"
            name="hidden"
            id="hidden"
            label="是否隐藏"
            placeholder="是否隐藏"
            request={async () => {
              return [
                {
                  label: '否',
                  value: false,
                },
                {
                  label: '是',
                  value: true,
                },
              ];
            }}
          />
          <ProFormDateTimePicker
            width="md"
            name="publishAt"
            id="publishAt"
            label="定时发布"
            placeholder={PUBLISH_AT_PLACEHOLDER}
            tooltip={PUBLISH_AT_TOOLTIP}
            formItemProps={{
              extra: PUBLISH_AT_HELP,
            }}
            showTime={{
              defaultValue: moment('00:00:00', 'HH:mm:ss'),
            }}
            fieldProps={{
              onKeyDown: stopMenuKeydown,
              allowClear: true,
            }}
          />
          <ProFormText
            width="md"
            id="copyright"
            name="copyright"
            label="版权声明"
            tooltip="设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示"
            placeholder="设置后会替换掉文章底部默认的版权"
          />
          <CoverImageField fieldProps={{ onKeyDown: stopMenuKeydown }} />
        </>
      )}
      </div>
    </ModalForm>
  );
}
