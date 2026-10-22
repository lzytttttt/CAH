# Cognitive Atrium — 空间化 LLM Harness（P0）

以**中心交付物**为核心的本地单用户空间化 LLM harness：模型真实调用、受控工具执行、差异审阅、版本恢复、配方复用与事件回放。空间界面只是执行过程的可视化投影，所有业务状态来自后端运行时与持久化记录。

> 设计依据：工作区根目录《Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划》。
> 本文件是实施后的工程说明；P0 完成情况与验收证据见 [docs/acceptance-report.md](docs/acceptance-report.md)、[docs/implementation-status.md](docs/implementation-status.md)。

## 1. 能力边界（P0）

| 能力 | 实现 |
| - | - |
| 真实模型 | OpenAI-compatible Chat Completions 适配器：流式输出、原生 tool calling、usage、超时、错误分类、能力探测（逐项 verified/unsupported/unknown） |
| 任务与成果 | 任意任务、1–8 个模块化交付物（markdown/JSON/CSV）、草稿 → 差异 → 版本接受、版本恢复、导出 |
| 工具 | source.list/read/search、data.profile、data.transform、artifact.read/propose_patch/validate；只读 + 隔离草稿写；无 shell/任意代码/外部写 |
| 运行控制 | 计划预览、真实风险、暂停/继续/取消、预算与超时、检查点、崩溃恢复、SSE 事件续传 |
| 空间 UI | 五区布局、三层视图、A–D 四机制、锁定/只读 Demo、键盘与减少动效、窄屏退化 |
| 配方 | 受限 DSL、确定性清洗配方零 LLM 调用、测试用例（原始/新数据/非法输入）、失效指纹、服务端提取候选配方 |
| CLI | 与 UI 共用同一命令 API，可脚本化输出，等待输入返回结构化状态（exit code 2） |
| 明确不做 | 公网多租户、组织权限、多人协同、任意代码执行、外部系统写入、P1 适配器（禁用以范围注明） |

## 2. 快速开始

### 环境要求

- Node.js **22.13+**（开发实测 22.20.5；使用内置 `node:sqlite`，无需原生编译）
- pnpm **11.x**（`corepack enable` 后按 `packageManager` 字段自动使用）
- 操作系统：Windows 10/11、Linux、macOS（开发验收基线 Windows）

### 安装与开发

```bash
pnpm install            # 安装（锁文件固定；首次会按 pnpm 策略执行 esbuild 构建脚本）
cp .env.example .env    # 按需填写；不配置模型凭据也可启动，但 Live 任务会明确报配置错误
pnpm dev                # Fastify API(4310) + Vite 前端(5173, 代理 /api)
```

打开 <http://127.0.0.1:5173> 使用空间工作台；Demo 演示数据在首次启动时写入 `data/demo/`。

### 生产构建与启动

```bash
pnpm build              # web(dist) + server(dist/server.mjs) + cli(dist/cli.mjs)
pnpm start              # 后端托管构建后的前端: http://127.0.0.1:4310
```

### Docker

```bash
docker compose up --build
# 打开 http://127.0.0.1:4310；数据卷 cognitive-atrium-data 持久化 data/
```

容器内访问宿主机模型服务时，把宿主机地址加入 `CA_ALLOWED_PROVIDER_HOSTS`（例如 `host.docker.internal:11434`），并注意容器内 `localhost` 不是宿主机。

### Demo 数据

```bash
pnpm seed:demo          # 只重建/播种 Demo 命名空间（data/demo），不触碰 Live
```

Demo 工作区是**只读演示**：展示固定的计划/阻塞/草稿/验证/接受状态，不调用真实模型。

### CLI

```bash
pnpm cli -- --help
pnpm cli -- provider test --profile <id> --json
pnpm cli -- task create --title "..." --intent "..." --template cognitive-atrium
pnpm cli -- run start --task <taskId> --module <moduleId> --intent "..."
pnpm cli -- run status --run <runId>
pnpm cli -- artifact review --patch <patchId>
pnpm cli -- artifact accept --patch <patchId> --report <validationReportId>
pnpm cli -- recipe run --recipe <recipeId> --inputs inputs.json
pnpm cli -- task export --task <taskId> --format task_package --out export.zip
```

CLI 通过 `data/session-token`（或 `--token-file` / `$CA_SESSION_TOKEN`）以 `Authorization: Bearer` 认证；`--json` 时 stdout 只有一个 JSON 文档，日志走 stderr。等待人工输入时返回 **exit code 2** 与结构化 blocker / resolution options，而不是失败。

## 3. 配置

完整变量见 [.env.example](.env.example)。关键项：

