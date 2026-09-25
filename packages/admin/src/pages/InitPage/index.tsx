import Footer from '@/components/Footer';
import { fetchInit } from '@/services/van-blog/api';
import ProCard from '@ant-design/pro-card';
import { ProFormInstance } from '@ant-design/pro-form';
import { Alert, Input, Modal } from 'antd';
import { SelectLang, useHistory, useIntl } from 'umi';
//@ts-ignore
import styles from './index.less';

import { ProFormText, StepsForm } from '@ant-design/pro-form';

import SiteInfoForm from '@/components/SiteInfoForm';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { accountPasswordMinRule } from '@/services/van-blog/passwordPolicy';
import { useRef, useState } from 'react';
import RestoreFromBackup from './RestoreFromBackup';
import { SETUP_KEY_FIELD, extractSetupKeyRejection, getSetupKeyHints } from './setupKeyCore';

const InitPage = () => {
  const history = useHistory();
  const intl = useIntl();
  /**
   * 🔴 多语言（第一期）。`/init` 路由是 `layout: false`（不带 ProLayout），
   * 所以后台头部那个由 plugin-layout 自动渲染的 `<SelectLang />` **不会出现在本页**
   * ⇒ 下面自己放一个。语言包是静态 import 编译进 bundle 的（plugin-locale 的 locale.tpl），
   * 不是运行时拉取 ⇒ 站点尚未初始化、服务端接口还不能依赖时也能正常切换。
   *
   * `t` 同时用于把翻译器注入 `setupKeyCore`（纯 JS、被 node --test 直接 require，
   * 拿不到 umi 运行时；不传时原样返回中文，所以那些单测逐字不变）。
   */
  // 🔴 `values` 必须是 `Record<string, any>`：react-intl 3 的 `formatMessage` 第二个形参要的是
  //    `Record<string, PrimitiveType | FormatXMLElementFn<…>>`，而 `Record<string, unknown>` **不可赋值**给它
  //    ⇒ 实测报 **TS2769（没有匹配的重载）**。这个形状在仓库里复制过 4 次，4 处都因此各背一条类型错误
  //    （admin 类型门禁的 TS2769 基线本来就是 3）⇒ 期 4 一并改成 any、把基线降到 0。
  //    ⚠️ 别"好心"改回 unknown：那会把 TS2769 带回来（棘轮会红，而且红得很莫名）。
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const setupKeyHints = getSetupKeyHints(t);
  const formMapRef = useRef<React.MutableRefObject<ProFormInstance<any> | undefined>[]>([]);
  const formRef1 = useRef<ProFormInstance>();
  const formRef2 = useRef<ProFormInstance>();
  /**
   * 初始化密钥（setup key）状态：服务端开 VANBLOG_INIT_REQUIRE_SETUP_KEY=true 时，
   * 两条初始化路由（向导提交 / 备份恢复上传）都要求 `setupKey` 字段。
   *
   * ⚠️ 输入框**只在服务端真的要密钥时才出现**（required 初始为 false）：
   * 判定信号来自 400 响应 body 里的 `setupKeyRequired:true`（机器可读标志，
   * 见 ./setupKeyCore.js），绝不在每个全新安装上摆一个空框吓人。
   * 页面加载时也**不发探测请求**：/api/admin/init* 前缀挂着 5 次/10 分钟的限流桶，
   * 探测会烧掉站长自己的提交预算。
   * 状态放在这一层（而不是向导里）：与「用备份恢复」卡片**共享同一个输入框**，
   * 两条提交路径带的是同一个值。
   */
  const [setupKeyRequired, setSetupKeyRequired] = useState(false);
  const [setupKeyNotice, setSetupKeyNotice] = useState('');
  const [setupKeyValue, setSetupKeyValue] = useState('');
  const markSetupKeyRequired = (serverMessage: string) => {
    setSetupKeyRequired(true);
    setSetupKeyNotice(String(serverMessage || ''));
  };
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {/* 🔴 `/init` 是 `layout: false`，拿不到 ProLayout 头部那个自动渲染的切换器，
            所以在这里自己放一个。右对齐，不占用向导的视觉主线。 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <SelectLang />
        </div>
        {setupKeyRequired && (
          <ProCard
            title={t('init.setupKey.cardTitle', '本站开启了初始化保护：请填写初始化密钥')}
            style={{ marginBottom: 16 }}
          >
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                setupKeyNotice ||
                t(
                  'init.setupKey.alertFallback',
                  '服务端要求携带初始化密钥（setup key）后才能完成初始化/恢复',
                )
              }
              description={
                <ul style={{ paddingLeft: 20, marginBottom: 0, color: '#888' }}>
                  {setupKeyHints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              }
            />
            {/* type=password（Input.Password）+ autoComplete=off：密钥不是账号密码，
                不许浏览器把它存进密码管理器，也不许自动填充旧值 */}
            <Input.Password
              value={setupKeyValue}
              onChange={(e) => setSetupKeyValue(e.target.value)}
              autoComplete="off"
              placeholder={t(
                'init.setupKey.placeholder',
                '粘贴 setup.key 文件的完整内容（或启动日志里「初始化密钥」那一行）',
              )}
              style={{ maxWidth: 520 }}
            />
          </ProCard>
        )}
        {/* 「用备份恢复」放在向导**前面**且完全独立：手里有整站备份的用户
            一个初始化字段都不用填（管理员账号、站点设置、文章、图片全在归档里）。
            它不读任何表单状态，所以也不影响「站点已初始化 → 跳走」的重定向逻辑。 */}
        <ProCard
          title={t('init.restore.cardTitle', '已有整站备份？直接恢复')}
          style={{ marginBottom: 16 }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('init.restore.cardMessage', '上传 full 备份归档，一步恢复整个旧站点')}
            description={
              <div>
                {t('init.restore.cardNotePrefix', '管理员账号、站点设置、文章、图片')}
                <b>{t('init.restore.cardNoteStrong', '全部来自备份文件')}</b>
                {t(
                  'init.restore.cardNoteSuffix',
                  '，不需要填写下面初始化向导的任何信息；恢复完成后用备份里的账号密码登录。',
                )}
              </div>
            }
          />
          <RestoreFromBackup setupKey={setupKeyValue} onSetupKeyRequired={markSetupKeyRequired} />
        </ProCard>
        <div style={{ textAlign: 'center', color: '#999', margin: '4px 0 20px' }}>
          {t('init.divider', '—— 或者，手动初始化 ——')}
        </div>
        <ProCard
          title={
            <div>
              <p style={{ fontSize: 20, marginBottom: 0 }}>
                {t('init.wizard.title', '欢迎使用 VanBlog 个人博客系统')}
              </p>
              <a
                target={'_blank'}
                rel="noreferrer"
                href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/config.md"
              >
                {t('init.wizard.helpDoc', '帮助文档')}
              </a>
            </div>
          }
        >
          <StepsForm
            formMapRef={formMapRef}
            onFinish={async (values) => {
              const { name, password, ...siteInfo } = values;
              const trimmedKey = setupKeyValue.trim();
              const newData = {
                user: {
                  username: name,
                  password: encryptPwd(name, password),
                },
                siteInfo,
                // 只在真的有值时携带（服务端没开保护时多这个字段也无害，
                // 但默认路径的请求体保持与旧版逐字节一致）
                ...(trimmedKey ? { [SETUP_KEY_FIELD]: trimmedKey } : {}),
              };
              const goLogin = () => {
                history.push('/user/login');
              };
              // 服务端判断「已经初始化过」的方式是 throw new HttpException('已初始化', 500)，
              // 也就是一个 HTTP 500：umi-request 会 reject（body 在 err.data 上），
              // 根本走不到下面这个 if。以前写成 `statusCode == 500` 也算成功，
              // 那段「已初始化就去登录页」的分支等于死代码 —— 用户只看到一条报错弹不出登录页。
              try {
                const res = await fetchInit(newData);
                if (res?.statusCode == 200) {
                  Modal.success({
                    title: t('init.success.title', '初始化成功!'),
                    content: t(
                      'init.success.content',
                      '首次使用请记得去后台 “站点管理/评论管理” 中注册一下评论系统的管理员账号哦！评论通知等设置可在 “系统设置/评论设置” 中找到。',
                    ),
                    onOk: goLogin,
                    onCancel: goLogin,
                  });
                  return true;
                }
                return false;
              } catch (err) {
                const info = (err as any)?.data || (err as any)?.info || {};
                // 服务端在要初始化密钥：显示共享输入框 + 把服务端原话挂在上面，
                // 表单留在原地方便填完直接重试（全局 errorHandler 也弹过同一条 message）
                const rejection = extractSetupKeyRejection(err);
                if (rejection.required || rejection.unavailable) {
                  markSetupKeyRequired(rejection.message);
                  return false;
                }
                const status = info?.statusCode ?? (err as any)?.response?.status;
                if (status == 500 && String(info?.message || '').includes('已初始化')) {
                  Modal.info({
                    title: t('init.alreadyInit.title', '本站已经初始化过了'),
                    content: t('init.alreadyInit.content', '初始化只能执行一次，接下来请直接登录。'),
                    onOk: goLogin,
                    onCancel: goLogin,
                  });
                  return true;
                }
                // 其它失败全局 errorHandler 已经弹过原因了，这里让表单留着方便重试
                return false;
              }
            }}
          >
            <StepsForm.StepForm name="step1" title={t('init.step.user', '配置用户')}>
              <Alert
                type="info"
                message={t('init.alert.allEditable', '初始化页面所有配置都可在初始化后进入后台修改。')}
                style={{ marginBottom: 8 }}
              ></Alert>
              <ProFormText
                name="name"
                required={true}
                rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
                label={t('init.field.username', '登录用户名')}
                placeholder={t('init.field.usernamePlaceholder', '请输入登录用户名')}
              ></ProFormText>
              {/* <ProFormText
                name="nickname"
                required={true}
                rules={[{ required: true, message: '这是必填项' }]}
                label="昵称"
                placeholder={'请输入昵称（显示的名字）'}
              ></ProFormText> */}
              {/* ⚠️ 这条 `min` 规则是「账号口令 ≥10」在初始化向导上**唯一**的强制点。
                  onFinish 里的 encryptPwd 会把口令派生成恒 64 位十六进制摘要再发出去，
                  服务端看到的长度与原始口令无关（sha256 不可逆）⇒ 服务端在数学上判不了强度。
                  rules 作用于**派生之前**的原始输入（onFinish 拿到的 values 才是原始值）。
                  策略与理由见 services/van-blog/passwordPolicy.js。 */}
              <ProFormText.Password
                name="password"
                required={true}
                rules={[
                  { required: true, message: t('init.field.required', '这是必填项') },
                  accountPasswordMinRule(),
                ]}
                label={t('init.field.password', '登录密码')}
                placeholder={t('init.field.passwordPlaceholder', '请输入登录密码')}
              ></ProFormText.Password>
            </StepsForm.StepForm>
            <StepsForm.StepForm
              name="step2"
              title={t('init.step.basic', '基本配置')}
              formRef={formRef1}
              onFinish={async (values) => {
                let ok = true;
                try {
                  new URL(values.baseUrl);
                } catch (err) {
                  ok = false;
                }
                if (!ok) {
                  Modal.warn({
                    title: t('init.baseUrl.invalidTitle', '网站 URL 不合法！'),
                    content: (
                      <div>
                        <p>{t('init.baseUrl.invalidLine1', '请输入包含完整协议的 URL')}</p>
                        <p>{t('init.baseUrl.invalidLine2', '例: https://blog.example.com')}</p>
                      </div>
                    ),
                  });
                  return false;
                }
                return true;
              }}
            >
              <Alert
                type="info"
                message={t(
                  'init.alert.uploadDefault',
                  '默认的上传图片会到内置图床，如需配置 oss 图床，可在初始化后去设置页更改。初始化页面所有配置都可在初始化后进入后台修改。',
                )}
                style={{ marginBottom: 8 }}
              ></Alert>
              <SiteInfoForm
                showRequire={true}
                showOption={false}
                showLayout={false}
                form={formRef1}
                isInit={true}
              />
            </StepsForm.StepForm>
            <StepsForm.StepForm
              name="step3"
              title={t('init.step.advanced', '高级配置')}
              formRef={formRef2}
            >
              <Alert
                type="info"
                message={t(
                  'init.alert.uploadDefault',
                  '默认的上传图片会到内置图床，如需配置 oss 图床，可在初始化后去设置页更改。初始化页面所有配置都可在初始化后进入后台修改。',
                )}
                style={{ marginBottom: 8 }}
              ></Alert>
              <SiteInfoForm
                showRequire={false}
                showOption={true}
                showLayout={false}
                form={formRef2}
                isInit={true}
              />
            </StepsForm.StepForm>
            <StepsForm.StepForm name="step4" title={t('init.step.layout', '布局配置')}>
              <Alert
                type="info"
                message={t('init.alert.allEditable', '初始化页面所有配置都可在初始化后进入后台修改。')}
                style={{ marginBottom: 8 }}
              ></Alert>
              <SiteInfoForm
                isInit={true}
                showRequire={false}
                showOption={false}
                showLayout={true}
                form={null}
              />
            </StepsForm.StepForm>
          </StepsForm>
        </ProCard>
      </div>
      <Footer />
    </div>
  );
};
export default InitPage;
