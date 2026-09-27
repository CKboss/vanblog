import { createArticle, createDraft } from '@/services/van-blog/api';
import { parseMarkdownFile } from '@/services/van-blog/parseMarkdownFile';
import { Alert, Button, Card, message, Space, Spin, Upload } from 'antd';
import { useState } from 'react';
import { useIntl } from 'umi';

const BatchImport = (props: { type: 'article' | 'draft'; beforeUpload: any }) => {
  // 🔴 期 6 第十四批：接上 i18n（这是个组件 ⇒ 可以用 hook）。
  // ⚠️ `message.*` 渲染进脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
    <Upload
      showUploadList={false}
      accept=".md"
      multiple={true}
      beforeUpload={async (file, files) => {
        await props.beforeUpload(props.type, file);
        if (files[files.length - 1] == file) {
          message.success(t('migrate.batchUploadDone', '批量上传完成！'));
        }
        return false;
      }}
    >
      <Button type="primary">
        {props.type == 'article'
          ? t('migrate.batchImportArticles', '批量导入文章')
          : t('migrate.batchImportDrafts', '批量导入草稿')}
      </Button>
    </Upload>
  );
};

export default function (props) {
  // 🔴 期 6 第十四批：这个组件（不是上面那个 BatchImport）里的文案也要 t ⇒ 各自持有自己的 hook。
  // ⚠️ 第一版只给 BatchImport 加了 hook，而 codemod 把 t() 写进了**这个**组件 ⇒ TS2304 ×3
  //    （🔴 类型门禁抓到的；这类"hook 加错了组件"在 .jsx 里不会报错，只会在运行时崩）。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [loading, setLoading] = useState(false);
  const handleImport = async (type, file) => {
    setLoading(true);
    try {
      // 🔴 `parseMarkdownFile(file, allowNotExistCategory, t)`：t 是**第 3 个**参数
      //    （它内部产的是给用户看的文案，例如分类缺失时的提示）⇒ 不传就是永远中文。
      const vals = await parseMarkdownFile(file, true, t);
      if (vals) {
        if (type == 'article') {
          await createArticle(vals);
        } else {
          await createDraft(vals);
        }
      }
    } catch (err) {}
    setLoading(false);
  };

  return (
    <>
      <Card title={t('sysconf.tabMigrate', '迁移助手')}>
        <Alert
          type="info"
          message={t('migrate.categoryWarning', '注意：使用迁移助手批量导入文章或草稿时，可能分类会为空，后期需要手动修改哦')}
          style={{ marginBottom: 20 }}
        />
        <Spin spinning={loading}>
          <Space size="large">
            <BatchImport type="article" beforeUpload={handleImport} />
            <BatchImport type="draft" beforeUpload={handleImport} />
            {/* <Upload showUploadList={false} accept=".md" multiple={true} beforeUpload={}>
              <Button>批量导入草稿</Button>
            </Upload> */}
          </Space>
        </Spin>
      </Card>
    </>
  );
}
