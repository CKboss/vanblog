/**
 * picgo 插件安装的开关（默认**关**）。
 *
 * 为什么要这个开关：本仓库钉的是 `picgo@1.5.6`，它依赖
 *  - `git-clone@0.1.0`：**命令注入**（把仓库地址直接拼进 `git clone` 的 shell 命令），
 *    上游早已弃坑，**没有修复版本**；
 *  - `decompress`（及其 tar/zip 插件）：**解压路径穿越**，同样没有修复版本。
 *
 * 而 `PicgoProvider.initDriver()` 会去安装后台「图床设置」里配置的 `picgoPlugins`
 * （`picgo.pluginHandler.install(...)` 内部就是 `npm install` + 走上面那两个包解压/克隆）。
 * 于是链条是：**拿到一个后台会话（或 CSRF/XSS 打进后台）→ 在图床设置里填一个恶意插件名
 * → 容器里以 root 执行任意代码**。图床设置本身是鉴权接口，但它的输入是"任意字符串"，
 * 而代价是 RCE，这个不对称不值得默认打开。
 *
 * 取舍（要写进文档，不能偷偷留着）：
 *  - **默认关**：`saveFile()` / `picgo.upload()` 这条正常的图床上传路径**完全不受影响**
 *    —— picgo 自带的 uploader（local / aliyun OSS / qiniu / upyun / smms / github …）
 *    都不需要插件，插件只用于第三方扩展（例如 web 上传器、自定义水印）。
 *  - **确实需要插件的部署**：显式设 `VANBLOG_ALLOW_PICGO_PLUGINS=true`，
 *    并接受"后台会话泄露 == 容器内 root"这个风险；建议同时把容器改成非 root 运行、
 *    或者把 picgo 升到 3.x（本仓库因为依赖树与 Node 版本钉住了 1.5.6，升级是另一件事）。
 */

export const PICGO_PLUGIN_ENV = 'VANBLOG_ALLOW_PICGO_PLUGINS';

/** 只有显式写成 true / 1 才算打开；其它任何值（含空串、拼错）都按"关"处理 */
export function isPicgoPluginsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PICGO_PLUGIN_ENV];
  if (raw === undefined) return false;
  const value = String(raw).trim().toLowerCase();
  return value === 'true' || value === '1';
}

/** 规范化后台填的插件列表：去空白、去空项 */
export function normalizePluginList(plugins: unknown): string[] {
  if (!Array.isArray(plugins)) return [];
  return plugins
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0);
}

/** 关掉时给出的解释（日志与返回值都用它，免得各处措辞漂移） */
export function picgoPluginsBlockedReason(plugins: string[]): string {
  return (
    `已跳过 picgo 插件安装：${plugins.join(', ')}。` +
    `picgo 1.5.6 依赖的 git-clone@0.1.0（命令注入）与 decompress（解压路径穿越）都没有修复版本，` +
    `而插件名来自后台设置 —— 一旦后台会话被拿到，装插件就等于在容器里以 root 执行任意代码。` +
    `确认接受这个风险后，设 ${PICGO_PLUGIN_ENV}=true 再重启服务即可恢复安装；` +
    `图床上传本身（local/OSS/七牛/又拍云/sm.ms 等内置 uploader）不需要插件，不受影响。`
  );
}
