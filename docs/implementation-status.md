# 实施状态（跨会话工作记忆）

> 本文件由 Lead 维护，记录当前阶段、工作流分工、已完成证据与已知缺口。恢复工作时先读本文件，再读设计文档与 `docs/traceability.md`。

更新时间：2026-10-22（Phase 0 → Phase 1/2 进行中）

## 当前阶段

- 目标：按《Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划》完成 P0 交付（Phase 0 → Phase 7）。
- 已完成：
  - Phase 0 骨架：pnpm workspace、TypeScript strict、Vite/Tailwind/React 前端壳、Fastify 服务壳、esbuild 生产构建、vitest 测试、git 基线提交。
  - `packages/contracts`：实体/事件（47 种事件，逐类型 payload Schema）/状态机/API/计划/补丁/配方/投影类型 + 纯函数（环检测、补丁应用、diff、事件校验）；26 个契约测试通过。
  - 端口冻结：harness/storage/tools/providers/recipes 的接口与占位实现，保证并行开发可编译。
  - 场景夹具：24 行存量系统数据（2 组重复主键、3 字段别名、2 异常枚举、1 缺失必填，已用 Node 实测核对）、约束冲突集、角色需求、新数据/非法数据、四模块模板。
  - Phase 0 文档：`docs/architecture.md`、`docs/state-machines.md`、`docs/traceability.md`。
- 进行中（并行工作流，每位 teammate 持有共享任务）：
  | 工作流 | 任务 | 负责 | 验收 |
  | - | - | - | - |
  | providers | task-1 | providers-dev | `pnpm exec vitest run packages/providers` |
  | tools | task-2 | tools-dev | `pnpm exec vitest run packages/tools` |
  | storage | task-3 | storage-dev | `pnpm exec vitest run packages/storage` |
  | harness | task-4 | harness-dev | `pnpm exec vitest run packages/harness` |
  | web | task-5 | web-dev | `pnpm build:web` + `pnpm exec vitest run apps/web` |
  | cli | task-6 | cli-dev | `pnpm exec vitest run apps/cli` + `pnpm build:cli` |
  | server 集成 / 场景 / 文档 / 验收 | Lead | Lead | 见下 |

## Lead 待办（按顺序）

1. `apps/server`：会话/Origin/CSRF、命令 API（全部 18.1 路由）、SSE 续传、调度队列、事件投影（TaskSnapshot）、导出/导入（含 ZIP）、provider profile 与凭据状态、Demo 播种、双模式运行时（demo 只读）。
2. `scripts/seed-demo.ts` + `scripts/demo.ts`：Demo 夹具事件、演示脚本。
3. 集成测试：使用注入的 fake provider（本地 HTTP 假服务）跑通 plan→commit→tool→validate→review→accept→export→restore；SSE 续传；幂等；版本冲突；取消；恢复。
4. Live 验证：检查环境是否有可用模型凭据；没有则写 `docs/provider-report.md` 明确"未完成 Live 验证"，不得用 Mock 补记。
5. Phase 6/7：Playwright/浏览器级端到端（如可安装）、性能实测、Docker、README、.env 文档、验收报告、已知限制、LICENSE/依赖许可。
6. 最终：`pnpm install && pnpm typecheck && pnpm test && pnpm build` 全绿；干净目录按 README 启动验证。

## 关键决策记录

1. **存储使用 Node 内置 `node:sqlite`**（Node 22.20 实测可用；避免 better-sqlite3 原生编译，满足可复现安装）。SQLite WAL + 内容寻址对象目录不变。
2. **工作区包以 TS 源码导出**（`exports: ./src/index.ts`），dev/test 用 tsx/vitest 直接加载；生产 server/cli 用 esbuild 打包工作区源码、外部化第三方依赖；web 用 Vite + tsconfig paths alias。
3. **ArtifactVersion 为模块级不可变快照**；`Artifact.acceptedVersionId` 指向最近一次接受产生的版本；恢复旧版本创建新版本并触发下游 stale。
4. **Demo 与 Live 物理分区**：`data/<mode>/` 各自 SQLite + objects；Demo 运行时使用只读/夹具策略，不调用真实模型；Live 失败不回退。
5. **CLI 通过同一命令 API 调用内核**（HTTP），保证 AC-17 一致；CLI 不平行业务逻辑。
6. **事件与状态同事务**：`storage.appendEvents` 与状态更新在同一 SQLite 事务；SSE 只推送已提交事件（轮询 tail + 心跳，P0 单进程足够）。
7. **配方 P0 以 deterministic 清洗配方为主路径**；llm_assisted 配方 DSL 与失效规则必须实现，执行器可复用模型网关（若时间不足，界面上禁用并注明范围，不得假装可用）。
8. **真实模型凭据**未知：Live 验收先完成离线契约测试，最终报告必须如实标注"等待 Live 验证"。

## 已知风险

- 六个并行工作流的接口偏差可能在集成时暴露；Lead 负责最终修正，contracts 由 Lead 独占修改。
- 前端体量大，需在 Phase 3-6 内完成核心路径（中心/计划/修复/差异/配方/恢复），装饰性打磨优先级最低。
- Windows 环境下文件编码：中文文件统一用 write/edit 工具写入 UTF-8，禁止用 PowerShell 文本改写（曾损坏 CSV）。
- 性能数字（点击 p95、动画帧、5000 事件恢复、1000 行清洗）尚未测量，不得在文档/演示中宣称已达标。

## 验证命令

```bash
pnpm install          # 安装（锁文件固定）
pnpm typecheck        # 全仓 TS 严格检查
pnpm test             # vitest 全部
pnpm build            # web + server + cli 生产构建
pnpm dev              # 开发：Fastify(4310) + Vite(5173, /api 代理)
pnpm seed:demo        # 播种 Demo 命名空间（不触碰 Live）
pnpm cli -- --help    # CLI
```
