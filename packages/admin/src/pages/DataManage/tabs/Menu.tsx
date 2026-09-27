import { getMenu, updateMenu } from '@/services/van-blog/api';
import { useIntl } from 'umi';
import { EditableProTable } from '@ant-design/pro-table';
// useRefFunction 只是 pro-utils 里的一个小 hook，为了不再拉整个 pro-components 桶，这里就地实现
const useRefFunction = <T extends (...args: any[]) => any>(fn: T) => {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: any[]) => ref.current(...args), []) as T;
};
import { message, Modal, Spin } from 'antd';
import {useCallback, useEffect, useRef, useState} from 'react';
type DataSourceType = {
  id: React.Key;
  name: string;
  value: string;
  level: number;
  children?: DataSourceType[];
};
const loopDataSourceFilter = (
  data: DataSourceType[],
  id: React.Key | undefined,
): DataSourceType[] => {
  return data
    .map((item) => {
      if (item.id !== id) {
        if (item.children) {
          const newChildren = loopDataSourceFilter(item.children, id);
          return {
            ...item,
            children: newChildren.length > 0 ? newChildren : undefined,
          };
        }
        return item;
      }
      return null;
    })
    .filter(Boolean) as DataSourceType[];
};

export default function () {
  // 🔴 期 6 第九批：接上 i18n（语言选择必须在**渲染期**，useIntl 是 hook）。
  // ⚠️ `message.*` / `Modal.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  // ⚠️ 这是 `.tsx`：`values` 必须写成**可选**且带类型（`values?: Record<string, any>`），
  //    否则只传两个实参的调用点会撞 TS2554「Expected 3 arguments, but got 2」（写 unknown 则撞 TS2769）。
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);

  const [loading, setLoading] = useState(false);
  const [editableKeys, setEditableRowKeys] = useState([]);
  const [dataSource, setDataSource] = useState<DataSourceType[]>([]);
  const [expendKeys, setExpendKeys] = useState([]);
  const removeRow = useRefFunction((record: DataSourceType) => {
    const toUpdateData = loopDataSourceFilter(dataSource, record.id);
    setDataSource(toUpdateData);
    setEditableRowKeys(editableKeys.filter((e) => e != record.id));
    setExpendKeys(expendKeys.filter((e) => e != record.id));
    update(toUpdateData);
  });
  const actionRef = useRef();
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getMenu();
      const menuData = data?.data || [];
      setDataSource(menuData);
      const expendKs = menuData.filter((e) => Boolean(e.children)).map((e) => e.id);
      setExpendKeys(expendKs);
      setLoading(false);
    } catch (err) {
      setLoading(false);
    }
  }, [setLoading, setDataSource, setExpendKeys]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);
  const getNewId = () => {
    return Date.now();
  };
  const update = useCallback(
    async (vals) => {
      await updateMenu({ data: vals });
      //@ts-ignore
      fetchData();
    },
    [fetchData],
  );
  const columns = [
    {
      title: t('dataManage.menuName', '菜单名'),
      dataIndex: 'name',
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('dataManage.menuUrl', '跳转网址'),
      dataIndex: 'value',
      tooltip: t(
        'dataManage.menuUrlRule',
        '内部地址需以 / 开头，外部地址请以协议开头( http/https )',
      ),
      formItemProps: (form, { rowIndex }) => {
        return {
          rules: [{ required: true, message: t('common.fieldRequired', '此项为必填项') }],
        };
      },
    },
    {
      title: t('common.colOption', '操作'),
      valueType: 'option',
      key: 'option',
      width: 200,
      render: (text, record, _, action) => {
        const l = record.level;
        return [
          <a
            key="editable"
            onClick={() => {
              action?.startEditable?.(record.id);
            }}
          >{t('common.editPost', '编辑')}</a>,
          l == 0 ? (
            <a
              key="addChild"
              onClick={() => {
                if (record.level >= 1) {
                  message.warning(t('dataManage.menuMaxLevel', '目前最大只支持二级菜单'));
                  return;
                }

                const children = record?.children || [];
                const newId = getNewId();
                children.push({
                  id: newId,
                  level: record.level + 1,
                });

                // 没有子属性的话增加一个子属性。
                const newData = dataSource.map((d) => {
                  if (d.id == record.id) {
                    return {
                      ...record,
                      children,
                    };
                  } else {
                    return d;
                  }
                });
                setDataSource(newData);
                setExpendKeys([...expendKeys, record.id]);
                action.startEditable(newId);
              }}
            >{t('dataManage.addSubmenu', '新增下级')}</a>
          ) : undefined,
          <a
            key="delete"
            onClick={async () => {
              Modal.confirm({
                onOk: async () => {
                  removeRow(record);
                },
                title: t('dataManage.deleteConfirmTitle', '确认删除"{name}"吗?', { name: record.name || '-' }),
              });
            }}
          >{t('common.delete', '删除')}</a>,
        ];
      },
    },
  ];
  return (
    <>
      <Spin spinning={loading}>
        <EditableProTable
          expandable={{
            defaultExpandAllRows: true,
            expandedRowKeys: expendKeys,
            onExpand: (e, r) => {
              if (e) {
                setExpendKeys([...expendKeys, r.id]);
              } else {
                setExpendKeys(expendKeys.filter((e) => e != r.id));
              }
            },
            // expandedRowKeys:
          }}
          actionRef={actionRef}
          rowKey="id"
          headerTitle={t('dataManage.menuCardTitle', '导航菜单管理')}
          scroll={{
            x: 960,
          }}
          recordCreatorProps={{
            position: 'bottom',
            newRecordType: 'dataSource',
            record: () => ({ id: getNewId(), level: 0 }),
          }}
          loading={false}
          columns={columns}
          value={dataSource}
          onValuesChange={(vals) => {
            setDataSource(vals);
          }}
          editable={{
            type: 'multiple',
            editableKeys,
            onSave: async (key, record, originRow, newLineConfig?) => {
              update(dataSource);
            },
            onDelete: async (key, row) => {
              removeRow(row);
            },

            onChange: setEditableRowKeys,
          }}
        />
      </Spin>
    </>
  );
}
