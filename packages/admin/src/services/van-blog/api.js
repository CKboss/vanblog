// @ts-ignore

/* eslint-disable */
import { request } from 'umi';
import { encodeQuerystring } from './encode';
import { buildAuditSearchUrl } from './auditApi';

export async function fetchAllMeta(options) {
  return request('/api/admin/meta', {
    method: 'GET',
    ...(options || {}),
  });
}
export async function activeISR() {
  return request('/api/admin/isr', {
    method: 'POST',
  });
}
export async function getHttpsConfig() {
  return request('/api/admin/caddy/https', {
    method: 'GET',
  });
}
export async function getLoginConfig() {
  return request('/api/admin/setting/login', {
    method: 'GET',
  });
}
export async function updateLoginConfig(body) {
  return request('/api/admin/setting/login', {
    method: 'PUT',
    data: body,
  });
}
export async function getLayoutConfig() {
  return request('/api/admin/setting/layout', {
    method: 'GET',
  });
}
export async function updateLayoutConfig(body) {
  return request('/api/admin/setting/layout', {
    method: 'PUT',
    data: body,
  });
}
export async function getWalineConfig() {
  return request('/api/admin/setting/waline', {
    method: 'GET',
  });
}
export async function updateWalineConfig(body) {
  return request('/api/admin/setting/waline', {
    method: 'PUT',
    data: body,
  });
}
export async function getISRConfig() {
  return request('/api/admin/isr', {
    method: 'GET',
  });
}
export async function updateISRConfig(body) {
  return request('/api/admin/isr', {
    method: 'PUT',
    data: body,
  });
}
export async function clearCaddyLog() {
  return request('/api/admin/caddy/log', {
    method: 'DELETE',
  });
}
export async function getCaddyConfig() {
  return request('/api/admin/caddy/config', {
    method: 'GET',
  });
}
export async function getCaddyLog() {
  return request('/api/admin/caddy/log', {
    method: 'GET',
  });
}
export async function setHttpsConfig(data) {
  return request('/api/admin/caddy/https', {
    method: 'PUT',
    data: data,
  });
}

export async function fetchInit(body) {
  return request('/api/admin/init', {
    method: 'POST',
    data: body,
  });
}
export async function searchArtclesByLink(link) {
  return request('/api/admin/article/searchByLink', {
    method: 'POST',
    data: {
      link,
    },
  });
}
export async function scanImgsOfArticles() {
  return request('/api/admin/img/scan', {
    method: 'POST',
  });
}
export async function rewriteArticleBaseUrl(body) {
  return request('/api/admin/img/rewrite-base-url', {
    method: 'POST',
    data: body,
  });
}
export async function transferRemoteImages(body) {
  return request('/api/admin/img/transfer-remote', {
    method: 'POST',
    data: body,
  });
}
export async function exportAllImgs() {
  return request('/api/admin/img/export', {
    method: 'POST',
  });
}

export async function login(body, options) {
  return request('/api/admin/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    data: body,
    ...(options || {}),
  });
}
export async function logout(options) {
  return request('/api/admin/auth/logout', {
    method: 'POST',
    ...(options || {}),
  });
}
export async function restore(data, options) {
  return request('/api/admin/auth/restore', {
    method: 'POST',
    data,
    ...(options || {}),
  });
}

export async function createArticle(body) {
  return request('/api/admin/article', {
    method: 'POST',
    data: body,
  });
}

export async function deleteArticle(id) {
  return request(`/api/admin/article/${id}`, {
    method: 'DELETE',
  });
}
/**
 * 回收站：软删除文章的列表（服务端分页；行内没有 content 字段）。
 * skipErrorHandler：server 未实现该接口时（404）不要往全局 toast 里打错误风暴，
 * 由 RecycleBin 组件在抽屉内用 Alert 展示失败原因。
 */
