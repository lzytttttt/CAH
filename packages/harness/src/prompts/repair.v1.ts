/**
 * repair.v1 — bounded local repair after deterministic validation findings.
 * The repair role may only fix the listed findings; it must not rewrite
 * unrelated accepted content or invent evidence.
 */
import { hashPromptTemplate, renderTemplate, PROMPT_GUARDRAILS } from './render';

export const REPAIR_V1_ID = 'repair.v1';
export const REPAIR_V1_VERSION = 'repair.v1';

export const REPAIR_V1_SYSTEM_TEMPLATE = `你是 Cognitive Atrium 的“局部修复”角色（repair.v1，策略版本 {{policyVersion}}）。
你收到的候选成果未通过确定性校验。你只能修复列出的具体问题，不得借机重写其他已通过的内容。

${PROMPT_GUARDRAILS}

修复硬性要求：
1. 只修改与以下失败项相关的最小范围；未列出的内容保持原样。
2. 缺少证据时必须二选一：引用给定的真实 SourceSpan，或把该陈述明确改写为“待验证假设”。不得编造引用。
3. 不得删除已满足的硬约束，不得扩大范围，不得提高预算。
4. 输出必须是修复后的完整候选成果 JSON：{"candidate": <模块内容>, "evidenceRefs": [...], "description": "修复说明"}；不要输出代码围栏或额外解释。
5. 修复失败就是失败：不得声称已通过校验。`;

export const REPAIR_V1_USER_TEMPLATE = `模块类型：{{moduleKind}}
修复尝试：第 {{attempt}} / {{maxAttempts}} 次

校验失败项（必须逐条处理）：
{{findings}}

允许引用的真实证据（只能使用这些；也可以把陈述改为待验证假设）：
{{allowedEvidence}}

原始候选成果 JSON（仅用于定位与重写）：
{{candidateJson}}

请输出修复后的完整候选成果 JSON。`;

export const REPAIR_V1_HASH = hashPromptTemplate(REPAIR_V1_SYSTEM_TEMPLATE);

export interface RepairSystemVars {
  policyVersion: string;
}

export function renderRepairSystem(vars: RepairSystemVars): string {
  return renderTemplate(REPAIR_V1_SYSTEM_TEMPLATE, { policyVersion: vars.policyVersion });
}

export interface RepairUserVars {
  moduleKind: string;
  attempt: number;
  maxAttempts: number;
  findings: string;
  allowedEvidence: string;
  candidateJson: string;
}

export function renderRepairInstruction(vars: RepairUserVars): string {
  return renderTemplate(REPAIR_V1_USER_TEMPLATE, {
    moduleKind: vars.moduleKind,
    attempt: vars.attempt,
    maxAttempts: vars.maxAttempts,
    findings: vars.findings,
    allowedEvidence: vars.allowedEvidence,
    candidateJson: vars.candidateJson,
  });
}
