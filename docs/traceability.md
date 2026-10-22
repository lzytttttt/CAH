# 需求追踪矩阵（需求 → 实现 → 验证）

本文件把设计文档的硬约束与验收项映射到代码位置和验证方式。状态列在开发过程中更新；只有真正执行过的验证才写"通过"。

- 设计文档：`Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划.md`
- 约定：文件路径可点击；"验证"指测试文件或可复现命令，不接受"看起来正确"。

## 1. 硬约束（MC-01 ~ MC-12）

| 编号 | 约束摘要 | 实现位置 | 验证 |
| - | - | - | - |
| MC-01 | UI 不得用定时器/动画回调/随机数决定成功失败阻塞解锁 | apps/web（无业务定时器）、packages/harness（真实状态驱动） | web 纯逻辑测试 + harness 状态机测试 + 代码审查 |
| MC-02 | 模型输出/工具结果/校验结果/用户接受/正式提交是不同事件 | packages/contracts/src/events.ts（事件类别）、packages/harness 执行循环 | contracts 事件测试 + harness 事件序列测试 |
| MC-03 | 正式模式禁止固定 65% 受阻、固定风险数、固定秒级生成 | packages/harness/src/plan（真实风险分析）、apps/server（无脚本化 Live） | harness 计划风险测试（零冲突→零风险） |
| MC-04 | Mock/Live 显式标识、物理分区、Live 失败不回退 Mock | apps/server（data/demo 与 data/live 分区）、apps/web 模式标识 | storage 分区测试 + server 集成测试 |
| MC-05 | 改变成果的动作必须产生持久化事件 | packages/harness + packages/storage/appendEvents | storage 事件原子性测试 + harness 事件测试 |
| MC-06 | 计划/工具调用/配方/成果修改必须经后端 Schema 与权限校验 | packages/contracts（Zod）、packages/tools（严格参数）、server 校验 | contracts/tools 测试 |
| MC-07 | 不得用模型自评分/发光/字数作为质量通过唯一证据 | packages/harness/src/validator（确定性 L0-L4） | validator 测试（失败必须阻止提交） |
| MC-08 | 调用中的输出先进入草稿，不覆盖已接受成果 | PatchProposal 草稿隔离；artifact.accept 事务 | storage commitAcceptance 测试 + harness accept 测试 |
| MC-09 | 展示计划/证据/理由摘要/工具轨迹，不伪造思维链 | contracts 事件（model.delta_batch 仅输出）、projection | contracts 事件 payload 测试 |
| MC-10 | 同一任务只有一个中心交付物清单；支线声明目标模块与回收条件 | contracts Task/Artifact 1:1、server 快照投影 | server 投影集成测试 |
| MC-11 | 执行依赖必须无环，"回环"只表示结果回收 | contracts `findPlanCycle`、模块依赖校验 | contracts plan 环检测测试 + harness |
| MC-12 | 所有可见操作有明确结果/状态/禁用原因，无装饰按钮 | apps/web 组件 + aria/disabled 原因 | web 测试 + 键盘/无障碍验收 |

## 2. 验收项（AC-01 ~ AC-20）

