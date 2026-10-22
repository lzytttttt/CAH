# 验收报告（P0）

- 方案依据：《Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划》（基线 2026-10-22）
- 代码基线：本仓库当前提交（见 `git log`）；`pnpm-lock.yaml` 锁定依赖
- 验收执行日期：2026-10-22
- 执行环境：Windows 11 x64、Node.js v22.23.2、pnpm 11.25.0、16 逻辑核（性能数据见 §4）
- 原则：只记录真实执行过的验证；未配置真实凭据的 Live 项标记“等待 Live 验证”；未测量的性能不宣称通过。

## 1. 复现命令

```bash
pnpm install
pnpm typecheck                 # 全仓 strict 类型检查
pnpm test                      # 契约/单元/集成测试（vitest）
pnpm build                     # 前端产物 + server/cli 生产包
pnpm exec tsx scripts/bench.ts # 本地性能测量（见 §4）
pnpm seed:demo && pnpm start   # 生产模式启动（后端托管前端）
```

## 2. 测试结果（本次执行）

| 范围 | 测试文件 | 用例数 | 结果 | 说明 |
| - | - | - | - | - |
| packages/contracts | 4 | 26 | ✅ | 实体/事件/状态机/补丁应用/diff/环检测 |
| packages/providers | 5 | 130 | ✅ | 模拟服务上的适配器行为矩阵（流式/tool calling/错误/超时/usage 缺失） |
| packages/tools | 10 | 156 | ✅ | 8 个工具、CSV/JSON 引擎、11 个确定性算子、权限/超时/大小限制 |
| packages/storage | 8 | 71 | ✅ | 迁移、事件 seq 并发、事务/回滚、commitAcceptance、租约、备份、对象存储 |
| packages/harness | 8 | 55 | ✅ | 状态机、计划/执行/校验/修复/接受/控制/恢复（fake 端口，确定性） |
| packages/recipes | 5 | 43 | ✅ | 24→22 / 8→7 真实夹具、非法输入拒绝、指纹、测试门禁、提取 |
| apps/cli | 9 | 97 | ✅ | 全命令 HTTP 语义、退出码、SSE、错误映射（本地 fake server） |
| apps/web | 11 | 95 | ✅ | 布局/聚合上限/SSE/快照/ViewState/API 客户端/复核门禁（DOM-free 纯逻辑） |
| apps/server + tests/integration | 9 | 16 | ✅ | ZIP、HTTP API、任务/资料/导出、run 全链路、版本冲突/恢复/拒绝、导出再导入、**真实适配器路径**、SSE 续传 |

集成测试证据（`tests/integration`）：

1. **run-flow**：plan → READY → commit → 模型原生 tool call（`artifact.propose_patch`）→ 校验 L0-L3 通过（L4 待人工）→ AWAITING_REVIEW → accept → 新版本 + COMPLETED；取消不改变已接受版本。
2. **live-adapter**：通过 `POST /api/provider-profiles` 保存本地假 OpenAI 兼容服务连接 → 能力测试（auth_and_text=verified）→ **真实 `@ca/providers` 适配器**经 HTTP SSE 完成规划、工具调用、候选提取、校验、接受；凭据不回传前端（响应中无 credentialRef/密钥）。
3. **artifacts**：版本冲突 409（双方保留）、拒绝后取消且不清空成果、恢复旧版本产生内容相同的新版本并成为 current、任务包导出→导入内容哈希一致且导入成果标记 stale、配方不自动激活。
4. **sse**：未认证 401；`id/event/data` 帧与 `HarnessEvent.seq/type` 一致；`Last-Event-ID` 续传只收到新事件。
5. **api**：会话/Origin/CSRF 守卫、模板展开（1→4 模块）、模块依赖环拒绝、支持格式导入/不支持类型 415、commandId 幂等、Demo 模式切换与只读数据。

## 3. 验收矩阵（AC-01 ~ AC-20）

