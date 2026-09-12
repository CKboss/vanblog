# AGENTS.md — VanBlog 本地开发环境运行手册

> 面向接手开发的人和 AI 编码代理（DeepSeek Harness / Claude Code / Cursor 等都会自动读这个文件）：
> **先读完这一页再动手。**
>
> 它和仓库自带的 [`docs/contribution.md`](docs/contribution.md) 互补：那份讲上游的贡献流程，
> 这份讲**在一台普通 Linux 机器上、不靠 docker 也不靠 sudo，怎么把整套栈跑起来**、怎么跑测试、
> 以及本分支已经做了哪些功能改动。
>
> 如果同目录存在 **`AGENTS.local.md`**，那是当前这台机器的专属附录（绝对路径、代理、已导入的数据、
> 远端凭据、遗留待办），**请先读它**；它不进版本库。

- 代码基线：`Mereithhh/vanblog`，本分支从 master `ccd708ce`（v0.54.0+）起
- 验证过的环境：Ubuntu 22.04 / 24.04，x86_64，**没有 docker 组权限、sudo 需要密码**

---

## 0. TL;DR

```bash
./dev-env.sh bootstrap    # 首次：下载 Node 20 + pnpm 8 + MongoDB 7 到 .tools/，并建好本地骨架
./dev-env.sh install      # 装依赖（--frozen-lockfile）
./dev-env.sh start        # MongoDB + server + admin + website 一起起
./dev-env.sh status       # 看状态
./dev-env.sh stop         # 全停（含 mongod、waline）
```

| 服务 | 地址 | 说明 |
|---|---|---|
| admin 后台 | http://localhost:3002 | 首次访问会走初始化向导 |
| website 前台 | http://localhost:3001 | Next.js dev；`/api/*` 与 `/static/*` 都可用 |
| server API | http://localhost:3000 | NestJS，Swagger 在 `/swagger` |
| waline 评论 | http://localhost:8360 | 由 server 自动拉起的子进程 |
| MongoDB | 127.0.0.1:27017 | 免安装版 mongod，数据在 `vanblog_dev/mongo-data` |

**铁律**：不要用系统默认的 Node（≥23）跑本项目——`util.isObject` 在 Node 23 被移除，`@nestjs/cli`
会直接崩。一律用 `.tools/node20`；`dev-env.sh` 已经处理好了，手工敲命令时记得
`export PATH=$PWD/.tools/node20/bin:$PATH`。

---

## 1. 环境总览

### 1.1 为什么是「自包含」的

| 常规做法 | 在没有特权的机器上为什么不行 |
|---|---|
| `docker run mongo` | 用户不在 `docker` 组，`/var/run/docker.sock` 权限拒绝；`sudo` 需要密码 |
| 系统 node（24/23） | Node ≥ 23 移除了 `util.isObject`，`@nestjs/cli` 崩溃；项目 `engines` 要求 `^18 \|\| >=20` |
| 全局 pnpm（9/10/12） | 会写 `~/.local/share/pnpm`（沙箱/权限受限），且本仓库 lockfile 是 v6.0（pnpm 8 格式），大版本不一致会改写 lockfile |
| 写 `~/.npm`、`/var/vanblog-dev` | 官方文档里的 `/var/vanblog-dev/*` 需要 root；沙箱通常只允许写工作区 |

结论：**工具链、包管理器、数据库、数据目录、缓存全部放进工作区**，`HOME` 也隔离到 `.tools/home`。
这样整套环境可以随仓库目录一起搬走，也不会污染系统。

### 1.2 目录约定（除 `dev-env.sh` 外都是本地文件，不入库）

```
.tools/                     # 工具链
  node20/                   # Node v20.19.5（唯一用于跑本项目的 node）
  node_modules/pnpm/        # pnpm 8.11.0（与 package.json 的 packageManager 一致）
  mongodb/bin/mongod        # 7.0.14，日常使用
  mongodb50/ mongodb60/     # 5.0.34 / 6.0.29，只在导入老备份做 FCV 升级时用
  pnpm-store/               # pnpm 内容寻址 store（几个 G，装包全靠它，勿删）
  npm-cache/ home/ pnpm-home/   # 隔离的缓存与 HOME
vanblog_dev/                # 运行时数据
  mongo-data/               # MongoDB 数据目录
  static/{img,customPage,export,rss,sitemap,tmp}   # 图床、附件、自定义页面等静态文件
  logs/{server,admin,website,mongod,install}.log   # 各服务日志
  pids/                     # dev-env.sh 写的 pidfile
  codeRunner/ pluginRunner/
dev-env.sh                  # 一键脚本（**已入库**）
packages/server/config.yaml # server 配置（仓库 .gitignore 已忽略）
packages/server/tsconfig.dev.json   # 本地 tsconfig 覆盖（见 §3.6）
packages/website/public/static -> ../../../vanblog_dev/static   # 让前台 dev 能出图
AGENTS.local.md             # 本机专属附录（若存在，不入库）
```

### 1.3 版本矩阵

| 组件 | 版本 | 备注 |
|---|---|---|
| Node | 20.19.5 | `.tools/node20/bin/node` |
| pnpm | 8.11.0 | `.tools/node_modules/pnpm/bin/pnpm.cjs` |
| mongod | 7.0.14 | 数据 FCV 建议停在 6.0（见 §4.2） |
| registry | 默认 `registry.npmmirror.com` | 可用 `VANBLOG_REGISTRY` 覆盖成 `https://registry.npmjs.org` |
| 原生依赖二进制 | npmmirror 镜像 | `VANBLOG_NODE_DISTURL` / `VANBLOG_SHARP_MIRROR` / `VANBLOG_SHARP_LIBVIPS_MIRROR` 可覆盖 |

---

## 2. 日常操作

```bash
./dev-env.sh bootstrap    # 首次准备工具链与本地骨架（可重复执行，已装好的会跳过）
./dev-env.sh install      # 装/更新依赖（--frozen-lockfile，不改 lockfile）
./dev-env.sh start        # 幂等启动：已在跑的会跳过
./dev-env.sh stop         # 停 server/admin/website/waline/mongod
./dev-env.sh restart
./dev-env.sh status       # 五个服务的端口与 pid
./dev-env.sh logs server  # server|website|admin|mongod（tail -f）
./dev-env.sh db           # 数据库巡检（需要 vanblog_dev/db-inspect.cjs；该脚本不入库，缺失时会提示）
```

只重启单个服务（不惊动 admin/website 的编译缓存）：

```bash
kill -- -"$(cat vanblog_dev/pids/server.pid)"; rm -f vanblog_dev/pids/server.pid
./dev-env.sh start        # 只会把 server 拉起来
```

编译耗时参考（冷启动）：admin(umi+MFSU) ≈ 1.5–2 min，website(next) ≈ 5–30 s，server(nest/tsc) ≈ 20–40 s；
热缓存后整套 stop→start ≈ 30 s。

### 2.1 跑测试（改代码后必做）

三套测试互相独立，都要用 `.tools/node20`：

```bash
export R=$PWD HOME=$PWD/.tools/home PATH="$PWD/.tools/node20/bin:$PATH"

# server: jest + ts-jest（全量约 1 min）
(cd packages/server && ./node_modules/.bin/jest)
(cd packages/server && ./node_modules/.bin/jest src/utils/slug.spec.ts)   # 单文件

# website: vitest（约 15 s）。注意 `pnpm test` 是 watch 模式，脚本/CI 里要用 run
(cd packages/website && ./node_modules/.bin/vitest run)

# admin: node:test（约 1 s，会读 docs/ 断言文案）
(cd packages/admin && node --test tests/unit/*.test.js)
```

- **已知失败**：`packages/server/src/utils/watermark.spec.ts` 的
  `composites text with a dot the same way (#322)` 需要 `Jimp.loadFont(Jimp.FONT_SANS_128_WHITE)`
  从 CDN 拉字体，**离线环境会超时失败**。与业务改动无关，别去「修」它（要跑通就挂代理）。
