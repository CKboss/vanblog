import { getCommentSetting, updateCommentSetting } from '@/services/van-blog/api';
import {
  MAX_CONTENT_LENGTH_CAP,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS,
  RATE_LIMIT_CAP,
  normalizeCommentSetting,
  validateKeywords,
} from '@/services/van-blog/commentAdmin';
import { reportRequestError } from '@/services/van-blog/requestError';
import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
} from 'antd';
import { useIntl } from 'umi';
import { useCallback, useEffect, useState } from 'react';

const { Text } = Typography;

/**
 * 「评论系统」设置卡片：provider（内置 / Waline / 关闭）+ 内置评论的审核规则。
 * 挂在「系统设置 → 评论设置」页签里（WalineTab.jsx），排在原 Waline 表单前面——
 * provider 决定后面那张 Waline 表单是否真的生效，先选系统再配细节更符合直觉。
 *
 * 用普通 antd Form 而不是 ProForm：保存成功后必须**回读一次**服务端
 * （服务端会夹取数字上限，切 provider 还会启停 waline 子进程），
 * ProForm 的 request 只在挂载时跑一次，回读得靠 formRef 绕一圈，不如手动 load() 直白。
 */
export default function CommentSystem() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 单独存一份 provider 只为了切换时即时显示对应的提示文案，权威值仍以表单/服务端为准
  const [provider, setProvider] = useState('builtin');
  // 🔴 语言选择必须在**渲染期**：getLocale()/useIntl() 依赖 umi 插件运行时已初始化，
  //    在模块加载期调用会拿到 undefined（与 app.jsx 的 links 数组同一条约束，见手册 §7.134）。
  //    t() 的第二个实参是 defaultMessage，必须与 zh-CN 语言包里的值逐字相同（localePackParity 钉住）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getCommentSetting();
      const setting = normalizeCommentSetting(data);
      form.setFieldsValue(setting);
      setProvider(setting.provider);
    } catch (err) {
      reportRequestError(message, err, t('sysconf.comment.readFailed', '读取评论设置失败！'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onFinish = async (values) => {
    // 与 WalineForm 一致的演示站拦截：服务端也会回 statusCode:401「演示站禁止修改此项！」
    // （走全局 errorHandler 弹出来），这里提前拦一下，不发注定失败的请求
    if (location.hostname == 'blog-demo.mereith.com') {
      Modal.info({ title: t('common.demoBlocked', '演示站禁止修改此项！') });
      return;
    }
    // 七个字段全量提交：PUT 是整体覆盖语义，漏字段等于把服务端存的值冲掉
    const payload = {
      provider: values.provider,
      moderation: values.moderation,
      keywords: (values.keywords || []).map((k) => String(k).trim()).filter((k) => k !== ''),
      requireEmail: Boolean(values.requireEmail),
      pendingOnLink: Boolean(values.pendingOnLink),
      maxContentLength: Number(values.maxContentLength),
      rateLimitPer10Min: Number(values.rateLimitPer10Min),
    };
    const keywordError = validateKeywords(payload.keywords);
    if (keywordError) {
      message.error(keywordError);
      return;
    }
    setSaving(true);
    try {
      await updateCommentSetting(payload);
      message.success(t('common.updateSuccess', '更新成功！'));
      // 保存后回读：服务端可能夹取/规范化字段，表单必须显示实际生效的值
      await load();
    } catch (err) {
      reportRequestError(message, err, t('sysconf.comment.saveFailed', '保存失败！'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('sysconf.comment.title', '评论系统')} style={{ marginBottom: 20 }}>
      <Spin spinning={loading}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message={
            <div>
              <p style={{ marginBottom: 4 }}>
                {t('sysconf.comment.alertP1a', '内置评论与 Waline 是两套互相独立的系统：')}
                <b>{t('sysconf.comment.alertP1b', '切换到内置评论不会迁移已有的 Waline 评论')}</b>
                {t('sysconf.comment.alertP1c', '（反之亦然），原系统的历史评论只是不再展示，数据仍保留。')}
              </p>
              <p style={{ marginBottom: 0 }}>
                {t(
                  'sysconf.comment.alertP2',
                  '切换到 Waline 会自动启动内嵌 Waline 服务，切换到「关闭」会停掉前台评论入口。',
                )}
              </p>
            </div>
          }
        />
        <Form
          form={form}
          layout="horizontal"
          labelCol={{ span: 5 }}
          wrapperCol={{ span: 15 }}
          initialValues={normalizeCommentSetting(null)}
          onFinish={onFinish}
        >
          <Form.Item name="provider" label={t('sysconf.comment.title', '评论系统')}>
            <Radio.Group onChange={(e) => setProvider(e.target.value)}>
              <Radio value="builtin">{t('sysconf.comment.builtin', '内置评论')}</Radio>
              <Radio value="waline">Waline</Radio>
              <Radio value="off">{t('sysconf.comment.off', '关闭')}</Radio>
            </Radio.Group>
          </Form.Item>
          {provider === 'waline' ? (
            <Form.Item wrapperCol={{ offset: 5, span: 15 }}>
              <Text type="secondary">
                {t(
                  'sysconf.comment.walineHint',
                  'Waline 的邮件通知、强制登录等选项在下方「Waline 评论设置」卡片里配置。',
                )}
              </Text>
            </Form.Item>
          ) : null}
          {provider === 'builtin' ? (
            <Form.Item wrapperCol={{ offset: 5, span: 15 }}>
              <Text type="secondary">
                {t(
                  'sysconf.comment.builtinHint',
                  '内置评论无需注册、随主服务运行，下面的审核规则仅对内置评论生效。',
                )}
              </Text>
            </Form.Item>
          ) : null}
          <Form.Item
            name="moderation"
            label={t('sysconf.comment.moderationLabel', '审核策略')}
            tooltip={t(
              'sysconf.comment.moderationTip',
              '仅对内置评论生效；Waline 的审核在它自己的后台里配置',
            )}
          >
            <Radio.Group>
              <Space direction="vertical">
                <Radio value="post">
                  {t(
                    'sysconf.comment.modPost',
                    '先发后审 —— 评论直接显示；命中待审关键词或包含外链时自动转入「待审核」',
                  )}
                </Radio>
                <Radio value="pre">
                  {t(
                    'sysconf.comment.modPre',
                    '先审后发 —— 所有评论先进入「待审核」，人工通过后才在前台显示',
                  )}
                </Radio>
                <Radio value="none">
                  {t(
                    'sysconf.comment.modNone',
                    '不审核 —— 所有评论（含命中规则的）一律直接显示，请谨慎开启',
                  )}
                </Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="keywords"
            label={t('sysconf.comment.keywordsLabel', '待审关键词')}
            tooltip={t(
              'sysconf.comment.keywordsTip',
              '「先发后审」下，评论内容命中任一关键词（不区分大小写）就自动转待审；「先审后发」下所有评论本来就待审，关键词不再起作用',
            )}
            extra={t(
              'sysconf.comment.keywordsExtra',
              '最多 {max} 个，每个不超过 {len} 字符；输入后回车添加',
              { max: MAX_KEYWORDS, len: MAX_KEYWORD_LENGTH },
            )}
          >
            <Select
              mode="tags"
              tokenSeparators={[',', '，']}
              placeholder={t('sysconf.comment.keywordsPlaceholder', '输入关键词后回车，如：广告')}
              maxTagCount={20}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="requireEmail"
            label={t('sysconf.comment.requireEmailLabel', '邮箱必填')}
            valuePropName="checked"
            tooltip={t(
              'sysconf.comment.requireEmailTip',
              '开启后访客必须填写邮箱才能评论；邮箱只在后台可见，前台不会展示',
            )}
          >
            <Switch checkedChildren={t('common.on', '开')} unCheckedChildren={t('common.off', '关')} />
          </Form.Item>
          <Form.Item
            name="pendingOnLink"
            label={t('sysconf.comment.pendingOnLinkLabel', '含外链自动待审')}
            valuePropName="checked"
            tooltip={t(
              'sysconf.comment.pendingOnLinkTip',
              '「先发后审」下，包含 http(s) 链接或 www. 的评论自动转待审（垃圾广告的常见特征）',
            )}
          >
            <Switch checkedChildren={t('common.on', '开')} unCheckedChildren={t('common.off', '关')} />
          </Form.Item>
          <Form.Item
            name="maxContentLength"
            label={t('sysconf.comment.maxLenLabel', '内容长度上限')}
            tooltip={t(
              'sysconf.comment.maxLenTip',
              '单条评论允许的最大字符数，超出会被服务端拒绝',
            )}
            extra={`1 ~ ${MAX_CONTENT_LENGTH_CAP}`}
          >
            <InputNumber min={1} max={MAX_CONTENT_LENGTH_CAP} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            name="rateLimitPer10Min"
            label={t('sysconf.comment.rateLabel', '频率限制')}
            tooltip={t(
              'sysconf.comment.rateTip',
              '同一 IP 每 10 分钟最多能发表几条评论，超出的请求直接拒绝',
            )}
            extra={`1 ~ ${RATE_LIMIT_CAP}`}
          >
            <InputNumber min={1} max={RATE_LIMIT_CAP} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item wrapperCol={{ offset: 5, span: 15 }}>
            <Space>
              <Button type="primary" htmlType="submit" loading={saving}>
                {t('common.save', '保存')}
              </Button>
              <Button onClick={() => load()} disabled={saving || loading}>
                {t('common.reset', '重置')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Spin>
    </Card>
  );
}
