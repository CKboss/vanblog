export interface UploadConfig {
  withWaterMark?: boolean;
  waterMarkText?: string;
}

/**
 * 上传上下文：隐写水印默认写「域名|上传者|时间」，
 * 这些信息只有调用方（控制器里有登录态和站点信息）知道。
 */
export interface UploadContext {
  uploader?: string;
  baseUrl?: string;
  author?: string;
}
