# 配方说明（机制 C）

配方是**有界、可重放的步骤程序**，不是对话截图。只有满足"可参数化输入、明确步骤、可描述输出、有验证器、权限已知、适用范围可说明"的成功支线才能保存为配方。

## 1. 三种复用类型

| 类型 | 执行 | 界面显示 |
| - | - | - |
| `deterministic` | 固定版本算子与规则；相同环境与输入产生相同规范化结果 | 0 次 LLM 调用；排序/时区/舍入等确定性条件 |
| `llm_assisted` | 固定工作流与验证器，步骤中仍调用模型（P0 中执行器禁用并明确标注，P1 启用） | 预计模型调用与预算范围；输出可能不同 |
| `cached_snapshot` | 按完整输入与依赖哈希复用既有成果（P0 不伪造缓存命中） | 缓存命中、生成时间、来源版本 |

## 2. 状态

`candidate → validated → stale ⇄ validated`；任意状态可 `→ disabled`，`disabled` 需重新测试才能回到 `validated`。只有 `validated` 可直接运行。

配方进入 `stale` 的触发：工具实现、prompt、模型、关键约束、字段语义、解析器或验证规则变化（由 `fingerprint` 决定），或原始授权过期/范围扩大。

## 3. DSL 约束

- 顺序步骤，最多 32 步；支持参数绑定（字符串/数字/布尔/来源/对象）与 `when` 条件守卫；不支持任意脚本、任意代码与无界循环。
- 步骤类型：source.read / source.search / data.profile / data.transform / artifact.read / llm.step / validate / emit_artifact。
- 转换算子来自受审查注册表（select/rename/filter/sort/dedupe/normalize/cast/fill/map/limit/require），不做 locale 依赖。
- 新数据运行前校验 Schema、字段语义、权限、版本与大小；不匹配时解释具体项，不静默改写规则。

## 4. 保存流程（服务端提取）

1. 成功运行完成后，`POST /api/recipes/propose {runId, name, kind, ...}`：服务端从持久化运行轨迹提取候选步骤、参数化可变输入、删除无效探索步骤，返回 `RecipeProposalInput`。
2. 人工审阅后 `POST /api/recipes` 注册为 `candidate`（不自动激活、不自动执行）。
3. `POST /api/recipes/:id/validate` 运行测试：至少 **1 个原始样本 + 1 个新有效样本 + 1 个预期被拒绝的越界样本**；通过后注册为 `validated` 并写入 `recipe.validated` 事件。
4. `POST /api/recipes/:id/run` 绑定新输入执行；输出先成为新草稿，经相同验证与接受流程更新中心成果。

## 5. 内置清洗配方示例（场景数据）

- 输入：`legacy-systems.csv`（24 行）+ `field-mapping.json`。
- 规则：别名重命名（sys_id→system_id、owner→owner_dept、protocol_type→protocol）→ trim/lower 规范化 → 按 system_id 去重 keep=last → 必填校验。
- 原始样本：24 → 22 行（2 组重复主键各去掉 1 行），缺失名称行记录 issue。
- 新有效样本：`legacy-systems-new.csv` 8 → 7 行；deterministic，0 次 LLM 调用。
- 非法样本：`legacy-systems-invalid.csv` 缺少可映射的 system_id 列 → 输入校验拒绝。

## 6. 折叠展示

`recipe.validated` 后，局部探索链折叠为一条连到目标模块的紧凑连接，显示配方名、类型、版本与最近运行状态；允许"展开来源"与"禁用配方"。折叠只改变展示，不删除审计与调试证据；也不能折叠权限边界。
