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
import { ModalForm, ProFormDateTimePicker, ProFormSelect, ProFormSwitch, ProFormText } from '@ant-design/pro-form';
import { Form, message, Modal } from 'antd';
import moment from 'moment';
import { useEffect } from 'react';
import { useIntl } from 'umi';
import { stopMenuKeydown } from '@/services/van-blog/editableKeyboard';
import {
  buildAccessPasswordPatch,
  buildSubmitValues,
  // 🔴 已接 i18n 的组件用**函数版**（传 t），不要用那几个 SCREAMING_CASE 常量
  //    （常量是同一份文案的 identity 视图，留给还没接 i18n 的消费方，见 accessPassword.js 顶部注释）
  clearPasswordLabel,
  clearPasswordTooltip,
  clearConfirmContent,
  clearConfirmTitle,
  hasPasswordFromRecord,
  passwordHelp,
  passwordPlaceholder,
  privateToggleHint,
  sanitizeRecordForForm,
  shouldShowClearOption,
} from '@/services/van-blog/accessPassword';
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
  // 服务端已经**不再下发**文章访问密码（明文和哈希都不给），只给一个布尔 `hasPassword`。
  // 所以：① 初始值里必须把 password 摘干净（对着还没升级的旧服务端也绝不回填）；
  //      ② 密码框留空 = 「不修改」，解除加密走下面那个独立开关 + 二次确认。
  const passwordSet = type == 'article' && hasPasswordFromRecord(currObj);
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。`values` 用 `Record<string, any>`：
  //    写 `unknown` 会报 **TS2769**（这个形状在仓库里复制过 4 次、各背一条类型错误，期 4 已一并清掉）。
  // ⚠️ 本文件的 `useEffect(..., [currObj])` **不用 t**（只做表单回填）⇒ 没有陈旧语言闭包问题；
  //    🔴 谁要往它的依赖数组里加 t，必须先把 t 用 useCallback([intl]) 包（§7.144 A/B）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  useEffect(() => {
    // publishAt 从服务端来是 ISO 串（或 null）；DatePicker 需要 moment。
    // 不合法或缺失都回落成 null，清空后才真的是「不定时」。
    const values = {
      ...sanitizeRecordForForm(currObj),
      publishAt: type == 'article' ? toMomentOrNull(currObj?.publishAt) : undefined,
      // 显式清空这两个键：ModalForm 默认不 destroyOnClose，上一篇的输入/勾选会残留在
      // form store 里。残留一个 `clearPassword: true` 就等于"换一篇文章打开、点保存、
      // 把它的密码悄悄清掉" —— 而密码清除后是找不回来的。
      password: undefined,
      clearPassword: false,
    };
    if (form && form.setFieldsValue) form.setFieldsValue(values);
  }, [currObj]);
  return (
    <ModalForm
      form={form}
      title={t('common.editInfo', '修改信息')}
      trigger={
        controlled ? undefined : (
          <a key="button" type="link">
            {t('common.editInfo', '修改信息')}
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
      initialValues={sanitizeRecordForForm(currObj)}
      onFinish={async (values) => {
        if (location.hostname == 'blog-demo.mereith.com' && type != 'draft') {
          Modal.info({
            title: t('common.demoBlockedUpdate', '演示站禁止修改信息！'),
            content: t(
              'common.demoBlockedReason',
              '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
            ),
          });
          return;
        }
        if (!currObj || !currObj.id) {
          return false;
        }
        // 访问密码（P4）三态：留空 = **不修改**；填了新值 = 改密码；勾「清除密码」= 解除加密。
        // 清除是**不可撤销**的（服务端只存 scrypt 哈希，谁也读不出原密码），所以二次确认。
        let accessPatch: any = {};
        if (type == 'article') {
          // 🔴 尾参必须传 t：不传就走 IDENTITY_T ⇒ 那 3 条校验错误（又填又勾 / 无需清除 /
          //    如若加密请填写密码）在英文界面下**永远是中文**，而且不报错、界面上看不出差别。
          //    这一处是**新加的"注入式翻译器每个调用点都要传 t"守卫当场抓出来的**（迁移时漏了）。
          const access = buildAccessPasswordPatch(
            {
              password: (values as any)?.password,
              clearRequested: (values as any)?.clearPassword,
              hasPassword: passwordSet,
              isCreate: false,
              isPrivate: (values as any)?.private,
            },
            t,
          );
          if (access.error) {
            message.error(access.error);
            return false;
          }
          if ((access.patch as any)?.clearPassword) {
            const proceed = await new Promise<boolean>((resolve) => {
              Modal.confirm({
                // 🔴 **还欠条**（§7.155 A）：实参与模板分属两层 ⇒ 必须一起翻。
                //    现在实参也走 t（accessPassword.targetThisArticle），模板在服务层用 ICU `{target}`。
                title: clearConfirmTitle(t('accessPassword.targetThisArticle', '这篇文章'), t),
                content: clearConfirmContent(t('accessPassword.targetThisArticle', '这篇文章'), t),
                okText: t('common.okClear', '确定清除'),
                okButtonProps: { danger: true },
                cancelText: t('common.cancelReconsider', '再想想'),
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
              });
            });
            if (!proceed) {
              return false;
            }
          }
          accessPatch = access.patch;
        }
        // buildSubmitValues 会把 password / hasPassword / clearPassword 三个键全部摘掉，
        // 再 merge 上面算出来的那几个 —— 保证绝不会把服务端给的值（或残留的初始值）回传。
        const submitValues: any =
          type == 'article' ? buildSubmitValues(values, accessPatch) : { ...values };
        if (type == 'article') {
          // 定时发布（publishAt）保存前归一化：
          // - 清空必须真的发 **null**（undefined 会在 JSON 序列化时丢键 → 服务端永远清不掉定时）；
          // - moment/字符串 → ISO 串（UTC）。
          submitValues.publishAt = normalizePublishAtForSave(values?.publishAt);
          // 选了过去的时间：警告而不是静默照存（服务端会视为已到期、直接发布）
          if (values?.publishAt && isPastSchedule(values?.publishAt)) {
            const proceed = await new Promise<boolean>((resolve) => {
              Modal.confirm({
                title: PAST_SCHEDULE_WARNING_TITLE,
                content: pastScheduleWarningText(values?.publishAt),
                okText: t('common.okSaveAnyway', '仍要保存'),
                cancelText: t('common.cancelGoBack', '回去改时间'),
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
            message.success(t('common.articleUpdated', '修改文章成功！'));
          } else if (type == 'draft') {
            await updateDraft(currObj?.id, values);
            onFinish();
            message.success(t('common.draftUpdated', '修改草稿成功！'));
          } else {
            return false;
          }
          return true;
        } catch (err) {
          // 全局 errorHandler 弹过服务端原因时不再叠加提示；这里返回 false 让弹窗留着，
          // 用户改完能直接再提交一次。
          reportRequestError(message, err, t('common.updateFailedCheck', '修改失败，请检查填写的内容！'));
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
        label={t('common.articleTitle', '文章标题')}
        placeholder={t('common.titlePlaceholder', '请输入标题')}
        rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
        fieldProps={{ onKeyDown: stopMenuKeydown }}
      />
      <AuthorField />
      <TagSelectField name="tags" />
      <ProFormSelect
        width="md"
        required
        id="category"
        tooltip={t('common.categoryTooltip', '首次使用请先在站点管理-数据管理-分类管理中添加分类')}
        name="category"
        label={t('common.colCategory', '分类')}
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
        name="createdAt"
        id="createdAt"
        label={t('common.createdAt', '创建时间')}
        placeholder={t('common.createdAtPlaceholder', '不填默认为此刻')}
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
            label={t('common.topPriority', '置顶优先级')}
            placeholder={t(
              'common.topPriorityPlaceholder',
              '留空或0表示不置顶，其余数字越大表示优先级越高',
            )}
          />
          <PathnameField fieldProps={{ onKeyDown: stopMenuKeydown }} />
          <ProFormSelect
            width="md"
            name="private"
            id="private"
            label={t('common.encrypted', '是否加密')}
            placeholder={t('common.encrypted', '是否加密')}
            tooltip={privateToggleHint(t)}
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
            placeholder={passwordPlaceholder({ hasPassword: passwordSet }, t)}
            tooltip={
              passwordSet
                ? t('common.passwordTooltipSet', '已设置密码。留空表示不修改；填新值表示改密码。')
                : t('common.passwordTooltipUnset', '留空表示不加密；填了就用这个密码加密。')
            }
            formItemProps={{
              extra: passwordHelp({ hasPassword: passwordSet }, t),
            }}
            // autoComplete="new-password"：挡住浏览器的密码自动填充。
            // 「留空 = 不修改」之后，一次自动填充就等于"用户没想改，却被改了密码"。
            fieldProps={{ autoComplete: 'new-password', onKeyDown: stopMenuKeydown }}
            dependencies={['private']}
          />
          {shouldShowClearOption({ hasPassword: passwordSet }) && (
            <ProFormSwitch
              width="md"
              name="clearPassword"
              id="clearPassword"
              label={clearPasswordLabel(t)}
              tooltip={clearPasswordTooltip(t)}
              formItemProps={{
                extra: t(
                  'common.clearPasswordExtra',
                  '勾选并提交 = 解除这篇文章的加密。清除后原密码无法找回；只想换密码请不要勾选，直接在上面填新密码。',
                ),
              }}
            />
          )}
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
          <ProFormDateTimePicker
            width="md"
            name="publishAt"
            id="publishAt"
            label={t('common.scheduledPublish', '定时发布')}
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
            label={t('common.copyright', '版权声明')}
            tooltip={t(
              'common.copyrightTooltip',
              '设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示',
            )}
            placeholder={t('common.copyrightPlaceholder', '设置后会替换掉文章底部默认的版权')}
          />
          <CoverImageField fieldProps={{ onKeyDown: stopMenuKeydown }} />
        </>
      )}
      </div>
    </ModalForm>
  );
}
