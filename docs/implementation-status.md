# 实施状态（最终）

更新时间：2026-10-22（P0 实现完成；Live 实测与浏览器自动化走查为已知缺口）

## 总览

P0 已按设计文档实现为可运行的本地 harness（空间 Web 工作台 + CLI + 执行内核 + 持久化 + 配方 + 导出/导入）。所有并行工作流已完成并在集成层验证。

## 验证结果（本次执行）

| 范围 | 结果 |
| - | - |
| `pnpm typecheck` | 0 错误 |
| `pnpm test` | 69 files / 706 tests 全部通过 |
| `pnpm test:e2e:browser` | Playwright/Chromium 35/35 通过（五区、Demo 夹具、修复卡/审阅面板、键盘切层与 Tab 遍历、多视口、减少动效、零控制台错误；截图见 `docs/screenshots/`） |
| `pnpm build` | web + server + cli 成功 |
| `pnpm exec tsx scripts/bench.ts` | 1000 行确定性清洗 5.4ms；5000 事件快照恢复 33.9ms（目标均 <2000ms）；浏览器内键盘切层 p95 ≈3.3ms |
| 生产冒烟 | 构建产物启动、会话/工作区/Demo 切换、Demo 夹具快照（57 events、10 节点）、前端静态托管、CLI 对同一服务读写一致 |
| 详细矩阵 | 见 `docs/acceptance-report.md` |

## 已完成工作流

| 工作流 | 交付 | 测试 |
| - | - | - |
| contracts | 版本化实体/事件（47 种逐类型 payload）/状态机/API/计划/补丁/配方/投影 + 纯函数 | 26 |
| providers | OpenAI-compatible 适配器（流式、原生 tool calling、错误/超时/usage）、能力探测、凭据（env/受限文件/AES-GCM）、URL 策略 | 130 |
| tools | 8 个 P0 工具、RFC4180 CSV/JSON、11 个确定性算子、权限/超时/大小限制、真实 SourceSpan 证据 | 156 |
| storage | node:sqlite WAL、22 表迁移、事件 seq 原子分配、事务/回滚、commitAcceptance、租约+fencing、内容寻址对象、备份 | 71 |
| harness | 计划（含确定性风险）、执行循环、工具回填、校验/修复、接受/拒绝/恢复/暂停/取消、上下文分层、恢复、验证器、版本化 prompts | 55 |
| recipes | DSL 运行时、指纹/失效、真实夹具确定性清洗 24→22、非法输入拒绝、从运行轨迹提取 | 55 |
| web | 五区/三层、机制 A–D、审阅/版本/设置/资料/导出/事件回放、键盘与减少动效、响应式、SSR 冒烟 | 99 |
| cli | 20+ 命令、machine-readable 状态、退出码契约、SSE 续传、sha256 校验导出 | 97 |
| server 集成 | 命令 API、会话/Origin/CSRF、SSE、调度队列、事件投影、导出/导入（ZIP）、Demo 固定夹具、Live 适配器真实路径 | 17 |
| 文档/交付 | README、.env.example、架构/状态机/追踪矩阵、Provider/工具/配方/用户指南、验收报告、已知限制、Docker、演示脚本、LICENSE/依赖许可 | — |

## 关键决策（最终）

1. 存储使用 Node 内置 `node:sqlite`（WAL + 内容寻址对象），无原生编译依赖，便于复现安装。
2. 工作区包以 TS 源码导出；dev/test 用 tsx/vitest；生产 server/cli 用 esbuild 打包，第三方依赖保持 external；web 用 Vite。
3. ArtifactVersion 为模块级不可变快照；接受在一个 SQLite 事务内完成（版本/模块/文档/任务修订 CAS/事件）；恢复产生内容相同的新版本。
4. 客户端 `expectedRevision` 一律为 `Task.revision`；冲突返回 409 且双方保留。
5. Demo 与 Live 物理隔离；Demo 为固定夹具只读演示（已接受/待审阅/计划阻塞/失败/validated 配方），不调用真实模型；Live 失败不回退。
6. CLI 与 UI 仅通过同一命令 API 操作内核（AC-17）。
7. 事件与状态同事务提交；SSE 只发已提交事件（120ms tail + 心跳 + Last-Event-ID 续传）。
8. 配方 P0 主路径为 deterministic；`llm_assisted` 执行器在 P0 明确返回 `model_step_unavailable`（不伪装成功），DSL/指纹/失效已实现。

## 已知缺口（如实声明）

1. **真实供应商 Live 实测未完成**（环境无凭据）。证据为本地 OpenAI 兼容假服务上的真实适配器路径。
2. **浏览器级 E2E 已执行**（Playwright/Chromium，35 checks）；但**未运行 axe/WCAG 全量自动化审计与真实用户走查**，鼠标点击专项性能序列未测量。
3. **真实进程 kill/restart 故障注入 E2E 未执行**；租约/检查点/恢复逻辑有单测。
4. P1（Anthropic/Responses/MCP/图片/PDF/DOCX/语义检索）未实现并明确禁用；P2 团队能力不在首版。
5. 未测量的性能项（点击 p95、动画帧、30 分钟内存）不宣称达标；已测量两项见验收报告。
6. URL 策略不做 DNS 解析（DNS rebinding 需部署层 egress 策略）；`llm_assisted`/`cached_snapshot` 配方执行路径按上述限制禁用。

## 后续建议

1. 在有凭据环境执行 `docs/provider-integration.md` 的实测模板，更新验收报告 AC-01/AC-03。
2. 安装 Playwright（或等价浏览器环境）补 AC-09 故障注入与 AC-19 浏览器级走查；对 1440×900/1366×768/1920×1080/390px 与 200% 缩放做截图验收。
3. 需要多进程/公网部署时，先补充独立鉴权、任务隔离、HTTPS、限流与事件归档策略。