- admin 的 `tests/e2e/*.spec.js` 需要 playwright 浏览器；安装时设了
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，所以本机只跑 `tests/unit`。
- admin 单测会断言 `docs/` 里的文案（例如必须出现「自定义路径名」「数字 id」「隐写水印」等），
  **改文档时别删这些词**，否则测试会红。
- 造真实图片的测试（sharp 编解码 + 逐像素循环）很慢：新写这类用例时记得
  `jest.setTimeout(60000)` 以上，并用 `beforeAll` 共享图片 fixture。

### 2.2 推到你的 fork

```bash
git remote add mine git@github.com:<你的用户名>/vanblog.git
git push -u mine <你的分支>
```

- `origin` 指向上游 `Mereithhh/vanblog`：**只 fetch，不要 push，不要打 tag**
  （`pnpm release` / `v*` / `doc*` / `test*` tag 都是作者专用，见 `docs/contribution.md`）。
- 提交信息用 Conventional Commits，照着 `git log --oneline -20` 的样式写
  （`feat(scope): ...` / `fix(scope): ...`，正文解释「为什么」）。
- 这台机器如果配了专用推送密钥 / remote，见 `AGENTS.local.md`。

---

## 3. 从零重建（`.tools/` 或 `node_modules/` 不存在时）

一条命令就够：

```bash
./dev-env.sh bootstrap                        # Node 20 + pnpm 8 + MongoDB 7 + 本地骨架
./dev-env.sh bootstrap --with-legacy-mongo    # 额外装 5.0/6.0，用于导入 FCV 4.4 的老备份（§4.2）
```

`bootstrap` 做的事（**幂等**，可以反复跑，已经装好的会跳过）：

1. 下载并校验 **Node 20.19.5**（官方 `SHASUMS256.txt`）→ `.tools/node20`；
2. 用这个 node 装 **pnpm 8.11.0** → `.tools/node_modules/pnpm`（与 `package.json` 的 `packageManager` 一致）；
3. 下载并校验 **MongoDB 7.0.14**（`.tgz.sha256` sidecar）→ `.tools/mongodb`，并用 `ldd` 检查动态库；
4. 建 `vanblog_dev/{logs,pids,mongo-data,static,codeRunner,pluginRunner}`、
   `packages/website/public/static` 软链、`packages/server/config.yaml`、
   `packages/server/tsconfig.dev.json`（都只在不存在时生成），并把这些本地文件补进 `.git/info/exclude`。

可用的环境变量覆盖：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VANBLOG_NODE_VERSION` | `20.19.5` | Node 版本 |
| `VANBLOG_PNPM_VERSION` | `8.11.0` | 要和 `package.json` 的 `packageManager` 一致 |
| `VANBLOG_MONGO_VERSION` | `7.0.14` | 日常使用的 mongod |
| `VANBLOG_MONGO50_VERSION` / `VANBLOG_MONGO60_VERSION` | `5.0.34` / `6.0.29` | 仅 `--with-legacy-mongo` |
| `VANBLOG_MONGO_PLATFORM` | `ubuntu2204` | 老发行版缺 `libssl3` 时可试 `ubuntu2004` |
| `VANBLOG_NODE_DISTURL` | `https://npmmirror.com/mirrors/node` | Node tarball 源；海外可换 `https://nodejs.org/dist` |
| `VANBLOG_MONGO_MIRROR` | `https://fastdl.mongodb.org/linux` | MongoDB tarball 源 |
| `VANBLOG_PROXY` | 空 | 下载命令前缀，例如 `proxychains4 -q` |
| `VANBLOG_KEEP_DOWNLOADS` | `0` | 设 `1` 保留下载的 tarball（默认装完就删） |
| `VANBLOG_REGISTRY` | `https://registry.npmmirror.com` | npm registry（pnpm 安装与 `install` 都用它） |

> 下载失败可以直接重跑：已经下完并校验通过的组件不会重来。
> 需要手工安装（离线机器、或想把 tarball 放到别处）时，照下面两节做。

### 3.1 工具链（手工）

```bash
mkdir -p .tools && cd .tools
# Node 20（nodejs.org 直连一般可用；也可用 https://npmmirror.com/mirrors/node/v20.19.5/）
curl -LO https://nodejs.org/dist/v20.19.5/node-v20.19.5-linux-x64.tar.xz
tar -xf node-v20.19.5-linux-x64.tar.xz && mv node-v20.19.5-linux-x64 node20

# MongoDB（fastdl.mongodb.org 在部分网络下很慢/易断，必要时走你自己的代理）
curl -sSLO https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz
tar -xzf mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz && mv mongodb-linux-x86_64-ubuntu2204-7.0.14 mongodb
```

> `mongodb-linux-x86_64-ubuntu2004-*` 的构建依赖 `libssl.so.1.1`/`libcrypto.so.1.1`；
> 换新机器时先 `ldd bin/mongod | grep "not found"` 确认。
> 只有需要导入 FCV 4.4 的老备份时，才额外准备 5.0 / 6.0（见 §4.2）。

### 3.2 本地 pnpm 8.11.0（手工）

```bash
cd .tools && printf '{"name":"vanblog-dev-tools","private":true,"dependencies":{"pnpm":"8.11.0"}}\n' > package.json
HOME=$PWD/home PATH=$PWD/node20/bin:$PATH \
  npm install --prefix "$PWD" --cache "$PWD/npm-cache" --registry https://registry.npmmirror.com
./node20/bin/node ./node_modules/pnpm/bin/pnpm.cjs -v   # 期望 8.11.0
```

### 3.3 关键环境变量（`dev-env.sh` 已内置，手工执行时也要带）

```bash
export PATH="$ROOT/.tools/node20/bin:$PATH"
export HOME="$ROOT/.tools/home"                    # 隔离 HOME：picgo 等会写 ~/.picgo
export PNPM_HOME="$ROOT/.tools/pnpm-home"
export npm_config_cache="$ROOT/.tools/npm-cache"
export npm_config_store_dir="$ROOT/.tools/pnpm-store"   # store 必须与 node_modules 同一文件系统，否则硬链接失败
export npm_config_registry=https://registry.npmmirror.com          # 或 VANBLOG_REGISTRY=... 覆盖
export npm_config_disturl=https://npmmirror.com/mirrors/node                  # node-gyp 头文件
export npm_config_sharp_binary_host=https://npmmirror.com/mirrors/sharp       # sharp 预编译产物
export npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1           # dev 不需要 e2e 浏览器
```

> 在中国大陆以外的网络下，把上面三个镜像变量换成官方源（或直接 `unset`）通常更快：
> `VANBLOG_REGISTRY=https://registry.npmjs.org ./dev-env.sh install`。

### 3.4 安装依赖

```bash
./dev-env.sh install      # 等价于 pnpm install --frozen-lockfile（日志 vanblog_dev/logs/install.log）
```

已知噪音（**都是正常的，不要试图「修」**）：

- `sqlite3@5.1.6`：预编译包在 GitHub，直连超时会回退源码编译，单线程 **约 4–5 分钟**，这是 install 最慢的一步；
- `tree-sitter` / `tree-sitter-json` / `tree-sitter-yaml`：`@swagger-api/apidom-*` 的 **optional** 依赖，编译成功与否都不影响运行；
- `sharp@0.32.6`：配好上面两个镜像变量后会打印 `Integrity check passed` + `Done`；
- `packages/admin postinstall$ umi g tmp`、`caniuse-lite is outdated` 提示：忽略。

热 store 情况下整轮 install ≈ 6 min（其中 5 min 是 sqlite3 编译）；store 为空时还要加下载时间。

### 3.5 `packages/server/config.yaml`（仓库已 gitignore；`bootstrap` 会自动生成）

