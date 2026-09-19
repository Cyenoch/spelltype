# Spelltype · 咒文对决

通过输入咒文进行实时对战。微信是唯一登录方式；账号、会话、对局结果和维护状态保存在数据库中。

## 运行方式

生产环境是 **一个 Bun 应用 + PostgreSQL**。应用同时提供前端静态资源、HTTP API 和 WebSocket；没有独立管理员端口、按 release 分流的路由或多版本并行运行。

发布采用先排空、再替换：关闭新对局入口，让现有对局完成，停止旧容器，再迁移并启动新容器。替换期间允许短暂不可用；重启不会自动解除维护。

- [部署、Dokploy、CI 维护接口与故障恢复](docs/deployment.md)
- [本地开发配置](.env.example)
- [生产配置模板](deploy/compose.env.example)

## 本地开发

使用 Bun 1.4.2：

```sh
bun install --frozen-lockfile
cp -n .env.example .env
bun run dev
```

已有 `.env` 时只补充缺失配置，不覆盖凭据。默认本地数据库为 PGlite，生产必须使用 PostgreSQL。

登录前需要在 xsg-website 的 `/developers` 创建应用，并配置桥接服务地址、该应用的 App ID / App Key，以及允许的回调主机。这里的 App ID **不是微信 AppID**；微信 AppSecret 不放入 Spelltype。具体变量见 `.env.example`。开发时留空整组桥接配置会禁用登录，配置不完整则拒绝启动。

前端使用 Vite HMR；修改后端后显式重启。不要用 Bun `--watch` 同时争用同一个持久化 PGlite 目录；异常退出后，只有确认原进程已停止才能清理其占用标记。

## 检查与构建

```sh
bun run format:check
bun run lint
bun run check
bun run test
bun run test:e2e
bun run build
```

`bun run verify` 包含格式、lint、类型、单元测试和构建，**不包含浏览器测试**。浏览器测试使用隔离的应用、数据库和微信桥接夹具，不需要真实微信凭据。

构建产物包含 `dist/client`，以及应用、迁移、维护三个入口：`dist/server/index.js`、`dist/server/migrate.js`、`dist/server/maintenance.js`。应用启动会自动应用待处理迁移，再校验迁移历史，成功后才监听端口；空库无需先运行迁移命令。单次迁移入口仍供排空替换流程使用，维护命令不修改 schema。

## 管理权限

- 人工维护：微信登录后，持久化 `admin` 角色可访问 `/admin/maintenance`。
- CI / 脚本：可选的维护专用令牌，只授权 `/api/ops/maintenance`，不授权账号管理或容器操作。
- 宿主机部署：使用现有 Docker 权限，应用容器不挂载 Docker socket。

维护状态、排空就绪和实例健康是不同概念；自动化使用方式及恢复边界见[部署文档](docs/deployment.md)。

## 许可

见 [LICENSE](LICENSE)、[LICENSING.md](LICENSING.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
