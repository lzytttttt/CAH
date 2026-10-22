# 验收报告（P0）

- 方案依据：《Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划》（基线 2026-10-22）
- 代码基线：本仓库当前提交；`pnpm-lock.yaml` 锁定依赖
- 验收执行日期：2026-10-22
- 执行环境：Windows 11 x64、Node.js v22.23.2、pnpm 11.25.0、SQLite 3.51.3（Node 内置）、浏览器未用于自动化测量
- 原则：只记录真实执行过的验证；未配置真实供应商凭据的 Live 项标记“等待 Live 验证”；未测量的性能不宣称通过。

## 1. 复现命令

```bash
pnpm install
pnpm typecheck                 # 全仓 strict 类型检查（0 error）
pnpm test                      # 契约/单元/集成测试（vitest，69 files / 706 tests）
pnpm build                     # 前端产物 + server/cli 生产包
pnpm exec tsx scripts/bench.ts # 本地性能测量（见 §5）
pnpm seed:demo && pnpm start   # 生产模式启动（后端托管构建后的前端）
```

生产冒烟（本次实际执行，临时数据目录 + `pnpm build` 产物）：
`GET /api/health` → `ok`；`/api/session` → 本地会话 + CSRF；`/api/workspace`；切换到 Demo（API）→ Demo 任务快照 `snapshotSeq=57`（4 模块、7 份来源、10 个空间节点、1 个阻塞、已接受/待审阅/等待输入/失败四种运行状态、1 个 validated 配方）；`/` 返回构建后的前端（200）；`node apps/cli/dist/cli.mjs session/task list --json` 对同一服务返回一致状态。

## 2. 测试结果（本次执行）

| 范围 | 测试文件 | 用例数 | 结果 | 覆盖重点 |
| - | - | - | - | - |
| packages/contracts | 4 | 26 | ✅ | 实体/事件（逐类型 payload）/状态机/补丁应用/diff/环检测 |
| packages/providers | 5 | 130 | ✅ | 模拟服务上的适配器行为矩阵（流式/工具调用/429/截断/usage 缺失/超时/URL 策略/凭据掩码） |
| packages/tools | 10 | 156 | ✅ | 8 个工具、RFC4180 CSV/JSON 引擎、11 个确定性算子、权限/超时/大小限制、真实证据 span |
| packages/storage | 8 | 71 | ✅ | 迁移、事件 seq 并发唯一、事务/回滚、commitAcceptance、租约/fencing、备份、对象存储 |
| packages/harness | 8 | 55 | ✅ | 计划/执行/校验/修复/接受/控制/恢复、预算、上下文分层、确定性验证器（fake 端口） |
| packages/recipes | 6 | 55 | ✅ | 真实夹具 24→22 / 8→7、非法输入拒绝、零 LLM、指纹失效、测试门禁、轨迹提取 |
| apps/cli | 9 | 97 | ✅ | 全命令 HTTP 语义、退出码、SSE、错误映射（本地 fake server） |
| apps/web | 12 | 99 | ✅ | 布局/聚合 3-12-16 上限、SSE 去重/缺口、快照合并、ViewState、API 客户端、SSR 渲染冒烟 |
| apps/server + tests/integration | 9 | 17 | ✅ | ZIP 安全、HTTP API、run 全链路、版本冲突/恢复/拒绝、导出再导入、真实适配器路径、SSE 续传、Demo 夹具、配方注册→验证→运行 |
| **合计** | **69** | **706** | **✅ 全部通过** | |

`pnpm typecheck`：0 错误。`pnpm build`：web(dist) + server(dist/server.mjs) + cli(dist/cli.mjs) 成功。

关键集成证据（`tests/integration`，全部使用真实 storage/tools/harness/server 与本地假服务，无外网）：

1. **run-flow**：plan → READY → commit → 模型原生 `artifact.propose_patch` tool call → L0–L3 校验 → AWAITING_REVIEW → accept → 新版本 + COMPLETED；取消运行不改变已接受版本。
2. **live-adapter**：`POST /api/provider-profiles` 保存指向本地 OpenAI 兼容假服务的连接 → 能力探测 auth_and_text=verified → **真实 `@ca/providers` 适配器经 HTTP/SSE** 完成规划、工具调用、候选提取、校验与接受；响应不含 `credentialRef` 或密钥。
3. **artifacts**：stale `expectedRevision` → 409 且已接受版本仍为 v2（双方保留）；拒绝补丁 → 运行取消、成果不清空；恢复旧版本 → 内容相同的新版本并成为 current；任务包导出→导入内容哈希一致、导入成果标记 stale；版本列表/内容接口正确。
4. **recipes**：服务端注册 candidate → 对原始/新数据/非法三类输入实际执行验证 → validated → 绑定新 CSV 运行（**llmCalls=0**）→ 7 行输出草稿 → 正常审阅接受；脚本化 provider 调用次数为 0。
5. **sse**：未认证 401；帧 `id/event/data` 与事件 seq/type 一致；Last-Event-ID 续传只收到新事件。
6. **api**：会话/Origin 守卫、模板展开、模块依赖环拒绝、导入格式限制、commandId 幂等、Demo 只读与新运行 409、Demo 夹具状态完整。

## 3. 验收矩阵（AC-01 ~ AC-20）

