import Footer from '@/components/Footer';
import { fetchInit } from '@/services/van-blog/api';
import ProCard from '@ant-design/pro-card';
import { ProFormInstance } from '@ant-design/pro-form';
import { Alert, Modal } from 'antd';
import { useHistory } from 'umi';
//@ts-ignore
import styles from './index.less';

import { ProFormText, StepsForm } from '@ant-design/pro-form';

import SiteInfoForm from '@/components/SiteInfoForm';
import { encryptPwd } from '@/services/van-blog/encryptPwd';
import { useRef } from 'react';
import RestoreFromBackup from './RestoreFromBackup';

const InitPage = () => {
  const history = useHistory();
  const formMapRef = useRef<React.MutableRefObject<ProFormInstance<any> | undefined>[]>([]);
  const formRef1 = useRef<ProFormInstance>();
  const formRef2 = useRef<ProFormInstance>();
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {/* 「用备份恢复」放在向导**前面**且完全独立：手里有整站备份的用户
            一个初始化字段都不用填（管理员账号、站点设置、文章、图片全在归档里）。
            它不读任何表单状态，所以也不影响「站点已初始化 → 跳走」的重定向逻辑。 */}
        <ProCard title="已有整站备份？直接恢复" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="上传 full 备份归档，一步恢复整个旧站点"
            description={
              <div>
                管理员账号、站点设置、文章、图片<b>全部来自备份文件</b>，
                不需要填写下面初始化向导的任何信息；恢复完成后用备份里的账号密码登录。
              </div>
            }
          />
          <RestoreFromBackup />
        </ProCard>
        <div style={{ textAlign: 'center', color: '#999', margin: '4px 0 20px' }}>
          —— 或者，手动初始化 ——
        </div>
        <ProCard
          title={
            <div>
              <p style={{ fontSize: 20, marginBottom: 0 }}>欢迎使用 VanBlog 个人博客系统</p>
              <a
                target={'_blank'}
                rel="noreferrer"
                href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/config.md"
              >
                帮助文档
              </a>
            </div>
          }
        >
          <StepsForm
            formMapRef={formMapRef}
            onFinish={async (values) => {
              const { name, password, ...siteInfo } = values;
              const newData = {
                user: {
                  username: name,
                  password: encryptPwd(name, password),
                },
                siteInfo,
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
                    title: '初始化成功!',
                    content:
                      '首次使用请记得去后台 “站点管理/评论管理” 中注册一下评论系统的管理员账号哦！评论通知等设置可在 “系统设置/评论设置” 中找到。',
                    onOk: goLogin,
                    onCancel: goLogin,
                  });
                  return true;
                }
                return false;
              } catch (err) {
                const info = (err as any)?.data || (err as any)?.info || {};
                const status = info?.statusCode ?? (err as any)?.response?.status;
                if (status == 500 && String(info?.message || '').includes('已初始化')) {
                  Modal.info({
                    title: '本站已经初始化过了',
                    content: '初始化只能执行一次，接下来请直接登录。',
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
            <StepsForm.StepForm name="step1" title="配置用户">
              <Alert
                type="info"
                message="初始化页面所有配置都可在初始化后进入后台修改。"
                style={{ marginBottom: 8 }}
              ></Alert>
              <ProFormText
                name="name"
                required={true}
                rules={[{ required: true, message: '这是必填项' }]}
                label="登录用户名"
                placeholder={'请输入登录用户名'}
              ></ProFormText>
              {/* <ProFormText
                name="nickname"
                required={true}
                rules={[{ required: true, message: '这是必填项' }]}
                label="昵称"
                placeholder={'请输入昵称（显示的名字）'}
              ></ProFormText> */}
              <ProFormText.Password
                name="password"
                required={true}
                rules={[{ required: true, message: '这是必填项' }]}
                label="登录密码"
                placeholder={'请输入登录密码'}
              ></ProFormText.Password>
            </StepsForm.StepForm>
            <StepsForm.StepForm
              name="step2"
              title={'基本配置'}
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
                    title: '网站 URL 不合法！',
                    content: (
                      <div>
                        <p>请输入包含完整协议的 URL</p>
                        <p>例: https://blog-demo.mereith.com</p>
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
                message="默认的上传图片会到内置图床，如需配置 oss 图床，可在初始化后去设置页更改。初始化页面所有配置都可在初始化后进入后台修改。"
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
            <StepsForm.StepForm name="step3" title={'高级配置'} formRef={formRef2}>
              <Alert
                type="info"
                message="默认的上传图片会到内置图床，如需配置 oss 图床，可在初始化后去设置页更改。初始化页面所有配置都可在初始化后进入后台修改。"
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
            <StepsForm.StepForm name="step4" title={'布局配置'}>
              <Alert
                type="info"
                message="初始化页面所有配置都可在初始化后进入后台修改。"
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