```yaml
database:
  url: mongodb://localhost:27017/vanBlog?authSource=admin
static:
  path: <绝对路径>/vanblog_dev/static
demo: 'false'
waline:
  db: waline
log: <绝对路径>/vanblog_dev/logs
codeRunner:
  path: <绝对路径>/vanblog_dev/codeRunner
pluginRunner:
  path: <绝对路径>/vanblog_dev/pluginRunner
```

配置优先级：环境变量 `VAN_BLOG_*` > `config.yaml` > 默认值（见 `packages/server/src/utils/loadConfig.ts`），
也可以用 `VAN_BLOG_CONFIG_FILE` 指定别的配置文件。
**路径必须写绝对路径**，因为 server 进程的 cwd 是 `packages/server`。

开发时建议加 `VANBLOG_DISABLE_WEBSITE=true`（`dev-env.sh` 已加）：它让 `ISRProvider.activeAll()`
变成空操作，避免每次改文章都去触发前台全量渲染。

### 3.6 `packages/server/tsconfig.dev.json`（某些机器上必须；`bootstrap` 会自动生成）

TypeScript 会自动向上扫描 `node_modules/@types`。如果**家目录**里存在
`$HOME/node_modules/@types/bun`（bun-types 1.3.x）之类的新语法包，server 用的 **TS 4.9.5** 解析不了，
会报上百个语法错误，`nest start --watch` 卡在 `Found 115 errors`，3000 端口永远不监听。

解决办法是不动仓库文件，另建一个本地 tsconfig 限制 `typeRoots`：

```jsonc
// packages/server/tsconfig.dev.json
{
  "extends": "./tsconfig.build.json",
  "compilerOptions": {
    "typeRoots": ["./node_modules/@types", "../../node_modules/@types"],
    "tsBuildInfoFile": "./dist/.tsbuildinfo-dev"
  }
}
```

启动命令相应变成 `nest start --watch -p tsconfig.dev.json`（`dev-env.sh` 里已经这么写了）。
admin(umi) 与 website(next) 用的是 TS 5.x，不受影响。
**如果你的机器没有这个问题**，这个文件也无害，留着即可。

### 3.7 本地忽略清单（写进 `.git/info/exclude`，不改仓库 `.gitignore`）

```
.tools/
vanblog_dev/
.xdg-data/
.pnpm-home/
packages/server/tsconfig.dev.json
packages/website/public/static
AGENTS.local.md
```

`bootstrap` 会把这几条自动补进 `.git/info/exclude`（已存在的不会重复写）。
验收标准：`git status --short` 里**不应该出现环境类文件**；出现别的改动说明是功能代码（见 §7）。
注意 `dev-env.sh`、`AGENTS.md`、`CLAUDE.md` 是**入库的**。

### 3.8 启动与验收

```bash
./dev-env.sh start
curl -s http://127.0.0.1:3000/api/public/meta | head -c 120     # 期望 {"statusCode":200,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/  # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3002/  # 期望 200
```

> 全新空库时 `/api/...` 会返回 `{"statusCode":233,"message":"未初始化!"}`，这是「数据库连通但还没初始化」
> 的正常信号，去 3002 走向导即可。
> 前台 dev(3001) 默认拿不到 `/static/*` 的文件（生产由 caddy 转发），需要建软链：
> `ln -sfn ../../../vanblog_dev/static packages/website/public/static`

---

## 4. 导入官方全量备份（`vanblog-backup-*.tar.gz`）

### 4.1 先认清备份类型

一键脚本 `vanblog.sh backup` 打的是**整个 `/var/vanblog` 目录**，不是后台「导入导出」的 JSON：

```
./data/data/mongo/      # MongoDB 原始 WiredTiger 数据文件（含 journal/、diagnostic.data/）
./data/data/static/     # 图床图片 img/、自定义页面 customPage/、rss/ sitemap/ export/ tmp/
./data/caddy/           # caddy 配置与证书（本地开发用不上）
./data/log/             # 旧日志 + restore.key（本地开发用不上）
```

所以导入 = **替换数据目录 + 数据库版本升级 + 合并 static 文件**，不能走后台的导入按钮。

### 4.2 版本升级链（核心结论）

老备份的数据可能是 **mongo 4.4（FCV=4.4）**，而 MongoDB 只能逐级升：

| 用哪个 mongod 打开 FCV 4.4 的数据 | 结果 |
|---|---|
| 7.0.x | ❌ `Wrong mongod version` / `UPGRADE PROBLEM: Found an invalid featureCompatibilityVersion document ... version: "4.4" ... expected '6.0' or '6.3' or '7.0'` |
| 6.0.x | ❌ 要求 FCV ≥ 5.0 |
| 5.0.x | ✅ 能打开 |

正确顺序：**5.0 打开 → setFCV 5.0 → 6.0 打开 → setFCV 6.0 → 7.0 运行**。

判断源数据版本：启动时报错里就写着 FCV；或启动 5.0 后执行
`printjson(db.adminCommand({getParameter:1,featureCompatibilityVersion:1}))`
（5.0 自带 legacy `mongo` shell，6.0 起没有，需要用 driver 写个小脚本）。

### 4.3 可复制的完整命令

```bash
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
BK=<你的备份.tar.gz>

# 0) 解压到临时目录（注意 tar 内是 ./data/data/mongo 两层 data）
mkdir -p vanblog_dev/restore && tar -xzf "$BK" -C vanblog_dev/restore
cp -a vanblog_dev/restore/data/data/mongo vanblog_dev/restore/work-dbpath
rm -f vanblog_dev/restore/work-dbpath/mongod.lock     # 备份是运行中打的，锁文件要删

# 1) 5.0 打开 + FCV 升到 5.0（端口用 27019，别碰在跑的 27017）
#    ⚠️ --logpath/--pidfilepath/--dbpath 一律用绝对路径：mongod --fork 后 cwd 会变，
#       相对路径会报 "Cannot write pid file to ...: No such file or directory"
.tools/mongodb50/bin/mongod --dbpath "$ROOT/vanblog_dev/restore/work-dbpath" --port 27019 \
  --bind_ip 127.0.0.1 --logpath "$ROOT/vanblog_dev/restore/m50.log" \
  --pidfilepath "$ROOT/vanblog_dev/restore/m50.pid" --fork
.tools/mongodb50/bin/mongo --quiet --port 27019 --eval \
  'printjson(db.adminCommand({setFeatureCompatibilityVersion:"5.0"}))'
.tools/mongodb50/bin/mongod --dbpath "$ROOT/vanblog_dev/restore/work-dbpath" --shutdown

# 2) 6.0 打开 + FCV 升到 6.0（6.0 没有 legacy shell，用 mongosh 或 driver 脚本设置）
.tools/mongodb60/bin/mongod --dbpath "$ROOT/vanblog_dev/restore/work-dbpath" --port 27019 \
  --bind_ip 127.0.0.1 --logpath "$ROOT/vanblog_dev/restore/m60.log" \
  --pidfilepath "$ROOT/vanblog_dev/restore/m60.pid" --fork
#   node -e "...用 mongodb driver 连 27019 执行 setFeatureCompatibilityVersion:'6.0'..."
.tools/mongodb60/bin/mongod --dbpath "$ROOT/vanblog_dev/restore/work-dbpath" --shutdown

# 3) 停掉开发栈的 mongod 与 server，换上导入的数据目录
kill -- -"$(cat vanblog_dev/pids/server.pid)"; rm -f vanblog_dev/pids/server.pid
.tools/mongodb/bin/mongod --dbpath "$ROOT/vanblog_dev/mongo-data" --shutdown
mv vanblog_dev/mongo-data vanblog_dev/mongo-data.old
mv vanblog_dev/restore/work-dbpath vanblog_dev/mongo-data

# 4) 合并图床/自定义页面（-n 不覆盖已有文件）
mkdir -p vanblog_dev/static
cp -a --update=none vanblog_dev/restore/data/data/static/. vanblog_dev/static/
ln -sfn ../../../vanblog_dev/static packages/website/public/static   # 让前台 dev(3001) 能出图

# 5) 起服务并验收
./dev-env.sh start
rm -rf vanblog_dev/restore        # 确认无误后再删（原始 tar 包还在）
```

