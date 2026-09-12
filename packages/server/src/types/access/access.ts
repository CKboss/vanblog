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
  'post-/api/admin/draft/publish': 'draft:publish',
  'post-/api/admin/draft': 'draft:create',
  'delete-/api/admin/draft/:id': 'draft:delete',
  'put-/api/admin/draft/:id': 'draft:update',
  'delete-/api/admin/img/:sign': 'img:delete',
  'post-/api/admin/img/:sign/replace': 'img:replace',
  'delete-/api/admin/file/:sign': 'file:delete',
};

export const permissionRoutes = Object.values(permissionPathMap);

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
];