export async function getDeletedArticles(page = 1, pageSize = 10) {
  return request(
    `/api/admin/article/deleted?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`,
    {
      method: 'GET',
      skipErrorHandler: true,
    },
  );
}
/**
 * 从回收站恢复一篇文章；成功后 data 可能是文章本体也可能是 null。
 * skipErrorHandler：失败文案由 RecycleBin 组件按状态码定制（404=已不在回收站、
 * 403=缺 article:update 权限），全局 toast 只会甩一句原始 message。
 */
export async function restoreArticle(id) {
  return request(`/api/admin/article/${encodeURIComponent(id)}/restore`, {
    method: 'PUT',
    skipErrorHandler: true,
  });
}
/** 永久删除（purge）一篇已软删除的文章，不可撤销。只对回收站里的条目有效（否则 404）。 */
export async function purgeArticle(id) {
  return request(`/api/admin/article/${encodeURIComponent(id)}/purge`, {
    method: 'DELETE',
    skipErrorHandler: true,
  });
}
/** 回收站：软删除草稿的列表。⚠️ 发布成功的草稿也会进这里（发布即归档，既有语义）。 */
export async function getDeletedDrafts(page = 1, pageSize = 10) {
  return request(
    `/api/admin/draft/deleted?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`,
    {
      method: 'GET',
      skipErrorHandler: true,
    },
  );
}
/** 从回收站恢复一个草稿（不会改动由它发布过的文章）。 */
export async function restoreDraft(id) {
  return request(`/api/admin/draft/${encodeURIComponent(id)}/restore`, {
    method: 'PUT',
    skipErrorHandler: true,
  });
}
/** 永久删除一个已软删除的草稿，不可撤销（不影响由它发布的文章）。 */
export async function purgeDraft(id) {
  return request(`/api/admin/draft/${encodeURIComponent(id)}/purge`, {
    method: 'DELETE',
    skipErrorHandler: true,
  });
}
/**
 * 版本历史：某篇文章的版本列表（只有元数据，没有 content）。
 * 响应 data 带 `enabled`（false = 功能关闭）；老 server 可能没有该字段甚至 404，
 * 由 RevisionHistory 组件区分「未开启 / 空 / 失败」，skipErrorHandler 避免 toast 风暴。
 */
