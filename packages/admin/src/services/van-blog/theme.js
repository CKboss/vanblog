import { request } from 'umi';

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

/** 取某个上传主题的 CSS 原文（内置主题没有独立文件，服务端会 404） */
export async function getThemeCss(id) {
  return request(`/api/admin/theme/${encodeURIComponent(id)}/css`, {
    method: 'GET',
    responseType: 'text',
    // 服务端直接回 text/css，不要被 umi 当 JSON 解析
    parseResponse: false,
  });
}
