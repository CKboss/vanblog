#!/usr/bin/env node
/**
 * 生成 caddy 的 JSON 配置（容器启动时用）。
 *
 * 用法：node caddyConfig.js <模板路径> <permission|ask> [email]
 *
 * 为什么需要它：**Caddy 2.11 把 on-demand TLS 的 `ask` 换成了 permission 模块**
 *
 *   旧（≤2.9）：  "on_demand": { "ask": "http://127.0.0.1:3000/api/admin/caddy/ask" }
 *   新（≥2.11）： "on_demand": { "permission": { "module": "http", "endpoint": "同上" } }
 *
 * 用错形式，caddy 直接拒绝加载整份配置：
 *   `provisioning automation policy 0: on-demand TLS cannot be enabled without a
 *    permission module to prevent abuse`
 * 而镜像里的 caddy 是 `apk add` 装的，版本会随基础镜像漂移 —— 所以**不猜版本**：
 * entrypoint 会把两种形式都生成一次、各自 `caddy validate`，用通过的那个。
 *
 * 顺带把 `VAN_BLOG_EMAIL` 占位换成真实邮箱（在解析后的对象里换，不是文本替换：
 * 邮箱里万一有引号或反斜杠，文本替换会把整份 JSON 写坏）。
 */
const fs = require('fs');

const [, , templatePath, mode, emailArg] = process.argv;
if (!templatePath || (mode !== 'permission' && mode !== 'ask')) {
  process.stderr.write('用法: node caddyConfig.js <模板路径> <permission|ask> [email]\n');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const email = typeof emailArg === 'string' ? emailArg : '';

/** 递归把 VAN_BLOG_EMAIL 占位换成真实邮箱（空邮箱也照换：caddy 的 acme issuer 允许没有联系邮箱） */
function fillEmail(node) {
  if (Array.isArray(node)) {
    node.forEach(fillEmail);
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (node[key] === 'VAN_BLOG_EMAIL') {
        node[key] = email;
      } else {
        fillEmail(node[key]);
      }
    }
  }
}
fillEmail(config);

const tls = config.apps && config.apps.tls;
const automation = tls && tls.automation;
const onDemand = automation && automation.on_demand;
if (onDemand) {
  const endpoint = onDemand.ask || (onDemand.permission && onDemand.permission.endpoint);
  if (endpoint) {
    delete onDemand.ask;
    delete onDemand.permission;
    if (mode === 'permission') {
      onDemand.permission = { module: 'http', endpoint };
    } else {
      onDemand.ask = endpoint;
    }
  }
}

process.stdout.write(JSON.stringify(config));
