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
import TagSelectField from '../TagSelectField';

export default function (props) {
  const { onFinish } = props;
  return (
    <ModalForm
      title="新建文章"
      trigger={
        <Button key="button" type="primary">
          新建文章
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
            title: '演示站禁止新建文章！',
            content: '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
          });
          return;
        }
        const washedValues = {};
        for (const [k, v] of Object.entries(values)) {
          washedValues[k.replace('C', '')] = v;
        }
        // 选了「加密」却没填密码 = 造出一篇**谁也打不开**的文章（服务端会存一个空密码，
        // 而解锁口对"标记加密但没密码"一律拒绝）。密码又不可找回，所以在表单里就拦下来。
        const access = buildAccessPasswordPatch({
          password: washedValues.password,
          hasPassword: false,
          isCreate: true,
          isPrivate: washedValues.private,
        });
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
        label="文章标题"
        placeholder="请输入标题"
        rules={[{ required: true, message: '这是必填项' }]}
      />
      <AuthorField />
      <ProFormText
        width="md"
        id="topC"
        name="topC"
        label="置顶优先级"
        placeholder="留空或0表示不置顶，其余数字越大表示优先级越高"
      />
      <PathnameField id="pathnameC" name="pathnameC" />
      <TagSelectField name="tagsC" />
      <ProFormSelect
        width="md"
        required
        id="categoryC"
        name="categoryC"
        tooltip="首次使用请先在站点管理-数据管理-分类管理中添加分类"
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
        placeholder="不填默认为此刻"
        name="createdAtC"
        id="createdAtC"
        label="创建时间"
        width="md"
        showTime={{
          defaultValue: moment('00:00:00', 'HH:mm:ss'),
        }}
      />

      <ProFormSelect
        width="md"
        name="privateC"
        id="privateC"
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
        id="passwordC"
        name="passwordC"
        autocomplete="new-password"
        placeholder={passwordPlaceholder({ isCreate: true })}
        formItemProps={{ extra: passwordHelp({ isCreate: true }) }}
        fieldProps={{ autoComplete: 'new-password' }}
        dependencies={['private']}
      />
      <ProFormSelect
        width="md"
        name="hiddenC"
        id="hiddenC"
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
      <ProFormText
        width="md"
        id="copyrightC"
        name="copyrightC"
        label="版权声明"
        tooltip="设置后会替换掉文章页底部默认的版权声明文字，留空则根据系统设置中的相关选项进行展示"
        placeholder="设置后会替换掉文章底部默认的版权"
      />
      <CoverImageField name="coverC" id="coverC" />
      </div>
    </ModalForm>
  );
}
