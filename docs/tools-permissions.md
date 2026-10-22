# 工具与权限指南

P0 工具全部在服务端执行，模型只能提出调用；参数经 Zod Schema、权限范围、超时与结果大小校验，结果按不可信资料处理。

## 1. 工具清单

| 工具 | 输入 | 输出 | 副作用 | 重试语义 |
| - | - | - | - | - |
| `source.list` | includeUnavailable? | 当前任务已授权资料元数据 | 只读 | 安全，可重试 |
| `source.read` | sourceId、version、locator?、maxChars? | 片段文本 + 定位 + 截断标记 | 只读 | 安全 |
| `source.search` | query、limit?、sourceIds? | SourceSpan 证据（spanId/quoteHash/定位/摘录/评分） | 只读（持久化 span 为幂等 upsert） | 安全 |
| `data.profile` | sourceId、version | 行列数、类型推断、缺失、重复、问题列表 | 只读 | 安全 |
| `data.transform` | sourceId、version、format、operations[] | 新对象哈希、预览、行数、问题 | 生成新对象，不覆盖源文件 | 安全（输出内容寻址） |
| `artifact.read` | moduleId、versionId? | 模块内容、哈希、依赖 | 只读 | 安全 |
| `artifact.propose_patch` | moduleId、baseVersionId、description、operations[]、evidenceRefs[] | 草稿 PatchProposal + ValidationReport | 仅写隔离草稿，不改已接受版本 | keyed（幂等键 = 运行+模块+基线） |
| `artifact.validate` | moduleId、baseVersionId、candidate、evidenceRefs | 确定性 ValidationReport | 只读 | 安全 |

P0 不提供任意 shell、Python eval、浏览器自动化、任意 SQL、任意文件路径读写、外部系统写入。

## 2. 权限模型

- 工具策略字段：`effect`（read / draft_write / external_write）、`idempotency`（safe / keyed / unsafe）、`timeoutMs`、`maxResultBytes`、`requiredScopes`。
- 每次调用由服务端授予 scope（P0：`sources:read`、`artifact:read`、`artifact:draft_write`、`artifact:validate`、`data:profile`、`data:transform`）；模型参数不能改变 scope 或权限。
- 首次连接外部服务、扩大数据范围、提高预算、P1 外部写入需要显式授权；授权绑定 toolId、参数哈希、资源范围、runId、有效期与策略版本，参数/资源/策略变化后旧授权失效。
- 模型生成的工具调用不得调用系统级接受、删除历史、修改密钥/权限或提高预算。

## 3. 执行可靠性

- 每次调用记录 `planned → authorized → started → succeeded/failed/outcome_unknown`。
- read-only 工具可在预算内自动重试；draft_write 使用持久化幂等键；外部写入（P1）必须支持查询结果或人工核对。
- 工具参数流片段只用于展示；收到完整结束事件、严格 Schema 校验通过后才执行（非法/未完成 JSON 不执行）。
- 路径由服务端以 sourceId/objectId 解析，拒绝目录穿越、符号链接越界与超大输出。
- 文件导入校验扩展名、MIME 与实际解析结果；首版支持 UTF-8 TXT、Markdown、JSON、CSV；PDF/DOCX/图片明确显示“不支持”。

## 4. 结果信任级别

- 所有工具结果标记 `trust: "untrusted_content"`；来源资料中的指令不改变系统权限。
- 搜索摘要不能当作全文证据；证据必须指向真实 SourceSpan（含 quoteHash）或明确标记的用户假设。
- `artifact.propose_patch` 在基线版本不一致、章节不存在、JSON 路径未知、模块类型不匹配时拒绝执行。
