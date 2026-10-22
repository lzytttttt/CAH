# 状态机与转换守卫

权威定义在 `packages/contracts/src/states.ts`（表 + 守卫函数），执行实现在 `packages/harness`。本文件解释语义与恢复策略，避免把视角状态、模块状态、运行状态混为一谈。

## 1. 四类状态必须区分

| 状态域 | 类型 | 说明 |
| - | - | - |
| RunState | 业务运行状态 | 由后端执行内核驱动，持久化并产生事件 |
| Module state | 中心交付物模块状态 | empty / draft / ready_for_review / accepted / stale / blocked |
| Recipe state | 配方注册状态 | candidate / validated / stale / disabled |
| ViewState | 纯视图状态 | elevation、选中、聚焦、展开、未提交输入；不属于业务事件 |

**ViewState 与 RunState 独立**：进入/退出聚焦、切换层级、展开面板不会启动工具、不会提交草稿、不会改变任务状态。视角状态可以保存在本地视图存储，但正式成果、Run、配方不能只存在 localStorage。

## 2. RunState 状态转换表

| 当前状态 | 事件与守卫 | 下一状态 | 必须持久化的结果 |
| - | - | - | - |
| CREATED | 计划命令合法 | PLANNING | 输入基线、预算、模型与策略版本 |
| PLANNING | 发现需用户处理的阻塞 | AWAITING_INPUT | 计划草稿、Blocker、解除条件 |
| PLANNING | 计划通过校验 | READY | 可提交的计划版本 + ContextSnapshot |
| READY | 用户提交的计划版本仍有效 | RUNNING | 提交者、执行上下文、检查点 |
| RUNNING | 收到完整工具调用 | RUNNING 或 AWAITING_INPUT | 调用记录、权限决定、结果或审批请求 |
| RUNNING | 发现业务阻塞 | AWAITING_INPUT | 已完成步骤、受影响步骤、局部修复请求 |
| AWAITING_INPUT | 输入补齐且再次校验通过 | READY 或 RUNNING | 回到预览或执行的明确 returnState |
| RUNNING | 已产生候选成果 | VALIDATING | 草稿、引用、调用消耗 |
| VALIDATING | 校验失败且仍有修复额度 | RUNNING | 具体失败项与修复范围 |
| VALIDATING | 校验通过 | AWAITING_REVIEW | PatchProposal、ValidationReport |
| AWAITING_REVIEW | 用户接受且基线未冲突 | COMMITTING | 提交意图与版本守卫 |
| COMMITTING | 数据库事务提交成功 | COMPLETED | 不可变成果版本与完成事件 |
| 活动状态 | 用户暂停 | PAUSING → PAUSED | 已完成副作用、待执行步骤、可恢复边界 |
| PAUSED | 用户继续且输入仍有效 | 保存的 returnState | 新尝试编号、必要的重新验证 |
| 非终态 | 用户取消且提交事务尚未完成 | CANCELLING → CANCELLED | 停止原因、保留草稿、副作用状态 |
| 调用中或提交前 | 进程意外终止 | INTERRUPTED | 最近检查点、结果未知的调用清单 |
| 任意非终态 | 不可恢复错误 | FAILED | 结构化错误、可重试范围、保留成果 |
| COMMITTING | 基线冲突/事务失败 | AWAITING_REVIEW 或 FAILED | 双方内容保留、明确冲突信息 |

### 守卫与不变量

- 终态：`COMPLETED`、`CANCELLED`、`FAILED` 不接受新的推进；`INTERRUPTED` 可从检查点恢复（新 attempt），不自动重放未知副作用。
- 非法转换（例如 `COMPLETED → RUNNING`、`PLANNING → RUNNING`）必须被拒绝并返回 `state_not_allowed`，前端按钮同时禁用并给出原因（MC-12）。
- 暂停不是暂停模型神经网络计算：它表示停止调度新步骤，在安全边界（工具完成、可取消请求中止或超时）进入 PAUSED，并提示继续可能产生重复费用。
- 提交与取消命令串行处理；已提交事务不能被取消按钮回溯抹除，撤回成果须通过新版本恢复完成。
- 每个任务最多一个"写成果"的活动 Run；全工作区最多 2 个活动 Run，其余排队并显示位置。
- 每次状态变更与对应业务事件在同一 SQLite 事务提交；只有已提交事件会被 SSE 推送。