> FCV **停在 6.0** 就够了：7.0 的 `setFeatureCompatibilityVersion: "7.0"` 需要 `confirm: true`
> 且**不可回退**，开发环境没必要冒这个险。

### 4.4 验收清单

```bash
curl -s http://127.0.0.1:3000/api/public/meta | head -c 200
curl -s "http://127.0.0.1:3000/api/public/article?page=1&size=2" | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/post/1    # 200
curl -s "http://127.0.0.1:3001/api/comment?path=%2Fpost%2F1&page=1&pageSize=3" | head -c 200
```

导入生产库后有两件常见的事，**不是数据丢失**：

- `metas.totalWordCount` 会被新版 server 启动时重算，数字可能变化；
- 站点信息里可能仍是生产域名 / 统计代码（GA、百度、51la），本地刷页面会上报到正式站，
  建议在后台关掉，或批量改写成 `http://localhost:3001`。

---

## 5. 故障排查速查表

| 症状 | 原因 | 处理 |
|---|---|---|
| `nest start --watch` 打印 `Found 115 errors`，3000 不监听 | 家目录 `@types/*`（如 bun-types）被 TS 4.9 自动纳入 | 用 `-p tsconfig.dev.json`（§3.6） |
| `@nestjs/cli` 崩、报 `util.isObject is not a function` | 用了系统 Node ≥ 23 | 换 `.tools/node20` |
| pnpm 启动即 `Permission denied ... pnpm/global/v11` | 全局 pnpm 版本太新、要写 `~/.local/share/pnpm` | 用 `.tools/node_modules/pnpm/bin/pnpm.cjs` + 隔离 HOME |
| `sharp: Installation error: Request timed out` | 直连 GitHub 下载 libvips | 设 `npm_config_sharp_libvips_binary_host` / `npm_config_sharp_binary_host`（§3.3） |
| node-gyp `common.gypi not found` | 头文件下载失败 | 设 `npm_config_disturl`，并清掉 `.tools/home/.cache/node-gyp` |
| mongod `Wrong mongod version` / `UPGRADE PROBLEM ... featureCompatibilityVersion` | 数据 FCV 低于当前 mongod 要求 | 走 §4.2 升级链 |
| mongod `Cannot write pid file to xxx: No such file or directory` | `--fork` 后 cwd 改变，用了相对路径 | `--dbpath/--logpath/--pidfilepath` 全用绝对路径 |
| waline 日志 `bind EADDRINUSE null:8360` | 上次 stop 没杀掉 waline（它以相对路径启动，命令行不含工作区路径） | `dev-env.sh stop` 已处理；手工：`pkill -f '[v]anilla.js'` 后重启 server |
| 前台 3001 图片 404（`/static/img/...`） | 生产由 caddy 转发 `/static`，dev 没这层 | `packages/website/public/static` 软链到 `vanblog_dev/static` |
| `ERROR [InitProvider] 写入恢复密钥到文件失败` | 代码硬编码写 `/var/log/restore.key`，非 root 写不了 | 无害；密钥会打在 server 日志里（每次重启重新生成） |
| `ERROR [CaddyProvider] 关闭 https 自动重定向失败` | 本地没有 caddy | 无害，忽略 |
| 前台页面空白 / 报未初始化 | 库是空的 | 去 3002 走初始化向导，或导入备份（§4） |
| `./dev-env.sh: Permission denied` | 脚本丢了可执行位（被 `chmod 644` 过） | `chmod +x dev-env.sh`，或改用 `bash dev-env.sh ...` |
| `./dev-env.sh` 报找不到 node / pnpm / mongod | `.tools/` 还没准备 | `./dev-env.sh bootstrap`（可重复执行，见 §3） |
| bootstrap 下载 Node/MongoDB 超时或校验失败 | 直连 `nodejs.org` / `fastdl.mongodb.org` 太慢 | 换源或走代理：`VANBLOG_PROXY="proxychains4 -q" ./dev-env.sh bootstrap`；Node 也可 `VANBLOG_NODE_DISTURL=https://nodejs.org/dist` |
| bootstrap 装完 mongod 报缺动态库 | `ubuntu2204` 构建需要 `libssl3`/`libcrypto3` | 换 `VANBLOG_MONGO_PLATFORM=ubuntu2004` 重装（需要 `libssl1.1`） |
| 3001/3002 页面报 500 / `[HPM] ECONNREFUSED ... :3000` | server 没起（或正在重启） | `./dev-env.sh status`，看 `vanblog_dev/logs/server-dev.log` |
| 后台菜单显示成 `paperclip附件管理` 这种纯文本 | umi 把路由 `icon` 按 `toHump(首字母大写)+'Outlined'` 解析，拼不出真实图标就退回字符串 | 用能拼成真实 antd 图标的写法（`paper-clip` → `PaperClipOutlined`），并核对 `src/.umi/plugin-layout/icons.ts` |
| 标题的复制按钮压在「编辑」上 | 复制按钮用了绝对定位，而「编辑」在文档流里 | 标题行是三列 grid、操作区同格（见 §7.2），别改回绝对定位 |
| 「检测隐写水印」总说没有水印 | 图被缩放/裁剪过；或上传时开关是关的；或换过 `stegoKey` | 属预期行为，见 `docs/features/image-storage.md` 的鲁棒性对照表 |

查日志的通用姿势（带 ANSI 颜色，需要去掉）：

```bash
sed 's/\x1b\[[0-9;]*m//g' vanblog_dev/logs/server-dev.log | tail -50
```

---

## 6. 铁律 / 不要做

1. **不要用系统 Node（≥23）跑 server/admin/website**，一律 `.tools/node20`。
2. **不要为了本地环境去改仓库跟踪的文件**（`config/config.js`、`config/proxy.js`、`next.config.js`、
   `tsconfig*.json` 等）。环境需要覆盖时就新建本地文件 + 写进 `.git/info/exclude`；
   只有**真正的功能改动**才应该出现在 `git diff` 里（当前有哪些见 §7）。
3. **不要去掉 `pnpm install --frozen-lockfile`**，也不要把 pnpm 升到 9/10/12（lockfile 是 v6.0）。
4. **不要 `pkill -f "<含工作区路径的模式>"`**：命令行里带同样字符串的当前 shell 会被自己杀掉（真踩过）。
   要杀就先 `pgrep` 出 pid，排除 `$$` 与 `$PPID` 再 `kill`。
5. **mongod 的 `--dbpath/--logpath/--pidfilepath` 必须绝对路径**（`--fork` 之后 cwd 会变）。
6. **不要把 pnpm store 放到别的文件系统**（跨设备无法硬链接，装包会退化成全量复制）。
7. **不要执行 `pnpm release` / `pnpm release-doc`，不要 push `v*`、`doc*`、`test*` tag**（作者专用）。
8. **不要往 `origin`（上游 `Mereithhh/vanblog`）push**，只推自己的 fork。
9. **不要把 FCV 升到 7.0**，除非明确需要且接受不可回退。
10. **不要把 `vanblog_dev/`、`.tools/` 里的东西提交进 git**：前者可能含真实博客数据
    （MongoDB 数据文件、图床图片、日志），后者是几个 G 的二进制。

---

## 7. 本分支的功能改动（改这块代码前先读）

本分支在上游 master `ccd708ce` 之上实现了下面这些需求（`git log --oneline ccd708ce..HEAD` 可查）：
拼音链接、标题可复制、自动摘要、附件管理、两个 UI 修复、图片管线（缩放/缩略图/隐写水印/列表视图）、整站备份与恢复、单篇文章导出（md + 带图 mdz）、前台 Apple 风格皮肤。
**别把它们当成脏改动回退掉。**