| 变量 | 默认 | 说明 |
| - | - | - |
| `CA_PORT` / `CA_HOST` | `4310` / `127.0.0.1` | 仅监听回环；生产容器内设为 `0.0.0.0` |
| `CA_DATA_DIR` | `./data` | 数据根目录，`live/` 与 `demo/` 物理隔离 |
| `CA_SESSION_SECRET` | 自动生成 | 本地会话令牌；留空时写入 `data/session-token` |
| `CA_OPENAI_BASE_URL` / `CA_OPENAI_MODEL` / `CA_OPENAI_API_KEY` | 空 | Live 模型连接；凭据只在后端读取 |
| `CA_OPENAI_CREDENTIAL_REF` | `CA_OPENAI_API_KEY` | 凭据引用名（环境变量或 `_FILE` 受限文件） |
| `CA_CREDENTIALS_MASTER_KEY` | 空 | 若要通过 UI 保存凭据，必须提供 ≥16 字符主密钥（AES-256-GCM，密钥与数据库分开） |
| `CA_ALLOWED_ORIGINS` | 本机 4310/5173 | 浏览器 Origin 允许列表 |
| `CA_ALLOW_HTTP_LOOPBACK` | `true` | 允许 `http://` 回环模型服务；远程必须 HTTPS |
| `CA_ALLOWED_PROVIDER_HOSTS` | 空 | 内网模型服务精确 host:port 白名单 |
| `CA_SEED_DEMO` | `true` | 首次启动播种 Demo 数据 |

## 4. 数据与安全

- 数据目录：`data/live/`（真实工作区）与 `data/demo/`（演示）分别包含 SQLite（WAL）与内容寻址对象目录 `objects/`。备份时先 WAL checkpoint，再同时复制数据库与对象清单。
- 会话：写命令需要本地会话；浏览器使用 HttpOnly + SameSite=Strict cookie 与 `x-csrf-token`，CLI 使用 Bearer；所有请求校验 Origin 允许列表。
- 凭据：后端环境变量/受限文件/加密文件读取；浏览器只看到“已配置/未配置”和掩码；日志、导出、事件脱敏，不包含 API key。
- 工具输入为不可信内容：参数经 Schema 与权限校验；无任意文件路径、无 shell、无外部写入。
- 部署边界：本机单用户/可信内网开发环境；发布公网前必须补充鉴权、任务隔离、HTTPS、速率限制与独立验收（见 [docs/known-limitations.md](docs/known-limitations.md)）。

## 5. 开发命令

```bash
pnpm install
pnpm dev            # 开发：server + web
pnpm build          # 生产构建
pnpm start          # 启动生产构建
pnpm typecheck      # 全仓 TypeScript strict 检查
pnpm test           # 单元 / 契约 / 集成测试
pnpm seed:demo      # 重建 Demo 数据
pnpm cli -- --help  # CLI
```

## 6. 目录结构

见 [docs/architecture.md](docs/architecture.md)。核心包：

- `packages/contracts`：版本化 Zod Schema、实体、事件（逐类型 payload）、状态机、API 类型、纯函数（补丁应用/diff/环检测）。
- `packages/harness`：执行内核（计划/执行/校验/修复/接受/恢复/上下文/验证器），无 DOM 依赖。
- `packages/providers`：OpenAI-compatible 适配器、能力探测、凭据、URL 策略。
- `packages/tools`：8 个 P0 工具、CSV/JSON 引擎、确定性算子。
- `packages/storage`：`node:sqlite` WAL、事件存储、内容寻址对象、事务、租约。
- `packages/recipes`：受限配方 DSL、指纹、测试、提取。
- `apps/server` / `apps/web` / `apps/cli`：命令 API/SSE/投影/导出导入、空间工作台、CLI。

## 7. 文档

- [架构说明](docs/architecture.md)
- [状态机与恢复](docs/state-machines.md)
- [需求追踪矩阵](docs/traceability.md)
- Provider 接入指南（实时能力报告）— `docs/provider-integration.md`
- 工具与权限指南 — `docs/tools-permissions.md`
- 配方说明 — `docs/recipes.md`
- 用户操作指南 — `docs/user-guide.md`
- 演示脚本 — [scripts/demo.ts](scripts/demo.ts)
- 验收报告（含未完成项）— `docs/acceptance-report.md`
- 已知限制 — `docs/known-limitations.md`
- 实施状态 — [docs/implementation-status.md](docs/implementation-status.md)

## 8. 许可

MIT，见 [LICENSE](LICENSE)。第三方依赖许可清单见 `docs/third-party-licenses.md`。
