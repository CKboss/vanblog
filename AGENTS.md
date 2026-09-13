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

编译耗时参考（冷启动）：admin(umi+MFSU，依赖 `patches/` 里两个补丁，见 §5 与 §7.14) ≈ 25s + MFSU 首次 ~1.5 min，
website(next) ≈ 5–30 s，server(nest/tsc) ≈ 20–40 s；
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
| 后台 3002 白屏 / `ScriptExternalLoadError: Loading script failed (timeout: /mf-va_remoteEntry.js)` | umi3 的 **MFSU** 只读 `main`/`module`、不认 `exports` 映射，遇到 ESM-only 包就 `AssertionError: filePath not found of xxx`，远程包生不出来 | 靠根目录 `patches/` 里两个 pnpm patch 给 `remark-supersub` / `remark-github-blockquote-alert` 补 `main`。**升级这两个包会让 patch 失效**（pnpm 会报错）：重新 `pnpm patch <pkg>@<ver>` 补一次，或临时 `mfsu: false`（dev 冷启动 25s→2min）。改完都要 `rm -rf packages/admin/src/.umi/.cache` 再重启 |
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
拼音链接、标题可复制、自动摘要、附件管理、两个 UI 修复、图片管线（缩放/缩略图/隐写水印/列表视图）、整站备份与恢复、单篇文章导出（md + 带图 mdz）、前台 Apple 风格皮肤、Markdown 编辑器/前台渲染一致性、前台性能优化（按需加载 + 缓存头）、全站 bug 与安全加固、一键脚本修复（并改成从本分支源码构建镜像）、后台性能优化、补齐 6 种 markdown 语法、内置评论系统。
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
- **第二版又被抓到一个 bug**：搜索浮层（右上角放大镜 / `Ctrl`+`K`）在 apple 主题下**整块透明、看不见输入框**。
  原因是我把 `.card-shadow` 一刀切成 `background: transparent !important`，而搜索面板正是
  `bg-white … card-shadow`。**教训：覆盖层（sheet / 弹窗 / 抽屉）必须有表面 + 投影，不属于「不要框」的范畴。**
  修法：给 `components/SearchCard` 加 `vanblog-search-overlay` / `vanblog-search-panel` 两个钩子，
  用**更具体**的选择器 `.card-shadow.vanblog-search-panel` 把表面/圆角/投影写回来（并且必须排在
  `.card-shadow` 那条透明规则之后），再按 Apple 全局搜索的样子做：遮罩 `rgba(0,0,0,.32)` + `blur(8px)`、
  面板白色 sheet（暗色 `#1d1d1f`）+ `0 24px 64px` 投影、输入框 21px 无框、下面一道发丝线、
  结果行去虚线改圆角 + hover 浅灰（`a[data-search-result] > div`）、`Ctrl K`/`Esc` 提示改无边框浅灰小胶囊。
  `appleTheme.spec.ts` 里加了守卫，其中一条专门断言「面板规则必须写在透明规则之后」，防止层叠再翻车。
- **第三轮用户又提了 3 个细节**（都已修，并各留一条回归测试）：
  1. 标题下元信息行（时间 / 分类 / 阅读量 / 评论量）中间的 `|` 要去掉 —— 那是 Tailwind `divide-x`
     给相邻 `span` 加的 `border-left`；apple 下改成 `border: 0 !important` + 18px 间距。
  2. 时间线月份行的展开按钮里 `>` 和外框不居中 —— 组件是 `inline-block` + **内联** `width:22.5` +
     `text-lg leading-tight`，我原先那条 `.bg-gray-200 { padding: 2px 10px; 胶囊 }` 把它顶偏了。
     现在用组件已有的 `data-expand-chevron` 钩子：固定 22px 正方形 + `display:inline-flex` 居中 +
     `line-height:1` + 正圆浅灰底，内层 span 同样 flex 居中（旋转 90° 的那个）。
  3. **关于页只显示一小截** —— 根因：我把摘要 `-webkit-line-clamp: 4` 写在
     `.post-card-wrapper .post-card > div > .markdown-body` 上，而 `pages/about.tsx` 的 PostCard
     没有 `.vanblog-article-page` 包裹（只有 `post/[id].tsx` 有），所以关于页正文被裁成 4 行。
     两处都修：about.tsx 补上 `.vanblog-article-page` 包裹；截断规则改成只命中
     `.post-card-wrapper:has(.post-card div.flex.justify-center.mt-4)`（即带「阅读全文」的列表卡）。
     **教训：任何"只对列表生效"的样式都要用列表独有的特征来限定，别用"页面没包 class"来兜。**
- 已知残留：`pages/404.tsx` 没用 `Layout`（自带 markup），拿不到 `data-ui`，所以 `.vanblog-notfound`
  那几条目前是死代码。要么以后让 404 走 Layout，要么删掉。
- e2e 已验证：`GET /api/admin/meta/site` → `PUT uiStyle=default/apple/乱填` → 首页 `data-ui` 依次是
  `default`/`apple`/`apple`（非法值回落），其余 19 个 siteInfo 字段没被 PUT 冲掉；
  `/`、`/timeline`、`/category`、`/tag`、`/about`、`/link`、`/post/<slug>` 全 200，无 Next 运行时报错。
- 文档：`docs/features/config.md` 新增「界面风格（Apple 风格）」整节（含逐项说明与令牌表）；
  `docs/features/markdown.md`（新页）是 Markdown 支持范围矩阵（支持 / 不支持 / front matter / 安全），见 §7.9。
- 测试：`packages/website/__tests__/appleTheme.spec.ts`(39，含「不许出现框」「标题操作区不能抢戏」
  「所有覆盖层都要有表面」「用户反馈的三个细节」四组守卫)、`packages/admin/tests/unit/appleTheme.test.js`(4)。

### 7.8.1 Apple 皮肤的字体：Maple Mono（令牌驱动 + `<link>` 加载）

用户要求把「自定义 CSS 里那份 Maple Mono 字体」直接整合进皮肤。做法与两个坑：

- **写在令牌里，不写宽选择器**：`--ap-font` / `--ap-font-mono` 以 `"Maple Mono NF CN", "Maple Mono"`
  打头，后面**完整保留**原来的 SF Pro / 苹方 / 雅黑栈；字体规则挂在 `[data-ui="apple"]` 与
  `[data-ui="apple"] body` 上靠继承生效。
  ⚠️ 用户原稿里那种 `p, span, div { font-family: … }` 不能用：它会把代码块的 `--ap-font-mono`
  一起覆盖掉，还会波及第三方组件（评论区、播放器）。
- **远程字体样式表走 `<link>`，不能写 `@import`**：CSS 规范要求 `@import` 在所有其它规则之前，
  而 `apple.css` 是被 `globals.css` 内联进来的（前面还有 `siteNameLayout.css` 与 Tailwind 产物），
  内联后远程 `@import` 不在首位 → 浏览器**静默丢弃**，字体加载不上且不报错。
  用户原稿正好踩了这个（`@font-face` 写在 `@import` 前面）。现在：拉丁子集的 `@font-face`
  放 `apple.css`（位置无关），中文子集那份 zeoseven CSS 由 `components/Layout` 用
  `<link rel="stylesheet">` 加载，**只在 `uiStyle === 'apple'` 时**加载，并配 preconnect/dns-prefetch。
  `__tests__/appleSkinFont.spec.ts` 会扫所有 css 文件，禁止出现远程 `@import`。
- ⚠️ 已有测试 `appleTheme.spec.ts` 里有一条 `expect(css).not.toContain('@import')`：
  它是针对**整份文件文本**的，所以我在 apple.css 里写「为什么不能用 @import」的注释会把它打红。
  已改成先剔除 `/* … */` 再断言（教训同 §7.15：源码级断言要先剔注释）。
- **实测发现**：`zeoseven.com` 可解析可访问，但**本机解析不了 `static.zeoseven.com`**
  （`No address associated with hostname`，走代理也是 SSL_ERROR_SYSCALL），
  所以中文子集在这台机器上加载不到 → 会退回兜底字体栈（这正是保留完整 fallback 的意义）。
  jsDelivr 的拉丁子集正常（`latin-400-normal.woff2` → 200 / 74KB）。
  npm 上没有 `maple-mono-nf-cn` / `maple-font` 包，`subframe7536/maple-font` 仓库里也没有构建产物
  （字体在 GitHub Releases 里，jsDelivr 的 `/gh/` 只能取仓库文件），所以要自己托管得从 Release 下载。
  换字体源只需改 `components/Layout/index.tsx` 里的 `appleFontCss` 常量（就一处）。
- **远程字体样式表必须异步加载**（`media="print"` → 水合后 `useEffect` 翻成 `all`，配 `<noscript>` 兜底）。
  普通 `<link rel="stylesheet">` 是**渲染阻塞**的，而 `static.zeoseven.com` 在部分网络下 DNS 就解析不了
  （本机实测如此）→ 阻塞加载等于首屏白屏等到超时。异步之后最坏只是用兜底字体。
  ⚠️ 翻 media 靠的是 `useEffect`，**不是** `<link onLoad>`：`next/head` 用
  `document.createElement` + `setAttribute` 搬子元素，函数 prop 不会被带过去；
  命中缓存时也可能在监听挂上之前就加载完了。
- 字体源集中在 `utils/appleFont.ts`（`APPLE_FONT_CSS_URL` + `APPLE_FONT_PRECONNECT_HOSTS`）。
  `APPLE_FONT_CSS_URL = null` 时 `<link>` 与 preconnect 都不输出 —— 这是**自托管**的入口
  （从 maple-font 的 GitHub Releases 下 NF-CN，按 unicode-range 分包放进 `public/fonts/`）。
- **后台编辑器预览也用同一套字体**（`packages/admin/src/style/apple-preview.css` +
  `components/Editor/useApplePreviewFont.ts`），做到所见即所得：
  - 两个包不共享构建产物，所以字体栈是**复制的两份**；`packages/admin/tests/unit/editorFont.test.js`
    会把 `--ap-font` / `--ap-font-mono` 两边逐项比对（改一边忘了另一边就会红）。
  - 作用域只有 `.vanblog-apple-preview .bytemd-preview`：**只影响预览面板**，
    不动左侧 CodeMirror 编辑区（改它会影响写代码的手感），也不外泄到后台其它页面（表格/表单仍是 antd 默认字体）。
    代码相关（`code`/`pre`/`kbd`/`tt`）走 `--ap-font-mono`，不被正文字体盖掉。
  - 皮肤判定：`/api/admin/meta` 的返回里**没有** `uiStyle`（只有 version/user/baseUrl/enableComment/allowDomains），
    所以编辑器挂载时单独取一次 `/api/admin/meta/site`（`getSiteInfo()`），判定规则与前台一致
    （只有显式 `'default'` 才算默认皮肤）。取不到就退回默认皮肤，**不能让编辑器白屏**（`.catch` 兜住）。
  - 远程字体样式表的注入是**非阻塞**的（`media='print'` → load 后翻 `all`，另有 1.5s 兜底定时器 +
    error 时摘掉节点），并用模块级引用计数，避免反复进出编辑器插拔 `<link>`。
    后台是 umi + React 17，直接操作 DOM 就行，不像前台要绕 `next/head` 丢函数 prop 的问题。
    `APPLE_FONT_CSS_URL = null` 时一个字节都不发（自托管入口，与前台同义）。
