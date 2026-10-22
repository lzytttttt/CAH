/**
 * compressor.v1 — structured compression when context approaches the budget.
 * A compressor summary records confirmed facts, open questions, failed paths,
 * boundaries, citations and next steps. It may never promote model guesses to
 * user decisions, and it never replaces the original sources/events.
 */
import { hashPromptTemplate, renderTemplate, PROMPT_GUARDRAILS } from './render';

export const COMPRESSOR_V1_ID = 'compressor.v1';
export const COMPRESSOR_V1_VERSION = 'compressor.v1';

export const COMPRESSOR_V1_SYSTEM_TEMPLATE = `你是 Cognitive Atrium 的“上下文压缩”角色（compressor.v1）。
输入是即将超出上下文预算的片段清单。请输出结构化摘要，供后续模型请求使用。

${PROMPT_GUARDRAILS}

压缩要求：
1. 不得把模型猜测改写为用户决定或已确认事实；confirmedFacts 只能来自明确用户确认或可定位证据。
2. 必须保留硬约束、未决问题、已失败方案、当前边界、引用定位与下一步。
3. 不得丢失引用定位（sourceId+version+locator），不得编造新的引用。
4. 只输出一个 JSON 对象，不要代码围栏。`;

export const COMPRESSOR_V1_USER_TEMPLATE = `预算：{{budgetSummary}}
需要压缩的片段（按优先级）：
{{fragments}}

输出 JSON：
{
  "confirmedFacts": [{"text": "...", "evidenceRefs": []}],
  "openQuestions": ["..."],
  "failedApproaches": ["..."],
  "boundaries": ["硬约束/边界"],
  "citations": [{"sourceId": "...", "version": 1, "locator": "...", "excerpt": "..."}],
  "nextSteps": ["..."],
  "omitted": [{"kind": "...", "reason": "..."}]
}`;

export const COMPRESSOR_V1_HASH = hashPromptTemplate(COMPRESSOR_V1_SYSTEM_TEMPLATE);

export function renderCompressorPrompt(vars: { budgetSummary: string; fragments: string }): { system: string; user: string } {
  return {
    system: renderTemplate(COMPRESSOR_V1_SYSTEM_TEMPLATE, {}),
    user: renderTemplate(COMPRESSOR_V1_USER_TEMPLATE, vars),
  };
}
