import { createArticle, getAllCategories } from '@/services/van-blog/api';
import { ModalForm, ProFormDateTimePicker, ProFormSelect, ProFormText } from '@ant-design/pro-form';
import { Button, message, Modal } from 'antd';
import moment from 'moment';
import { stopMenuKeydown } from '@/services/van-blog/editableKeyboard';
import {
  buildAccessPasswordPatch,
  passwordHelp,
  passwordPlaceholder,
} from '@/services/van-blog/accessPassword';
import AuthorField from '../AuthorField';
import CoverImageField from '../CoverImageField';
import PathnameField from '../PathnameField';
import { useIntl } from 'umi';
import TagSelectField from '../TagSelectField';

export default function (props) {
  const { onFinish } = props;
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // ⚠️ 本文件的 t **没有**进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <ModalForm
      title={t('article.newTitle', '新建文章')}
      trigger={
        <Button key="button" type="primary">
          {t('article.newTitle', '新建文章')}
        </Button>
      }
      width={450}
      autoFocusFirstInput
      modalProps={{
        onKeyDown: stopMenuKeydown,
      }}
      submitTimeout={3000}
      onFinish={async (values) => {
        if (location.hostname == 'blog-demo.mereith.com') {
          Modal.info({
            title: t('common.demoBlockedCreate', '演示站禁止新建文章！'),
            content: t(
              'common.demoBlockedReason',
              '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
            ),
          });
          return;
        }
        const washedValues = {};
        for (const [k, v] of Object.entries(values)) {
          washedValues[k.replace('C', '')] = v;
        }
        // 选了「加密」却没填密码 = 造出一篇**谁也打不开**的文章（服务端会存一个空密码，
        // 而解锁口对"标记加密但没密码"一律拒绝）。密码又不可找回，所以在表单里就拦下来。
        // 🔴 尾参必须传 t（不传就走 IDENTITY_T ⇒ 那 3 条校验错误在英文界面下永远是中文）。
        //    这一处同样是"注入式翻译器每个调用点都要传 t"守卫**当场抓出来的**：
        //    🔴 上一轮在 UpdateModal 犯过一次、这轮在 NewArticleModal 又犯一次 ⇒ 它是**易犯错误**、
        //    不是偶发笔误（守卫的价值就在这里：人会忘，判据不会）。
        const access = buildAccessPasswordPatch(
          {
            password: washedValues.password,
            hasPassword: false,
            isCreate: true,
            isPrivate: washedValues.private,
          },
          t,
        );
        if (access.error) {
          message.error(access.error);
          return false;
        }

        const { data } = await createArticle(washedValues);
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
      <ProFormText
        width="md"
        id="topC"
        name="topC"
        label={t('common.topPriority', '置顶优先级')}
        placeholder={t(
          'common.topPriorityPlaceholder',
          '留空或0表示不置顶，其余数字越大表示优先级越高',
        )}
      />
      <PathnameField id="pathnameC" name="pathnameC" />
      <TagSelectField name="tagsC" />
      <ProFormSelect
        width="md"
        required
        id="categoryC"
        name="categoryC"
        tooltip={t('common.categoryTooltip', '首次使用请先在站点管理-数据管理-分类管理中添加分类')}
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
        placeholder={t('common.createdAtPlaceholder', '不填默认为此刻')}
        name="createdAtC"
        id="createdAtC"
        label={t('common.createdAt', '创建时间')}
        width="md"
        showTime={{
          defaultValue: moment('00:00:00', 'HH:mm:ss'),
        }}
      />

      <ProFormSelect
        width="md"
        name="privateC"
        id="privateC"
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
        id="passwordC"
        name="passwordC"
        autocomplete="new-password"
        placeholder={passwordPlaceholder({ isCreate: true }, t)}
        formItemProps={{ extra: passwordHelp({ isCreate: true }, t) }}
        fieldProps={{ autoComplete: 'new-password' }}
        dependencies={['private']}
      />
      <ProFormSelect
        width="md"
        name="hiddenC"
        id="hiddenC"
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
      <ProFormText
        width="md"
        id="copyrightC"
        name="copyrightC"
        label={t('common.copyright', '版权声明')}
        tooltip={t(
          'common.copyrightTooltip',
          '设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示',
        )}
        placeholder={t('common.copyrightPlaceholder', '设置后会替换掉文章底部默认的版权')}
      />
      <CoverImageField name="coverC" id="coverC" />
      </div>
    </ModalForm>
  );
}
