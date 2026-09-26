import { Table, Typography } from 'antd';
import { useMemo } from 'react';
// 🔴 **不能用 `useIntl()`**：本组件是被 `Modal.info({ content: <ObjTable … /> })` 渲染的，
//    而 antd 4 的 `Modal.info/confirm/...` 会 `ReactDOM.render` 到一个**新建的容器**里
//    （见 antd/es/modal/confirm.js 的 render/reactUnmount(container)）⇒ 那是**独立的 React 根**，
//    🔴 **拿不到 app 的 IntlProvider context**，`useIntl()` 会直接抛错、弹窗内容整块渲染不出来。
//    实测：改成 useIntl 之后，en-US 下点右键「信息」⇒ 弹窗**不出现**（活体探针抓到，单测看不见）。
//    ⇒ 用 `getIntl(getLocale())`（普通函数、不依赖 context），与 `app.jsx` 的 makeServerErrorTranslator 同一套路。
import { getIntl, getLocale } from 'umi';

export default function (props: { obj: any }) {
  // 🔴 语言选择在**渲染期**取（不能提到模块顶层：那时 umi 插件运行时还没初始化，getLocale() 会拿不到值）。
  //    `values` 用 `Record<string, any>`（写 unknown 会报 TS2769，见手册 §7.148 B）。
  const intl = getIntl(getLocale());
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const data = useMemo(() => {
    if (!props.obj || Object.keys(props.obj).length == 0) {
      return [];
    }
    const res = [];
    for (const [k, v] of Object.entries(props.obj)) {
      res.push({ key: k, name: k, val: v });
    }
    return res;
  }, [props]);
  return (
    <Table
      dataSource={data}
      size="small"
      columns={[
        { title: t('common.colProperty', '属性'), dataIndex: 'name', key: 'name', width: 60 },
        {
          title: t('common.colValue', '值'),
          dataIndex: 'val',
          key: 'val',
          render: (val) => {
            return (
              <Typography.Text
                copyable={val.length > 20}
                style={{ wordBreak: 'break-all', wordWrap: 'break-word' }}
              >
                {val}
              </Typography.Text>
            );
          },
        },
      ]}
      pagination={{
        showQuickJumper: true,
        hideOnSinglePage: true,
      }}
    ></Table>
  );
}
