# 部署、维护与故障恢复

本文是生产操作手册；配置项及默认值以 [`deploy/compose.env.example`](../deploy/compose.env.example) 为准。所有命令从仓库根目录执行。不要把真实 `.env`、`deploy/compose.env` 或密钥文件提交到仓库。

## 1. 运行与安全边界

生产只有一个 Bun 应用实例和 PostgreSQL。应用在同一端口提供静态资源、HTTP API、WebSocket、管理员接口和可选的 CI 维护接口。数据库全局租约及写入 fencing 阻止旧实例继续修改房间和匹配状态；不能用增加副本数或滚动更新绕过单实例约束。

发布顺序：

```text
验证候选镜像 → 进入维护 → 等待排空 → 停止旧应用
→ 单次向前迁移 → 启动新应用 → 验证健康和镜像身份 → 显式恢复入口
```

这是允许短暂不可用的排空替换，不是零停机或蓝绿部署。`buildId` 只用于诊断与发布核对，不负责玩家路由或授权。客户端协议版本与对局记录中的规则版本各自独立。

三个权限边界：

| 使用者 | 凭据 | 能力 |
| --- | --- | --- |
| 人工管理员 | 微信会话 + 数据库 `admin` 角色 | `/admin` 只读数据管理、维护页面及 `/api/admin/*` |
| CI / 远程脚本 | 维护专用 Bearer 令牌 | `/api/ops/maintenance` 查询、关闭或恢复新对局入口 |
| 宿主机部署程序 | 宿主机 Docker 权限 | 构建、迁移、替换容器和回滚 |

维护令牌不能登录管理员页面、管理账号或调用 Docker。应用没有 Docker socket，也没有通用管理员令牌或独立管理员监听端口。角色在服务端读取；预设管理员仅由受验证的指定 UnionID 授予，昵称、OpenID 或请求头不能授予权限。已有账号被降权后，不会因再次登录自动恢复管理员身份。

## 2. 首次安装

### 配置与持久化

宿主机需要 Bun 1.4.2、Docker 和支持 `up --wait` 的 Compose 插件。

```sh
cp -n deploy/compose.env.example deploy/compose.env
```

按模板填写：

- `SPELLTYPE_STATE_DIR`：保存 `secrets/`、部署锁和 `deploy-state.json`，必须持久保存并保护访问权限。
- `SPELLTYPE_PUBLIC_ORIGIN`：应用对外的规范 origin。
- 微信桥接服务地址及其 `/developers` 应用的 `WECHAT_BRIDGE_APP_ID`。App Key 是桥接应用的服务端密钥，不是微信 AppSecret；允许的回调主机必须覆盖本站，回调路径为 `/api/auth/wechat/callback`。
- `SPELLTYPE_PROJECT`、数据库用户名/库名、宿主机端口及 `SPELLTYPE_UID/GID`。应用 UID/GID 必须能读取部署用户创建的 `0600` 密钥文件。
- `COMPOSE_FILE`：普通宿主机使用 `compose.yaml`；Dokploy 使用下文的完整文件集。

PostgreSQL 数据位于项目专属的 `postgres_data` 命名卷；`SPELLTYPE_STATE_DIR` **不是数据库备份**。更换项目名会指向另一组卷和网络。正常发布、回滚不删除卷；不要把 `docker compose down -v` 当作重试步骤。

### 搜索收录与规范域名

- `SPELLTYPE_PUBLIC_ORIGIN` 在容器内对应 `PUBLIC_ORIGIN`，必须填写正式对外 origin（生产建议 HTTPS）。canonical、Open Graph 分享地址和 `/sitemap.xml` 都从该配置生成，不采信请求的 Host 或转发主机头；更换域名后重启应用即可，无需把域名重新编译进前端。
- 首页 `/` 与教程 `/guide` 是公开收录入口。Bun 应用直接返回练习简介、上手步骤、标题、描述和 JSON-LD，JavaScript 启动后由交互页面接管；这是公开内容摘要，不是完整对战页面的 SSR。
- `/robots.txt` 声明站点地图；`/sitemap.xml` 仅列出两个公开入口。登录、战绩、匹配、创建房间、管理页及带 `room` / `error` 参数的页面返回 `noindex`。不要在反向代理中额外禁止爬取这些 HTML 页面，否则爬虫无法读到 `noindex`。
- 未知页面返回 HTTP 404；`/index.html` 和已知页面的尾斜杠版本重定向至统一入口，保留邀请参数。请勿在 CDN 或反向代理层把所有未知路径改写成首页 200。
- SEO 响应由 Bun 应用提供，不能只把 `dist/client` 部署到通用 SPA 静态托管。Vite 开发服务不提供这些生产 SEO 端点。
- 上线后检查正式域名的首页、教程、`robots.txt` 和 `sitemap.xml`，再向搜索引擎站长平台提交站点地图。本站代码不自动提交，也不保证收录或排名。

