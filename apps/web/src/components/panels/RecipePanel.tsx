/**
 * Mechanism C — recipes and path folding.
 *
 * Saving a candidate always goes through the server extractor
 * (`POST /api/recipes/propose`) so the UI never invents workflow steps; the
 * human then reviews the proposal. Validation, run-with-new-inputs, disable and
 * the deterministic 0-LLM-call accounting are all driven by real responses.
 */
import { useEffect, useMemo, useState } from 'react';
import type { JsonObject, Recipe, RecipeProposalInput, TaskSnapshot } from '@ca/contracts';
import { canRunRecipe } from '@ca/contracts';
import { ChevronDown, ChevronRight, FlaskConical, GitBranch, Play, Save, ShieldOff } from 'lucide-react';
import { formatDuration, formatTimestamp, safeJsonPreview, truncateText } from '../../lib/format';
import { recipeKindLabel, recipeRunAccounting, recipeStatusLabel, recipeStatusTone, runStateLabel } from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { useViewStore } from '../../state/viewStore';
import { Button, Card, Chip, EmptyState, ErrorNotice, Field, LoadingBlock, Select, StatusBadge, TextArea, TextInput, cn } from '../common/ui';

export interface RecipePanelProps {
  snapshot: TaskSnapshot;
  initialRecipeId: string | null;
  onClose: () => void;
  onOpenEvents: () => void;
}