| 编号 | 场景 | 实现位置（计划/实际） | 验证 | 状态 |
| - | - | - | - | - |
| AC-01 | 新用户配置真实 LLM，凭据不回传前端，能力逐项测试 | apps/server provider routes + packages/providers/capabilities + apps/web settings | server 集成 + providers 契约测试；Live 需真实凭据 | 待 Live 验证 |
| AC-02 | 任意新任务可自定义目标与模块 | server POST /api/tasks + web task create | server 集成测试 | 待实现集成 |
| AC-03 | 真实工具闭环（调用 ID/入参/结果/回填/草稿） | harness executor + tools + storage tool_invocations | harness 测试 + e2e(fake provider) | 待集成 |
| AC-04 | 流式工具参数未完成/非法 JSON 不执行 | providers 流解析 + tools.validateArguments + harness | providers + tools + harness 测试 | 待集成 |
| AC-05 | 计划风险数量与输入一致；硬冲突未处理不能提交 | harness 计划/风险 + server commit 守卫 | harness 测试 + server 测试 | 待集成 |
| AC-06 | 局部恢复只重跑受影响步骤 | harness blocker/repair + checkpoint | harness 测试 | 待集成 |
| AC-07 | 取消/暂停后不再调度新步骤，安全边界真实 | harness pause/cancel | harness 测试 | 待集成 |
| AC-08 | 断线续传无丢失，重复 commandId 返回同一结果 | server SSE + storage command_results | server 集成测试 | 待实现 |
| AC-09 | 崩溃恢复四个故障点 | storage leases/checkpoints + harness recoverInterrupted | storage + harness 测试 | 待集成 |
| AC-10 | 版本冲突不覆盖，双方保留 | storage commitAcceptance + harness accept | storage/harness 测试 | 待集成 |
| AC-11 | 配方原始/新有效/非法三类输入符合预期 | packages/recipes + server recipe routes | recipes 测试 + 集成 | 待实现 |
| AC-12 | deterministic 配方 LLM 请求数为零 | recipes runtime 账本 + harness 事件 | recipes 测试 | 待实现 |
| AC-13 | 高台错误输入不解锁；满足后仍经生成验证接受 | server prospect 投影 + harness run | server 投影测试 | 待实现 |
| AC-14 | 失效传播（来源/约束/上游版本变化） | storage stale 标记 + server 投影 | 集成测试 | 待实现 |
| AC-15 | 权限与注入（来源越权指令不改变权限，不泄露凭据） | tools 权限 + providers url policy + server | tools/providers/server 测试 | 待集成 |
| AC-16 | 导出再导入内容/哈希一致；无来源明确提示；配方不自动执行 | server export/import | server 集成测试 | 待实现 |
| AC-17 | CLI 与 UI 一致，CLI 不依赖浏览器/DOM | apps/cli 调同一 API | CLI 测试 + 手工命令 | 待实现 |
| AC-18 | 禁止静默模拟：Live 失败明确失败/等待恢复 | server + web（不做 Mock 回退） | server/web 测试 | 待实现 |
| AC-19 | 无障碍：仅键盘、减少动效、200% 缩放可完成主任务 | apps/web | web 测试 + 人工走查 | 待实现 |
| AC-20 | 整体交付：干净环境安装启动，文档/数据/测试/源码/模型报告齐备 | 根 README、docs、Docker、验收报告 | 按 README 在干净目录复现 | 待实现 |

## 3. P0 范围（设计文档 1.2）

| 级别 | 能力 | 对应实现 | 状态 |
| - | - | - | - |
| P0 真实执行 | OpenAI-compatible 适配器（流式/tool calling/回填/循环终止） | packages/providers + packages/harness | 开发中 |
| P0 任务与成果 | 任意任务、模块化交付物、草稿、差异、版本恢复、导出 | server + storage + web | 开发中 |
| P0 工具与上下文 | 本地资料导入、检索、结构化转换、证据引用、受控草稿修改 | tools + storage + harness | 开发中 |
| P0 运行控制 | 暂停/继续/取消/预算/超时/故障分类/检查点/事件回放 | harness + server + storage | 开发中 |
| P0 空间体验 | 三层视图、中心锚点、A-D 四机制、高台依赖提示、快捷配方 | apps/web | 开发中 |
| P0 可交付工程 | 源码、可复现安装、容器启动、演示数据、测试、文档 | 全仓 + Docker + docs | 开发中 |
| P1 接入扩展 | Anthropic/Responses 适配器、MCP 只读 | 未实现 | 明确禁用并记录 |
| P2 团队能力 | 多用户/权限/云端调度/多 Agent/配方市场 | 不属于首版 | 明确禁用并记录 |

## 4. 事实性声明纪律

- 未配置真实凭据时，Live 验收标记为"未完成/待验证"，不能用 Mock 补记通过。
- 性能数字（点击反馈 p95、动画帧、恢复耗时、清洗耗时）必须在记录环境后实测，未测量的不得写成"已通过"。
- 所有演示数据标记为合成；商业结论标记为待验证假设。