### 7.1 文章链接默认带标题拼音（`/post/<pinyin-slug>`）

- 复用项目原有的 `pathname` 机制（`utils/getArticlePath.ts` = `pathname || id`，路由仍是 `/post/[id]`），
  **没有动路由**；`/post/<数字id>` 永远可用（`getByIdOrPathname` 先查 pathname，再退回数字 id）。
- 新增 `packages/server/src/utils/slug.ts`：`titleToSlug()`（pinyin-pro，`toneType:'none'` +
  `nonZh:'consecutive'` + `v:true` 让 ü→v）、`slugify()`、`slugCandidates()`；上限 60 字符，按 `-` 边界截断；
  纯数字结果直接判废。
- 新增 `packages/server/src/utils/articlePathname.ts`：手工别名校验（不含 `/`、非纯数字、≤100 字符、
  无控制字符）。**纯数字必须拒绝**，否则会顶掉同 id 文章的数字地址。
- `ArticleProvider.create()`：别名为空 → 按标题生成，冲突依次 `-2`、`-3`…最后兜底 `-<id>`；
  手工填了别名 → 校验 + 唯一性，冲突抛 `BadRequestException`。软删除文章仍占用别名（随时会被恢复）。
- `ArticleProvider.updateById()`：**只有显式传 `pathname` 才动别名**，改标题不重算
  （否则已分享/已收录的链接全废）。
- `ArticleProvider.backfillPathname()` + `POST /api/admin/article/backfill-pathname`（body `{dryRun}`）：
  批量补历史文章，只填空值、可重复执行；非 dryRun 且有改动时触发 ISR 全量渲染。
  接口在 `AdminGuard` 后面，未登录返回 401。
- 后台入口：文章管理右上角「生成拼音路径」按钮（`packages/admin/src/pages/Article/index.jsx` +
  `services/van-blog/api.js` 的 `backfillArticlePathname()`）。别名字段本来就有
  （`components/PathnameField`：新建/导入/发布草稿/修改信息），本次只改了文案
  （`services/van-blog/importPathname.js` 的 `PATHNAME_FIELD`）。
- 新依赖：`packages/server` 增加 `pinyin-pro@^3.29.4`（`pnpm-lock.yaml` 已同步）。
- 文档同步：`docs/features/article.md`、`docs/advanced/seo.md`、`docs/advanced/migrate.md`、
  `docs/faq/usage.md`。**admin 单测会断言这些文件里的关键词**（「自定义路径名」「数字 id」等），
  改文案时别删。
- 顺手修了一个既有 bug：`packages/website/utils/washArticles.ts` 的 `washArticlesByKey()` 会把文章裁剪成
  `{title,id,createdAt,updatedAt}`，**丢掉 `pathname`**，导致分类页/标签页
  （`getTagPagesProps` / `getCategoryPagesProps`）的链接退回 `/post/<数字id>`；已补上 `pathname`。
- 单测：`src/utils/slug.spec.ts`、`src/utils/articlePathname.spec.ts`、
  `src/provider/article/article.provider.pathname.spec.ts`、
  `packages/website/__tests__/articlePathnameLinks.spec.ts`。

### 7.2 标题可选中 + 一键复制

- 文章标题（列表页/详情页）与关于页标题：去掉 `select-none`、加 `select-text`；hover（小屏常驻）出现两个
  图标按钮：复制标题、复制文章链接。
- 导航栏站点名：移动端与桌面端都改成 `select-text`；**只有桌面端**加复制按钮——移动端容器是
  `pointer-events:none` + 绝对居中（上游 #262），塞元素会破坏居中。
- 契约集中在 `packages/website/components/PostCard/titleCopyA11y.ts`（label / class / toast / 键盘可达性 /
  `articleUrl()`），图标在 `components/CopyIcons/index.tsx`；复制沿用既有依赖
  `react-copy-to-clipboard` + `react-hot-toast`（与 `CopyRight`、`RssButton` 一致）。
- 标题行是 **三列 grid**（`grid-cols-[1fr_minmax(0,auto)_1fr]`）：左边空列和右边操作列等宽，标题保持视觉居中；
  复制按钮和「编辑」同在右格里，**不要用绝对定位**（会压在「编辑」文字上，已踩过）。
- 单测：`packages/website/__tests__/titleCopy.spec.ts`。
- 正文里的 h1–h6 本来就能选中（`.heading-permalink` 还显式写了 `user-select:text`），本次没动；
  `select-none` 仅剩页脚版权/访问数和导航图标按钮，属于有意为之。

### 7.3 无 `<!-- more -->` 时自动取前 200 字作摘要

- `packages/website/utils/articleExcerpt.ts`：`DEFAULT_OVERVIEW_CHARS` 由 50 改成 **200**；
  截断不会切开 `[文字](网址)`（上游 #410 的逻辑保留），另外新增代理对保护，不会把 emoji 截成半个。
- 后台编辑器保存时的提示文案改成「会自动截取前 200 字」（`packages/admin/src/pages/Editor/index.jsx`），
  本来也只是 confirm 不是拦截。
- 服务端**草稿发布不再因为缺 more 标记而 403**（`draft.provider.ts` 里那条 `ForbiddenException` 已删），
  否则和「自动摘要」矛盾。
- RSS 的 `MarkdownProvider.getDescription()` 没动：无标记时仍然输出全文（很多人要全文 RSS），
  别顺手改成 200 字。
- 文档：`docs/features/editor.md`、`docs/faq/usage.md`。
- 测试：`packages/website/__tests__/articleExcerpt.spec.ts`、
  `packages/server/src/provider/draft/draft.provider.publish.spec.ts`。

### 7.4 附件管理（上传任意文件并生成 URL）

仿图片管理做的一套，复用 `statics` 表和 `/static` 静态服务，`staticType = 'file'`：

- 存储：`<static>/file/<md5>.<原文件名>`，URL `/static/file/<md5>.<原文件名>`；**只存本地**，
  不跟 PicGo/OSS 走（`saveFile()` 里对 `file` 强制 local）。
- 去重：按 `(sign, staticType)` 去重（`getOneBySignAndType`），同内容重复上传返回同一 URL；
  注意**不能**只按 sign 去重，否则会和同内容的图片串味。
- 新代码：`utils/attachment.ts`（文件名安全化 / 200MB 上限 / 危险类型强制下载 / nosniff /
  latin1 文件名修复）、`utils/regex.ts`（`escapeRegExp`，搜索用）、
  `controller/admin/file/file.controller.ts`（`/api/admin/file`：upload、列表(可按名字搜)、all、export、delete）、
  `local.provider.saveAttachment/exportAllAttachments`、`static.provider.uploadAttachment`。
- 安全：html/htm/svg/xml/js/mjs 等一律 `Content-Disposition: attachment`（同源内联等于存储型 XSS），
  其余类型内联预览；所有附件响应带 `X-Content-Type-Options: nosniff`；上传文件名会去掉路径分隔符/
  控制字符/前导点，`../../x` 只会被存成 `x`。
- 坑：multer/busboy 把 `filename` 按 **latin1** 解码，中文名会变成 `æµ‹è¯•é™„ä»¶.txt`，
  必须 `Buffer.from(name,'latin1').toString('utf8')` 再判断（`decodeUploadFileName`）。
  **图片上传那条老路径仍有这个问题**，本次没动。
- 坑：mongoose 文档不能直接 `{...doc}` 展开（字段在原型上），`withDisplayName()` 里要先 `toObject()`，
  否则接口返回的对象只剩 `displayName`。
- 权限：`file:delete` → `delete-/api/admin/file/:sign`；查看/上传/all 进了 `publicRoutes`（协作者可用），
  导出仅管理员。后台协作者弹窗加了「删除-附件」。
