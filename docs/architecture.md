# 架构说明（Cognitive Atrium P0）

本文件描述首版（P0）实现架构。设计依据为工作区根目录的《Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划》，本文件只补充工程落地细节；两者冲突时以设计文档的 MUST 要求为准。

## 1. 分层与依赖方向

```
apps/web (React + Vite + Tailwind + Motion + Zustand)
   │  HTTP 命令 / SSE 事件（只提交命令，不直接改正式成果）
   ▼
apps/server (Fastify：命令校验、会话、调度、SSE、投影、导出导入)
   │  进程内调用（同一执行内核）
   ▼
packages/harness (执行内核：计划/执行/校验/修复/接受/恢复，无 DOM)
   ├── packages/providers (OpenAI-compatible 适配器、能力探测、凭据、URL 策略)
   ├── packages/tools   (8 个 P0 工具、CSV/JSON 引擎、确定性算子、权限)
   ├── packages/storage (node:sqlite WAL、事件存储、内容寻址对象、事务、租约)
   └── packages/recipes (受限配方 DSL、编译/测试/执行/失效)
apps/cli (HTTP 客户端：与空间 UI 调用同一命令 API，产生同一业务状态)
packages/contracts (版本化 Zod Schema、实体、事件、API 类型；浏览器安全)
scenarios/cognitive-atrium (合成资料、内置四模块模板、Demo 夹具)
```

- `packages/contracts` 不依赖任何其他包，也不得 import Node 内置模块（空间 UI 复用同一套校验器）。
- `packages/harness` 只依赖 `contracts`、`storage`、`tools` 的类型，不依赖 DOM / React / 画布坐标。
- `packages/providers` / `packages/tools` / `packages/storage` 之间互不依赖（`recipes` 可依赖 `tools` 的纯算子）。
- `apps/server` 是唯一装配根：读取配置、打开存储、构造 ProviderGateway / ToolRuntime / Validator / HarnessEngine、注册路由、托管前端构建产物。

## 2. 三种模式与物理分区

| 模式 | 数据与调用 | 实现 |
| - | - | - |
| Demo | 固定可复现事件夹具，无外部 LLM 调用 | `data/demo/`：独立 SQLite + 对象目录；启动时按夹具播种 |
| Live | 真实模型、真实工具、真实存储与预算 | `data/live/`：独立 SQLite + 对象目录 |
| Replay | 回放已记录事件，不重新执行副作用 | 任一模式内的只读视图：按 `afterSeq` 读取事件重放，位置由客户端 ViewState 控制 |

- Demo 与 Live 在文件系统层物理隔离，禁止共用数据库或对象目录。
- Live 失败不得自动回退到 Demo 数据；Demo 标识常驻界面。
- 模式切换不能在运行中进行；切换后进入独立任务空间。

## 3. 命令与事件路径

1. 空间 UI / CLI 发送带 `commandId` 与 `expectedRevision` 的命令。
2. `apps/server` 校验会话、Origin、Schema、幂等键、修订号，再进入 Harness。
3. Harness 在事务中持久化状态变更并追加业务事件；只有已提交事件才会被 SSE 推送。
4. SSE 按 `afterSeq` / `Last-Event-ID` 续传；客户端忽略重复 seq，发现缺口重新拉取快照。
5. 快照由后端投影生成（`TaskSnapshot`），前端只渲染投影；视角、展开、选中、未提交输入属于 ViewState，不进入业务事件流。

## 4. 关键不变量

1. **一个中心交付物清单**：每个 Task 恰好关联一个 Artifact；模块通过稳定 ID 引用，不通过画布坐标引用。
2. **已提交版本不可变**：`ArtifactVersion` 一旦提交不可修改；恢复旧版本产生内容相同的新版本。
3. **草稿隔离**：模型输出先进入 `PatchProposal`，用户接受前不改变中心正式版本。
4. **无动画驱动业务**：任何进度、成功、失败、解锁都必须来自后端状态；UI 动画只表达状态转换。
5. **事件与状态同事务**：`storage.appendEvents` 与状态更新在同一个 SQLite 事务中提交。
6. **执行依赖无环**：计划步骤与模块依赖在写入前做环检测；"回环"只表示结果回收。
7. **预算按实际调用计数**：重试不免费；token 无 provider 数据时标记为估算；无法获得价格时金额显示"未知"。
8. **失败/取消副作用**：不清空已接受成果；未知副作用进入 `outcome_unknown`，不自动重放。

