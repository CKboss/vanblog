import SiteInfoForm from '@/components/SiteInfoForm';
import { getSiteInfo, updateSiteInfo } from '@/services/van-blog/api';
import { useTab } from '@/services/van-blog/useTab';
import { ProForm } from '@ant-design/pro-form';
import { Card, message, Modal } from 'antd';
import { useIntl } from 'umi';
export default function () {
  // 🔴 期 6 第八批：站点配置页签（基本/高级/布局）与那几条提示接上 i18n。
  //    ⚠️ `message.*` / `Modal.*` 是脱离 React 树的独立根（§7.151）⇒ 传算好的字符串。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const [tab, setTab] = useTab('basic', 'siteInfoTab');
  const [form] = ProForm.useForm();
  const tabList = [
    {
      key: 'basic',
      tab: t('sysconf.siteInfoTabBasic', '基本设置'),
    },
    {
      key: 'more',
      tab: t('sysconf.tabAdvance', '高级设置'),
    },
    {
      key: 'layout',
      tab: t('sysconf.siteInfoTabLayout', '布局设置'),
    },
  ];

  return (
    <Card tabList={tabList} onTabChange={setTab} activeTabKey={tab}>
      <ProForm
        form={form}
        grid={true}
        layout={'horizontal'}
        labelCol={{ span: 6 }}
        request={async (params) => {
          const { data } = await getSiteInfo();
          return data;
        }}
        syncToInitialValues={true}
        onFinish={async (data) => {
          let ok = true;
          try {
            new URL(data.baseUrl);
          } catch (err) {
            ok = false;
          }
          if (!data.baseUrl) {
            ok = true;
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
            return;
          }
          if (location.hostname == 'blog-demo.mereith.com') {
            Modal.info({ title: t('siteInfo.demoBlockedEdit', '演示站禁止修改站点配置！') });
            return;
          }
          await updateSiteInfo(data);
          message.success(t('common.updateSuccess', '更新成功！'));
        }}
      >
        <SiteInfoForm
          form={form}
          showLayout={tab == 'layout'}
          showOption={tab == 'more'}
          showRequire={tab == 'basic'}
          isInit={false}
        />
      </ProForm>
    </Card>
  );
}
