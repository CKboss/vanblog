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
- **开发要点（用户定的）：不用刻意兼容原版 VanBlog，一切以当前开发环境能跑的版本为基准** → 见 §6.0

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

### 6.0 版本基准与兼容性取向（**用户明确定的开发要点**）

> **不用刻意去兼容原版 VanBlog。以当前开发环境能跑的软件版本为基准。**

含义与边界：

- **基准 = 本机开发环境实测能跑的那套版本**（下表）。Dockerfile、compose 模板、安装脚本、
  CI 都以这张表为准，**不要为了"和上游一致"而降级**，也不要保留只为上游服务的兼容分支。
- 已经按这条原则处理过的：镜像默认 `EMAIL` 不再是上游作者的邮箱；示例 compose 的 `image:`
  指向本 fork 的 ghcr 而不是 `mereith/van-blog`；后台「关于」页与 14 处帮助文档链接指向本分支；
  页脚署名指向本分支；`node:18`（上游用的、已 EOL）升到 `node:20`；
  全新安装的 mongo 默认 `7.0`（上游钉的 `4.4.16` 早在 2024-02 就 EOL）。
- **不属于"兼容上游"、因此仍然要保留的**：保护**用户自己的现有数据**。
  `pick_mongo_image()` 在检测到已有 mongo 数据目录时保持原 tag，不是留恋上游的 4.4，
  而是因为数据目录与 FCV 绑定、直接换大版本 mongod 会拒绝启动（看起来像数据全丢）。
  同理，`--offline` 的老式数据目录 tar 备份也保留（站点起不来时它是唯一能用的手段）。
- 与下面第 3、9 条**不冲突**：那两条是"别动这套已验证的基准"（pnpm 8 / lockfile v6.0、
  FCV 保持 6.0），正是本原则的另一面 —— 基准是本机跑得通的组合，不是越新越好。

**当前基准（本机实测全绿的那套）**

| 组件 | 版本 | 备注 |
| --- | --- | --- |
| Node | **20.19.5**（`.tools/node20`） | 系统 Node ≥23 会让 `@nestjs/cli` 9 崩（`util.isObject` 被移除） |
| pnpm | **8.11.0** | lockfile v6.0；升 9/10 要重写 lockfile 并重算补丁 hash |
| MongoDB | **7.0.14**，FCV **6.0** | 镜像/compose 的默认 tag 用 `mongo:7.0` |
| sharp | 0.32.6 | 有 Node 20 的 prebuild；升 Node 22 必须先升 sharp 0.33+ |
| TypeScript | 4.9.5 | |
| NestJS | 9.x | |
| Next.js | 13.5.x（pages router） | |
| umi | 3.5.x（admin） | 两个 pnpm 补丁是为它的 MFSU 老解析器打的 |
| Alpine | 3.23（`node:20-alpine` 带的） | 仓库路径是 `v3.23`（两段），而 `VERSION_ID` 是 `3.23.4`（三段） |

1. **不要用系统 Node（≥23）跑 server/admin/website**，一律 `.tools/node20`。
2. **不要为了本地环境去改仓库跟踪的文件**（`config/config.js`、`config/proxy.js`、`next.config.js`、
   `tsconfig*.json` 等）。环境需要覆盖时就新建本地文件 + 写进 `.git/info/exclude`；
   只有**真正的功能改动**才应该出现在 `git diff` 里（当前有哪些见 §7）。
3. **不要去掉 `pnpm install --frozen-lockfile`**，也不要把 pnpm 升到 9/10/12（lockfile 是 v6.0）。
4. **不要 `pkill -f "<含工作区路径的模式>"`**：命令行里带同样字符串的当前 shell 会被自己杀掉（真踩过）。
   要杀就先 `pgrep` 出 pid，排除 `$$` 与 `$PPID` 再 `kill`。
5. **mongod 的 `--dbpath/--logpath/--pidfilepath` 必须绝对路径**（`--fork` 之后 cwd 会变）。
6. **不要把 pnpm store 放到别的文件系统**（跨设备无法硬链接，装包会退化成全量复制）。
7. **不要执行 `pnpm release` / `pnpm release-doc`**（作者的发版工具，会改版本号并提交），
   也**不要把 `.github/workflows/release.yml`（上游那份）加回来**：它由 `v*` tag 触发，
   会登录 DockerHub 推 `mereith/van-blog:<版本>`、`curl -X POST $VERSIONURL` 往作者的版本服务器上报、
   还有两步 `kubectl set image deployment/van-blog …` **部署到作者的集群** —— 在 fork 里这些
   要么因为缺 secret 失败，要么就是往别人家推东西。本 fork 用的是
   `.github/workflows/release-fork.yml`（同样由 `v*` 触发，只用 `GITHUB_TOKEN` 建 Release，
   发布说明取 CHANGELOG 里对应 tag 的那一节并把相对链接改写成绝对地址，附件带
   `vanblog.sh` 与编排模板）。
   `doc*` / `test*` tag 仍然是作者专用的（分别触发 deploy-docs 与 test 工作流），不要推。
   `v*` tag 现在可以推：它会同时触发 `release-fork`（建 Release）与 `publish-ghcr`
   （构建并推 `latest` + `<tag>` 两个镜像 tag）。
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

**5. 渐变占位封面：做了、被否了、删了（设计复盘，别再走回头路）**

列表页「一半卡片有图一半没有」，第一版做法是给没图的文章按**标题哈希**生成一张渐变占位封面
（双色渐变 + 两个光斑 + 斜纹 + 标题首字）。用户先否掉了首字（中文取一个字像乱码、且标题就在旁边），
改成纯抽象渐变之后又问「这种设计真的好嘛?」——**答案是不好**，理由值得记下来：

1. **哈希出来的颜色不承载任何信息**：同分类的两篇会得到毫无关系的颜色，读者从中读不到任何东西。
   好的配色要么来自真实内容（照片），要么编码语义（分类/状态）。
2. **一屏五种高饱和色 = 变花，不是变好看**：这恰好违反本皮肤自己写下的原则
   （大面积中性色 + 少量柔和彩色）。标签胶囊可以，因为它是 95% 亮度的洗色、且颜色与标签绑定。
3. **假图比没图更糟**：16:10 + 圆角 + 阴影的色块，在视觉语法上就是「这里有张缩略图」，等于撒谎
   （和「永远不结束的骨架屏」同类）。Apple News 对没有配图的文章就是**纯文字卡**，
   节奏靠字号/字重/留白/发丝线。
4. **它没解决根因**：根因是「53 篇文章 0 张封面」（内容问题），用装饰去盖是创可贴。

**最终方案 = B + A**：
- **B｜后台一键补封面**（`utils/coverFromContent.ts` + `ArticleProvider.backfillCoversFromContent/revertCovers`
  + `POST /api/admin/article/covers/{from-content,revert}`）：先 `dryRun` 预览、可逐篇取消勾选、
  默认只补 `cover` 为空的、写入后触发 ISR、并且**可精确撤销**（把 `previousCover` 原样写回；
  撤销时用 `{id, cover: {$ne: previous}}` 做条件更新，用户后来手改过的不会被覆盖）。
  取图规则与前台 `utils/firstImage.ts` 一致（文档顺序第一张可用图，复用 `extractImageRefs`
  所以自动跳过代码区），并**优先本站图床**：外链首图随时可能失效（防盗链/CDN 下线/仓库改名），
  还会把访客 IP 与 Referer 泄露给第三方，只有整篇没有本地图时才退回外链。
  本站实测：53 篇里 16 篇能补（37 篇正文压根没图），二次执行 0 写入 / 16 跳过（幂等）。
- **A｜删掉占位封面**：`utils/coverPlaceholder.ts` 已删除，`ListThumb` 回到「没图就 `return null`」，
  apple.css 里 `.post-card-cover-fallback` / `-glyph` 相关规则全部清掉。
  测试里留了一条**反向断言**（`utils/coverPlaceholder.ts` 必须不存在、CSS 里不许再出现
  `post-card-cover-*`），并且断言服务端的补封面接口还在 —— 防止以后有人又把假图加回来。

**6. 深色模式的层次**：暗色令牌原来是**反的**（`--ap-surface-2` #161617 比 `--ap-surface` #1d1d1f 还暗），
本该凸起的面看起来是凹的 → 整个暗色页很平。改成单调递增 `#000 < #1c1c1e < #2c2c2e < #3a3a3c`
（Apple 暗色系统的数值），并新增两个暗色专用令牌：
`--ap-inset-highlight`（顶边 1px 高光）与 `--ap-ring`（1px 半透明环）。
⚠️ **纯黑底上投影是看不见的**，所以暗色的"抬升"必须靠高光 + 环来表达，浮层再叠一层投影拉开离地高度。
发丝线从实色 `#424245` 换成 `rgba(255,255,255,.16)`（实色在黑底太重，会把版面切成格子）。
`__tests__/appleTheme.spec.ts` 里有一条断言会**计算四个表面色的相对亮度并要求单调递增**，
以后谁再把层级调反就会红。

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
README 里的 curl 也指向作者的文档站与上游 raw。当时本分支还没有发布镜像，所以改成：

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

### 7.20 SEO：canonical / 301 / 结构化数据 / sitemap lastmod / robots

面向用户的完整说明在 `docs/advanced/seo.md`，这里只记**改了什么、为什么、有哪些坑**。

**1. 重复内容（最大的一条）**：一篇文章有 `/post/<数字id>` 和 `/post/<别名>` 两个入口，
以前**两个都返回 200 且没有 canonical**，搜索引擎会当成两份内容把权重拆开，阅读量也按 pathname 分家
（这就是 §7.11 里挂着的 M2）。现在：
- `pages/post/[id].tsx` 的 `getStaticProps` 里，`params.id !== getArticlePath(article)` 就
  `redirect: { destination, permanent: true }` → Next 返回 **308**（Google 按 301 同等处理）。
  没有别名的文章 `canonical === String(id)`，不会跳。
- `components/Layout` 统一输出 `<link rel="canonical">`（用 `useRouter().asPath` 算，
  **去掉 query 与 hash**、`/page/1` 规范到 `/`、多余斜杠收敛）。放在 Layout 是为了**一处生效全站**，
  不用改 8 个页面。⚠️ 站点 URL 没配时**不输出** canonical：错误的绝对地址比没有更糟。
- 评论的 path 键与这件事无关（那边用数字 id + 服务端等价展开，见 §7.16），301 不会影响评论。

**2. sitemap 带上了 lastmod / changefreq / priority**（以前只有 `<loc>`）：
`getSiteEntries()` 一次取全部文章的 `updatedAt || createdAt`，文章 0.8/weekly、首页 1.0/daily、
时间线 0.7、分类 0.5、标签 0.4、分页从 0.4 递减到 0.2、自定义页 0.6；
聚合页的 lastmod 用「最新文章更新时间」。并按 URL 去重（`/page/1` 与首页重复）。
- **加密文章与加密分类下的文章不进 sitemap**：正文对爬虫不可见，收录进来是浪费抓取配额 +
  薄内容（thin content）拉低质量评分。隐藏文章本来就被 `getAll('list', false, false)` 排除了。
- 拿不到分类信息时按「没有加密分类」处理，**不让整份 sitemap 生成失败**。

**3. sitemap/RSS 的生成以前被 `VANBLOG_DISABLE_WEBSITE` 挡死了** —— 这两个是 **server 自己写的静态文件**，
和前台 Next 进程无关，但 `isrProvider.activeAll()` 第一件事就是 `if (VANBLOG_DISABLE_WEBSITE) return`，
于是「前台没起 / server 单独部署」时它们**永远不更新**（本机开发环境正好复现：sitemap 里还留着
早就删掉的探针文章 `/post/53`、`/post/52`）。修法是把两行生成挪到守卫**之前**。
⚠️ 本开发环境 `VANBLOG_DISABLE_WEBSITE=true`，所以想验证 sitemap/RSS 必须走
`POST /api/admin/isr`（且要等 60s / 3min 的防抖），别以为改了代码没生效。

**4. robots.txt 改成 server 动态生成**（`controller/public/robots.controller.ts`，路由就是 `/robots.txt`）：
`Sitemap:` 必须是**绝对 URL**，静态文件不知道域名 —— 这就是以前 robots.txt 里根本没有 Sitemap 行的原因。
- 删掉了 `packages/website/public/robots.txt` 与那个手误的 `robot.txt`；
  ⚠️ **必须删**：Next 的 `public/` 静态文件优先于 rewrites，留着就会把动态路由盖掉。
- 生产由 caddy `handle /robots.txt → 127.0.0.1:3000`，开发由 `next.config.js` 的 rewrite 兜；
  同时补了 `/sitemap.xml` 的 rewrite（生产是 caddy 的 `uri replace`）。
- Disallow 补齐：`/api/`、`/admin`、`/swagger`、`/swagger-json`、`/static/export|tmp|upload-tmp`，
  并显式 `Allow: /static/`（图床要能被收录）。
- ⚠️ `washUrl('')` 返回的是 `'https://'`（它给没协议的串补 `https://`，`new URL` 抛错后原样返回），
  直接用会写出 `Sitemap: https:///sitemap.xml`。所以要用 `/^https?:\/\/[^/\s]/i` 验一遍再写。
- 带 `Cache-Control: public, max-age=3600`（爬虫请求频繁）。

**5. meta 与结构化数据**（`utils/seo.ts`，全是纯函数 + 19 条单测）：
- **每篇文章自己的 description**：`toPlainText(content, 160)` 把正文压成纯文本
  （围栏代码整块丢掉、行内代码留内容、图片换 alt、链接留文字、剥掉 markdown 记号与残留 HTML、
  压掉 `<!-- more -->`），超长时优先在句读处截断补省略号。以前所有页面共用站点描述，摘要千篇一律。
- 文章页：`og:type=article`、`article:published_time/modified_time/section/tag`、`twitter:title/description`；
  Layout 全站输出 `og:url`(=canonical)、`og:site_name`、`og:locale`、`og:title`、`og:description`。
  （`next/head` 会按 name/property 去重，页面级的会盖掉 Layout 的同名标签，所以不会有两个 description。）
- **JSON-LD**：文章页 `BlogPosting` + `BreadcrumbList`（首页→分类→文章），首页 `WebSite`+`Blog`。
  ⚠️ 非法日期**直接省略字段**，绝不写 `Invalid Date`（那会让整段结构化数据校验失败）；
  序列化走 `JSON.stringify` 且把 `<` 换成 `\u003c`，堵死从 JSON-LD 逃出 `</script>` 的路。
- `LayoutProps` 新增 `siteUrl` / 复用已有的 `siteName`（⚠️ `siteName` 本来就存在，
  我第一遍又加了一次，TS 直接报 Duplicate identifier —— 加字段前先 grep）。

**6. `<html lang>`**：前台 `_document.tsx` 原来是 `lang="zh"`（BCP 47 里 `zh` 是宏语言，
简繁与发音规则都不明确），后台 `document.ejs` 更离谱，是 **`lang="cn"`** —— `cn` 根本不是语言子标签
（ISO 639-1 里中文是 `zh`，`CN` 是国家代码），浏览器/读屏/搜索引擎只能当未知语言处理。
两处都改成规范的 `zh-CN`，与 `og:locale=zh_CN`、RSS 的 `<language>zh-CN</language>`、
JSON-LD 的 `inLanguage` 一致。⚠️ 改 `_document.tsx` 时踩了个坑：**JSX 注释写在
`return (` 的顶层**（`return ( {/* … */} <Html …> )`）会让整个括号变成对象字面量，
**全站 500**；而 vitest 只把文件当文本读，测试照样全绿 —— 所以改完必须
`tsc --noEmit` + 真的 curl 一次首页。`__tests__/seo.spec.ts` 里加了一条
`expect(doc).not.toMatch(/return\s*\(\s*\{\//)` 当守卫。

**7. RSS/Atom/JSON Feed 小修**：分类/标签的 `domain` 以前是 `https://域名//category/x`（双斜杠、中文没编码）；
标签现在也作为 `<category>` 输出（以前只有分类，53 篇文章 → 108 条 category）；
`language` 改规范的 `zh-CN`；KaTeX 样式表从 **0.5.1（2016 年，已失效）** 升到 0.16.9。

**测试**：`utils/seo.ts` 19 条（website）、`sitemap.provider.spec.ts` 追加 6 条、
新增 `controller/public/robots.controller.spec.ts` 5 条。
基线：server 610（609 绿 + 1 个既有离线字体用例）、website 55 文件 / 528、admin 77 套件 / 306、
脚本 8 文件 / 313。

**实测**（本机站点 URL 指向的是生产域名，所以 canonical/og 里出现的是那个域名，属正常）：
`/post/1` → 308 → `/post/jiang-paddleocr-zhuan-wei-onnx-yun-xing` → 200；
文章页有 canonical、独立 description、`og:type=article`、`article:published_time`、`article:tag`
与 2 段 JSON-LD（BlogPosting + BreadcrumbList）；首页有 WebSite+Blog 与 canonical；
`/robots.txt` 200 且带 `Sitemap:` 行；`/sitemap.xml` 79 条 URL、76 条 lastmod、79 条 changefreq/priority，
且已删除的探针文章不再出现；`feed.xml` 的 `language` 为 zh-CN、category domain 无双斜杠。

### 7.21 归属：后台「关于」页、页脚署名、文档链接与版本号

`packages/admin/src/pages/About.tsx` 以前整页都指向**上游**（Mereithhh/van-blog + 作者文档站），
但这个后台跑的是本 fork 的代码：点「提交BUG」会开到上游仓库报本分支才有的问题，
点「更新日志」看到的是上游发版记录（本分支的改动一条都不在里面）。现在分两块：

- **上半页 = 本分支**：`增强修改版` 标签、`CKboss/vanblog` 的 `dev/dsh` 分支说明、GPL v3 声明、
  9 条主要增强点（`FORK_HIGHLIGHTS`），链接指向本分支的 Github / 提交历史 / CHANGELOG.md /
  README 的「本分支新增内容」锚点 / 仓库内 `docs/` / `AGENTS.md` / 本地 `/swagger` / 本分支 Issues。
- **下半页 = 原始项目**（`Divider` 分隔）：致谢 @Mereithhh，保留上游 Github、官方文档站、
  上游更新日志、官方交流群、打赏入口，并注明「上游文档与更新日志描述的是**官方镜像**的行为，
  与本分支不完全一致」。
- 上游地址集中在文件顶部的常量里，换分支/换仓库只改一处。

**前台页脚同样处理**（`components/Footer/index.tsx`）：`Powered By VanBlog <version>`
以前链到上游文档站，访客点进去看到的说明与本站实际行为对不上（评论系统、皮肤、SEO 全不一样）。
现在链到 `https://github.com/CKboss/vanblog`，后面跟一个 ` · 增强修改版` 链到 README 的
「本分支新增内容」锚点。**项目名仍然叫 VanBlog** —— 它确实是 VanBlog，本分支遵循上游 GPL v3，
致谢在 README / CHANGELOG / 后台「关于」页都有。
⚠️ 改这段 markup 时保留 `ua ua-link` 两个类，且**不许加 `hover:scale-*`**
（§7.10 的性能/动效不变式里有测试盯着 `.ua` 元素不能带缩放）。

**版本号（页脚与「关于」页显示的那个）**：来自 server 的 `process.env.VAN_BLOG_VERSION`，
没设就回退 `'dev'`（`utils/loadConfig.ts:49`）—— 所以本地源码直跑显示 `dev` 是**正常的**，不是 bug。
- 官方镜像：构建时写死；
- 本仓库 `vanblog.sh` 源码构建：`--build-arg VAN_BLOG_VERSIONS=dev/dsh@<sha>`；
- 本地开发：`dev-env.sh` 启动 server 时注入 `VAN_BLOG_VERSION=dev/dsh@<短sha>`（git 不可用则退回 `dev/dsh`）；
- 前台从接口拿（`getLayoutProps` 里 `data?.version || "dev"`），拿不到也不会渲染成 `undefined`。
- ⚠️ Dockerfile 里**构建参数是复数 `VAN_BLOG_VERSIONS`、环境变量是单数 `VAN_BLOG_VERSION`**
  （`ARG VAN_BLOG_VERSIONS` → `ENV VAN_BLOG_VERSION ${VAN_BLOG_VERSIONS}`），这是上游就有的设定，
  别"顺手统一"，改一边版本号就退回 dev。测试里钉了这两个名字同时存在。
- ⚠️ 改完 `dev-env.sh` 的环境变量必须 `./dev-env.sh restart` 才生效（server 只在启动时读一次）。

**顺手修掉一个假警报**：`app.jsx` 的「有新版本！」横幅原来是
`if (version && latestVersion && version != 'dev') { if (version >= latestVersion) {} else {弹} }`。
源码构建的版本号是 `dev/dsh@1a2b3c4`（不是 `dev`），拦不住；而 `'dev/dsh@…' >= 'v0.54.0'`
是**字符串比较**，首字符 `'d' < 'v'` → 结论「有新版本」，**每次进后台都弹一次假警报**
（本仓库的 `vanblog.sh` 源码构建同样会中）。而且字符串比较连 `0.9.0` vs `0.10.0` 都判反。
现在逻辑挪到 `src/services/van-blog/version.js`（CJS，可被 node:test 直接 require）：
`isReleaseVersion()` 只认 `^v?\d+\.\d+`，`compareVersions()` 按 major/minor/patch 数字段比，
`shouldNotifyNewVersion()` 要求**两边都是发布号**且 current < latest 才弹。

**顺带清掉了一批死链**：后台里指向 `vanblog.mereith.com/<path>.html` 的**帮助文档链接共 14 处**，
实测其中 **6 处已经 404**（`/feature/basic/editor.html`、`/feature/advance/collaborator.html`、
`/feature/advance/isr.html`、`/feature/advance/customizing.html`、`/feature/basic/comment.html`、
`/guide/https.html`）—— 上游文档站改过目录结构（`feature/basic/*` → `features/*`、
`feature/advance/*` → `advanced/*`）。全部改指**本分支仓库里的 `docs/**.md`**（与正在运行的代码同版本），
CHANGELOG 那条指仓库根的 `CHANGELOG.md`（里面有 🍴 fork 区块）。
⚠️ 锚点别乱带：`guide/update.md` 里没有「升级方法」这个标题、`image-storage.md` 里没有「外置图床」，
所以这两条**去掉了 anchor**，只链到文件。
⚠️ 「关于」页里保留的上游链接是**刻意的**（致谢 + 官方入口），别当成漏改的死链一起清掉；
`tests/unit/aboutPage.test.js` 会做全仓扫描：除 `pages/About.tsx` 外不许再出现
`vanblog.mereith.com/<小写路径>`，同时会**逐个检查新链接指向的仓库文件真实存在**
（别把一批死链换成另一批死链）。

⚠️ 验证后台文案时注意：umi dev 的 JSX 文本子节点会被 babel 转成 `\uXXXX` 转义
（`children: "\u589E\u5F3A\u4FEE\u6539\u7248"`），直接 `grep 中文` 在 chunk 里搜不到，
但数组/字符串字面量是原样的 —— 别据此误判"改动没生效"。

### 7.22 镜像构建：pnpm 补丁必须进构建上下文（源码构建的第一道坎）

用 `scripts/vanblog.sh` 的源码构建装的时候，`docker build` 在这里直接失败：

```
> [website_builder 15/16] RUN pnpm install --frozen-lockfile:
ENOENT: no such file or directory, open '/app/patches/remark-supersub@1.0.0.patch'
```

**根因**：`pnpm.patchedDependencies` 写在**仓库根**的 `package.json` 里（那两个 ESM-only 的
remark 包要靠补丁补出 `main`/`module`，见 §7.14），而 `website_builder` 那一层只
`COPY` 了 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `tsconfig.base.json` /
`packages/website` —— **没有 `patches/`**。workspace 安装读得到根 manifest 的声明，
却找不到补丁文件，于是 ENOENT。

**还有一个躲在后面的同类问题**：`admin_builder` 那一层是 `COPY ./packages/admin/ ./` 然后
`pnpm i`，属于**独立安装**（没有仓库根 manifest），所以它**根本看不到**根上的
`patchedDependencies` → 两个包不会被补丁 → umi3 的 MFSU 解析器报
`AssertionError: filePath not found of remark-github-blockquote-alert`，构建同样失败。

修法：`admin_builder` 与 `website_builder` 都加 `COPY ./patches ./patches`。

⚠️ **当时的第二半修法已废弃，别再照做**：我一度让 `packages/admin/package.json` 也镜像声明一份
`pnpm.patchedDependencies`（因为那一层是独立安装、看不到根 manifest），代价是每次在仓库根跑
`pnpm install` 都会打一条 `The field "pnpm" was found in packages/admin/package.json.
This will not take effect.`。后来 `admin_builder` 改成了**和 website_builder 一样的 workspace
安装 + `--frozen-lockfile`**（见 §7.27），根 manifest 直接可见，那份镜像声明就成了纯噪音，已删除
（WARN 也随之消失）。守卫测试现在断言的是**反面**：`packages/admin/package.json` 里
不许再出现 `pnpm.patchedDependencies`。

**还要把被补丁的包钉死到精确版本**：`packages/admin/package.json` 与 `packages/website/package.json`
里 `remark-supersub` 与 `remark-github-blockquote-alert` 已从 `^1.0.0` / `^2.1.0` 改成
`1.0.0` / `2.1.0`（`pnpm-lock.yaml` 同步只改了 4 行 specifier，`--frozen-lockfile` 依然通过）。
原因：`patchedDependencies` 的键是 `name@精确版本`，写成 `^2.1.0` 的话上游一发布 2.1.1
就可能解析到新版 → 补丁不匹配 → pnpm 8 直接 `ERR_PNPM_PATCH_NOT_APPLIED` 让构建失败。
（当时 admin 那层还是独立安装、连 lockfile 都没有，风险更大；改成 workspace 安装后
lockfile 也会兜一层，但精确版本这条仍然保留 —— 补丁本来就是版本相关的。）
（查过 registry：这两个包目前 1.0.0 / 2.1.0 就是最新版，所以现在是"防患于未然"。）
守卫测试里有 4 条断言盯着这件事，谁把 `^` 加回来就会红。

顺手把 Dockerfile 的 18 条 buildkit 警告清了：阶段名统一小写
（`ADMIN_BUILDER`→`admin_builder`、`SERVER_BUILDER`、`WEBSITE_BUILDER`、`RUNNER`→`runner`）、
`FROM … as` 的大小写统一成 `AS`、`ENV key value` 全部改成 `ENV key=value`。
⚠️ 改阶段名要同步改所有 `COPY --from=`，还有 `scripts/tests/dockerfile-alpine-sharp.test.sh`
里按名字切 stage 的 awk（已同步）。

**新增 `scripts/tests/dockerfile-patches.test.sh`（21 条断言）**，专门守这类问题：
根 manifest 声明的每个补丁文件都在仓库里、`pnpm-lock.yaml` 记录了同样的 `dep -> path`、
`packages/admin/package.json` 与根声明**逐条一致**、`website_builder` 与 `admin_builder`
都真的有 `COPY ./patches ./patches`（**整行精确匹配**，否则 `COPY ./patches-REMOVED` 也能蒙过去 ——
第一版就是这么漏的）、每个 `COPY --from=` 都能对上已声明的阶段、阶段名与 `ENV` 形式合规、
`vanblog.sh` 确实从源码树构建。三个负向对照都验过：删掉 website 的 COPY、删掉 admin 的 COPY、
把 `--from` 改成不存在的阶段名，测试都会红。

⚠️ **本机跑不了 `docker build`**（没有 docker 组权限，daemon socket 拒绝连接），所以这一类改动
只能靠静态断言 + `pnpm` 的最小复现实验来验证：想确认「独立安装认不认 manifest 里的
`patchedDependencies`」，建一个只有一个小依赖的临时项目、把补丁和声明拷进去跑
`pnpm install --ignore-scripts`，然后看 `node_modules/<pkg>/package.json` 里有没有
补丁加的 `main` 字段（实测 `remark-supersub` 装完是 `main: lib/index.js`，即补丁生效）。
⚠️ 还有一点血的教训：**别对含未提交改动的文件跑 `git checkout <file>`** ——
我做负向对照时用它还原 Dockerfile，结果把没提交的修复一起冲掉了，只能重做一遍。
要还原就用之前 `cp` 出来的备份。

### 7.23 源码构建第二道坎：`VAN_BLOG_SERVER_URL` 为空让 `next build` 挂掉

补丁问题解决后，构建往前走了一大步（`pnpm install --frozen-lockfile` 过了、
`✓ Compiled successfully`），然后死在**收集页面数据**阶段：

```
TypeError [ERR_INVALID_URL]: Invalid URL
    at new URL (node:internal/url:676:13)
    at 485 (/app/packages/website/.next/server/chunks/324.js:6:9051)
  input: '',            ← 关键线索：传给 new URL 的是**空串**
Error: Failed to collect page data for /about
```

