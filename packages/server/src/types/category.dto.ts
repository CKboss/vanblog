export class CreateCategoryDto {
  name: string;
}

export class UpdateCategoryDto {
  name?: string;
  /**
   * 分类访问密码（**明文入参**），存 scrypt 哈希。分类加密后该分类下所有文章都用它解锁。
   * **留空/缺键 = 不修改**（不是清空）；解除加密请显式给 `clearPassword: true`。
   * 规则的唯一真源：utils/accessPassword.ts。
   */
  password?: string;
  /** 显式解除加密；与"填了新密码"同时出现 ⇒ 400。只认 `true` / `'true'`。 */
  clearPassword?: boolean;
  private?: boolean;
  hidden?: boolean;
  order?: number;
}

export class ReorderCategoriesDto {
  names: string[];
}
export type CategoryType = 'category' | 'column';