- 后台：菜单「附件管理」= `/static/file`（`config/routes.js`，`icon: 'paper-clip'`，见 §5 那个坑），
  页面 `pages/Static/file/index.tsx`（ProTable + 搜索 + 上传 + 复制链接/Markdown + 下载 + 搜索引用 +
  删除 + 导出全部），编辑器工具栏加了回形针「上传附件并插入链接」（`components/Editor/fileUpload.tsx`）。
- 文档：`docs/features/attachment.md`（新页，AutoCatalog 自动收录）、`docs/advanced/collaborator.md`、
  `docs/reference/dir.md`、`docs/advanced/backup.md`。
- 测试：`utils/attachment.spec.ts`、`provider/static/static.provider.attachment.spec.ts`、
  `controller/admin/file/file.controller.spec.ts`、`packages/admin/tests/unit/attachmentManage.test.js`。

### 7.5 图片管线：1080p 缩放 + 缩略图 + 隐写水印 + 列表视图

- 上传顺序（`StaticProvider.runImagePipeline()`，**顺序不能改**）：
  可见水印 → **缩放**（长边 ≤ `maxImageEdge`，默认 1920，只缩不放）→ **隐写水印** → 有损压缩（webp/avif）→
  生成缩略图 → 落盘 + 写库（`meta.thumb`）。缩放必须在隐写之前（重采样会打乱块均值格点），
  隐写必须在压缩之前（压完还要能读出来）。`upload()` 与 `replaceBySign()` 共用这个方法，别改分叉。
- 新代码：`utils/stego.ts`（纯算法：8x8 块均值格点量化 QIM、CRC32、mulberry32 排列、多数表决）、
  `utils/stegoWatermark.ts`（sharp/Jimp 适配：读 raw RGBA → 改像素 → 按原格式写回）、
  `utils/imgResize.ts`、`utils/thumbnail.ts`、`utils/imgEncode.ts`、`utils/imageOptions.ts`。
- 隐写参数：`STEGO_BLOCK=8`、`STEGO_DELTA=16`（格点间距）、`STEGO_MAX_DELTA=4`
  （每块亮度最多动 4 个色阶 → 肉眼不可见，PNG 上实测平均每通道 <1）、每个 bit 重复 3 次
  （容量不够自动降到 2/1），载荷 = `VBL1 + 版本 + 长度 + UTF-8 + CRC32`；magic/CRC 不对就当没有 →
  **不会误报**。扛得住 webp/avif 有损压缩、二次 jpeg 转码、轻噪声；**缩放/裁剪会失效**
  （种子与尺寸绑定，属设计取舍）。
- 密钥：`settings.static.value.stegoKey`，`SettingProvider.getStegoKey()` 首次生成（`makeSalt()`）。
  **`getStaticSetting()` 返回前会 `delete safe.stegoKey`**（这接口在 `publicRoutes` 里，协作者能调）；
  `updateStaticSetting()` 必须用 `readStaticSetting()` 取旧值，否则每次保存设置都会把密钥冲掉、
  旧图水印全废。
- 缩略图：`<static>/img/thumb/<同名>.webp`（默认 300px、q70，单张约 10KB），DB 存 `meta.thumb`
  （`/static/...` 形式）+ `thumbWidth/thumbHeight`；删图连带删缩略图；
  `POST /api/admin/img/thumb/backfill` 给存量补（只处理 local，picgo 跳过）。
- **替换图片** `POST /api/admin/img/:sign/replace`（multipart，新权限 `img:replace`，协作者弹窗里叫
  「替换-图片」）：新内容走完整管线后**覆盖写回原 realPath**，文件名/后缀一律不变 → 文章里的链接不用改；
  DB 里 `sign`/`meta`/`fileType` 更新，磁盘文件名仍是**旧内容**的 md5 前缀（故意的，为了保 URL）。
  只支持本地存储，picgo/OSS 直接报错让用户删了重传。
- **批量引用查询** `POST /api/admin/img/references`（进了 `publicRoutes`，只读）：
  `ArticleProvider.countArticlesByLinks()` 用一次 `$regex`（`escapeRegExp` 转义后 `|` 拼接）把候选文章捞出来
  再在内存里计数，**不是每张图查一次**；传相对路径能匹配到正文里的绝对 URL；单次最多 200 个链接、
  每个链接最多回 10 篇。
- 检测水印 `POST /api/admin/img/stego/detect`：body 给 `sign` 查图床里那张，或直接上传文件来验；
  只读、不接受外链 URL，所以没有 SSRF。
- 后台：图床设置新增 大图自动缩放 / 长边上限 / 生成缩略图 / 缩略图宽度 / 隐写水印 / 隐写内容
  （原「水印」改名「可见水印」，默认关）；图片管理页有三种视图 —— `小图`（默认，桌面 12 列 / 每页 60 张）、
  `大图`（5 列 / 15 张）、`列表`（Table：图片、名称、格式、尺寸、大小、上传时间、引用文章、操作），
  每页数量由 `PAGE_SIZE[viewMode]` 推导；**「全部删除」按钮已删除**（误点代价太大）。
- 列表里的「上传时间」取 `updatedAt`：`statics` 表只有这一个时间字段（新建时即上传时间，替换后会刷新）。
- 本机若没有 `cwebp` / `avifenc`，压缩会走 `compressImg()` 的 **sharp 兜底分支**；server 自带 sharp 0.32.6。
- 坑：量「水印是否可见」要用 **PNG**（无损）比像素，用 JPEG 会把重编码误差算进去。
- 测试：`utils/stego.spec.ts`、`utils/stegoWatermark.spec.ts`、`utils/imgResize.spec.ts`、
  `provider/static/static.provider.imagePipeline.spec.ts`、
  `provider/article/article.provider.references.spec.ts`、
  `packages/admin/tests/unit/imagePipeline.test.js`。
- 文档：`docs/features/image-storage.md`（大图自动缩放 / 缩略图 / 隐写水印 / 三种浏览模式 / 替换图片）、
  `docs/advanced/collaborator.md`、`docs/reference/dir.md`。

### 7.6 整站备份 / 恢复（一个高压缩归档）

- 新接口（都在 `AdminGuard` 后，协作者调不到）：`POST /api/admin/backup/full/export`（body `{format: auto|zstd|xz|gzip}`）、
  `GET full/formats`、`GET full/list`、`POST full/inspect`、`POST full/restore`（`{name, confirm:'true'}` 或直接 multipart 上传）、
  `POST full/delete`、`GET full/download?name=`（鉴权下载）。
- 备份内容：主库**全部集合** + `waline` 评论库 + `<static>/{img,file,customPage}`（含缩略图）；
  **不含** `export/`（会套娃）、`tmp/`、`rss/`、`sitemap/`、日志、证书。
- 没有 `mongodump`/`mongorestore`（官方 server tarball 与 Alpine 镜像都不带），所以用 driver 逐集合导成 **NDJSON**，
  BSON 类型按 canonical EJSON 编解码（`utils/backupCodec.ts`，按 `_bsontype` 判别，比 `instanceof` 稳）。
  注意：`bson` 在 pnpm 严格 node_modules 下不能直接 require，`mongodb@5` 也不再导出 EJSON，所以自己实现了子集；
  解码遵循「只有单键 `$xxx` 才当扩展 JSON」，构造失败就退回普通对象（脏数据不能把整次恢复带崩）。
- 压缩：`zstd -19 --long=27 -T0` > `xz -9e -T0` > `gzip -9`，运行时探测、后缀跟着变。实测（53 篇 / 90 图 / 68.8MB 静态）：
  gzip 66.00MB/5.4s、**zstd 65.91MB/33.9s**、xz 65.92MB/51.4s —— 图片已是 WebP，压缩率主要取决于数据库部分，
  zstd 又小又快所以设为默认；等级可用 `VANBLOG_BACKUP_ZSTD_LEVEL` 调。恢复只要 ~3s。
