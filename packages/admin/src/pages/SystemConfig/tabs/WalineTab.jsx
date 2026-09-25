import WalineForm from '@/components/WalineForm';
import { useIntl } from 'umi';
import { Alert, Card } from 'antd';
import CommentSystem from './CommentSystem';

export default function () {
  const intl = useIntl();
  const t = (id, defaultMessage, values) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      {/* 「评论系统」放在最前面：provider 决定下面这张 Waline 表单是否真的生效 */}
      <CommentSystem />
      <Card title={t('sysconf.waline.title', 'Waline 评论设置')}>
        <Alert
          type="info"
          message={
            <div>
              <p>
                <span>{t(
                    'sysconf.waline.notice',
                    '本表单控制内嵌 Waline 评论系统。换成自定义域名邮箱时，开启「是否启用邮件通知」后填写 SMTP、博主邮箱（收件人）和发件地址（From）即可，不用另外部署邮件服务。说明见：',
                  )}</span>
                <a
                  target={'_blank'}
                  rel="noreferrer"
                  // 上游这个地址已经 404；本分支的评论文档同时写了内置评论与 Waline 两套
                  href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/comment.md"
                >
                  {/* 🔴 复用第一期已有的 key，不新增同值第二处口径 */}
                  {t('init.wizard.helpDoc', '帮助文档')}
                </a>
              </p>
            </div>
          }
          style={{ marginBottom: 20 }}
        />
        <WalineForm />
      </Card>
    </>
  );
}