**成因链**（每一环单看都"合理"）：

1. `packages/website/utils/loadConfig.ts` 在**模块顶层**执行
   `new URL(process.env.VAN_BLOG_SERVER_URL ?? "http://localhost:3000")`；
2. `??` **只拦 undefined/null，拦不住空串**；
3. Dockerfile 是 `ARG VAN_BLOG_BUILD_SERVER` + `ENV VAN_BLOG_SERVER_URL=${VAN_BLOG_BUILD_SERVER}`
   —— **不传这个 build-arg 时 ENV 就是空串**，不是"未定义"；
4. 上游 CI 三个 workflow 都显式传了 `VAN_BLOG_BUILD_SERVER=http://localhost:3000`，所以从没暴露；
   而本分支的 `scripts/vanblog.sh` 只在**用户自己设了** `VANBLOG_BUILD_SERVER` 时才传 → 默认路径必炸。

栈里只有一串 webpack chunk 编号（`chunks/324.js:6:9051`），完全看不出是环境变量为空 ——
唯一有用的线索是 `input: ''`。

**三层一起修**（少一层都还会以别的方式炸）：

1. `Dockerfile`：`ARG VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000` 给默认值；
2. `scripts/vanblog.sh`：**总是**传 `--build-arg VAN_BLOG_BUILD_SERVER=…`
   （默认 `http://127.0.0.1:3000`，用户设了 `VANBLOG_BUILD_SERVER` 就用用户的），
   删掉原来那个"没设就不传"的分支；两份脚本仍要字节一致；
3. `utils/loadConfig.ts`：抽出纯函数 `resolveServerUrl()`，**空串 / 纯空白 / 非法 URL /
   非 http(s) 协议一律回退默认值**（`new URL("localhost:3000")` 不会抛，它把 `localhost`
   当协议，所以必须显式校验 `url.protocol`）。

⚠️ **修的时候我自己踩了第二个坑，而且是全站 500 级别的**：兜底分支直接
`return DEFAULT_SERVER_URL`，而常量写的是 `"http://localhost:3000"`（**没有尾斜杠**）。
调用方全是 `` `${config.baseUrl}api/public/meta` `` 这种拼法（路径不带前导斜杠，见
`api/getAllData.ts`、`api/getArticles.ts`），于是拼出 `http://localhost:3000api/public/meta`
→ `new URL()` 抛 `ERR_INVALID_URL` → **前台每个页面都 500**。
以前那个尾斜杠是 `new URL(x).toString()` 顺带补上的，兜底分支绕过了它就漏了。
现在：默认值本身带尾斜杠，且 `resolveServerUrl` 对**任何**输入都保证结果以 `/` 结尾
（`https://host/api` 这种带前缀的也要补，否则会拼成 `…/apiapi/…`）。
测试里有一条不变式：九种输入 × `base.endsWith("/")` × `new URL(base + "api/public/meta")` 不抛。

**教训**：凡是"原来由某个函数顺带保证的格式"（这里是尾斜杠），加兜底分支时必须把那个格式一起兜住；
改完**必须真的 curl 几个页面**，光看测试绿不算（这次测试是绿的，页面全 500）。

**本地怎么复现/验证**（这台机器没有 docker 权限）：

```bash
cd packages/website
isBuild=t VAN_BLOG_SERVER_URL='' NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build
```

- `isBuild=t` 必须带：否则 `next build` 会跑类型检查，撞上 `mdast-util-mark` 依赖自身的
  类型错误（既有问题，见 §7.10）而失败，跟本问题无关。
- 期望结果：日志里出现「无法连接，采用默认值」，然后 `✓ Generating static pages (8/8)`、`EXIT=0`。
  **构建期连不上 server 是正常的**（容器里那时候还没有 server），页面走兜底数据，
  运行时再由 runner 阶段的 ENV 覆盖成真实地址 —— 上游 CI 也是这么构建的。
- ⚠️ 跑完 `next build` 之后 **`next dev` 会 500**：生产和开发共用 `.next` 目录。
  必须 `rm -rf packages/website/.next` 再 `./dev-env.sh start`。

**新增/扩充的测试**：`packages/website/__tests__/serverUrlConfig.spec.ts`（6 条：空值回退、
非法与非 http 协议回退、合法地址规范化、尾斜杠不变式、源码里不再有裸 `new URL(process.env…)`、
Dockerfile 与两份脚本都带默认值）；`scripts/tests/dockerfile-patches.test.sh` +3（ARG 默认值、
脚本总传 build-arg、不再有"没设就不传"的分支）；`vanblog-source-install.test.sh` 的构建参数断言
改成同时校验两个 `--build-arg`，并新增"用户自定义 server 地址优先"的用例。

### 7.24 源码构建第三道坎：admin 构建 OOM（cross-env 把堆上限吃掉了）

