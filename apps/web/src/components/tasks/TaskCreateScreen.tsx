/** Task creation screen: title/intent/artifact + template or custom module list (1–8). */
import { useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import type { CreateTaskRequest } from '@ca/contracts';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useNavigate } from '../../state/hooks';
import { Button, Card, Chip, ErrorNotice, Field, Select, TextArea, TextInput } from '../common/ui';

const BUILT_IN_TEMPLATE_ID = 'cognitive-atrium';

const BUILT_IN_MODULES = [
  { title: '核心架构拓扑', kind: 'json' as const },
  { title: '多模态交互引擎规范', kind: 'markdown' as const },
  { title: '存量系统兼容层清洗', kind: 'csv' as const },
  { title: '商业化价值壁垒矩阵', kind: 'csv' as const },
];

interface CustomModule {
  title: string;
  kind: 'markdown' | 'json' | 'csv';
}

export function TaskCreateScreen(): JSX.Element {
  const core = useCore();
  const navigate = useNavigate();
  const { pending } = useCommandPending();
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [artifactTitle, setArtifactTitle] = useState('');
  const [useTemplate, setUseTemplate] = useState(true);
  const [customModules, setCustomModules] = useState<CustomModule[]>([{ title: '模块 1', kind: 'markdown' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const titleError = title.trim().length === 0 ? '任务标题不能为空。' : null;
  const intentError = intent.trim().length < 2 ? '请至少输入 2 个字符的任务意图。' : null;
  const artifactError = artifactTitle.trim().length === 0 ? '交付物名称不能为空。' : null;
  const modulesError = !useTemplate && customModules.some((module) => module.title.trim().length === 0) ? '自定义模块名称不能为空。' : null;
  const disabledReason = titleError ?? intentError ?? artifactError ?? modulesError;

  const submit = async (): Promise<void> => {
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const envelope = commandEnvelope();
      const moduleInputs = useTemplate
        ? []
        : customModules.map((module, index) => ({
            key: `m${index + 1}`,
            title: module.title.trim().slice(0, 200),
            kind: module.kind,
            order: index,
            acceptanceCriteria: [],
            dependsOnKeys: [],
            intentHint: '',
          }));
      const request: CreateTaskRequest = {
        ...envelope,
        title: title.trim().slice(0, 200),
        intent: intent.trim().slice(0, 8000),
        artifactTitle: artifactTitle.trim().slice(0, 200),
        constraints: [],
        templateId: useTemplate ? BUILT_IN_TEMPLATE_ID : null,
        modules: moduleInputs as never,
      };
      const result = await core.runCommand('新建任务', (client) => client.createTask(request), { successNotice: '任务已创建。', refresh: false });
      if (result) {
        await core.loadTasks();
        navigate({ name: 'task', taskId: result.taskId });
      } else {
        setError('创建失败；请查看顶部错误提示。已填内容会保留。');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto p-4 ca-scroll">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink-primary">新建任务</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">任务包含恰好一个中心交付物清单，可含 1–8 个模块；依赖必须无环。</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'tasks' })} icon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}>
          返回任务列表
        </Button>
      </div>

      <Card title="任务信息">
        <div className="flex flex-col gap-2.5">
          <Field label="任务标题" htmlFor="create-title" required error={title.trim().length === 0 ? titleError : null}>
            <TextInput id="create-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="例如：次世代智能工作空间产品架构与 GTM 策略中枢" />
          </Field>
          <Field label="中心交付物名称" htmlFor="create-artifact" required error={artifactTitle.trim().length === 0 ? artifactError : null} help="中心锚点展示的唯一交付物清单名称。">
            <TextInput id="create-artifact" value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} maxLength={200} placeholder="例如：产品架构与 GTM 策略中枢交付物" />
          </Field>
          <Field label="任务意图" htmlFor="create-intent" required error={intent.trim().length < 2 ? intentError : null} help="描述目标、输入范围与约束；进入任务后仍可在意图胶囊中细化并保存草稿。">
            <TextArea id="create-intent" value={intent} onChange={(event) => setIntent(event.target.value)} maxLength={8000} className="min-h-[120px]" placeholder="例如：依据产品 brief、约束清单与存量系统数据，形成四个模块成果；所有市场结论必须标记为待验证假设。" />
          </Field>
        </div>
      </Card>

      <Card title="模块结构" subtitle="内置四模块模板与设计文档场景一致；也可以自定义 1–8 个模块。">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={useTemplate ? 'secondary' : 'ghost'} onClick={() => setUseTemplate(true)} aria-pressed={useTemplate}>
            使用内置四模块模板
          </Button>
          <Button size="sm" variant={!useTemplate ? 'secondary' : 'ghost'} onClick={() => setUseTemplate(false)} aria-pressed={!useTemplate}>
            自定义模块
          </Button>
          {useTemplate && <span className="text-[11px] text-ink-secondary">模板：{BUILT_IN_MODULES.map((module) => module.title).join(' / ')}</span>}
        </div>

        {!useTemplate && (
          <div className="mt-2 flex flex-col gap-1.5">
            {customModules.map((module, index) => (
              <div key={index} className="flex flex-wrap items-end gap-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <div className="min-w-[12rem] flex-1">
                  <Field label={`模块 ${index + 1} 名称`} htmlFor={`custom-module-${index}`}>
                    <TextInput
                      id={`custom-module-${index}`}
                      value={module.title}
                      onChange={(event) => setCustomModules((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, title: event.target.value } : item)))}
                      maxLength={200}
                    />
                  </Field>
                </div>
                <div className="w-32">
                  <Field label="类型" htmlFor={`custom-kind-${index}`}>
                    <Select
                      id={`custom-kind-${index}`}
                      value={module.kind}
                      onChange={(event) => setCustomModules((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, kind: event.target.value as CustomModule['kind'] } : item)))}
                    >
                      <option value="markdown">Markdown</option>
                      <option value="json">JSON</option>
                      <option value="csv">CSV</option>
                    </Select>
                  </Field>
                </div>
                <Button size="sm" variant="ghost" aria-label={`删除模块 ${index + 1}`} disabled={customModules.length <= 1} onClick={() => setCustomModules((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                {index < customModules.length - 1 && <Chip>顺序 {index + 1} → {index + 2}</Chip>}
              </div>
            ))}
            <Button
              size="sm"
              variant="quiet"
              disabled={customModules.length >= 8}
              disabledReason={customModules.length >= 8 ? '首版最多 8 个模块。' : null}
              onClick={() => setCustomModules((current) => [...current, { title: `模块 ${current.length + 1}`, kind: 'markdown' }])}
              icon={<Plus aria-hidden="true" className="h-3.5 w-3.5" />}
            >
              添加模块
            </Button>
          </div>
        )}
      </Card>

      {error && <ErrorNotice compact title="无法创建任务" message={error} guidance={['表单内容仍保留在页面上，修正后可以重试。']} />}

      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Button size="lg" variant="primary" busy={pending || busy} disabledReason={disabledReason} onClick={() => void submit()}>
          创建任务并进入工作台
        </Button>
        <Button size="lg" variant="ghost" onClick={() => navigate({ name: 'tasks' })}>
          取消
        </Button>
        <span className="text-[11px] text-ink-secondary">创建任务不会调用模型；意图执行仍需在任务空间内发起运行并经过计划预览。</span>
      </div>
    </div>
  );
}
