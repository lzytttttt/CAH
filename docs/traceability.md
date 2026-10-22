# 需求追踪矩阵（最终）

设计文档：`Cognitive Atrium 空间化 LLM Harness 完整设计与实施计划.md`（内部文档，不随本仓库分发）。只有真实执行过的验证才标记为“通过/部分”；Live 与浏览器自动化未执行的项目如实标记。

## 1. 硬约束（MC-01 ~ MC-12）

| 编号 | 约束 | 实现位置 | 验证 | 结果 |
| - | - | - | - | - |
| MC-01 | UI 不得用定时器/动画/随机数决定业务结果 | apps/web（无业务定时器）、packages/harness（真实状态机） | web 纯逻辑测试 + harness 状态机测试 + 代码审查 | ✅ |
| MC-02 | 模型输出/工具结果/校验/用户接受/正式提交是不同事件 | contracts/events.ts（47 种逐类型 payload）、harness 执行循环 | contracts 事件测试 + harness 事件序列 + run-flow 集成 | ✅ |
| MC-03 | 正式模式禁止固定风险/受阻/秒级生成 | harness 计划与确定性风险规则；Demo 仅在 Demo 命名空间 | harness 零冲突→零风险/真实冲突→blocking 测试 | ✅ |
| MC-04 | Mock/Live 显式标识、物理分区、失败不回退 | data/live 与 data/demo 独立 DB+objects；Demo 只读；web 常驻模式标识 | storage 分区测试 + api/生产冒烟（Demo 切换） | ✅ |
| MC-05 | 改变成果的动作产生持久化事件 | harness 事件事务 + storage.appendEvents | storage 事件原子性 + harness 测试 | ✅ |
| MC-06 | 计划/工具/配方/成果修改经 Schema 与权限校验 | contracts Zod、tools 严格参数、server 校验 | contracts/tools 测试 + 集成 | ✅ |
| MC-07 | 不得用模型自评分/发光/字数作为通过证据 | harness 确定性 L0–L4 验证器 | validator 测试（失败阻止提交，L4 人工） | ✅ |
| MC-08 | 流式输出先入草稿，不覆盖已接受成果 | PatchProposal 隔离 + accept 事务 | storage commitAcceptance + harness/artifacts 测试 | ✅ |
| MC-09 | 展示计划/证据/理由摘要/工具轨迹，不伪造思维链 | 事件只在 model.delta_batch 携带可见输出；投影/UI 展示证据与轨迹 | contracts 事件测试 + UI 面板 | ✅ |
| MC-10 | 一个任务一个中心交付物清单；支线声明目标模块 | Task↔Artifact 1:1、模块依赖、投影 | server 投影/快照测试 | ✅ |
| MC-11 | 执行依赖无环；“回环”只表示结果回收 | contracts `findPlanCycle` + 模块依赖校验 + 计划校验 | contracts 环检测 + api 环拒绝测试 | ✅ |
| MC-12 | 所有可见操作有结果/状态/禁用原因，无装饰按钮 | web 组件 + disabled 原因 + aria | web 测试 + SSR 冒烟 + 代码审查 | ✅ |

## 2. 验收项（AC-01 ~ AC-20）