补丁（§7.22）与空 server URL（§7.23）都过了之后，构建死在 `admin_builder` 的 `pnpm build`：

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[27:0x…] 59779 ms: Mark-sweep (reduce) 475.9 (486.1) -> 475.4 (486.9) MB
```

**486MB 就炸**，而 Dockerfile 的 admin_builder 明明写了
`ENV NODE_OPTIONS='--max_old_space_size=4096 --openssl-legacy-provider'`。原因是：

```jsonc
// packages/admin/package.json
"build": "cross-env NODE_OPTIONS=--openssl-legacy-provider umi build"
```

`cross-env NODE_OPTIONS=X` 是**整体替换**这个变量，不是追加 —— 镜像 ENV 里的
`--max_old_space_size=4096` 被直接丢掉。于是 Node 退回"按可用内存启发式决定堆上限"，
而 `docker build` 会**并发跑 admin / server / website 三个 stage**，可用内存被挤掉，
启发式就给了个几百 MB 的堆，构建到一半必然 OOM。

修法（改脚本，不是改 Dockerfile）：

```jsonc
"build":   "cross-env NODE_OPTIONS=\"--openssl-legacy-provider --max_old_space_size=4096\" umi build",
"analyze": "cross-env NODE_OPTIONS=\"--max_old_space_size=4096\" ANALYZE=1 umi build"
```

⚠️ 两个 flag 必须在**同一个** `NODE_OPTIONS` 赋值里（带引号），分成两次 `cross-env` 只会保留一个。
Dockerfile 里那行 ENV **保留**（`pnpm i` 与 `postinstall` 的 `umi g tmp` 不走 cross-env，仍然吃它），
但已在原处注明它对 `pnpm build` 不起作用 —— 否则下一个人会以为调 ENV 就能调构建内存。
`tests/unit/buildMemory.test.js`（4 条）盯着这件事：build/analyze 都带堆上限、两个 flag 在同一个赋值里、
不许退回旧写法、Dockerfile 的 ENV 与说明注释都还在。

**本地已真跑过一次生产构建验证**（这台机器没有 docker 权限，但 `pnpm build` 与镜像里那一步是同一条命令）：

```bash
cd packages/admin && ../../../.tools/node_modules/.bin/pnpm build   # 约 4 分钟，EXIT=0，dist 24MB
```

顺带这也是**第一次**验证本分支所有后台改动能过生产构建（markdown 插件、评论管理页、
补封面弹窗、关于页、编辑器字体）—— 以前只跑过 dev（MFSU）与单元测试。
⚠️ 跑完记得 `rm -rf packages/admin/dist`（在 .gitignore 里，但别留着占地方）。

### 7.25 低配机器自适应构建 + pnpm 源自动选择

两个都是"源码构建在真机上跑不起来 / 跑得太慢"的问题。

**1. 低配机器：`docker build` 默认并发跑三个重 stage**

BuildKit 会**并发**构建互不依赖的 stage：`admin_builder`（umi build，峰值 1.5-2GB）、
`server_builder`（nest build，~1GB）、`website_builder`（next build，2-4GB）。
在 1C2G 的小机器上三个一起跑必然 OOM，而且失败点在第 10-20 分钟，排查成本极高。

`scripts/vanblog.sh` 现在构建前先量本机（`detect_host_resources`）：
CPU 用 `nproc`（比 `/proc/cpuinfo` 更接近真实可用），内存用 `/proc/meminfo` 的
**`MemAvailable`**（含可回收 cache，比 `MemFree` 靠谱），拿不到再退 `MemTotal` / `free -m`；
**docker 自己有配额时以配额为准**（`docker info --format '{{.MemTotal}}'`，Docker Desktop
默认只给 2GB，宿主机 32GB 也没用）。

然后 `classify_build_profile <cpus> <mem_mb>`（**纯函数，可喂假数据测试**）定档：

| 条件 | 档位 | 行为 |
| --- | --- | --- |
| 可用内存 <1.8GB | 劝退 | 不跑 `docker build`，直接返回 1 并给出两条出路（见下） |
| <3.5GB | `lowmem` | 串行 + admin 用 `build:lowmem`（堆 1536MB） |
| CPU <2 | `balanced` | 串行（并发只会互相抢 CPU，不会更快），admin 满堆 |
| <7GB 或 <4 核 | `balanced` | 串行 |
| 其余 | `fast` | 并发（最快） |

**串行怎么实现**：BuildKit 没有暴露"限制 stage 并发"的开关，所以改成**分步构建** ——
先 `docker build --target admin_builder` / `server_builder` / `website_builder` 各跑一次
（一次只有一个重活），最后一次全量 `docker build` 三步全部命中缓存、只组装 runner。
⚠️ 中间步骤**不要 `-t`**：打了 tag 会多留三个 1-2GB 的镜像，小机器磁盘吃不消；
不打 tag 层缓存照样生效。

**劝退时给两条出路**（不是简单报错）：
`VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh`（用官方镜像，能跑起来但不含本分支改动）
或 `VANBLOG_FORCE_BUILD=true ./vanblog.sh`（我知道会失败，还是要试）。
⚠️ 内存探测失败（返回 0）时**不劝退**，按保守的串行档走 —— 宁可慢，不要莫名其妙不给装。

**admin 堆上限怎么传进去**：不能靠 Dockerfile 的 `ENV NODE_OPTIONS`（cross-env 会整体替换，
见 §7.24），也不要用 `cross-env-shell` 拼 `${VAR:-default}`（实测三层引号传递后输出是空的）。
最终方案是**换脚本名**：`package.json` 里放两档
`build`（`--max_old_space_size=4096`）与 `build:lowmem`（`1536`），
Dockerfile 用 `ARG VAN_BLOG_ADMIN_BUILD_SCRIPT=build` + `RUN pnpm run ${VAN_BLOG_ADMIN_BUILD_SCRIPT}`，
脚本按档位传参 —— 全程没有任何引号嵌套问题。

**两档都本地真跑过**（这台机器没 docker 权限，但 `pnpm run build` 与镜像里那一步是同一条命令）：
`build`（4096）EXIT=0、约 4 分钟、dist 24MB；`build:lowmem`（1536）同样 EXIT=0、dist 24MB
—— 也就是说 1536MB 这一档是**真的够用**，不是拍脑袋写的数字（umi3 + antd 的生产构建
实际峰值在 1.5GB 以内）。跑完记得 `rm -rf packages/admin/dist`。

**2. pnpm 源自动选择**

以前 `admin_builder` 那层硬编码 `registry.npmjs.org`，其余三层用 `npmmirror` ——
国内直连 npmjs 只有 200-350KB/s，这就是 admin 的 `pnpm i` 跑了 563 秒还没完、
而 website 那层只用 138 秒的原因（实测本机：npmmirror 207ms vs npmjs 1965ms，差 9.5 倍）。

现在四层统一用 `ARG VAN_BLOG_NPM_REGISTRY`（默认 npmmirror），由脚本探测后传入：
`detect_npm_registry` 拿一个真实存在的小包（`/cross-env`）当探针，各 8 秒超时比 `time_total`，
取更快的；某个源不可达就用另一个；**两个都不可达**（构建机不通外网）就用默认值并明确提示。
用户可以用 `VANBLOG_NPM_REGISTRY=<url>` 直接指定（此时不探测）。
海外机器上 npmjs 更快，探测会自动选它 —— 别把它写死成 npmmirror。

⚠️ **BuildKit 的 ARG 作用域**：`FROM` 之前声明的 ARG 是"全局"的，但**在具体 stage 里要用必须
再 `ARG <name>` 一次**，否则取到空值（表现是 `pnpm config set registry  -g` 然后回退默认源，
很难发现）。四个 stage 都补了，守卫测试会数"用了变量的 stage 数 == 重新声明过的 stage 数"。

**测试**（`scripts/tests/vanblog-source-install.test.sh` 从 43 条涨到 92 条）：
八种 CPU/内存组合的档位判定、三种手动档位、资源探测的取值形状、
registry 探测的四种情形（npmmirror 快 / npmjs 快 / 一个不可达 / 都不可达）+ 用户指定、
并发与串行两种模式的 docker 命令（串行必须正好 4 次 build、三个 `--target`）、
劝退路径（返回 1、一次 docker build 都不跑、提示里给出两条出路、`VANBLOG_FORCE_BUILD=true` 时照跑并提醒 OOM）。
`dockerfile-patches.test.sh` 从 21 涨到 40 条（两个新 ARG 的默认值、四个 stage 都重新声明过 ARG、
admin 用 `${VAN_BLOG_ADMIN_BUILD_SCRIPT}`、两档脚本都存在且都带堆上限）。

⚠️ 写 shell 测试踩到的坑（都真踩过，别再踩）：
- **假命令的日志文件必须 `export`**：假 `docker`/`git` 是子进程，靠 `"${CMDLOG}"` 记命令；
  不 export 时它们写到空文件名，CMDLOG 永远是空的 —— 于是所有 `assert_not_contains`
  都"通过"（空文件当然什么都不含），`assert_file_contains` 全挂。**空的 CMDLOG 会让
  一批否定断言变成假绿**，比测试失败更危险。
- **shell 函数桩会跨用例残留**：某个用例里定义过 `docker() { … }`，后面的用例即使把假二进制
  放进 PATH 也不会被调用（函数优先级高于 PATH）。`setup_case` 里要 `unset -f docker curl git …`。
- **别把新用例追加到文件末尾** —— 这些测试文件的结尾是 `echo passed=… ; exit 0`，
  追加在后面永远不会执行（我第一次就是这么写的，92 条里只跑了 45 条还以为过了）。
- **别用 `OUT="$(fn)"` 断言函数设置的全局变量** —— 命令替换是子 shell，赋值会丢；
  要断言就 `fn >"$LOG" 2>&1` 然后再看变量。
- `source_script` 里要**把新加的环境变量一起 unset**，否则上一个用例设的
  `VANBLOG_BUILD_SERVER` 会漏到下一个用例（我这次就被它坑了一条断言）。

### 7.26 把镜像发布到 ghcr.io：让安装回到「docker pull 就能装」

**动机**：上游用户从来不需要构建 —— 作者在 CI 里构建好镜像推到 Docker Hub，用户只 `docker pull`。
本分支没有发布镜像，一键脚本就只能 clone + 本地 `docker build`，于是**构建从 CI 挪到了用户机器上**，
内存要求也跟着挪过去（umi build 峰值 1.5-2GB、next build 2-4GB，BuildKit 还会并发跑三个 stage）。
1C1G 的机器"跑"得动（三个 node 进程一共 ~120MB），但"装"不上 —— 这才是根因。

**`.github/workflows/publish-ghcr.yml`**：**手动 dispatch** 或**推 `v*` tag** 时构建并推到
`ghcr.io/ckboss/vanblog`，标签有 `latest` / `dev-dsh` / `dev-dsh-<短sha>`（tag 事件则用 tag 名，
并且 tag 也会更新 `latest`）。

⚠️ **不在 push 分支时自动构建**：一次构建要 20-40 分钟 runner，而这个分支一天能推几十次
（大多是文档与测试），每次 push 都发一版既浪费额度也没意义。要自动化的话，
workflow 里已经留好了注释掉的 `branches:` + `paths:` 过滤段（只在 `packages/**`、`patches/**`、
`Dockerfile`、`pnpm-lock.yaml`、`package.json` 变化时构建），放开即可。
**副作用要说清楚**：`dev-dsh` 标签对应的是**最后一次手动发版时的代码**，不等于分支最新提交；
想装最新提交得用 `VANBLOG_INSTALL_MODE=source ./vanblog.sh` 自己构建。
- **只用 `secrets.GITHUB_TOKEN`**（`permissions: packages: write`），不需要配任何 secret ——
  上游的 `release.yml` 用的是作者的 `DOCKERHUB_USERNAME/TOKEN`，fork 里没有，跑不起来。
- 默认**只出 `linux/amd64`**：arm64 要 QEMU 模拟，next/umi 的生产构建慢好几倍还容易超时。
  `workflow_dispatch` 有 `platforms` 输入可以手动加 `linux/arm64`。
- 构建参数：`VAN_BLOG_VERSIONS=<分支>@<短sha>`、`VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000`
  （⚠️ 必须传，见 §7.23）、`VAN_BLOG_NPM_REGISTRY=https://registry.npmjs.org`
  （GitHub 的 runner 在海外，直连 npmjs 比走 npmmirror 快 —— 与本地开发相反）、
  `VAN_BLOG_ADMIN_BUILD_SCRIPT=build`。
- `cache-from/cache-to: type=gha` 让重建快很多；`concurrency` 限制同分支只跑一次。
- ⚠️ **ghcr 的 package 默认是 private 且绑定仓库**：第一次跑完要去
  `https://github.com/CKboss/vanblog/pkgs/container/vanblog` → Package settings →
  Change visibility → **Public**，否则别人 `docker pull` 会要求登录。
  workflow 的 step summary 里也写了这条提醒。

**`scripts/vanblog.sh` 改成「镜像优先，源码兜底」**：

```
VANBLOG_USE_UPSTREAM_IMAGE=true  → 上游官方镜像（优先级最高，不含本分支改动）
VANBLOG_INSTALL_MODE=image       → 只拉 VANBLOG_IMAGE_REF，拉不到就失败（不偷偷构建）
VANBLOG_INSTALL_MODE=source      → 只 clone + 本地构建
VANBLOG_INSTALL_MODE=auto（默认）→ 先 docker pull；失败才退回源码构建
```

`auto` 的退回是有意义的：镜像还没发布、机器不通 ghcr.io、或者架构不匹配（只发了 amd64
而机器是 arm64）时，`docker pull` 会失败，脚本打印原因后走 §7.25 的自适应源码构建。
`Docker_IMG` 最终值由 `prepare_vanblog_image` 决定，`ensure_compose_image` 再写进编排文件
（ghcr 地址带斜杠，sed 分隔符是 `|`，这个以前就处理过了）。

⚠️ **镜像名必须全小写**：`github.repository` 是 `CKboss/vanblog`，**owner 带大写字母**，
而 ghcr（和 Docker 一样）要求镜像引用全小写 —— 直接拼会得到 `ghcr.io/CKboss/vanblog`
→ `invalid reference format`，而且是在构建之后才报，白烧几十分钟 runner。
Actions 表达式里**没有 `lower()` 函数**，所以用一个 shell step `tr '[:upper:]' '[:lower:]'`
算出 `steps.image.outputs.name`，并在同一个 step 里校验（发现大写立刻 `::error::` 退出）。

另外加了一个「打印本次构建参数」step：镜像名 / 标签 / 架构 / 版本 / 三个 build-arg / 磁盘可用。
远程 CI 失败时看不到本地环境，先把生效参数打出来能省掉一轮猜测
（第一次跑就失败了，而 `actions/jobs/<id>/logs` 对未认证请求返回 **403**，
即使仓库是 public 也拿不到日志 —— 只能靠 workflow 自己把信息吐到可见的 step 输出里）。

**排查第一次构建失败时顺手验证的一件事**：在 `/tmp` 里按 `website_builder` 的目录结构
（根 `package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml` + `tsconfig.base.json` +
`patches/` + 只有 `packages/website`）跑**完全相同**的命令
`pnpm install --frozen-lockfile --ignore-scripts` → **EXIT=0**，
说明钉死版本之后的 lockfile 是同步的，失败与它无关。
（注意：`pnpm install --frozen-lockfile --lockfile-only` 是个**弱验证**，它只写 lockfile，
不能代替真装一次。要验就按上面那样搭个最小工作区。）

**测试**：`vanblog-source-install.test.sh` 从 92 涨到 133 条 —— 默认模式与默认镜像地址、
auto 拉到镜像时**一次 build 和 clone 都不发**、auto 拉不到时退回构建并说明、
image 模式拉不到就直接失败不偷偷构建、source 模式一次 pull 都不发、
`VANBLOG_IMAGE_REF` 覆盖、`VANBLOG_USE_UPSTREAM_IMAGE` 仍然优先、编排文件写入 ghcr 地址、
以及 workflow 文件本身的契约（`packages: write`、ghcr.io、用 GITHUB_TOKEN、
**不再引用 DOCKERHUB_TOKEN**、四个 build-arg 都在、gha 缓存、Public 可见性提醒）。
⚠️ 既有用例里有几条是断言"prepare 之后 Docker_IMG 变成本地 tag"的，默认模式改成 auto 之后
它们会走到 pull 分支 —— 已全部显式钉上 `VANBLOG_INSTALL_MODE=source`。
假 docker stub 也加了 `DOCKER_PULL_FAIL=1` 来模拟拉取失败。
⚠️ 又踩了一次「`OUT="$(fn)"` 是子 shell，全局赋值会丢」的坑（§7.25 记过），
这次改成 `fn >"$LOG" 2>&1` 再读文件。
⚠️ 还有一条：`assert_file_contains` 的针是 **grep BRE**，里面的 `*`、`[`、`]` 都要转义
（`v*` 会变成"零个或多个 v"，`[:upper:]` 会被当成字符类），否则会误报"文件里没有"。

**镜像发布成功之后，脚本这边还要配套改三件事**（都是审查时发现的，不是可选项）：

1. **`update` 的顺序：先备好新镜像，再停旧容器。** 旧实现是先
   `vanblog_compose down --remove-orphans` 再 pull/build —— 拉镜像几十秒、源码构建 15-40 分钟，
   整段时间**站点是停的**；构建失败时更是"白白停机一次，再把旧容器起回来"。
   现在改成：上游模式先 `pull vanblog`、本分支模式先 `prepare_vanblog_image` +
   `ensure_compose_image`，**都成功之后**才 down/up。准备失败直接返回，
   正在跑的容器全程不动，停机时间只剩重启那几秒。
   ⚠️ `old_cid/old_image/old_version` 的采集必须放在 **prepare/pull 之前**：
   否则"版本有没有变"就比不出来了 —— 先 pull 再读，读到的已经是新版本，
   于是永远打印"已经是最新版本"，更新成功也报不出来（我第一版就是这么改错的，
   `vanblog-update.test.sh` 的 success path 三条断言立刻红了，是它拦住的）。
   读的是**运行中容器**的镜像 id，先 pull 一个新 tag 不会影响它。
   同理，`vanblog-update.test.sh` 里"down 失败时没 pull"这条旧不变式也失效了：
   现在 pull 在 down 之前，先拉镜像对运行中的容器无影响，真正要保证的是
   **down 失败就不再 up**（不把栈停在半死不活的状态）。
2. **拉取失败要按原因给具体下一步**：`pull_fork_image` 把 `docker pull` 的输出接住再打印，
   然后按关键字分流 —— `denied/unauthorized/authentication` → 提示 ghcr 包默认 private，
   给出 package 设置页地址与"Change visibility → Public"；`no matching manifest`/`not found`
   → 提示是架构问题（目前只发布 linux/amd64）并说明怎么用 workflow_dispatch 出 arm64；
   其它 → 通用解释（还没发布 / 网络不通）。笼统一句"拉取失败"等于让人自己猜。
3. **从本地构建切到拉镜像后，旧的本地镜像会一直占着磁盘**（~1.5GB）。
   `hint_stale_local_image` 只在"当前用的不是本地 tag 且本地 tag 还存在"时提示
   `docker rmi vanblog:dev-dsh`，**不自动删** —— 删镜像不可逆，而且用户可能还想切回源码模式。

**测试**：`vanblog-source-install.test.sh` 133 → 147 条，包含
「`update()` 函数体里 `prepare_vanblog_image` 的行号必须小于 `down --remove-orphans` 的行号」
这种**源码顺序断言**（用 awk 切出函数体再比行号，比重放整个 update 流程稳）、
准备失败时一次 down 都不发生、三种拉取失败各自的关键字提示、
以及"仍在用本地镜像时不许提示删除"（否则等于让人删掉正在用的镜像）。

### 7.27 admin_builder 必须走 lockfile：cytoscape 事故的始末

CI 上第一次真正跑到 admin 构建时挂在这里：

```
error in ./node_modules/.pnpm/mermaid@10.6.1/node_modules/mermaid/dist/mindmap-definition-617cf8dd.js
Module not found: Error: Package path ./dist/cytoscape.umd.js is not exported from
package /app/node_modules/.pnpm/mermaid@10.6.1/node_modules/cytoscape
  (see exports field in .../cytoscape/package.json)
```

**根因不是 mermaid，是「没有 lockfile」**：`admin_builder` 那一层当时是独立安装
（`COPY ./packages/admin/ ./` + `pnpm i`），**每次构建都重新解析依赖版本**。
`mermaid@10.6.1`（admin 里钉的是精确版本）内部要 `cytoscape/dist/cytoscape.umd.js`；
仓库 lockfile 锁的是 `cytoscape@3.27.0`，它的 `exports` 里**有**这条子路径，
而独立安装解析到的更新版 cytoscape 把 `exports` 收紧了 → webpack 找不到模块。

对照证据很硬：**`website_builder` 一直用 `--frozen-lockfile`，从来没出过这个问题**，
而且就在同一次失败的构建里它成功了（76.3s，8 个页面全生成、路由表都打出来了）。
所以修法不是给 cytoscape 加 override 或再写一个补丁，而是**让 admin 也走 lockfile**：

```dockerfile
FROM node:18-alpine AS admin_builder
COPY ./package.json ./            # 根 manifest（带 patchedDependencies）
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
COPY ./patches ./patches
COPY ./packages/admin ./packages/admin
RUN pnpm install --frozen-lockfile
WORKDIR /app/packages/admin
RUN pnpm run ${VAN_BLOG_ADMIN_BUILD_SCRIPT}
```

**连带必须改的一处**：runner 取产物的路径从 `/app/dist/` 变成 **`/app/packages/admin/dist/`**
（布局从「admin 就是 /app」变成「workspace 根是 /app」）。⚠️ 这个忘了改的话镜像**能构建成功**，
但后台页面全是 404 —— 比构建失败更难查。

顺带的好处：依赖版本可复现、与本地开发和 website/server 层完全一致，不会再有「CI 挂了本地好的」；
根 manifest 的 `patchedDependencies` 直接生效（admin 里那份镜像声明因此删掉，WARN 也没了）；
manifest 与 lockfile 不同步时 `--frozen-lockfile` 会**立刻失败**，而不是悄悄装个新版本。

⚠️ 代价：这一层现在也受 lockfile 约束 —— 改了 `packages/admin/package.json` 的依赖之后
**必须**在仓库根跑一次 `pnpm install`（或 `--lockfile-only`）更新 lockfile，
否则镜像构建会报 `ERR_PNPM_OUTDATED_LOCKFILE`。

**本地怎么验证**（没有 docker 权限也能验，这一层的命令就是普通 pnpm）：

```bash
rm -rf /tmp/absim && mkdir -p /tmp/absim/packages
cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json /tmp/absim/
cp -r patches /tmp/absim/ && cp -r packages/admin /tmp/absim/packages/
cd /tmp/absim && pnpm install --frozen-lockfile   # → EXIT=0，装到 cytoscape@3.27.0
cd packages/admin && pnpm run build               # → EXIT=0，dist 24MB，无 Module not found
```

实测就是这么过的：装完 `node_modules/.pnpm/` 下确实是 `cytoscape@3.27.0`（lockfile 锁的那个），
构建 EXIT=0，日志里 `cytoscape` / `Module not found` 出现 **0 次**。

**守卫**（`dockerfile-patches.test.sh` 30 → 36 条）：admin_builder 必须拷
`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `patches`、
必须用 `--frozen-lockfile`、必须 `WORKDIR /app/packages/admin`、runner 必须从
`/app/packages/admin/dist/` 取产物；另外 `packages/admin/package.json` 里**不许**再有
`pnpm.patchedDependencies`（§7.22 那个已废弃的做法）。

### 7.28 镜像跑起来才暴露的两个问题：幻影依赖与 caddy 模板漂移

镜像发布、`docker pull` 成功、容器起来了 —— 然后**打不开任何页面**。日志里是两条独立的致命错误，
都属于"本地/dev 永远碰不到，只有真镜像才会暴露"的类型。

**1. `Cannot find module 'multer'`（server 直接崩，我的代码引入的）**

```
Error: Cannot find module 'multer'
Require stack: /app/server/controller/admin/backup/backup.controller.js
```

`backup.controller.ts` 里 `import { diskStorage } from 'multer'`（整站备份的恢复上传要落盘，
不能用默认的内存存储），但 **`multer` 从来没写进 `packages/server/package.json`** ——
它只是 `@nestjs/platform-express` 的间接依赖（典型的**幻影依赖 / phantom dependency**）。
pnpm 的严格布局下间接依赖是不可见的，镜像里 `/app/node_modules` 又是从 server_builder
直接 COPY 过来的，于是启动即崩。

修法：`packages/server/package.json` 显式声明 `"multer": "1.4.4-lts.1"`
（**和 `@nestjs/platform-express@9` 用的是同一个版本**，避免装两份），并刷新 `pnpm-lock.yaml`。
顺带把上传的 `limits` 收紧了：原来只有 `fileSize: 8GB`（备份确实可能很大），
但 multer 1.x 的主要 DoS 面是**不限数量的 parts/fields/files** —— 一个几十万个空 part 的
multipart 请求能打满事件循环。现在补了 `files: 1 / fields: 8 / parts: 32 / headerPairs: 64`。

⚠️ 关于版本：`pnpm install` 会提示 `Multer 1.x is impacted by a number of vulnerabilities,
patched in 2.x`。这里**故意留在 1.4.4-lts.1**：它是 Nest 9 的 platform-express 自己钉的版本，
换成 2.x 会让一个应用里出现两份 multer、而且 `FileInterceptor` 走的是 1.x；
这个接口是 AdminGuard 保护的，加上上面的 limits，风险面可控。

⚠️ **本地为什么没暴露**：本地 dev 用 tsc watch + `nest start`，解析路径和镜像里不一样，
`require.resolve('multer', {paths:['packages/server']})` 在本机其实也是 **MODULE_NOT_FOUND** ——
也就是说"本地能跑"根本不能证明依赖声明是对的。所以有了下面这个扫描。

**新增 `scripts/tests/image-runtime.test.sh`**（专门守"只有真镜像才会暴露"的问题）：
扫描 `packages/{server,website,admin,cli,waline}` 的源码，把所有
`import … from 'x'` / `require('x')` 的裸包名和各自 `package.json` 的
`dependencies + devDependencies` 对账（排除 Node 内建模块、`src/` 与 `@/` 路径别名、
umi 运行时注入的 `umi`/`@@/exports`、以及 `.css/.less/.json` 这类资源），
**断言前先剥掉注释**（`utils/ip.ts` 里有一行被注释掉的 `// import publicIp from 'public-ip'`，
不剥就会误报）。现在五个包全绿：0 个幻影依赖。

**2. `tls.issuance.zerossl: json: unknown field "email"`（caddy 起不来 → 没有 HTTP 入口）**

```
Error: loading initial config: … provisioning automation policy 0: …
       position 1: loading module 'zerossl': decoding module config:
       tls.issuance.zerossl: json: unknown field "email"
Error: caddy process exited with error: exit status 1
```

`caddyTemplate.json` 的 `apps.tls.automation.policies[0].issuers` 里有两个签发器：
`{"email":"VAN_BLOG_EMAIL","module":"acme"}` 和 `{"email":"VAN_BLOG_EMAIL","module":"zerossl"}`。
**较新的 Caddy 已经把 zerossl 模块的 `email` 字段去掉了**，于是整份配置加载失败、
caddy 进程退出 —— 容器还"在跑"，但 80/443 全都没了，比 server 崩了更难查
（`docker ps` 看着是正常的）。

根因是**版本漂移**：runner 阶段是 `apk add --no-cache caddy`，装的是构建当时的最新版；
上游镜像是在 Caddy 还接受 `email` 的时候构建的，所以一直没暴露。**每次重新构建镜像都会
重新掷一次这个骰子。**

修法：把 zerossl 那个 issuer 删掉，只留 acme（Let's Encrypt）。
理由：配置**加载失败 = 全站没有入口**，而"多一个签发器兜底"的收益远小于这个风险；
新版 zerossl 要 API key/EAB，没有凭据时它在签发阶段也会失败，留着只是增加噪音。
`on_demand` 与 `on_demand.ask`（`/api/admin/caddy/ask`，§7.18 加的按需证书白名单）**原样保留**。
`image-runtime.test.sh` 会盯着：模板必须是合法 JSON、issuers 里不许再有 zerossl、
必须有 acme 且带 email 占位、`on_demand.ask` 不许消失。

⚠️ 同类风险的通用教训：**镜像里由包管理器"装最新版"的东西（apk/apt 的系统包）都是漂移源**。
caddy 这次漂了，`zstd`/`xz`/`libwebp-tools`/`libavif-apps` 同样可能漂。
要彻底稳，得把 caddy 也钉版本（Alpine 的 `apk add caddy=2.x.y-rN` 会随仓库滚动而失效，
更可靠的是从官方 release 下载固定版本的二进制并校验 sha256）—— 这次没做，先记下。

**验证**：`packages/server` 全量 jest、`src/utils/cacheControl.spec.ts`（它本来就会读
`caddyTemplate.json` 断言 /admin 的 no-store 头）、`backup.controller.spec.ts` 全绿；
本地 server 重启后 `/api/admin/backup/full/formats` 返回 200（证明 multer 装对了、能跑）。
⚠️ 改了依赖之后**必须**在仓库根跑一次 `pnpm install`（不是 `--lockfile-only`），
否则本地 `node_modules` 里没有 multer，而 `--frozen-lockfile` 在 CI 里会直接失败。

### 7.29 一键脚本的整站备份与一步恢复（`./vanblog.sh backup` / `restore`）

以前脚本的 `restore` 只认自己 `backup` 打出来的 `vanblog-backup-*.tar.gz`（数据目录的原始 tar 包，
停服 → 解压覆盖 → 删 `mongod.lock` → 起服）。而 §7.6 的**整站备份** `vanblog-full-*.tar.zst`
是 server 导出的「各集合 NDJSON + waline 库 + 图床/附件 + sidecar 清单」，
**直接解压到数据目录是错的**（那是 mongo 的数据文件布局，不是 NDJSON），只能走 server 的
`POST /api/admin/backup/full/restore`。所以脚本现在按目标自动分流：

```
vanblog-full-*  / *.tar.zst / *.zst / *.tar.xz  → HTTP 接口恢复（不停服）
vanblog-backup-*.tar.gz / *.tgz                 → 原来的离线解压流程（停服）
```

**用法**：

```bash
./vanblog.sh restore                    # 不带参数：列出服务器备份目录里的归档，选一个
./vanblog.sh restore <归档名>            # 一步恢复；归档在服务器上时**不上传**（走 name=）
./vanblog.sh restore /path/to/x.tar.zst # 本地文件走 multipart 上传
./vanblog.sh restore <归档名> --no-static   # 只恢复数据库，保留当前图床/附件
VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh restore <归档名>   # 全自动
```

**几个实现要点**：

- **优先用 `name=` 而不是上传**：归档本来就在服务器备份目录
  （宿主机 `${VANBLOG_DATA_PATH}/log/vanblog-backups`，容器里的 `<log>/vanblog-backups`）时，
  传名字让 server 自己读，几百 MB 也省掉一次传输。只有给的是本地路径才上传。
- **认证**：`VANBLOG_ADMIN_TOKEN` 优先；否则交互式输入账号密码，脚本本地按
  `packages/admin/src/services/van-blog/encryptPwd.js` 的算法派生口令
  （`u=lower(username)`；`sha256(u + sha256(sha256(sha256(sha256(p)))) + sha256(u))`，
  用 `printf '%s' | sha256sum` 实现，**明文密码不出本机**）。
  ⚠️ 派生逻辑必须和后台逐字节一致，`scripts/tests/vanblog-restore.test.sh` 会真的调 node
  跑 `js-sha256` 做对照（含中文用户名/中文密码/混合大小写三组），别凭记忆改。
  ⚠️ 登录接口有失败限流（§7.18），所以**只试一次、不重试**。
- **接口地址**：从编排文件里读 vanblog 服务映射到容器 80 的宿主机端口（`get_compose_http_port`），
  拼 `http://127.0.0.1:<port>`；`VANBLOG_API_BASE` 可覆盖。恢复前先探 `/api/public/meta`，
  不通就明确提示「先 `./vanblog.sh start`」而不是丢一个 curl 错误。
- **恢复前先 `full/inspect`** 把清单打出来（备份时间、各集合条数、静态文件数），确认没选错版本。
- **确认要输 `yes`**（不是 y），`VANBLOG_ASSUME_YES=1` 才跳过 —— 这一步会覆盖全部数据。
- 恢复成功后 server 自己会 `isrProvider.activeAll('整站恢复触发全量渲染！')`，
  **脚本不需要重启容器**，也不要 `stop_vanblog`（测试里断言了走接口这条路一次 stop 都不发）。
- **JSON 输出别用 sed 硬拆**：第一版 `s/,"/,\n/g` 把嵌套对象拆得支离破碎。
  现在 `pretty_json` 有 python3 就 `json.dumps(indent=2)`，没有就原样打印一行
  （不硬依赖 jq/python3：小机器上不一定有）。
- 备份列表要**排除 `*.manifest.json`** sidecar（`vanblog-full-*` 这个 glob 会把它一起匹配上，
  第一版就把清单文件列成了一个"可恢复的备份"）。
- ⚠️ 脚本开头有 root 检查，所以本机验证要么用测试（`VANBLOG_SKIP_MAIN=1` + `source`），
  要么就别指望直接 `./vanblog.sh restore` 跑通。

**端到端实测过**（本机 dev，接口指到 :3000）：先把某篇文章的 `cover` 清空做成可观测的改动，
再 `restore <归档名>` → 脚本打印清单与「恢复成功」，数据库里那篇文章的封面**回来了**、
16 篇有封面的文章数也复原 ✓。

**备份也一起换了**：`./vanblog.sh backup` 现在默认调 `POST /api/admin/backup/full/export`
产出 `vanblog-full-*.tar.zst`（和后台「系统设置 → 备份」同一套逻辑），老的"打包数据目录"
降级成 `--offline`（另有 `--offline --consistent` 先停 mongo）。理由是那张对比表里的三件事：
一致性（不会拍到 mongod 写一半的数据文件）、跨版本可恢复（NDJSON 不绑 MongoDB 版本，
而数据目录 tar 换大版本 mongod 直接拒启）、可预览（恢复前能读清单）。
⚠️ 整站备份**不含 caddy 的证书与配置**（那些在数据目录里），所以要备证书必须 `--offline` ——
脚本每次备份成功都会把这句话打出来，别让用户以为"备了就是全备了"。
`--format zstd|xz|gzip` 透传给接口，非法值直接拒（不发请求）。
站点没起时**不偷偷降级**成打 tar：明确报错 + 给出 `start` 与 `--offline` 两条路
（静默降级会让人以为拿到的是一致性快照，其实不是）。
认证与接口地址复用 restore 那套（`VANBLOG_ADMIN_TOKEN` / 交互派生口令 / `VANBLOG_API_BASE`）。
⚠️ 探活那段别写成 `$(curl … || echo 000)`：curl 连接失败时 `-w '%{http_code}'` 已经输出过 `000`，
再补一个就变成 `000000`（restore 那边先踩的，两处都改了）。
实测：本机 dev 上 `backup 0` 产出 65.91MB / 29.9s / 15 集合 / 9838 文档 / 185 文件 ✓。

### 7.30 部署审计（2026-09）：一次性修掉的 12 个坑

用户装完之后"打不开设置页面"，顺着这条线把**部署全链路**审了一遍（脚本 / Dockerfile /
entrypoint / start.js / compose / caddy 模板 / 运行时 provider）。下面每条都是**已修**的，
按"用户会看到什么"排序。

**A. 容器"在跑但没人服务"这一类（最坑，因为 `docker ps` 一切正常）**

1. **server 崩了容器不退出**：`start.js` 的 `ctx.on('exit')` 只打印一行"已停止"，自己不退出 →
   server 挂了（比如缺 multer 那次）容器仍然 Up，`restart: always` 永远不触发。
   现在子进程退出时父进程**以同样的退出码退出**。
2. **caddy 起不来没人管**：`entrypoint.sh` 不检查 `caddy start` 的退出码（zerossl 那次就是这样，
   80/443 全没了而容器"正常"）。现在先 `caddy validate`，失败就**降级**到
   `caddyFallbackTemplate.json`（同一份路由表、去掉 `apps.tls`，HTTP 仍可用、443 走自签），
   并把 Caddy 版本打进日志让人来报。
3. **waline 崩了不会自己起来**：`waline.provider.ts` 的 exit 处理只打日志
   （而 `website.provider.ts` 一直有自动重启）→ 评论静默 502 直到重启容器。
   现在自动重启，带 2s×n 的退避、**5 次上限**、稳定运行超过 1 分钟就重置计数，
   主动 `stop()` 时不会重启（否则关不掉）。
4. **没有健康检查**：加了 `HEALTHCHECK`，探的是 **caddy 的 80 端口**（不是 server 的 3000），
   这样一条检查覆盖 caddy → server → 前台 → 后台静态文件整条链路；用镜像自带的 node 发请求
   （**镜像里没有 curl**），`start-period=180s` 给小机器留冷启动时间。
   ⚠️ Docker 本身不会因为 unhealthy 就重启容器，所以它只是给人看的信号，不会引入重启风暴。

**B. 停机与数据完整性**

5. **`docker stop` 从来不优雅**：PID 1 是 `sh`，SIGTERM 被它吃掉；`start.js` 只接 SIGINT，
   而且转发用的是 `process.kill(-ctx.pid)` —— 子进程没有 `detached: true`，**没有独立进程组**，
   这句直接抛 ESRCH；`main.ts` 也只接了 SIGINT。三处叠加的结果是每次停容器都等满 10 秒宽限期
   再 SIGKILL，**正在写的整站备份/导出/恢复上传被截断**（留下没有 sidecar 清单的半截归档）。
   修法：entrypoint 用 `exec node start.js`（node 当 PID 1 直接收 SIGTERM）、
   `start.js` 接 SIGTERM/SIGINT/SIGHUP 并用 `ctx.kill('SIGTERM')` 转发 + 等子进程 + 超时硬退、
   `main.ts` 同样接三个信号并依次停 waline / 前台 / `app.close()`（每步单独 try，一个失败不影响其它）。
6. **`restart`/`start_vanblog`/`stop_vanblog` 永远返回 0**：不管 docker-compose 成没成功都打印
   "成功"，安装与 config 流程因此到处误报；更危险的是**离线恢复**（老的 `vanblog-backup-*.tar.gz`）
   靠它判断"服务停了吗"，停不下来照样解压覆盖数据目录 = **mongod 还在写的时候动它的数据文件**。
   现在三个函数都把 docker-compose 的退出码返回出去，恢复流程停不下来就直接中止。
7. **`/var/log` 无限增长**：`start.js` 把 server/前台/waline 的每个输出块**同时**写进
   stdout/stderr/stdio 三个文件，而 `/var/log` 是挂到宿主机数据目录的卷 → 跑几个月把磁盘写满，
   然后 mongod 写失败、整站挂掉。现在按 `VAN_BLOG_STDIO_LOG_MAX_BYTES`（默认 20MB）轮转，
   只留一份 `.old`。⚠️ `vanblog-stdio.log` **不能不写**：后台「查看日志」读的就是它
   （`log.provider.ts` 的 `systemLogPath`），所以是轮转而不是删掉。
8. **`restore.key` 是 0644**：它写在挂载到宿主机的 `/var/log` 下，还会被 `vanblog.sh backup`
   一起打包 —— 而它是「忘记密码」的恢复密钥。现在以 **0600** 写入（并额外 `chmodSync`，
   因为文件已存在时 `writeFileSync` 的 mode 不生效）。

**C. 装错东西 / 装不上**

9. **`config` 会把镜像悄悄换回上游官方版**：`config` 用 `Docker_IMG` 重写 `image:` 行，
   而 `Docker_IMG` 只在 `pre_check` 里被设成 `mereith/van-blog:latest`，这条路径又不经过
   `prepare_vanblog_image` → **改个邮箱/端口就把本 fork 换成了上游镜像**，所有分支功能消失，
   而且没有任何提示。现在优先沿用编排文件里现有的镜像，没有才去准备。
   ⚠️ 顺带踩到一个 `set -u` 坑：新代码里引用 `Docker_IMG` 必须写成 `${Docker_IMG:-}`，
   否则在被 source 的场景下会 `unbound variable` 直接中断，配置改到一半停下。
10. **首次启动可能崩溃循环**：`initJwt` 是启动后第一次碰数据库，发生在 `unhandledRejection`
    兜底装上之前，而且只连一次；compose 的 `depends_on` 只保证"先启动 mongo 容器"，
    不保证 mongod 已经能接受连接（首次初始化数据目录/慢磁盘要几秒到几十秒）→
    未捕获 rejection → 进程退出 → 容器重启 → 再退出。现在最多重试 10 次、每次间隔 3 秒。
    compose 里也补了 `depends_on: [mongo]` 与两个服务的**日志上限**
    （`json-file` + `max-size: 10m` + `max-file: 3`，否则容器 stdout 也会无限增长）。
11. **自更新可能把唯一一份可用脚本毁掉**：`is_valid_vanblog_script` 只 grep 一个版本号，
    截断到 20 行的下载也能通过，然后 `mv` 覆盖 + `exec`；而且用的是 `./vanblog.sh`
    （CWD 相对路径，在别的目录里执行会写错地方）。现在校验 `bash -n` + 首尾标志
    （`show_menu` 定义与文件末尾的调用都在），下载到 `mktemp` 出来的临时文件
    （固定的 `/tmp/vanblog.sh` 可被软链攻击，而脚本是 root 跑的），版本相同就不替换，
    覆盖与 exec 都用 `VANBLOG_SELF_PATH`（由 `BASH_SOURCE` 推出的绝对路径）。
12. **wget 下载关掉了 TLS 校验**：`download_url_to_file` 用 `wget --no-check-certificate`，
    而下载的正是**编排模板和脚本自己**（还会被 exec）→ 等于允许中间人塞一份进来。
    现在正常校验，wget 失败退 curl，而不是退到"不校验"。

**顺手修的小问题**：`VANBLOG_DATA_PATH_RAW` 以前写死 `/var/vanblog/data`，用
`VANBLOG_DATA_PATH` 换目录后编排文件与 backup/restore 各写各的地方（现在跟着变量走并正确转义）；
邮箱里的 `&` 会被 sed 当成"整个匹配"展开（`a&b@x.com` → `avanblog_emailb@x.com`，
ACME 拿到非法地址，HTTPS 一直签不出来）；`get_compose_http_port` 的 `[0-9]+:80` 会把
`"3000:8080"` 里的 `3000:80` 当成匹配（restore 于是去探错端口）；`clone_or_update_source`
在克隆前无条件 `rm -rf "${VANBLOG_SRC_DIR}"`（指向自己的源码树时整个删掉，现在要求是 git 仓库
或在安装目录下）；编排模板校验只看 `services:`/`vanblog:`（截断的模板能过，会生成一份**没有 mongo**
的编排文件）；docker 装不上时 `exit 0`（自动化流程会误判成功，现在 `exit 1` 并检查 `docker info`）；
卸载只删上游镜像（本分支 ghcr 镜像、本地构建 tag、自建 shim 都留着，现在一起清，
且**只删自己写的 shim**）；caddy 的 admin API 监听 `0.0.0.0:2019`（同网络任何容器都能改写全部路由与
TLS，改成 `127.0.0.1`）；镜像默认 `EMAIL` 是上游作者的邮箱（没设 EMAIL 的用户会拿它注册
Let's Encrypt 账户，改成空值）；SELinux Enforcing 时给出提示（bind mount 没有 `:z`，
mongo/caddy 会被 AVC 拒绝而反复重启）。

**审计到但这次没动的（记下来）**：
- `server_builder` / `cli` / `waline` 三个 stage 仍然是**独立安装、没有 lockfile**
  （§7.27 的 cytoscape 教训只应用到了 admin）。server 的依赖都是 semver 区间，
  每次构建都重新解析 → 上游发个新 minor 就可能让镜像构建或运行出问题。
  没顺手改是因为 pnpm 的符号链接布局：runner 现在直接 `COPY --from=server_builder /app/node_modules`，
  换成 workspace 布局后必须同时拷 `/app/node_modules`（.pnpm 真身）与
  `/app/packages/server/node_modules`（软链层）并保持相对路径一致，还要改 `start.js` 的 cwd ——
  改动面大且本机没有 docker 权限验证。**缓解**：镜像由 CI 构建、构建失败就发不出来，
  所以漂移会在发布时暴露，不会到用户手上。
- 流水线的依赖装在 `/app/codeRunner`（不在卷里），每次重建容器都要重新下载；镜像里没有 `git`，
  git URL 形式的依赖永远装不上。
- runner 里是 Node 18（已 EOL）、容器以 root 运行、`PORT` 被 `isr.provider.ts` 硬编码成 3001
  （改 PORT 会同时弄坏 ISR 与 caddy→前台的代理）。
- mongo 钉在 4.4.16（EOL 无安全更新）。**不要直接换 `latest`**：数据目录与 FCV 绑定，
  4.4 → 8.x 没有直升路径，mongod 会拒绝启动，看起来像数据全丢。要升级必须走
  5.0 → 6.0 → 7.0 阶梯并逐级改 FCV，或者用整站备份（NDJSON，跨版本可恢复）迁到新库。
  模板里的注释已经这么写了。

**测试**：新增 `scripts/tests/vanblog-hardening.test.sh`（36 条，覆盖 B1/B2/B3/M1/M2/M3/m1/m2/m3/M5/m4），
`image-runtime.test.sh` 从 19 涨到 42（caddy admin 回环、EMAIL 默认值、main.ts 三个信号、
waline 自动重启与上限与 stopping 标记、initJwt 重试、restore.key 0600、EXPOSE/HEALTHCHECK），
`start-js.test.sh`（15 条，真的起 stub 子进程验证退出码传播、SIGTERM 转发、超时硬退、日志轮转）。
脚本合计 **13 文件 / %s 条断言**；server 610（609 绿 + 1 个既有离线字体用例）；
本地三个服务改完全程 200。

⚠️ 这轮又踩了两次同一个坑：**反向断言前必须剥掉注释**（新写的注释里引用了旧代码），
而且剥注释的 `sed` **不能用 `#` 当分隔符**（`s#^[[:space:]]*#.*##` 会被解析成
"把行首空白替换成 `.*`"，注释根本没剥掉，表现是"明明改了却还报有旧代码"）。
另外别把字面量旗标写进用户可见的提示语里（我写了"别用 --no-check-certificate 绕过"，
结果守卫断言把它当成了"又关掉校验了"）。

### 7.31 基础镜像与运行时版本对齐（哪些能升、哪些不能）

用户问"Dockerfile 里的镜像是不是过时了、要不要和开发环境对齐"。答案是**部分过时，但不能一路升到最新** ——
每一项都有一条具体的依赖链卡着。先把事实摆出来（2026-09）：

| 组件 | 原来 | 现状 | 本机开发环境 | 这次怎么处理 |
| --- | --- | --- | --- | --- |
| Node（4 个 stage） | `node:18` / `node:18-alpine` | **2025-04 EOL**，无安全更新 | v20.19.5 | **升到 node:20** ✅ |
| MongoDB（compose） | `mongo:4.4.16` | **2024-02 EOL**，无安全更新 | 7.0.14（FCV 6.0） | 模板改占位符，**新装 7.0 / 有数据保持原样** ✅ |
| pnpm | 8.11.0（corepack + `packageManager`） | pnpm 8 已停维护，lockfile 是 v6.0 格式 | 8.11.0 | 不动 ⛔（见下） |
| sharp | 0.32.6 | 0.32 线不再维护 | 0.32.6 | 不动 ⛔（与 Node 版本绑定） |
| caddy | `apk add caddy`（不钉版本） | 每次构建都重新掷骰子 | — | 不动，但已有**降级模板**兜底（§7.28） |
| NestJS / Next / umi | 9.x / 13.5 / 3.5 | 都落后好几个大版本 | 同左 | 不动 ⛔ |

**为什么 Node 停在 20，不是 22 或 24**（两条硬约束，Dockerfile 里也写了注释，别让人顺手升上去）：

1. **Node 23 移除了 `util.isObject`，而 `@nestjs/cli` 9 还在用它** → Node 24 上 `nest build` 直接崩。
   本机开发环境固定在 node20 就是这个原因（§3.6）。
2. **sharp 0.32.6 的预编译二进制只覆盖到 Node 20**（NODE_MODULE_VERSION 115）；Node 22 是 127 →
   没有 prebuild，而 **runner 阶段没装 `vips-dev`**（只有 website_builder 装了），
   于是图片处理会在运行时加载失败。要升 22 必须**同时**把 sharp 升到 0.33+ 并重新验证
   Alpine/musl 的 prebuild（§7.10 有一整节讲 alpine + sharp 的坑）。

Node 20 这一档是**本机验证过的**：server 610 用例、admin `umi build`（EXIT=0，dist 24MB）、
website `next build`（EXIT=0，8 个页面）全在 v20.19.5 上跑通；`--openssl-legacy-provider`
在 20 上照常需要且照常有效；sharp 0.32.6 有 Node 20 的 prebuild。
⚠️ Node 20 本身也已经在 2026-04 EOL 了 —— 所以这只是"止损"，真正的目标是
「sharp 0.33 + @nestjs/cli 10 + Node 22」一起升，那要单独一轮（见下面的路线图）。

**MongoDB 为什么不能直接换 tag**：数据目录与 `featureCompatibilityVersion` 绑定，
4.4 的 datadir 换成 `mongo:7.0` 起来，mongod 会**直接拒绝启动**（容器反复重启，看起来像数据全丢，
其实把 tag 换回去就好了）。而且 mongoose 7.6 / driver 5.9 官方只支持到 server 7.0，
`mongo:latest`（8.x）根本不是受支持的目标。

所以做法是**把版本决定权交给脚本，按"有没有数据"分流**：

- 模板里改成占位符 `vanblog_mongo_image`；
- `pick_mongo_image()`：`${VANBLOG_DATA_PATH}/data/mongo` 里有真实数据
  （`WiredTiger` / `mongod.lock` / `storage.bson` / `collection-*` / `index-*` / `_mdb_catalog.wt` /
  `diagnostic.data`）→ **保持现有编排文件里的 tag**，连 `VANBLOG_MONGO_IMAGE` 覆盖都不听；
  目录不存在或只有无关文件 → 用 `VANBLOG_MONGO_IMAGE`（默认 `mongo:7.0`）；
- `config` 替换占位符并说明选了哪个；沿用的是 4.x/5.x 时额外打印两条升级路径
  （阶梯 setFCV，或 `backup` → 空库 → `restore` 的整站备份迁移）；
- 模板里没有占位符（比如回退到了上游的旧模板）时**不硬改**，只提示一句。
- ⚠️ 备份迁移这条路是**自洽**的：迁移时新数据目录是空的，所以 `pick_mongo_image` 会自动给出新版本，
  不需要用户去改代码或加特殊参数。
- 老机器不支持 avx（跑不了 5.0+）：`VANBLOG_MONGO_IMAGE=mongo:4.4.16`。

**这次刻意没升的（各自卡在哪）**：

| 想升的东西 | 卡在哪 | 要怎么做 |
| --- | --- | --- |
| Node 22 | sharp 0.32.6 没有 Node 22 的 prebuild；runner 没装 vips-dev | sharp → 0.33.x，确认 musl prebuild，再升 node:22-alpine |
| pnpm 9/10 | lockfile 是 v6.0，升 pnpm 会重写整个 lockfile（`patchedDependencies` 的 hash 也要重算） | 单独一轮：升 pnpm → `pnpm install` 重生成 lockfile → 验证两个补丁仍生效 → 全量测试 |
| NestJS 10/11 | 装饰器与 `@nestjs/swagger` 6 的 API 变化、`multer` 版本、`mongoose` 版本联动 | 单独一轮，改动面很大 |
| Next 14/15 | pages → app router、`next.config` 变化、ISR 行为变化；前台所有页面都要过一遍 | 单独一轮 |
| umi 4 | 配置格式与插件体系全变（MFSU、`mfsu:{}`、两个 pnpm 补丁的必要性都要重新评估） | 单独一轮，最重 |
| caddy 钉版本 | `apk add caddy=X-rN` 会随 Alpine 仓库滚动失效；钉官方 release 二进制要维护 sha256 | 已有降级模板兜底，优先级低 |

**测试**：`image-runtime.test.sh` 加了"不许再出现 `FROM node:18`、四个 stage 都是 node:20、
不许贸然出现 node:22+、Dockerfile 里必须写明为什么停在 20"；`vanblog-hardening.test.sh` 加了
`get_compose_mongo_image` / `pick_mongo_image` 的七种情形（无数据、有数据、有数据+覆盖、
空目录、只有无关文件、读现有 tag、默认值）；`vanblog-source-install.test.sh` 的 config 模拟
补上了 mongo 占位符替换，并断言生成的编排文件里**没有残留占位符**、`image:` 行不是 mongo:4.x。
⚠️ 那条断言只能用 `^[[:space:]]*image:[[:space:]]*mongo:4\.` 判断 —— 模板注释里正好写着
`mongo:4.4.16`（讲升级路径），全文搜子串会把注释当成配置命中（又一次"断言前要剥注释"的变体）。
⚠️ 升 Node 之后 `dockerfile-alpine-sharp.test.sh` 里三处写死的 `node:18-alpine` 也要跟着改，
不然它会红 —— 那个测试是按 stage 名切 Dockerfile 正文的，基础镜像名写死在里面。

### 7.32 怎么在本地构建并冒烟测试镜像（`scripts/build-image-local.sh`）

前面连着四轮镜像问题（缺 multer、caddy zerossl、admin OOM、cytoscape）都是**用户装的时候才炸**的，
因为本机没有 docker 权限、只能做静态检查。所以补了一个本地构建 + 冒烟测试脚本。

```bash
./scripts/build-image-local.sh                       # 构建 + 冒烟测试
./scripts/build-image-local.sh --build-only          # 只构建
./scripts/build-image-local.sh --stage admin_builder # 只构建某一层（迭代时快得多，不打 tag 也会留层缓存）
./scripts/build-image-local.sh --smoke-only          # 只测已有镜像
./scripts/build-image-local.sh --lowmem              # admin 用 1536MB 堆
ENGINE=podman IMAGE_TAG=vanblog:local-test SMOKE_HTTP_PORT=18080 ./scripts/build-image-local.sh
```

**引擎怎么选**：脚本先试 `docker info`（有命令不等于 daemon 连得上），连不上就退 **podman**。
这台机器的实际情况是：docker daemon 在跑、`docker` 组存在但**没有任何成员**，当前用户不在里面 →
`docker` 命令一律 `permission denied /var/run/docker.sock`；而 **podman 4.9.3 + buildah 是装好的**，
rootless 可用（`/etc/subuid` 里有 `ckboss:100000:65536`），**不需要 sudo、不需要加组**。
想用 docker 就一次性 `sudo usermod -aG docker $USER` 再重新登录。

⚠️ **rootless podman 在受限环境里的两个坑**（都是实测）：
1. 需要能写 `/run/user/<uid>` 与 `/proc/<pid>/uid_map`。在只允许写工作区的沙箱里会报
   `mkdir /run/user/1000/libpod: permission denied` 或 `newuidmap: open of uid_map failed`；
   把 `XDG_RUNTIME_DIR` / `HOME` / `TMPDIR` 指到工作区里可以绕过前者，后者需要沙箱放开。
2. **docker.io 直连超时**（`registry-1.docker.io … i/o timeout`）。实测可用的公共加速：
   `docker.m.daocloud.io`（和本仓库 `vanblog.sh` 里 GitHub 加速用的是同一家）。
   podman 配 `~/.config/containers/registries.conf`：
   ```toml
   unqualified-search-registries = ["docker.io"]
   [[registry]]
   prefix = "docker.io"
   location = "docker.m.daocloud.io"
   ```
   docker 则配 `/etc/docker/daemon.json` 的 `registry-mirrors`。
   ⚠️ 脚本里**不写死任何镜像站**（各机器网络不同），需要时用 `NPM_REGISTRY=` 或引擎自己的配置。

**冒烟测试查什么**（起一套临时 mongo + vanblog，测完自动拆，`SMOKE_KEEP=1` 可保留）：
- 关键路径逐个打：`/`、`/api/public/meta`、`/admin`、`/robots.txt`、`/sitemap.xml`、
  `/rss/feed.xml`、`/post/1`、`/timeline`（200/301/302/308/404 都算通 —— 404 说明
  caddy → server/前台这条链路是活的，比连接被拒强）；
- **扫日志里的已知故障特征**，每条都是真炸过的：`Cannot find module`（multer）、
  `caddy process exited` / `loading initial config`（zerossl）、`Reached heap limit`（admin OOM）、
  `ERR_INVALID_URL`（空的 VAN_BLOG_SERVER_URL）、`Failed to collect page data`、
  `unhandledRejection`、`降级使用`（entrypoint 走了 caddy 降级模板 = 主配置没加载成功）；
- 容器状态：`RestartCount` 必须是 0（有进程在崩就会被 restart 拉起）、healthcheck 状态、
  `State.Running`；
- **优雅停机耗时**：`docker stop -t 20` 后计时，<15s 说明 SIGTERM 被正确转发，
  接近 20s 说明信号没转发、进程被硬杀（§7.30 修的就是这个，这里把它变成可回归的检查）。
- mongo 版本调 `vanblog.sh` 的 `pick_mongo_image()` 拿，和真实安装走同一条逻辑。

**没有容器引擎时的替代办法**（这轮之前一直这么干，抓到了 cytoscape 那个问题）：
按 Dockerfile 里某一层的**目录结构和命令**在 `/tmp` 复刻一遍。例如验 `admin_builder`：

```bash
rm -rf /tmp/absim && mkdir -p /tmp/absim/packages
cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json /tmp/absim/
cp -r patches /tmp/absim/ && cp -r packages/admin /tmp/absim/packages/
cd /tmp/absim && pnpm install --frozen-lockfile      # 与镜像里完全相同的命令
cd packages/admin && pnpm run build                  # EXIT=0 才算过
```

**Alpine 源也要能换**（同一类问题，同一套解法）：Dockerfile 三个 alpine stage 里
`apk add` 走的是官方 `dl-cdn.alpinelinux.org`，国内实测 **8-10 秒才回一个索引**，
构建会看起来"卡死"在 `apk add python3 make g++` 那一步（我本地第一次构建就卡了 8 分钟）。
现在：`ARG VAN_BLOG_ALPINE_MIRROR`（留空=官方源），每个 alpine stage 在**第一条 apk 之前**
按镜像自己的 Alpine 版本重写 `/etc/apk/repositories`；`vanblog.sh` 的 `detect_alpine_mirror`
和 pnpm 源一样实测延迟后自动选（本机实测 aliyun 321ms / tuna 416ms / 官方 8001ms）；
`build-image-local.sh` 默认用 aliyun，`ALPINE_MIRROR=none` 可关掉。
⚠️ 两个只有真构建才会暴露的坑：
1. **不要用 sed 改 `/etc/apk/repositories`**：Alpine 是 busybox sed，GNU 的 `\?` 可选分组不认；
   而且原行是 `https://dl-cdn.alpinelinux.org/alpine/v3.23/main`，把主机名换成
   `https://mirrors.aliyun.com/alpine` 会拼出 **`/alpine/alpine/`** 双段路径 → 404。
   直接按 `VERSION_ID` 重写整个文件最稳。
2. **`VERSION_ID` 是三段（`3.23.4`），仓库路径只有两段（`v3.23`）** —— 直接拼会 404，
   然后 apk 报 `python3 (no such package)`，看起来像"镜像源坏了"，其实是路径错了。
   必须 `cut -d. -f1,2`。探测延迟时也别写死某个 `v3.x`（基础镜像的 Alpine 版本会漂），
   用 `latest-stable`。

**本地真构建时又抓到的三件事（都只有真跑才会暴露）**：

1. **公共镜像站拉大 blob 会静默卡死**：`node:20`（debian，350MB+）在 `docker.m.daocloud.io`
   上拉到一半就不动了 —— 进度行停在那里、不报错、也不超时，`du` 看存储 40 秒 0 字节增长。
   小镜像（`node:20-alpine` 50MB）反而一次就过。解法是**多站轮换 + 每次限时**：
   `docker.1ms.run` / `docker.m.daocloud.io` / `dockerproxy.net` / `hub.rat.dev` 依次试，
   每次 `timeout 300`，拉下来立刻 `podman tag` 成 `docker.io/library/<name>` 再删掉带站名的 tag。
   实测：node:20 第 1 次（1ms.run）超时、第 2 次（daocloud）成功；node:20-alpine 走 1ms.run 一次过。
   ⚠️ podman 4.9 的 `pull` **没有 `--retry`**（那是后来加的），写了会直接 rc=125，重试要靠外层循环。
2. **admin/website 两个 alpine stage 里 tree-sitter 系列会把 node-gyp 卡死**：
   进程活着、11 个线程全 sleep、**没有任何 make/cc1plus 子进程**，十几分钟不动，整个 stage 挂住。
   同一份 Dockerfile 在 GitHub Actions 上能编过，所以是 musl + rootless podman 这一侧的问题。
   查清了来源：`packages/admin` 的 `swagger-ui-react@3.52.5` 传递依赖 `@swagger-api/apidom-*` →
   `tree-sitter` / `tree-sitter-json` / `tree-sitter-yaml`。**全仓库源码与 dist 里没有任何一处
   import 它们**（`grep -rl "apidom\|tree-sitter" packages/*/src packages/*/dist` 是空的），
   属于纯粹的幽灵传递依赖 —— 所以在这两个 stage 的 `/app/.npmrc` 里写
   `never-built-dependencies[]=tree-sitter{,-json,-yaml}` 跳过编译是安全的，
   而且**只影响镜像构建**（不动仓库的 package.json，本机开发照常编译）。
   ⚠️ 别把 `sharp` 一起加进去：它靠 install 脚本取预编译二进制，跳过脚本反而会坏。
   加了之后 admin 的 `pnpm install` 从"永远不结束"变成 **2m24s** ✓
3. **顺带把两个 stage 改成按包过滤安装**：`pnpm install --frozen-lockfile --filter "@vanblog/admin..."`。
   原来是整仓安装，会把 `packages/server` 的依赖也拉进来（就是 tree-sitter 的来源之一），
   admin 构建根本用不到。⚠️ **过滤名必须和 package.json 里的真名一致**：
   website 那个包叫 `@vanblog/theme-default`（不是 `@vanblog/website`），写错不会报错，
   只是**一个包都不装**，然后在 `next build` 才炸，错误信息完全指不到根因 ——
   现在有测试会拿每个 `packages/*/package.json` 的 name 去核对 Dockerfile 里的过滤名。

### 7.32.1 本地真跑一遍（构建 → 起栈 → 导入整站备份 → 验证）抓到的 6 个问题

`vanblog_dev/pipeline.sh`（本机脚本，不入库）把「预拉基础镜像 → 构建 → 起 mongo+vanblog →
首次初始化 → 用 server 接口导入 `vanblog-full-*.tar.zst` → 逐项验证」串成一条。
第一遍跑下来，**单元测试和 CI 构建全绿的情况下**，站点仍然是坏的 —— 下面每一条都是只有
真把镜像跑起来才会暴露的：

1. **Caddy 2.11 换了 on-demand TLS 的写法**：`tls.automation.on_demand.ask` 被
   `on_demand.permission = {module:"http", endpoint:...}` 取代，旧写法让 caddy **拒绝加载整份配置**
   （`on-demand TLS cannot be enabled without a permission module to prevent abuse`），
   于是走降级配置：HTTP 能用、HTTPS 变自签证书。
   修法不是猜版本，而是 `scripts/caddyConfig.js` 生成两种形式、entrypoint 各跑一次
   `caddy validate`，用通过的那个（新形式的结构是拿镜像里 `caddy adapt` 的输出对照出来的，
   不是猜的）。邮箱替换也搬进这个脚本，在**解析后的对象**上改，不再用 sed。
2. **前台整站 502，而 /admin 与 /api 正常**：Next 13 的 standalone server 用 `HOSTNAME`
   决定监听地址，容器里 `HOSTNAME` 就是容器 ID → 它只绑那个网卡 IP，
   而 caddy 反代的是 `127.0.0.1:3001` → 502。修法是 `WebsiteProvider` spawn 时显式
   `HOSTNAME: '0.0.0.0'`（放在 `...loadEnvs` 之后，保证不被覆盖；可用 `VANBLOG_WEBSITE_HOST` 改）。
3. **`/robots.txt` 404**：动态 robots 是 server 提供的（`3000/robots.txt` → 200），
   但 caddy 模板里没有这条路由，落到 catch-all 转给前台 → 404。
   ⚠️ 而且模板里有**两个 server**：`srv0(:443)` 和 `srv1(:80)`，只补 srv0 的话
   "HTTPS 正常、HTTP 404"，更难查。现在两个都补了，并且加了守卫测试：
   **两个 server 的路径路由必须完全对齐**（`/robots.txt`、`/sitemap.xml`、`/api/*`、`/static/*`、`/admin*` 逐个点名）。
4. **中文别名的文章 500**（这份生产数据里 16 篇）：SEO 那轮加的规范地址 308 重定向
   把 `Location: /post/<pathname>` 直接塞了中文，而 HTTP 头只能是 Latin-1 →
   Node `setHeader` 抛 `Cannot convert argument to a ByteString` → 整篇 500。
   新增 `utils/encodeLocationPath.ts`：纯 ASCII 原样返回（避免把已编码的 `%xx` 再编成 `%25xx`），
   含非 ASCII 时按 `/` 分段 `encodeURIComponent`。**假数据永远测不出这个**，
   所以既加了工具的单测，也加了"重定向必须过这个函数"的源码守卫，
   还在本机栈里用真实数据里那篇 `Qt自定义控件与提升法(prompted)` 跑通了 200。
5. **waline 装不上（Node 20 的连带后果）**：`@waline/vercel` → `think-model-sqlite` → `sqlite3@5.1.7`，
   而 sqlite3 5.1.7 **没有 Node 20（ABI 115）的预编译包**（node:18 时代有，所以以前不用编），
   于是退回 node-gyp 现场编译 —— 而 runner 阶段故意不装编译器 → 构建失败。
   修法：单独的 `waline_builder` 阶段装 `python3 make g++` 编好，runner 只 `COPY node_modules`，
   **编译器不进最终镜像**。
6. **sharp 只能靠环境变量改源**：它默认从 `github.com/lovell/sharp{,-libvips}/releases` 下预编译包，
   国内 `Installation error: aborted`。翻它的 `install/libvips.js` 才确认它读的是
   `process.env.npm_config_sharp_libvips_binary_host`，而 **pnpm 8 不会把 .npmrc 里的自定义键
   转成 `npm_config_*` 传给 install 脚本** —— `npm config set -g` 和项目 `.npmrc` 两条路都试过，都没用，
   只有 Dockerfile 的 `ENV` 有效。npmmirror 把两套二进制都镜像了、**musl 版也有**
   （`/-/binary/sharp/v0.32.6/sharp-v0.32.6-napi-v7-linuxmusl-x64.tar.gz`、
   `/-/binary/sharp-libvips/v8.14.5/libvips-8.14.5-linuxmusl-x64.tar.gz`，逐个 HEAD 过 200），
   于是 server/website 两个 stage 都不再需要 gcc+vips-dev：**server 阶段的 apk 从 218 个包降到 1 个**。

**这台机器上跑 rootless podman 的额外坑**（都属于环境，不进产品代码，但记下来省时间）：
- `docker` 组是空的、daemon 却在跑 → `docker` 命令一律 EACCES；**podman 4.9.3 rootless 可用**
  （`/etc/subuid` 有 `ckboss:100000:65536`），免 sudo。需要把 `XDG_RUNTIME_DIR`/`HOME`/`TMPDIR`
  指到工作区里（默认 `/run/user/1000` 写不了），`registries.conf` 配镜像加速。
- **公共加速站拉大 blob 会静默卡死**：`node:20`（350MB）在第 1 个站上超时、第 2 个站才成功；
  `mongo:7.0` 试到第 6 次才成。所以 `pipeline.sh` 是多站轮换 + 每次 `timeout` + 拉完 `podman tag` 回标准名。
  ⚠️ podman 4.9 的 `pull` **没有 `--retry`**（写了直接 rc=125）。
- **容器内拉大包也会卡**：`apk add gcc/vips-dev`（218 个包）卡在 `Installing gcc` 十几分钟，
  进程 `read/write` 都是 0 字节；小文件（APKINDEX、pnpm 的 2827 个包）却很快。
  固定 MTU=1500、换 pasta 后端都没稳定解决 → 最终解法是**别在容器里下大包**（见上面第 6 条）。
- **没有 aardvark-dns**（`/usr/libexec/podman/` 里只有 catatonit/quadlet/rootlessport），
  所以自定义网络里**容器名解析不了**（server 报 `getaddrinfo EAI_AGAIN vb-mongo`）。
  本机栈改成取 mongo 容器的 IP 直连 + `--add-host` 兜底。
- **被 SIGTERM 打断的 `podman build` 会返回 0**：日志停在半截却打印"构建成功"。
  所以 `build-image-local.sh` 在构建后必须再 `image exists` 确认一次。
- 杀掉 `podman build` 之后，**容器里的进程会变成孤儿继续跑**（见过一个 `apk add` 挂了一个多小时），
  下次构建会和它抢资源；清理时要按 PID 杀，别用 `pkill -f`（模式里带工作区路径会把自己杀掉，§6 第 4 条）。

⚠️ **一个恢复后才会出现的行为**（不是 bug，但会误导排查）：server 的 JWT 密钥是**启动时**从
`settings` 读的（`initJwt`），整站恢复会把 `settings` 换成备份里的那份 → 进程内存里的密钥和库里的
对不上。后果：**恢复完立刻用库里的密钥签 token 会 401**，重启容器后才对得上。
用户侧没有影响（`TokenGuard` 还会查 `tokens` 表，恢复后旧 token 一并失效；重新登录用的仍是
内存里那把密钥，登录/签发/校验三者自洽），但**任何"恢复后马上调 /api/admin/**"的自动化脚本
都必须先重启容器**，否则会误判成"鉴权坏了"。

**验证结果**（本机 podman，镜像 `vanblog:local-test`，导入的是用户那份 66MB 生产整站备份）：
初始化 → 登录 → `full/inspect` → `full/restore`（含静态文件）全部成功；
前台首页/归档/关于/文章页/中文别名文章页、后台 `/admin`、`/api/public/meta`、
`/sitemap.xml`、`/rss/feed.xml` 全部 200；库里 `articles`、`nativecomments`(3)、
`waline.Comment`(3)、`users`（已被备份里的真实用户替换）、16 篇有封面的文章都在；
容器 `RestartCount=0`、健康检查通过、日志里没有那 8 类已知故障特征
（`Cannot find module` / `caddy process exited` / `loading initial config` / `Reached heap limit` /
`ERR_INVALID_URL` / `降级使用` / `unhandledRejection` / `ByteString`）；
恢复后自动触发全量渲染；`docker stop` 在宽限期内优雅退出（SIGTERM 转发验证）。
重启容器后**后台鉴权链路也实测通过**：`/api/admin/meta`（返回 `version: local@b90c2498`）、
`/api/admin/article?page=1`（返回恢复出来的真实文章标题）、`/api/admin/backup/full/list`
（列出刚导入的归档）全部 200。静态文件也核对过：恢复出来 68MB 的 `static/`，
`/static/img/<hash>.webp` 直接 200 且 content-type 正确。

**测试**：`scripts/tests/build-image-local.test.sh`（35 条静态契约）—— 构建参数必须和 CI 一致
（四个 build-arg 一个都不能少，否则"本地测过了"是假的）、支持 `--target` 单层构建、
引擎探测要看 `docker info` 而不是只看命令存在、冒烟测试必须覆盖上面那 6 个故障特征 +
关键路径 + 停机耗时 + RestartCount、`trap cleanup EXIT` 在、默认端口 18080（不撞正在跑的站点）、
容器名带 PID（并发跑两次不会互拆）、mongo 版本走 `pick_mongo_image`、
且**不许硬编码内网地址或某个镜像加速站**。

### 7.33 安装 / 备份 / 恢复文档的对齐与一致性守卫

文档漂移过好几轮了（脚本的默认行为改了，文档还写着旧命令），而且**文档里还留着会删卷的命令**。
这次一次性对齐，并加了守卫测试，以后漂了会直接红。

**改了什么**：

- `docs/guide/script.snippet.md`（安装入口，被 `get-started.md` include）：下载地址从上游
  `vanblog.mereith.com/vanblog.sh` 改成**本分支** raw（下载上游脚本会装成官方镜像，
  本分支的改动一个都没有，还专门写了一段说明两者的区别）；补上"装的是什么"表
  （安装模式 / 镜像 / mongo / 数据目录 / 端口）、源码构建的四个源变量
  （npm / alpine / node 头文件 / sharp）、装完之后的常用命令、数据目录布局。
- `docs/guide/backup.md`：**默认备份已经是整站备份**这件事必须写清楚 —— 原文说
  `vanblog.sh backup` 打的是目录级 tar 包（现在是 `--offline` 才有），`VANBLOG_BACKUP_CONSISTENT=1`
  这种旧用法也一并改成 `--offline --consistent`；补了 `--format`、按名字恢复、`--no-static`、
  token/交互两种认证、cron 写法，以及一张"整站备份 vs 目录快照"的对比表
  （一致性 / 跨版本 / 含不含 caddy 证书 / 要不要站点在跑 / 恢复停不停服）。
  ⚠️ 还补了一条**恢复之后要重新登录后台**的说明（JWT 密钥是启动时读的，见 §7.32.1）。
- `docs/guide/update.md` 与 `docs/faq/update.md`：删掉 `docker-compose down -v`
  （`-v` 会删编排里的卷；现在是 bind mount 所以侥幸没事，一旦有人改成命名卷就是删库），
  换成 `pull → down → up -d`，并加 `::: danger` 警告；升级顺序说明改成
  "**先把新镜像准备好再停容器**"；回滚改成"用带提交号的 `dev-dsh-<sha>` tag"或"整站备份恢复"。
- `docs/faq/deploy.md`：编排模板的来源顺序改成"本分支 raw 优先"，并说明退到上游模板会拿到什么
  （mongo 写死 4.4.16、没有日志上限/`depends_on`/mongo 占位符）；外部访问数据库那节的 `down -v` 同样去掉。
- `docs/advanced/backup.md`：那张"与一键脚本备份的区别"的表已经过时（脚本默认就是整站备份了），
  改成"后台 / 一键脚本 / 目录快照"三者对比。
- 新增 `docs/advanced/local-build.md`：本地构建与冒烟测试怎么做（§7.32 那套的用户视角版本），
  含 podman rootless、国内三个下载源、冒烟测试查什么、"真起一个站导入整站备份"的完整命令，
  以及那张踩坑表（无 aardvark-dns → 用容器 IP、Next 的 HOSTNAME、恢复后 JWT 401、
  robots 只在 srv0 有路由、sitemap 恢复后要等一会儿、被 SIGTERM 打断的 podman build 返回 0）。
- `scripts/vanblog.sh` 新增 **`status` 子命令**与 `--help`/`-h`/`help` 入口：
  一屏看清脚本版本、安装/数据目录、编排里的 vanblog 与 mongo 镜像、mongo 数据是否存在、
  HTTP 端口、站点接口探活、`docker-compose ps`、各目录占用、整站备份数量与最近三个归档、
  磁盘剩余（含挂载点）。全部只读。⚠️ 提示语里**不要用 `$0`**：被 source 时它是 `bash`，
  会打印出"跑一次 bash backup"这种东西，改用 `VANBLOG_SELF_NAME`。
  脚本版本号 v0.4.0 → **v0.5.0**（`update_script` 靠它判断要不要替换）。

**守卫测试** `scripts/tests/docs-consistency.test.sh`（25 条）：

- 文档里出现的每个 `./vanblog.sh <子命令>` 都必须在 dispatcher 里存在；反过来
  `backup/restore/status/update/install/config/log` 这几个必须在文档里出现过（新命令最容易漏文档）；
- **任何文档都不许教人敲 `down -v`**（只允许出现在"不要这样做"的警告行里）；
- `guide/`、`faq/` 里不许把上游脚本地址当安装命令；安装文档必须给本分支地址；
- 安装/备份这几份文档提到的 `VANBLOG_*` 变量必须在脚本或编排模板里存在
  （⚠️ 只查这几份：`VANBLOG_DISABLE_WEBSITE`/`VANBLOG_SWAGGER`/各种限流变量是 **server** 的，
  写在 `features/config.md`，本来就不该出现在 vanblog.sh 里 —— 第一版检查范围太大，误报一片）；
- 文档写的默认镜像 / 默认 mongo 必须和脚本里的默认值一致
  （⚠️ 提取 `${VAR:-default}` 时 `cut -d: -f2-` 会多带一个 `-`，要 `sed 's/^-//'`）；
- 备份文档必须同时出现 `backup --offline` 与 `vanblog-full-`（证明写清了两种备份）、
  必须提醒恢复后重新登录；升级文档必须有 `down -v` 的警告；
- `docs/advanced/local-build.md` 存在、覆盖 `build-image-local.sh` / podman / `SHARP_DIST_HOST` /
  `aardvark-dns` / `publish-ghcr`，且被安装文档链接到。

⚠️ **改文档也要跑一次文档站构建**（`cd docs && pnpm run docs:build`，约 22 秒）：
Markdown 里的裸尖括号会让 vue 编译器报 `Element is missing end tag` 并**整站构建失败**。
这次就是 `<https://github.com/<owner>/<repo>/...>` 这种"自动链接里套占位符"炸的 ——
占位符要么放进反引号，要么别用尖括号自动链接。守卫测试里加了一条：
扫所有入库 md，代码块与行内代码之外不许出现白名单以外的尖括号标签。

另外 `vanblog-hardening.test.sh` 加了 12 条 `status` 的断言（有数据/空环境两种情形、
提示语里不许出现 `bash backup`、dispatcher 真的有 `status` 与 `--help`）。
⚠️ 写这个测试时踩到：整站备份目录是 `<数据目录>/log/vanblog-backups`，**不是** `data/log/...`
（`full_backup_dir()` 的实现是 `${VANBLOG_DATA_PATH}/log/vanblog-backups`），路径写错断言就会假失败。

### 7.33.1 文档死链检查与 CHANGELOG（补做的收尾）

- **新增 `scripts/tests/docs-links.test.sh`**：`vuepress build` **不会**报相对路径写错
  （`./init.md` 打成 `./initt.md` 照样构建成功，用户点进去才 404），所以自己查：
  相对链接指向的文件存在、带 `#锚点` 的链接在目标文件里真有那个标题、
  `<!-- @include: -->` 引用的片段存在、站内图片在 `docs/.vuepress/public` 下存在。
  第一次跑就在 195 条站内链接里查出 **7 处死锚点**：`editor.md#代码高亮`（全站没有这个标题）、
  `editor.md#在-markdown-里写-html`（真身在 `faq/usage.md#文章里写的-html-不生效`）、
  `env.md#环境变量`（那只是 frontmatter 的 title，不是标题）、`draft.md#创建草稿`（实际叫「新建草稿」）、
  `get-started.md#一键脚本部署`（那是个 `@tab`，不是标题；真实标题是「部署方式」）×2。全部改掉。
  ⚠️ 写这个检查器有两个坑：**`@/` 别名**指 docs 根（不是相对路径）；
  **标题可能藏在 `@include` 的 snippet 里**（`get-started.md#调整-nginx-缓存` 的标题其实在
  `bt-panel.snippet.md`），不递归展开就会误报死链。
  仓库根的 `README.md`/`CHANGELOG.md`/`AGENTS.md` 是 **GitHub 渲染**的，不是文档站页面，
  里面的 `/img/x.png` 指仓库根的 `img/`，而不是 `docs/.vuepress/public/img/`（第一版按文档站规则解析，
  把 README 的预览图误判成死链）。
- **文档里的环境变量全部核对过**：39 个 `VAN_BLOG_*` / `VANBLOG_*` 在
  server/website/admin/cli 源码、Dockerfile、compose、脚本、entrypoint、start.js 里都能找到，
  已固化成守卫（`docs-consistency.test.sh` 第 9 组），以后文档写了个代码不读的变量会直接红。
- **截图**：install/backup/update 那几页的截图来自上游图床（仍可访问），但内容已经和本分支不符
  （假"有新版本"警报、备份页没有整站备份、页脚与「关于」指向上游）。没法在本机重截图，
  所以在 `update.md` 与 `get-started.md` 各加了一段 `::: info` **明确列出截图与本分支的差异**，
  并把"升级前备份"改成推荐整站备份。
- **CHANGELOG** 的 fork 区块补齐了这一整轮（一键脚本 v0.5.0 的每一条、镜像的 6 项、
  容器运行时的 6 项、compose、本地构建脚本、文档对齐），以及三个"只有镜像里才暴露"的修复
  （前台 502 / 中文别名 500 / robots 404）。⚠️ 里面的测试数字要**跑完再写**，
  第一版凭印象写了 778，实际是 752。

### 7.35 `reset`：新机器上从整站备份一步重置整站

用户反馈："新机器上重置太繁琐 —— 要先初始化，再重新载入旧的备份包"。根因是个**死结**：
恢复接口在 `AdminGuard` 后面，而全新站点没有账号 → 没账号就没法登录 → 没法登录就没法恢复；
而后台的初始化向导建出来的账号，又会在恢复时被备份里的 `users` 集合整个覆盖 —— 白走一趟。

`./vanblog.sh reset [归档名|本地路径]` 把整条链自动化：

```
探活 /api/public/meta
  → POST /api/admin/init（随机口令的临时账号，只在"还没初始化"时做）
  → POST /api/admin/auth/login 拿 token（只试一次，登录有限流）
  → POST /api/admin/backup/full/inspect 打印清单（默认摘要，--verbose 给全文）
  → 要用户输 yes（VANBLOG_ASSUME_YES=1 跳过）
  → POST /api/admin/backup/full/restore（名字 → 服务器本地读；路径 → multipart 上传）
  → restart（让 server 重新读取恢复后的 JWT 密钥，见 §7.32.1）
  → 核对：meta / 站点名 / 首页 / 后台 / robots / sitemap / 文章数
  → 打印站点地址 + "用备份里原来的账号登录"
```

还能在安装时一步到位：`VANBLOG_RESTORE_FROM=<归档> ./vanblog.sh install`
（`install_and_maybe_reset` 包装了 `install_vanblog`，**菜单入口和命令行入口都要走它**，
只改一个的话从菜单装就不会自动恢复）。

**实现上踩到的两个坑**（都写成了测试）：

1. ⚠️ **命令替换里的全局变量会丢**：`token="$(ensure_admin_token)"` 是子 shell，
   在里面设的 `RESET_TEMP_USER/PASS` 出了子 shell 就没了 → 恢复失败时打印不出临时账号，
   用户在新机器上**连后台都进不去**。改成：临时账号在**父 shell**（`reset_from_backup`）里
   生成并保存，函数只负责回传 token；"这次真的做了初始化"用 **`INIT ` 前缀**回传
   （父 shell 剥掉前缀并置 `RESET_DID_INIT=1`）。
   ⚠️ 加前缀时**只能加在 `ensure_admin_token` 上**：`vanblog_admin_token` 也被 `restore` 用着，
   给它加前缀会让 restore 把 `INIT xxx` 整个当 token 发出去（第一版就这么改错了，
   而 restore 的测试因为走 `VANBLOG_ADMIN_TOKEN` 早退分支没抓到 —— 现在有专门的守卫断言）。
2. ⚠️ **摘要解析不能用 `sed 's/.*://'`**：ISO 时间戳 `2026-09-13T06:09:54.882Z` 里全是冒号，
   会被削成 `54.882Z`。要按 `^"key":` 精确削前缀。

**输出为什么默认是摘要**：一次 reset 原来打印 **114 行**，其中绝大多数是 inspect/restore 的
完整 JSON（屏幕上全是 `},`），真正要看的就 5 项。现在默认摘要（归档名/备份时间/格式大小耗时/
集合文档文件数/各集合条数，约 10 行），`--verbose` 或 `VANBLOG_VERBOSE=1` 才给全文。

**实测**（本机 podman 起的真镜像 + 用户那份 66MB 生产整站备份，全新空库）：
`reset` 一条命令跑通，rc=0；库里 `users` 变成 `['blogadmin']`（临时账号被覆盖）、13 个集合、
articles 59、nativecomments 3、waline.Comment 3、statics 93、16 篇有封面；
`/`、`/admin`、`/api/public/meta`、`/robots.txt` 全 200，站点名恢复成 `示例站点 aka blogadmin`；
重启后用**恢复出来的 JWT 密钥**签的 token 调 `/api/admin/meta`、`/api/admin/article` 都是 200
（证明 restart 那一步是必要的）；`/sitemap.xml` 恢复后立刻访问是 404、约一两分钟后 200
（生成有延迟，核对函数会提示"刚恢复完可能还在渲染"而不是报失败）。

**测试**：`scripts/tests/vanblog-reset.test.sh`（51 条）—— 全新站点自动初始化并恢复、
已初始化时不重复初始化而用现有 token、`--no-restart` 不调 restart、输 no 时连初始化都不做
（不会留下一个临时账号）、归档在服务器目录时不上传、本地路径走 `-F file=@`、
恢复失败时打印临时账号、初始化失败/接口不通时明确报错且不乱调接口、
`INIT` 前缀只在 `ensure_admin_token` 里、随机口令长度与字符集、摘要与 `--verbose` 两种输出、
以及 install 的两个入口都接了 `VANBLOG_RESTORE_FROM`。
⚠️ 用例之间要 `unset INIT_MODE/LOGIN_FAIL/RESTORE_FAIL/...`：漏了一个 `INIT_MODE`，
后面所有用例都会走"已初始化"分支去交互登录、读到 EOF 失败，表现为一片莫名其妙的 rc=1。

### 7.35.1 交互菜单与 `--help` 重写（以及一次差点删掉半个脚本的教训）

菜单和 `show_usage` 都停在几个版本以前了：菜单门头还写着上游仓库地址、
"安装来源"那行谎称默认是**本地构建镜像**（现在默认是拉 ghcr 镜像、拉不到才构建）、
没有 `status` 入口；`show_usage` 里 `backup`/`restore` 各有两条互相矛盾的条目（旧的"备份 VanBlog"
和新的"整站备份"并存），还写着"默认从源码构建本分支，不用官方镜像"。

**菜单**现在长这样（编号全部保持不变 —— 文档和用户都按编号操作，`6` 是更新、`20` 是更新脚本）：

```
    VanBlog 管理脚本 v0.5.0
    本分支  ：CKboss/vanblog 分支 dev/dsh（上游项目 Mereithhh/van-blog）
    安装目录：/var/vanblog    数据目录：/var/vanblog/data
    镜像来源：ghcr.io/ckboss/vanblog:dev-dsh
              模式 auto：先拉镜像，拉不到再从源码构建
    状态    ：● 运行中  http://<域名或服务器IP>:80（后台在后面加 /admin）
    ── 安装与日常 ──   1 安装/重装  2 修改配置  3/4/5 启停重启  6 更新  7 日志  13 状态总览
    ── 备份与恢复 ──   10 备份（整站备份）  11 恢复（不停服）  12 重置整站（新机器推荐）
    ── 其它 ──         8 卸载（不删备份）  9 重置 https  20 更新脚本  30 使用说明  0 退出
```

新加的**状态行**（`menu_state_line`）会探一次 `<宿主机端口>/api/public/meta`（超时 3 秒），
三种结果：`未安装`（没有编排文件）/ `● 运行中` + 访问地址 / `○ 接口不通` + 端口与状态码 +
"用 3 启动、7 看日志、13 看总览"。这样一进菜单就知道现在是什么情况，不用先跑一遍 status。

**`show_usage`** 重写成分组的详解：安装与日常 / 备份·恢复·重置（每个子命令的**全部参数**与
注意事项，包括"恢复不停服""恢复后要重新登录""老 tar.gz 会走离线恢复且停不下来就不解压"）/
环境变量（按"装什么、放在哪、构建用哪个源、备份与恢复、其它"分组）/ 常见场景配方
（新机器装机、换机器一步搬站、cron 定时备份、升级、回滚镜像、站点打不开怎么查、磁盘满了）/
约定（退出码语义、需要 root、破坏性操作要输完整 yes、各路径的含义）。
⚠️ 正文用**引号 heredoc**（`<<'USAGE'`）：里面有大量 `$VAR`、`$(...)` 形式的示例，
不加引号会被当场展开甚至执行（`$(date)` 这种示例会真的跑一遍）。
需要显示实际默认值的几行单独 `echo` 在最后。

**守卫**（`docs-consistency.test.sh` 27 → 48 条）：dispatcher 里每个子命令都必须出现在 `--help` 里；
菜单必须有 13/状态总览、12/重置整站、"整站备份"字样、状态行；菜单门头不许再是上游仓库地址、
不许再谎称默认本地构建；`--help` 必须覆盖 `VANBLOG_INSTALL_MODE`/`VANBLOG_MONGO_IMAGE`/
`VANBLOG_RESTORE_FROM`/`VANBLOG_ADMIN_TOKEN`/`VANBLOG_ASSUME_YES`/`VANBLOG_ALPINE_MIRROR`
以及"退出码/换机器/定时"这几段；不许再有旧的重复 `backup` 条目和"默认从源码构建"的说法。

⚠️⚠️ **一次差点毁掉半个脚本的教训**：用 `s.index('show_menu() {')` 定位函数头，
结果匹配到的是 **`before_show_menu() {`**（子串！），于是"从函数头替换到菜单 read 行"
把中间的 `install_base`/`install_soft`/`install_vanblog`/`selinux`/`config`/`restart`/…
**1853 行全删了**，而且 `bash -n` 还是通过的（语法没错，只是函数没了）。
发现是因为随手一测 `get_compose_http_port` 报 command not found。
规矩：
1. 定位函数一律用**换行锚定**（`'\nshow_menu() {\n'`）并断言 `count == 1`；
2. 改完**先做完整性检查再落盘**：行数变化量要合理，并且逐个确认关键函数还在
   （现在这段检查列了 53 个函数名，缺一个就 assert 失败）；
3. 大改之前 `cp` 一份备份（这次靠 `git checkout` 救回来的，但如果已经 commit 过中间态就更麻烦）。

### 7.36 插件式前台主题（后台上传一份 CSS 就能换肤）

用户要的是："apple 主题是不是一个 css 文件？能不能做成插件式的 —— 后台上传/选择主题，
前台刷新后自动生效，并且在项目里补上主题怎么实现的文档和一个 demo 教程。"

**答案与做法**：apple 主题确实就是一份 CSS（`packages/website/styles/apple.css`，1430 行，
被 `globals.css` `@import` 进产物，所有规则挂在 `[data-ui="apple"]` 下）。现在把这套约定
**通用化**成了主题系统：

| 层 | 做了什么 |
| --- | --- |
| 数据 | `siteInfo.uiStyle` 从 `'default' \| 'apple'` 放宽成 `string`（就是主题 id）；上传主题的元数据存 `settings` 的 `{type:'theme', value:{themes:[…]}}`（不新建集合，整站备份也不用多一张表） |
| 文件 | CSS 落在 `<staticPath>/themes/<id>-<hash8>.css`（hash = sha1 前 8 位）。**文件名带 hash**：同 id 覆盖上传后 URL 变化，中间层缓存自然失效；旧文件在写新文件**之后**才删（先删后写的话中途失败会把正在用的主题弄没） |
| 服务端 | `ThemeProvider`（list/upload/activate/remove/getActive）+ `ThemeController`（`/api/admin/theme/*`）+ `PublicThemeController`（`/api/public/theme`、`/api/public/theme.css`） |
| 校验 | `validateThemeCss()`（纯函数，好测）：≤512KB、拒 NUL、拒 `javascript:` / `expression(` / `behavior:` / `-moz-binding` / `</style>` / `<script>`；远程 `@import` 放行但警告；没有 `[data-ui=` 也警告 |
| 前台 | `getLayoutProps` 原样透传主题 id；`Layout` 把 id 写到 `<html data-ui>` 与 `.vb-root`，非内置主题额外挂 `<link href="/api/public/theme.css?v=<id>">` |
| 后台 | `系统设置 → 主题` 新标签页（列表 / 上传弹窗 / 启用 / 删除 / 查看 CSS）；`站点配置 → 界面风格` 的下拉框动态列出上传的主题（**初始化向导阶段不调**，那时没登录态，调 `/api/admin/**` 必 401） |
| 文档 | `docs/features/theme.md`（原理 + 从零写一个主题的教程 + 稳定钩子表 + 限制 + 接口 + FAQ）与可直接上传的示例主题 `docs/.vuepress/public/theme-demo.css`（「暖纸」，含亮/暗两套令牌） |

**两个关键取舍**（都是被"前台是静态生成的"逼出来的）：

1. **主题 CSS 走 `GET /api/public/theme.css` 这个固定地址**，而不是直接链
   `/static/themes/<id>-<hash>.css`：前台的 `<link href>` 在渲染时就写死进 HTML 了，
   href 里带 hash 就意味着"换主题必须等所有页面重新渲染完"。固定地址 + `ETag`（内容 hash）
   + `Cache-Control: no-cache` 之后，浏览器每次廉价协商（没变 304、变了拿新的），
   **刷新即生效**，不依赖 ISR 跑没跑完。内置主题没有独立文件，返回 **204**
   （不是 404 —— 前台挂着 link 也不该报错）。
2. **启用主题仍然触发一次 `isrProvider.activeAll(…, {forceActice:true})`**：
   页面里的 `data-ui` 值本身变了，静态 HTML 必须重渲染才对得上。两件事互补。

⚠️ **命名撞车**：仓库里 "theme" 有两个不相干的含义 —— `packages/website/utils/theme.ts`
（+ `__tests__/theme.spec.ts`）是**明暗模式**（`html.dark`、`applyThemeClass`、`getAutoTheme`），
本节说的是**皮肤**。皮肤相关的代码在 `packages/server/src/{types/theme.dto.ts, provider/theme/,
controller/admin/theme/, controller/public/theme.controller.ts}`、
`packages/website/__tests__/customTheme.spec.ts`、`packages/admin/src/pages/SystemConfig/tabs/Theme.jsx`。
动手前先确认自己改的是哪一个。

⚠️ **一次真实事故**：我用 `cat > packages/website/__tests__/theme.spec.ts` 写新测试，
把**已有的 13 个明暗模式测试整个覆盖掉了**（全量跑从 552 掉到 545 才发现）。
规矩：新建文件前先 `ls` / `git status` 看它在不在，或者直接用 write 工具
（它会拒绝覆盖没读过的文件 —— 这次是我用 heredoc 绕过了这道保护）。
我的测试已改名 `customTheme.spec.ts`，原文件用 `git checkout` 还原。
**同样的事故当天又发生了第二次，而且被提交推了出去**：`packages/admin/src/services/van-blog/theme.js`
本来就是后台**明暗模式**的工具（`getInitTheme` / `decodeAutoTheme` / `mapTheme` / `beforeSwitchTheme`，
被 `app.jsx` 与 `ThemeButton` 用着），我用 `cat >` 写皮肤接口时把它整个覆盖了 ——
`git status` 里它是 ` M`（已跟踪文件被改），不是 `??`，这本来就是最明显的信号。
现象是后台编译报
`export 'beforeSwitchTheme' … was not found in './services/van-blog/theme'`。
修法：`git show HEAD~1:<path> > <path>` 还原，皮肤接口挪到 **`skinTheme.js`**，
并加了一条"两个文件各是什么、不许互相污染"的断言。
**规矩（写进这里，别再犯）**：新建文件前一律先 `ls` 目标路径 / 看 `git status` 是 `??` 还是 ` M`；
要用 heredoc 写文件就先确认它不存在；命名时避开仓库里已有的同名词
（"theme" 在本仓库指**明暗模式**，皮肤相关的文件一律用 `skin`/`customTheme` 前缀）。

⚠️ **校验要扫"去掉注释之后"的文本**：示例主题的注释里就写着
"javascript: / expression() / <script> 会被拒绝"，扫原文会把自己家的 demo 拒掉
（第一次实测上传就是这么失败的）。去注释时**替换成空串而不是空格**：
CSS 分词虽然把注释当分隔符、`java/*x*/script:` 严格说不会变成 `javascript:`，
但安全扫描宁可保守（正常 CSS 里不可能出现这种写法）。

⚠️ **`getSiteInfo()` 的归一化会吃掉自定义主题**：原来写的是
`uiStyle: siteInfo.uiStyle === 'default' ? 'default' : 'apple'` —— 前台读的是 `getAll()`
的原始值所以看着正常，但后台表单初值等走 `getSiteInfo()` 的地方会一律显示成 Apple 风格，
让人以为没存上。已改成原样保留、缺省 apple（`appleTheme.test.js` 里钉旧行为的那条断言一起改了）。

**实测**（本机 dev，server :3000 / 前台 :3001）：上传示例主题 →
`{id: warm-paper, url: /static/themes/warm-paper-28381fac.css, size: 5521, warnings: []}`；
启用 → `/api/public/theme` 返回 `uiStyle: warm-paper`；`/api/public/theme.css` → 200，带
`ETag: W/"28381fac"` 与 `Cache-Control: no-cache`、5521 字节；带 `If-None-Match` 再请求 → **304**；
前台首页 HTML 里出现 `data-ui="warm-paper"` 与
`<link rel="stylesheet" href="/api/public/theme.css?v=warm-paper"/>`，经前台代理取 CSS → 200；
磁盘上 `vanblog_dev/static/themes/warm-paper-28381fac.css` 在。测完已切回 apple（主题文件保留）。

⚠️ **后台接口一律回 JSON 信封 `{statusCode, data}`，别直接回裸文本**：
后台 umi 的 `request` 配了 `errorConfig.adaptor`（`services/van-blog/requestError.js` 的
`adaptAdminResponse`），它会对**每一个**响应跑一遍，拿不到 `{statusCode,data}` 就判定失败并抛
**BizError**。第一版「查看 CSS」的接口直接 `res.type('text/css').send(css)`，
点一下就报 `读取 CSS 失败：BizError`；而服务层的 `parseResponse: false` / `responseType: 'text'`
**救不回来**（adaptor 在它之前就跑完了）。修法：`GET /api/admin/theme/:id/css` 改成回
`{statusCode:200, data:{id,name,url,hash,size,css}}`，前台读 `res.data.css`；
真正要给浏览器当样式表用的 `/api/public/theme.css` 仍然必须是裸 `text/css`（那是 `<link>`，不走 umi）。
另外 `size` 要用 `Buffer.byteLength` 而不是 `text.length`：主题里有中文注释时字符数比字节数小，
和列表里显示的上传大小对不上，看着像文件被改小了。

**测试**：`packages/server/src/provider/theme/theme.provider.spec.ts`（25 条，mock 掉
settings/meta/isr 与静态目录：校验规则、slug、内置排序、上传落盘与元数据、同 id 覆盖删旧文件、
只有改到当前主题才触发渲染、启用写 uiStyle、内置/在用的不给删）；
`packages/website/__tests__/customTheme.spec.ts`（6 条接线断言）；
`packages/admin/tests/unit/themeTab.test.js`（15 条：标签页注册、五个动作都接上、上传弹窗写清规则、
内置与在用的不给删、服务层地址与 token、界面风格下拉在初始化阶段不调鉴权接口、服务端注册与文件位置、
文档与示例主题存在且示例本身不会被自己的校验拒掉）。

### 7.38 caddy 的协议与连接池优化（HTTP/2 已有、HTTP/3 打开、上游连接池、/atom.xml 修复）

用户问："caddy 中用的 http 是不是还是 1.1，这个服务器的配置能不能优化？"

**先把事实查清楚**（读 `caddyTemplate.json` + 用真 caddy 跑起来看日志，不猜）：

| 位置 | 改之前 | 改之后 |
| --- | --- | --- |
| 访客 → caddy `:443` | **h1 + h2 + h3 全都已经开着**（实测 2.11.4：不写 `protocols` 时默认就是这三个，且已在发 `alt-svc: h3`）；真正挡住 h3 的是**编排文件没映射 UDP 443** | 显式写 `protocols: ["h1","h2","h3"]`（**钉住默认值**，不是"打开"） |
| 访客 → caddy `:80` | h1（明文没有 h2/h3） | 不变（h3 只在 srv0 上开，明文开 QUIC 没意义） |
| caddy → server:3000 / website:3001 | HTTP/1.1，**连接池用 Go 默认值**（`MaxIdleConnsPerHost = 2`） | HTTP/1.1 + `keep_alive{idle_timeout:60s, max_idle_conns:64, max_idle_conns_per_host:32}`（28 处） |
| caddy → waline:8360 | 带 `trusted_proxies` | **原样不动**（低流量，少一处改动就少一处读配置的噪音） |
| 压缩 | `zstd` + `gzip`，prefer zstd | 不变（Caddy 不支持 brotli，zstd 已是最优） |

⚠️ **我一开始判断错了，实测才纠正过来**：我以为 "caddy 的 HTTP/3 默认是关的、要显式写 `protocols`"，
于是把加 `protocols` 当成了本次的主要优化。用真 caddy 跑对照实验才发现**不是**：
不写 `protocols` 的 TLS 监听，日志就是 `protocols:["h1","h2","h3"]`，响应头也有
`alt-svc: h3=":8443"; ma=2592000`；而写了 `protocols h1 h2` 的那个对照实例就没有 alt-svc。
也就是说 h3 早就"开"着，**访客用不上它纯粹是因为 QUIC 的 UDP 443 没有从容器发布出来**。
教训：涉及"某软件默认开没开某特性"，别靠记忆，起两个实例做 A/B 对照，看日志和响应头。

**HTTP/3 真正缺的那一环**：QUIC 跑在 UDP 上，编排文件必须映射 `443/udp`，
否则浏览器永远只能用到 h2。已在 `docker-compose-template.yml` 加了
`- vanblog_https_port:443/udp`（TCP 那条保留，不是替换）。**没放行 UDP 也不会坏** ——
caddy 照样发 `Alt-Svc`，浏览器试连失败自动退回 h2，所以这是个安全的默认。
老安装要跑一次 `./vanblog.sh config` 重新生成编排文件；`show_status` 会直接告诉用户
QUIC 端口映射了没有（新增 `get_compose_https_port` / `compose_has_quic_port`，
注意端口解析不能被新加的 `/udp` 行带偏，有测试钉着）。

**顺手挖出一个真 bug**：`/atom.xml` 那条路由的 rewrite 是从 `/feed.xml` 复制来的，
`find` 写成了 `/feed.xml` —— 永远匹配不上，于是 `/atom.xml` 直接 **404**，
而 `docs/advanced/rss.md` 明明把它当公开地址写着（`/feed.xml`、`/feed.json` 都是好的，
所以这个坏法特别隐蔽）。已改成 `find: "/atom.xml" → replace: "/rss/atom.xml"`，
并把三条短地址一起写进测试。实测：改之前 `/atom.xml` 经 caddy 是 404、`/rss/atom.xml` 是 200。

**怎么在没有容器的情况下验证 caddy 配置**（这次的关键手法，值得记住）：
本会话里 podman 已经用不了了（`failed to open 2048 locks in /libpod_rootless_lock_1000: permission denied`，
沙箱不给写默认 runtime 目录），但 caddy 是**单个静态 Go 二进制**，直接下载就能在宿主机跑：

```bash
proxychains4 -q curl -sSL -o /tmp/caddy.tar.gz \
  https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz
