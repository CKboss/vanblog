/**
 * Admin copy for built-in analytics IDs (#350).
 *
 * VanBlog already injects gtag for `gaAnalysisId` (GA4 `G-` and legacy `UA-`)
 * and hm.js for `baiduAnalysisId`. The gap is discoverability: users asked
 * whether `G-XXXXXXXXX` is valid, and why Google may show no data from CN.
 */

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是模块级常量（不是组件），拿不到 hook
 * ⇒ 由消费方在渲染期把 t 传进来；🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**。
 * ⚠️ 下面那些大写常量是**identity 视图**（只为既有测试与还没接 i18n 的消费方保留）；
 *    🔴 已接 i18n 的消费方**必须**改用函数版并传 t，否则文案永远中文（localePackParity 有判据盯着）。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

const analysisAdminPath = (t = IDENTITY_T) =>
  t('analysis.adminPath', '站点管理 / 系统设置 / 站点配置 / 高级设置');

/** identity 视图（既有测试钉着这句中文措辞）；🔴 已接 i18n 的消费方要调 `analysisAdminPath(t)` */
const ANALYSIS_ADMIN_PATH = analysisAdminPath();

const gaAnalysisField = (t = IDENTITY_T) => Object.freeze({
  name: 'gaAnalysisId',
  label: t('analysis.gaLabel', 'Google Analytics 测量 ID'),
  placeholder: t('analysis.gaPlaceholder', 'G-XXXXXXXXX，留空表示不启用'),
  tooltip:
    t('analysis.gaTooltip', 'GA4 测量 ID，格式为 G-XXXXXXXXX（旧版 Universal Analytics 的 UA-XXXXXXXXX-X 也可）。只填这一串，不要整段粘贴 gtag 代码。保存后无需重启。大陆访客访问 googletagmanager.com 常会超时，谷歌后台「尚未收到数据」多半是网络/地区问题，不一定是 ID 写错；可先看 Analytics「实时」。替代方案见定制化里插入 Umami。'),
});

/** identity 视图 */
const GA_ANALYSIS_FIELD = gaAnalysisField();

const baiduAnalysisField = (t = IDENTITY_T) => Object.freeze({
  name: 'baiduAnalysisId',
  label: t('analysis.baiduLabel', '百度统计 ID'),
  placeholder: t('analysis.baiduPlaceholder', '请输入百度统计站点 ID，留空表示不启用'),
  tooltip: t('analysis.baiduTooltip', '百度统计后台站点的 hm.js 参数（脚本地址问号后的那一串）。留空不启用。'),
});

/** identity 视图 */
const BAIDU_ANALYSIS_FIELD = baiduAnalysisField();

module.exports = {
  ANALYSIS_ADMIN_PATH,
  GA_ANALYSIS_FIELD,
  BAIDU_ANALYSIS_FIELD,
  // 🔴 函数版（消费方在渲染期传 t）
  analysisAdminPath,
  gaAnalysisField,
  baiduAnalysisField,
};