### 配置密钥

由受保护的终端环境或 CI 凭据存储注入以下环境变量，再运行初始化命令。不要将密钥放在命令参数、URL 或日志中，也不要开启会打印变量展开值的 shell tracing。

| 输入 | 用途 |
| --- | --- |
| `POSTGRES_PASSWORD` | 数据库密码 |
| `WECHAT_BRIDGE_APP_KEY` | 桥接应用 App Key，至少 16 个字符 |
| `OPENROUTER_API_KEY` | 咒文生成 |
| `MAINTENANCE_TOKEN`（可选） | 32 随机字节的 64 位小写十六进制编码，仅用于 CI 维护 API |

```sh
bun run deploy secrets
```

该命令创建缺失的 `0600` 文件，并生成 `database_url`；**已有文件保持不变**，重新导出环境变量不会轮换旧密钥。轮换需维护窗口内显式更新对应文件并重建应用。数据库密码还需同步修改数据库本身，不能只替换文件。

> **从 DeepSeek 切换到 OpenRouter（既有安装必读）**：咒文生成提供方已更换为 OpenRouter，模型默认 `google/gemini-3.8-flash`（`OPENROUTER_MODEL`）。既有安装不能复用旧的 DeepSeek 密钥，必须在下一次发布前完成迁移：
>
> 1. 在 OpenRouter 创建一个**全新**的 API 密钥，通过凭据存储导出 `OPENROUTER_API_KEY`，运行 `bun run deploy secrets` 生成新的 `openrouter_api_key` 密钥文件。新文件名与既有密钥文件不冲突；该命令只创建缺失文件，不会改写 `postgres_password` 等既有密钥。
> 2. 确认 `deploy/compose.env` 中的 `OPENROUTER_MODEL`（默认 `google/gemini-3.8-flash`）符合预期。
> 3. 按第 3 节流程重新部署（排空 → 停止旧应用 → 迁移 → 启动新应用 → 恢复入口），使新密钥与新模型生效。
>
> 替换后的镜像不再读取旧的环境变量或 `secrets/deepseek_api_key`；确认新配置生效后可删除该残留密钥文件。

咒文生成通过官方 `@openrouter/ai-sdk-provider` 发送严格的 `json_schema` 响应格式，并要求路由端点支持请求参数（`require_parameters: true`）；不使用提示词注入 schema 或 JSON 修复插件。本地仍校验法术数量、字符范围与重复内容。Gemini 3.8 Flash 使用最低支持的 `low` 思考档位；隐藏思考文本不代表关闭思考或免除计费。采样使用模型默认值，不传 `temperature` / `top_p`，避免排除不声明支持它们的 Google 端点。

应用支持对应的 `*_FILE` 配置。直接配置应用或远程 CLI 时，同一个密钥的内联值和文件形式只能选一种；维护令牌显式为空是配置错误，不是禁用接口的方式。

### 构建与安装

```sh
bun run deploy build
```

从输出 JSON 的 `imageId` 取得不可变镜像 ID，设置非敏感变量 `IMAGE_ID` 后执行：

```sh
bun run deploy install --image "$IMAGE_ID"
```

也可使用预先拉取到宿主机的镜像 digest 引用。生产不要依赖可变标签来表示待发布版本。CLI 会解析并固定实际镜像 ID，检查镜像入口，等待 PostgreSQL 健康，执行迁移，启动应用，并在健康验证后恢复入口。

直接执行 `docker build` 时，诊断构建标识的参数名是 `BUILD_ID`，不是 `SPELLTYPE_BUILD_ID`：

```sh
docker build --build-arg BUILD_ID=operator-build -t spelltype:operator-build .
```

### 使用 GitHub Actions 镜像