- 静态文件用 `cp -al` **硬链接**进暂存目录（同文件系统零额外空间、几乎瞬时），失败回退真实拷贝；
  tar 与压缩器用 `spawn` 管道**全异步**——用 `spawnSync` 会把事件循环卡死几分钟，整个 API 都不响应。
- 归档目录 = `config.backupPath`（新配置项 `backup.path` / `VAN_BLOG_BACKUP_PATH`，默认 `<log>/vanblog-backups`）。
  **故意不放在 staticPath 下面**：静态目录匿名可读，而归档里有密码哈希和 jwt 密钥；`main.ts` 还留了一道兜底拦截
  （万一被配进静态目录，或旧版本留在 `<static>/export/backups/` 的文件）。下载一律走 `full/download`。
- 恢复：每个集合先导进 `<name>__vanblog_restore`，全部写成功后 `rename(dropTarget:true)` 原子替换，
  再按备份里的 `*.indexes.json` 重建索引（跳过 `_id_`）；中途失败原数据还在，也不会留半张表。导出时会跳过残留的临时集合。
- 上传恢复必须用 multer **diskStorage** 落到 `<static>/tmp`：默认内存存储会让 `file.path` 为空
  （一开始就踩了，接口一直报「没有收到文件」），而且 65MB 全进内存；`finally` 里删临时文件。
  装饰器里不能调实例方法，所以 multer 选项写成模块级常量。
- 恢复后 **`tokens` 表也被覆盖 → 当前登录态立刻失效**（实测恢复完再调接口直接 401），必须重新登录；
  `confirm=true` 是硬性要求，演示站一律拦；用户可见的错误一律抛 `BadRequestException`
  （普通 `Error` 会被 Nest 变成 500 + "Internal server error"，前端就看不到原因）。
- 顺手修了老 JSON 导出的 bug：`fs.writeFileSync('temp.json')` 写在进程 cwd（`packages/server/temp.json`），
  而且**只有出错才删**，成功下载就把整站数据留在了代码目录里；改成系统 tmp 目录 + 无论成败都删。
- 后台：`站点管理/系统设置/备份恢复` 顶部新增「整站备份与恢复」卡片（格式选择 / 导出 / 上传恢复 /
  列表：体积·格式·内容·时间 + 下载·清单·恢复·删除），原来的 JSON 导入导出挪到下面的卡片并写清区别。
- 测试：`utils/backupCodec.spec.ts`(7)、`utils/fullBackup.spec.ts`(10，用假 Mongo 跑完整的「打包 → 恢复到另一个目录」往返，
  校验 BSON 类型、索引重建、静态文件、错误归档被拒)、`packages/admin/tests/unit/fullBackup.test.js`(12)。
- 本机 e2e 已验证：导出（zstd 65.91MB / 29s）、inspect（不解压，0.04s）、鉴权下载、匿名访问 403/404、路径穿越 400、
  **破坏性恢复**（删 8 篇文章 + 清空 visits/settings/waline 评论 + 删 2 个图片文件 → 恢复后全部回来：
  articles 53、visits 8705、settings 6、waline Comment 3，13 个索引重建，`_id` 仍是 ObjectId、`createdAt` 仍是 Date、
  日期范围查询仍命中 53 条，`stegoKey` 的 sha256 与归档内一致）、上传恢复（multipart 2.7s，临时文件已清）、
  错误路径（非备份 / 截断 / 假 7z 都返回可读的 400）、删除。

### 7.7 导出单篇文章（`.md` 原样 + `.mdz` 带图包）

- 接口 `POST /api/admin/export/markdown`（`AdminGuard`；进了 `publicRoutes`，协作者可用——只读，而且他们本来就能读这些文章）：
  body `{id?, type: 'article'|'draft'|'raw', title?, content?}`，回一个 zip；
  `X-Export-Report` 头里带打包明细（前端要靠 `Access-Control-Expose-Headers` 才读得到）。
- 产物：`<标题>.md`（**原样**：front matter + 正文，图片链接不动）、`<标题>.mdz`（**只有真有图片时才生成**：
  本身就是个 zip = 链接改成相对路径的 md + `<标题>.assets/` 图片目录，Typora 风格）、
  `导出说明.md`（只有出现跳过/失败图片时才生成）。外层再套一个 zip 一次性下载，免得浏览器拦多文件。
- `type:'raw'` = 不查库，直接用调用方给的 title/content：**编辑器里未保存的改动**和**关于页**（没有文章 id）走这条路。
- 图片识别（`utils/markdownExport.ts`）：`![]()`、`![](url "title")`、`![](<带空格 url>)`、`<img src>`、
  引用式 `![][label]`（改的是定义行，用出处不动）。**代码块与行内代码里的图片语法一律跳过**：
  做法是把代码区「涂黑」成等长 NUL 占位（`maskCodeRegions`），偏移量不变，再按偏移精确改写，所以不会误伤。
- 偏移坑：`<img src="...">` 的值起点必须用 `/^\s*src\s*=\s*["']?/` 量前缀，**不能**用「匹配长度 − 值长度」倒推
  （带引号时尾部还有一个引号，会整体偏一位，实测把 `src="/static/x.webp"` 改成了 `src="/x.assets/x.webp width=...`，
  把闭引号吃掉了）。`![](...)` 的偏移可以用 `m[0].length - m[2].length - 1` 倒推（值确实在尾部）。
- 文件名：标题里的空格与 `()[]{}'"#%` 换成 `-`（markdown 链接目标里有这些就得转义或百分号编码，
  Typora/Obsidian/VSCode 支持程度不一致），于是链接可以直接写 `标题.assets/图.webp`，不做任何转义；
  标题原文仍在 front matter 里，导入回来不丢。
- front matter 自己拼（`buildFrontMatter`），比原来后台那份严谨：标题带冒号/空格会加引号、
  `tags` 输出真正的 YAML 数组（旧实现 `tags: ${value}` 会把数组 toString 成 `a,b`）、补了 `pathname`、
  `false`/空值不写。旧格式 js-yaml 也能读，但结构会丢。
- 外链图片：axios 抓一次（超时 15s、单张 ≤50MB、≤3 次跳转）；**抓不到就保留原链接**并写进 `导出说明.md`，
  不影响整体导出。抓之前过 `assertSafeRemoteUrl()`：只允许 http/https、字面量内网地址直接拒、
  域名还要 `dns.lookup` 后确认没解析到内网（防 SSRF / DNS rebinding）——协作者也能调这个接口，所以必须挡。
- 本地图片按**路径**塞进 zip（`compressing.zip.Stream` 的 `addEntry(path)`），不整块读进内存；
  「本站域名的绝对地址」也算本地（`classifyImageUrl` 会比对 `siteInfo.baseUrl`）。
- 后台：文章/草稿列表每行「导出」、编辑器「导出文章 / 导出草稿 / 导出关于」全部改成服务端打包
  （`services/van-blog/exportMarkdown.tsx` 的 `downloadMarkdownExport()`：读报告头、解析 `filename*=UTF-8''`、
  blob 里其实是 JSON 时报错要嗅探出来、有失败图片时弹窗列清单）。文件后缀必须是 `.tsx`（里面有 JSX，`.ts` 编译不过）。
- 顺手修了 `batch.ts` 的 `exportEachById`：收了 `isDraft` 参数却写死 `getArticleById`，草稿批量导出等于在导文章。
- 测试：`utils/markdownExport.spec.ts`(20)、`provider/export/markdownExport.provider.spec.ts`(9，会解包校验 mdz 内部结构、
  外链成功/失败、raw、草稿、丢图、SSRF；`jest.mock('dns')` 让离线环境也能测外链)、
  `packages/admin/tests/unit/markdownExport.test.js`(12)。
