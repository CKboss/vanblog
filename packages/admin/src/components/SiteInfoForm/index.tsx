import { BAIDU_ANALYSIS_FIELD, GA_ANALYSIS_FIELD } from '@/utils/analysisFields';
import { listThemes } from '@/services/van-blog/skinTheme';
import { ProFormDateTimePicker, ProFormDigit, ProFormSelect, ProFormText, ProFormTextArea } from '@ant-design/pro-form';
import UrlFormItem from '../UrlFormItem';
import { useIntl } from 'umi';

export default function (props: {
  showOption: boolean;
  showRequire: boolean;
  showLayout: boolean;
  form: any;
  isInit: boolean;
}) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 运行时还没初始化）。
  //    t() 的第二个实参是 defaultMessage，必须与 zh-CN 语言包逐字相同（localePackParity 钉住）。
  //    ⚠️ 本文件没有把 t 放进任何 useCallback/useEffect/useMemo 的依赖数组；将来若要放，
  //    🔴 必须先把 t 用 useCallback([intl]) 包起来（否则无限渲染/请求循环，见手册 §7.144 A）。
  const intl = useIntl();
  // 🔴 `values` 必须是 `Record<string, any>`：react-intl 3 的 `formatMessage` 第二个形参要的是
  //    `Record<string, PrimitiveType | FormatXMLElementFn<…>>`，而 `Record<string, unknown>` **不可赋值**给它
  //    ⇒ 实测报 **TS2769（没有匹配的重载）**。这个形状在仓库里复制过 4 次，4 处都因此各背一条类型错误
  //    （admin 类型门禁的 TS2769 基线本来就是 3）⇒ 期 4 一并改成 any、把基线降到 0。
  //    ⚠️ 别"好心"改回 unknown：那会把 TS2769 带回来（棘轮会红，而且红得很莫名）。
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  return (
    <>
      {props.showRequire && (
        <>
          <ProFormText
            name="author"
            required
            label={t('siteInfo.author.label', '作者名字')}
            placeholder={t('siteInfo.author.placeholder', '请输入作者名字')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          />
          <ProFormText
            name="authorDesc"
            required
            label={t('siteInfo.authorDesc.label', '作者描述')}
            placeholder={t('siteInfo.authorDesc.placeholder', '请输入作者描述')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          />
          <UrlFormItem
            isInit={props.isInit}
            formRef={props.form}
            name="authorLogo"
            required
            label={t('siteInfo.authorLogo.label', '作者 Logo')}
            placeholder={t('siteInfo.authorLogo.placeholder', '请输入作者 Logo Url')}
          />
        </>
      )}
      {props.showOption && (
        <UrlFormItem
          required={false}
          formRef={props.form}
          name="authorLogoDark"
          label={t('siteInfo.authorLogoDark.label', '作者 Logo（黑暗模式）')}
          placeholder={t('siteInfo.authorLogoDark.placeholder', '请输入黑暗模式作者 Logo Url，留空表示沿用上个')}
          isInit={props.isInit}
        />
      )}
      {props.showOption && (
        <>
          <UrlFormItem
            formRef={props.form}
            name="siteLogo"
            required={false}
            label={t('siteInfo.siteLogo.label', '网站 Logo')}
            placeholder={t('siteInfo.siteLogo.placeholder', '请输入网站 Logo Url')}
            isInit={props.isInit}
          />
          <UrlFormItem
            formRef={props.form}
            name="siteLogoDark"
            label={t('siteInfo.siteLogoDark.label', '网站 Logo（黑暗模式）')}
            required={false}
            placeholder={t('siteInfo.siteLogoDark.placeholder', '请输入网站黑暗模式 Logo Url，留空表示沿用上个')}
            isInit={props.isInit}
          />
        </>
      )}
      {props.showRequire && (
        <>
          <UrlFormItem
            isInit={props.isInit}
            formRef={props.form}
            name="favicon"
            required
            label={t('siteInfo.favicon.label', '网站图标(favicon)')}
            placeholder={t('siteInfo.favicon.placeholder', '请输入网站图标 Url')}
            isFavicon={true}
          />
          <ProFormText
            name="siteName"
            required
            label={t('siteInfo.siteName.label', '网站名')}
            placeholder={t('siteInfo.siteName.placeholder', '请输入网站名')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          />
          <ProFormText
            name="siteDesc"
            required
            label={t('siteInfo.siteDesc.label', '网站描述')}
            placeholder={t('siteInfo.siteDesc.placeholder', '请输入网站描述')}
            rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          />
        </>
      )}
      {props.showOption && (
        <>
          <UrlFormItem
            formRef={props.form}
            isInit={props.isInit}
            name="payAliPay"
            label={t('siteInfo.payAliPay.label', '支付宝图片 Url')}
            placeholder={t('siteInfo.payAliPay.placeholder', '请输入支付宝打赏图片 Url，留空不启用打赏')}
            required={false}
          />
          <UrlFormItem
            formRef={props.form}
            isInit={props.isInit}
            name="payAliPayDark"
            label={t('siteInfo.payAliPayDark.label', '支付宝图片 Url（黑暗模式）')}
            placeholder={t('siteInfo.payAliPayDark.placeholder', '请输入黑暗模式支付宝打赏图片 Url，留空沿用上个')}
            required={false}
          />
          <UrlFormItem
            formRef={props.form}
            isInit={props.isInit}
            name="payWechat"
            label={t('siteInfo.payWechat.label', '微信图片 Url')}
            placeholder={t('siteInfo.payWechat.placeholder', '请输入微信打赏图片 Url，留空不启用打赏')}
            required={false}
          />
          <UrlFormItem
            formRef={props.form}
            isInit={props.isInit}
            name="payWechatDark"
            label={t('siteInfo.payWechatDark.label', '微信图片 Url（黑暗模式）')}
            placeholder={t('siteInfo.payWechatDark.placeholder', '请输入黑暗模式微信打赏图片 Url，留空沿用上个')}
            required={false}
          />
        </>
      )}
      {props.showRequire && (
        <ProFormText
          name="baseUrl"
          rules={[{ required: true, message: t('init.field.required', '这是必填项') }]}
          label={t('siteInfo.baseUrl.label', '网站 Url')}
          placeholder={t('siteInfo.baseUrl.placeholder', '请输入包含访问协议的完整 URL')}
          tooltip={t('siteInfo.baseUrl.tooltip', '请输入包含访问协议的完整 URL，此 URL 会被用来生成前后台/RSS的相关数据。')}
          required={true}
        />
      )}
      {props.showOption && (
        <>
          <ProFormText name="copyrightAggreement" label={t('siteInfo.copyrightAggreement.label', '版权协议')} placeholder={t('siteInfo.copyrightAggreement.label', '版权协议')} />
          <ProFormText
            name="beianNumber"
            label={t('siteInfo.beianNumber.label', 'ICP 备案号')}
            placeholder={t('siteInfo.beianNumber.placeholder', '请输入备案号，留空不显示备案信息')}
          />
          <ProFormText
            name="beianUrl"
            label={t('siteInfo.beianUrl.label', 'ICP 备案网址')}
            placeholder={t('siteInfo.beianUrl.placeholder', '请输入备案网址，留空不显示备案信息')}
          />
          <ProFormText
            name="gaBeianNumber"
            label={t('siteInfo.gaBeianNumber.label', '公安备案号')}
            placeholder={t('siteInfo.gaBeianNumber.placeholder', '请输入公安备案号，留空不显示公安备案信息')}
          />
          <ProFormText
            name="gaBeianUrl"
            label={t('siteInfo.gaBeianUrl.label', '公安备案网址')}
            placeholder={t('siteInfo.gaBeianUrl.placeholder', '请输入公安备案号点击后跳转的网址，留空则不跳转')}
          />
          <UrlFormItem
            formRef={props.form}
            isInit={props.isInit}
            name="gaBeianLogoUrl"
            label={t('siteInfo.gaBeianLogoUrl.label', '公安备案 Logo 地址')}
            placeholder={t('siteInfo.gaBeianLogoUrl.placeholder', '请输入公安备案的 logo 的 url，留空不显示公安备案 logo')}
            required={false}
          />
          <ProFormText
            name={GA_ANALYSIS_FIELD.name}
            label={GA_ANALYSIS_FIELD.label}
            placeholder={GA_ANALYSIS_FIELD.placeholder}
            tooltip={GA_ANALYSIS_FIELD.tooltip}
          />
          <ProFormText
            name={BAIDU_ANALYSIS_FIELD.name}
            label={BAIDU_ANALYSIS_FIELD.label}
            placeholder={BAIDU_ANALYSIS_FIELD.placeholder}
            tooltip={BAIDU_ANALYSIS_FIELD.tooltip}
          />
          <ProFormSelect
            name={'enableComment'}
            label={t('siteInfo.enableComment.label', '是否开启评论系统')}
            placeholder={t('common.enabled', '开启')}
            valueEnum={{
              true: t('common.enabled', '开启'),
              false: t('common.disabled', '关闭'),
            }}
            tooltip={t('siteInfo.enableComment.tooltip', '默认开启')}
          />
          <ProFormDateTimePicker
            name="since"
            width={'lg'}
            label={t('siteInfo.since.label', '建站时间')}
            placeholder={t('siteInfo.since.placeholder', '不填默认为此刻')}
          />
        </>
      )}
      {/* 布局选项 */}
      {props.showLayout && (
        <>
          <ProFormDigit
            name={'articlesPerPage'}
            label={t('siteInfo.articlesPerPage.label', '每页文章数')}
            placeholder={'5'}
            fieldProps={{ precision: 0 }}
            min={1}
            max={50}
            tooltip={t('siteInfo.articlesPerPage.tooltip', '前台首页与 /page/n 每页展示的文章数量。默认 5，范围 1–50。分类/标签/时间线仍是完整列表。')}
          />
          <ProFormSelect
            name={'uiStyle'}
            label={t('siteInfo.uiStyle.label', '界面风格')}
            placeholder={t('siteInfo.uiStyle.placeholder', 'Apple 风格')}
            tooltip={t('siteInfo.uiStyle.tooltip', '前台展示页的视觉风格。Apple 风格参考 developer.apple.com/news：单列发丝线分隔的列表、SF Pro 字体、17px 正文、毛玻璃导航、苹果蓝强调色，并自动适配暗色模式。只改样式不改结构，随时可切回默认。除了内置的两个，这里还会列出「系统设置 → 主题」里上传的自定义主题（上传/管理请去那个页签）。')}
            // 初始化向导阶段还没有登录态，调 /api/admin/** 一定 401，所以那时只给内置项
            request={
              props.isInit
                ? undefined
                : async () => {
                    const builtin = [
                      { label: t('siteInfo.uiStyle.apple', 'Apple 风格（推荐）'), value: 'apple' },
                      { label: t('siteInfo.uiStyle.default', '默认（原卡片风格）'), value: 'default' },
                    ];
                    try {
                      const res = await listThemes();
                      const list = res?.data?.themes || [];
                      if (!list.length) return builtin;
                      // 内置的排前面，上传的按服务端给的顺序跟在后面
                      const order = (id) => (id === 'apple' ? 0 : id === 'default' ? 1 : 2);
                      return [...list]
                        .sort((a, b) => order(a.id) - order(b.id))
                        .map((th) => ({
                          // 🔴 形参原本叫 t —— 与本组件的翻译器**同名会遮蔽** ⇒ 改名 th
                          label:
                            th.source === 'builtin'
                              ? `${th.name}`
                              : `${th.name}${t('siteInfo.uiStyle.customSuffix', '（自定义·{id}）', { id: th.id })}`,
                          value: th.id,
                        }));
                    } catch (e) {
                      return builtin;
                    }
                  }
            }
            valueEnum={
              props.isInit
                ? {
                    apple: t('siteInfo.uiStyle.apple', 'Apple 风格（推荐）'),
                    default: t('siteInfo.uiStyle.default', '默认（原卡片风格）'),
                  }
                : undefined
            }
            fieldProps={{ defaultValue: 'apple' }}
          />
          <ProFormSelect
            name={'showSubMenu'}
            label={t('siteInfo.showSubMenu.label', '显示分类导航栏')}
            placeholder={t('common.hide', '隐藏')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showSubMenu.tooltip', '默认隐藏，开启后将在主导航栏下方显示分类子导航栏（其实就是双层导航栏）。')}
          />

          <ProFormDigit
            name={'subMenuOffset'}
            label={t('siteInfo.subMenuOffset.label', '分类导航栏左侧偏移（px）')}
            dependencies={['showSubMenu']}
            placeholder={'0'}
            fieldProps={{ precision: 0 }}
            min={0}
            max={200}
            tooltip={t('siteInfo.subMenuOffset.tooltip', '导航栏显示的是网站名的时候，设置正确偏移以对其分类第一个字。')}
          />
          <ProFormSelect
            name={'headerLeftContent'}
            label={t('siteInfo.headerLeftContent.label', '导航栏左侧显示内容')}
            valueEnum={{
              siteLogo: t('siteInfo.headerLeftContent.siteLogo', '网站logo'),
              siteName: t('siteInfo.headerLeftContent.siteName', '网站名'),
            }}
            placeholder={t('siteInfo.headerLeftContent.siteName', '网站名')}
            tooltip={t('siteInfo.headerLeftContent.tooltip', '显示网站 logo 的前提是已设置正确的网站 logo 哦。默认显示网站名')}
          />
          <ProFormSelect
            name={'showAdminButton'}
            label={t('siteInfo.showAdminButton.label', '后台按钮是否显示')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showAdminButton.tooltip', '默认显示，关闭后前台会隐藏后台按钮')}
          />
          <ProFormSelect
            name={'showDonateInfo'}
            label={t('siteInfo.showDonateInfo.label', '是否显示捐赠信息')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showDonateInfo.tooltip', '默认显示，关闭后关于页面会隐藏捐赠信息')}
          />

          <ProFormSelect
            name={'showCopyRight'}
            label={t('siteInfo.showCopyRight.label', '是否显示版权声明')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showCopyRight.tooltip', '默认显示，关闭后文章页面将不显示版权声明')}
          />
          <ProFormSelect
            name={'showDonateButton'}
            label={t('siteInfo.showDonateButton.label', '是否显示打赏按钮')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showDonateButton.tooltip', '默认显示（前提是设置了支付宝和微信支付图片），关闭后所有位置将不显示打赏按钮')}
          />
          <ProFormSelect
            name={'showDonateInAbout'}
            label={t('siteInfo.showDonateInAbout.label', '关于页面是否显示打赏按钮')}
            placeholder={t('common.hide', '隐藏')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showDonateInAbout.tooltip', '默认隐藏，开启后关于页面会显示打赏按钮')}
          />
          <ProFormSelect
            name={'defaultTheme'}
            label={t('siteInfo.defaultTheme.label', '前台默认主题模式')}
            placeholder={t('siteInfo.defaultTheme.placeholder', '自动模式')}
            valueEnum={{
              auto: t('siteInfo.defaultTheme.placeholder', '自动模式'),
              dark: t('siteInfo.defaultTheme.dark', '暗色模式'),
              light: t('siteInfo.defaultTheme.light', '亮色模式'),
            }}
            tooltip={t('siteInfo.defaultTheme.tooltip', '设置后第一次进入前台的用户将以此作为默认主题模式')}
          />
          <ProFormSelect
            name={'allowOpenHiddenPostByUrl'}
            label={t('siteInfo.allowOpenHiddenPostByUrl.label', '是否允许通过 URL 打开隐藏的文章')}
            placeholder={t('common.disallow', '不允许')}
            valueEnum={{
              true: t('common.allow', '允许'),
              false: t('common.disallow', '不允许'),
            }}
            tooltip={t('siteInfo.allowOpenHiddenPostByUrl.tooltip', '默认不允许，开启后可通过 URL 打开隐藏文章。')}
          />
          <ProFormSelect
            name={'enableCustomizing'}
            label={t('siteInfo.enableCustomizing.label', '是否开启定制化功能')}
            placeholder={t('common.enabled', '开启')}
            valueEnum={{
              true: t('common.enabled', '开启'),
              false: t('common.disabled', '关闭'),
            }}
            tooltip={t('siteInfo.enableCustomizing.tooltip', '默认开启，关闭后即使通过定制化面板，自定义了 CSS、Script、HTML 也不会生效。')}
          />
          <ProFormSelect
            name={'showRSS'}
            label={t('siteInfo.showRSS.label', '是否显示 RSS 按钮')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showRSS.tooltip', '默认显示，关闭后所有位置会隐藏 RSS 按钮。')}
          />
          <ProFormSelect
            name={'defaultExpandAllCategories'}
            label={t('siteInfo.defaultExpandAllCategories.label', '分类页默认展开全部分类')}
            placeholder={t('siteInfo.defaultExpandAllCategories.placeholder', '默认收起')}
            valueEnum={{
              true: t('siteInfo.defaultExpandAllCategories.true', '默认展开'),
              false: t('siteInfo.defaultExpandAllCategories.placeholder', '默认收起'),
            }}
            tooltip={t('siteInfo.defaultExpandAllCategories.tooltip', '默认收起，和升级前一样。开启后打开前台分类列表时全部分类都是展开的。单篇分类页、标签页和时间线不受影响。访客仍可点分类行或「全部展开 / 全部收起」临时切换。')}
          />
          <ProFormSelect
            name={'openArticleLinksInNewWindow'}
            label={t('siteInfo.openArticleLinksInNewWindow.label', '前台点击链接时的默认行为')}
            placeholder={t('siteInfo.openArticleLinksInNewWindow.placeholder', '在当前页面跳转')}
            valueEnum={{
              true: t('siteInfo.openArticleLinksInNewWindow.true', '打开新标签页'),
              false: t('siteInfo.openArticleLinksInNewWindow.placeholder', '在当前页面跳转'),
            }}
            tooltip={t('siteInfo.openArticleLinksInNewWindow.tooltip', '默认在当前页面跳转，会影响除了导航栏之外的大部分链接。注意如果打开新标签的话，就不会那么丝滑了哦（当前页面跳转的话是无感切换的）')}
          />
          <ProFormSelect
            name={'showExpirationReminder'}
            label={t('siteInfo.showExpirationReminder.label', '是否显示文章内容过时提醒')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showExpirationReminder.tooltip', '默认显示，关闭后文章页面不会显示内容过期提醒。')}
          />
          <ProFormSelect
            name={'showEditButton'}
            label={t('siteInfo.showEditButton.label', '是否在前台展示编辑按钮')}
            placeholder={t('common.show', '显示')}
            valueEnum={{
              true: t('common.show', '显示'),
              false: t('common.hide', '隐藏'),
            }}
            tooltip={t('siteInfo.showEditButton.tooltip', '默认开启，关闭后登录后台时，前台将不再显示编辑按钮。')}
          />
          <ProFormText
            name={'friendLinkIntro'}
            label={t('siteInfo.friendLinkIntro.label', '友链页介绍文案')}
            placeholder={t('siteInfo.friendLinkIntro.placeholder', '以下是本站的友情链接，排名不分先后：')}
            tooltip={t('siteInfo.friendLinkIntro.tooltip', '友链列表上方的介绍。留空则使用升级前的默认文案。')}
          />
          <ProFormTextArea
            name={'friendLinkApplyContent'}
            label={t('siteInfo.friendLinkApplyContent.label', '友链页底部文案')}
            placeholder={t('siteInfo.friendLinkApplyContent.placeholder', '留空则使用默认的申领要求与本站信息')}
            tooltip={t('siteInfo.friendLinkApplyContent.tooltip', '友链列表下方的 Markdown。留空保持升级前的申领要求。可用占位符 {{siteName}}、{{description}}、{{url}}、{{logo}} 插入本站信息。')}
            fieldProps={{
              autoSize: {
                minRows: 8,
                maxRows: 20,
              },
            }}
          />
          <ProFormText
            name={'aboutTitle'}
            label={t('siteInfo.aboutTitle.label', '关于页标题')}
            placeholder={t('siteInfo.aboutTitle.placeholder', '关于我')}
            tooltip={t('siteInfo.aboutTitle.tooltip', '前台关于页标题。留空则为「关于我」。关于页正文仍在文章管理里点「编辑关于」修改，不是这段设置。')}
          />
        </>
      )}
    </>
  );
}