[`build` 工作流](../.github/workflows/build.yml) 并行执行代码校验与镜像构建，两者成功后才向 `ghcr.io/<owner>/<repository>`（全小写）发布同一份镜像，当前平台为 `linux/amd64`。校验或构建失败时不发布、不部署。

| 触发方式 | 发布标签 |
| --- | --- |
| 推送 `main`，或在 `main` 手动运行 | `main`、`latest`、`sha-<完整提交 SHA>` |
| 推送 `v*` 标签，例如 `v1.2.3` | 原始版本标签、`sha-<完整提交 SHA>`；不更新 `latest` |
| PR，或在其他分支手动运行 | 仅校验及构建，不登录 GHCR、不发布 |

**`main` 推送在发布成功后还会触发一次生产部署**：部署任务直接调用仓库机密 `DEPLOYMENT_HOOK_URL`（Dokploy 部署钩子，配置见第 5 节）。工作流本身不停止容器、不运行迁移、不验证健康、也不恢复入口：迁移由应用启动时自动执行，容器替换由 Dokploy 完成。钩子 URL 等价于凭据能力，只存在仓库机密中，绝不写入工作流或日志；未配置该机密时 `main` 推送的部署任务明确失败，不会静默跳过。`v*` 标签、PR 与其他分支不触发部署。

> **这条路径不排空。** Dokploy 重建容器不会执行第 3 节的 drain → stop → migrate → verify → resume 流程，被替换容器上正在进行的对局会中断——数据库租约与结算状态能保证数据不被写坏，但玩家当场的对局会丢失。要保留排空契约，必须由部署平台或 CI 显式实现排空、无重叠替换、健康校验与恢复；仅调用部署钩子做不到。人工的 `bun run deploy deploy` 路径仍然保留，但必须与钩子部署串行，不能并发替换同一服务。

CI 使用自动提供的 `GITHUB_TOKEN`，不需要新增 PAT 或应用密钥；仅发布任务拥有 `packages: write` 权限。组织策略必须允许发布包；若同名包已存在，需在包设置中授予本仓库 Actions 写入权限。工作流不修改包可见性；私有包的宿主机需先使用有读取权限的凭据登录 GHCR。

镜像的 `BUILD_ID` 为完整提交 SHA。成功运行的摘要列出镜像标签及 digest。**包括 SHA 标签在内的标签都可被重跑覆盖**，生产应从摘要复制完整的 `ghcr.io/<owner>/<repository>@sha256:...` 引用：

```sh
# 将成功运行摘要中的完整 digest 引用赋给 IMAGE_REF。
docker pull "$IMAGE_REF"
bun run deploy install --image "$IMAGE_REF"
# 已安装的环境改用下方命令，按既有维护流程更新：
# bun run deploy deploy --image "$IMAGE_REF" --wait-timeout 900
```

发布阶段加载本次构建的临时镜像产物，不重新构建。临时产物保留一天；过期后须重新运行构建，不能只重跑发布任务。多个标签的推送不是原子操作；中途失败时可能已有部分标签可用，应排查后重跑并以成功记录中的 digest 为准。

工作流的权限、并发、缓存和失败行为见[构建与发布规格](../spec/spec-process-cicd-build.md)。

## 3. 日常发布与维护

```sh
bun run deploy build
# 从构建结果设置 IMAGE_ID。
bun run deploy deploy --image "$IMAGE_ID" --wait-timeout 900
bun run deploy status
```

构建和候选入口验证在关闭服务入口之前完成。排空默认超时为 600 秒；`--wait-timeout` 只设置排空等待，不改变新应用的 180 秒健康等待窗口。

部署日志中的维护 revision 是并发控制值，不是镜像版本。发布会检查 revision 未被其他操作者修改，再停止旧应用；新应用启动前旧容器已停止。真实运行镜像必须匹配被固定的候选镜像。

单独操作维护：

```sh
bun run maintenance status
bun run maintenance drain --timeout 900
bun run maintenance wait --timeout 900
bun run maintenance resume
```

- `drain` 关闭入口并等待排空；已经维护时等待当前维护状态。
- `wait` 不修改状态，只等待当前维护 revision 下的就绪结果。等待期间 revision 改变就失败，不接管别人的操作。
- 超时返回非零，不杀对局、不停止容器、不自动重新开放入口。可以继续等待，或明确选择 `resume` 放弃此次维护。
- `resume` 可以取消尚未排空的维护，让原对局继续并重新接纳新对局。**排空就绪是替换容器的前提，不是取消维护的前提。**