tar xzf /tmp/caddy.tar.gz -C /tmp/caddybin && /tmp/caddybin/caddy version   # v2.11.4，与镜像里同版本
```

于是能做到**真验证**而不是"看着像对"：

1. `node scripts/caddyConfig.js caddyTemplate.json permission <email>` 生成配置
   （⚠️ 必须先生成再 validate：裸模板里是 `ask` 形式，caddy 2.11 会拒绝
   —— "on-demand TLS cannot be enabled without a permission module"），
   再把 `logging` 段去掉（本机没有 `/var/log` 写权限），`caddy validate` → **Valid configuration**
   （主模板与降级模板都过）。
2. 真起一个 caddy（`tls internal` + `auto_https disable_redirects`，因为非 root 绑不了 :80）
   反代到本机 dev server:3000，然后：
   - 日志里出现 `"server running","name":"srv0","protocols":["h1","h2","h3"]` ✓
   - `curl -k --http2 https://127.0.0.1:8443/api/public/meta` → **HTTP/2 200**，
     响应头有 **`alt-svc: h3=":8443"; ma=2592000`**（h3 已启用并对外广告）✓
   - `--http1.1` 对照 → HTTP/1.1 200 ✓；`Accept-Encoding: gzip` → `content-encoding: gzip` ✓
   - 20 个并发请求走连接池：0.47s ✓