export async function getArticleRevisions(articleId) {
  return request(`/api/admin/article/${encodeURIComponent(articleId)}/revisions`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}
/**
 * 单个版本的完整内容（含 content，只读展示用）。
 * ⚠️ 路径是**嵌套在文章下**的 `/api/admin/article/:id/revisions/:rid`，不是顶层 `/api/admin/revisions/:rid`
 * —— 顶层那条**在 server 上不存在**（活体探测是 `Cannot GET` 404）。早期契约写错过一次，
 * 结果「历史版本 → 查看」在生产上会 404；服务端还会校验"版本属于别的文章 → 404"，
 * 所以 articleId 不是可选的装饰，它是路由与鉴权的一部分。
 */
export async function getRevisionById(articleId, revisionId) {
  return request(
    `/api/admin/article/${encodeURIComponent(articleId)}/revisions/${encodeURIComponent(revisionId)}`, {
    method: 'GET',
    skipErrorHandler: true,
  });
}
/**
 * 把文章恢复到某个版本（**PUT**，server 已确认）；服务端会先把当前状态存成新版本
 * （响应 data 里带 snapshotRevisionId），所以恢复本身可撤销。
 * 版本属于别的文章 → 404；skipErrorHandler：失败文案由组件按状态码定制。
 */
export async function restoreArticleRevision(articleId, revisionId) {
  return request(
    `/api/admin/article/${encodeURIComponent(articleId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
    {
      method: 'PUT',
      skipErrorHandler: true,
    },
  );
}
export async function createCollaborator(body) {
  return request('/api/admin/collaborator', {
    method: 'POST',
    data: body,
  });
}
export async function createCustomPage(body) {
  return request('/api/admin/customPage', {
    method: 'POST',
    data: body,
  });
}
export async function createCustomFile(path, subPath) {
  return request(`/api/admin/customPage/file?path=${path}&subPath=${subPath}`, {
    method: 'POST',
  });
}
/**
 * 新建自定义页面里的文件夹。
 * 以前这里 POST 的是 `customPage/file`（和上面的 createCustomFile 一模一样），
 * 服务端对应的路由是 `POST /api/admin/customPage/folder`，
 * 所以点「新建文件夹」实际会建出一个空文件。
 * 目前唯一的调用方是 Code 页面里被注释掉的那段工具栏（死代码），
 * 这也是这个错地址一直没被发现的原因 —— 接口既然导出了就得是对的。
 */
export async function createCustomFolder(path, subPath) {
  return request(`/api/admin/customPage/folder?path=${path}&subPath=${subPath}`, {
    method: 'POST',
  });
}
export async function updateCustomPage(body) {
  return request('/api/admin/customPage', {
    method: 'PUT',
    data: body,
  });
}
export async function updateCustomPageFileInFolder(pathname, filePath, content) {
  return request('/api/admin/customPage/file', {
    method: 'PUT',
    data: {
      pathname,
      filePath,
      content,
    },
  });
}
export async function deleteCustomPageByPath(path) {
  return request('/api/admin/customPage?path=' + path, {
    method: 'DELETE',
  });
}
export async function getCustomPages() {
  return request('/api/admin/customPage/all', {
    method: 'GET',
  });
}
export async function getCustomPageByPath(path) {
  return request('/api/admin/customPage?path=' + path, {
    method: 'GET',
  });
}
export async function getCustomPageFolderTreeByPath(path) {
  return request(`/api/admin/customPage/folder?path=${encodeURIComponent(path)}`, {
    method: 'GET',
  });
}
export async function getCustomPageFileDataByPath(path, key) {
  return request(
    `/api/admin/customPage/file?path=${encodeURIComponent(path)}&key=${encodeURIComponent(key)}`,
    {
      method: 'GET',
    },
  );
}
export async function deleteCustomPageFile(path, key) {
  return request(
    `/api/admin/customPage/file?path=${encodeURIComponent(path)}&key=${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
    },
  );
}
export async function updateCollaborator(body) {
  return request('/api/admin/collaborator', {
    method: 'PUT',
    data: body,
  });
}
export async function deleteCollaborator(id) {
  return request(`/api/admin/collaborator/${id}`, {
    method: 'DELETE',
  });
}
export async function getAllCollaborators() {
  return request(`/api/admin/collaborator`, {
    method: 'GET',
  });
}

export async function getAllCategories(withAllData = false) {
  return request(`/api/admin/category/all?detail=${withAllData ? 'true' : 'false'}`, {
    method: 'GET',
  });
}
export async function getLog(type, page, pageSize = 10) {
  return request(buildAuditSearchUrl(type, page, pageSize), {
    method: 'GET',
  });
}
export async function updateSiteInfo(body) {
  return request(`/api/admin/meta/site`, {
    method: 'PUT',
    data: body,
  });
}
export async function updateUser(body) {
  return request(`/api/admin/auth`, {
    method: 'PUT',
    data: body,
  });
}
export async function createCategory(body) {
  return request(`/api/admin/category/`, {
    method: 'POST',
    data: body,
  });
}
export async function updateCategory(name, value) {
  return request(`/api/admin/category/${encodeQuerystring(name)}`, {
    method: 'PUT',
    data: value,
  });
}
export async function reorderCategories(names) {
  return request('/api/admin/category/all/order', {
    method: 'PUT',
    data: { names },
  });
}
export async function updateTag(name, value) {
  return request(`/api/admin/tag/${encodeQuerystring(name)}?value=${encodeQuerystring(value)}`, {
    method: 'PUT',
  });
}
export async function deleteTag(name) {
  return request(`/api/admin/tag/${encodeQuerystring(name)}`, {
    method: 'DELETE',
  });
}
export async function deleteCategory(name) {
  return request(`/api/admin/category/${encodeQuerystring(name)}`, {
    method: 'DELETE',
  });
}
export async function deleteDraft(id) {
  return request(`/api/admin/draft/${id}`, {
    method: 'DELETE',
  });
}
export async function createDraft(body) {
  return request(`/api/admin/draft`, {
    method: 'POST',
    data: body,
  });
}
export async function publishDraft(id, body) {
  return request(`/api/admin/draft/publish?id=${id}`, {
    method: 'POST',
    data: body,
  });
}
export async function createDonate(body) {
  return request(`/api/admin/meta/reward`, {
    method: 'POST',
    data: body,
  });
}
export async function updateLink(body) {
  return request(`/api/admin/meta/link`, {
    method: 'PUT',
    data: body,
  });
}
export async function getLink() {
  return request(`/api/admin/meta/link`, {
    method: 'GET',
  });
}
export async function updateMenu(body) {
  return request(`/api/admin/meta/menu`, {
    method: 'PUT',
    data: body,
  });
}
export async function getMenu() {
  return request(`/api/admin/meta/menu`, {
    method: 'GET',
  });
}
export async function deleteLink(name) {
  return request(`/api/admin/meta/link?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function createLink(body) {
  return request(`/api/admin/meta/link`, {
    method: 'POST',
    data: body,
  });
}
export async function updateDonate(body) {
  return request(`/api/admin/meta/reward`, {
    method: 'PUT',
    data: body,
  });
}
export async function deleteDonate(name) {
  return request(`/api/admin/meta/reward/${encodeQuerystring(name)}`, {
    method: 'DELETE',
  });
}
export async function getDonate() {
  return request(`/api/admin/meta/reward`, {
    method: 'GET',
  });
}
export async function updateSocial(body) {
  return request(`/api/admin/meta/social`, {
    method: 'PUT',
    data: body,
  });
}
export async function getSocial() {
  return request(`/api/admin/meta/social`, {
    method: 'GET',
  });
}
export async function getSocialTypes() {
  return request(`/api/admin/meta/social/types`, {
    method: 'GET',
  });
}
export async function getTags() {
  return request(`/api/admin/tag/all`, {
    method: 'GET',
  });
}
export async function getAllCollaboratorsList() {
  return request(`/api/admin/collaborator/list`, {
    method: 'GET',
  });
}
/**
 * 导出文章 / 草稿为 Markdown 压缩包（`<标题>.md` 原样 + `<标题>.mdz` 带图包）。
 * 返回 `{ data: Blob, response }`，response 上有 `X-Export-Report` 头可以拿打包明细。
 */
export async function exportMarkdownZip(payload) {
  return request('/api/admin/export/markdown', {
    method: 'POST',
    data: payload,
    skipErrorHandler: true,
    responseType: 'blob',
    getResponse: true,
    // 图多的文章打包 + 下载可能几十秒
    timeout: 10 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// 整站备份：数据库（含 waline 评论）+ 本地静态文件（图床/附件/自定义页面）打成一个高压缩归档
// ---------------------------------------------------------------------------
export async function getFullBackupFormats() {
  return request('/api/admin/backup/full/formats', { method: 'GET' });
}

export async function exportFullBackup(format = 'auto') {
  return request('/api/admin/backup/full/export', {
    method: 'POST',
    data: { format },
    // 大站点打包可能要几分钟，别被默认超时掐掉
    timeout: 30 * 60 * 1000,
  });
}

export async function listFullBackups() {
  return request('/api/admin/backup/full/list', { method: 'GET' });
}

export async function inspectFullBackup(name) {
  return request('/api/admin/backup/full/inspect', { method: 'POST', data: { name } });
}

export async function restoreFullBackup(name) {
  return request('/api/admin/backup/full/restore', {
    method: 'POST',
    data: { name, confirm: 'true' },
    timeout: 30 * 60 * 1000,
  });
}

export async function deleteFullBackup(name) {
  return request('/api/admin/backup/full/delete', { method: 'POST', data: { name } });
}

/** 归档不在静态目录下，下载必须带 token，所以走 blob 再触发浏览器保存。 */
export async function downloadFullBackup(name) {
  return request(`/api/admin/backup/full/download?name=${encodeURIComponent(name)}`, {
    method: 'GET',
    skipErrorHandler: true,
    responseType: 'blob',
    timeout: 30 * 60 * 1000,
  });
}

export async function importAll() {
  return request(`/api/admin/backup/import`, {
    method: 'POST',
  });
}
export async function exportAll() {
  return request(`/api/admin/backup/export`, {
    method: 'GET',
    skipErrorHandler: true,
    responseType: 'blob',
  });
}
export async function deleteSocial(name) {
  return request(`/api/admin/meta/social/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}
export async function updateArticle(id, body) {
  return request(`/api/admin/article/${id}`, {
    method: 'PUT',
    data: body,
  });
}
/**
 * 给历史上没有「自定义路径名」的文章批量补上标题拼音（/post/<pinyin>）。
 * 只填空值，不会覆盖已有别名，因此可以重复执行；dryRun=true 时只预演不写库。
 */
export async function backfillArticlePathname(dryRun = false) {
  return request(`/api/admin/article/backfill-pathname`, {
    method: 'POST',
    data: { dryRun },
  });
}
export async function updateDraft(id, body) {
  return request(`/api/admin/draft/${id}`, {
    method: 'PUT',
    data: body,
  });
}
export async function updateAbout(body) {
  return request(`/api/admin/meta/about`, {
    method: 'PUT',
    data: body,
  });
}
export async function getAbout() {
  return request(`/api/admin/meta/about`, {
    method: 'GET',
  });
}
export async function getArticleById(id) {
  return request(`/api/admin/article/${id}`, {
    method: 'GET',
  });
}
export async function getDraftById(id) {
  return request(`/api/admin/draft/${id}`, {
    method: 'GET',
  });
}
export async function getSiteInfo() {
  return request(`/api/admin/meta/site`, {
    method: 'GET',
  });
}
export async function getArticlesByOption(option) {
  const newQuery = {};
  for (const [k, v] of Object.entries(option)) {
    newQuery[k] = v;
  }
  let queryString = '';
  for (const [k, v] of Object.entries(newQuery)) {
    queryString += `${k}=${v}&`;
  }
  queryString = queryString.substring(0, queryString.length - 1);
  return request(`/api/admin/article?${queryString}&toListView=true`, {
    method: 'GET',
  });
}
export async function getImgs(page, pageSize = 10) {
  return request(`/api/admin/img?page=${page}&pageSize=${pageSize}`, {
    method: 'GET',
  });
}
export async function deleteImgBySign(sign) {
  return request(`/api/admin/img/${sign}`, {
    method: 'DELETE',
  });
}
export async function deleteAllIMG() {
  return request(`/api/admin/img/all/delete`, {
    method: 'DELETE',
  });
}
/** 附件管理：列表（支持按文件名模糊搜索） */
/**
 * 替换图片：新内容写回原来的 URL（文件名/后缀都不变），文章里的引用不用改。
 * 走 fetch 是为了带 multipart 和 token header（和 UploadBtn 一致）。
 */
export async function replaceImgBySign(sign, file, withWaterMark = true) {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const res = await fetch(
    `/api/admin/img/${sign}/replace?withWaterMark=${withWaterMark ? 'true' : 'false'}`,
    {
      method: 'POST',
      body: formData,
      headers: {
        token: window.localStorage.getItem('token') || 'null',
      },
    },
  );
  return res.json();
}

/** 批量查这批图片各被哪些文章引用（列表视图的「引用文章」列）。 */
export async function getImgReferences(links) {
  return request('/api/admin/img/references', {
    method: 'POST',
    data: { links },
  });
}

export async function backfillThumbnails(force = false) {
  return request('/api/admin/img/thumb/backfill', {
    method: 'POST',
    data: { force },
  });
}

export async function detectStegoBySign(sign) {
  return request('/api/admin/img/stego/detect', {
    method: 'POST',
    data: { sign },
  });
}

/**
 * 上传一张图直接验水印。umi-request 传 FormData 不太稳，这里用 fetch，
 * 和 UploadBtn / 附件上传保持一致（token 放在 header 里）。
 */
export async function detectStegoByFile(file) {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const res = await fetch('/api/admin/img/stego/detect', {
    method: 'POST',
    body: formData,
    headers: {
      token: window.localStorage.getItem('token') || 'null',
    },
  });
  return res.json();
}

export async function getAttachments(page = 1, pageSize = 10, name = undefined) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (name) {
    query.set('name', name);
  }
  return request(`/api/admin/file?${query.toString()}`, {
    method: 'GET',
  });
}
export async function getAllAttachments() {
  return request(`/api/admin/file/all`, {
    method: 'GET',
  });
}
export async function deleteAttachmentBySign(sign) {
  return request(`/api/admin/file/${sign}`, {
    method: 'DELETE',
  });
}
/** 打包全部附件，返回 /static/export/xxx.zip */
export async function exportAllAttachments() {
  return request(`/api/admin/file/export`, {
    method: 'POST',
  });
}
export async function getStaticSetting() {
  return request(`/api/admin/setting/static`, {
    method: 'GET',
  });
}
export async function updateStaticSetting(data) {
  return request(`/api/admin/setting/static`, {
    method: 'PUT',
    data: data,
  });
}
export async function getDraftsByOption(option) {
  const newQuery = {};
  for (const [k, v] of Object.entries(option)) {
    newQuery[k] = v;
  }
  let queryString = '';
  for (const [k, v] of Object.entries(newQuery)) {
    queryString += `${k}=${v}&`;
  }
  queryString = queryString.substring(0, queryString.length - 1);
  return request(`/api/admin/draft?${queryString}&toListView=true`, {
    method: 'GET',
  });
}
export async function getWelcomeData(tab, overviewNum = 5, viewNum = 5, articleTabNum = 5) {
  return request(
    `/api/admin/analysis?tab=${tab}&viewerDataNum=${viewNum}&overviewDataNum=${overviewNum}&articleTabDataNum=${articleTabNum}`,
    {
      method: 'GET',
    },
  );
}
export async function getPiplelines() {
  return request(`/api/admin/pipeline`, {
    method: 'GET',
  });
}
export async function getPipelineConfig() {
  return request(`/api/admin/pipeline/config`, {
    method: 'GET',
  });
}
export async function getPipelineById(id) {
  return request(`/api/admin/pipeline/${id}`, {
    method: 'GET',
  });
}
export async function updatePipelineById(id, data) {
  return request(`/api/admin/pipeline/${id}`, {
    method: 'PUT',
    data,
  });
}
export async function deletePipelineById(id) {
  return request(`/api/admin/pipeline/${id}`, {
    method: 'DELETE',
  });
}
export async function createPipeline(data) {
  return request(`/api/admin/pipeline`, {
    method: 'POST',
    data,
  });
}
export async function triggerPipelineById(id, input) {
  return request(`/api/admin/pipeline/trigger/${id}`, {
    method: 'POST',
    data: input,
  });
}
export async function createApiToken(data) {
  return request(`/api/admin/token`, {
    method: 'POST',
    data,
  });
}
export async function deleteApiToken(id) {
  return request(`/api/admin/token/${id}`, {
    method: 'DELETE',
  });
}
export async function getAllApiTokens() {
  return request(`/api/admin/token`, {
    method: 'GET',
  });
}

/**
 * 下载「导出全部图片 / 导出全部附件」的归档。
 * 归档不再放在匿名可读的 /static/export/ 下，必须带 token 走这个接口。
 */
export async function downloadExportArchive(name) {
  return request(`/api/admin/export/archive?name=${encodeURIComponent(name)}`, {
    method: 'GET',
    responseType: 'blob',
    getResponse: true,
    timeout: 10 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// 内置评论：评论系统设置 + 评论管理。
// 六个函数都刻意不带 skipErrorHandler：失败（含演示站的 statusCode:401
// 「演示站禁止修改此项！」）由全局 errorHandler 弹出服务端的具体原因，
// 业务代码里再用 reportRequestError 兜底，避免同一次失败弹两条 toast。
// ---------------------------------------------------------------------------

/** 读评论系统设置（provider: builtin | waline | off，决定评论管理页走哪个分支） */
export async function getCommentSetting() {
  return request('/api/admin/setting/comment', {
    method: 'GET',
  });
}
/** 保存评论系统设置；provider 切到/切离 waline 时服务端会顺带启停 waline 子进程 */
export async function updateCommentSetting(body) {
  return request('/api/admin/setting/comment', {
    method: 'PUT',
    data: body,
  });
}
/**
 * 评论列表（分页）。params: { page, pageSize, status, path, keyword }，
 * 空值不进 query（status 不传 = 服务端的「全部」，即不含已删除）。
 * 响应里带 counts（各状态全局计数），状态页签不用另发一次请求。
 */
export async function getComments(params) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      query.set(k, String(v));
    }
  }
  const qs = query.toString();
  return request(`/api/admin/comment${qs ? `?${qs}` : ''}`, {
    method: 'GET',
  });
}
/** 各状态评论数：{ pending, approved, spam, deleted } */
export async function getCommentCounts() {
  return request('/api/admin/comment/counts', {
    method: 'GET',
  });
}
/** 改评论：body 可带 { status, content, nick, isAuthor } */
export async function updateComment(id, body) {
  return request(`/api/admin/comment/${id}`, {
    method: 'PUT',
    data: body,
  });
}
/** 删评论（软删；删顶层评论会连带软删它下面的回复） */
export async function deleteComment(id) {
  return request(`/api/admin/comment/${id}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// 从正文首图批量回填文章封面（预览 → 写入 → 撤销）。
// 两个函数都刻意不带 skipErrorHandler：失败（含演示站回的 statusCode:401
// 「演示站禁止修改此项！」）由全局 errorHandler 弹出服务端的具体原因，
// 业务代码里再用 reportRequestError 兜底，避免同一次失败弹两条 toast。
// ---------------------------------------------------------------------------

/**
 * 用文章正文里的第一张可用图片补 cover 字段。
 *
 * body: { dryRun, onlyMissing, ids }
 * - `dryRun: true` 只统计与预览、不写库，界面打开弹窗时先发这一次；
 *   服务端默认是 false（真的写库），所以这里必须由调用方显式传值。
 * - `onlyMissing` 默认 true：只补 cover 为空的文章，已有封面不动。
 * - `ids` 不传表示全部；界面里用户勾掉某几篇后，确认写入时把选中的 id 传回来。
 *
 * 返回 data: { scanned, matched, changed, skippedNoImage, skippedHasCover, dryRun,
 *              items: [{ id, title, cover, previousCover }] }（items 最多 200 条）
 */
export async function backfillCoversFromContent(body) {
  return request('/api/admin/article/covers/from-content', {
    method: 'POST',
    data: body,
  });
}

/**
 * 撤销一次回填：items 是 `[{ id, cover }]`，其中 cover 要填**旧值**
 * （即预览/写入响应里的 previousCover，服务端原样写回）。
 * 组装载荷用 coverBackfill.js 的 toRevertPayload()，别在界面里手拼字段。
 *
 * 返回 data: { reverted, skipped }（skipped = 当前值已经等于旧值的，比如用户又手动改过）
 */
export async function revertBackfilledCovers(items) {
  return request('/api/admin/article/covers/revert', {
    method: 'POST',
    data: { items },
  });
}
