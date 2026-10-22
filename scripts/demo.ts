/**
 * End-to-end demo helper.
 *
 * This script never fabricates model output: it prints the exact commands the
 * presenter must run against a Live server with a configured provider, plus the
 * matching CLI commands. Demo (fixture) mode is read-only and labelled as such.
 */
function print(text: string): void {
  console.log(text);
}

print(`Cognitive Atrium 演示脚本（5-8 分钟）
==================================================
前置：在 .env 中配置 CA_OPENAI_BASE_URL / CA_OPENAI_MODEL / CA_OPENAI_API_KEY，
     运行 pnpm dev（或 pnpm build && pnpm start），浏览器打开 http://127.0.0.1:4310 。

阶段 1 连接模型（Live）
- 设置 → 模型连接：填写 profileName、baseURL、model；点击“测试连接”（先鉴权+基础文本，
  再明确点击能力探测，逐项得到 verified/unsupported/unknown）。
- 说清楚：HTTP 200 不等于能力已通过；每项都有实际测试时间与模型名。

阶段 2 新建任务与导入资料
- 新建任务 → 选择内置模板“次世代智能工作空间…”，或自定义 1-8 个模块。
- 导入 scenarios/cognitive-atrium 下的 product-brief.md、constraints.json、
  legacy-systems.csv、field-mapping.json、stakeholder-notes.md。

阶段 3 计划预览（机制 A）
- 选择“核心架构拓扑”模块，意图：根据 brief 与 constraints 形成组件拓扑与决策记录。
- 观察真实风险：constraints.json 中的 DEPLOY-1（完全离线）与 AI-1（云端实时模型）冲突，
  风险数为输入决定，不是固定三个。
- 处理冲突（补充证据 / 修改约束 / 缩小范围），计划版本变化后才能提交。
- 打开“先看计划”，确认输入版本与预算，然后提交并执行。

阶段 4 真实执行与局部修复（机制 B）
- 展示模型实际调用的工具、参数、结果与检查点；等待模型的时间与操作时间分别说明。
- 人为删除/不绑定必需资料（如 legacy CSV），观察修复卡出现；补齐后只重跑依赖步骤。

阶段 5 差异审阅与接受
- 在差异视图查看逐章节差异、证据引用与 L0-L4 验证结果；接受后中心成果产生新版本。
- 刷新页面（甚至重启服务）验证：版本、证据与运行记录仍可查看，不重新执行。

阶段 6 配方复用（机制 C）
- 对已接受的清洗支线“保存为配方”→ 审阅 DSL 步骤 → 测试（原始样本 / 新数据 / 非法输入）
  → 注册 validated。
- 用 legacy-systems-new.csv 运行配方：显示 deterministic、0 次 LLM 调用、7 行输出。
- 用 legacy-systems-invalid.csv 运行：必须被拒绝并说明缺失字段，不得静默改写规则。

阶段 7 高台综合成果与导出
- 打开“商业化价值壁垒矩阵”高台：需要已接受的核心架构与清洗成果；显示缺少项。
- 生成、验证、接受；随后修改上游版本，观察价值矩阵变为 stale。
- 导出 Markdown / JSON / 任务包；再导入任务包，验证内容哈希一致、配方不自动执行。

诚实边界
- 未配置真实凭据时，Live 验收标记为“等待验证”，不得用模拟数据补记通过。
- 演示时不要剪辑等待模型的时间，不要宣称固定秒级完成。
`);