## 3. Task / Artifact 状态

- Task：`active` / `archived`；修订号 `revision` 用作写命令的乐观并发守卫。
- Artifact：`draft` / `active` / `archived`；`acceptedVersionId` 指向最近一次已接受变更产生的版本（各模块另有自己的 `acceptedVersionId`）。
- 模块（六态）：

| 当前 | 允许进入 | 说明 |
| - | - | - |
| empty | draft, blocked | 尚无草稿 |
| draft | ready_for_review, empty, stale, blocked | 草稿可重新生成或校验 |
| ready_for_review | accepted, draft, stale, blocked | 等待用户接受；接受需基线未冲突 |
| accepted | stale, blocked | 已接受版本不可变；上游/资料变化进入 stale |
| stale | draft, empty, blocked | 重新生成或重新验证后离开 stale |
| blocked | empty, draft, ready_for_review, accepted, stale | 解除后恢复到先前状态（blockedFrom） |

Run 失败不会自动把已有 accepted 模块改成 failed；界面同时显示"保留的成果版本"与"本次运行状态"。

## 4. Blocker 状态

`open → resolved → cleared`，或 `open → cancelled`。

- Blocker 必须说明受阻原因与解除判据，并声明受影响字段/步骤。
- 类型：信息缺失、约束冲突、验证失败、无进展、服务故障、权限不足。
- 技术故障（401/429/网络/模型不存在）只能用技术恢复入口表达，不得伪装成业务选择题。
- 解除后只使依赖变化的下游步骤失效，已完成且输入未变的步骤复用。

## 5. Recipe 状态

`candidate → validated → stale ⇄ validated`，任意状态可 `→ disabled`；`disabled → validated` 需重新测试。

- 只有 `validated` 可直接运行。
- 工具实现、prompt、模型、关键约束、字段语义、解析器或验证规则变化后进入 `stale`，必须重新测试。
- 失效或权限范围扩大的原有授权需重新处理；折叠不能折叠权限边界。

## 6. 高台综合成果（Prospect）

`proposed → missing_inputs ⇄ ready → generating → review → accepted`；来源变更后 `→ stale`。

- 依赖满足只代表允许生成，不代表成果已完成；生成/验证/审阅/接受沿用标准 Run。
- 未接受的草稿不能默认解锁正式综合；上游版本变更使综合失效。

## 7. 计划预览局部状态（机制 A）

`idle → planning → peeking → resolving → ready → executing → review → failed`。

- `peeking` 对应"业务计划已产生"，不代表暴露模型隐藏思维链。
- 计划风险数量必须与真实输入一致；零风险时显示零个风险卡；硬约束冲突未处理时不能提交。
- 提交按钮绑定 `planVersion + contextSnapshotId`；输入变化后按钮失效并提示重新检查。

## 8. 恢复矩阵（与设计文档 19.2 对应）

| 故障 | 运行语义 | 用户可见结果 |
| - | - | - |
| 浏览器刷新或 SSE 断开 | 后端继续运行 | 重连后读取快照并续传，不重复发起 Run |
| 用户关闭页面 | 默认后端继续，受预算限制 | 再次打开显示实际进度；可设置"离开时暂停" |
| 后端正常退出 | 停止新调度，记录可恢复边界 | 重启后显示暂停或中断原因 |
| 后端被强制终止 | 租约失效，标记 INTERRUPTED | 展示最后检查点和需要核对的调用 |
| 模型流中断 | 部分草稿保留，当前尝试未完成 | 可重新尝试，提示可能产生重复费用 |
| 工具超时且结果不明 | 不自动重放不安全副作用 | 提供查询或人工核对入口 |
| 提交版本冲突 | 事务拒绝，双方数据保留 | 查看差异、重新生成或人工合并 |
| 磁盘空间不足 | 停止新增写操作，不宣布提交成功 | 保留可读取版本并说明恢复条件 |
| 输入文件被更新或删除 | 引用版本仍保留或明确标记不可用 | 受影响成果与配方标记过期或缺失 |

"继续"表示从完整检查点重新组织后续工作，不是从模型断流的某个 token 精确继续；若模型供应商不支持请求恢复，重新调用必须显示新的 attempt 与新的消耗。