| 编号 | 结果 | 证据 / 说明 |
| - | - | - |
| AC-01 配置真实 LLM、凭据不回传、能力逐项 | ⚠️ 等待 Live 验证 | 连接保存/掩码/能力探测/错误映射 + 本地假服务全链路通过；**无真实供应商凭据实测**，不宣称 Live 通过 |
| AC-02 任意新任务与自定义模块 | ✅ | `api.test`（自定义/模板任务、快照投影）；UI 任务创建 |
| AC-03 真实工具闭环 | ✅（本地适配器） | `run-flow`/`live-adapter`：tool_call_complete → 工具 → 结果回填 → 草稿；tool.* 事件成对记录 |
| AC-04 流式工具参数非法不执行 | ✅ | providers SSE 分片组装 + tools 严格校验 + harness 门禁测试与集成路径 |
| AC-05 计划风险与输入一致/硬冲突阻止提交 | ✅ | harness 风险规则测试；Demo 夹具展示 DEPLOY-1/AI-1 冲突 blocking + AWAITING_INPUT；冲突决策需用户补齐 |
| AC-06 局部恢复只重跑受影响步骤 | ✅ | harness checkpoint/blocker/repair 测试 |
| AC-07 取消/暂停后不调度、无偷偷接受 | ✅ | harness 控制测试 + `run-flow` 取消测试 |
| AC-08 断线续传与 commandId 幂等 | ✅ | `sse.test` + 重复 commandId duplicate=true 测试 |
| AC-09 崩溃恢复四故障点 | ⚠️ 部分 | storage 租约/检查点 + harness 恢复（INTERRUPTED、未知副作用不重放）单测通过；**未做真实 kill/restart 故障注入 E2E** |
| AC-10 版本冲突不覆盖、双方保留 | ✅ | `artifacts.test` 409 后 v2 仍 current；harness 事务回滚测试 |
| AC-11 配方的原始/新有效/非法输入 | ✅ | recipes 单测 + `recipes.test` 服务端注册/验证/运行全链路 |
| AC-12 deterministic 零 LLM 请求 | ✅ | recipes 测试断言 + 服务端测试断言 provider 调用为 0 |
| AC-13 高台错误输入不解锁/满足后仍经生成验证接受 | ✅ | 投影按依赖接受状态计算 prospect；Demo 夹具 value-matrix=missing_inputs；接受流程沿用标准 Run |
| AC-14 失效传播 → stale | ✅ | 恢复/上游变更使下游 stale（storage/harness 测试）；无来源导入包标记 stale |
| AC-15 权限与注入 | ✅ | scope/严格参数/证据校验/URL 策略/凭据不回传；来源中的指令不改变权限 |
| AC-16 导出再导入 | ✅ | `artifacts.test` 任务包 round-trip、哈希一致、配方 disabled、sourcesNeedRebinding |
| AC-17 CLI 与 UI 一致、CLI 无 DOM | ✅ | 同一命令 API；CLI 97 测试 + 真实 server 冒烟 |
| AC-18 禁止静默模拟 | ✅ | Demo 物理分区、只读运行、Live 失败明确错误码、无 Mock 回退路径 |
| AC-19 无障碍：键盘/减少动效/200% | ⚠️ 部分 | 键盘导航、可见层切换按钮、文字状态、prefers-reduced-motion、响应式退化已实现并有纯逻辑/SSR 冒烟；**未执行浏览器级自动化走查** |
| AC-20 整体交付 | ✅ / ⚠️ | 源码/锁文件/构建/容器/场景/测试/文档/CLI/验收报告齐备；干净数据目录启动验证通过；Live 实测与浏览器自动化走查为明确缺口 |

## 4. 真实执行声明

- 当前环境**未配置真实模型供应商凭据**。所有“真实执行”指：真实 HTTP/SSE 适配器路径、真实内核/工具/存储/事务、真实事件与版本，但模型端点是本地 OpenAI 兼容假服务。该证据不能替代真实供应商兼容性结论。
- 需在有凭据环境按 `docs/provider-integration.md` 模板补充：服务/模型、测试时间、逐项能力、请求数、成本（未知写 null）、已知差异。
- 未使用 Mock 补记任何 Live 通过项；Demo 与 Live 物理隔离且 Demo 明确只读。

## 5. 性能测量（实际执行）

命令：`pnpm exec tsx scripts/bench.ts`；环境：win32 x64、Node v22.23.2（开发机，非统一参考硬件）。

| 指标 | 目标 | 实测 | 结果 |
| - | - | - | - |
| 确定性清洗配方 1000 行 CSV（解析+归一化+去重+排序+必填） | < 2000 ms | **5.4 ms** | ✅ |
| 5,000 条事件后恢复快照投影 | < 2000 ms | **33.9 ms**（5,000 事件 append 144.6 ms） | ✅ |
| 点击至本地可见反馈 p95 | < 100 ms | 未测量（需浏览器环境） | 未验证 |
| 空间动画 60fps / 95% 帧 < 32ms | 目标 | 未测量 | 未验证 |
| 流式 UI 更新合批 ≤ ~10 次/秒 | 目标 | 实现为服务端 delta 合批 + 120ms 事件轮询；未做帧级测量 | 未验证 |
| 30 分钟长任务内存稳定 | 目标 | 未测量 | 未验证 |

## 6. 结论

P0 核心闭环已按设计实现并在本地适配器路径完成自动化验证：真实模型接口 → 计划预览 → 提交 → 工具执行 → 确定性校验 → 差异审阅 → 版本接受 → 恢复/导出/配方复用；失败、取消、冲突均不伪造成功；空间 UI 只渲染后端投影与事件；Demo 与 Live 物理隔离。

剩余缺口（已在 `docs/known-limitations.md` 声明，不冒充通过）：**真实供应商 Live 实测**、**浏览器级无障碍/性能自动化走查**、**真实进程 kill/restart 故障注入**。
