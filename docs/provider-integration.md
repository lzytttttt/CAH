# Provider 接入指南与实测报告

本文件记录 OpenAI-compatible 接入的实际实现、能力探测方法、当前实测状态与配置示例。设计文档 6.1/6.2 的行为矩阵在这里逐项对应。

## 1. 已验证范围（重要：如实声明）

| 项目 | 状态 |
| - | - |
| 适配器离线契约测试（模拟服务） | ✅ 130 tests：覆盖流式、tool calling、错误映射、超时、usage 缺失、截断、拒绝、429、URL 策略、凭据掩码 |
| 本地 OpenAI 兼容假服务 + 真实适配器 + 真实内核/工具/存储的端到端路径 | ✅ `tests/integration/live-adapter.test.ts`：保存连接 → 能力探测 → 规划 → 原生工具调用 → 校验 → 审阅 → 接受 |
| 真实供应商服务端到端（Live） | **⚠️ 等待验证**——当前环境未提供真实模型凭据；未使用 Mock 补记通过 |
| Anthropic 原生 / OpenAI Responses | 未实现（P1，界面明确禁用；`createAdapter` 返回 `unsupported_feature`，无静默回退） |
| MCP 只读连接 | 未实现（P1） |

> “OpenAI-compatible”仅是接口形状声明，不代表任何具体服务已被验证。真实兼容性以 §5 更新后的实测记录为准。

## 2. 配置

```bash
# .env（不要提交真实密钥）
CA_OPENAI_BASE_URL=https://api.openai.com/v1
CA_OPENAI_MODEL=<实际模型名>
CA_OPENAI_API_KEY=<密钥>
# 或使用受限文件：
# CA_OPENAI_API_KEY_FILE=/run/secrets/openai_key
```

- 服务端启动时会创建名为 `环境变量连接（env-default）` 的连接配置（若不存在），可在设置页继续添加其他 profile。
- 远程端点必须 HTTPS；本机回环允许 HTTP（`CA_ALLOW_HTTP_LOOPBACK=true`）；内网地址需加入 `CA_ALLOWED_PROVIDER_HOSTS`。
- 浏览器永远拿不到密钥，只显示“已配置/未配置 + 掩码”。

## 3. 两步连接测试

1. **鉴权与基础文本**：第一步只验证鉴权与一次最小文本返回，失败直接给出可操作错误（401/404/网络）。
2. **能力探测**（需要用户明确确认会产生少量费用）：分别测试 streaming、tool_calling、structured_output、usage。
   - 每项结果为 `verified` / `unsupported` / `unknown` / `error`，带延迟、测试模型与测试时间。
   - HTTP 200、模型名称或“兼容 OpenAI”声明都不能替代功能测试。

## 4. 适配器行为矩阵（实现对照）

| 情况 | 实现行为 |
| - | - |
| 原生 tool calling | 保留调用 ID/参数/结果配对；完整 tool_call_complete 且 Schema 通过后才执行 |
| 不支持 tool calling | 标记能力 `unsupported`；执行时返回明确错误，不从自然语言/正则猜测执行 |
| 结构化输出 | 使用适配器支持的 JSON Schema；服务端再次校验 |
| 不支持结构化输出 | 允许 JSON 文本 + 严格校验（超过修复上限则失败） |
| 不支持流式 | 非流式响应，显示真实等待状态，不伪造逐字流 |
| 流截断/length | 保留部分草稿并标记未完成，不当作成功 |
| 鉴权错误/模型不存在 | 可操作的配置错误，不无限重试 |
| 429/可重试 5xx | 仅对安全操作按预算重试，显示尝试次数，遵循 Retry-After |
| usage 缺失 | 本地估算并标记 `estimated`，不伪造 provider 数值 |
| 服务拒绝 | 保留可公开原因，允许修改任务；不当网络错误重试 |
| 供应商不透明续接字段 | 适配器内部保存/续传，不在通用 UI 解释为思维链 |

## 5. 实测记录模板（Live 验证后填写）

```yaml
service: <服务提供方与 API 版本>
baseURL: <URL>
model: <模型名>
testedAt: <ISO 时间>
tester: <人员/环境>
probes:
  auth_and_text: verified | unsupported | unknown | error
  streaming: ...
  tool_calling: ...
  structured_output: ...
  usage: ...
notes: <已知差异；例如 strict schema 字段要求>
requestCount: <本次测试实际请求数>
estimatedCostUsd: <未知则写 null，不得写 0>
```

## 6. 无凭据时的验收口径

- 全部适配器契约测试可在无凭据下通过（本地模拟服务，不访问外网）。
- Live 相关验收项（AC-01/AC-03/AC-11 的真实服务部分）在验收报告中标记“等待 Live 验证”。
- 不得把 Mock/模拟服务的测试结果表述为真实模型接入成功；切换模式必须显式，Live 失败不得回退到 Demo 数据。