3. Caddyfile 的 `keepalive` 不接受 `on`（`bad duration value 'on'`），要写时长；
   用 `caddy adapt` 把 Caddyfile 翻成 JSON，才能确定 `transport` 的确切形状：
   `{"protocol":"http","versions":["1.1"],"keep_alive":{"idle_timeout":60000000000,"max_idle_conns":64,"max_idle_conns_per_host":32}}`
   （时间单位是**纳秒**）。⚠️ 别凭记忆写 JSON 字段名，用 `caddy adapt` 反查最快。

**故意没做的事**（都有理由，别再当"待优化"提出来）：

- **上游不开 h2c**：Nest(Express) 与 Next standalone 默认都不支持 HTTP/2，开了反而要改上游启动方式；
  本机回环上 h1.1 + 连接池已经够了。
- **不让 caddy 直接 `file_server` 服务 `/static/*`**：虽然能省掉一跳 Node，但静态目录的
  Cache-Control / ETag / content-type / 缩略图逻辑现在都在 server 里，搬一部分到 caddy
  会出现两处真相，得不偿失。
- **不给主路由加 `trusted_proxies`**：客户端 IP 的正确性已经在应用层处理
  （`provider/log/utils` 优先 `CF-Connecting-IP`，有测试），反代场景的写法在
  `docs/reference/reverse-proxy.md` 里；在 caddy 里默认信任私网段会让局域网客户端能伪造 XFF。
- **不动 `read_timeout` / `write_timeout`**：不设限是有意的 —— 整站备份下载、Markdown 导出
  都是大响应，设小了会在传输中途被掐断。
- **不调 `encode.minimum_length`**：Caddy 默认 512 字节已经合理。

**测试**：`scripts/tests/caddy-perf.test.sh`（12 条）—— 两份模板的 srv0 都有 h1/h2/h3 且 srv1 没有、
热点上游的 `transport.keep_alive` 参数齐全而 waline 上游保持原样且没丢 `trusted_proxies`、
三条订阅源 rewrite 的 `find` 与路由路径一致、编排模板映射了 UDP 443 且 TCP 那条还在、
脚本有那两个新函数且 status 会提 HTTP/3、用模板生成的编排文件端口解析不被 UDP 行带偏、
以及**本机有 caddy 二进制时真的跑一遍 `caddy validate`**（没有就跳过并说明）。

**文档**：`docs/faq/deploy.md` 新增"用的是 HTTP/1.1 还是 HTTP/2 / HTTP/3"（含 `curl -I --http2`
看 `alt-svc`、浏览器 Network 的 Protocol 列、UDP 443 的两个前提、老安装要重跑 config）；
`docs/reference/reverse-proxy.md` 新增"协议：HTTP/2 与 HTTP/3 在哪一层生效"
（外层反代决定访客协议、nginx 不能反代 UDP 所以 QUIC 过不去、Cloudflare 在边缘终结 h3）；
`docs/advanced/rss.md` 补上三条短地址与 `/rss/...` 的改写关系。

### 7.38.1 安全响应头 + 备份保留策略（本轮审计里已落地的两项）

**全站安全响应头**：`caddyTemplate.json` 里原本**只有** `/admin*` 与 `/api/admin*` 两条
`headers` 处理器（都是 `Cache-Control`），一个安全头都没有。server 自己的中间件
（`utils/rateLimit.ts`）会给 `/api/**`、`/static/**` 下发 `nosniff` / `Referrer-Policy` /
`X-Frame-Options` / `Permissions-Policy`，但**前台页面的 HTML 是 caddy → website:3001 直接反代的，
一个头都没有**（实测直连 3001 的安全头数量 = 0）。而 `docs/advanced/security.md` 写着
"caddy 模板与 Nest 中间件都下发" —— 文档在说谎。

修法：在两个 server 的 `route[0]`（无 matcher 的全局路由，与 `encode` 并列）各插一个 `headers`
处理器：`deferred: true` + `delete: ["Server"]` + `set` 那四个头。三个要点：

- `deferred: true` 不能少：否则反代回来的响应、以及 caddy 自己的 5xx 都不会带上；
- 用 `set`（覆盖）而不是 `add`（追加），所以 `/api/**` 上不会和 server 已有的头重复；
- `X-Frame-Options` 保持 `SAMEORIGIN` 而不是 `DENY`（后台要 iframe 同源的 waline `/ui`）。

实测：用改过的模板生成的配置起真 caddy（本机把监听改成 8080/8443，因为非 root 绑不了 80/443，
还得 `auto_https disable_redirects`，否则 caddy 会去绑 :80 做跳转然后 permission denied），
前台首页四个头齐了。**没加 HSTS**：一旦 TLS 出问题会把站长锁在门外，属于用户自己该决定的事。

