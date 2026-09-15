import { request } from 'umi';

/**
 * 前台**皮肤主题**（后台「系统设置 → 主题」）的接口封装。
 *
 * ⚠️ 别和同目录的 `theme.js` 搞混：那个是后台自己的**明暗模式**工具
 * （getInitTheme / decodeAutoTheme / beforeSwitchTheme，被 app.jsx 与 ThemeButton 用），
 * 和这里的"前台皮肤"完全是两回事。名字撞过一次车（新文件直接覆盖掉了旧的），
 * 所以这个文件叫 skinTheme。
 */

/** 主题列表：内置（default / apple）+ 后台上传的，另外带出当前生效的 id */
export async function listThemes() {
  return request('/api/admin/theme/all', { method: 'GET' });
}

/** 启用某个主题（写进 siteInfo.uiStyle，并触发前台全量渲染） */
export async function activateTheme(id) {
  return request('/api/admin/theme/active', { method: 'POST', data: { id } });
}

/** 删除一个上传的主题（内置的、正在用的服务端会拒绝） */
export async function deleteTheme(id) {
  return request(`/api/admin/theme/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 上传地址与请求头（antd Upload 用 action + headers 直传，不走 umi request） */
export const THEME_UPLOAD_ACTION = '/api/admin/theme/upload';

export function themeTokenHeader() {
  return { token: window.localStorage.getItem('token') || 'null' };
}

/**
 * 取某个上传主题的 CSS 原文（内置主题没有独立文件，服务端会 404）。
 *
 * ⚠️ 走普通的 JSON 接口，**不要**加 `responseType: 'text'` / `parseResponse: false`：
 * 后台 umi 的 request 配了 errorConfig.adaptor，它对每个响应都要看到 `{statusCode,data}`，
 * 拿到裸文本会直接抛 BizError（`parseResponse` 在 adaptor 之后才起作用，救不回来）。
 * 返回结构是 `{statusCode:200, data:{id,name,url,hash,size,css}}`。
 */
export async function getThemeCss(id) {
  return request(`/api/admin/theme/${encodeURIComponent(id)}/css`, { method: 'GET' });
}