维护状态存储在 PostgreSQL 的 `runtime_control` 中。重启、镜像更换或运行一次迁移都不能自动恢复 `open`；只有显式恢复操作才能开放入口。

### 如何判定可替换

`GET /health` 证明数据库和当前运行时租约可用。维护中它仍可返回 200；健康不等于已排空。

`GET /api/status` 是公开的维护指针与构建/协议信息；它不包含完整排空计数。完整 `DrainStatus` 由管理员接口、维护 CLI 或 CI 维护接口提供：

| 字段 | 含义 |
| --- | --- |
| `mode` | `open` 或 `draining` |
| `revision` | 维护状态的 CAS 版本 |
| `updatedAt` | 最近状态变更的毫秒时间戳 |
| `activeMatches` | 仍在生成、倒计时或进行中的对局 |
| `liveReservations` | 尚未到期的快速匹配席位预留 |
| `waitingTickets` | 等待配对的排队条目；进入维护时清理 |
| `pendingResults` | 尚未完成或失败待重试的结算 |
| `runtimeKnown` | 数据库是否能确认运行时状态，而非未经确认的租约丢失 |
| `runtimeEpoch` | 运行时所有权代次 |
| `ready` | 已维护、四类阻塞计数均为零且运行时状态已知 |

只有 `ready: true` 才可进入替换阶段。不能只检查 `activeMatches === 0`，也不能因超时、请求失败或租约过期而推定安全。状态只是当前观察，不是永久许可；所有发布者必须串行化，执行替换前仍须确认维护 revision 未变化。

revision 校验不是覆盖 Docker 操作的分布式锁。维护页面仍允许人工取消维护，因此从排空成功到发布结束，禁止其他操作者执行恢复或替换；必须把人工操作也纳入同一发布协调流程，不能仅串行化 CI 任务。

## 4. CI / 远程脚本

### 启用服务端令牌

将 `deploy/compose.ops.yaml` 加入生产配置中的 `COMPOSE_FILE`，并通过凭据存储注入随机生成的 `MAINTENANCE_TOKEN`，运行 `bun run deploy secrets`。例如 Dokploy 的完整文件集：

```dotenv
COMPOSE_FILE=compose.yaml:deploy/compose.dokploy.yaml:deploy/compose.ops.yaml
```

令牌在下一次容器重建时加载。未启用此 override、应用也未配置令牌时，机器接口返回 503，但人工管理员和宿主机维护仍可用。**启用 override 却缺少令牌文件是部署配置错误，不会静默降级。**

### 推荐使用 CLI

CI 需要仓库脚本、Bun 和已安装的项目依赖，不需要 Docker 权限即可使用 `--http`。设置：

```sh
export SPELLTYPE_OPS_URL=https://spelltype.example.com
export MAINTENANCE_TOKEN_FILE=/run/secrets/spelltype-maintenance-token
```

文件由 CI 凭据存储挂载，不要把真实令牌写入脚本。也支持环境变量 `MAINTENANCE_TOKEN`，但不可与文件形式同时设置。远程 origin 必须是 HTTPS；仅 `localhost`、`127.0.0.1`、`[::1]` 允许本地 HTTP。URL 不能含凭据、路径、查询参数或 fragment；客户端拒绝跟随重定向。

一次发布拆成三个有条件的步骤：

1. 执行 `bun run maintenance drain --http --timeout 900`。它同时关闭入口并轮询，只有退出码为零才进入下一步。若只需观察已经进入的维护，用 `bun run maintenance wait --http --timeout 900`。
2. **由 CI / 部署平台负责**停止旧容器、使用候选镜像运行单次向前迁移、启动唯一的新容器，并确认实际镜像及 `/health` 的目标构建正确。机器 API 不执行这些动作。该平台必须与人工维护、其他发布任务串行化；不得用滚动更新启动第二个写入实例。
3. 验证通过后执行 `bun run maintenance resume --http`。CLI 重新从 `/health` 取得当前 epoch，再以维护 revision 和该 epoch 恢复入口。

不得把恢复放在无条件的 `finally` / CI `always()` 步骤中。远程 `resume` 验证当前运行时，但不会替 CI 判断它是否为预期候选镜像；步骤 2 的目标镜像核对不可省略。失败时保持关闭，调查后显式恢复。