- 顺带确认：站点的 `siteInfo.customCss` 是**空的**、`enableCustomizing` 也没开 —— 也就是说
  用户那段自定义 CSS 此前**根本没生效**（`CustomLayout` 只在 `enableCustomizing == "true"` 时渲染）。
  整合进皮肤后不再依赖那个开关。

### 7.8.2 Apple 皮肤「看起来只有黑白灰」的修法

用户反馈：主页只有黑和白，很单调。查下来的**事实**（不是审美问题，是数据 + 设计问题）：

- 库里 53 篇文章 **一张 `cover` 都没设**，而列表卡只在 `type == "article"` 时才渲染 `ArticleCover`
  → 首页**一张图都没有**；
- 皮肤为了「去盒子化」（§7.8 的 3fabc05a）把卡片阴影/背景都去掉了，条目之间只剩发丝线；
- 元信息行里所有 `span/div` 被强制成 `--ap-text-3`（灰），图标也是灰的；
- 每页只有 5 篇（`articlesPerPage=5`），信息量本来就少。

于是「白底 + 黑标题 + 灰摘要 + 发丝线」= 用户说的单调。修法是补**低饱和的颜色与图像**，
而不是改配色体系（Apple 的语言本来就是中性色为主 + 少量彩色）：

1. **列表缩略图**（`utils/firstImage.ts` + `components/PostCard/ListThumb.tsx`）：
   `cover` 优先，没有就取正文首图。⚠️ 要用**完整正文** `content` 而不是 `calContent`
   （摘要只有 200 字，首图常常在后面）。本站图床的图换成 `/static/img/thumb/<同名>`（§7.5 的缩略图），
   `onError` 回退原图，再失败就整块不渲染。取图要**屏蔽代码区**（教程里的 `![示例](…)` 不算），
   且只接受 `http(s)` / `//` / `/static/`，`data:` 与相对路径一律不要。
   桌面端 `float: right`（文字左图右），窄屏不浮动、排在标题上方。
2. **标签彩色胶囊**（`utils/tagColor.ts`）：色相 = 标签名哈希（稳定），
   以 CSS 变量 `--chip-h` 下发，浅色 `hsl(h 76% 95%)/hsl(h 62% 33%)`、深色 `hsl(h 42% 20%)/hsl(h 72% 74%)`
   —— 用变量而不是内联颜色，是因为**内联样式做不了暗色适配**。
   ⚠️ 列表页原来**没有把 `tags` 传给 PostCard**（接口是返回 tags 的），所以一个胶囊都渲染不出来，
   `pages/index.tsx` 与 `pages/page/[p].tsx` 都补了 `tags={article.tags}`。
3. **页首作者条**换成两层径向渐变面板（蓝 + 品红，8~10% 不透明度）+ 18px 圆角，头像加强调色描边。
4. 元信息行的 **svg 图标**染成 `--ap-accent`（`opacity: .72`），文字仍保持灰色。

**作用域纪律**：`.post-card-thumb-wrap` / `.post-card-chips` 这两个节点对两种皮肤都会渲染，
但 `globals.css` 里默认 `display: none`，只有 `[data-ui="apple"]` 下才显示 ——
默认皮肤的版面一个像素都不变。测试里钉了这条（`__tests__/appleSkinRichness.spec.ts`）。

**别搞错的两件事**：
- 公开列表接口带 `toListView=true` 时**不返回 content**（只有 tags/cover/title 等），
  那是 `getStaticPaths` 用的；真正的列表数据是不带 `toListView` 的那次请求，content 是有的。
  调试时别拿 `toListView=true` 的返回去判断"列表页有没有正文"。
- 首页只有 5 张卡（`articlesPerPage=5`），所以"10 篇里 4 篇有图"在首页只会出现 2 张缩略图，
  这不是 bug。

### 7.9 Markdown：编辑器预览与前台渲染的一致性

- 两边共用 bytemd 流水线：`remark-parse → remark-rehype({allowDangerousHtml:true}) → rehype-raw →
  rehype-sanitize(schema) → 插件 rehype → stringify`。所以一致性只取决于三件事：
  **插件清单**、**sanitize 白名单**、**共享插件的实现**。实测矩阵写在 `docs/features/markdown.md`。
- 这轮查出并修掉的不一致：
  1. **front matter（最严重）**：编辑器有 `@bytemd/plugin-frontmatter` 会把它解析掉，前台没有 →
     正文开头的 `---\ntitle: …\n---` 在文章页被渲染成 `<hr>` + 一个巨大的 setext 标题
     `<h2>title: xxx tags: [a, b]</h2>`。修法不是加依赖，而是新增 `utils/frontMatter.ts`
     （website 与 server 各一份、逻辑一致），在三处剥掉：`components/Markdown`（渲染）、
     `utils/articleExcerpt`（摘要）、server `MarkdownProvider.getDescription`（RSS）。
     剥完顺手吃掉紧随的空行，否则摘要会以 `\n` 开头。
  2. **编辑器 sanitize 落后于前台**：前台的 canonical schema 放行 `button` + `type/disabled`、
     `dataLine`（代码块行号）、`title`、`ariaLabel/ariaHidden`，并过滤 `on*` 事件属性；
     编辑器那份是早期手写的，这些都没有 → **编辑器预览里代码块没有复制按钮、没有行号、没有 tooltip**。
     修法：新建 `packages/admin/src/components/Editor/markdownSanitize.ts`（与前台同构），
     删掉 `Editor/index.tsx` 里那份内联 schema。
  3. **未知容器标题回落**：`::: foo`（不在映射表里）编辑器回落成容器名、前台回落成 `undefined`
     → 前台补 `|| tagName`。
  4. `linkTarget.tsx` / `rawHTML.tsx` 两份实现只有引号风格差异，功能一致（已逐个 diff 核对，不用动）。
- **有意保留的差异**：前台 `heading.tsx` 会生成 `id` / `markdown-heading` class / 悬停 `#` 永久链接（91 行），
  编辑器版只设 `data-id`（18 行）→ 预览里标题没有锚点和 `#`，可接受；`codeBlock.tsx` 前台用
  `react-hot-toast` + `codeCopyA11y`，编辑器用 antd `message`，行为等价。
- 两边**都不支持**的 6 种语法后来补齐了（见 §7.14）：`==高亮==`、`X^2^` / `H~2~O`、`:emoji:` 短代码、
  定义列表、GitHub Alerts `> [!NOTE]`、`[[toc]]`。原则不变：**要补必须两边同时加插件**。
- 两边**都支持**（逐项实测 ✅）：GFM 表格与对齐、任务列表、删除线、自动链接、**脚注**（remark-gfm 3 自带）、
  KaTeX 行内与块级、mermaid、`::: tip/info/note/warning/danger` 容器、代码高亮 + 行号 + 复制按钮、
  `<u> <mark> <kbd> <center> <font color> <button> <details> <iframe>`、`<!-- more -->`。
- 回归测试：`packages/admin/tests/unit/markdownConsistency.test.js`(7) 把「两份 sanitize 白名单逐项对齐」
  「渲染类插件两边都在」「front matter 两边都不显示」「编辑器独有插件不该出现在前台」「未知容器回落一致」钉死；
  另有 `packages/website/__tests__/frontMatter.spec.ts`(7)、
  `packages/server/src/provider/markdown/markdown.provider.frontmatter.spec.ts`(3)。
- 实测方法（可复用）：建一篇 pathname 固定的探针文章 → 正文塞满各种语法 → 抓 `/post/<pathname>` 的 HTML
  逐项 grep → **测完删文章**（别留在站上）。

### 7.10 前台性能优化（首屏 JS −34%，图片长缓存）

- **重依赖全部改成按需加载**（这是最大头）：以前 `components/Markdown/index.tsx` 静态 import 了
  `@bytemd/plugin-math-ssr`（KaTeX 275KB）和 `@bytemd/plugin-mermaid`（含 d3 等 1MB+），
  于是**每个渲染 markdown 的页面**都要下载它们，哪怕这篇文章一个公式都没有。现在：
  - `components/Markdown/` 拆成 `MarkdownView.tsx`（共用外壳，零重依赖）+ `MarkdownBase.tsx`
    （gfm/highlight/容器/rawHTML/heading/img）+ `MarkdownRich.tsx`（Base + KaTeX + mermaid），
    `index.tsx` 只做 `needsRichMarkdown(content)` 嗅探再用 `next/dynamic` 二选一。
  - mermaid 连 Rich 里也不静态引：`mermaidForViewer` 的 `viewerEffect` 先看有没有
    `.language-mermaid`，有才 `import("@bytemd/plugin-mermaid")`（数学文章的页面不会白背 mermaid）。
  - `components/MarkdownTocBar/tocMath.ts` 以前静态 import KaTeX（**这是首页 275KB 的真凶**，
    因为 PostCard → TocMobile/TocDrawer → MarkdownTocBar → tocMath），改成 `ensureTocMathLoaded()`
    动态 import + `onTocMathReady()` 订阅，`core.tsx` 用 `mathTick` state 触发重渲染。
  - **列表页只用轻量渲染器**：PostCard 的摘要走 `dynamic(() => import("../Markdown/MarkdownBase"))`；
    文章页/关于页把自己的 `dynamic(() => import("../Markdown"))` 通过新 prop `markdownRenderer` 传进来。
    ⚠️ **PostCard 里千万不能静态 import `../Markdown`**：实测首页 First Load JS 从 286kB 涨回 432kB。