| 编号 | 结果 | 证据 / 说明 |
| - | - | - |
| AC-01 配置真实 LLM，凭据不回传，能力逐项状态 | ⚠️ 部分（等待 Live 验证） | 连接保存/掩码/能力探测/错误映射有测试与实际本地假服务端到端；**未使用真实供应商凭据完成实测**（环境无凭据），报告不宣称 Live 通过 |
| AC-02 任意新任务与自定义模块 | ✅ | `api.test`：自定义模块任务、快照投影、模板任务；UI 任务创建界面 |
| AC-03 真实工具闭环（调用 ID/入参/结果/回填/草稿） | ✅（本地适配器） | `run-flow` + `live-adapter`：原生 tool_call_complete → 工具执行 → 结果回填 → 候选草稿；事件记 tool.requested/authorized/started/succeeded |
| AC-04 流式工具参数未完成/非法 JSON 不执行 | ✅ | providers 流解析 + tools `validateArguments` 测试 + harness 测试；集成路径覆盖分片 SSE |
| AC-05 计划风险与输入一致；硬冲突未处理不能提交 | ✅ | harness 计划/风险规则测试（零冲突→零风险；DEPLOY-1/AI-1 冲突→blocking + AWAITING_INPUT）；server 侧冲突命令流程 |
| AC-06 局部恢复只重跑受影响步骤 | ✅ | harness checkpoint/blocker/repair 测试；已完成且输入未变的步骤复用 |
| AC-07 取消/暂停后不再调度，安全边界真实 | ✅ | harness 控制测试 + `run-flow` 取消测试；cancelled 不产生 COMPLETED，已接受版本不变 |
| AC-08 断线续传无丢失；重复 commandId 同一结果 | ✅ | `sse.test`（resume 只收新事件）；幂等测试（重复 commandId → duplicate=true） |
| AC-09 崩溃恢复四故障点 | ⚠️ 部分 | storage 租约/检查点与 harness 恢复（INTERRUPTED、未知副作用不重放）单测通过；**未做真实进程 kill/重启故障注入 E2E** |
| AC-10 版本冲突不覆盖，双方保留 | ✅ | `artifacts.test` stale expectedRevision 409 + 已接受版本仍为 v2；harness 版本冲突测试回滚 |
| AC-11 配方三类输入符合预期，记录步骤/输出哈希 | ✅ | recipes 测试（原始 24→22、新数据 8→7、非法输入拒绝）+ 服务端配方路由 |
| AC-12 deterministic 配方 LLM 请求数为零 | ✅ | recipes 测试断言 llmCalls=0 且不可调用模型；配方运行账本记录 |
| AC-13 高台错误输入不解锁；满足后仍经生成/验证/接受 | ✅ | 投影 prospect 状态由依赖接受状态计算；未接受草稿不解锁（server projection 测试覆盖） |
| AC-14 失效传播（来源/约束/上游变化 → stale） | ✅ | 恢复/上游变更触发 stale（storage+harness）；导入无来源包标记 stale（`artifacts.test`） |
| AC-15 权限与注入 | ✅ | tools scope/严格参数测试；证据伪造被拒；providers URL 策略；凭据不回传、日志不含密钥 |
| AC-16 导出再导入哈希一致；无来源提示；配方不自动执行 | ✅ | `artifacts.test` 任务包 round-trip + 导入配方 disabled + stale 提示 |
| AC-17 CLI 与 UI 一致，CLI 不依赖 DOM | ✅ | CLI 与 UI 只调用同一命令 API；CLI 97 测试 + 对真实 server 冒烟（session/task create/status/export/provider test） |
| AC-18 禁止静默模拟 | ✅ | Demo 物理分区且只读运行；Live 失败映射为明确错误（provider_error 等），无回退 Demo 代码路径 |
| AC-19 无障碍：键盘/减少动效/200% 缩放 | ⚠️ 部分 | 实现键盘导航、可见层切换按钮、文字状态、prefers-reduced-motion、响应式退化；**未执行浏览器级自动化走查（无 Playwright）**，仅纯逻辑测试 + 代码审查 |
| AC-20 整体交付 | ✅ / ⚠️ | 源码、锁文件、构建、容器文件、场景数据、测试、文档、CLI 齐备；干净安装与启动已多次验证；**Live 真实模型报告与浏览器自动化走查为未完成项** |

## 4. 性能测量（实际执行）

命令：`pnpm exec tsx scripts/bench.ts`；环境：win32 x64、Node v22.23.2（开发机，非统一参考硬件；仅代表本机实测）。

| 指标 | 目标 | 实测 | 结果 |
| - | - | - | - |
| 确定性清洗配方 1000 行 CSV | < 2000 ms | **5.4 ms**（解析+归一化+去重+排序+必填校验） | ✅ |
| 5,000 条事件后恢复当前任务（快照投影） | < 2000 ms | **33.9 ms**（append 5,000 事件耗时 144.6 ms） | ✅ |
| 点击至本地可见反馈 p95 | < 100 ms | 未测量（需浏览器环境与构建产物，未做自动化测量） | 未验证 |
| 空间动画 60fps / 95% 帧 < 32ms | 目标 | 未测量（同上） | 未验证 |
| 流式 UI 更新合批 ≤ ~10 次/秒 | 目标 | 实现为服务端 delta 合批（≤10/s）+ 事件 120ms 轮询；未做帧级测量 | 未验证 |
| 长任务 30 分钟内存稳定 | 目标 | 未测量 | 未验证 |

> 未测量的性能项不得表述为“已达标”。LLM 首字延迟/总生成时间/token/成本需真实服务实测后填写，本报告不提供伪造 SLA。

## 5. Live 验证缺口（必须如实声明）

1. 当前环境**未配置任何真实模型供应商凭据**；所有“真实执行”证据来自本地 OpenAI 兼容假服务（真实适配器 + 真实 HTTP/SSE + 真实内核/工具/存储），不等同于真实供应商兼容性结论。
2. 需要在有凭据的环境按 `docs/provider-integration.md` 的模板补充：服务/模型、测试时间、逐项能力状态、请求数、成本（未知写 null）、已知差异。
3. P1（Anthropic 原生、Responses、MCP、图片/PDF/DOCX、语义检索）未实现且界面/文档明确禁用；P2 团队能力不在首版。
4. 浏览器级 E2E（Playwright）未执行：未安装浏览器依赖；以 DOM-free 组件逻辑测试、HTTP 集成测试与人工代码审查替代，并在已知限制中列明。

## 6. 结论

- P0 核心闭环（真实模型接口 → 规划 → 提交 → 工具执行 → 校验 → 差异审阅 → 版本接受 → 恢复/导出）已在本地适配器路径上跑通，并有自动化测试证据。
- 失败/取消/冲突路径不伪造成功；Demo 与 Live 物理隔离；空间 UI 的业务状态全部来自后端投影与事件。
- 交付仍有两个明确缺口：**真实供应商 Live 实测**与**浏览器级无障碍/性能自动化走查**；二者在 `docs/known-limitations.md` 中标记，不冒充已通过。
