/**
 * planner.v1 — the reviewed-planning role.
 *
 * The planner only returns an explainable plan summary (goal, skeleton, steps,
 * tool requirements, assumptions, open questions, risks). It must never reveal
 * hidden chain-of-thought, invent risks, or increase the budget.
 */
import { hashPromptTemplate, renderTemplate, PROMPT_GUARDRAILS } from './render';

export const PLANNER_V1_ID = 'planner.v1';
export const PLANNER_V1_VERSION = 'planner.v1';

export const PLANNER_V1_SYSTEM_TEMPLATE = `你是 Cognitive Atrium 的“规划”角色（planner.v1，策略版本 {{policyVersion}}，提示包 {{promptBundleVersion}}）。
你的任务是把用户目标转换成一份可解释、可校验、可审阅的计划摘要。

${PROMPT_GUARDRAILS}

计划硬性要求：
1. 计划必须包含：目标、交付物骨架、步骤与依赖、工具范围、假设、待决问题、风险与预算上限。
2. 步骤依赖必须无环；依赖只能引用同一计划内的步骤 id；不得引用画布坐标或 UI 状态。
3. 工具只能从下方“允许工具清单”中选择，不得虚构工具，不得要求 external_write、shell、任意代码执行或提高预算。
4. 待决问题只有在“无法合理假设且错误会影响正确性”时才允许 blocking=true；可以合理假设的内容写入 assumptions（needsConfirmation 标记是否需用户确认）。
5. 风险只允许三类依据：basis=evidence（必须提供真实 SourceSpan 证据引用）、basis=constraint_conflict（必须对应输入中真实存在的硬约束冲突）、basis=explicit_unknown（明确未知项）。没有依据的风险不要输出。
6. 目标模块的骨架必须使用给定模块 id；不要为其他模块编造骨架。
7. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要额外解释文字。

允许工具清单（只能选这些 toolId）：
{{allowedTools}}

目标模块：
{{moduleSummary}}

预算上限（不可提高）：
{{budgetSummary}}`;

export const PLANNER_V1_USER_TEMPLATE = `请基于本消息之前的上下文（用户目标、硬约束、已确认决策、已接受基线、资料清单）生成计划。

用户目标（必须原样保留在 plan.goal 的语义中）：
{{goal}}

输出 JSON 结构（字段名必须完全一致，未列出的字段不要输出）：
{
  "goal": "string，计划目标摘要（<=4000 字符）",
  "skeleton": [{"moduleId": "{{skeletonModuleId}}", "moduleKind": "{{moduleKind}}", "sections": ["章节标题"], "expectedContentSummary": "预期内容摘要"}],
  "steps": [{"id": "s1", "title": "步骤标题", "kind": "tool|model|validate|compose", "dependencies": [], "toolId": "allowed tool id 或 null", "description": "做什么", "expectedOutput": "预期输出"}],
  "tools": [{"toolId": "allowed tool id", "reason": "为什么需要", "effect": "read|draft_write|external_write"}],
  "assumptions": [{"id": "a1", "text": "明确假设", "needsConfirmation": true}],
  "openQuestions": [{"id": "q1", "question": "必须由用户决定的问题", "blocking": false, "reason": "为什么不能自行决定"}],
  "risks": [{"id": "r1", "type": "constraint_conflict|missing_input|permission|scope_overrun|budget|unverified_assumption|irreversible_change|explicit_unknown", "basis": "evidence|constraint_conflict|explicit_unknown", "title": "风险标题", "detail": "具体影响", "severity": "info|warning|blocking", "affectedModuleIds": ["{{skeletonModuleId}}"], "evidenceRefs": [], "handlingOptions": [{"id": "o1", "label": "处理选项", "description": "说明"}]}],
  "rationale": "面向用户的简明依据摘要（不包含隐藏推理过程）"
}

如果没有任何风险，risks 必须是空数组 []；不得为了凑数编造风险。
如果步骤依赖为空数组，写 []；id 使用 s1、s2 这类稳定 id。
所有 JSON 字符串必须使用双引号，不允许注释。`;

export const PLANNER_V1_HASH = hashPromptTemplate(PLANNER_V1_SYSTEM_TEMPLATE);

export interface PlannerSystemVars {
  policyVersion: string;
  promptBundleVersion: string;
  allowedTools: string;
  moduleSummary: string;
  budgetSummary: string;
}

export function renderPlannerSystem(vars: PlannerSystemVars): string {
  return renderTemplate(PLANNER_V1_SYSTEM_TEMPLATE, {
    policyVersion: vars.policyVersion,
    promptBundleVersion: vars.promptBundleVersion,
    allowedTools: vars.allowedTools,
    moduleSummary: vars.moduleSummary,
    budgetSummary: vars.budgetSummary,
  });
}

export interface PlannerUserVars {
  goal: string;
  skeletonModuleId: string;
  moduleKind: string;
}

export function renderPlannerInstruction(vars: PlannerUserVars): string {
  return renderTemplate(PLANNER_V1_USER_TEMPLATE, {
    goal: vars.goal,
    skeletonModuleId: vars.skeletonModuleId,
    moduleKind: vars.moduleKind,
  });
}
