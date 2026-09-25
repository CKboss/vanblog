import CodeEditor from '@/components/CodeEditor';
import { getLayoutConfig, updateLayoutConfig } from '@/services/van-blog/api';
import { useTab } from '@/services/van-blog/useTab';
import { Button, Card, message, Modal, Spin } from 'antd';
import { useIntl } from 'umi';
import { useCallback, useEffect, useRef, useState } from 'react';
// 🔴 这里原本有一份模块级的帮助文案映射，已移进组件内部（见下面 helpMap 处的说明）。
export default function () {
  const [tab, setTab] = useTab('css', 'customTab');
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState({
    css: '',
    script: '',
    html: '',
    head: '',
  });
  const cardRef = useRef();
  // 🔴 语言选择必须在**渲染期**：useIntl() 是 hook，而模块级常量在模块加载期就求值 ——
  //    那时 umi 插件运行时还没初始化（与 app.jsx 的 links 数组同一条约束，见手册 §7.134）。
  //    所以帮助文案的映射从模块级搬到了这里；t() 的第二个实参是 defaultMessage，
  //    必须与 zh-CN 语言包里的值逐字相同（localePackParity 钉住这一条）。
  const intl = useIntl();
  const t = (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values);
  const helpMap = {
    css: t(
      'sysconf.customizing.helpCss',
      '自定义 css 会把您写入的 css 代码作为 <style> 标签插入到前台页面中的 <head> 中。',
    ),
    script: t(
      'sysconf.customizing.helpScript',
      '自定义 script 会把您写入的 script 代码作为 <script> 标签插入到前台页面的最下方。',
    ),
    html: t(
      'sysconf.customizing.helpHtml',
      '自定义 html 会把您写入的 html 代码插入到前台页面 body 标签中的下方。是静态化的，首屏源代码即存在。',
    ),
    head: t(
      'sysconf.customizing.helpHead',
      '自定义 html 会把您写入的 html 代码插入到前台页面的 head 标签中的下方。是静态化的，首屏源代码即存在，可以用于网站所有权验证。',
    ),
  };
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getLayoutConfig();
      if (data) {
        setValues({
          css: data?.css || '',
          script: data?.script || '',
          html: data?.html || '',
          head: data?.head || '',
        });
      }
    } catch (err) {
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setValues, setLoading]);
  const handleSave = async () => {
    Modal.confirm({
      title: t('sysconf.customizing.saveConfirmTitle', '保存确认'),
      content: t(
        'sysconf.customizing.saveConfirmBody',
        '在保存前请确认代码的正确性,有问题的代码可能导致前台报错！如不生效，请检查是否在站点配置/布局设置中打开了定制化功能。',
      ),
      onOk: async () => {
        setLoading(true);
        try {
          await updateLayoutConfig(values);
          setLoading(false);
          message.success(t('common.updateSuccess', '更新成功！'));
        } catch (err) {
          throw err;
        } finally {
          setLoading(false);
        }
      },
    });
  };
  const handleReset = async () => {
    fetchData();
    message.success(t('sysconf.customizing.resetOk', '重置成功！'));
  };
  const handleHelp = () => {
    Modal.info({
      title: t('common.help', '帮助'),
      content: (
        <div>
          <p>{helpMap[tab]}</p>
          <a
            target="_blank"
            // 上游这个地址已经 404，统一改指本分支仓库里的文档（与正在运行的代码同版本）
            href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/advanced/customizing.md"
            rel="noreferrer"
          >
            {t('init.wizard.helpDoc', '帮助文档')}
          </a>
        </div>
      ),
    });
  };
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  const languageMap = {
    css: 'css',
    script: 'javascript',
    html: 'html',
    head: 'html',
  };

  // 🔴 下面这四个内层页签标签**刻意尚未**接入 i18n，不是漏翻。
  //    原因：docs/advanced/customizing.md 里有一张表逐条列出了这四个标签名，
  //    而 analysisFields 与 adminCopySync 两个测试把「后台措辞 ↔ 文档措辞」钉在一起；
  //    站长尚未就「文档 i18n」裁定 ⇒ 只翻这一侧会造成「界面英文、文档仍是中文」的可见不一致。
  //    这与 SystemConfig/index.jsx 外层页签标签的暂缓是同一个裁定（父代理裁定，见手册）。
  //    前置条件满足后，这四个标签应与外层页签一批做完。
  const tabList = [
    {
      key: 'css',
      tab: '自定义 CSS',
    },
    {
      key: 'script',
      tab: '自定义 Script',
    },
    {
      key: 'html',
      tab: '自定义 HTML (body)',
    },
    {
      key: 'head',
      tab: '自定义 HTML (head)',
    },
  ];
  return (
    <>
      <Card
        ref={cardRef}
        tabList={tabList}
        onTabChange={setTab}
        activeTabKey={tab}
        defaultActiveTabKey={'css'}
        className="card-body-full"
        actions={[
          <Button type="link" key="save" onClick={handleSave}>
            {t('common.save', '保存')}
          </Button>,
          <Button type="link" key="reset" onClick={handleReset}>
            {t('common.reset', '重置')}
          </Button>,
          <Button type="link" key="help" onClick={handleHelp}>
            {t('common.help', '帮助')}
          </Button>,
        ]}
      >
        <Spin spinning={loading}>
          {tab == 'css' && (
            <CodeEditor
              height={600}
              language={languageMap[tab]}
              onChange={(v) => {
                setValues({ ...values, [tab]: v });
              }}
              value={values[tab] || ''}
            />
          )}
          {tab == 'script' && (
            <CodeEditor
              height={600}
              language={languageMap[tab]}
              onChange={(v) => {
                setValues({ ...values, [tab]: v });
              }}
              value={values[tab] || ''}
            />
          )}
          {tab == 'html' && (
            <CodeEditor
              height={600}
              language={languageMap[tab]}
              onChange={(v) => {
                setValues({ ...values, [tab]: v });
              }}
              value={values[tab] || ''}
            />
          )}
          {tab == 'head' && (
            <CodeEditor
              height={600}
              language={languageMap[tab]}
              onChange={(v) => {
                setValues({ ...values, [tab]: v });
              }}
              value={values[tab] || ''}
            />
          )}
        </Spin>
      </Card>
    </>
  );
}
