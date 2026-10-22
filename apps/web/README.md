# apps/web — 空间工作台（Cognitive Atrium P0）

React 18 + Vite + Tailwind + framer-motion + lucide + Zustand 的空间化 Web 工作台。
**所有业务状态只来自后端快照 / SSE 事件；本地只保存 ViewState（层级、选中、草稿、面板、过滤、减少动态效果）。**

## 启动

```bash
# 由仓库根目录启动（需要后端 apps/server）
pnpm dev:web              # Vite dev server: http://127.0.0.1:5173 ，/api 代理到 127.0.0.1:4310
pnpm build:web            # 产物 apps/web/dist

# 无后端时显式使用本地夹具预览（会持久显示“本地夹具（非真实执行）”标识）
# http://127.0.0.1:5173/?fixture=1
# 可选场景：review（默认，完整机制演示）、blocked、completed、empty
# http://127.0.0.1:5173/?fixture=1&scenario=blocked
```

**不会自动回退到夹具**：服务端不可达时显示真实连接错误与 traceId，绝不伪造 Live 业务成功（MC-04 / AC-18）。
`VITE_CA_FIXTURE=1` 等价于固定夹具预览；`VITE_CA_API_BASE` 可覆盖 API 根地址（默认同源/代理）。

## 路由（hash，无 router 依赖）

| Hash | 屏幕 |
| - | - |
| `#/tasks`（缺省） | 任务列表：选择、新建、导入任务包、Demo 重置、真实连接错误态 |
| `#/tasks/new` | 新建任务：标题/意图/交付物 + 内置四模块模板或自定义 1–8 模块 |
| `#/tasks/:id` | 空间工作台（五区 + 三层 + 机制 A–D + 面板） |
| `#/settings` | 连接配置（掩码凭据 + 能力矩阵）、工作区策略、模式切换、服务端信息 |

## 五个空间区域 / 三层

- **CentralHubAnchor（中心交付区）**：唯一交付物清单，1–8 模块每页 4 个；状态、版本、待接受变更、阻塞数、验收标准数；聚焦时缩为小型锚点 + 返回入口。
- **ConstraintCanopy（上方约束区）**：默认折叠摘要（目标 / 硬约束 / 依赖 / 预算 / 阶段），Z+1 展开；模块依赖与待决问题只读投影。
- **BranchLane（两侧执行支线）**：最多 3 条展开支线、12 个工作节点、16 条 SVG 可见连线；活动支线优先；超限/折叠节点按数量与 kind 聚合，不静默丢弃；节点动作按类型打开真实面板（处理 / 审阅 / 诊断 / 配方）。
- **EvidenceDepth（下方证据区）**：资料、SourceSpan、工具/执行事件、L0–L4 验证报告；内部滚动 + 增量渲染；Z-1 自动展开。
- **HighLedgeAttractor（右上综合预览）**：候选成果、所需输入满足情况、缺失项；未生成时不显示仿真正文。
- **IntentPill**：按选中模块的多行意图、附件/资料选择、将使用的资料、请求范围、planFirst、提交真实 `createRun`；草稿持久到本地视图。
- **RunControlBar（常驻）**：阶段、运行状态、暂停/继续/停止（停止需原因）、预算、连接、未保存草稿、诊断与设置入口。
- **StatusBanner（常驻）**：模式徽标（演示/正式/历史回放）、夹具徽标、连接状态、Alt+↑/↓ + 可见按钮的层级切换。

三层只改 ViewState：`Z+1 全局 / Z0 执行 / Z-1 证据`。切层、聚焦、选择、展开均不产生业务命令。

## 机制 A–D

- **A 计划预览 / 风险**：风险数量来自 `snapshot.plan.risks`，零风险零卡片；风险卡含类型/依据/影响模块/证据/处理选项/解除标准；阻止提交风险始终可见；提交绑定 `planVersion + contextSnapshotId + expectedRevision`；意图草稿或任务修订变化后提交按钮失效并要求重新检查。
- **B 局部修复**：每批最多 3 张修复卡；按 `ResolutionOption` 渲染 choose/text/bind_source/confirm_mapping/exclude，并在提交前用契约 `validateBlockResolution` 校验；bind_source 支持文件导入 → 资料版本 → resolve；技术故障（service_failure/permission_denied）走恢复入口而非业务选择题；取消修复保留已接受成果。
- **C 配方**：列表/折叠表示（名称、类型、版本、状态、测试）；从已审阅运行经服务端 `POST /api/recipes/propose` 提取候选 → 人工审阅 → 注册；测试、新数据运行、禁用；确定性配方显示“0 次 LLM 调用”，运行结果按 cacheState / 账本计数展示。
- **D 聚焦**：按依赖/同模块/同运行保留相关节点，其余降对比并退出 Tab 序列；中心锚点缩略、Escape/按钮返回并恢复焦点；停止、审批、错误始终可见；减少动态效果时关闭过渡。