| 编号 | 场景 | 实现 | 验证 | 结果 |
| - | - | - | - | - |
| AC-01 | 真实 LLM 配置/凭据不回传/逐项能力 | server provider routes、providers、web 设置 | 本地假服务全链路 + 掩码验证；真实凭据缺失 | ⚠️ 等待 Live 验证 |
| AC-02 | 任意新任务/自定义模块 | POST /api/tasks、web 任务创建 | `api.test`（自定义/模板/环拒绝） | ✅ |
| AC-03 | 真实工具闭环 | harness executor + tools + storage | `run-flow` + `live-adapter` | ✅（本地适配器） |
| AC-04 | 流式工具参数非法不执行 | providers SSE + tools.validateArguments + harness | 三方测试 + 集成 | ✅ |
| AC-05 | 计划风险真实；硬冲突未处理不能提交 | harness 计划/风险 + Demo 夹具 blocker | harness 测试 + Demo 快照断言 | ✅ |
| AC-06 | 局部恢复只重跑受影响步骤 | harness checkpoint/blocker/repair | harness 测试 | ✅ |
| AC-07 | 取消/暂停后不调度，无偷偷接受 | harness 控制 | harness + run-flow 取消 | ✅ |
| AC-08 | 断线续传/重复 commandId | server SSE + storage 幂等 | `sse.test` + 幂等测试 | ✅ |
| AC-09 | 崩溃恢复四故障点 | storage 租约/检查点 + harness recovery | 单测通过；无真实 kill/restart E2E | ⚠️ 部分 |
| AC-10 | 版本冲突不覆盖 | storage.commitAcceptance + harness.accept | `artifacts.test` + harness | ✅ |
| AC-11 | 配方三类输入 | recipes runtime/validate + server routes | recipes 55 + `recipes.test` | ✅ |
| AC-12 | deterministic 零 LLM | recipes 账本 + 权限断言 | recipes + `recipes.test`（provider calls=0） | ✅ |
| AC-13 | 高台错误输入不解锁/满足后仍走标准 Run | 投影 prospect + harness run | Demo 快照 missing_inputs + 标准接受流程 | ✅ |
| AC-14 | 失效传播 stale | storage/harness/import 标记 | 恢复/导入测试 | ✅ |
| AC-15 | 权限与注入 | tools scopes/证据校验、providers URL、凭据隔离 | tools/providers/server 测试 | ✅ |
| AC-16 | 导出再导入一致 | server export/import + ZIP 安全 | `artifacts.test` + zip 测试 | ✅ |
| AC-17 | CLI 与 UI 一致、CLI 无 DOM | CLI 走同一命令 API | CLI 97 + 真实服务冒烟 | ✅ |
| AC-18 | 禁止静默模拟 | Demo/Live 分区、只读 Demo、明确错误码 | server 测试 + 生产冒烟 | ✅ |
| AC-19 | 无障碍/减少动效/200% 缩放 | web 键盘/aria/reduced-motion/响应式 | Playwright 浏览器 E2E（35 checks：Tab 遍历、键盘切层、多视口、减少动效、零控制台错误） | ✅（未跑 axe 全量审计） |
| AC-20 | 整体交付 | 全仓 + docs + Docker + 验收报告 | `pnpm install/typecheck/test/build` + 生产冒烟 | ✅（缺口见验收报告） |

## 3. P0 能力清单

| 能力 | 实现 | 状态 |
| - | - | - |
| OpenAI-compatible 适配器（流式/tool calling/回填/终止） | packages/providers + harness | ✅（真实服务待 Live） |
| 任意任务/模块化交付物/草稿/差异/版本恢复/导出 | server + storage + web + cli | ✅ |
| 本地资料导入/检索/结构化转换/证据引用/受控草稿 | tools + storage + harness | ✅ |
| 暂停/继续/取消/预算/超时/故障分类/检查点/事件回放 | harness + server + storage + web/cli | ✅（真实 kill 故障注入未执行） |
| 三层视图/中心锚点/机制 A–D/高台依赖/快捷配方 | apps/web | ✅（浏览器级走查未执行） |
| 源码/可复现安装/容器/演示数据/测试/文档 | 全仓 | ✅ |

## 4. 事实纪律

- 未配置真实凭据 → Live 验收标记“等待 Live 验证”，未用 Mock 补记通过。
- 性能仅报告实际测量项（1000 行清洗 5.4ms、5000 事件恢复 33.9ms）；点击 p95/动画帧/30 分钟内存未测量，不宣称达标。
- 演示数据全部为合成；商业结论标记为待验证假设。
