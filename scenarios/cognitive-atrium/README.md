# 内置场景数据说明（fixture README）

本目录全部为**合成演示数据**，用于 Cognitive Atrium 的“次世代智能工作空间产品架构与 GTM 策略中枢”场景。它们不是真实市场调研、真实客户资料或真实财务数据。

## 文件清单

| 文件 | 用途 |
| - | - |
| product-brief.md | 目标用户、场景、边界、验收标准；含一处部署范围歧义 |
| constraints.json | 离线/在线、隐私、延迟、输出格式约束；含一组可识别硬冲突 |
| legacy-systems.csv | 24 行存量系统数据（清洗配方原始输入） |
| field-mapping.json | 规范字段、别名映射、必填规则、异常处理口径 |
| stakeholder-notes.md | 5 条角色需求，含可定位证据行号 |
| legacy-systems-new.csv | 与原始示例不同的新数据，用于配方泛化验收 |
| legacy-systems-invalid.csv | 缺少关键字段，用于输入拒绝验收 |
| template.json | 内置四模块模板与验收标准 |

## 统计口径（测试必须按此定义计算）

- **数据行数**：24（不含表头，含重复行与异常行）。
- **重复主键组**：按规范化后的 `system_id` 分组（先按别名映射得到 `system_id`，再 trim；不改变大小写，因为主键为大小写敏感字符串），出现 2 次及以上的组计为 1 组。预期 **2 组**：`S-1001`、`S-1007`。
- **字段别名**：CSV 表头中不是规范字段名、但能通过 `field-mapping.json` 的 `aliases` 映射到规范字段的列数。预期 **3 个**：`sys_id→system_id`、`owner→owner_dept`、`protocol_type→protocol`。
- **异常枚举**：`status` 列去除首尾空白并转小写后，不在规范枚举 `active / legacy / planned / retired` 中的值个数。预期 **2 个**：`S-1004` 的 `decommissioned` 与 `S-1012` 的 `unknown`。
  验收时以源数据真实统计为准，测试不得写死“必须是 2”；生产逻辑不得写死演示数量。
- **缺失必填项**：清洗后必填字段（`system_id`、`name`、`status`）为空的行数。预期 **1 个**：`S-1021` 行 `name` 为空。
- **raw 行号**：CSV 数据行从 1 开始计数（表头为第 0 行）。

## 新数据（legacy-systems-new.csv）

- 8 条数据行，1 组重复主键（`N-2003`），大小写/空白不规范值 2 处。
- 同一清洗配方应产生 7 行输出（按 keep=last 去重），且不得调用 LLM（deterministic）。

## 非法数据（legacy-systems-invalid.csv）

- 表头缺少可映射到 `system_id` 的列（`record_code` 不在别名表中），必须在导入或配方输入校验阶段被拒绝，不得静默改写规则。