## 5. 数据存储

- SQLite（Node 内置 `node:sqlite`，WAL）保存实体元数据、版本关系、运行检查点、命令幂等记录、工具调用、配方与事件。
- 原始资料、大工具结果与导出对象放入内容寻址目录：`objects/<sha256 前两位>/<sha256>`；写文件采用临时对象 + 原子重命名，数据库只引用已完成对象。
- 每次模型或工具调用前登记调用意图，完成后保存结果与下一检查点；运行租约 + fencing owner 阻止失效执行者继续提交。
- 备份 = WAL checkpoint 后的一致性数据库快照 + 对象清单；不直接复制正在写入的数据库文件充当备份。

## 6. 安全边界

- 服务默认只监听回环地址；写命令校验本地会话令牌与 Origin；CORS 严格；不把 "localhost" 当作天然鉴权。
- 凭据只在后端解析（环境变量或受限密钥文件），浏览器只得到已配置状态与掩码；日志/导出/配方/prompt 不含 API key。
- 模型与 MCP 输出视为不可信资料：工具参数必须经 Schema 与权限校验；工具不得调用系统级接受、删除历史、修改密钥/权限或提高预算。
- P0 不开放通用网络抓取、shell、Python eval、浏览器自动化、任意 SQL、任意文件路径读写。

## 7. 前端空间结构（投影而非新事实来源）

- 五个职责区：中心交付区（CentralHubAnchor）、上方约束区（ConstraintCanopy）、两侧局部执行区（BranchLane）、下方证据区（EvidenceDepth）、右上综合预览区（HighLedgeAttractor）。
- 三层视图：Z+1 全局（约束/依赖/骨架/阻塞摘要）、Z0 执行（中心成果/支线/修复/差异）、Z-1 证据（原始资料/片段/工具轨迹/验证报告）。切层只改 ViewState。
- 默认上限：3 条展开支线、12 个工作节点、16 条可见连线；超限按模块/运行聚合并显示数量与展开入口，不静默丢弃。
- 关闭动效、仅键盘、窄屏（<1024）与 200% 缩放时，全部关键任务仍可完成。

## 8. 工程目录

| 路径 | 内容 |
| - | - |
| apps/web | 空间 UI、SSE/命令客户端、ViewState、可访问交互 |
| apps/server | 命令 API、SSE、会话、调度、事件投影、导出导入、静态托管 |
| apps/cli | 命令行入口（HTTP 客户端，共用命令 API） |
| packages/contracts | 版本化 Schema、实体、事件、API 类型 |
| packages/harness | 执行循环、状态机、预算、检查点、恢复、上下文、验证 |
| packages/providers | 模型适配器、能力探测、凭据与 URL 策略 |
| packages/tools | 工具注册表、权限、CSV/JSON 引擎、确定性算子 |
| packages/recipes | 配方 DSL、编译、校验、执行、失效规则 |
| packages/storage | SQLite 迁移、对象文件、事件与版本存储 |
| scenarios/cognitive-atrium | 合成场景资料与内置四模块模板 |
| tests | 跨包集成、故障注入、端到端 |
| docs | 架构、状态机、接入、工具、配方、验收、演示脚本 |

## 9. 技术选型与版本（实测基线）

| 层 | 实现 | 说明 |
| - | - | - |
| 运行时 | Node.js 22.20.5（Windows 实测） | 支持 `node:sqlite` 内置模块 |
| 语言 | TypeScript 5.9.3 | strict 模式 |
| 服务端 | Fastify 5.12.7 | 单进程，无 Redis/消息中间件 |
| Schema | Zod 4.6.7 | 运行时校验 + `z.toJSONSchema` 导出 |
| 存储 | `node:sqlite`（SQLite 3.51.3，WAL） | 无原生编译依赖，便于复现安装 |
| 前端 | React 18.3.1、Vite 6.4.5、Tailwind 3.4.19、framer-motion 11.18.2、lucide-react、Zustand 5 | 2.5D CSS，无 Three.js/WebGL |
| 测试 | Vitest 2.1.9 | 单元/契约/集成；E2E 见验收文档 |

版本均锁定在 `pnpm-lock.yaml`，不使用浮动 latest。
