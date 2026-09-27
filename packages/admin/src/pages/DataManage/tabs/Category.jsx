import {
  createCategory,
  deleteCategory,
  getAllCategories,
  reorderCategories,
  updateCategory,
} from '@/services/van-blog/api';
import { encodeQuerystring } from '@/services/van-blog/encode';
import {
  buildAccessPasswordPatch,
  buildSubmitValues,
  clearPasswordLabel,
  clearPasswordTooltip,
  clearConfirmContent,
  clearConfirmTitle,
  hasPasswordFromRecord,
  PASSWORD_UNRECOVERABLE_WARNING,
  passwordUnrecoverableWarning,
  passwordHelp,
  passwordPlaceholder,
  privateToggleHint,
  shouldShowClearOption,
} from '@/services/van-blog/accessPassword';
import { useIntl } from 'umi';
import { PlusOutlined } from '@ant-design/icons';
import { ModalForm, ProFormSelect, ProFormSwitch, ProFormText } from '@ant-design/pro-form';
import { ProTable } from '@ant-design/pro-table';
import { Button, message, Modal, Switch } from 'antd';
import { useRef, useState } from 'react';

function isDemoHost() {
  return location.hostname == 'blog-demo.mereith.com';
}

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是模块级普通函数（`Modal.info` 还是脱离 React 树的
 * 独立根，§7.151）⇒ 拿不到 hook，只能由调用方把 t 传进来；🔴 不传 t ⇒ 输出与改造前逐字相同。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

function showDemoBlocked(t = IDENTITY_T) {
  Modal.info({
    title: t('common.demoBlockedUpdate', '演示站禁止修改信息！'),
    content: t(
      'common.demoBlockedReason',
      '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
    ),
  });
}

function OrderButtons({ record, index, total, onMove }) {
  // 🔴 期 6 第九批：接上 i18n。⚠️ 这是一个**模块级组件**（不是页面组件），但它是组件 ⇒ 可以自己用 hook。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  return (
    <span data-category-order={String(record.name)}>
      <Button
        type="link"
        size="small"
        disabled={index <= 0}
        aria-label={t('dataManage.moveUpCategoryAria', '上移分类 {name}', { name: record.name })}
        data-category-move-up={String(record.name)}
        onClick={() => onMove(record.name, -1)}
      >{t('dataManage.moveUp', '上移')}</Button>
      <Button
        type="link"
        size="small"
        disabled={index < 0 || index >= total - 1}
        aria-label={t('dataManage.moveDownCategoryAria', '下移分类 {name}', { name: record.name })}
        data-category-move-down={String(record.name)}
        onClick={() => onMove(record.name, 1)}
      >{t('dataManage.moveDown', '下移')}</Button>
    </span>
  );
}

function HiddenSwitch({ record, action }) {
  // 🔴 期 6 第九批：接上 i18n。⚠️ 这是一个**模块级组件**（不是页面组件），但它是组件 ⇒ 可以自己用 hook。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const [loading, setLoading] = useState(false);
  return (
    <span data-category-hidden-toggle={String(record.name)}>
      <Switch
        size="small"
        loading={loading}
        checked={Boolean(record.hidden)}
        checkedChildren={t('common.yes', '是')}
        unCheckedChildren={t('common.no', '否')}
        aria-label={t('dataManage.hiddenSwitchAria', '是否隐藏 {name}', { name: record.name })}
        onChange={async (checked) => {
          if (isDemoHost()) {
            showDemoBlocked(t);
            return;
          }
          setLoading(true);
          try {
            await updateCategory(record.name, { hidden: checked });
            message.success(checked ? t('article.hiddenOn', '已设为隐藏') : t('article.hiddenOff', '已取消隐藏'));
            action?.reload();
          } finally {
            setLoading(false);
          }
        }}
      />
    </span>
  );
}