- 本机 e2e：文章 46（11 张本地图）→ 11.04MB，11 张全在 `.assets/`，链接 0 处失配；文章 2（无图）→ 只有 `.md`；
  文章 44（标题带空格 + 1 个 `<img>`）；草稿（`type:'draft'`）；边界文章（代码块假图 / 行内代码假图 / data URI /
  坏外链 / 引用式 / 本站绝对地址 / 同一张图重复引用）全部符合预期；SSRF 三例（127.0.0.1、192.168.1.1、localhost）
  全被拒且 axios 没被调用；400/401 错误路径齐全。

### 7.8 前台 Apple 风格皮肤（后台可切换）

- 新设置 `siteInfo.uiStyle`：`'apple'`（默认）| `'default'`。`MetaProvider.getSiteInfo()` 做归一化：
  **只有显式写了 `default` 才不是 apple**，老站点没这个字段就直接吃新风格（后台「站点信息 → 布局设置 → 界面风格」可切回）。
- website 接线：`utils/getLayoutProps.ts` 透传 `uiStyle` → `components/Layout` 在最外层输出
  `<div class="vb-root" data-ui="apple">`，并用 effect 把它同步到 `<html data-ui>`
  （SSR 就带上所以不闪；同步到 html 是为了 overscroll 区域的底色）。
- 皮肤全部在 `packages/website/styles/apple.css`，**每条规则都带 `[data-ui="apple"]` 作用域**
  （`__tests__/appleTheme.spec.ts` 有一条「不许漏」的守卫测试：解析出所有选择器，断言都含作用域），
  只改样式、不动结构，也不会和用户的自定义 CSS 打架。
- 为了给皮肤稳定挂载点，加了几个纯 class 钩子：`.vanblog-body`(LayoutBody 行容器)、
  `.vanblog-article-page`(文章页包裹)、`.vanblog-timeline` / `.vanblog-timeline-item`、
  `.vanblog-category-list`、`.vanblog-link-card`、`.vanblog-notfound`。
- 令牌（改这些就能整体调色）：canvas `#fff`/`#000`、surface `#fff`/`#1d1d1f`、内嵌面 `#f5f5f7`/`#2c2c2e`、
  text `#1d1d1f`/`#f5f5f7`、次要 `#6e6e73`、发丝线 `#d2d2d7`/`#424245`、强调 `#0071e3`/`#2997ff`、
  圆角 18/12/980、列表宽 980px、阅读栏 780px、正文 17px/1.6、SF Pro 字体栈、`cubic-bezier(.4,0,.2,1)`。
- 几个关键手法（改这块前先看懂）：
  - 列表条目分隔线用**相邻兄弟**选择器 `.post-card-wrapper + .post-card-wrapper { border-top }` ——
    文章页只有一张卡，自然不会有分隔线，不用去区分页面类型。
  - 作者卡片从右侧栏挪到页首：`.vanblog-body:has(#author-card) { flex-direction: column }` +
    `.vanblog-sider { order: -1; display: block !important }`（它原本是 `hidden lg:block`），
    再 `#author-card { position: static !important }` 抵消 headroom.js 的 sticky。
    文章页的 `#toc-card` 不受影响，仍是右栏（220px + 左侧发丝线）。
  - 文章页正文**不能**被列表页的 4 行截断规则盖住（那条选择器更具体），所以文章页的
    `display` / `-webkit-line-clamp` / `overflow` 都写了 `!important`。
  - 分页单元格没有稳定 class（只有 Tailwind 工具类 + inline style），用 `ul li > div[style]` 命中普通格、
    `div[class*="bg-gray-700"]` 命中当前页 —— 脆但有效，改分页组件时记得回来核对。
  - `:has()` 要 Chrome 105+ / Safari 15.4+ / FF 121+；不支持时只是作者卡片留在右栏，不会错乱。
- **第一版被用户否掉了（"丑爆了"）**，两个具体问题和修法，改这块务必记住：
  1. 我给 `.card-shadow` 加了 `border: 1px solid` 想做"卡片感"，而 `#post-card` 同时带 `.card-shadow`
     又被 id 规则强制 `border-radius: 0` → **每篇文章外面套一个直角描边框**。Apple 的层次是
     **留白 + 发丝线 + 浅灰填充，不靠线框**：现在 `.card-shadow` 一律 `border: 0` + `background: transparent`，
     只有两处例外用 `--ap-surface-3` 浅灰填充（友链卡片、文章正文里的提醒/版权/打赏小块），仍然不描边。
  2. 标题右侧「编辑」在组件里写死 `text-dark`（近黑）+ 默认字号，视觉过重 → 皮肤里压成
     13px / `--ap-text-3` / 400 字重，hover 才变强调色；复制图标同步压淡、svg 缩到 14px。
  顺带抹平的描边：导航内部两条 `border-b`（主行 + 分类子菜单行）、分页胶囊、代码块、表格外框与斑马纹、
  自定义容器、输入框、返回顶部、过期提醒的 `border-l-4` 彩色左边条（改成浅灰内嵌块）、TOC 左竖线。
  **整份皮肤现在只剩这几处单边发丝线**：导航底部、列表条目之间、文章元信息下、引用块左边(2px)、
  表格行之间、页脚上方、移动端抽屉右边。`appleTheme.spec.ts` 加了守卫：出现任何四面包围的
  `border: … solid`（除 `border: 0` 与滚动条的 `transparent` 技巧）、或单边线没用 `--ap-hairline`，测试直接红。
- 已知残留：`pages/404.tsx` 没用 `Layout`（自带 markup），拿不到 `data-ui`，所以 `.vanblog-notfound`
  那几条目前是死代码。要么以后让 404 走 Layout，要么删掉。
- e2e 已验证：`GET /api/admin/meta/site` → `PUT uiStyle=default/apple/乱填` → 首页 `data-ui` 依次是
  `default`/`apple`/`apple`（非法值回落），其余 19 个 siteInfo 字段没被 PUT 冲掉；
  `/`、`/timeline`、`/category`、`/tag`、`/about`、`/link`、`/post/<slug>` 全 200，无 Next 运行时报错。
- 文档：`docs/features/config.md` 新增「界面风格（Apple 风格）」整节（含逐项说明与令牌表）。
- 测试：`packages/website/__tests__/appleTheme.spec.ts`(26，含「不许出现框」「标题操作区不能抢戏」两组守卫)、
  `packages/admin/tests/unit/appleTheme.test.js`(4)。

### 7.9 测试基线（本分支最后一次全量运行的结果）

| 套件 | 结果 |
|---|---|
| server `jest` | 511 用例：510 绿，1 个既有失败（`utils/watermark.spec.ts` 需要联网拉字体，见 §2.1） |
| website `vitest run` | 47 文件 / 398 用例全绿 |
| admin `node --test tests/unit` | 50 文件 / 184 用例全绿 |
| admin playwright e2e | 未跑（没装浏览器） |

改动之后请至少跑对应包的那一套；跨包改动（例如同时动了 server 与 docs）三套都跑。

---

## 8. 给 AI 代理的额外提示

1. 动手前先 `git log --oneline -10` + `git status`，确认自己在哪个分支、有没有未提交的东西。
2. 改完代码**必须跑测试**（§2.1），并对照 §7.9 的基线判断是不是自己弄坏的。
3. 需要改本地环境时，**新建文件 + 写进 `.git/info/exclude`**，不要改仓库跟踪的文件（§6.2）。
4. 提交信息用 Conventional Commits；一个需求一个提交，交叉文件的改动尽量按功能拆开
   （必要时用 `git apply --cached` 做 hunk 级暂存）。
5. 不要 `git push` 到 `origin`；推自己的 fork（§2.2）。不要打 tag。
6. 涉及上传/图片/附件的功能，注意三条既有约束：附件只落本地、图片按 `(sign, staticType)` 去重、
   图片管线顺序不可调整（§7.5）。
7. 本机专属信息（真实路径、代理、已导入的数据、远端与凭据、遗留待办）都在 `AGENTS.local.md`，
   **不要把它的内容写进入库文件，也不要提交它**。
