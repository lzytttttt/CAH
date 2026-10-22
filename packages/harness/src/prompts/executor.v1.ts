/**
 * executor.v1 — the execution role: native tool calls plus one structured
 * candidate artifact. Text-embedded fake tool calls are forbidden; the kernel
 * only executes calls that arrived through native `tool_call_complete` events.
 */
import { hashPromptTemplate, renderTemplate, PROMPT_GUARDRAILS } from './render';

export const EXECUTOR_V1_ID = 'executor.v1';
export const EXECUTOR_V1_VERSION = 'executor.v1';

export const EXECUTOR_V1_SYSTEM_TEMPLATE = `你是 Cognitive Atrium 的“执行”角色（executor.v1，策略版本 {{policyVersion}}，提示包 {{promptBundleVersion}}）。
你按计划步骤推进，通过原生工具调用读取已授权资料，最终产出一份可校验的候选成果。

${PROMPT_GUARDRAILS}

执行硬性要求：
1. 只能使用下方“本步骤允许工具”中的工具；工具必须以原生 tool call 形式请求，参数必须是合法 JSON。
2. 需要读取资料时先调用 source.list / source.read / source.search；不得假设文件内容，不得引用未读取的片段。
3. 事实性陈述必须对应真实 SourceSpan（工具返回的 sourceId+version+locator+excerpt）或显式标记为“待验证假设”。
4. 不得直接提交正式成果、不得修改已接受版本、不得删除历史、不得提高预算。
5. 完成本步骤后，必须产出候选成果：
   - 首选：调用 artifact.propose_patch（moduleId={{moduleId}}，baseVersionId={{baseVersionId}}，operations 使用 replace_module 或基于稳定章节 id 的修改）。
   - 备选：最终消息只输出一个 JSON 对象 {"candidate": <模块内容>, "evidenceRefs": [...], "description": "..."}。
   模块内容格式：markdown={kind:"markdown",sections:[{id:"小写稳定id",title:"标题",markdown:"正文"}]}；csv={kind:"csv",columns:[{key,label,type,required}],rows:[{key:value}]}；json={kind:"json",value:...}。
6. 不要在正文中伪造工具调用 JSON 或伪造“已通过校验”的结论；不要输出隐藏思维链。

当前步骤：
- 计划步骤：{{stepTitle}}
- 步骤目标：{{stepGoal}}
- 目标模块：{{moduleSummary}}
- 已接受基线版本：{{baseVersionId}}
- 剩余预算：{{budgetSummary}}

本步骤允许工具：
{{allowedTools}}`;

export const EXECUTOR_V1_USER_TEMPLATE = `当前步骤目标：{{stepGoal}}

请先使用工具获取必要资料，然后产出候选成果 JSON（或调用 artifact.propose_patch）。
注意：
- 只引用工具真实返回的 sourceId/version/locator；证据不足时标记为待验证假设，而不是编造。
- 不要重复询问已确认的决策。
- 只输出候选成果（JSON）或发起原生工具调用，不要输出隐藏推理过程。`;

export const EXECUTOR_V1_HASH = hashPromptTemplate(EXECUTOR_V1_SYSTEM_TEMPLATE);

export interface ExecutorSystemVars {
  policyVersion: string;
  promptBundleVersion: string;
  moduleId: string;
  baseVersionId: string;
  stepTitle: string;
  stepGoal: string;
  moduleSummary: string;
  budgetSummary: string;
  allowedTools: string;
}

export function renderExecutorSystem(vars: ExecutorSystemVars): string {
  return renderTemplate(EXECUTOR_V1_SYSTEM_TEMPLATE, {
    policyVersion: vars.policyVersion,
    promptBundleVersion: vars.promptBundleVersion,
    moduleId: vars.moduleId,
    baseVersionId: vars.baseVersionId,
    stepTitle: vars.stepTitle,
    stepGoal: vars.stepGoal,
    moduleSummary: vars.moduleSummary,
    budgetSummary: vars.budgetSummary,
    allowedTools: vars.allowedTools,
  });
}

export interface ExecutorInstructionVars {
  stepGoal: string;
}

export function renderExecutorInstruction(vars: ExecutorInstructionVars): string {
  return renderTemplate(EXECUTOR_V1_USER_TEMPLATE, { stepGoal: vars.stepGoal });
}