**备份保留策略**：`prune_old_backups <full|offline> <keep>` + `backup --keep N` /
`VANBLOG_BACKUP_KEEP`。以前**整个仓库没有任何清理逻辑**（脚本和 server 都只管写不管删），
而文档又教用户配 cron 每天备 —— 一份 66MB，一个月 2GB。边界全部朝"宁可少删"定：
只认 `vanblog-full-*.tar.*` / `vanblog-backup-*.tar.*` 两种名字、只在备份 `rc == 0` 之后清理、
keep 不是正整数就 `return 0`、`rm -f "${dir:?}/..."` 带 `:?` 保护（dir 为空时不会退化成
`rm -f /xxx`）、连带删同名 `.manifest.json` sidecar（不删的话 `restore` 的列表里会出现孤儿清单）。
排序用 `ls -1t`（比 `find -printf` 可移植）。
⚠️ 体积显示踩了个小坑：`human_size` 收的是**文件路径**（内部走 `du -h`）而不是字节数，
把字节数传给它只会得到空串（`|| echo` 也救不了，因为它 exit 0）；新加了 `human_bytes <n>`
（纯 awk）用于"删完之后报总共释放多少"。

**顺手更正 `docs/advanced/security.md` 的"已知限制"清单**（两条已经过时，留着会误导人）：

- "`/post/<数字id>` 与 `/post/<别名>` 都返回 200，没有 canonical / 301" —— 实测 `/post/53`
  → **308** 跳到拼音别名，首页也有 `link rel="canonical"`，早就修好了；
- "website 的 `__tests__` 里还有约 27 个类型错误，靠 `VANBLOG_SKIP_TYPECHECK` 绕过" ——
  实测 `packages/website` 跑 `tsc --noEmit` 报 115 个错，**全部来自本机 `~/node_modules/bun-types`**
  （TS 4.9 解析不了它的新语法，见 §3.6），仓库代码 0 个类型错误。
  副作用：website 没有 server 那样的 `tsconfig.dev.json`，所以本机没法把 tsc 当门禁用。

### 7.38.2 第二轮性能审计（已落地的 5 项 + 明确暂缓的 6 项）

三个方向并行审（前台 / server 运行时与 DB / 依赖·CI·运维），下面只记**已改的**与**为什么不改**。
实测数据都在 `docs/advanced/performance.md` 的"第二轮"一节。

**已改（website）：**

1. **列表摘要里的原图 → 缩略图**。首页摘要里嵌着 3,497,836 B 与 1,076,400 B 两张 webp，
   而对应缩略图是 14,098 B / 8,076 B；同一张图的缩略图还被 `ListThumb` 另外请求了一次
   （一张图下载两遍：8KB + 1MB）。`loading="lazy"` 只是推迟，没有省。
   新增 `utils/excerptThumbs.ts`（`toThumbPath` / `withThumbnailImages`，markdown 与内联 `<img>`
   两种写法都处理；外链、`/static/file/`、子目录、带 `?`/`#` 的一律不动），
   只在 `PostCard` 的 **overview 分支**用 —— 文章页正文必须保持原图。
   `components/Markdown/img.tsx` 的 rehype 插件给缩略图补 `data-zoom-src`（medium-zoom 1.1 支持，
   所以"省流量"和"点开看大图"不冲突），并注册一次 `error` 回退到原图（老图片可能没补过缩略图）。
   ⚠️ `data-zoom-src` **只能在 rehype 插件里加**：bytemd 管线是 `sanitize → 插件`，
   写在 markdown 里的 `data-*` 会先被 `rehype-sanitize` 删掉。
   **实测：首页那两张图 4.57MB → 22KB（208 倍）。**
2. **`getPublicMeta()` 加 5s TTL + 并发合并**（`__resetPublicMetaCache()` 是给测试用的）。
   一轮 ISR 全量重渲染 ~130 个页面、每页调一次、同一份 8.3KB 串行拉 130 次（~1MB）；
   接口只发 ETag 不发 Cache-Control，undici 也复用不了。模式抄的是 `utils/commentApi.ts`。
   ⚠️ **只缓存成功结果**：构建期连不上 server 会走默认值分支，缓存了它整个构建就都是空数据。
3. **封面 CLS**：`.article-cover img { aspect-ratio: 21/9; height: auto }`。
   `ArticleCover` 的 `<img>` 没有宽高、`.article-cover` 以前一条 CSS 都没有 → 盒子高度先 0
   再跳到 `min(缩放高, 320px)`，而它正是被 preload 的 LCP（16/53 篇有封面）。
4. **GA 判据收紧**：`shouldInjectGa` 与 `describeGaInjection` 都要求 `^G-…|UA-…$`。
   本站 `gaAnalysisId` 里填的是别家统计的 id，以前照样请求 `gtag/js?id=…` → **200 / 242,542 B**，
   为一个不存在的媒体资源白下载。⚠️ 组件调的是 `describeGaInjection`，只改 `shouldInjectGa` 没用
   （我的第一版就只改了前者，测试立刻抓到）。
5. **`largePageDataBytes` 10MB → 256KB**：Next 13 默认 128KB，抬 80 倍等于关掉唯一的告警
   （现有最大是 `/timeline` 的 73KB）。顺带说明：`website.provider.ts` 把
   `The value at .experimental has an` / `Invalid next.config.js options` 两条 stderr 过滤掉了，
   所以这类配置告警在生产日志里也看不见。

**已改（server）**：见 §7.38.3。

**明确暂缓（都量化过，别当"没人发现"重复提）：**

| 项 | 实测 | 暂缓原因 |
| --- | --- | --- |
| 首页/分页把**全文**塞进 `__NEXT_DATA__` | HTML 114KB（gzip 33KB），`__NEXT_DATA__` 占 31.8%（gzip 后 **54.8%**）；5 篇 content 25KB，卡片只要 3.3KB 摘要 → **87% 白送**；模拟修完 gzip −31.8% | 要在 server 侧出 `excerpt`：把 `utils/articleExcerpt.ts`（围栏感知的 `findMoreMarker`、200 字回退、截断链接修复、代理对安全）移植过去，并让 `markdown.provider.getDescription` 改为委托它，否则两份实现会漂。跨 server+website，得配"两边摘要一致"的对照测试；还要处理 9 篇没有 `<!-- more -->` 的文章（#410 那个"卡片里露出 `[文字](url)` 括号"的回归就出在这条路径上） |
| ~~ByteMD **编辑器**进了每个 markdown 页面的首屏 JS~~ **这条判断是错的，已被生产构建推翻**（见 §7.45）：那个"1148 个模块、含 9 个 codemirror-ssr"的证据来自 **dev/server chunk**，不是浏览器下载的产物。真跑 `next build` 后逐个 chunk 搜 `CodeMirror`/`tippy`/`popper`/编辑器工具栏字符串，**一个都没有** —— 编辑器本来就没进客户端包。原来的记录：| 两条路都要跑生产构建对比：① 摘要在服务端渲染成 HTML（和上一条一起做最划算，注意仍要过 `sanitizeMarkdownSchema`）②内联 `@bytemd/react` 那 30 行 `Viewer` 并给 bytemd 标 `sideEffects:false`。另外 `dynamic(..., {ssr:true})` 在首页的**初始** script 列表里 —— 它一点都不 defer |
| `/timeline` 带 42.5KB 没人读的数据 | pageProps 73.5KB 里 `sortedArticles`(21.3KB) + `yearGroup.articles`(21.2KB) 都无读者（`TimelineArchives` 只在 `months.length===0` 时才读，实测 4 个年份组一个都不满足） | gzip 后只省 6.6%（两份 JSON 高度相似），收益主要在解析/内存；要同步改 `timelineMonths` 的测试与"没有日期的文章"回退路径 |
| 每张卡片一个未合并的阅读量请求 | 5 次串行 XHR（89ms vs 并行 36ms），每次回 220B 的**整个 visit 文档**只为显示一个整数，而这数字 pageProps 里已经有 | 要加批量接口（或并进 `/comments/counts` 那种 50ms 合并器，`commentApi.ts:96-146` 是现成范例）；顺带把初始值从 pageProps 里 seed，省掉卡片上 `"..."` → 数字的抖动 |
| apple 皮肤 46KB CSS 在全局表里 | 全局 CSS 72.7KB（gzip 16.3KB）：apple 46.2KB + markdown 相关 43KB；用 `default`/自定义主题时那 46KB 纯浪费，且 markdown 那部分在 `/link`、`/tag`、`/category`、`/timeline` 上也用不到 | 现在主题机制已经有 `/api/public/theme.css` 这条路，内置 apple 也可以走；但 apple.css 依赖"在 Tailwind 之后引入"的顺序，挪成 `<link>` 要对两种皮肤做视觉对比 |
| 字体走 `static.zeoseven.com` | 本机 DNS 解析不出来：每页一次 preconnect + 一个 stylesheet 卡在 DNS 上；而且 CSS 是水合后才从 `media="print"` 提升的，字体下载**最早也要等 JS 跑完**（没有 preload，FOUT 必然） | 正解是自托管到 `public/fonts/`（`utils/appleFont.ts:8-10` 的注释里就写着这条路）+ 给覆盖站名/导航的 2–3 个子集加 `preload`；CJK 按 unicode-range 切子集比较费事，切错了会掉字形 |

**⚠️ 一个不是代码问题、但影响最大的**：本站 `layout.html`（后台「定制化」里的自定义 HTML，
存在库里、随 `/api/public/meta` 下发）里塞了一堆第三方脚本 —— 一个 **798,345 B 的 MathJax**
（而公式早就由 KaTeX 在服务端渲染了，纯属重复）、gtag 与百度统计**各加载两次**
（一次来自 `layout.html`，一次来自 `siteInfo` 里的统计 ID 字段）、两个 51la 属性且
`screenRecord:true`（会话录制）、一个 `mapmyvisitors.com` 的 `<img>`（本机实测 >8s 超时）、
几个没有宽高的计数器 `<img>`。这些是**站点数据**不是仓库代码，改法是在后台把那段 HTML 清一清
（MathJax 那条删掉就省 798KB），代码侧能做的兜底（GA 判据）已经做了。

### 7.38.3 server 运行时审计（已落地的 5 项）

1. **`GET /api/public/article/%25` → 500**（未鉴权公开接口，一个百分号就能让它报错）：
   `getByPathName` 里裸调 `decodeURIComponent`，`%` 抛 URIError。新增 `utils/safeDecode.ts`
   （解不开原样返回 + 限长 500），实测 `%25`→404、`%zz`→400、`%2525`/`a%2Fb`/`..%2f..%2fetc`→404，
   而真的百分号编码别名（`%E4%B8%AD%E6%96%87`）仍然解得开。
2. **文章阅读量是"读出来 +1 写回绝对值"** → 并发看同一篇会**永久少计**。
   `visit` / `meta` 两个 provider 早就改成原子 `$inc` 了，文章这边漏了。
   `updateViewerByPathname` 与 `updateViewer` 现在都是 `$inc` + `$set lastVisitedTime`。
3. **恢复密钥写死 `/var/log/restore.key`**：容器里正好有这个目录所以看不出来，
   裸机部署（日志目录由 `config.log` 决定）就一直写失败 —— 本机日志里失败了 **19 次**，
   密钥只存在于 stdout。改成 `config.log || '/var/log'`，权限仍 0600。
4. **热查询没索引**：`visits` 只有单列索引，`{pathname} + sort(date:-1) + limit 1`
   （公开接口每次浏览都查）被 planner 选成"`date_1` 倒着扫再过滤"——
   explain 实测一个 6 天没访问的路径 **examined=125**，天数越久越多，冷路径等于扫全表。
   加 `{pathname:1, date:-1}` 复合索引后 **examined=1**。
   `articles.viewer/visited/lastVisitedTime` 也没索引，后台"阅读排行/最近浏览"每次全表扫 + 内存 SORT
   （explain 里有 SORT 阶段，examined=106）；加索引后按 viewer 排序 **examined=5、无 SORT 阶段**。
   ⚠️ `autoIndex: true` 必须留着：项目没有迁移工具，索引全靠启动时同步。
5. **`schedule/count.task.ts` 是死代码**（从未在 `app.module` 注册，grep 零引用），已删。
   它想做的"每 5 分钟刷字数缓存"本来就由启动时 + 每次增删改后 30s 的 `updateTotalWords` 覆盖，
   真注册上去等于每 5 分钟把全部文章连正文捞一遍。

顺手：mongoose 连接不再全用驱动默认值 —— `serverSelectionTimeoutMS` 10s（默认 30，
mongod 重启时每个请求要干等半分钟）、`connectTimeoutMS` 10s、`socketTimeoutMS` 120s
（默认 **0 = 永不超时**：网络黑洞时借出的连接一直卡着，池子 100 个占满就是整站假死）、
`maxPoolSize` 100、`retryWrites/retryReads` on，四个都能用 `VANBLOG_MONGO_*` 覆盖，
且解析成非数字时回落默认值（不能把 NaN 交给驱动）。socket 超时故意给得宽，
免得误伤整站备份/恢复/大集合导出这类长任务。

**server 侧已量化但暂缓的**（都是"要么改接口语义、要么要迁移数据"，需要单独决策）：

- **公开文章列表把整个集合连正文捞回来**：`getByOption` 只在 `!isPublic` 时才 skip/limit
  （`article.provider.ts:817-820`），然后在 **JS 里**排序/过滤/切置顶，再 `count(query)`，
  再对每篇文章 `categoryModal.findOne` 一次（N+1）。explain：内存 SORT、examined=106、returned=53
  （全部公开文章连正文 ≈200KB），`pageSize=-1`（前台静态生成）时 N+1 覆盖全部文章。
  **本轮只修了 N+1**（复用已有的 `getPrivateCategoryNames()` 一次查完做成 Set）、
  `countTotalWords` 加 `{content:1}` 投影、`searchByString` 加 `.limit(200)`；
  把置顶排序与分页推进 Mongo 是下一步（要同时保证前后台两个视图的排序语义不变）。
- **每次浏览 ~11 次 Mongo 操作 / 4 次写**，分散在 metas、articles、viewers、visits 四个集合，
  无批量、无防抖；`visits`/`viewers` **永不清理**（实测 visits 8748 条、跨 800 天，
  索引 0.88MB 已大于压缩后的数据 1.21MB 的 70%），而且 `visit.provider.add` 的
  "重复键兜底"依赖一个**并不存在**的 `{date,pathname}` 唯一索引（listIndexes 实测只有非唯一的
  `date_1`/`pathname_1`），并发首访会静默产生重复行。要做得先写一个去重迁移再加唯一索引。
- **ISR 风暴没有护栏**：25+ 处调用 `activeAll`，只有 1s 防抖、**没有 in-flight 互斥**，
  `activeWithRetry` 不 await 也不 catch，`testConn`/`activeUrl` 的 axios **没有超时**；
  一轮 ~130 次串行重渲染（含 6 篇已删除文章的 id 与别名两条路径）。
  本机还实测到**两个 server 进程同时在跑 cron**（watch 重启留下的孤儿进程），
  说明定时任务也没有多实例保护。
- **RSS 每次全量同步渲染**：实测 53 篇 markdown-it+hljs+katex = **135ms 同步阻塞事件循环**，
  三份 feed 各约 350KB（**全文、无条数上限**），每小时 + 每次启动 + 每次编辑后 3 分钟各跑一遍。
  应该限条数（20–30）并改成异步/增量。
- `express.json({limit:'50mb'})` 挂在**所有**路由上（评论只需要几 KB，只有备份恢复/上传才要大）；
  无 request-id / 无 API 访问日志 / 无慢查询日志；`InitMiddleware` 每个请求都
  `userModel.findOne({})`（还把密码哈希读进内存）；`initJwt` 在 `main.ts` 与 JwtModule 工厂里
  **各跑一次**且两次都不 `client.close()`（泄漏 MongoClient 与它的 SDAM 定时器）；
  website 子进程的 `exit` 处理器在优雅停机时会把刚杀掉的进程**再拉起来**
  （waline 有 `stopping` 标志，website 没有），而它的 `starting` 互斥量**从未被赋值**（死代码）。

**测试**：server `utils/safeDecode.spec.ts`(9) + `provider/article/article.provider.viewer.spec.ts`(5)
+ `audit-hardening.spec.ts`(8)；website `__tests__/frontPageWeight.spec.ts`(20)。
⚠️ 写 jest 的源码级断言时注意 `__dirname` 就是 `src/`（ts-jest 直接跑源码，没有 dist 那一层），
`join(__dirname, '..')` 会让所有 `read()` 都 ENOENT。
⚠️ vitest 里 `vi.useFakeTimers()` 只能开在需要它的那个用例里：另一个用例的 fetch 桩用了真实
`setTimeout`，假定时器一开它就永远不触发（表现为"测试超时 5000ms"而不是断言失败，很容易看错方向）。

### 7.38.4 仓库卫生与 CI（三方向审计的收尾）

审计还查了依赖、镜像、编排、CI 与泄密面。这一节记**已经落地的**；剩下的按优先级列在
§7.40「审计遗留清单」里，都是量化过的，别当"没人发现"重复提。

**入库文件里的生产标识已脱敏**：生产域名与真实后台用户名（两个字符串本身**不要写进这份文档**，
否则等于一边脱敏一边又抄回去 —— 第一版就是这么干的）
以前出现在 3 个 server spec、1 个脚本测试、2 篇文档和 AGENTS 里 —— 不是凭据，但把公开 fork
和生产站点绑在了一起，还白送攻击者一个准确的用户名（登录有限流，喷洒成本变高，但没必要送）。
统一换成 `example.com` / `blogadmin` / `示例站点`。
⚠️ 脱敏之后 `stego.spec.ts` 的"小图降级重复次数"用例红了：它断言 `repetition < 3`，
而载荷从 45 字节变成 42 字节之后，400×400 就放得下 3 份了 —— **断言隐式依赖了测试数据的长度**。
改成显式构造 70 字节的载荷，并把窗口写在注释里（≤50 字节 → 3 份放得下；200 字节 → 1 份都放不下）。
`scripts/tests/build-image-local.test.sh` 里那条"不许有内网地址"的断言原本把**具体那个内网 IP**
写进了测试文件（等于把地址本身提交进公开仓库），改成匹配整个 RFC1918 段的正则。

**镜像里 next/image 的默认允许域名清空**：`Dockerfile` 两处
`ENV VAN_BLOG_ALLOW_DOMAINS="pic.mereith.com"` → `""`。原值是**上游作者的图床域名**，
意味着每个 fork 部署的图片优化器默认都会去别人域名取图；那个域名一旦过期被注册，
就等于让第三方通过你的 `/_next/image` 提供内容（还顺带放大 next 13 图片优化器的那批公告）。
`getAllowDomains()` 对空值在生产环境返回 `[]`，所以清空是安全的；要允许远程域名在编排文件里设。

**`.dockerignore` 补上本机目录**：以前本地构建的上下文是 **27GB**（`.tools` 1.9G + `vanblog_dev` 25G），
而 CI 上干净 checkout 只有 ~35MB —— 每次 build 都要先把这堆打包送给 daemon。
顺带一个隐私问题：`AGENTS.local.md`（代理地址、生产域名、密钥路径）会随上下文 tar 包一起进 daemon
（好在 Dockerfile 没有 `COPY .`，进不了镜像，已核实）。

**编排模板**：mongo 加 `stop_grace_period: 60s`（docker 默认 10s 就 SIGKILL，慢盘/大库会在 flush
中途被杀；WiredTiger 有 journal 所以真损坏不多见，但多给 50 秒是免费保险）；
`mem_limit` 那段注释补上了**关键的相互作用**：整站备份在 vanblog 容器里跑
`zstd -19 --long=27 -T0`（多线程 + 128MB 窗口），峰值能到 1GB 上下 ——
开了 768m 限制又不降压缩等级，备份会被 OOM 杀掉（`VANBLOG_BACKUP_ZSTD_LEVEL: '12'`）。
另外把 `VANBLOG_SWAGGER` 与 `VAN_BLOG_ALLOW_DOMAINS` 作为**注释掉的**可选项写进模板：
swagger 默认公开确实等于把后台 API 面摊给未登录用户，但后台「关于」页与「Token 管理」页
各有一个跳 `/swagger` 的链接，默认关掉会让那两个链接 404 —— 所以交给用户自己决定，
而不是替他们关。

**CI 从"六个从没跑过的工作流"收敛到四个有用的**：GitHub API 实测这个 fork 一共只跑过 3 次
（publish-ghcr ×2、release ×1），其余六个工作流从未执行。

- 删掉 `test.yml` / `test-arm.yml` / `local-build.yml` / `deploy-docs.yml`：它们都是**作者的基础设施**
  —— 推 `docker.io/mereith/van-blog:*`、`kubectl set image` 到作者的集群、刷作者的 CDN，
  而且用的还是不存在的 secrets、已废弃的 `::set-output`（VERSION 恒为空）、
  `test.yml` 甚至推 `test-${VERSION}` 标签却部署 `van-blog:${VERSION}`（对不上）。
  和之前删掉的 `release.yml` 是同一类东西。
- 删掉 `scripts/sync-aliyuncs.sh` 与根 `package.json` 里的 `sync-aliyun` / `release:local` /
  `build:test`（都是作者的发布链路）。
- `server-test.yml` 与 `admin-e2e.yml` 以前只在 `pull_request → master` 时触发，
  而开发全在 `dev/dsh` 上、从不发 PR ⇒ **永远不跑**。现在加了 `push: dev/dsh`（带 paths 过滤，
  纯文档提交不触发）、`concurrency`（同分支连推时取消上一次，这个 job 要装整个 workspace，
  排队很浪费）、server-test 超时 15→30 分钟，并把本轮新增的 5 个 spec
  （safeDecode / article.provider.viewer / audit-hardening / theme.provider）加进 jest 的
  `testPathPattern`（否则 CI 根本不跑它们）。
- 删掉 `alpine-sharp-install` 这个 job 与它的脚本：它 grep `FROM node:18-alpine AS WEBSITE_BUILDER`
  （Dockerfile 现在是 `node:20-alpine AS website_builder`），实测提取结果 start=-1、
  python 直接抛错 ⇒ **100% 失败**；而且它还断言 `vips-dev`，而那正是我们**故意去掉**的
  （sharp 走 musl 预编译包）。
- ⚠️ 修掉 `dockerfile-alpine-sharp.test.sh` 里 3 条**假绿**断言：它们在整个 stage 文本里搜
  `vips-dev` / `fftw-dev`，而 stage 里正好有一行注释写着"去掉 vips-dev/fftw-dev…" ——
  断言匹配到的是**解释为什么没装**的那句注释，结论正好反了（谁删掉 libc6-compat 它照样绿）。
  现在先剥注释、只取真正的 `RUN apk add` 行，正向断言 python3/make/g++/libc6-compat 在，
  反向断言 vips-dev/fftw-dev 不在。23 条全绿。

### 7.40 审计遗留清单（已量化、待决策，别重复审计）

三个方向并行审过一轮（前台性能 / server 运行时与 DB / 依赖·镜像·CI·泄密面）。
已落地的见 §7.38.1–§7.38.4；下面是**查清了但故意没动**的，按"性价比 ÷ 风险"排序。
每条都带实测数字，动手前不用再查一遍。

**A. 依赖与镜像（要动就得能跑构建；本会话 podman 用不了，所以整批推后）**

1. **镜像的 server stage 不用 lockfile**（**已落地，见 §7.43**；waline / cli 两个 stage 仍未 lockfile 化）。原始记录：（`Dockerfile:175+192` 直接 `pnpm i`，
   `packages/server/` 下没有 pnpm-lock.yaml）：镜像不可复现，`mongoose ^7.6.6` / `axios ^1.6.2` /
   `express ^4.18.2` / `@nestjs/* ^9.4.3` 每次构建都重新解析 —— 今天构建可能悄悄带上 mongoose 7.8.x
   （是"意外修好"，同样也可能意外坏）。**这也意味着下面所有依赖升级在改成 lockfile 之前都不保证进得了镜像。**
   改法照抄同一个 Dockerfile 里 admin_builder 的写法（workspace manifests + `--frozen-lockfile --filter`）。
2. **免费的 semver 内安全升级**（目标版本都已确认在 npmmirror 上）：axios → 1.16.0（SSRF
   CVE-2024-39338 等 12+ 高危，用于抓远程图片与 IP 归属地）、jws → 3.2.3（**HMAC 校验缺陷**，
   它就是后台会话的签名链）、mongoose → 7.8.9（3 条搜索/sanitizeFilter 注入；代码里没用
   `$where`/`$nor`/`sanitizeFilter`，实际可利用性低，但升级是免费的）、next → 13.5.9
   （缓存投毒 GHSA-gp8f-8m3g-qvj9，零代码补丁版本）、express/body-parser/qs/send 用 pnpm overrides
   提到 4.21.2 / 1.20.3 / 6.16 / 0.19（body-parser DoS 在**每一个** urlencoded POST 上，含登录）、
   @waline/vercel 1.31.7 → 1.41.6（koa 2.14.2 的 **critical ReDoS + Host 注入**打在匿名评论接口上）、
   mermaid 10.6.1 → 10.9.3、katex → 0.16.21、dompurify → 3.2.4、prismjs → 1.30.0、
   compressing → 1.10.5、`markdown-it-katex`（2016 年就弃坑、XSS **无修复版本**）→ `@traptitech/markdown-it-katex`。
   sharp 0.32.6 → 0.35.4 顺带能**删掉整套 `VAN_BLOG_SHARP_*_HOST` 构建参数**（≥0.33 的预编译包
   走 npm optionalDependencies），并解开 Node 22 的路。
3. ~~runner 里带进了 394 个 dev 包 ≈ 121MB~~ **已落地，见 §7.43**（deploy 之后 server 的 node_modules 是 191.6MB / 34 个顶层包）。原始记录：（typescript 自己就 64MB，还有 webpack/jest/ts-node/
   supertest/@nestjs/cli）：`Dockerfile:192` 全量 `pnpm i` → `:367` 把整个 node_modules 拷进 runner。
   构建后加一句 `pnpm prune --prod` 即可。
4. **没用 `pnpm fetch`，且源码在 install 之前 COPY**（admin `:99`→`:126`，website `:242`→`:276`）：
   改一行源码就作废整个下载+安装层。改成 manifests → `pnpm fetch --frozen-lockfile` → 源码 →
   `pnpm install --offline`，国内网络下本地构建提速最明显。
5. **接受的风险（要写进文档而不是偷偷留着）**：nest 9（EOL；`@nestjs/common` 的 Content-Type
   上传 RCE 只在 ≥10.4.16 修，multer 1.4.4-lts.1 的 3 条 DoS 只在 2.x 修 —— 但所有上传路由都在
   AdminGuard 后面，且 Nest 的 guard 先于 FileInterceptor 跑，**没有匿名入口**）；
   picgo 1.5.6（拖进来的 `git-clone@0.1.0` 命令注入**无修复版本**，而
   `picgo.provider.ts:33-52` 会安装后台配置的 picgo 插件 ⇒ "拿到后台会话 → 容器内 root" 链条，
   要么升 picgo 3.x 要么把插件安装功能关掉/加白名单）；umi3 / antd4 / React17 / next13 的整体迁移；
   waline 那 249MB 里绝大部分是**永远加载不到的死适配器**（mysql2 RCE、protobufjs、leancloud 那批
   公告都是噪音，但体积是真的，上游不拆就没法减）。

**B. server 运行时（改动语义或要迁移数据，需要单独决策）**

6. **公开文章列表把整个集合连正文捞回来**：`getByOption` 只在 `!isPublic` 时 skip/limit
   （`article.provider.ts:817-820`），然后在 **JS 里**排序/过滤/切置顶，再 `count(query)`。
   explain：内存 SORT、examined=106、returned=53（≈200KB）。本轮只修了 N+1（分类改一次查完）、
   `countTotalWords` 加 `{content:1}` 投影、`searchByString` 加 `.limit(200)`；
   把置顶排序与分页推进 Mongo 是下一步，难点是要同时保证前后台两个视图的排序语义不变。
7. **每次浏览 ~11 次 Mongo 操作 / 4 次写**，散在 metas、articles、viewers、visits 四个集合，
   无批量无防抖；`visits`/`viewers` **永不清理**（实测 visits 8748 条跨 800 天，索引 0.88MB
   已经接近压缩后数据 1.21MB 的七成）；`visit.provider.add` 的"重复键兜底"依赖一个**并不存在**的
   `{date,pathname}` 唯一索引（listIndexes 实测只有非唯一索引）⇒ 并发首访会静默产生重复行。
   要做就得先写去重迁移再加唯一索引，顺带考虑 TTL 或按年清理。
8. **ISR 风暴没有护栏**：25+ 处调 `activeAll`，只有 1s 防抖、**没有 in-flight 互斥**，
   `activeWithRetry` 不 await 不 catch，`testConn`/`activeUrl` 的 axios **没有超时**；
   一轮 ~130 次串行重渲染（含 6 篇**已删除**文章的 id 与别名两条路径）。
   本机还实测到**两个 server 进程同时跑 cron**（watch 重启留下的孤儿），说明定时任务也没有多实例保护。
9. **RSS 全量同步渲染**：实测 53 篇 markdown-it+hljs+katex = **135ms 阻塞事件循环**，
   三份 feed 各约 350KB（**全文、无条数上限**），每小时 + 每次启动 + 每次编辑后 3 分钟各跑一遍。
   应该限条数（20–30）并改异步/增量。