## 审阅 / 版本 / 设置 / 资料 / 空态

- 差异审阅：整体接受或被允许的 Markdown 章节接受；失败验证不可接受；证据、L0–L4 检查项、接受备注、拒绝原因（必填）；版本冲突提示不覆盖基线。
- 版本历史：不可变版本列表、内容预览、恢复为新版本（触发下游过期提示）。
- 设置：Provider 公开信息（凭据只写不读、已配置/掩码状态）、分步能力测试（需勾选费用确认）、工作区策略（自动接受默认关闭）、Demo/Live 切换（有活动运行或未配置 Live 时给出禁用原因）。
- 资料：文件选择 + 扩展名/大小前端预检、base64 → API、解析结果/警告、不支持类型明确拒绝；信任级别与可用性文字标签。
- 导出/导入：Markdown/JSON/CSV/任务包导出下载；任务包导入提示重新绑定来源，不自动执行配方。
- 覆盖：加载 / 空 / 错误 / 离线（快照轮询兜底）/ 无权限 / 版本过期 / 取消 / 中断 / 夹具标识。
- 事件诊断：记录事件过滤与只读回放（仅移动视图游标，不重跑模型/工具）。

## 可访问性与响应式

- 所有状态 text-first（颜色 + 文字），`aria-label` 覆盖模块/状态/来源/错误；`focus-visible` 全局可见；面板为 `role="dialog"` + Escape 关闭并恢复焦点。
- 点击目标 ≥ 40px（`min-h-10`）；正文 14–16px，辅助 ≥ 12px；最多两层玻璃表面；网格 3.5% 透明度。
- 动画：反馈 120ms / 常规 220ms / 折叠 ≤ 420ms；仅中心锚点一个呼吸焦点；`prefers-reduced-motion`、工作区策略、本机开关任一开启即禁用倾斜/缩放/抖动；页面隐藏时暂停呼吸动画。
- 键盘：Tab 全量可达，Enter 触发主按钮，Escape 关面板保留草稿，Alt+↑/↓ 切层（输入框内不拦截）；文件/绑定输入始终有显式按钮，不依赖拖拽。
- 响应式：≥1024px 三栏空间布局（1440×900 主设计）；<1024 顺序堆叠并保留中心摘要与局部面板；390px 与 200% 缩放下核心操作可换行访问。

## 目录

```
src/api/        types/errors/sse/http/fixture/clientFactory（冻结契约驱动，无本地业务态）
src/state/      coreStore（快照/SSE/命令，外部 store）+ snapshot 纯 reducer + viewStore（Zustand，仅视图）
src/lib/        labels（业务语言）、format、layout（3/12/16 上限）、review（接受门禁）、routes、taskGraph、ids
src/components/ common（a11y 原语）、layout（五区）、panels（计划/修复/审阅/版本/配方/资料/事件/约束/导出）、settings、tasks
src/screens/    WorkspaceScreen
test/           95 个 Node 纯逻辑测试（无 jsdom）
```

## 测试 / 类型 / 构建

```bash
pnpm exec vitest run apps/web       # 11 files / 95 tests（layout 上限、SSE 去重/缺口、快照合并、ViewStore、
                                    # HTTP 客户端 fake fetch、夹具契约有效性、风险/阻塞格式化、章节接受门禁、路由、依赖无环）
pnpm exec tsc -p apps/web/tsconfig.verify.json --noEmit   # 仅 apps/web 的独立类型校验（便于本地定位）
pnpm build:web                      # Vite 生产构建
```

> `apps/web/tsconfig.verify.json` 仅用于本地聚焦校验，不参与根 `pnpm typecheck` 的 include。

## 已知缺口 / 边界

- **不做 DOM 测试**：仓库未提供 jsdom；交互由纯逻辑测试 + 手工/预览验证覆盖。Playwright E2E 未接入（由 Lead 的仓库级验收决定）。
- 夹具模式的数据全部是合成演示，界面持续标识“本地夹具（非真实执行）”；Live 连接错误不会被演示数据覆盖。
- 配方提取/测试/运行依赖后端新增路由（`/api/recipes/propose` 等）；后端未实现时面板给出明确错误与禁用原因，不会伪造成功。
- 模式切换仅在无活动运行且 Live 已配置时可用；服务端仍会以 409 `state_not_allowed` 复核。
- 空间连线基于可见节点布局测量；服务端聚合隐藏的节点/连线只显示数量，不在前端展开（需要后端提供对应投影）。
- 拖拽交互未实现（所有绑定均有显式“选择输入/选择文件”按钮），符合“拖拽必须配按钮”的可访问性底线。
- Provider 的详细能力矩阵来自服务端探测结果；前端不推断“兼容 OpenAI”等声明。