export function RecipePanel({ snapshot, initialRecipeId, onClose, onOpenEvents }: RecipePanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const openPanel = useViewStore((view) => view.openPanel);
  const [details, setDetails] = useState<Record<string, Recipe>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialRecipeId ?? snapshot.recipes[0]?.recipeId ?? null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selectedId || details[selectedId]) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void core
      .read('读取配方详情', (client) => client.getRecipe(selectedId))
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setLoadError('配方详情读取失败；运行、测试与禁用按钮在详情可用前保持禁用。');
          return;
        }
        setDetails((current) => ({ ...current, [result.recipe.id]: result.recipe }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [core, selectedId, details]);

  const selected = selectedId ? details[selectedId] ?? null : null;
  const summaries = snapshot.recipes;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>已注册配方 {summaries.length}</Chip>
        <Chip>确定性配方 0 次 LLM 调用</Chip>
        <Chip>只有「已验证」配方可直接运行</Chip>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpenEvents}>
          查看配方事件
        </Button>
      </div>

      <Card title="折叠表示（路径压缩）" subtitle="折叠只改变展示方式，不删除审计与调试证据。">
        {summaries.length === 0 && <p className="text-xs text-ink-secondary">还没有配方。一次成功并接受的运行可以保存为候选配方，经测试后注册为已验证版本。</p>}
        <ul className="space-y-1.5">
          {summaries.map((summary) => {
            const isSelected = summary.recipeId === selectedId;
            const isExpanded = expanded[summary.recipeId] ?? false;
            return (
              <li key={summary.recipeId} className={cn('rounded border px-2 py-1.5', isSelected ? 'border-anchor/50 bg-anchor/[0.04]' : 'border-white/10 bg-black/20')}>
                <button
                  type="button"
                  className="ca-focus-ring flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded text-left"
                  onClick={() => {
                    setSelectedId(summary.recipeId);
                    setExpanded((current) => ({ ...current, [summary.recipeId]: !isExpanded }));
                  }}
                  aria-expanded={isExpanded}
                  aria-label={`配方 ${summary.name}，${recipeStatusLabel(summary.status)}`}
                >
                  {isExpanded ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
                  <GitBranch aria-hidden="true" className="h-3.5 w-3.5 text-anchor" />
                  <span className="truncate text-xs font-medium text-ink-primary">{summary.name}</span>
                  <Chip>{recipeKindLabel(summary.kind)}</Chip>
                  <Chip>v{summary.version}</Chip>
                  <StatusBadge label={recipeStatusLabel(summary.status)} tone={recipeStatusTone(summary.status)} ariaLabel="配方状态" />
                  <span className="ml-auto text-[10px] text-ink-secondary">fingerprint {summary.fingerprint.slice(0, 8)}</span>
                </button>
                {isSelected && loading && <LoadingBlock compact label="读取配方详情…" />}
                {isSelected && loadError && <ErrorNotice compact title="配方详情不可用" message={loadError} guidance={['可以查看摘要，但测试/运行/禁用需要详情。']} />}
                {isSelected && selected && (
                  <RecipeDetail
                    recipe={selected}
                    snapshot={snapshot}
                    pending={pending}
                    onOpenPanel={(panel, context) => openPanel(panel, context)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <SaveCandidateCard snapshot={snapshot} onOpenEvents={onOpenEvents} onClose={onClose} />
    </div>
  );
}

function RecipeDetail({
  recipe,
  snapshot,
  pending,
  onOpenPanel,
}: {
  recipe: Recipe;
  snapshot: TaskSnapshot;
  pending: boolean;
  onOpenPanel: (panel: 'versions' | 'sources', context: { moduleId?: string } | null) => void;
}): JSX.Element {
  const core = useCore();
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const parameter of recipe.inputParameters) {
      if (parameter.defaultValue != null) initial[parameter.name] = typeof parameter.defaultValue === 'string' ? parameter.defaultValue : JSON.stringify(parameter.defaultValue);
    }
    return initial;
  });
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [disableReason, setDisableReason] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const testCases = recipe.testCases;
  const passedCount = testCases.filter((testCase) => testCase.status === 'passed').length;

  const validate = async (): Promise<void> => {
    const envelope = commandEnvelope();
    const testInputs = testCases.map((testCase) => ({ testCaseId: testCase.id, inputs: testCase.inputs }));
    const result = await core.runCommand(
      '测试配方',
      (client) => client.validateRecipe(recipe.id, { ...envelope, testInputs }),
      { successNotice: '配方测试完成；状态以返回结果为准。' },
    );
    if (result) setRunResult(`测试状态：${result.status === 'validated' ? '已验证' : result.status} · 测试用例 ${result.testCases.filter((testCase) => testCase.status === 'passed').length}/${result.testCases.length} 通过`);
  };

  const run = async (): Promise<void> => {
    const errors: Record<string, string> = {};
    const parsed: Record<string, unknown> = {};
    for (const parameter of recipe.inputParameters) {
      const raw = (inputs[parameter.name] ?? '').trim();
      if (parameter.required && raw.length === 0) {
        errors[parameter.name] = '该输入为必填项';
        continue;
      }
      if (raw.length === 0) continue;
      if (parameter.type === 'number') {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) errors[parameter.name] = '需要数字';
        else parsed[parameter.name] = numeric;
      } else if (parameter.type === 'boolean') {
        parsed[parameter.name] = raw === 'true';
      } else if (parameter.type === 'object') {
        try {
          parsed[parameter.name] = JSON.parse(raw) as unknown;
        } catch {
          errors[parameter.name] = '需要合法 JSON 对象';
        }
      } else {
        parsed[parameter.name] = raw;
      }
    }
    setInputErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setRunning(true);
    try {
      const envelope = commandEnvelope(snapshot.task.revision);
      const result = await core.runCommand(
        '运行配方',
        (client) => client.runRecipe(recipe.id, { ...envelope, inputs: parsed as JsonObject, expectedRevision: snapshot.task.revision }),
        { successNotice: '配方运行已提交（输出先成为草稿，仍需验证与接受）。' },
      );
      if (result) {
        setRunResult(
          `运行结果：${result.cacheState === 'cache_hit' ? '命中缓存' : '实际执行'} · ${recipeKindLabel(recipe.kind)} · [${
            result.result ? recipeRunAccounting(recipe.kind, result.result.llmCalls) : recipeRunAccounting(recipe.kind)
          }]${result.result ? ` · 工具 ${result.result.toolCalls} 次 · ${formatDuration(result.result.durationMs)}` : ''}`,
        );
      }
    } finally {
      setRunning(false);
    }
  };

  const disable = async (): Promise<void> => {
    const reason = disableReason.trim();
    if (reason.length === 0) return;
    const envelope = commandEnvelope();
    const result = await core.runCommand('禁用配方', (client) => client.disableRecipe(recipe.id, { ...envelope, reason }), { successNotice: '配方已禁用。' });
    if (result) {
      setShowDisable(false);
      setDisableReason('');
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-2 border-t border-white/10 pt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge label={recipeStatusLabel(recipe.status)} tone={recipeStatusTone(recipe.status)} ariaLabel="配方状态" />
        <Chip>{recipeKindLabel(recipe.kind)}</Chip>
        <Chip>版本 v{recipe.version}</Chip>
        <Chip>DSL {recipe.dslVersion}</Chip>
        <Chip>测试 {passedCount}/{testCases.length} 通过</Chip>
        <Chip>来源运行 {recipe.sourceRunId.slice(0, 8)}</Chip>
        <Chip>更新于 {formatTimestamp(recipe.updatedAt)}</Chip>
      </div>
      <p className="text-[11px] leading-4 text-ink-secondary">{recipe.description || '无描述'}</p>
      <p className="text-[11px] leading-4 text-ink-secondary">适用范围：{recipe.applicability || '未声明（需要人工确认适用范围后才能复用）'}</p>
      {recipe.staleReason && <p className="text-[11px] text-pending">失效原因：{recipe.staleReason}</p>}

      <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
        <p className="text-[11px] font-medium text-ink-secondary">确定性账本（运行前声明）</p>
        <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-secondary">
          <li>执行方式：{recipeRunAccounting(recipe.kind)}</li>
          <li>权限：工具 {recipe.permissions.tools.join('、') || '无'} · 允许模型调用：{recipe.permissions.allowModelCalls ? `是（上限 ${recipe.permissions.maxModelCallsPerRun}）` : '否'}</li>
          <li>预算：模型 {recipe.budget.maxModelCalls} 次 · 工具 {recipe.budget.maxToolCalls} 次 · 时长 ≤ {formatDuration(recipe.budget.maxRuntimeMs)}</li>
        </ul>
      </div>

      <div>
        <p className="text-[11px] font-medium text-ink-secondary">输入参数与步骤</p>
        <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-secondary">
          {recipe.inputParameters.map((parameter) => (
            <li key={parameter.name}>
              <span className="font-mono text-ink-primary">{parameter.name}</span> · {parameter.type}
              {parameter.required ? ' · 必填' : ' · 可选'} · {parameter.description || '无说明'}
            </li>
          ))}
        </ul>
        <details className="mt-1">
          <summary className="ca-focus-ring min-h-8 cursor-pointer rounded text-[11px] text-ink-secondary">展开步骤（{recipe.steps.length} 步，确定性顺序）</summary>
          <ol className="mt-1 space-y-0.5 text-[11px] text-ink-secondary">
            {recipe.steps.map((step) => (
              <li key={step.id}>
                {step.id} · {step.title || step.kind} <span className="text-ink-secondary">({step.kind})</span>
              </li>
            ))}
          </ol>
        </details>
      </div>

      <div>
        <p className="text-[11px] font-medium text-ink-secondary">测试用例</p>
        <ul className="mt-0.5 space-y-0.5">
          {testCases.map((testCase) => (
            <li key={testCase.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <StatusBadge
                label={testCase.status === 'passed' ? '通过' : testCase.status === 'failed' ? '失败' : '未测试'}
                tone={testCase.status === 'passed' ? 'success' : testCase.status === 'failed' ? 'danger' : 'muted'}
                ariaLabel="测试用例状态"
              />
              <span className="text-ink-primary">{testCase.label}</span>
              <Chip>{testCase.kind} · 预期{testCase.expectation === 'accept' ? '接受' : '拒绝'}</Chip>
              {testCase.detail && <span className="text-ink-secondary">{truncateText(testCase.detail, 60)}</span>}
            </li>
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" busy={pending} onClick={() => void validate()} icon={<FlaskConical aria-hidden="true" className="h-3.5 w-3.5" />}>
            运行测试用例
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenPanel('versions', { moduleId: recipe.sourceModuleId ?? undefined })}>
            查看来源版本
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowDisable((value) => !value)} aria-expanded={showDisable} icon={<ShieldOff aria-hidden="true" className="h-3.5 w-3.5" />}>
            禁用配方
          </Button>
        </div>
        {showDisable && (
          <div className="mt-1 rounded border border-failed/30 bg-failed/[0.05] p-2">
            <label htmlFor="recipe-disable-reason" className="text-[11px] text-ink-primary">
              禁用原因（会记录事件）
            </label>
            <TextInput id="recipe-disable-reason" value={disableReason} onChange={(event) => setDisableReason(event.target.value)} className="mt-1" maxLength={2000} />
            <div className="mt-1 flex gap-1.5">
              <Button size="sm" variant="danger" busy={pending} disabledReason={disableReason.trim().length === 0 ? '请填写禁用原因。' : null} onClick={() => void disable()}>
                确认禁用
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowDisable(false)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
        <p className="text-[11px] font-medium text-ink-secondary">用新数据运行（先校验输入，再实际执行）</p>
        <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
          {recipe.inputParameters.map((parameter) => (
            <Field key={parameter.name} label={`${parameter.name}（${parameter.type}）`} htmlFor={`recipe-input-${parameter.name}`} error={inputErrors[parameter.name]} help={parameter.description || undefined} required={parameter.required}>
              <TextInput
                id={`recipe-input-${parameter.name}`}
                value={inputs[parameter.name] ?? ''}
                onChange={(event) => setInputs((current) => ({ ...current, [parameter.name]: event.target.value }))}
                placeholder={parameter.type === 'object' ? '{"key":"value"}' : parameter.type === 'source' ? '资料标识或名称' : parameter.type === 'boolean' ? 'true / false' : parameter.type}
              />
            </Field>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button
            size="md"
            variant="primary"
            busy={pending || running}
            disabledReason={!canRunRecipe(recipe.status) ? '只有已验证的配方可以直接运行；请先完成测试。' : null}
            onClick={() => void run()}
            icon={<Play aria-hidden="true" className="h-4 w-4" />}
          >
            运行配方
          </Button>
          <Button size="md" variant="ghost" onClick={() => setInputs({})}>
            清空输入
          </Button>
          <span className="text-[11px] text-ink-secondary">运行输出先成为新草稿，经相同的验证与接受流程后才更新中心成果。</span>
        </div>
        {runResult && <p className="mt-1 rounded border border-accepted/30 bg-accepted/[0.05] px-2 py-1 text-[11px] text-ink-primary">{runResult}</p>}
      </div>
    </div>
  );
}

function SaveCandidateCard({ snapshot, onOpenEvents, onClose }: { snapshot: TaskSnapshot; onOpenEvents: () => void; onClose: () => void }): JSX.Element {
  const core = useCore();
  const { pending } = useCommandPending();
  const eligibleRuns = snapshot.runs.filter((run) => run.state === 'COMPLETED' || run.state === 'AWAITING_REVIEW');
  const [runId, setRunId] = useState<string>(eligibleRuns[0]?.runId ?? '');
  const [name, setName] = useState('从运行保存的候选配方');
  const [kind, setKind] = useState<'deterministic' | 'llm_assisted' | 'cached_snapshot'>('deterministic');
  const [description, setDescription] = useState('');
  const [applicability, setApplicability] = useState('');
  const [proposal, setProposal] = useState<RecipeProposalInput | null>(null);
  const [traceStepCount, setTraceStepCount] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const propose = async (): Promise<void> => {
    setError(null);
    setFeedback(null);
    const envelope = commandEnvelope();
    const result = await core.runCommand(
      '提取候选配方',
      (client) => client.proposeRecipe({ ...envelope, runId: runId as never, name, description, kind, applicability }),
      { successNotice: '已从运行提取候选配方，请人工审阅后注册。' },
    );
    if (result) {
      setProposal(result.proposal);
      setTraceStepCount(result.traceStepCount);
    } else {
      setError('提取失败：运行可能没有可复用步骤，或服务端尚未实现该接口。');
    }
  };

  const register = async (): Promise<void> => {
    if (!proposal) return;
    const envelope = commandEnvelope();
    const result = await core.runCommand(
      '注册候选配方',
      (client) => client.createRecipe({ ...envelope, proposal }),
      { successNotice: '候选配方已注册；运行测试后才能直接复用。' },
    );
    if (result) {
      setFeedback(`已注册候选配方：${result.recipe.name} v${result.version} · 状态 ${recipeStatusLabel(result.status)}`);
      setProposal(null);
    }
  };

  return (
    <Card title="从已审阅运行保存候选配方" subtitle="步骤由服务端 Recipe Extractor 提取，前端不臆造工作流；人工审阅后再注册。">
      {eligibleRuns.length === 0 ? (
        <EmptyState compact title="暂无可提取的运行" description="只有完成或待审阅的运行可以保存为配方；失败/取消的运行不能伪装成可复用程序。" />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="来源运行" htmlFor="recipe-run" required>
              <Select id="recipe-run" value={runId} onChange={(event) => setRunId(event.target.value)}>
                {eligibleRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId.slice(0, 8)} · {runStateLabel(run.state)} · {run.origin}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="配方类型" htmlFor="recipe-kind" required help="确定性配方不得包含模型调用；LLM 辅助配方必须声明模型调用预算。">
              <Select id="recipe-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="deterministic">确定性规则（0 次 LLM 调用）</option>
                <option value="llm_assisted">LLM 辅助</option>
                <option value="cached_snapshot">缓存快照</option>
              </Select>
            </Field>
            <Field label="配方名称" htmlFor="recipe-name" required>
              <TextInput id="recipe-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
            </Field>
            <Field label="适用范围" htmlFor="recipe-scope" help="不适用的数据必须被拒绝，而不是静默改写规则。">
              <TextInput id="recipe-scope" value={applicability} onChange={(event) => setApplicability(event.target.value)} maxLength={2000} placeholder="例如：字段映射已知、主键为大小写敏感字符串的 CSV" />
            </Field>
          </div>
          <Field label="说明" htmlFor="recipe-description">
            <TextArea id="recipe-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} className="min-h-[56px]" />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" busy={pending} disabledReason={runId ? null : '请选择来源运行。'} onClick={() => void propose()} icon={<Save aria-hidden="true" className="h-3.5 w-3.5" />}>
              提取候选配方
            </Button>
            <Button size="sm" variant="ghost" onClick={onOpenEvents}>
              查看运行证据
            </Button>
          </div>
          {error && <p role="alert" className="text-[11px] text-failed">{error}</p>}
          {feedback && <p className="text-[11px] text-accepted">{feedback}</p>}
          {proposal && (
            <div className="rounded border border-anchor/30 bg-anchor/[0.04] px-2 py-1.5">
              <p className="text-xs font-medium text-ink-primary">人工审阅：候选配方 v1（来源步骤 {traceStepCount ?? proposal.steps.length} 条）</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Chip>{recipeKindLabel(proposal.kind)}</Chip>
                <Chip>参数 {proposal.inputParameters.length}</Chip>
                <Chip>步骤 {proposal.steps.length}</Chip>
                <Chip>测试用例 {proposal.testCases.length}</Chip>
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-ink-secondary">
                {proposal.inputParameters.map((parameter) => (
                  <li key={parameter.name}>
                    <span className="font-mono text-ink-primary">{parameter.name}</span> · {parameter.type} · {parameter.required ? '必填' : '可选'}
                  </li>
                ))}
                {proposal.steps.map((step) => (
                  <li key={step.id}>
                    {step.id} · {step.title || step.kind} ({step.kind})
                  </li>
                ))}
              </ul>
              <details className="mt-1">
                <summary className="ca-focus-ring min-h-8 cursor-pointer rounded text-[11px] text-ink-secondary">查看原始提案 JSON</summary>
                <pre className="ca-scroll mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/25 p-2 font-mono text-[11px] text-ink-secondary">
                  {safeJsonPreview(proposal, 2400)}
                </pre>
              </details>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button size="sm" variant="primary" busy={pending} onClick={() => void register()}>
                  注册候选配方
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
                  放弃
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  稍后处理
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export { Chip };