// 🔴 列定义是模块级工厂 ⇒ **尾参** t（与 showDemoBlocked 同一套做法）；调用点在页面组件里，把 t 传进来。
//    ⚠️ t 必须是**独立的最后一个参数**，不能塞进第一个对象里：调用点判据就是按「最后一个实参是不是 t」看的
//    （藏在对象里它不认 ⇒ 变异对照会告诉你；而且这个约定本身有价值：尾参一眼就能看出有没有传）。
function createColumns({ onMove, rows }, t = IDENTITY_T) {
  return [
  {
    dataIndex: 'name',
    title: t('dataManage.categoryColTitle', '题目'),
    search: false,
  },
  {
    title: t('dataManage.colOrder', '排序'),
    tooltip:
      t('dataManage.orderTooltip', '上移 / 下移可调整分类在前台导航、分类列表和分类页中的显示顺序。隐藏分类仍参与后台排序，但不会出现在前台。'),
    search: false,
    width: 140,
    render: (_, record) => {
      const index = rows.findIndex((item) => item.name === record.name);
      return (
        <OrderButtons record={record} index={index} total={rows.length} onMove={onMove} />
      );
    },
  },
  {
    title: t('common.hiddenField', '是否隐藏'),
    tooltip:
      t('dataManage.hiddenTooltip', '隐藏后，前台分类列表、导航分类子菜单、分类页和 sitemap 不再展示该分类。后台仍可见。该分类下的文章仍按各自的隐藏/加密规则展示，不会因为分类隐藏而被加密。'),
    dataIndex: 'hidden',
    search: false,
    render: (_, record, __, action) => <HiddenSwitch record={record} action={action} />,
  },
  {
    title: t('dataManage.encryptedText', '加密'),
    // 🔴 原来是"字符串 + 常量"拼接 ⇒ 收成一条带 {warning} 的 ICU 整句（英文语序不同，拼接必出接缝）。
    //    ⚠️ 那个警告本身也是**注入式**的 ⇒ 这里用函数版 `passwordUnrecoverableWarning(t)`，
    //    不能读 identity 常量 `PASSWORD_UNRECOVERABLE_WARNING`（那样它永远是中文）。
    tooltip: t(
      'dataManage.encryptTooltip',
      '分类加密后，此分类下的所有文章都会被加密。密码以分类的密码为准。加密后，访客仍可正常访问分类并获取文章列表。{warning}',
      { warning: passwordUnrecoverableWarning(t) },
    ),
    dataIndex: 'private',
    search: false,
    valueType: 'select',
    valueEnum: {
      [true]: {
        text: t('dataManage.encryptedText', '加密'),
        status: 'Error',
      },
      [false]: {
        text: t('dataManage.notEncryptedText', '未加密'),
        status: 'Success',
      },
    },
  },
  {
    title: t('dataManage.passwordCol', '访问密码'),
    tooltip: t(
      'dataManage.passwordColTooltip',
      '服务端只存 scrypt 哈希，后台也读不出原密码，所以这一列只能告诉你"设没设"。{warning}要改密码或解除加密，用「重命名」弹窗里的密码框与「清除密码」开关。',
      { warning: passwordUnrecoverableWarning(t) },
    ),
    dataIndex: 'hasPassword',
    search: false,
    width: 110,
    render: (_, record) => (hasPasswordFromRecord(record) ? t('dataManage.passwordSet', '已设置') : t('dataManage.passwordNotSet', '未设置')),
  },
  {
    title: t('common.colOption', '操作'),
    valueType: 'option',
    width: 240,
    render: (text, record, _, action) => [
      <a
        key="viewCategory"
        onClick={() => {
          window.open(`/category/${encodeQuerystring(record.name)}`, '_blank');
        }}
      >{t('common.view', '查看')}</a>,
      <ModalForm
        key={`editCateoryC%{${record.name}}`}
        title={t('dataManage.renameCategoryModalTitle', '重命名分类 "{name}"', { name: record.name })}
        trigger={<a key={'editC' + record.name} data-category-rename={String(record.name)}>{t('dataManage.rename', '重命名')}</a>}
        autoFocusFirstInput
        // ⚠️ 不再回填密码：服务端已经**不下发**分类密码（只给布尔 hasPassword）。
        // 密码框永远是空的，留空 = 不修改；解除加密走下面的「清除密码」开关。
        initialValues={{
          private: record.private,
          hidden: Boolean(record.hidden),
        }}
        submitTimeout={3000}
        onFinish={async (formValues) => {
          const hasPassword = hasPasswordFromRecord(record);
          const access = buildAccessPasswordPatch({
            password: formValues?.password,
            clearRequested: formValues?.clearPassword,
            hasPassword,
            isCreate: false,
            isPrivate: formValues?.private,
            // 🔴 第二个参数才是翻译器：它算出来的 `access.error` 是**给用户看的文案**
            //    （漏传 t 就会永远中文，而且看不出来 —— localePackParity 有判据盯着）
          }, t);
          if (access.error) {
            message.error(access.error);
            return false;
          }
          // 摘掉 password/hasPassword/clearPassword 三个表单键，只留算出来的那几个
          const values = buildSubmitValues(formValues, access.patch);
          if (Object.keys(values).length == 0) {
            message.error(t('dataManage.noValidInput', '无有效信息！请至少填写一个选项！'));
            return false;
          }
          const clearing = Boolean(access.patch?.clearPassword);
          const proceed = await new Promise((resolve) => {
            Modal.confirm({
              title: clearing
                // 🔴 这个"分类 "xxx""是**嵌进另一句译文里**的成分（`clearConfirmTitle` 来自注入式模块
                //    accessPassword.js）⇒ 它自己也要走 t（英文是 the category "xxx"），不能留中文。
                ? clearConfirmTitle(
                    t('dataManage.categoryQuotedName', '分类 "{name}"', { name: record.name }),
                    t,
                  )
                : t('dataManage.renameCategoryConfirmTitle', '确定重命名分类 "{name}" 吗？', { name: record.name }),
              content: clearing
                ? clearConfirmContent(t('dataManage.allArticlesUnderCategory', '该分类下的所有文章'), t)
                : t('dataManage.changeTakesEffectNow', '改动将立即生效!'),
              okText: clearing ? t('common.okClear', '确定清除') : t('common.ok', '确定'),
              // antd 4 的 Modal.confirm 没有 description，危险态靠 okButtonProps + content 表达
              okButtonProps: clearing ? { danger: true } : undefined,
              cancelText: clearing ? t('common.cancelReconsider', '再想想') : t('init.restore.confirmCancel', '取消'),
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
          if (!proceed) {
            return false;
          }
          try {
            await updateCategory(record.name, values);
            message.success(clearing ? t('dataManage.passwordCleared', '已清除该分类的访问密码') : t('common.submitOk', '提交成功'));
            action?.reload();
            return true;
          } catch (err) {
            // 全局 errorHandler 已经弹过服务端原因；留在弹窗里让用户改完再提交
            return false;
          }
        }}
      >
        <ProFormText width="md" name="name" label={t('dataManage.categoryNameCol', '分类名')} placeholder={t('dataManage.categoryNamePlaceholder', '请输入新的分类名称')} />
        <ProFormSelect
          width="md"
          name="hidden"
          label={t('common.hiddenField', '是否隐藏')}
          placeholder={t('common.hiddenField', '是否隐藏')}
          request={async () => {
            return [
              { label: t('common.no', '否'), value: false },
              { label: t('common.yes', '是'), value: true },
            ];
          }}
        />
        <ProFormSelect
          width="md"
          name="private"
          label={t('common.encrypted', '是否加密')}
          placeholder={t('common.encrypted', '是否加密')}
          tooltip={privateToggleHint(t)}
          request={async () => {
            return [
              { label: t('dataManage.notEncryptedText', '未加密'), value: false },
              { label: t('dataManage.encryptedText', '加密'), value: true },
            ];
          }}
        />
        <ProFormText.Password
          width="md"
          name="password"
          label={t('login.passwordPlaceholder', '密码')}
          placeholder={passwordPlaceholder({ hasPassword: hasPasswordFromRecord(record) }, t)}
          tooltip={
            hasPasswordFromRecord(record)
              ? t('dataManage.passwordEditHint', '该分类已设置密码。留空表示不修改；填新值表示改密码。')
              : t('dataManage.passwordNewHint', '留空表示不加密；填了就用这个密码加密该分类下的所有文章。')
          }
          formItemProps={{
            extra: passwordHelp({ hasPassword: hasPasswordFromRecord(record) }, t),
          }}
          // 挡浏览器自动填充：「留空 = 不修改」之后，一次自动填充 = 悄悄改了密码
          fieldProps={{ autoComplete: 'new-password' }}
        />
        {shouldShowClearOption({ hasPassword: hasPasswordFromRecord(record) }) && (
          <ProFormSwitch
            width="md"
            name="clearPassword"
            id="clearPassword"
            label={clearPasswordLabel(t)}
            tooltip={clearPasswordTooltip(t)}
            formItemProps={{
              extra: t(
                'dataManage.decryptHint',
                '勾选并提交 = 解除该分类（及其下所有文章）的加密。{warning}',
                { warning: passwordUnrecoverableWarning(t) },
              ),
            }}
          />
        )}
      </ModalForm>,

      <a
        key={'deleteCategoryC' + record.name}
        onClick={() => {
          Modal.confirm({
            title: t('dataManage.deleteCategoryConfirmTitle', '确定删除分类 "{name}"吗？', { name: record.name }),
            onOk: async () => {
              try {
                await deleteCategory(record.name);
                message.success(t('dataManage.deleteOk', '删除成功!'));
              } catch {}
              action?.reload();
            },
          });
          // action?.startEditable?.(record.id);
        }}
      >{t('common.delete', '删除')}</a>,
    ],
  },
];
}

export default function () {
  // 🔴 期 6 第九批：接上 i18n（语言选择必须在渲染期）。⚠️ `message.*` / `Modal.*` 是脱离 React 树的独立根（§7.151）。
  // 🔴 本文件的 t **没有**进任何 hook 的依赖数组；谁要加，必须先用 useCallback([intl]) 包成稳定引用（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const actionRef = useRef();
  const [rows, setRows] = useState([]);
  const fetchData = async () => {
    const { data: res } = await getAllCategories(true);
    const data = res.map((item) => ({
      key: item.id,
      ...item,
    }));
    setRows(data);
    return data;
  };
  const moveCategory = async (name, delta) => {
    if (isDemoHost()) {
      showDemoBlocked(t);
      return;
    }
    const index = rows.findIndex((item) => item.name === name);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= rows.length) {
      return;
    }
    const names = rows.map((item) => item.name);
    const swapped = names[index];
    names[index] = names[next];
    names[next] = swapped;
    await reorderCategories(names);
    message.success(t('dataManage.orderUpdated', '已调整分类顺序'));
    actionRef?.current?.reload();
  };
  return (
    <>
      <ProTable
        rowKey="name"
        columns={createColumns({ onMove: moveCategory, rows }, t)}
        search={false}
        pagination={false}
        dateFormatter="string"
        // headerTitle="分类"
        actionRef={actionRef}
        options={false}
        toolBarRender={() => [
          <ModalForm
            title={t('dataManage.createCategory', '新建分类')}
            key="newCategoryN"
            trigger={
              <Button key="buttonCN" icon={<PlusOutlined />} type="primary">{t('dataManage.createCategory', '新建分类')}</Button>
            }
            width={450}
            autoFocusFirstInput
            submitTimeout={3000}
            onFinish={async (values) => {
              await createCategory(values);
              actionRef?.current?.reload();
              message.success(t('dataManage.createCategoryOk', '新建分类成功！'));
              return true;
            }}
            layout="horizontal"
            labelCol={{ span: 6 }}
          >
            <ProFormText
              width="md"
              required
              id="nameC"
              name="name"
              label={t('dataManage.categoryNameField', '分类名称')}
              key="nameCCCC"
              placeholder={t('dataManage.categoryNameFieldPlaceholder', '请输入分类名称')}
              rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
            />
          </ModalForm>,
        ]}
        request={async () => {
          const data = await fetchData();
          return {
            data,
            // success 请返回 true，
            // 不然 table 会停止解析数据，即使有数据
            success: true,
            // 不传会使用 data 的长度，如果是分页一定要传
            total: data.length,
          };
        }}
      />
    </>
  );
}