### 直接调用 API

`GET` 和 `POST /api/ops/maintenance` 都要求 `Authorization: Bearer <维护令牌>`。令牌仅放在授权头中，日志需屏蔽该头。GET 返回上表的 `DrainStatus`；POST 返回新的 `MaintenanceInfo`，不表示已排空。

关闭入口的请求体（`N` 替换为刚读取的 revision）：

```text
{"mode":"draining","expectedRevision":N}
```

随后 GET 轮询，确认 revision 未变化且 `ready` 为 true。替换完成后，重新读取新实例 `/health` 的 epoch `E`，恢复请求体为：

```text
{"mode":"open","expectedRevision":N,"expectedRuntimeEpoch":E}
```

这里 `N` 是当前维护 revision，不是进入维护前的旧值。不要使用旧实例的 epoch 或仅凭排空响应中的 epoch 恢复。

- `400`：请求形状不合法，例如恢复时缺少 epoch。
- `401`：维护令牌缺失或错误；微信 cookie 不能代替它。
- `409`：revision / epoch 冲突。停止自动化，重新观察并确认操作者意图，不要自动强制重试。
- `503`：接口未配置或运行时不可用等情况；不能当作排空成功。

## 5. Dokploy

使用 `compose.yaml:deploy/compose.dokploy.yaml`，需要机器 API 时再追加 ops override。设置 `SPELLTYPE_DOKPLOY_HOST`，确保它与规范公开 origin 对应，并按宿主机实际配置调整 Traefik router、entrypoint 和证书 resolver。

Dokploy override 使用外部 `dokploy-network`，通过 Traefik 把域名路由到 `app:3000`；宿主机端口只绑定 loopback，供本地健康探测使用。每一次 CLI 操作都必须使用同一套 `COMPOSE_FILE`，否则容器重建可能丢失路由标签。

**一个服务只能有一个容器生命周期控制者：**

- 本仓库默认让 CI 拥有 `main` 推送的替换触发：工作流发布镜像后调用 Dokploy 部署钩子（第 2 节）。此时不要再用宿主机 CLI 对同一环境执行更新；首次安装、显式回滚和故障恢复仍由宿主机 CLI 完成。
- 如果改为由宿主机部署 CLI 负责日常发布，则必须关闭 Dokploy 的自动部署 / webhook 触发器，并从工作流移除部署任务（同时更新[构建与发布规格](../spec/spec-process-cicd-build.md)）。
- 无论选择哪一侧，都必须实现第 3 节的排空、无重叠停止/启动、迁移、健康验证和恢复流程；不能再让宿主机 CLI 或另一个自动部署任务同时替换。

Compose 默认信任代理提供的转发地址。必须确保入口覆盖受信任的客户端 IP 头且无法绕过入口；无可信代理时显式设置 `TRUST_FORWARDED_FOR=false`。其他模式见配置模板。

## 6. 迁移与回滚边界

生产应用启动会自动应用待处理迁移，再校验迁移历史，全部成功后才监听端口。空库无需预先运行迁移命令；重复启动不会重复应用迁移。PostgreSQL 迁移使用独立连接池和有界咨询锁，迁移失败会阻断启动。数据库必须包含镜像预期的完整、哈希匹配的迁移前缀；数据库可以有更多已应用的后续迁移，但这不等于旧代码一定兼容新 schema。维护命令仍只校验 schema，不执行迁移。

`0000_init_wechat_auth_schema.sql` 是保留的基线，不改写、不回退。后续变更只增加向前迁移。部署 CLI 仍使用单次迁移入口，并在完成后确保维护关闭；应用启动会保留既有维护状态，不自动恢复入口。自动迁移和单次迁移入口都**不会替调用者排空正在运行的旧应用**；更新已有部署时仍必须先排空、停机，再启动新应用。

应用启动若发现另一存活实例仍持有运行时租约（任何 stop-first 替换的固有窗口：替换任务先启动、旧任务才收到 SIGTERM），不会立即崩溃，而是在默认 90 秒（3 × 30 秒租约 TTL）内每 2 秒重试获取，并在日志中以 `{"event":"lease_busy"}` 计数；窗口耗尽仍繁忙则以非零退出，把决策交还编排器。这使绕过部署 CLI 的容器替换不再把短暂交接放大成崩溃循环，但**不能**以此替代排空流程：等待中的实例不监听端口、不对外服务，SIGTERM 会立即退位。

