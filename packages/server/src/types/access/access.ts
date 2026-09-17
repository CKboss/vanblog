export type LimitPermission =
  | 'article:create'
  | 'article:delete'
  | 'article:update'
  | 'draft:publish'
  | 'draft:create'
  | 'draft:delete'
  | 'draft:update'
  | 'img:delete'
  | 'img:replace'
  | 'file:delete';

export type Permission = LimitPermission | 'all';

export const permissionPathMap: Record<LimitPermission, string> = {
  'article:create': 'post-/api/admin/article',
  'article:delete': 'delete-/api/admin/article/:id',
  'article:update': 'put-/api/admin/article/:id',
  'draft:create': 'post-/api/admin/draft',
  'draft:publish': 'post-/api/admin/draft/publish',
  'draft:delete': 'delete-/api/admin/draft/:id',
  'draft:update': 'put-/api/admin/draft/:id',
  'img:delete': 'delete-/api/admin/img/:sign',
  'img:replace': 'post-/api/admin/img/:sign/replace',
  'file:delete': 'delete-/api/admin/file/:sign',
};

export const pathPermissionMap: Record<string, LimitPermission> = {
  'post-/api/admin/article': 'article:create',
  'delete-/api/admin/article/:id': 'article:delete',
  'put-/api/admin/article/:id': 'article:update',
  // P3 回收站：恢复是"改文章"（article:update 档），彻底删除与既有软删同权限档
  // （任务要求：purge 用 existing delete 的同一权限 = article:delete）。
  'put-/api/admin/article/:id/restore': 'article:update',
  'delete-/api/admin/article/:id/purge': 'article:delete',
  // P4 历史版本：还原本质是一次内容更新，走 article:update 档
  'put-/api/admin/article/:id/revisions/:revisionId/restore': 'article:update',
  'post-/api/admin/draft/publish': 'draft:publish',
  'post-/api/admin/draft': 'draft:create',
  'delete-/api/admin/draft/:id': 'draft:delete',
  'put-/api/admin/draft/:id/restore': 'draft:update',
  'delete-/api/admin/draft/:id/purge': 'draft:delete',
  'put-/api/admin/draft/:id': 'draft:update',
  'delete-/api/admin/img/:sign': 'img:delete',
  'post-/api/admin/img/:sign/replace': 'img:replace',
  'delete-/api/admin/file/:sign': 'file:delete',
};

/**
 * 带权限要求的 method-path 键集合。
 * ⚠️ 从 pathPermissionMap 的 **keys** 派生（历史上是 Object.values(permissionPathMap)，
 * 两张表当时互为镜像，结果集相同）；permissionPathMap 一个权限只挂一条代表路径，
 * 同一权限有多条路径时（restore/purge/revisions-restore）必须由这张表派生才拦得住。
 */
export const permissionRoutes = Object.keys(pathPermissionMap);

export const publicRoutes = [
  'get-/api/admin/meta',
  'post-/api/admin/auth/login',
  'post-/api/admin/auth/logout',
  'get-/api/admin/article',
  'get-/api/admin/draft',
  'get-/api/admin/category/all',
  'get-/api/admin/tag/all',
  'get-/api/admin/article/:id',
  'get-/api/admin/draft/:id',
  'get-/api/admin/img/all',
  'get-/api/admin/img',
  'get-/api/admin/file/all',
  'get-/api/admin/file',
  'post-/api/admin/file/upload',
  'get-/api/admin/collaborator/list',
  'post-/api/admin/img/upload',
  // 只读：批量查图片被哪些文章引用（列表视图用）
  'post-/api/admin/img/references',
  // 只读：检测图片里的隐写水印（协作者也能用来验图）
  'post-/api/admin/img/stego/detect',
  'post-/api/admin/article/searchByLink',
  // 只读：导出文章/草稿为 Markdown（含图片打包），协作者本来就能读这些内容
  'post-/api/admin/export/markdown',
  // 只读：回收站列表（P3）。协作者本来就能读文章/草稿列表（上面两条 get-），
  // 软删列表不含 content，泄露面不大于既有列表接口。
  'get-/api/admin/article/deleted',
  'get-/api/admin/draft/deleted',
  // 只读：历史版本列表与单条（P4）。协作者有 article:update（能读能改正文），
  // 读历史版本没有额外授权；**还原**是写操作，走 pathPermissionMap 的 article:update 档。
  'get-/api/admin/article/:id/revisions',
  'get-/api/admin/article/:id/revisions/:revisionId',
];
