import CustomPageModal from '@/components/CustomPageModal';
import { deleteCustomPageByPath, getCustomPages } from '@/services/van-blog/api';
import { ProTable } from '@ant-design/pro-table';
import { Button, Card, message, Modal, Space } from 'antd';
import { useRef } from 'react';
import { Link, useIntl } from 'umi';
export default function () {
  // const [loading, setLoading] = useState(true);
  const actionRef = useRef();
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）⇒
  //    `columns` 从模块级常量搬进组件内部（与 Token.tsx / SiteInfoForm / app.jsx 的 links 同一条约束）。
  //    ⚠️ 本文件没有把 t 放进任何 hook 的依赖数组；将来若要放，必须先用 useCallback([intl]) 包（§7.144 A）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const columns = [
    {
      // 🔴 用 common.colIndex（从 customPage.colIndex 提升）：日志管理的两个表也有「序号」列
      title: t('common.colIndex', '序号'),
      render: (_, record, index) => {
        return index;
      },
    },
    { dataIndex: 'name', title: t('common.colName', '名称') },
    {
      dataIndex: 'type',
      title: t('customPage.type', '类型'),
      valueType: 'select',
      valueEnum: {
        file: {
          text: t('customPage.typeFile', '单文件页面'),
          status: 'Default',
        },
        folder: {
          text: t('customPage.typeFolder', '多文件页面'),
          status: 'Success',
        },
      },
    },
    { dataIndex: 'path', title: t('customPage.colPath', '路径') },
    {
      title: t('common.colOption', '操作'),
      render: (text, record, _, action) => {
        return (
          <Link
            to={
              record.type == 'file'
                ? `/code?type=file&lang=html&path=${record.path}`
                : `/code?type=folder&path=${record.path}`
            }
          >
            {record.type == 'file'
              ? t('customPage.editContent', '编辑内容')
              : t('customPage.fileManager', '文件管理')}
          </Link>
        );
      },
    },
    {
      title: t('customPage.colPath', '路径'),
      render: (text, record, _, action) => {
        return (
          <Space>
            <a key="view" target="_blank" rel="noreferrer" href={`/c${record.path}`}>
              {t('common.view', '查看')}
            </a>

            <CustomPageModal
              key={'editInfo'}
              trigger={<a>{t('common.editInfo', '修改信息')}</a>}
              initialValues={record}
              onFinish={() => {
                action?.reload();
              }}
            ></CustomPageModal>
            <a
              key="delete"
              onClick={() => {
                if (location.hostname == 'blog-demo.mereith.com') {
                  Modal.info({
                    title: t('customPage.demoBlocked', '演示站不可修改此项！'),
                  });
                  return;
                }
                Modal.confirm({
                  title: t('common.deleteConfirmTitle', '删除确认'),
                  content: t('customPage.deleteConfirmBody', '是否确认删除该自定义页面？'),
                  onOk: async () => {
                    await deleteCustomPageByPath(record.path);
                    action?.reload();
                    message.success(t('common.deleteSuccess', '删除成功！'));
                  },
                });
              }}
            >
              {t('common.delete', '删除')}
            </a>
          </Space>
        );
      },
    },
  ];

  const handleHelp = () => {
    Modal.info({
      // 🔴 这个弹窗的 content 是**在本组件的渲染作用域里创建**的元素（t() 在这里就求值好了），
      //    所以不受"Modal.* 是独立 React 根、里面不能用 useIntl"那条限制（§7.151 A）——
      //    🔴 被限制的是"在 content 里渲染一个**自己调 useIntl 的组件**"（例如上一批的 ObjTable）。
      title: t('common.help', '帮助'),
      width: 560,
      content: (
        <div>
          {/* 🔴 "文本 + <code>/<strong> + 文本"的混排拆成前后片段（与 Caddy 那批同一条纪律）：
              英文语序不同，只有让每段各自成句才翻得对；{' '} 负责那个空格。 */}
          <p>
            {t('customPage.helpP1a', '自定义页面把静态内容挂到站点的')}{' '}
            <code>{t('customPage.helpPathSample', '/c/路径/')}</code>{' '}
            {t('customPage.helpP1b', '下，不是通用应用托管。')}
          </p>
          <p>
            {t(
              'customPage.helpP2',
              '分为两种：单文件页面（后台编辑一段 HTML）、多文件页面（上传 HTML/CSS/JS 等静态文件）。',
            )}
          </p>
          <p>
            {t('customPage.helpP3a', '多文件页面访问')}{' '}
            <code>{t('customPage.helpPathSample', '/c/路径/')}</code> {t('customPage.helpP3b', '时读取')}
            <strong>{t('customPage.helpP3strong', '根目录的 index.html')}</strong>
            {t('customPage.helpP3c', '。请在文件树根上确认能看到它，不要多包一层解压文件夹。')}
          </p>
          <p>
            {t('customPage.helpP4a', 'React / Vue 等 SPA 若资源写成')} <code>/static/...</code>{' '}
            {t('customPage.helpP4b', '这种站点根路径，放到')} <code>/c/uptime/</code>{' '}
            {t('customPage.helpP4c', '下通常是白屏。请改成相对路径（如')} <code>./static/...</code>
            {t('customPage.helpP4d', '），或构建时把 homepage / base 设为')}{' '}
            <code>{t('customPage.helpPathSample', '/c/路径/')}</code>{' '}
            {t('customPage.helpP4e', '。需要后端或独立域名时请用反代，不要把整个项目塞进自定义页面。')}
          </p>
          <a
            target="_blank"
            href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/custom-page.md"
            rel="noreferrer"
          >
            {t('init.wizard.helpDoc', '帮助文档')}
          </a>
        </div>
      ),
    });
  };

  return (
    <>
      <Card
        className="card-body-full"
        // 🔴 卡片标题**复用菜单那一条** `menu.site.customPage`（同一个东西 ⇒ 一处口径，
        //    与图片管理页复用 menu.img 同一套做法），不新增 customPage.title 这个同值第二个 key。
        title={t('menu.site.customPage', '自定义页面')}
        extra={
          <Space>
            <CustomPageModal
              trigger={<Button type="primary">{t('common.create', '新建')}</Button>}
              onFinish={() => {
                actionRef.current?.reload();
                message.success(t('customPage.createdOk', '新建成功！'));
              }}
            />
            <Button type="link" key="help" onClick={handleHelp}>
              {t('common.help', '帮助')}
            </Button>
          </Space>
        }
      >
        <ProTable
          rowKey="_id"
          columns={columns}
          dateFormatter="string"
          actionRef={actionRef}
          search={false}
          options={false}
          pagination={{
            showQuickJumper: true,
            hideOnSinglePage: true,
            simple: true,
          }}
          request={async (params = {}) => {
            let { data } = await getCustomPages();
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
      </Card>
    </>
  );
}