10. 运行时杂项：`express.json({limit:'50mb'})` 挂在**所有**路由（评论只要几 KB，只有备份恢复/上传才要大）；
   无 request-id / 无 API 访问日志 / 无慢查询日志（ISR 风暴或 30s serverSelection 卡顿时无法归因）；
   `InitMiddleware` 每个请求都 `userModel.findOne({})`（还把密码哈希读进内存）；
   `initJwt` 在 `main.ts` 与 JwtModule 工厂里**各跑一次**且两次都不 `client.close()`（泄漏 MongoClient
   与它的 SDAM 定时器）；website 子进程的 `exit` 处理器在优雅停机时会把刚杀掉的进程**再拉起来**
   （waline 有 `stopping` 标志，website 没有），而它的 `starting` 互斥量**从未被赋值**（死代码）。

**C. 前台（量化过，改动面较大或需要视觉回归对比）**

11. **首页/分页把全文塞进 `__NEXT_DATA__`**：HTML 114KB（gzip 33KB），`__NEXT_DATA__` 占 31.8%
    （gzip 后占 **54.8%**）；5 篇 content 25KB，卡片只需要 3.3KB 摘要 ⇒ **87% 白送**，
    模拟修完 gzip −31.8%。要在 server 出 `excerpt`：把 `utils/articleExcerpt.ts`
    （围栏感知的 `findMoreMarker`、200 字回退、截断链接修复、代理对安全）移植过去，
    并让 `markdown.provider.getDescription` 委托它，否则两份实现会漂；
    还要照顾 9 篇没有 `<!-- more -->` 的文章（#410 那个"卡片里露出 `[文字](url)` 括号"就出在这条路径）。
12. **ByteMD 的编辑器进了每个 markdown 页面的首屏 JS**：服务端 chunk 1148 个模块，含 9 个
    `codemirror-ssr`（源码 1.97MB）、57 个 `@popperjs/core`；`bytemd`/`codemirror-ssr`/`@bytemd/react`
    **都没有 `sideEffects` 字段**，webpack 不敢丢（生产估计 150–250KB min+gz，**未实测**：
    本机没有生产构建）。两条路：①摘要在服务端渲染成 HTML（和第 11 条一起做最划算，
    注意仍要过 `sanitizeMarkdownSchema`）②内联 `@bytemd/react` 那 30 行 `Viewer` 并给 bytemd 标
    `sideEffects:false`。另外 `dynamic(...,{ssr:true})` 在首页的**初始** script 列表里 —— 它一点不 defer。
13. `/timeline` 带 **42.5KB 没人读**的数据（pageProps 73.5KB 里 `sortedArticles` 21.3KB +
    `yearGroup.articles` 21.2KB 都无读者：`TimelineArchives` 只在 `months.length===0` 时才读，
    实测 4 个年份组一个都不满足）；gzip 后只省 6.6%，收益主要在解析与内存。
14. 每张卡片一个未合并的阅读量请求：5 次串行 XHR（89ms vs 并行 36ms），每次回 220B 的
    **整个 visit 文档**只为显示一个整数，而这数字 pageProps 里已经有（还会先显示 `"..."` 再跳成数字）。
    范例就在仓库里：`commentApi.ts:96-146` 的 50ms 合并器。
15. apple 皮肤 46KB CSS 在全局样式表里（全局 CSS 72.7KB / gzip 16.3KB，另有 markdown 相关 43KB
    在 `/link`、`/tag`、`/category`、`/timeline` 上根本用不到）。现在已经有
    `/api/public/theme.css` 这条路，内置 apple 也可以走；但 apple.css 依赖"在 Tailwind 之后引入"
    的顺序，挪成 `<link>` 要对两种皮肤做视觉对比。
16. 字体走 `static.zeoseven.com`：本机 DNS 解析不出来（每页一次 preconnect + 一个 stylesheet 卡在 DNS 上），
    而且 CSS 是水合后才从 `media="print"` 提升的 ⇒ 字体下载**最早也要等 JS 跑完**，没有 preload，FOUT 必然。
    正解是自托管到 `public/fonts/`（`utils/appleFont.ts:8-10` 的注释里就写着这条路）+ 给覆盖站名/导航的
    2–3 个子集加 `preload`；CJK 按 unicode-range 切子集比较费事，切错会掉字形。
17. **`revalidate` 没有下限**：`VAN_BLOG_REVALIDATE_TIME` 默认 **10 秒**且 `parseInt` 不做 NaN 兜底；
    `fallback:"blocking"` + `revalidate:{}` 组合下，按需生成的页面**永不过期**（丢了 revalidate 触发就一直旧）。
    建议夹到 ≥60 秒，并给按需模式一个兜底的长 revalidate（如 3600）。

**D. 运维（小、安全，随时可做）**

> **2026-09-15 更新：18、19、20、22 已落地，见 §7.41**（21、23 仍待定）。

18. **mongo 没有 healthcheck**：加 `mongosh … || mongo …` 的 ping（4.4 没有 mongosh、7.0 没有 mongo，
    必须两个都试）+ `depends_on: condition: service_healthy`，能干掉模板注释里自己承认的
    "首次启动 server 连不上库、容器要重启几次才稳"。⚠️ `condition:` 需要 docker-compose ≥1.27
    或 compose v2（脚本在缺 v1 时会别名到 v2，但 Ubuntu 20.04 自带的 1.25 会解析失败）⇒
    要么在脚本里加版本判断，要么保留列表形式做回退。**→ 已落地（§7.41 A）**
19. **备份没有校验和，也没有空间预检**：manifest 里没有 sha256（损坏要等到恢复时才由 zstd/xz/gzip
    的 CRC 发现）；导出前不看磁盘剩余（ENOSPC 会优雅失败并清掉半成品，但大站上已经白等几分钟）。
    便宜的做法：manifest 里写 sha256 + 一个 `vanblog.sh verify <归档>`（流式解压 + 解析 manifest）。
    **→ 已落地（§7.41 B）：走的是"脚本侧"这条腿 —— `verify` 子命令 + `<归档>.sha256` sidecar +
    备份前空间预检；server 的 manifest 里仍然没有 sha256（本轮不许动 packages/，遗留见 §7.41）**
20. **没有内置的定时备份**：`--keep` 有了，但调度还得用户自己写 crontab（脚本里只有一条可复制的配方）。
    可以加一个 `./vanblog.sh install-cron`（写 crontab 时默认带上 KEEP=7）。
    实测数据供决策：整站归档 **66MB**（zstd -19），目录级快照 **356MB**；40GB 的 VPS 每天备一次、
    `--keep 7` ≈ 460MB（没问题），不带 keep ≈ **24GB/年**（不行）。**→ 已落地（§7.41 C）**
21. `TZ: 'Asia/Shanghai'` 在两个服务里都是硬编码（非中国时区用户要手改，且 `config` 会覆盖）；
    `version: '3'` 在 compose v2 下已废弃（纯噪音）；`Dockerfile:376` 有一层 `cd /app/website && cd ..`
    的空操作、`:62` 有 `ENV EEE=production` 的拼写错误（都在 builder 阶段，不影响产物）；
    基础镜像全是浮动 tag（`node:20-alpine` ×5，没有 digest 钉住）。
    （小注：`version` 本轮从 `'3'` 改成了 `'3.4'` —— 不是处理"噪音"问题，是 healthcheck 的
    `start_period` 在 v1 的 3.0–3.3 schema 里不存在，见 §7.41 A；"删掉 version"仍然没做。）
22. **安装脚本的下载回退会退到上游**：`vanblog.sh:91-98` 在拉不到本分支的编排模板/脚本时，
    会回退到 `vanblog.mereith.com`、`Mereithhh` 的 raw、jsDelivr —— 而国内网络下
    raw.githubusercontent 常常不通（本分支的 URL 恰好就是它），于是用户**静默地用上了上游版本**，
    丢掉本分支全部加固（日志上限、mongo 7 默认、整站备份、ghcr 镜像）。
    应该在上游回退**之前**插一个 fork 可达的镜像（jsDelivr 的 `gh/CKboss/vanblog@dev/dsh`，
    或者 release-fork 已经挂在 Release 上的附件）。另外 `:976` 会把
    `vanblog.mereith.com/docker.sh` 用 root 管道执行（上游遗留，至少要在文档里点明）。
    **→ 已落地（§7.41 E）：fork 三源优先（raw → jsDelivr → Release 附件），docker.sh 的文档
    警告也加了；管道执行本身保留（取舍见 §7.41 E）**
23. **`/swagger` 默认公开**（`VANBLOG_SWAGGER=false` 可关，模板里已给出注释掉的开关）：
    等于把整个后台 API 面摊给未登录用户，robots 的 disallow 不是访问控制。
    没直接默认关掉是因为后台「关于」页与「Token 管理」页各有一个跳 `/swagger` 的链接。

### 7.41 运维五件套（§7.40 D 组的落地）：mongo healthcheck、verify、空间预检、install-cron、fork 优先回退