首次从旧 release 架构切换时：

1. 用旧版本工具关闭准入并排空旧系统，再停止所有旧运行时。
2. 确认没有进行中的对局、有效预留、未完成结算和有效旧租约。切换迁移会加锁检查，不满足条件就拒绝，不能跳过检查。
3. 备份 PostgreSQL 并确认恢复方案；保留旧卷及必要的旧配置，不能先删库或删卷。
4. 配置新架构，运行 `bun run deploy secrets` 和 `bun run deploy install --image "$IMAGE_ID"`。

切换迁移保留账号、会话、结果和规则历史，授予预设管理员角色，清理旧等待队列和 release 结构。迁移不是对任意后续数据变换的无损保证，备份仍然必要。

普通回滚：

```sh
bun run deploy rollback --schema-compatible
# 需要明确指定目标时：
bun run deploy rollback --image "$ROLLBACK_IMAGE_ID" --schema-compatible
```

回滚流程不运行单次迁移入口，也不下迁移 schema；旧镜像启动仍会执行幂等的自动迁移检查，已应用的迁移不会重复执行。`--schema-compatible` 是操作者对兼容性的确认，不是自动兼容检查：需要确认旧镜像能使用当前 schema、数据和环境/密钥契约，不能因为迁移看起来是“新增字段”就默认安全。旧镜像还必须通过迁移前缀及启动健康检查。

首次架构切换删除了旧 release 结构，不能把旧 release 镜像当作普通回滚目标。回到旧体系需要独立的备份恢复计划，且必须评估切换后新增数据的损失风险；工具不会自动执行。

## 7. 故障恢复

`deploy-state.json` 记录 `current`、`previous` 和 `pending`。停止旧容器前先保存待执行目标；通过健康验证后先更新镜像历史，再恢复入口。请保留这些记录和对应镜像，不要手工篡改 journal 来绕过失败。

| 失败位置 | 处理 |
| --- | --- |
| 候选构建或入口检查失败 | 不关闭当前入口；修复候选镜像 |
| 排空超时 | 原容器和对局保留，维护保持关闭；继续等，或显式取消维护 |
| 停机后迁移、启动、健康检查失败 | 不自动回滚、不自动开放；检查数据库状态与 journal，再显式恢复 |
| 恢复请求的确认丢失 | 结果可能已提交；先读持久状态，不能声称仍关闭或盲目重复发布 |
| 首次安装失败且无健康历史 | 修复原因后重试 `install`；没有可默认回滚的旧镜像 |

失败更新存在 `pending` 时，默认 rollback 恢复 **`current` 所记录的最后健康镜像**，不是再退到 `previous`。正常完成发布后没有 pending，默认 rollback 才选择 previous。恢复前要求持久维护仍为 draining，且四类阻塞计数全为零；失败容器会先停止，恢复镜像健康后才开放。

```sh
bun run deploy status
bun run deploy rollback --schema-compatible
```

崩溃循环中的应用可能使 `status` 无法通过容器内命令读取维护状态；这不表示维护已经解除。恢复分支会使用目标镜像的一次性数据库入口检查。必要时由有数据库权限的操作者执行只读诊断：

```sql
SELECT mode, revision, runtime_epoch
FROM runtime_control
WHERE singleton = 1;
```

不要手动修改控制行、清零阻塞计数或强制夺取租约来使检查“通过”。宿主机进程崩溃留下锁时，先确认原发布者已停止，再使用 `bun run deploy unlock`；该命令拒绝移除仍有活跃持有者的锁。

## 8. 验证范围

常规检查见根目录 README。发布验收还应在隔离 PostgreSQL、独立 Compose project、临时密钥和端口上实际覆盖：首次安装、顺序替换、正常回滚、排空超时不停止旧容器、停机后的迁移失败、启动失败、显式恢复、持久维护重启、旧 epoch 拒绝恢复、管理员与 CI 凭据隔离。

Compose 渲染能验证 Dokploy 标签、网络和 secret 挂载，但不能代替真实平台上的 DNS、证书、反向代理和生命周期配置验收。验收不要读取或修改生产凭据、数据库或卷。
