import { saveExportArchive } from '@/services/van-blog/downloadArchive';
import TipTitle from '@/components/TipTitle';
import UploadBtn from '@/components/UploadBtn';
import {
  deleteAttachmentBySign,
  exportAllAttachments,
  getAttachments,
  searchArtclesByLink,
} from '@/services/van-blog/api';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { Button, message, Modal, Space, Table } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { history, useModel } from 'umi';
import type { StaticItem } from '../type';
import { copyAttachmentLink, downloadAttachment, getAttachmentLink } from './tools';

type AttachmentItem = StaticItem & { displayName?: string };

const ATTACHMENT_UPLOAD_URL = '/api/admin/file/upload';

export default () => {
  const actionRef = useRef<ActionType>();
  const [uploading, setUploading] = useState(false);
  const { initialState } = useModel('@@initialState');

  const showDelBtn = useMemo(() => {
    const user: any = initialState?.user;
    if (!user) {
      return false;
    }
    if (user.id == 0) {
      return true;
    }
    const ps = user.permissions || [];
    return ps.includes('file:delete') || ps.includes('all');
  }, [initialState]);

  async function handleDelete(record: AttachmentItem) {
    try {
      await deleteAttachmentBySign(record.sign);
      message.success('删除成功！已彻底删除本地文件。');
    } catch (err) {
      message.error('删除失败！');
    }
    actionRef.current?.reload();
  }

  async function handleSearchReference(record: AttachmentItem) {
    // 正文里可能写相对路径也可能写完整域名，用存储名（含 md5）搜索两种都能命中
    const { data } = await searchArtclesByLink(record.name);
    Modal.info({
      title: '被引用文章',
      width: 600,
      content: (
        <Table
          pagination={{ hideOnSinglePage: true }}
          rowKey={'id'}
          dataSource={data || []}
          size="small"
          columns={[
            { title: '文章 ID', dataIndex: 'id', key: 'id' },
            { title: '标题', dataIndex: 'title', key: 'title' },
            {
              title: '操作',
              key: 'action',
              render: (val: any, row: any) => (
                <a onClick={() => history.push(`/editor?type=article&id=${row.id}`)}>编辑</a>
              ),
            },
          ]}
        />
      ),
    });
  }

  const columns: ProColumns<AttachmentItem>[] = [
    {
      title: '文件名',
      dataIndex: 'displayName',
      ellipsis: true,
      fieldProps: { placeholder: '按文件名模糊搜索' },
      render: (_, record) => (
        <a href={getAttachmentLink(record.realPath)} target="_blank" rel="noreferrer">
          {record.displayName || record.name}
        </a>
      ),
    },
    {
      title: '格式',
      dataIndex: 'fileType',
      width: 90,
      hideInSearch: true,
      render: (_, record) => (record.fileType ? String(record.fileType).toUpperCase() : '-'),
    },
    {
      title: '大小',
      dataIndex: 'meta',
      width: 110,
      hideInSearch: true,
      render: (_, record) => (record.meta && record.meta.size) || '-',
    },
    {
      title: '链接',
      dataIndex: 'realPath',
      ellipsis: true,
      hideInSearch: true,
      copyable: true,
      render: (_, record) => getAttachmentLink(record.realPath),
    },
    {
      title: '上传时间',
      dataIndex: 'updatedAt',
      valueType: 'dateTime',
      width: 180,
      hideInSearch: true,
    },
    {
      title: '操作',
      valueType: 'option',
      width: 260,
      render: (_, record) => {
        const name = record.displayName || record.name;
        const actions = [
          <a
            key="copy"
            onClick={() => copyAttachmentLink(record.realPath, false, name)}
          >
            复制链接
          </a>,
          <a
            key="copyMd"
            onClick={() => copyAttachmentLink(record.realPath, true, name)}
          >
            复制 Markdown
          </a>,
          <a key="download" onClick={() => downloadAttachment(name, record.realPath)}>
            下载
          </a>,
          <a key="ref" onClick={() => handleSearchReference(record)}>
            搜索引用
          </a>,
        ];
        if (showDelBtn) {
          actions.push(
            <a
              key="delete"
              style={{ color: '#ff4d4f' }}
              onClick={() => {
                Modal.confirm({
                  title: '确定删除该附件吗？删除后不可恢复！',
                  onOk: () => handleDelete(record),
                });
              }}
            >
              删除
            </a>,
          );
        }
        return <Space size="middle">{actions}</Space>;
      },
    },
  ];

  return (
    <PageContainer
      className="t-0"
      header={{
        title: (
          <TipTitle
            title="附件管理"
            tip="上传任意文件并生成可分享的链接（/static/file/...）。附件只存本地，单文件上限 200MB；html/svg/js 这类会在站点源上执行的类型会被强制下载。"
          />
        ),
      }}
      extra={
        <Space>
          <Button
            onClick={async () => {
              const res: any = await exportAllAttachments();
              const name = res?.data?.path;
              if (!name) {
                message.error('打包失败！');
                return;
              }
              // 归档在服务器静态目录之外，必须走鉴权下载接口
              await saveExportArchive(name, '附件打包完成，已开始下载');
            }}
          >
            导出全部附件
          </Button>
          <UploadBtn
            setLoading={setUploading}
            loading={uploading}
            muti={true}
            text="上传附件"
            url={ATTACHMENT_UPLOAD_URL}
            accept="*"
            onFinish={(info: any) => {
              const data = info?.response?.data;
              if (data?.src) {
                copyAttachmentLink(
                  data.src,
                  false,
                  data.name,
                  data.isNew ? `${info.name} 上传成功！ ` : `${info.name} 已存在！ `,
                );
              }
              actionRef.current?.reload();
            }}
          />
        </Space>
      }
    >
      <ProTable<AttachmentItem>
        headerTitle="附件列表"
        actionRef={actionRef}
        rowKey="sign"
        columns={columns}
        search={{ labelWidth: 'auto' }}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        dateFormatter="string"
        request={async (params) => {
          const { current, pageSize, displayName } = params as any;
          const res: any = await getAttachments(current || 1, pageSize || 10, displayName);
          return {
            data: res?.data?.data || [],
            total: res?.data?.total || 0,
            success: res?.statusCode === 200,
          };
        }}
      />
    </PageContainer>
  );
};
