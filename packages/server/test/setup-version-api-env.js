// jest-admin-meta-e2e.json 专用 setup（setupFiles，在测试文件加载之前执行）。
//
// ⚠️ 为什么必须在 setupFiles 里设、而不能写在 spec 顶层：
//    914b134e（2026-09-20，「版本检查默认关闭」——不再于启动/DI 时回连第三方）之后，
//    `utils/getVersion.ts` 在**模块加载时**就把 `VAN_BLOG_VERSION_API` 读成常量
//    （RAW_VERSION_API_URL / VERSION_API_ENABLED / VERSION_API_URL）。spec 里的 import
//    先于任何顶层语句执行 ⇒ 在 spec 里 `process.env.x = …` 已经晚了。setupFiles 是
//    唯一能保证"模块第一次被 require 时 env 已就位"的钩子。
//
// ⚠️ 这个 e2e 测的正是「显式开启之后」的行为（缓存命中 / 后台刷新 / 慢 API 不拖慢
//    getAllMeta）。远端 API 全程被 `jest.mock('axios')` 接管，这里的 URL 用 RFC 2606
//    保留的 `.invalid` TLD —— 即使 mock 失效也发不出真包（fail-safe，不是 fail-open）。
process.env.VAN_BLOG_VERSION_API =
  process.env.VAN_BLOG_VERSION_API || 'https://version-api.e2e.invalid/vanblog/version';