一键脚本 **v0.5.0 → v0.6.0**，编排模板同步改。五件事都只在脚本/模板/文档层，**没动 packages/**
（server 侧的两个遗留见文末"没做的事"）。测试从 19 文件/859 条涨到 **22 文件/1105+ 条**，
新增 `vanblog-compose-health.test.sh`(56) / `vanblog-verify.test.sh`(79) / `vanblog-install-cron.test.sh`(100)，
重写 `vanblog-download-fallback.test.sh` 的顺序断言(67→78)。

**A. mongo healthcheck + depends_on 的长/短形式（D-18）**

- 模板给 mongo 加了 `healthcheck`：`test` 是 `mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || mongo …`
  的 CMD-SHELL —— **两个 shell 必须都试**（4.4.16 没有 mongosh；6.0 起没有 legacy mongo；5.0 两个都有），
  `interval 10s / timeout 5s / retries 5 / start_period 40s`。
- ⚠️ **`start_period` 逼着 version 从 `'3'` 提到 `'3.4'`**：不是凭记忆定的，是拉了 docker-compose
  1.25.5 的 schema 逐个查的 —— `config_schema_v3.0.json` 的 healthcheck 定义
  `additionalProperties:false` 且**没有** `start_period`（3.1/3.2/3.3 同样没有，3.4 起才有）。
  也就是说保持 `version: '3'` 的话，Ubuntu 20.04 的 1.25 会把**整个模板**拒掉 —— 比没有
  healthcheck 严重得多。3.4 的门槛是 docker-compose ≥1.16（2017-08）/ Engine ≥17.09；
  现模板本来就要求 ≥1.10（`version: '3'`），实际抬高的只是 2017 年前的古董。compose v2 忽略 version。
- **方向选择（模板提交哪种形式）**：`depends_on` 的 `condition: service_healthy` 长格式在
  1.25.5 的 v3.x schema 里**只是 list_of_strings**（同样实拉 schema 核实过；长格式是 compose spec
  合并后、1.27+ 才回来的）。所以模板**提交列表形式**（所有版本都解析得了），由
  `./vanblog.sh config` 生成编排文件时**实测**本机再决定升不升级 —— 反方向（模板写死长格式、
  老机器降级）会把"现有安装解析失败"变成默认路径，是更容易搞坏人的那个方向。
- **探测不猜版本号**（`compose_supports_depends_condition`）：`docker-compose version` 的输出格式
  太乱（1.25.5 / v2.20.2 / 脚本自建的 shim），改成拿一个带 `condition:` 的最小临时编排文件跑
  `docker-compose -f probe config`，退出码 0 = 支持；探测文件带 `version: '3.4'`，与真实生成物
  同形状（万一某个 1.27 对带版本号文件仍按老 schema 校验，实测结果也如实反映）。结果缓存在
  `VANBLOG_COMPOSE_COND_SUPPORT`，一次 config 只探一次。
- `apply_depends_on_form` 四个分支：支持+列表+**mongo 有 healthcheck** → 升级（没有 healthcheck
  绝不升级：compose v2 对没有健康检查的依赖会直接拒绝启动 dependents）；不支持+长格式 → 降级并
  打印一行原因；不支持+列表 → 保持并打印一行说明；异形（用户手改过）→ 原样不动。改写用 awk 写到
  临时文件、**退出码为"确实改了"且文件非空才 mv**（awk 的 END 里 `exit(3)` 表示形状没匹配上），
  任何岔子都不会把编排文件改坏。升降级后的文件都用 pyyaml 反解断言过形状。
- 集成点：`config()` 在全部 sed 替换之后、`ensure_compose_image` 之前调用。

**B. 备份完整性：`verify` 子命令 + `<归档>.sha256` sidecar（D-19 前半）**

- **先核实了 server 侧**：`packages/server/src/utils/fullBackup.ts` / `backupCodec.ts` /
  `fullBackup.provider.ts` 里 grep `sha256|checksum|hash` **零命中** —— manifest 只有
  `totals.archiveBytes`，没有校验和。所以按任务要求走脚本侧，server 一行没动。
- `./vanblog.sh verify [归档名|路径]…`（不带参数 = 备份目录里全部 `vanblog-full-*`）三步，
  全程**不解压落盘**：① `zstd -t -q --long=27` / `xz -t` / `gzip -t` 流式完整性（`--long=27`
  对齐 server 的解压参数；老 zstd 不认 `--long` 时去掉重试一次，别把"工具老"误报成"归档坏"）；
  ② `.sha256` sidecar 有就比对，没有就**明说跳过**（后台/接口导出的归档没有 sidecar，照常校验、
  恢复不受影响）；③ 流式解压 | `tar -tf -` 列成员，按 server 的打包结构核对
  （`tar -cf - -C staging .` ⇒ `./manifest.json`、`./db/<库>/<集合>.ndjson`、`./static/<img|file|customPage>/`）。
  成员预期分了"失败"与"只提示"两档：缺 manifest / 一个 NDJSON 都没有 = FAIL；缺 `static/` 树 = 提示
  （BACKUP_STATIC_FOLDERS 是"存在才打包"，空站点 legitimately 没有）；旁边缺 `.manifest.json` = 提示。
  `vanblog-backup-*.tar.gz`（offline）按 `./data/` 树核对；陌生文件名只做完整性+结构，并明说。
  汇总一行 OK/FAIL 计数，任一 FAIL → rc 非 0（可进监控）。
- **sidecar 的写入方**：只有**脚本自己**做的备份才写（`backup_full` 在接口成功后对宿主机路径算
  sha256；`backup_offline` 在 tar 成功后写）。格式与 `sha256sum` 输出一致（`hex␣␣basename`），
  `sha256sum -c` 直接可用；记 basename 而不是全路径，归档拷去别处 sidecar 跟着走。
- ⚠️ **`.sha256` 会匹配 `vanblog-full-*.tar.*` 这个 glob**（`x.tar.zst.sha256`）：
  prune 的份数计数、status 的归档计数、restore/reset 的选择列表、verify 的全目录扫描**四处**都要
  过滤它（prune 还要在删归档时连带删 sidecar）。第一版就漏了计数这处，测试用"3 个归档 + 3 个
  sidecar、keep=2 应删 1 份"钉住了。
- ⚠️ server 的 `listFullBackups()` 只排除 `.manifest.json`，**不排除 `.sha256`** —— 后台
  「备份恢复」页会把这些小文件列成"归档"（恢复它会报"无法识别压缩格式"，无害但难看）。
  本轮不许动 packages/，已报给父代理转给 server 侧（一行 filter 的事）。

**C. 磁盘空间预检（D-19 后半）**

- `check_backup_space <full|offline> <目标目录>` 挂在 `backup_full`（探活之后、要 token 之前 ——
  别让用户输完密码才告诉他磁盘不够）与 `backup_offline`（确认数据目录存在之后）。
- 估算的诚实阶梯：full = 上一个归档的大小（最有依据）→ 静态目录 `du -sk` + 64MB 数据库固定猜测
  → 静态目录都读不到就只按 64MB 猜并明说依据；offline = 数据目录 `du -sk`（tar.gz 对已压缩的
  图片几乎不再缩小，算上界）。判定：`free < est+margin` → **中止**（rc 1，打印估算依据/剩余/
  怎么调）；`free < est*2+margin` → 警告但继续；`VANBLOG_BACKUP_SPACE_MARGIN_MB`（默认 256）
  覆盖余量，`VANBLOG_BACKUP_SKIP_SPACE_CHECK=1` 跳过。**估算或 df 拿不到 → 明说"跳过检查直接
  备份"并放行**，绝不假装检查过（测试里用 df/du 桩函数专门钉了这两条诚实路径）。
- `df -Pk`（POSIX 格式，两行定长列）取 Available，不依赖 GNU 的 `--output`；目标目录不存在时
  往上找存在的父目录（备份目录是导出时才建的）。

**D. `install-cron`：内置定时整站备份（D-20）**

- 行为：默认每天 03:00、`KEEP=7`（`VANBLOG_BACKUP_KEEP` 覆盖默认，`--hour N`/`--keep N` 覆盖参数）、
  `VANBLOG_ASSUME_YES=1`、日志 `<数据目录>/log/vanblog-backup-cron.log`；`--remove` 移除；
  `--force` 换参数。写入前**展示整行**再确认。cron 行形如
  `0 3 * * * . '<安装目录>/vanblog-cron.env' && '<脚本绝对路径>' backup >> '<日志>' 2>&1 # vanblog-backup-cron`。
- **幂等**的三态：crontab 里已有**同样**的标记行 → rc 0 +"不会重复添加"；已有但**参数不同** →
  rc 1 拒绝，给 `--force`/`--remove` 两条路（不悄悄出现两条每天各备一次的条目）；没有 → 追加。
- **绝不毁已有 crontab**：`crontab -l` 成功 → 原样保留 + 末尾追加；失败但 stderr 是
  "no crontab" → 当空表；**其它失败**（服务没起/权限）→ 拒绝安装（宁可不装）。写入走
  `{ 旧表; 新行; } | crontab -`，写完**回读确认**标记在，不在就报失败不装蒜。
- **token 的诚实处理**：备份接口在 AdminGuard 后面，cron 没法交互输密码 ⇒ token 必须落盘。
  取 `VANBLOG_ADMIN_TOKEN`（环境变量）或 tty 下交互输入（`read -e -r -s`，不回显），写进
  `<安装目录>/vanblog-cron.env`，`umask 077` + chmod 600；**单引号做 shell 转义**（`to'k` →
  `'to'\''k'`，测试里 source 回来比对原值）。文件头注释与 docs/guide/backup.md 都写明了权衡
  （长期有效的管理员 token 明文落盘）与作废方法。**不给 token 也装**，但打印红字"备份会在登录
  一步失败"、env 文件里留注释掉的模板行 —— 失败的备份会写进日志，比"静默不跑"诚实。
  没有 `crontab` 命令 → rc 1 + 可照抄的手工步骤（含标记，之后 install-cron 还能识别）。
- ⚠️ 踩到一个小坑：参数解析里 `0|--*) :;;`（菜单占位豁免）排在 `*)` 之前，会把 `--keep 0` 的
  `0` 当占位符**吞掉**，keep 静默保持默认 7 —— 而 `--keep 0` 本该被正整数校验拦下（保留 0 份
  等于备完就删）。改成"先看上一个参数是不是 `--hour/--keep`，不是才豁免 0"。
- ⚠️ 测 tty 交互（`read -s` 不回显）要用 util-linux 的 `script -qec` 起真 pty；而 **`script` 会把
  自己 stdin 的管道字节原样回显到输出开头**（child 还没 read 就出现了），"不回显"的断言必须看
  **提示符之后**的文本，不能整段搜 token（第一版就这么误报了）。

**E. fork 优先的下载回退（D-22）**

- 顺序从「fork raw → 上游文档站 → 上游 raw → 上游 jsDelivr」改成 6 条：
  「fork raw → **fork jsDelivr**（`cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/...`）→
  **fork Release 附件**（`github.com/CKboss/vanblog/releases/latest/download/{vanblog.sh,
  docker-compose-template.yml}`，`VANBLOG_RELEASE_TAG` 可钉成 `releases/download/<tag>/`）→
  上游文档站 → 上游 raw → 上游 jsDelivr」。资产名与 tag 约定是读 `release-fork.yml`
  （`files: scripts/vanblog.sh + docker-compose/docker-compose-template.yml`，`v*` tag）+
  GitHub API 实测确认的（v2026.09 的 Release 上就挂着这两个名字）。
- **两个 fork 镜像都实测可达**（本机直连）：jsDelivr 的 `@dev/dsh` 分支 URL → **200**
  （带斜杠的分支名 jsDelivr 解析没问题）；`releases/latest/download/vanblog.sh` → **302** 到
  `releases/download/v2026.09/vanblog.sh`。
- `download_with_fallback` 的"打印实际用的 URL + 下载后校验（`bash -n`/占位符/首尾标志）"原样保留，
  只是候选列表变长；`vanblog-download-fallback.test.sh` 全部顺序断言重写，并加了一条**顺序不变式**：
  前三条必须都是 CKboss 源、后三条不许含 CKboss —— 谁再把上游挪到 fork 前面，测试直接红。
- **docker.sh 的处理是"文档点明"而不是改行为**：`bash <(curl -sL https://${Get_Docker_URL})` 以 root
  管道执行作者主机的脚本仍是上游遗留行为，但它只在"机器上没有 docker"时触发；换掉它（比如内置
  get.docker.com）超出本轮范围，按任务要求在 `docs/guide/script.snippet.md` 与
  `docs/faq/deploy.md#如何安装-docker` 各放了一条明确警告（不放心就先自己装 docker）。

**菜单/帮助/文档**：菜单加 `14. 定时备份`、`15. 校验备份`（**老编号一个没动**，13 之前原样）；
dispatcher 加 `"verify"` / `"install-cron"`；`show_usage`（引号 heredoc，`<<'USAGE'` 规则照旧）加了
两个子命令的全部参数、三个新环境变量、场景配方（install-cron 一行代替手写 cron）、路径约定
（vanblog-cron.env / cron 日志 / .sha256）。文档：`docs/guide/backup.md`（verify、空间预检、
install-cron 与 token 权衡、每周 verify 的 cron 配方）、`docs/faq/deploy.md`（新回退顺序、
healthcheck 与 depends_on 两种形状对照表、docker.sh 警告）、`docs/guide/script.snippet.md`
（回退顺序、常用命令、docker.sh 警告、目录清单）。`docs/reference/dir.md` **没改**：它是容器内
目录映射表，本轮新增的文件（cron env/.sha256/cron 日志）全在宿主机侧，容器内路径一个没变。

**没做的事（都有原因，别当遗漏）**：

- **server 的 manifest 里仍然没有 sha256**：任务边界是"不许动 packages/"，脚本侧 sidecar 已覆盖
  "脚本做的备份"；后台/接口直接导出的归档依旧只有 CRC 兜底（verify 会明说"无 sha256 记录"）。
  要补就是 `fullBackup.ts` 写完归档后补一个 `crypto.createHash('sha256')` 流 + manifest 加字段，
  以及 `listFullBackups` 顺手排除 `.sha256`（B 节末尾那条）。
- **verify 没有"下载回来验"**：只验本机/备份目录里已有的文件；从 server 拉归档是 restore 的事。
- **healthcheck 没在真 mongo 容器里跑过**：本会话 podman/docker 不可用。test 命令的行为是按
  mongo shell 的退出码语义推的（连不上 → 非 0；4.4 无 mongosh → 127 → `||` 兜底），schema 兼容性
  是拉 1.25.5 的 JSON schema 核实的，但 `docker-compose up` 后的真实 healthy 翻转**没有实测**。
- **install-cron 没在真 cron 守护进程下跑过一夜**：假 crontab 测的是脚本与 crontab CLI 的契约；
  cron 行本身的语法是标准 POSIX 五段 + `.` source，风险低但未实测。

**测试**：`vanblog-compose-health.test.sh`(56) —— 模板内容/剥注释后的反向断言/pyyaml 形状、
探测函数的支持/不支持/缓存/没有 docker-compose 四种情况、升级/降级/幂等/无 healthcheck 不动/
异形不动、config 集成（v2 与 1.25 两种假 compose 各跑一遍完整 config）；
`vanblog-verify.test.sh`(79) —— **真 tar+zstd/xz/gzip** 造的 server 形状归档三种格式全过、
真截断（`head -c` 一半）必 FAIL、篡改一个字节由 sha256 抓住、缺 NDJSON/缺 manifest FAIL、
缺 static 只提示、offline 与陌生文件名两条路、按名/按路径/找不到/空目录、prune 与列表的
sidecar 过滤、offline+mock-curl 的 full 两种备份都写 sidecar 且 verify 能闭环、预检的
通过/中止/偏紧/margin 覆盖/skip/df 失败/估算失败（df、du 用桩函数摆布剩余空间）；
`vanblog-install-cron.test.sh`(100) —— 假 crontab 二进制（记录 stdin）跑真流程：全新安装/
幂等/参数不同拒绝/--force 替换/--remove 保留其它条目/`crontab -l` 故障时拒写/写入丢失时不报成功/
没有 crontab 命令/没有 token 的诚实路径/env 文件 0600+单引号转义+source 还原/tty 交互输入
（`script` 起真 pty）/参数校验/dispatcher 与菜单与 --help 接线/老菜单编号不变。
既有套件只改了两处断言：download-fallback 的顺序（67→78 条）与 backup-restore 的版本号 v0.6.0。

### 7.42 服务端文章摘要（withExcerpt）：列表页不再下发全文（§7.40 C-11 的落地）

前台首页/分页以前把每篇列表文章的**全文**带回浏览器：`getIndexPageProps` / `getPagePagesProps`
调 `getArticlesByOption` 时没传 `toListView`，5 篇正文 25,053 B 全进 `__NEXT_DATA__`，
而卡片只渲染 3,263 B 摘要（**87% 白送**；`__NEXT_DATA__` 占首页 gzip 的 54.8%）。

现在摘要在 **server** 算：`packages/server/src/utils/articleExcerpt.ts` 是
`packages/website/utils/articleExcerpt.ts` 的**逐字符移植**（围栏感知的 `findMoreMarker`、
200 字回退、#410 的截断链接补全、代理对安全），并且只 import 已有的 `./frontMatter`（不重复实现）。
公开列表接口 `GET /api/public/article` 新增 **`withExcerpt`** 开关（显式 opt-in，
**不传时响应一个字节都不变** —— 实测 `cmp` 逐字节相同），与 `toListView` 搭配时列表项带
`excerpt` + `firstImage`（`pickCoverFromContent(content,{preferLocal:false})`，
与前台 `firstImageOfMarkdown` 同规则），`content` / `password` 剥掉。

⚠️ 两个顺序不能错：

1. **先过滤私密文章，再算摘要**（provider 里的顺序反了就会把加密正文的前 200 字放进公开列表）；
2. 聚合分页与 `find()` 回退两条路径的**字段形状必须一致**（有专门的 spec 逐字段对比 +
   真 API A/B 钉住；唯一差别是 JSON 键的插入顺序，对消费者不可见）。

前台 `PostCard` 用 `props.excerpt ?? articleOverviewMarkdown(content)`、
`listCardImage(cover, content, props.firstImage)` —— **保留本地回退**，
老的 ISR 缓存页与文章页照旧工作。`hasToc` 那条确认过：`showToc` 对 `type === "overview"`
恒为 false，所以列表卡从来不需要正文来算目录。

**两边一致性由 `packages/website/__tests__/articleExcerptParity.spec.ts`（38 用例，
跨包 import 两个实现跑同一组向量）钉住 —— 改任何一边都必须同步**：
more 标记 / 标记在围栏代码块里 / front matter / 200 字回退 / 截在 `[文字](url)` 中间 /
截在 emoji 代理对中间 / 空与 undefined / CJK 按字符不按字节，外加 13 组首图向量
（全站 53 篇跑下来 server 与 website 的 firstImage **0 处不一致**，16 篇有首图）。

`markdown.provider.getDescription`（RSS 用）改为委托共享实现，两份实现不会再漂。
**一处有意的可见变化**：9 篇没有 `<!-- more -->` 的文章，RSS 的 description 从"渲染后的全文"
变成"渲染后的 200 字摘要"（与 §7.3 的全站摘要语义一致；全文仍在 `content:encoded` 里，
阅读器不会丢内容），44 篇有标记的**逐字节不变**。

实测（真跑，不是推算）：首页 HTML 114,485 → **92,228 B**，gzip 33,156 → **22,661 B（−31.7%，
与审计预测的 −31.8% 吻合）**；`__NEXT_DATA__` 36,297 → **14,040 B**（gzip −55.5%）；
pageProps 里的正文 25,053 → **0 B**，换成 3,263 B 摘要。
把 `__NEXT_DATA__` / buildId / dev 的 `?ts=` 归一化之后，首页 HTML 与改前**逐字节一致**；
5 张卡片的可见标题/摘要文字/图片地址全部相同；`/page/2` gzip −25.7%；
文章页、admin 列表接口、tag/category 接口全部不变（admin 加 `withExcerpt` 也无效，
这个 flag 只加在公开控制器上）。

已知的小分歧（当前数据没踩到）：server 的 `HTML_IMAGE` 用 `\\bsrc`（会匹配 `data-src=`）
而 website 用 `(?<![-\\w])src`，且 server 拒绝超过 2000 字符的 URL；53 篇里没有 `data-src`。
没去动 `transferRemoteImages`（改它会连带改变"远程图片本地化"的行为，是另一个决策）。

### 7.43 镜像的 server 依赖：workspace + frozen lockfile + pnpm deploy（§7.40 A-1/A-3 的落地）

以前 `server_builder` 是 `COPY ./packages/server/ .` + `pnpm i`：**没有 lockfile**，
每次构建现场解析 `^` 范围（mongoose/axios/express/@nestjs 都可能漂），镜像不可复现，
而且"依赖升级"是在构建时随机发生的。另外 `pnpm i` 装的是全量（含 devDependencies），
runner 又把整个 `node_modules` 拷进生产镜像 —— 实测 394 个 dev 包 ≈ **121MB**
（typescript 自己 64MB，还有 webpack/jest/ts-node/supertest/@nestjs/cli）。

现在和 admin_builder / website_builder 一样走 workspace：拷根 manifests（`package.json`、
`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`patches/`）+ `packages/server`，
`pnpm install --frozen-lockfile --filter "@vanblog/server..."` → `pnpm build` →
**`pnpm --filter @vanblog/server deploy --prod /deploy`**，runner 只拷
`/deploy/node_modules`（**191.6MB / 34 个顶层包**，typescript、jest 都不在）与
`/app/packages/server/dist/src/`。

⚠️ **别走 `node-linker=hoisted` 那条路**（试过了，两个坑，Dockerfile 注释里也写着）：

1. 扁平布局会把 `types-ramda` 这种**间接**依赖抬到顶层，于是 TypeScript 能解析到它了 ——
   而 `types-ramda@0.29.6` 的 `.d.ts` 用了 **TS 5.0 的 `const` 类型参数**，本仓库是 TS 4.9.5，
   `nest build` 当场 24 个 TS1434 语法错误（`skipLibCheck` 救不了：它跳过类型检查，不跳过解析）。
   默认的符号链接布局下它躺在 `.pnpm/` 里、顶层解析不到，TS 当 any 放过，所以一直没炸。
2. hoisted + `--filter` 实测装出 **2313 个包 / 2.0GB**，而 `pnpm prune --prod` 在 workspace 里会
   **弹交互确认**（"will be removed and reinstalled from scratch. Proceed?"），
   非 TTY 构建里它什么也没干就退出了 —— dev 依赖一个没少，而那一层构建居然还算"成功"
   （日志里只有 `prune 前：2.0G`，`prune 后` 那行永远没出现）。
   **教训：构建日志里出现交互式提问，就等于那一步没做。**

`pnpm deploy` 是关键：它就是为"把某个 workspace 包连同**生产依赖**导出成自包含目录"设计的，
产物里的符号链接全部指向**同一棵** `.pnpm/`（相对路径、自包含），所以 runner 只拷一份就能跑。
顺带一个坑：合并同名目录**不能用 `cp -a`** —— 这些文件与目标目录是同一个 inode（硬链接），
cp 会报 `are the same file` 并非 0 退出、整层构建失败；用 `tar -cf - -h … | tar -xf - …` 覆盖即可。

**验证**（podman 在本会话恢复可用之后做的，不再靠"看起来对"）：
`build-image-local.sh --stage server_builder` 单阶段通过；完整镜像构建通过（5 个 stage 全绿）；
进 stage 镜像核对 `/deploy/node_modules` = 191.6M / 34 个顶层包、`.pnpm` 自包含、
`mongoose` 的符号链接指向 `.pnpm/mongoose@7.6.6/...`、typescript 与 jest 都不在、
`dist/src/main.js` 存在、**sharp 的 musl 预编译 `.node` 在**（说明 `npm_config_sharp_*_host`
那套 ENV 仍然生效）；再用这个镜像起一整套栈（mongo 7.0 + vanblog），
`/`、`/admin`、`/api/public/meta`、`/api/public/theme`、`/robots.txt`、`/sitemap.xml`、
`/feed.xml` 全部 200，容器内 `require.resolve('@nestjs/core')` 与 `require.resolve('sharp')` 都成功。
⚠️ `build-image-local.sh` 的**冒烟测试在本机跑不起来**，原因与本次改动无关：
它给 `podman run` 传了 `--link`（这个 podman 版本不认：`Error: unknown flag: --link`），
清理临时 mongo 目录时还会撞上 root 属主文件的 `Permission denied`。
本机验证请改用 `vanblog_dev/run-image-stack.sh`（用容器 IP + `--add-host`，不依赖 `--link`）。

### 7.43.1 后台日志渲染的存储型 XSS（`ansi-to-html` 的 escapeXML 默认是关的）

`packages/admin/src/components/TerminalDisplay/index.tsx` 是**整个后台唯一一处**
`dangerouslySetInnerHTML`：它把「日志管理 → 系统日志」的文本经 `ansi-to-html` 转成带颜色的
HTML 再塞进 `<code>`。而这个库的 `escapeXML` **默认值是 `false`**（`lib/ansi_to_html.js:21`
的 defaults 里写着），也就是日志里的 `<`、`>`、`&` 会原样成为标签。

日志里能不能出现访客可控的字符串？能：404 的请求路径、上传的文件名、评论作者、
以及被 pipe 进 server 日志的 website/waline 子进程输出里的 URL。任何一条进了系统日志，
下一个打开那个页面的管理员就会执行攻击者的脚本 —— 而后台 token 放在 localStorage 里，
等于直接把管理员会话交出去（比"能改文章"严重得多）。

修法是一行：`new convert({ escapeXML: true })`。ANSI 颜色照常渲染（这正是这个库的用途），
只是尖括号变实体。测试 `packages/admin/tests/unit/terminalDisplayXss.test.js`（3 条）
不只断言源码写了这个选项，还**用真库跑**：`<img src=x onerror=alert(1)>` 必须变成 `&lt;img`，
颜色 span 必须还在，而且**默认配置的对照组必须仍然漏出真标签**（否则无法证明这个修复有必要）。
第三条断言盯着"全后台只允许这一处 `dangerouslySetInnerHTML`"，以后谁再加第二处就会红，
逼他先想清楚"这里的数据是谁写的"。

⚠️ 写这条断言时踩了两个 grep 的坑：`src/.umi/.cache/.mfsu/*.async.js` 与
`src/.umi-production/.cache/webpack/*.pack` 里都能搜到这个字符串（打包产物），
必须同时 `--exclude-dir=.umi --exclude-dir=.umi-production` **和**限定源码后缀 ——
只限定后缀不够（mfsu 的产物就是 `.js`），只排除目录也不够（`.pack` 不是源码后缀但照样命中）。
另外 `escapeXML: true` 会把中文也转成实体（`红了` → `&#x7EA2;&#x4E86;`），
所以断言颜色时要用英文样例，别断言"输出里包含中文原文"。

### 7.44 IO 与并发（C10K）：先测再改，改完再测

用户要"IO 性能优化，C10K 更好"。这一节的做法是**先建一个可复现的压测台，再动代码**，
每一步都有前后对比数字 —— 因为"并发优化"最容易变成凭感觉加参数。

**压测台**：`vanblog_dev/loadtest.cjs`（本机脚本，不入库）。自己写而不用 ab/wrk 是因为要的是
几个能直接对上代码的指标：并发扫描下的 rps/p50/p95/p99、**socket 层错误**（ECONNRESET/EPIPE，
用来抓 keep-alive 竞态）、状态码分布（429 说明测的是限流器不是栈）、以及
"一万条连接先全部挂住、再一起发请求"的 C10K 模式。⚠️ 客户端与服务端同机，CPU 是抢的，
**绝对值偏保守，但前后对比有效**（同机、同数据、同脚本）。
被测对象是**真镜像起的真栈**（mongo 7.0 + vanblog 容器，数据用 `reset` 从那份 66MB 生产整站备份灌进去，
53 篇公开文章 + 93 个静态文件），不是 dev 服务器。

**第一件事是发现"测的根本不是栈"**：默认配置下 2000 个混合请求里 **1600+ 个是 429** ——
全局限流（每 IP 每分钟 600）挂在 `path: '*'` 上，**每一张图片也算一次**。
一篇带 10 张图的文章 = 11 次计数，600/分钟只够 ~50 次浏览/分钟/IP；
在公司 NAT、校园网、或 CDN 回源 IP 没被识别（所有访客共用一个出口 IP）的场景下，
正常读者会成片看到 429，看起来像站点挂了。
→ 静态资源改走**独立桶**（`/static/**`，默认是全局的 10 倍，`VANBLOG_STATIC_LIMIT_PER_MIN` 可调）。
实测：只压静态资源 3000 个请求 **全部 200**（改造前会在 600 个之后开始 429）；
混合流量里成功响应从 375/2000 提升到 **1426/2000**（同一套限流参数）。

**改的四件事与实测**：

1. **图床图片由 caddy 直接发**（`file_server`），不再穿过 Node。
   两份 caddy 模板都在全局路由之后、`/static/*` 反代之前插了一条路由：
   只匹配 `/static/img/` 与 `/static/img/thumb/` 下的**图片扩展名**
   （webp/png/jpg/jpeg/gif/avif/ico），`root /app` + 与 server 完全一致的缓存头
   `public, max-age=3600, stale-while-revalidate=604800`。
   ⚠️ 只放图片扩展名是**安全边界**：`/static/file/`（附件）、`/static/export/`、`/static/tmp/`、
   `/static/upload-tmp/` 一律继续走 server —— 那边有 nosniff、对 html/svg/js 强制下载、
   以及对导出/临时目录的匿名 403。实测 `/static/export/x.zip` 仍然是 **403**，没被直服放出去。
   实测收益（同一张 1.08MB 的 webp，并发 50 × 800 请求）：
   Node 718.8 rps / p50 37ms / p95 183ms → **caddy 1556.4 rps / p50 24ms / p95 56ms**
   （**2.17 倍吞吐，p95 降 69%**）；单请求 18.4ms → **2.4ms**。
   更重要的是这些字节**不再经过 Node 的事件循环**。
2. **上游 keep-alive 超时必须长于反代的空闲超时**：Node 的 `server.keepAliveTimeout` 默认只有
   **5 秒**，而 caddy 模板里上游空闲超时是 60 秒 —— 反代把连接留在池里，Node 却先关，
   于是偶发 ECONNRESET / 502，且只在"流量有间歇"时出现，极难复现。
   现在显式设 65s（`VANBLOG_KEEP_ALIVE_TIMEOUT_MS`）、`headersTimeout` 再大 1s
   （Node 要求 headersTimeout > keepAliveTimeout），`requestTimeout` 显式 300s。
   有一条测试直接**读 caddy 模板里的 `keep_alive.idle_timeout`（纳秒）和 main.ts 的默认值做对比**，
   保证以后改任何一边都会被钉住。
3. **`UV_THREADPOOL_SIZE=16`**（镜像 ENV）：sharp 的编解码、fs 异步操作、crypto 的 scrypt
   都跑在 libuv 线程池里，Node 默认只有 **4** —— 图片站并发处理时表现为"CPU 很闲但一直在排队"。
   ⚠️ 第一版把这个 ENV 加到了 **website_builder** 阶段（因为 `VAN_BLOG_ALLOW_DOMAINS` 那个锚点
   在文件里出现两次，`replace(...,1)` 命中了第一次）—— 对最终镜像毫无作用，
   是进容器 `echo $UV_THREADPOOL_SIZE` 发现是空的才抓到。**多阶段 Dockerfile 里加 ENV，
   一定要确认落在哪个 stage，并且进容器实测一次。**
4. **`/api/public/meta` 并行化 + 5 秒进程内缓存**：这个接口是全站最热的一次读
   （前台每个页面渲染都要调），而它内部有 **7 个互相独立的 Mongo 查询，以前是串行 await**。
   改成 `Promise.all` 之后总耗时≈最慢的那一个；再加 `utils/publicMetaCache.ts`
   （默认 5s，`VANBLOG_PUBLIC_META_CACHE_MS=0` 可关），后台改站点信息/总字数时主动失效。
   ⚠️ 模块级缓存会**跨 jest 用例复用**：加了缓存之后 public.controller.spec 立刻红了 5 个
   （"期望 5 收到 12"这种），修法是在 `createController()` 里失效一次（每个夹具都干净），
   而不是去调 TTL。

   顺带：编排模板给两个服务都加了 `ulimits.nofile` 65536（高并发下 fd 是第一道天花板，
   mongod 自己低于 64000 也会告警），vanblog 服务加了 `stop_grace_period: 30s`
   （start.js 给子进程 8 秒优雅退出，docker 默认只等 10 秒，余量太薄）。

**C10K 实测结论（要诚实区分"连接层"与"应用层"）**：

| 场景 | 结果 |
| --- | --- |
| 一万条连接**同时挂住** | 全部建立成功，用时 **1.1 秒**，0 拒绝（宿主与容器 fd 上限都是 1048576，somaxconn 4096） |
| 一万条连接上同时请求 **caddy 直服的静态图片** | **10000/10000 全部 200，用时 0.8 秒**，0 失败 |
| 一万条连接上同时请求 `/api/public/meta`（改造前） | 30 秒内只完成 1600 个，其余客户端超时 |
| 一万条连接上同时请求 `/robots.txt`（极轻，但要反代到 Node） | 30 秒完成 4397 个 |
| 混合流量并发扫描（改造前 → 改造后） | c=50：225→**259 rps**、336→**396 Mbps**；c=200：259→**284 rps**、p50 364→**262ms**、p95 2357→**1572ms**；c=500：246→**270 rps**；c=1000：200→**272 rps**、250→**420 Mbps**、**101 个 502 → 0** |

也就是说：**连接层（caddy）本来就能扛 C10K**，静态内容直服之后"一万并发拿图片"是 0.8 秒的事；
真正的天花板是 **Node 应用层（单进程单核）** —— 凡是反代到 Node 的请求，
一万并发就要排队几十秒。要继续往上抬只有三条路，按性价比排序：
① 把更多东西挪出 Node（图片已做；ISR 生成的 HTML 本身就是静态文件，
   理论上也能让 caddy 直接发 `.next/` 里的产物，但要处理 revalidate 语义，风险高）；
② 给热点动态接口加缓存（meta 已做，`/api/public/comments/setting`、分类/标签列表同理）；
③ **Node 多进程（cluster）** —— 这是唯一能真正把动态吞吐乘以核数的办法，
   但前提是先解决 §7.40 B-8 里那批"多实例会重复执行"的东西：
   cron（每小时 ISR、每日 viewer 结算）、`initJwt`、waline/website 子进程的 spawn、
   ISR 的 in-flight 互斥（现在是**进程内**变量，多进程下形同虚设）。
   本机压测时就实测到过**两个 server 进程同时在跑 cron**（watch 重启留下的孤儿），
   所以这件事不是"加个 cluster 就完事"，得先做单实例选主（DB 锁或 env 指定 primary）。

**没做的事**（都是有意的）：没加 `express.json` 的分路由限流（GET 不解析 body，
公开写接口另有 30/min 的限制，收益不大）；没动 mongo 的 `maxPoolSize`（100 对单进程 Node 够用，
真正的瓶颈不在连接数）；没开 Node cluster（见上）；没给 caddy 加缓存插件（标准版没有）。

### 7.45 前台"打开顺滑"这一轮（生产构建实测，不是 dev 数字）

⚠️ **先纠正一条错误结论**：§7.38.2 里写"ByteMD 编辑器进了每个 markdown 页面的首屏 JS，
估计 150–250KB"——**错的**。那份证据（chunk 里 1148 个模块、9 个 `codemirror-ssr`、
57 个 `@popperjs/core`）取自 **dev/server chunk**：dev 产物没压缩、没 tree-shake，
`.next/` 里连 `BUILD_ID` 都是空的。**跑了真 `next build` 之后逐个 chunk 搜
`CodeMirror` / `tippy` / `popper` / 编辑器工具栏字符串，一个都没有** —— 编辑器本来就没进客户端包。
教训：谈"首屏 JS 里有什么"，只能用生产构建的产物；dev chunk 的模块清单只能当线索，不能当结论。
（`MarkdownView.tsx` 仍然改成不 import `@bytemd/react` 那个桶、改用内联的 viewer-only 模块
`MarkdownViewer.tsx`，并加了 spec 钉住 —— 这是防以后有人把编辑器拽回来，不是在修一个现存问题。）

**真正的大头是 highlight.js**：222,215 B 原文 / **65,890 B gzip**，以前只要页面渲染 markdown 就会带上，
哪怕整篇一个代码块都没有。现在渲染器从两档变三档：`Markdown/index.tsx` 在原有
Base/Rich（靠嗅探 mermaid 围栏与行内公式）之外加了 **`MarkdownPlain`**（不含 highlight.js / KaTeX / mermaid），
由新的 `utils/hasFencedCode.ts` 决定走哪一档 —— 嗅探**宁可误判也不能漏判**：
误判只是多下载一个 chunk，漏判会让代码块没有高亮。

**实测（生产构建，页面 HTML 引用到的全部资源 gzip 之和）**：

| 页面 | 改造前 | 改造后 | 变化 |
| --- | --- | --- | --- |
| `/` | 458,979 B | **398,286 B** | **−13.2%** |
| `/link` | 429,632 B | **373,583 B** | **−13.0%** |
| `/about` | 445,336 B | **390,850 B** | **−12.2%** |
| `/timeline` | 251,698 B | 246,837 B | −1.9% |
| `/tag` | 239,239 B | 234,379 B | −2.0% |

产物里核对过：53 篇文章中**仍有 8 篇**带 `hljs-*` 的 token span、且那些页面照样引用 hljs chunk
（有代码块的文章不受影响），首页与 `/link`、`/about`、`/tag`、`/timeline` 不再引用。
全局 CSS 的 hash 前后完全相同（`d9c0aa857e98492b.css`）—— 这轮改动是纯 JS 的，不可能影响样式。
Next 自己的 First Load JS 表几乎不动（`/` 297→293 kB），因为它**不统计 `dynamic(...,{ssr:true})`
的 chunk** —— 这也正是上一条错误结论的来源，看这张表会以为什么都没变。

**阅读量数字：既慢又是错的**。每张列表卡都渲染一个 `<PostViewer>`，它在 `useEffect` 里
无条件请求 `GET /api/public/article/viewer/:id`：首页 5 张卡 = 5 次串行 XHR，
每次回一个 ~220B 的**整条 visit 文档**只为显示一个整数，而且卡片先显示 `"..."` 再跳成数字
（每张卡一次文字位移）。改成从 pageProps 里已有的 `article.viewer` 直接渲染 +
`utils/viewerApi.ts` 合并后台刷新（抄的是评论数那套 50ms 合并器的写法）。
浏览器实测：首页客户端请求 **42 → 37**（正好少掉那 5 个），卡片首屏就是
145/127/87/71/86 而不是 `...` → 38/10/2/1/3。
⚠️ **而且旧数字是错的**：那个接口读的是"按 pathname 记的 visit 台账"，
在引入拼音别名之后**同一篇文章被拆成了两条**（数字 id 一条、别名一条），
而 `article.viewer` 是原子 `$inc` 的累计值 —— 卡片以前显示的是**半截计数**。
（把这两套台账合并是 server 侧的事，见 §7.46，不要在前台打补丁。）

**`revalidate` 加了下限与 NaN 兜底**：`VAN_BLOG_REVALIDATE_TIME` 以前直接 `parseInt` 塞进配置，
delay 模式默认 **10 秒**（有流量的页面每 10 秒一次完整 SSR + 两次 API 调用），
写成非数字还会得到 NaN 让 Next 在构建期报错。现在夹到最小值；
按需模式另给一个很长的兜底 revalidate —— `fallback:"blocking"` + `revalidate:{}` 的组合
意味着**按需生成的页面永不过期**，一旦 revalidate 触发丢了就会一直旧下去，
有了兜底就能自愈（代价是最坏情况下内容旧一个周期，比"永远旧"好）。

顺手：`components/WaLine/index.tsx` 以前在**渲染函数体内**调 `dynamic()`，
每次渲染都产生一个新的组件类型 → 子组件被反复 remount；已提到模块作用域（有 spec 钉住）。

**没做的一件事（不是风险问题，是 Next 13 不支持）**：把 apple.css（46KB）与 markdown 专用的那几张表
从全局阻塞样式里拆出来。pages router 只会产出**一份全局 CSS**，不支持按页引入 CSS，
试过的写法被 Next 直接拒了，所以改动已回退而不是半成品交上来。
皮肤字体自托管（解决 FOUT 与那个本机解析不出来的 preconnect 域名）仍然是正解，
需要字体文件与 unicode-range 切子集，留在 §7.40 C-16。

### 7.46 server 资源占用与逻辑/安全漏洞这一轮（全部有实测）

**浏览统计从"每次浏览 8 条命令 / 4 次写"降到 ~1 条**：一次文章页浏览原来要在
metas、articles、viewers、visits 四个集合里记同一件事（无批量、无防抖）。
现在 `utils/viewStatsBuffer.ts` + `provider/stats/` 在内存里合并计数，
按 5 秒定时、进程退出、以及缓冲超阈值三种时机落库。
用 mongod 的 `serverStatus().metrics.commands` 差值实测（同一套协议、N=6/6s、扣掉噪声）：
**8.00 命令 / 4.00 写每次浏览 → ~1.0 命令 / 0.8 写**（1 浏览/秒）；
一个刷新窗口内 20 次浏览是 0.20 命令/次，100 次是 0.05。
**退出不丢数**：SIGTERM 现在会打印`浏览统计落库（优雅退出(SIGTERM)）：6 次浏览 → 4 次 Mongo 命令`
（以前要么 48 条命令，要么硬杀时一条都不落）。

**`visits` 的数据完整性漏洞**：`VisitProvider.add` 里那段"重复键兜底"依赖一个
**根本不存在的** `{date,pathname}` 唯一索引（`listIndexes` 实测只有非唯一单列索引），
所以并发首访会**静默产生重复行**，之后 `findOneAndUpdate({date,pathname})` 改的是任意一行。
真 mongod 上复现过：8 个并发首访 → 8 行。现在 `utils/statsMaintenance.ts` 在启动时合并重复组
并建唯一索引（幂等、有日志、不在请求路径里跑）。
⚠️ **合并取 max 而不是 sum**：`visits.viewer/visited` 是**按路径的累计快照**、不是当天增量
（`add()` 用 `getLastData(pathname).viewer + 1` 起新的一天），线上那两组重复数据也印证了 ——
同一天两行是 2270 与 2266，**求和会得到 4536，正好是真实值的两倍**。
max 还天然幂等、并发安全（`max(max(a,b),b)=max(a,b)`），重复启动或多实例都不会把数字吹大。
开发库上首次运行合并了 2 组、建了 `visits.date_1_pathname_1` 唯一索引与 `viewers.date_1` 唯一索引；
之后每次启动都是"重复组 0 个、合并删除 0 行；索引已存在"。重复组：**2 → 0**。

**可选的保留期**：两张台账以前**永不清理**（本机 8750 条 visit 跨 800 天，索引已 ~0.88MB）。
`VANBLOG_VISIT_RETENTION_DAYS` 默认 **0 = 永不删除**（不静默改行为），
挂在已有的每日 ViewerTask 上（不新增定时器），无论设多少都保留最近若干天，删了多少会打日志。

**去掉每请求的浪费**：`InitMiddleware` 以前**每个 API 请求**都 `users.findOne({})`
（顺带把密码哈希读进内存），现在缓存"是否已初始化"，于是
`GET /api/public/article/viewer/:id` 从 2 次 find 降到 1 次；
`initJwt` 以前在 `main.ts` 与 JwtModule 工厂里**各连一次**且两次都不 `client.close()`
（每次泄漏一个 MongoClient 与它的 SDAM 定时器），现在只连一次、复用密钥 ——
启动日志从两条连接变成一条连接 + 一条"复用已读取的 jwt 密钥（不再新建 MongoClient）"；
`LogProvider.searchLog` 以前每次打开后台日志页都**整文件逐行读 + 逐行 JSON.parse**，
现在用 `utils/logTail.ts` 限界，响应形状不变。

**安全**：picgo 的插件安装改成 `VANBLOG_ALLOW_PICGO_PLUGINS` 开关，**默认关**，关着的时候给明确报错。
picgo 1.5.6 拖进来的 `git-clone@0.1.0`（命令注入，**上游无修复**）与 `decompress`（路径穿越，无修复）
意味着"后台可配的插件字符串"= 拿到后台会话就能在容器里 root 执行；
picgo 其余上传链路不受影响。website 子进程的重启竞态也修了：
`stop()` 置空 ctx 并 kill，但子进程的 exit 处理器会无条件 respawn ——
优雅停机时可能留下一个 detached 的孤儿进程；现在照 waline 的做法加了 `stopping` 标志，
那个**从未被赋值**的 `starting` 互斥量变成真的，respawn 也加了有限退避。

**cluster 模式**（`VANBLOG_CLUSTER_WORKERS`，**默认 1 = 与今天完全一致**）：
单进程 Node 是动态请求的实测天花板（§7.44：一万并发拿静态图 1.2 秒，拿要反代的动态接口就不行）。
`utils/clusterRole.ts` 把两个 cron、两次子进程 spawn、启动期的 wash、首轮全量 ISR/RSS、
统计维护都限定在 primary；限流/登录/尝试次数的预算与 mongoose `maxPoolSize` 按 worker 数均摊；
primary 先解出 JWT 密钥再 fork，并转发 SIGTERM、对不退的 worker 补 SIGKILL。
⚠️ **诚实的保留**：本机没有生产镜像可跑，多进程路径只有"注入假对象的单元测试"，
**从未真的以 N>1 跑起来过**；而且内存随 worker 数近似线性增长，这与"占用更低"是相反的 ——
所以默认值保持 1，要用得自己压测过再开。

**测试**：server jest **885 用例、883 绿** + 2 个既有的 `utils/watermark.spec.ts` 离线字体用例
（基线是 699/698，也就是 **+186 条**），分布在 viewStatsBuffer、viewStats.provider、
statsMaintenance.provider、statsMaintenance、logTail、log.provider.tail、initJwt、init.provider、
picgo.provider、clusterRole、clusterBootstrap、website.provider.respawn、audit-hardening-round2；
`tsc -p tsconfig.dev.json --noEmit` 干净。
⚠️ CI 的 `server-test.yml` 用的是**显式 testPathPattern 白名单**，新 spec 不加进去就永远不会在 CI 跑 ——
本轮补了 9 个 token（`viewStatsBuffer|viewStats.provider|statsMaintenance|logTail|initJwt|init.provider|picgo.provider|clusterRole|clusterBootstrap`）。
以后加 spec 文件都要顺手改这里。

### 7.39 测试基线（本分支最后一次全量运行的结果）

| 套件 | 结果 |
|---|---|
| server `jest` | 885 用例：883 绿（另 2 个是 `utils/watermark.spec.ts` 的离线字体用例），1 个既有失败（`utils/watermark.spec.ts` 需要联网拉字体，见 §2.1） |
| website `vitest run` | 67 文件 / 672 用例全绿 |
| admin `node --test tests/unit` | 84 套件 / 347 用例全绿 |
| `scripts/tests/*.test.sh`（一键脚本/部署） | 22 文件 / 1106 条断言全绿（§7.41 之后；此前为 19 文件 / 859 条） |
| admin playwright e2e | 未跑（没装浏览器） |

改动之后请至少跑对应包的那一套；跨包改动（例如同时动了 server 与 docs）三套都跑。

---

## 8. 给 AI 代理的额外提示

1. 动手前先 `git log --oneline -10` + `git status`，确认自己在哪个分支、有没有未提交的东西。
2. 改完代码**必须跑测试**（§2.1），并对照 §7.39 的基线判断是不是自己弄坏的。
3. 需要改本地环境时，**新建文件 + 写进 `.git/info/exclude`**，不要改仓库跟踪的文件（§6.2）。
4. 提交信息用 Conventional Commits；一个需求一个提交，交叉文件的改动尽量按功能拆开
   （必要时用 `git apply --cached` 做 hunk 级暂存）。
5. 不要 `git push` 到 `origin`；推自己的 fork（§2.2）。不要打 tag。
6. 涉及上传/图片/附件的功能，注意三条既有约束：附件只落本地、图片按 `(sign, staticType)` 去重、
   图片管线顺序不可调整（§7.5）。
7. 本机专属信息（真实路径、代理、已导入的数据、远端与凭据、遗留待办）都在 `AGENTS.local.md`，
   **不要把它的内容写进入库文件，也不要提交它**。