- 嗅探规则（`needsRichMarkdown`）：mermaid 围栏（带 `\b` 词边界，避免 ```mermaidx 误判）、`$$`、
  或行内 `$…$`（`$` 后不能是空白，和 remark-math 的规则一致）。**只判断「有没有 `$`」是不行的**：
  `$PATH`、`5$` 太常见，实测会让首页白背 KaTeX。已知可接受误判：同一行出现两个 `$`。
- 图片：正文图片由 `Markdown/img.tsx` 的 rehype 插件统一加 `loading="lazy"` + `decoding="async"`；
  封面（LCP）加 `fetchPriority="high"`；`ImageBox` 本来就有 lazy，补了 `decoding`（注意别重复声明 loading）。
- **静态资源缓存头**（server `utils/imgCompress.ts` 的 `applyStaticAssetHeaders`）：原来只有
  `Cache-Control: public, max-age=0`，等于每次翻页都重新问一遍。现在
  `<static>/img/**` → `public, max-age=3600, stale-while-revalidate=604800`（**不能写 immutable**：
  「替换图片」是同名覆盖），其余静态文件 → `public, max-age=300, must-revalidate`。
- `_app.tsx` 的访客统计（初始化 + 每次路由切换）挪进 `requestIdleCallback`，不和水合/导航抢主线程。
- `next.config.js`：`poweredByHeader:false`、`swcMinify:true`，并加了类型检查逃生口
  `VANBLOG_SKIP_TYPECHECK=true`（`isBuild=t` 时也放行，和官方镜像的构建命令一致）。
- **顺手发现：`next build` 在这个仓库里本来是失败的**（dev 不做全量类型检查所以看不出来），
  已修 5 处：`mermaidViewer.ts`（viewerEffect 参数缺 `file`）、`MarkdownTocBar/scrollToHeading.ts`
  （`Element` vs `HTMLElement`，把 `getEl` 收窄成 `HeadingLookup`）、`PageNav/a11y.ts`
  （`FocusableEl` vs `EventTarget`，`event.target as unknown`）、`WaLine/core.tsx`
  （`Record<string, unknown>` 展开污染对象字面量，加类型断言）、`api/getAllData.ts`
  （`SiteInfo` 缺 `uiStyle`，是我上一轮加皮肤时漏的）。`__tests__/*.spec.ts` 里还有约 27 处类型错误没动
  （不影响运行，只影响严格构建），所以留了上面那个开关。
- 实测（`next build` 的 First Load JS）：首页 432→**286 kB**、文章页 427→**281 kB**、
  关于页 430→**284 kB**、友链页 418→**172 kB**（−59%）、分类/标签/时间线 168 kB 不变；
  首页实际资源 26 个 / 原始 1541 KB / gzip 459 KB（原 1825 KB / 538 KB），KaTeX chunk 不再被引用。
  TTFB：首页与分类页 5–11 ms，时间线 ~140 ms。
- e2e 验证：数学文章（`class="katex"` SSR 出现 13 处）、临时冒烟文章（mermaid 代码块进 DOM、
  KaTeX 渲染、hljs 高亮、行号、复制按钮全在，且页面里没有内联 mermaid 源码）→ 测完已删文章；
  `/ /post/1 /about /timeline /category /link` 全 200。
- 文档：`docs/advanced/performance.md`（新页，含数据、原理和「别做的事」清单）；
  安全相关的用户文档在 `docs/advanced/security.md`（见 §7.11）。
- 测试：`packages/website/__tests__/perfBudget.spec.ts`(14，守卫懒加载结构、嗅探规则、图片属性、
  构建配置)、`packages/server/src/utils/staticCache.spec.ts`(4)。

### 7.11 全站 bug / 安全审计与修复（四路并行审计后的批量修复）

用四个只读审计代理分别查了「认证与权限」「文件与上传」「注入与数据暴露」「功能正确性」，
再逐条验证 + 修复。面向用户的说明在 `docs/advanced/security.md`，这里只记**改了什么、为什么**。

**注入 / 输入校验**
- 新增 `utils/sanitizeRequest.ts`：`stripOperatorKeys()`（递归删 `$*` / `__proto__` / `constructor` / `prototype`）
  + `asQueryString()`，在 `main.ts` 里 `app.use(sanitizeRequestPayloads)` 挂到所有路由之前。
  起因：项目**没有任何 ValidationPipe**，Express 的 qs 会把 `?category[$ne]=x` 变成对象直接进 Mongo 过滤器
  （实测 `?category[$regex]=客$` 能拿到全站文章正文，`?path[$ne]=` 能把 custompages 文档连 `$__`/`_doc` 一起吐出来）。
- `utils/regex.ts` 增加 `safeSearchPattern()`（转义 + trim + 200 字上限），接到**所有** `$regex` 站点：
  `article.provider` 的 searchByString / getByOption(tags,category,title) / searchArticlesByLink、
  `draft.provider` 同四处。实测修复前 `?value=(`、`[`、`*`、`a{2,1}` 全部 500；草稿搜索的
  `` `*${str}*` `` 更是**任何输入都非法**（`*` 开头 = nothing to repeat）。搜索另加 `maxTimeMS(5000)`。
- `searchByString` 的后置过滤改成 `String(value ?? '')`：`category` 没有 schema 默认值，
  老数据/JSON 导入的文章缺字段时 `.toLocaleLowerCase()` 会抛 TypeError → 整站搜索 500。
- 公开搜索**排除加密文章与加密分类**（`getPrivateCategoryNames()` + `$nin`）：否则可以拿候选词反复搜，
  看加密文章标题是否出现，一个词一个词把受密码保护的正文试出来。

**认证 / 权限**
- `LoginGuard` 重写：只统计**失败**（计数移到 controller：失败 `recordFailure()`、成功 `reset()`）、
  阈值读设置里的 `maxRetryTimes`/`durationSeconds`（原来写死 3/60）、没有设置行时**默认开启**（5 次 / 300 秒）、
  key 用新的 `pickSocketIp()`（原来用 `pickClientIp()`，它优先读 cf-connecting-ip/x-real-ip/XFF，
  客户端随便换一个头就能无限试密码，还能用受害者 IP 把对方锁死）。
  原来还在限流路径上 `await getNetIp()` → 每次登录都同步请求第三方 `cip.cc`，**没有超时**。
- `getNetIp()`：加 3 秒超时（`VAN_BLOG_IP_GEO_TIMEOUT`）、`VANBLOG_DISABLE_IP_GEO=true` 可完全关闭、
  IP 拼进 URL 前 `encodeURIComponent`（值来自请求头）。
- `validateUser()`：入参为空或算出的哈希为空、或库里存的哈希为空 → 直接失败。
  起因：`encryptPassword()` 任一入参为空返回 `''`，而旧 `updateUser` 会把 `''` 写进库 →
  **空密码可以登录**该账号。
- `updateUser()` / `createCollaborator()` / `updateCollaborator()`：校验用户名密码（1-50 / 1-200），
  只写白名单字段。旧实现 `{...dto}` 直接展开进 Mongo：`PUT /api/admin/auth` 能改自己的 `id`，
  建协作者时 `{type:'admin'}` 能覆盖掉前面的 `type:'collaborator'`（等于造第二个管理员）。
- `POST /api/admin/auth/restore`（忘记密码自救通道）同样校验：以前空密码会把账号写成空哈希，自救变自锁。
- `AccessGuard`：`!user` 与 `catch` 分支从 `return true` 改成 `return false`（失败关门）。
- `jwt.strategy`：协作者已删但 token 未过期时读 `user.permissions` 会 500 → 改成 401。
- 分类列表 `?detail=true` 对**协作者**脱敏 `password`（这个路由在 publicRoutes 里，任何协作者都能调，
  原来能读到所有加密分类的明文密码）。
- `caddy/ask`（on-demand TLS 回调，必须无鉴权）加白名单：`siteInfo.baseUrl` + https 设置 + 已登记 subjects，
  其余 403；`VANBLOG_CADDY_ASK_ALLOW_ALL=true` 可恢复旧行为。原来任何非 IPv4 域名都批准。
- 演示站（`demo:'true'`）补上缺失的写操作拦截：**管线 create/update/delete/trigger（fork 执行任意 JS = RCE）**、
  草稿增改删、customPage 上传、图片上传、ISR 触发/配置、旧版 JSON 备份导出。
- waline 启动日志不再整份打印 env（里面有 `MONGO_PASSWORD`、`JWT_TOKEN`＝本站 jwt 签名密钥、`SMTP_PASS`），
  改成敏感键打 `[REDACTED]`。
- `main.ts` 加 `process.on('unhandledRejection'/'uncaughtException')` 记录：Node 20 默认未处理 rejection 直接退出，
  项目里有大量 fire-and-forget 写库（每次页面浏览的计数、菜单清洗、sitemap…），一次 Mongo 抖动就能带走整个进程。

**上传 / 文件 / 静态服务**
- 新增 `utils/uploadLimits.ts`：`assertUploadedImage()`（按**内容**判定：魔数/image-size + 拒绝 SVG + 1 亿像素上限）、
  `safeImageExtension()`、`IMAGE_UPLOAD_OPTIONS`（50MB + 后缀过滤）、`CUSTOM_PAGE_UPLOAD_OPTIONS`（200MB）、
  `JSON_IMPORT_UPLOAD_OPTIONS`（200MB）。图床上传/替换/隐写检测三处 `FileInterceptor` 全部接上。
  起因（审计里最严重的一条）：图片接口以前**不校验内容**，上传 `evil.html` 时管线每一步失败都被 catch，
  原始字节被存成 `/static/img/<md5>.evil.html`，再被静态服务以 `text/html` **同源**返回 → 存储型 XSS →
  偷管理员 token → 管线接口 RCE。实测现在 html / 假 png 都 400，真 png 正常。
- `applyStaticAssetHeaders`：`nosniff` 覆盖**整个**静态目录（原来只在 `<static>/file/` 下），
  html/svg/js/css 等类型无论在哪个子目录都强制下载。
- 图片上传的 latin1 文件名（`decodeUploadFileName`）补到图片/自定义页面这条老路径（附件早就修了）。
- `deleteOneBySign(sign, staticType?)`：记录不存在时返回可读 400（原来 `.storageType` 空指针 500），
  并按 staticType 限定（图片与附件同内容同 sign 时会互相误删）；上传去重同样改成 `getOneBySignAndType(sign,'img')`。
- `deleteCustomPage` 用 `normalizeCustomPageRel()`：原来 `path.replace('/','')` 只去掉第一个斜杠且不查 `..`，
  配合 `rmSync(recursive)` 能递归删到静态目录外。
- `utils/webp.ts`：临时文件改 `mkdtempSync`（随机目录、0600、`wx`），并加 `finally` 清理。
  原来 `/tmp/temp${Date.now()}` 无 finally：压缩一失败整块 buffer 永久留在 /tmp（反复上传即可写满磁盘），
  同毫秒并发互相覆盖，`writeFileSync` 还会跟随符号链接。
- 「导出全部图片/附件」的归档从 `<static>/export/` 搬到 `config.backupPath/export/`，
  新增鉴权下载 `GET /api/admin/export/archive?name=`（basename + `export-` 前缀校验，下载后删除），
  后台两个入口改成 blob 下载（`services/van-blog/downloadArchive.ts`）。
  原来归档匿名可读、文件名只有日期（实测 `GET /static/export/export-file-<日期>.zip` → 200），
  而且 `ImgTab.jsx` 里 `link.href = data`（对象）等于**这个按钮一直是坏的**。
  `main.ts` 的匿名拒绝清单扩到整个 `/static/export/` + `/static/tmp/` + `/static/upload-tmp/`。
- 恢复上传的暂存目录从 `<static>/tmp` 搬到 `<backupPath>/upload-tmp`，并把整个 handler 包进 try/finally
  （演示站/confirm 校验提前 return/throw 时，multer 已经把几百 MB 落盘了）。

**SSRF**
- 新增 `utils/safeFetch.ts`：`fetchRemoteSafely()`（`maxRedirects: 0` + **每一跳重新 `assertSafeRemoteUrl`** +
  体积/超时上限）与 `detectImageByMagic()`/`assertImageBuffer()`。
  `markdownExport.provider.fetchRemote` 与 `static.provider.fetchRemoteImage`（转移外链图片 / 扫描文章图片）都换成它。
  起因：`assertSafeRemoteUrl` 只校验第一个 URL，而 axios 默认跟随 302 → 攻击者用自己的域名过检再跳
  `169.254.169.254`/`127.0.0.1:2019`，响应体被打进 zip 回传（**可读回显**的 SSRF，协作者即可调用）。

**备份 / 恢复（自己的功能，审计发现 4 处）**
- 空集合恢复：没有 `insertMany` 就不会创建 `*__vanblog_restore` 临时集合，`rename` 抛
  "Source collection does not exist" → **前面的集合已换、后面的原样不动**，变成看不懂的半恢复 + 500。
  现在 0 条时显式 `db.createCollection(tmpName)`。
- 恢复失败：`try/catch` 里 `tmp.drop()` 清残留，并抛 `BadRequestException`（带集合名）。
- 导出失败：删掉半成品归档（否则备份列表里会出现一个坏归档）、子进程 `SIGKILL`、`BadRequestException`；
  `tar` 退出码 1（"file changed as we read it"，`cp -al` 窗口里正好替换图片会碰到）不再当致命错误。
- 压缩/解压管道给 `compressor.stdin` / `tar.stdin` 挂 `error` 监听：压缩器被 OOM kill 时写 stdin 会 EPIPE，
  没有监听就是 unhandledRejection → 进程退出。
- `FullBackupProvider` 加 `serialize()` 串行队列：临时集合名固定、归档名只精确到秒，
  两个并发导出/恢复会互相截断却都返回"成功"。

**功能 bug（非安全）**
- `<pre>` 里没有 `<code>` 时 `codeBlock.tsx` 会在 `.properties` 上抛 TypeError → **整篇文章 SSR 500**，
  列表卡也跟着炸（正文里直接写 `<pre>纯文本</pre>` 就能触发，而 sanitize 白名单允许 pre）。
- `stripFrontMatter` 只在「每行都像 YAML」时才剥（`looksLikeYaml`）：原来只看 `---`，
  正文以分隔线开头、后面又有一条分隔线时，**中间的标题和第一段会被整段删掉**（文章页/摘要/RSS 都受影响）。
  这是上一轮 §7.9 我自己引入的，审计抓出来了。
- 前台「编辑」按钮：`props.id` 现在是拼音别名，后台编辑器只认数字 id → 打开空编辑器 + "无效的文档 ID"。
  新增 `numericId` prop（4 个调用点已传），只给编辑链接用，链接/复制仍是别名。
- `utils/auth.ts checkLogin()` 第一行就 `return true`（真判断是死代码）→ 匿名访客也能看到「编辑」按钮。
- `batch.ts batchDelete`：`fn(id).finally()` 把失败也计数 → token 过期/500 时同时弹「登录失效」和「批量删除成功！」，
  实际一条没删；空选择还永远不 settle。改 `Promise.allSettled`。
- 标签/分类/打赏的重命名与删除 URL 未编码：标签叫 `C#` 时 DELETE 变成 `/api/admin/tag/C`，
  **改到/删掉另一个标签**，界面还提示成功。四处都加 `encodeQuerystring`。
- 列表排序加唯一 tiebreaker（`{viewer:-1}` → `{viewer:-1, id:-1}`）：Mongo 排序不稳定，翻页会重复+漏行。
- `POST /api/public/viewer`：缺 Referer 时 `new URL(undefined)` 抛错 → 未鉴权接口 500（每次页面浏览都调）；
  现在 try/catch + 回落 query.path + 500 字限长。
- `customPage` 公开接口：`{...mongooseDoc}` 会把 `$__`/`$isNew`/`_doc` 吐给公网，改成只返回 name/path/type/html；
  `?path[$ne]=x` 由 500 变 404。前台拼 URL 补 `encodeURIComponent`。
- 草稿 `publish()` 空值检查（双击发布 → 第二次 `draft.title` TypeError → 500）。
- `setting.provider` 里 `const toInsert = defaultMenu` 会**就地修改导出常量**（init 之后拿到的默认菜单是被改过的）。
- RSS `language: '\tzh-cn'` 里有个真制表符 → feed 校验不通过。
- markdown 图片 `className += " img-zoom"` 在 className 不存在时得到 `"undefined img-zoom"`。
- `importArticles` / `importDrafts` / `importItems` 三处未 await 的写操作：失败即 unhandledRejection → 进程退出；
  `importItems` 的更新文档还写成 `{ each }`（非原子操作符，mongoose 静默剥成 `{}`，重复导入永远不更新）。

**审计发现但本轮未修（记下来别忘）**
- 计数（viewer/visited）是读-改-写而非 `$inc`，`visits` 表 `(date,pathname)` 没有唯一索引 → 并发首日访问会写重行、少计数。
- 拼音别名上线后 `/post/<id>` 与 `/post/<slug>` 都返回 200 且无 canonical/redirect，访问量按 pathname 分家；
  公开列表接口 `pageSize=-1` 会把全部文章正文一次拉走（前端静态生成也依赖它，不能简单封）。
- `getNewId()` 的 idLock 提前释放且不是异常安全的（并发新建可能撞唯一索引；`find()` 抛错后锁永远不释放）。
- 管线执行没有超时/`error`/`exit` 监听 → 脚本不发消息就让**保存文章**永久挂住；`spawnSync('pnpm','add')` 阻塞事件循环。
- 改任意站点信息都会重启整个前台进程（`websiteProvider.restart`），且 `run()` 没有并发保护。
- 「本地化远程图片」的 `extractImageRefs` 没有屏蔽代码块（导出那条路径有 `maskCodeRegions`）→ 会改坏文档里的示例；
  `parseImgLinksOfMarkdown` 会把 alt 文本当成链接（导致误报失效图片 + 写入垃圾 statics 记录）。
- 前台：TOC scroll-spy 闭包过期（客户端跳转后高亮/地址栏是上一篇的标题）、缺文章时返回 200 软 404 并污染 ISR 缓存、
  `getArticles.ts` 手拼查询串未编码（标签 `C++` 会显示"此标签不存在"）、`/page/abc` 渲染成第 1 页、
  多处 `.then(setLoading(false))` 没有 catch → 失败后转圈卡死、`pages/api/revalidate` 没有 secret（独立部署 website 镜像时可达）。
- 安全侧遗留：文章/分类密码明文存储且 `==` 比较、解锁接口无次数限制；管理员口令是 sha256 套 sha256（非 bcrypt/argon2）；
  除登录外无全局限流；`/swagger` 公开；没有全局 ValidationPipe（当前净化中间件是黑名单不是白名单）；
  `init` 接口无守卫（靠"库里有没有用户"判断）；API token 有效期 100 年。
- `next build` 仍有约 27 处 `__tests__/*.spec.ts` 里的类型错误（不影响运行），所以留了 `VANBLOG_SKIP_TYPECHECK`。

### 7.12 一键脚本 `scripts/vanblog.sh` 体检与修复（v0.3.6 → v0.3.7；安装来源的改动见 §7.12.1）

这个脚本是用户 `curl | bash` 装的入口（**两份副本必须一致**：`scripts/vanblog.sh` 与
`docs/.vuepress/public/vanblog.sh`，后者才是文档站真正下发的文件），它下载
`docker-compose/docker-compose-template.yml` 并替换占位符来起容器。逐条查下来有这些问题，都已修：

- 🔴 **`docker-compose down -v` 出现在 restart / stop / update / restore 四条常规路径上**。
  `-v` 会删除编排里的卷：当前模板用的是 bind mount 所以侥幸没炸，但很多人会把 compose 改成命名卷
  （官方文档也这么教），那时「重启」= 删库，「更新」= 删库，**恢复备份时也会先删一次卷**。
  现在常规路径统一 `down --remove-orphans`，只有卸载（有二次确认）保留 `-v`。
- 🔴 **`backup()` 不检查 tar 退出码**，失败也打印「备份成功」；`restore()` 同样如此，而且
  不校验文件是否存在/是否完整 gzip、**没有二次确认**、路径不加引号（带空格就炸）、
  输入为空时 `exit 1` 直接退出整个脚本。两个函数都重写了：
  - `backup`：GNU tar 加 `--warning=no-file-changed`，退出码 1（"file changed as we read it"，热备份的正常现象）
    容忍但会提示，≥2 判失败并删掉半成品；打印体积；新增 `--consistent`（先 `compose stop mongo`、
    打包完再 start）与环境变量 `VANBLOG_BACKUP_CONSISTENT=1` 供定时任务使用。
  - `restore`：`gzip -t` 先验完整性 → 二次确认（`VANBLOG_ASSUME_YES=1` 跳过）→ 停服务 → 解压（失败即返回 1，
    不再谎报成功）→ **删掉 `mongod.lock`**（热备份的产物，不删 mongod 会拒绝启动、容器反复重启，
    §4.3 手工流程里也写了这一步，脚本却一直没做）→ 询问是否立即启动；
    支持 `VANBLOG_RESTORE_FILE=` 与位置参数，非交互可用。
- 🟠 **`chmod 777 -R $VANBLOG_DATA_PATH`**：这个目录里有 MongoDB 数据文件、图床内容，
  以及 **caddy 的证书私钥**，宿主机上任何用户都能读。改成 755（容器内是 root，够用）。
- 🟠 **docker-compose 别名会覆盖用户已装的 docker-compose**：旧逻辑只要 `docker compose` 可用就无条件
  `echo > /usr/local/bin/docker-compose`。改成「只在 `command -v docker-compose` 失败时才建」，
  并且两者都没有时明确报错返回，而不是继续往下走到一堆看不懂的报错。别名脚本本身也修了
  （`docker compose $@` → `docker compose "$@"`，带空格的参数以前会被拆词）。
- 🟠 **`update()` 把「已经是最新版」报成红色"更新失败"**（镜像 id 没变就判定失败并返回 1），
  自动化里会误告警。现在返回 0 并提示「已经是最新版本（版本号），容器已重启」；
  真正的拉取失败在 `pull` 那一步就已经拦下。
- 🟡 **`config()` 会用模板覆盖 `docker-compose.yaml`**，用户自己加的 `environment`（CDN 前缀、
  备份目录等）和卷映射**静默丢失**。现在覆盖前先存一份 `docker-compose.yaml.bak-<时间戳>` 并提示。
  同时补了输入校验：邮箱格式（要拿去申请证书）、端口必须是 1-65535 的数字；
  `sed` 分隔符从 `/` 换成 `|`（邮箱里出现 `/`、`&` 时旧写法会截断或展开）。
- 🟡 路径变量改成可被环境变量覆盖（`VANBLOG_BASE_PATH` / `VANBLOG_DATA_PATH` / `VANBLOG_DATA_PATH_RAW`，
  默认值不变），既是测试需要，也方便把安装目录放别处。
- 🟡 **运行镜像里没有 `zstd` / `xz`**：后台「整站备份」默认选 `zstd -19`，其次 `xz`，最后才 `gzip`，
  探测不到就静默降级 → 用户以为在用高压缩。Dockerfile 运行阶段已加 `zstd xz`（`tar` 用 busybox 自带的够了）。
- 🟡 编排模板补了注释掉的可选环境变量：`VAN_BLOG_BACKUP_PATH`、`VANBLOG_BACKUP_ZSTD_LEVEL`、
  `VAN_BLOG_REVALIDATE(_TIME)`、`VANBLOG_DISABLE_IP_GEO`、`VAN_BLOG_IP_GEO_TIMEOUT`、
  `VANBLOG_CADDY_ASK_ALLOW_ALL`（都是 §7.6/§7.11 新增的开关，以前用户只能手改 compose，
  然后被 `config` 覆盖掉）。
- 核对过**没问题**的部分：`backup`/`restore` 的路径拼接是对的（`cd $BASE && tar ./data` 正好等于
  `$DATA`，因为 `DATA=$BASE/data`）；卸载流程会保留 `vanblog-backup-*` 并拒绝删除无效数据目录；
  `reset_https` 那套 caddy/JSON 清理逻辑；下载回退（文档站 → GitHub raw → jsDelivr）与自更新。
- 测试：新增 `scripts/tests/vanblog-backup-restore.test.sh`(34 条)，用假的 `docker`/`docker-compose`
  记录调用 + **真实 tar** 跑完整的「备份 → 改数据 → 恢复 → 校验还原/删锁/自动启动」往返，
  并断言常规路径不再出现 `down -v`、`chmod 777` 已消失、两份脚本一致、模板与 Dockerfile 已同步。
  既有的 `vanblog-update.test.sh` / `vanblog-download-fallback.test.sh` 按新语义更新
  （「已是最新」返回 0；沙箱里补一个假的 docker-compose，免得脚本去写 `/usr/local/bin`）。
  七个脚本测试文件共 **259 条断言全绿**。

### 7.12.1 一键安装改成「装本分支源码构建的镜像」（v0.3.7 → v0.4.0）

脚本以前拉的是官方镜像 `mereith/van-blog:latest`，也就是**上游 master**，本分支的改动一个都不在里面；
README 里的 curl 也指向作者的文档站与上游 raw。本分支没有发布镜像，所以改成：

```
克隆 https://github.com/CKboss/vanblog.git 的 dev/dsh（浅克隆到 <安装目录>/src）
  → docker build -t vanblog:dev-dsh（--build-arg VAN_BLOG_VERSIONS=<branch>-<shortsha>）
  → 编排文件里的 image: 用这个本地 tag
```

- 新增可调项（都能用环境变量覆盖）：`VANBLOG_REPO` / `VANBLOG_BRANCH` / `VANBLOG_SRC_DIR` /
  `VANBLOG_IMAGE_TAG` / `VANBLOG_USE_UPSTREAM_IMAGE`（设 `true` 回到官方镜像）/ `VANBLOG_BUILD_SERVER`。
- `update` 在源码模式下是「fetch + `checkout -f FETCH_HEAD` + 重新 build」，**不是 `docker pull`**；
  构建失败会保留旧镜像并把容器起回来，不会让更新变成停机。
  用 `checkout -f FETCH_HEAD` 而不是 `pull`：源码目录只当构建缓存，有本地改动时 pull 会卡住；
  `git clean -fdq` 只在源码目录是默认的 `<base>/src` 时才做（用户指到别处就不能乱删）。
- 编排模板优先用**源码里那份**（含本分支新增的可选环境变量注释）；下载回退顺序改成
  本分支 raw → 上游文档站 → 上游 GitHub raw → jsDelivr（`vanblog-download-fallback.test.sh` 的
  URL 顺序断言也跟着改成 4 个）。
- `Docker_IMG` 不再转义斜杠，写入编排文件的 `sed` 分隔符从 `/` 换成 `|`，
  这样自定义 tag（如 `ckboss/vanblog:dev-dsh`）也不会被截断。
- 卸载会把源码目录一起删掉（仅限「在安装目录下且确实是 git clone」的那种，防止误删用户目录）。
- ⚠️ 两份脚本副本必须**逐字节一致**（多个测试用 `cmp -s` 盯着）：改完记得
  `cp scripts/vanblog.sh docs/.vuepress/public/vanblog.sh`。
- 测试：新增 `scripts/tests/vanblog-source-install.test.sh`(41，假的 git/docker/docker-compose，不联网)，
  覆盖默认值、克隆与更新两条路径、构建参数、缺 Dockerfile、构建失败返回非 0、
  官方镜像模式完全不碰 git/docker、编排文件写入本地 tag（含带斜杠的 tag）、
  `ensure_compose_image` 改写旧镜像行、有源码时不再联网下模板、卸载清源码目录。
  `vanblog-download-fallback.test.sh` 与 `vanblog-update.test.sh` 的 harness 里必须设
  `VANBLOG_USE_UPSTREAM_IMAGE=true`，否则用例会去真克隆/真构建而**挂住**（踩过，一次 7 分钟超时）。
- 脚本测试总量：8 个文件 / 304 条断言全绿。

### 7.13 后台（packages/admin）性能优化

先量后改：`umi build` 出 dist **27MB**，`umi.js`（每个页面都要下载的入口）**1133KB**，
编辑器路由包 ~1748KB（里面塞着 KaTeX 和 emoji 全量数据），dist 里还躺着**三份 mermaid**（5.6MB）。

- **35 个文件从 `@ant-design/pro-components` 桶式导入改成具体包**（pro-table / pro-form / pro-layout /
  pro-card / pro-descriptions）。桶会把没用到的 ProList、ProDescriptions 等一起拖进来。
  映射时注意：`EditableProTable`/`ActionType`/`ProColumns` 在 **pro-table**，
  `ModalForm`/`StepsForm`/`ProFormXxx` 在 **pro-form**，`StatisticCard` 在 **pro-card**，
  `PageContainer` 在 **pro-layout**；`Modal` 其实该从 antd 来；
  `useRefFunction` 是 pro-utils 的内部 hook（没有独立依赖），在 `DataManage/tabs/Menu.tsx` 里就地实现了。
- **编辑器 KaTeX 按需**：删掉 `import math from '@bytemd/plugin-math-ssr'` 与 `import 'katex/dist/katex.css'`，
  改成 `hasMath`（与前台同一套嗅探正则）为真时 `Promise.all([import(...), import('katex/dist/katex.css')])`
  → `setMathPlugin`，插件数组里用 `...(mathPlugin ? [mathPlugin] : [])` 展开，
  **`useMemo` 依赖数组必须带上 `mathPlugin`**（漏了就一直不刷新）。
- **表情选择器按需**：`components/Editor/emoji.tsx` 以前在 `editorEffect` 里就把 Picker 渲染好（CSS 藏起来），
  等于每次打开编辑器都下载 `@emoji-mart/data`。现在 `editorEffect` 只建容器 + 记住 `ctx.editor`，
  **首次点击**才 `ensurePicker()`（三个 `import()` 并行，成功后打 `data-emoji-ready` 标记，失败要把
  `pickerPromise` 置回 null，否则再点没反应）。
- **mermaid 只留一条加载路径**：`plugins/mermaidSafety.ts` 的 `importMermaidModule()` 原来有三个回退
  （`mermaid.min.js` / `mermaid.js` / `mermaid`）——**webpack 会给每个 `import()` 各打一份产物**，
  所以 dist 里有三份 mermaid；而第三个走的正是文件注释里写明会导致 #391 崩溃的 core ESM 入口。
  mermaid 版本锁死 10.6.1，`dist/mermaid.min.js` 必然存在，回退纯属负担，已删。
- **首页三个统计 tab 改 `React.lazy` + `Suspense`**：它们都 import `@ant-design/plots`（G2），
  静态导入会让「一进后台」就下载三份图表代码，而用户一次只看一个 tab。
- **`targets: { ie: 11 }` → `{ chrome: 80 }`**：IE11 目标会把大量 core-js polyfill 打进 `umi.js`。
- **图片管理页**：网格与列表的 antd `<Image>` 加 `loading="lazy"` + `decoding="async"`（一页最多 60 张）。
  网格本来就用 `getThumbLink()` 缩略图、点开预览才拉原图（§7.5），这次只是补上懒加载。
- 实测结果：dist 27MB → **24MB**；`umi.js` 1133KB → **1077KB**；编辑器路由首包 ~1748KB → **~911KB**，
  KaTeX(280KB)/emoji(81KB)/mermaid(2.8MB) 各自独立成按需 chunk；`/admin`、`/admin/editor`、
  `/admin/article`、`/admin/static/img`、`/admin/welcome` 全部 200，webpack 编译无错。
- 本来就已经开着、**别关**的：`dynamicImport`（路由分包）、`hash`、`ignoreMomentLocale`、`esbuild`、
  `mfsu` + `webpack5`（dev 编译加速）、`nodeModulesTransform: none`、`exportStatic`。
- 测试：`packages/admin/tests/unit/adminPerf.test.js`(8) —— 钉死「不许再出现 pro-components 桶导入」
  「KaTeX/emoji/mermaid 必须动态导入且只有一处」「首页 tab 必须 lazy」「targets 不许回到 ie:11」
  「图片必须 lazy+async」。注意断言要**排除注释**（注释里会写旧写法，否则自己匹配自己）。
- 文档：`docs/advanced/performance.md` 新增「后台管理界面」一节（含前后对比表）。

### 7.14 补齐 6 种 markdown 语法（两边同时加，用标准插件）

用户要求把「两边都缺」的语法补上，并且要用最标准/最新的插件。实现落在**两份必须一致**的文件里：
`packages/website/components/Markdown/extraSyntax.ts` 与
`packages/admin/src/components/Editor/plugins/extraSyntax.ts`（后者只把前台的
`normalizeHeadingText` / `headingHashHref` 换成本地等价实现）。

- **版本选择**：bytemd 1.21 锁 unified 10 / remark-parse 10 / mdast v3，所以只能用同一世代的插件
  （更高大版本已经是 mdast v4 / unified 11）：`remark-supersub@1`、`remark-gemoji@7`
  （package.json 明确 peer `unified ^10`、`@types/mdast ^3`）、`remark-definition-list@1`
  （micromark-extension-definition-list 1 = micromark 3 世代）、
  `remark-github-blockquote-alert@2`、`micromark-extension-mark@1` + `mdast-util-mark@1`、
  `mdast-util-toc` 未采用（见下）。两个包都装了**同样的 7 个依赖**。
- **`==高亮==`**：npm 上的 `remark-mark` 是 `0.0.0` 占位包，不能用；正确做法是自己按 remark 插件的
  标准写法把官方的 micromark/mdast 扩展对拼起来（和 remark-gfm/remark-math 一样）。
  ⚠️ 导出名不是 `mark`：是 `pandocMark` / `pandocMarkFromMarkdown` / `pandocMarkToMarkdown`，
  而且它们是**扩展对象不是工厂函数**（micromark 那个两种形态都可能，所以按 `typeof` 判断）。
- **踩坑：data 字段名**。unified 10 世代的 remark-parse 读的是 `fromMarkdownExtensions` /
  `toMarkdownExtensions`；写成 remark 15 的 `mdastUtilFromMarkdownExtensions` **不会报错、只会静默失效**
  （表现是 `==高亮==` 变成纯文本，`==` 被吃掉）。`remark-definition-list` 的源码可以当参照。
- **定义列表**：mdast 节点是 `defList` / `defListTerm` / `defListDescription`，remark-rehype 不认识，
  必须把官方 handler 传进去：`remarkRehype={{ allowDangerousHtml: true, handlers: defListHastHandlers }}`
  （前台在 `MarkdownView.tsx`，后台在 `Editor/index.tsx`）。不传的话会被当未知节点摊成
  `<div><div>术语</div>…</div>`。
- **`~x~` 冲突**：GFM 的删除线默认吃单波浪，`remark-supersub` 的下标抢不到（**插件顺序换过来也没用**，
  实测两种顺序都是 `<del>`）。解法是 `gfm({ singleTilde: false })` —— `@bytemd/plugin-gfm`
  会把除 `locale` 之外的选项**原样转发给 remark-gfm**（看它的 `index.d.ts` 就知道），所以不用换掉插件。
  **这是行为变更**：单个 `~x~` 从删除线变成下标，删除线要写 `~~x~~`（本来就是 GFM 标准写法）。
  文档里单独开了一节说明。
- **`[[toc]]`**：标准的 `remark-toc` 只认**标题**形式的标记（`## 目录`），不认 `[[toc]]`；
  而且它用 github-slugger 生成锚点，与本站标题 id 规则（`normalizeHeadingText` 原文）对不上，
  链接会点不动。所以自己实现：扫描顶层段落找 `[[toc]]`/`[toc]`，用与 Heading 插件**同一个**
  `headingHashHref()` 生成锚点，产出标准的嵌套 `list`/`listItem`/`link` mdast 节点。
  没有标题时直接删掉标记；后台预览里点不动（预览的标题只有 `data-id` 没有 `id`），已写进文档。
- **sanitize 白名单**：两份 schema 都加了 `mark` / `dl` / `dt` / `dd`（GitHub 默认表里没有 `mark`）。
  **故意不放行 `svg`**：提示块插件的标题图标是内联 `<svg>`，会被剥掉，改用
  `styles/markdown-extra.css` 的 `::before` 画等效图标 —— 放行 svg 等于给正文多开一个 XSS 面。
- **样式**：`remark-github-blockquote-alert/alert.css` + 自己的 `markdown-extra.css`
  （前台在 `pages/_app.tsx` 引入，后台在 `Editor/index.tsx` 引入；两份 css 内容一致）。
- 实测（建临时文章 → 抓 `/post/syntax-check` → 删文章）：`<mark>`、`<sup>`、`<sub>`、`<del>`、
  😄/🚀、`<dl><dt><dd>`、`markdown-alert-note`/`-warning`、`[[toc]]` 生成的嵌套列表与锚点全部正确。
- ⚠️ **这批依赖把后台的 MFSU 打挂了**（加完插件后 3002 整页白屏，浏览器报
  `ScriptExternalLoadError: timeout /mf-va_remoteEntry.js`，dev 日志里是
  `AssertionError: filePath not found of remark-github-blockquote-alert`）：
  umi3 的 MFSU 用老版 resolve 解析裸包名，遇到**只有 `exports` 没有 `main`** 的 ESM 包就拿不到
  filePath（`remark-supersub`、`remark-github-blockquote-alert` 都是）。
  试过改成子路径导入 `pkg/lib/index.js` —— **也不行**：webpack 5 会按 `exports` 映射校验，
  而 `./lib/index.js` 没被 export，报 Module not found。MFSU 又没有 exclude 选项
  （只有 output/mfName/exportAllMembers/chunks/ignoreNodeBuiltInModules），
  **最终解法是 pnpm patch**（`patches/remark-supersub@1.0.0.patch`、
  `patches/remark-github-blockquote-alert@2.1.0.patch`，在根 `package.json` 的
  `pnpm.patchedDependencies` 里登记）：只给这两个包补上 `main`/`module`（`exports` 优先级更高，
  正常解析行为完全不变），MFSU 就能解析了 —— 现在 `mfsu: {}` 重新打开，dev 冷启动仍是 ~25s。
  复现命令：`pnpm patch <pkg>@<ver>` → 改临时目录里的 package.json → `pnpm patch-commit <dir>`。
  ⚠️ **升级这两个包会让 patch 失效**（pnpm install 会明确报错），届时重新 patch 一次，
  或者临时把 `mfsu` 设成 `false`（代价：dev 冷启动 ~2min；生产构建 `umi build` 不用 MFSU，不受影响）。
  无论怎么改，都要 `rm -rf packages/admin/src/.umi/.cache` 再重启，否则坏的预打包产物会被继续复用。
  实测：MFSU `Compiled successfully in 1.42m`、`mf-va_remoteEntry.js` 200（218KB）、
  `/admin` 与 `/admin/editor` 200、生产构建 exit=0（dist 24MB / umi.js 1078KB，与关 MFSU 时一致）。
- 测试：`packages/website/__tests__/extraSyntax.spec.ts`(15，**用真实管线渲染**逐项断言 + 两份文件
  的插件链/字段名/sanitize/CSS 一致性)，`markdownConsistency.test.js` 增加 `extraSyntax()`、
  `singleTilde: false`、`handlers: defListHastHandlers` 的比对。
- 文档：`docs/features/markdown.md` 把这 6 项从「不支持」挪到「支持」，新增「单个 `~` 的行为变化」
  「用的是哪些插件」两节，以及提示块图标与预览 TOC 的说明。

### 7.15 第二轮清理：性能 + 审计遗留项

接着 §7.10（性能）与 §7.11（审计）往下做，把「未修清单」里能低风险拿下的都清了。

**前台（website）**
- **真 404**：`/post/<不存在>` 与 `/page/abc`、`/page/0`、`/page/999` 以前都返回 **200 + 软 404**，
  既骗搜索引擎，也会在后端抖动时把 ISR 缓存里的好页面替换掉。现在 `getStaticProps` 返回 `notFound: true`；
  `api/getArticles.ts` 里区分「后端 404（确实没有）」与「后端 5xx/网络错误（抛出去，让 ISR 保留旧页面）」。
- **参数编码**：`getArticlesByOption` 原来手拼 `k=v&` 再用只转义 `#`/`/` 的 `encodeQuerystring`，
  于是分类名 `a&b` 变成 `category=a`、标签 `C++` 被服务端按空格解出来 → 标签页显示"此标签不存在"。
  统一改 `URLSearchParams`；`api/search.ts` 的搜索词加 `encodeURIComponent`（搜 `C#` 以前等于搜 `C`）；
  文章 id 加 `isSafeArticleParam()`（Next 会把 `%2F` 解码成 `/`，拼进后端 URL 就能打到 `/api/admin/**`）。
- **ISR 触发地址**：server 侧原来是 `encodeURI(base + url)`，而 `encodeURI` **不编码 `#`**，
  文章别名里允许 `#` → 增量渲染悄悄失败。改成 `URLSearchParams`，并支持 `VAN_BLOG_REVALIDATE_SECRET`；
  `pages/api/revalidate.ts` 增加路径校验（必须 `/` 开头、禁 `..`、禁 `//`、禁协议、禁控制字符、限长）
  与可选密钥（单独部署 website 镜像时这个路由是公网可达的）。
- **封面 preload**：文章页给封面加 `<link rel="preload" as="image">`（它是 LCP 元素）。
- **百度统计** 改 `strategy="lazyOnload"`（GA 本来就有 strategy）。
- **摘要截断**：`<!-- more -->` 出现在围栏代码/行内代码里时不再当截断标记
  （`findMoreMarker()`，教程类文章以前会被截成半个代码块，把后面的内容全吞掉）。
- **TOC scroll-spy 闭包过期**：滚动监听只注册一次（`[]` 依赖）却闭包了 `items`，
  客户端从文章 A 跳到 B 后仍用 A 的标题 → 高亮错行 + 每次滚动把地址栏 hash 改成 A 的标题。
  改成 `itemsRef` + 卸载时 `throttle.cancel()`。
- **AuthorCard 的 headroom 泄漏**：`useEffect` 没有依赖数组也没有清理，每次渲染都新建实例 + 再挂一个
  scroll 监听。改成有依赖 + 清理。
  ⚠️ **清理里绝对不能直接调 `headroom.destroy()`**（第一版就是这么写的，结果「一滚动就报错」）：
  headroom 0.12 的 `init()` 把 `scrollTracker` 的创建放在 `setTimeout(…, 100)` 里（等浏览器恢复滚动位置），
  所以「刚 init 就 destroy」时 `this.scrollTracker` 还是 `undefined`，`destroy()` 会抛
  `TypeError: Cannot read properties of undefined`；React 18 StrictMode 的「挂载 → 立刻清理 → 再挂载」
  正好命中这个窗口，而清理函数里抛错会冒到 commit 阶段。另外 `destroy()` 会把 `classes` 里所有类名
  （`side-bar` 等）从元素上摘掉，StrictMode 下新实例挂在**同一个元素**上，旧实例的延迟清理会把新实例
  刚加的类一起删掉。所以现在统一走 `utils/headroom.ts` 的 `stopHeadroom()`：只停 `scrollTracker`
  （try/catch 包住），并在 250ms 后补一次，覆盖那个 100ms 竞态。`NavBar` 的同类用法也一起换了。
  ⚠️ 这次还漏了 `AuthorCard` 的 `import`（浏览器里直接 `ReferenceError: stopHeadroom is not defined`）：
  插 import 的判断写成了 `if 'utils/headroom' not in s`，而我自己的注释里就有 "见 utils/headroom.ts"
  → 条件不成立、import 被跳过；而 **vitest 走 esbuild 不做类型检查**，463 个测试全绿也发现不了。
  教训：脚本化改代码时（1）插入 import 的判断要针对 **import 语句本身**，别拿标识符名去 `in` 整个文件；
  （2）改完必须跑一次 `tsc --noEmit`（或 `next build`），单测绿不等于能跑；
  （3）测试里断言「用了某个 helper」时，顺手断言它的 import 也在。

**服务端（server）**
- **流水线不会再卡死保存**：`runCodeByPipelineId` 的 Promise 只监听 `message`，脚本不发消息
  （死循环 / await 卡住 / `<codeRunner>/<id>.js` 被删导致子进程起不来）就永远 pending，
  而 `dispatchEvent` 是被 `await` 的 → **保存任何文章都永久挂住**。现在加了 30s 超时
  （`VANBLOG_PIPELINE_TIMEOUT_MS`）+ `error`/`exit` 监听 + SIGKILL。
  `addDeps` 的 `spawnSync('pnpm','add')` 改成异步 `spawn`（同步等待会把事件循环卡死十几秒，
  和 §7.6 备份踩的是同一个坑），并校验依赖名不以 `-` 开头（参数注入）。
- **`getNewId()` 的锁**：4 个 provider 都补了 `try/finally`。以前 `find()` 抛一次错，
  `idLock` 就永远是 `true`，之后所有新建请求都在 `while (this.idLock) await sleep(10)` 里空转，
  只能重启进程。
- **计数改原子 `$inc`**：`meta.addViewer`（每次页面浏览都调）与 `visit.add` 原来是「读出来 +1 再写回」，
  并发下互相覆盖、永久少算。`visit.add` 先试原子 `$inc`，当天没记录才按上一天的累计值建新行，
  并对并发建行做了 E11000 回退。
- **改站点信息不再无条件重启前台/评论**：`websiteProvider.restart()` 先算一遍 `loadEnv()` 与上次比对，
  一样就跳过（`stop()` 会杀进程组再由 exit 钩子拉起 next，期间公网是 down 的；改个站点描述不值得停站）；
  `run()` 加了并发保护（重叠的 restart 会 spawn 两个 next 抢 3001）。`walineProvider.restart()` 同理比对 env。
- **图片链接解析**：`parseImgLinksOfMarkdown` 原来遍历**每个捕获分组**、只用 `includes('http')` 过滤，
  于是 `![参见 https://docs…](https://cdn/real.png)` 会把 **alt 文本**当链接、`![a](url "title")` 会返回
  `url "title"`、代码块里的示例也算 —— 失败的被报成「文章里有失效图片」，成功的还往 statics 插垃圾记录。
  改成只取 URL 分组 + 用 `maskCodeRegions` 跳过代码区。`transferRemoteImages.extractImageRefs`
  同样加代码区屏蔽（「本地化远程图片」以前会改坏教程里的示例）。
- **`markdownExport`**：`\bsrc=` 会匹配到 `data-src`（懒加载占位图被当成真图，真 src 反而没改，
  导出的 mdz 离线打开是坏图）→ 改 `(?<![-\w])src`；`decodeURIComponent` 遇到 `%zb` 会抛 URIError
  让整个导出 500 → 统一走 `safeDecodeURIComponent`。
- **`backupCodec`**：`{$date: "乱七八糟"}` 不会抛错只会得到 Invalid Date，被当 1970 写进库、
  再次编码时又抛 RangeError → 现在回落到 `NOT_EXTENDED_JSON`（保持原样）。
- **加密文章解锁限流**：`POST /api/public/article/:id` 是明文比较且完全公开，可以无限速爆破。
  新增 `utils/attemptLimit.ts`（内存计数，同 IP + 同文章 10 分钟 20 次，成功即清零）→ 429。
- **Swagger 可关**：`VANBLOG_SWAGGER=false`（默认仍开启，保持既有行为）。

**后台（admin）**
- **转圈卡死一族**：`Welcome/tabs/{overview,viewer,article}.jsx`、`components/UpdateModal`、
  `pages/Code`（含 Ctrl+S 路径）、`SystemConfig/tabs/Backup.jsx`（旧版 JSON 导出用了
  `skipErrorHandler`，全局 handler 会把错误抛回来）、`SystemConfig/tabs/ImgTab.jsx` 的扫描按钮
  都是 `.then(() => setLoading(false))` 或空 `catch`：请求一失败（401/500/离线）loading 永远不清，
  而且 UpdateModal 失败会让**编辑器整页冻住**（Spin 是 Editor 注入的）。
  统一改成 try/catch/finally，并新增共享helper `services/van-blog/requestError.js` 的
  `reportRequestError(messageApi, err, fallback)`：只在全局 errorHandler **没有**提示过服务端消息时
  才补一条兜底提示（复用已有的 `shouldShowRequestError`），避免双重弹窗。
- **顺带发现一个真 bug**：`ImgTab.jsx` 用了 `saveExportArchive` 却**没有 import**
  （上一轮 §7.11 我改导出下载时，插入 import 的 `if` 判断没断言替换成功，静默失败了）→
  「导出全部本地图床内容」按钮一直抛 ReferenceError。**教训：用脚本改代码时，
  `s.replace()` 之后要断言确实变了，不能只 `if ... in s`。**
- `LogoutButton`：登出返回 401（token 已失效）时既不跳转也不清 localStorage → 半登录状态。
  现在无论如何都清 token + 跳转。
- 深链与 umi `base:'/admin/'`：`Welcome/tabs/viewer.jsx` 写 `<Link to="/admin/site/setting">`
  会渲染成 `/admin/admin/...`（catch-all 404）；`Article/columns.jsx` 与 `Editor/index.jsx`
  推的 `?subTab=layout` **没人读**（SystemConfig 读 `tab`，SiteInfo 读 `siteInfoTab`）→
  统一改成 `/site/setting?tab=siteInfo&siteInfoTab=layout|more`。
- `DataManage/tabs/Tag.jsx`：任何搜索都会把列表替换成 `[{key:input,name:input}]`，
  凭空造出一个不存在的标签，它的重命名/删除在服务端 no-op 却提示成功 → 改成对真实列表做模糊过滤
  + `locale.emptyText`。
- `services/van-blog/useNum.js`：三个 Welcome tab 都不传 token → 全部落到同一个
  `van-blog-admin-num-undefined`，在「概览」改近 30 天会**悄悄改掉另外两个 tab 的条数**。
  现在各自带 token，并做一次性迁移（把旧 key 的值复制到三个新 key 后删掉旧 key）。
- `SystemConfig/tabs/Caddy.jsx`：`location.reload()` / `location.replace('http://…')` 的定时器
  在 `await setHttpsConfig` **之前**就排上了，catch 里也不取消 → 更新失败浏览器照样切协议。
  改成只在成功后排。另外 `import lodash from 'lodash'` → `lodash/isEqual`（`UrlFormItem` 的
  `lodash/debounce` 也一并改了，桶式导入会把整个 lodash 拖进 chunk）。
- `pages/InitPage/index.tsx`：把 `statusCode == 500` 当成功，但服务端是用
  `throw new HttpException('已初始化', 500)` 表达的 → 请求直接 reject，那个分支是死代码。
  改成 try/catch 并识别「已初始化」文案，引导去登录。
- `api.js createCustomFolder` POST 的是**文件**接口（服务端文件夹路由是 `/customPage/folder`）；
  目前唯一引用在 `Code/index.tsx` 被注释掉的工具栏里，属于死代码，但仍已修正并用测试钉住。
- `useEditorCache.js` 少了 `return`（hook 恒返回 undefined）。
- `pages/CommentManage/index.jsx` 的评论 iframe 在 `version=='dev'` 时指向一个**硬编码的内网地址**
  （上游遗留）→ 改成按 `window.location` 推导 `//<host>:8360/ui`。
- 测试：新增 `tests/unit/adminRobustness.test.js`(18)：以上每件的源码契约（断言前先剔除注释行）、
  全仓扫描「不许再有 `<Link to="/admin/...">`」、深链 key 与 SystemConfig/SiteInfo 实际读取的 key 对齐、
  顺序断言（先清 token 再跳转、先 await 再排定时器），以及 3 条 `require()` 真实模块的行为测试
  （`reportRequestError` 只在全局没提示过时才补提示）。

**测试**：server 新增 `utils/attemptLimit.spec.ts`(4)、`utils/imgLinkParse.spec.ts`(7)；
website 新增 `__tests__/robustness.spec.ts`(12)；admin 新增 `adminRobustness.test.js`(18)。
基线见 §7.16。

### 7.16 内置评论系统（builtin，可替代外挂 Waline）

上游的评论是外挂的 Waline：server 用 `spawn` 拉起一个子进程（端口 8360、独立的 `waline` 库），
前台加载 `@waline/client`，后台评论页是它的 `/ui` iframe，caddy 还要转发 `/comment`、`/ui` 等路径。
现在多了一套**内置评论**：数据在 `vanBlog` 库的 `nativecomments` 集合，接口是本站的
`/api/public/comments*` 与 `/api/admin/comment*`，前台是自研 React 组件，后台是原生管理页。

- **三选一**，存在 settings 的 `type: 'comment'` 行里：`builtin` / `waline` / `off`。
  ⚠️ **没有这一行时默认 `waline`**（老站点升级后评论不会凭空消失）；
  **全新安装**由 `init.provider` 显式写入 `provider: 'builtin'`。
  切换模式时 `setting.controller` 会顺手启停 waline 子进程；`walineProvider.run()` 里也有一道
  守卫（provider 不是 waline 就直接 return，连退出钩子的自动重启一起挡住）。
  两套数据互不迁移。
- 数据模型是**两层**：顶层 `rootId = 0`，回复挂到所属顶层（回复「回复」也归同一顶层，
  用 `parentId` + `replyToNick` 显示「回复 @某人」）。无限嵌套在移动端没法看，也和 Waline 表现一致。
- **安全是重点**（评论是匿名可写的）：
  - 渲染端不开 `allowDangerousHtml`，原始 HTML 根本不解析；再补一个 remark 插件把 html 节点
    转成 text 节点 —— remark-rehype 默认是**直接丢弃** html 节点，那样用户写的内容会凭空消失。
  - `utils/commentSanitize.ts` 的白名单比正文严得多：无 `img`（追踪像素/钓鱼图）、无
    `iframe/style/svg/math/form/input/button`，属性只留 `a[href|title|rel|target]` 与代码高亮的
    `className`，没有 `style`/`id`/`data-*`；`script`/`style` 等连内容一起 strip。
  - 链接统一 `target=_blank` + `rel="nofollow noopener noreferrer"`（防 tab-nabbing，也不给评论区传权重）。
  - 服务端**不信任前端**：path 必须 `/` 开头且无 `..`、文章必须真实存在且未隐藏（否则机器人可以
    往编造路径灌库）、昵称剥尖括号与控制字符、邮箱格式校验、`site` **显式拒绝非 http/https 的 scheme**
    （不能只靠 `new URL()` 碰巧解析失败）、内容拒绝控制字符并剥掉双向控制符（RLO 伪装）、限长。
  - 反垃圾：蜜罐字段（对外只说「待审」，不暴露判定）、同 IP 每 10 分钟 N 条（默认 10）、
    每天 50 条、同 IP+同内容 5 分钟 1 条、关键词命中与含外链自动转待审、演示站禁止评论。
    限流复用 `utils/attemptLimit.ts`。
  - 公开接口的返回里**没有** `email`/`ip`/`ua`/`reason`（`CommentProvider.toPublic` 收口），
    这些只在后台可见；昵称/主页在组件里当文本渲染，主页还要在客户端再校验一次 `^https?://`。
- ⚠️ **评论的 path 键用「数字 id」，而且服务端要做等价展开**（`expandPostPaths()`）：
  一篇文章有 `/post/<数字id>` 和 `/post/<拼音别名>` 两个入口（都返回 200），别名还能改。
  一开始前台用 `getArticlePath()`（有别名就返回别名）当键，而 waline 时代的历史评论全是
  `/post/7` 这种数字形式 → 页面上「库里明明有评论，一条都不显示」。现在：
  **写入**统一用 `/post/<numericId>`（`PostCard` 与 `SubTitle` 都用 `numericId ?? id`），
  **查询/计数**先把同一篇文章的所有等价路径展开成 `$in`，所以两种形式的老数据都认。
  waline 那条路径（`data-path={dataPath}`）**故意保持不变**，别把它已有的评论弄丢。
- **导航栏的下划线**：`.ua:before`（`bottom: 2px`）是画在 `<li>` 上的，所以**这个 li 绝对不能有
  transform**。原来 li 上挂着 `hover:scale-110`，一悬停整条横线就往下移 ~2px 并且变宽变粗，
  和「当前页那条横线」不在同一水平线上。修法：缩放挪到里面的文字（`group` + `group-hover:scale-110`），
  再在 `globals.css` 里加一条兜底 `.ua, .ua:hover { transform: none }`，
  以后谁再把缩放加回去也不会错位。`__tests__/robustness.spec.ts` 有源码级守卫。
- **所有评论区都走 `components/CommentArea`**（三选一的分支收在里面）。
  ⚠️ 别再在任何页面直接渲染 waline 组件：`pages/link.tsx` 原来就是写死的，
  站点切到内置评论后 waline 子进程已被停掉，友链页的评论区就是一片空白/报错。
  列表页（`pages/index.tsx`、`pages/page/[p].tsx`）那个 `visible={false}` 的**隐形 waline 实例**
  只是为了让 `@waline/client` 去填 `.waline-comment-count`，内置模式下评论数走本站
  `/counts` 接口（`components/Comment/Count.tsx`），所以它必须被 `commentProvider === "waline"` 门住。
  `__tests__/comment.spec.ts` 会全仓扫描这条规则（扫描前先剔除 `//`、`/* */` 与 JSX 的 `{/* */}`，
  否则注释里提到组件名会被误伤）。
- **前台接线注意性能**：评论区在 `CommentArea` 里是 `dynamic(() => import("../Comment"), { ssr: false })`。
  评论渲染用 bytemd 的 `getProcessor`，静态 import 会把 markdown 管线拖进 PostCard 的 chunk，
  首页 First Load JS 立刻回涨（和「PostCard 不许 import ../Markdown」是同一条约束）。
  评论数走 `utils/commentApi.ts` 的**批量合并**：50ms 内的请求合成一次 `/counts?paths=…`（上限 50 个）。
- 坑记录：
  1. `CommentProvider` 一开始注入了 `ArticleProvider` + `MetaProvider`，Nest 直接报
     `A circular dependency has been detected inside AppModule`（Article ↔ Meta 本来就互相引用，
     新加一条边把潜在环暴露了）→ 改成**直接注入 model**（`Article`/`Meta`）。
  2. 往 `app.module.ts` 的数组里插元素时，正则的插入点已经带逗号，结果写成 `TokenController,,`
     —— JS 数组的**空洞**会让 Nest 报成"循环依赖"（错误信息完全不指向真因）。
     教训：脚本化改数组后一定要 `grep ',,'` 或直接看编译结果。
  3. bytemd 的 `plugins` 数组要的是 `{remark}/{rehype}` 形状的对象，裸的 unified transformer
     会报 `Type '(tree:any)=>void' has no properties in common with type 'BytemdPlugin'`。
- **从 Waline 导入 / 导出**（`importFromWaline()` / `exportComments()`，接口
  `POST /api/admin/comment/import/waline`、`GET /api/admin/comment/export`）：
  导入吃三种形状（VanBlog 的 waline 备份 `{type:'waline',data:{Comment:[]}}`、`{Comment:[]}`、裸数组），
  **默认只导 approved**、按 `sourceId`(=waline objectId) **幂等**、保留 `insertedAt`→`createdAt`
  与 `like`→`likeCount`、`rid/pid` 映射成两层结构、走与本站发表**同一套校验**（导入不是后门）、
  支持 `dryRun`。两条容错是刻意的：历史数据里**邮箱格式不合法只清空邮箱、不丢整条**；
  `data:image/...;base64` 的图片折叠成 alt（否则一条几十 KB base64 进库，而白名单里根本没有 `img`，
  前台只会显示字面量）。导出**默认只给 approved**，`status=all` 才带其它状态，非法状态值退回 approved。
  schema 为此加了 `source` / `sourceId`(带索引) / `likeCount` 三个字段。
- **备份覆盖评论**：`utils/fullBackup.ts` 的 `dumpDatabase()` 是 `db.collections()` **动态枚举**，
  所以 `nativecomments` 自动进备份（实测清单里 `vanBlog.nativecomments 3 条` + `waline.Comment 3 条`，
  两个库都在）。⚠️ 备份**包含所有状态**（含待审/垃圾/已删除），这是对的 —— 只要"正式显示的"用 export 接口。
- 测试：`provider/comment/comment.provider.spec.ts`(32，用假 model 跑校验/审核/限流/隐私字段/查询/导入导出)，
  website `__tests__/comment.spec.ts`(15，渲染安全 + 接线契约)。另外用脚本对**运行中的服务**做过
  端到端验证（发表/回复/嵌套/计数/待审/放行/删除/注入 payload/PII 不泄露）。
- 文档：`docs/features/comment.md`（两套系统对比、审核策略、反垃圾参数、安全设计、接口清单）。

### 7.18 第三轮安全加固：口令哈希、全局限流、响应头、`pageSize=-1`

接着 §7.11 / §7.15 往下清「已知未修项」，这一轮拿下四件大的。

**1. 管理员/协作者口令 → scrypt（登录时自动迁移）**
- 原来是 `sha256(sha256(username + 浏览器端派生值) + salt + sha256(username + salt))`：
  纯 sha256 是**快哈希**，库或整站备份泄露后可以用 GPU 每秒试几十亿次。
- 现在存 `scrypt$16384$8$1$<salt b64>$<hash b64>`（自描述格式，以后想调参数或换 argon2 也能识别旧格式）。
  选 scrypt 而不是 argon2/bcrypt：**node:crypto 自带，不加依赖**（argon2 要原生编译，alpine 镜像里风险大）。
- **迁移是透明的**：`verifyUserPassword()` 新旧格式都认，登录成功时 `updateSalt()` 顺手升级成 scrypt。
  用户不用改密码、不用停机跑脚本。客户端也不用改（scrypt 的输入仍是浏览器端派生值）。
- ⚠️ `validateUser()` 原来是「算出哈希再去 Mongo 里 `findOne({name, password})`」，那样只能支持一种格式。
  改成先按 name 取出用户、在 JS 里校验。**别再改回用查询比密码**。
- `washUserWithSalt()`（把更老的无盐数据洗成带盐）**只能**继续用旧方案：它的输入是上一代服务端哈希，
  拿不到浏览器端派生值。等该用户下次登录就会自动升级 —— 代码里写了注释，别"顺手统一"掉。
- `verifySecret()` 会校验 scrypt 参数上限（`N ≤ 2^20`、`128*N*r ≤ 64MB`）：库被改过也不至于构造出
  一个让进程 OOM 的哈希。空口令一律拒绝（空哈希曾经等于空密码可登录）。

**2. 全局限流中间件**（`utils/rateLimit.ts`，在 `app.module.configure()` 里最先 apply）
- 分档：`/api/admin/init*` 10 分钟 5 次、`/api/public/**` 写操作每分钟 30 次、全局每分钟 600 次
  （都有环境变量）。命中返回 429 + `Retry-After`。
- **回环直连放行**：前台 SSR / waline / ISR 触发都是高频内部调用，不能被自己限死。
  判据是「socket 是回环 **且** 没有 `X-Forwarded-For` / `X-Real-IP`」——
  ⚠️ 只看 socket 会出事：一体式镜像里 caddy 转发过来的请求 socket 全是 127.0.0.1，
  那样等于**对所有真实用户放行**。经过反代的一定带转发头，所以真实客户端跑不掉。
- **fail-open**：限流组件自己抛错就放行。别为了防护把可用性搭进去。
- 复用 §7.15 的 `utils/attemptLimit.ts`（桶数超过 2 万会整体清空，是刻意的软失败）。

**3. 安全响应头**（Nest 中间件 + `CaddyfileTemplate` 都下发）
- `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、
  `Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`、caddy `-Server`。
- ⚠️ `X-Frame-Options` 必须是 **SAMEORIGIN 而不是 DENY**：后台的评论管理页会把同源的 waline `/ui`
  放进 iframe，DENY 会直接白屏。
- **刻意不加 CSP**：内联样式 + bytemd 注入的脚本 + 可选第三方统计，严 CSP 会把站点搞坏，
  松 CSP 等于没有。要做必须先给内联样式发 nonce。测试里钉了「不许半成品地上 CSP」。

**4. `pageSize=-1` 收敛 + API Token 有效期**
- 公开文章列表原来允许任何人 `pageSize=-1` 把**全部文章连正文**一次拉走（前台静态生成需要它）。
  现在只有 `isInternalRequest()`（回环直连，或带 `x-vanblog-internal: <VAN_BLOG_INTERNAL_TOKEN>`）
  可以，其它夹到 `MAX_PAGE_SIZE`。一体式部署零配置；前后端分离时两边配同一个 token。
- API Token 原来是 **100 年**过期（等于永不过期）。新签发默认 1 年（`VANBLOG_API_TOKEN_TTL_DAYS`），
  已签发的不受影响（`expiresIn` 已写在库里）。
- 文章解锁的密码比较改成**常量时间**（`verifyAccessPassword()`），同时兼容历史明文与将来的哈希。
  ⚠️ 文章/分类密码**没有**改成哈希存储：后台「修改信息」表单会把存着的密码回填到输入框，
  改哈希必须同时改前端语义（留空 = 不修改），否则会把密码写成哈希串或把文章意外解锁。要做得前后端一起改。

**5. CORS**：`main.ts` 里**没有** `enableCors`，也就是默认同源策略 ✓ 别顺手"加个 CORS 方便调试"，
那会让任意站点能带着用户的 token 调后台接口。

测试：`utils/crypto.spec.ts`(11)、`utils/rateLimit.spec.ts`(9)；
`scripts/tests/reverse-proxy-host-header.test.sh` 增加 7 条 Caddyfile 断言（42 → 49）。
线上实测：四个响应头都在；带 XFF 的公开写接口第 31 次开始 429；`/api/admin/init` 第 6 次开始 429；
错误密码登录仍是 401（说明旧格式校验路径正常）。

### 7.19 测试基线（本分支最后一次全量运行的结果）

| 套件 | 结果 |
|---|---|
| server `jest` | 587 用例：586 绿，1 个既有失败（`utils/watermark.spec.ts` 需要联网拉字体，见 §2.1） |
| website `vitest run` | 54 文件 / 504 用例全绿 |
| admin `node --test tests/unit` | 73 套件 / 283 用例全绿 |
| `scripts/tests/*.test.sh`（一键脚本/部署） | 8 文件 / 313 条断言全绿 |
| admin playwright e2e | 未跑（没装浏览器） |

改动之后请至少跑对应包的那一套；跨包改动（例如同时动了 server 与 docs）三套都跑。

---

## 8. 给 AI 代理的额外提示

1. 动手前先 `git log --oneline -10` + `git status`，确认自己在哪个分支、有没有未提交的东西。
2. 改完代码**必须跑测试**（§2.1），并对照 §7.19 的基线判断是不是自己弄坏的。
3. 需要改本地环境时，**新建文件 + 写进 `.git/info/exclude`**，不要改仓库跟踪的文件（§6.2）。
4. 提交信息用 Conventional Commits；一个需求一个提交，交叉文件的改动尽量按功能拆开
   （必要时用 `git apply --cached` 做 hunk 级暂存）。
5. 不要 `git push` 到 `origin`；推自己的 fork（§2.2）。不要打 tag。
6. 涉及上传/图片/附件的功能，注意三条既有约束：附件只落本地、图片按 `(sign, staticType)` 去重、
   图片管线顺序不可调整（§7.5）。
7. 本机专属信息（真实路径、代理、已导入的数据、远端与凭据、遗留待办）都在 `AGENTS.local.md`，
   **不要把它的内容写进入库文件，也不要提交它**。
