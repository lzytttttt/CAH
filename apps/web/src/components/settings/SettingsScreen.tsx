/**
 * Settings screen: provider connections (masked credentials + capability test),
 * workspace policy toggles (auto-accept default OFF) and Demo/Live mode switch.
 * No credential value is ever read back or stored in the browser.
 */
import { useEffect, useState } from 'react';
import type { CapabilityReport, ProviderProfilePublic, SessionInfo, WorkspaceSettings, WorkspaceView } from '@ca/contracts';
import { ArrowLeft, KeyRound, PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatTimestamp } from '../../lib/format';
import {
  adapterTypeLabel,
  capabilityStatusLabel,
  capabilityStatusTone,
  modeLabel,
  modeTone,
  probeLabel,
} from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState, useNavigate } from '../../state/hooks';
import { useViewStore } from '../../state/viewStore';
import { Button, Card, Checkbox, Chip, EmptyState, ErrorNotice, Field, InlineWarning, Select, StatusBadge, TextInput, Toggle } from '../common/ui';

const PROBES = ['auth_and_text', 'streaming', 'tool_calling', 'structured_output', 'usage'] as const;
type ProbeName = (typeof PROBES)[number];

const ADAPTERS = ['openai_compatible', 'anthropic_native', 'openai_responses'] as const;

export function SettingsScreen(): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const navigate = useNavigate();
  const { pending } = useCommandPending();
  const reducedMotion = useViewStore((view) => view.reducedMotion);
  const setReducedMotion = useViewStore((view) => view.setReducedMotion);
  const workspace = state.workspace;
  const session = state.session;
  const [settings, setSettings] = useState<WorkspaceSettings | null>(workspace?.workspace.settings ?? null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) setSettings(workspace.workspace.settings);
  }, [workspace]);

  const activeRuns = (state.tasks?.tasks ?? []).filter((task) => task.activeRunState != null);
  const modeBusy = pending;

  const switchMode = async (mode: 'demo' | 'live'): Promise<void> => {
    const envelope = commandEnvelope();
    const result = await core.runCommand('切换工作区模式', (client) => client.setWorkspaceMode({ ...envelope, mode }), {
      successNotice: `已切换到${modeLabel(mode)}模式；请重新读取会话与任务列表。`,
      refresh: false,
    });
    if (result) {
      await core.boot();
    }
  };

  const saveSettings = async (): Promise<void> => {
    if (!settings) return;
    setSettingsError(null);
    setSettingsSaved(null);
    const envelope = commandEnvelope();
    const result = await core.runCommand('保存工作区策略', (client) => client.updateWorkspace({ ...envelope, settings }), {
      successNotice: '工作区策略已保存。',
      refresh: false,
    });
    if (result) {
      await core.refreshWorkspace();
      setSettingsSaved('已保存；自动接受策略仍然默认关闭，除非你明确开启。');
    } else {
      setSettingsError('保存失败；详见顶部错误提示。');
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 overflow-y-auto p-4 ca-scroll">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink-primary">连接与工作区设置</h1>
          <p className="mt-0.5 text-xs text-ink-secondary">设置按需打开，不把主工作台变成长期管理后台。浏览器永远不会收到明文字段。</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'tasks' })} icon={<ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />}>
            任务列表
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void core.refreshWorkspace()} icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}>
            刷新
          </Button>
        </div>
      </div>

      {state.workspaceError && <ErrorNotice compact title="工作区设置读取失败" message={state.workspaceError.message} traceId={state.workspaceError.traceId} onRetry={() => void core.refreshWorkspace()} />}

      <ModeCard session={session} workspace={workspace} activeRunCount={activeRuns.length} busy={modeBusy} onSwitch={(mode) => void switchMode(mode)} />

      <ProviderSection workspace={workspace} />

      <Card title="工作区策略" subtitle="默认关闭自动接受；所有策略变更会记录到后端并可能影响风险判定。">
        {!settings ? (
          <EmptyState compact title="设置未加载" description="请刷新工作区设置后重试。" />
        ) : (
          <div className="flex flex-col gap-2">
            <Toggle
              label="自动接受已验证草稿（默认关闭）"
              checked={settings.autoAcceptVerifiedDrafts}
              onChange={(next) => setSettings({ ...settings, autoAcceptVerifiedDrafts: next })}
              help="仅对低风险、确定性验证通过的任务生效；仍记录策略与版本，不能绕过 Schema、权限与版本检查。"
            />
            <Toggle
              label="离开页面时暂停运行"
              checked={settings.pauseWhenPageCloses}
              onChange={(next) => setSettings({ ...settings, pauseWhenPageCloses: next })}
              help="关闭页面不会自动完成或取消任务；后端仍受预算限制。"
            />
            <Toggle
              label="默认减少动态效果（工作区级）"
              checked={settings.reducedMotion}
              onChange={(next) => setSettings({ ...settings, reducedMotion: next })}
              help="与操作系统 prefers-reduced-motion 及本机视图开关取并集；业务步骤完全相同。"
            />
            <Toggle
              label="本机视图：减少动态效果"
              checked={reducedMotion}
              onChange={setReducedMotion}
              help="只保存在本地视图存储；不写入业务事件。"
            />
            <Field label="主题" htmlFor="theme-select" help="首版以深色为主；system 跟随系统。">
              <Select id="theme-select" value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value as WorkspaceSettings['theme'] })}>
                <option value="dark">深色（默认）</option>
                <option value="system">跟随系统</option>
              </Select>
            </Field>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Button size="md" variant="primary" busy={pending} onClick={() => void saveSettings()}>
                保存策略
              </Button>
              <Button size="md" variant="ghost" onClick={() => setSettings(workspace?.workspace.settings ?? null)}>
                重置未保存修改
              </Button>
              {settingsSaved && <span className="text-[11px] text-accepted">{settingsSaved}</span>}
              {settingsError && <span className="text-[11px] text-failed">{settingsError}</span>}
            </div>
          </div>
        )}
      </Card>

      <Card title="服务端信息" subtitle="只读信息来自后端会话与工作区视图。">
        <div className="flex flex-wrap gap-1.5">
          {session && <Chip>服务端版本 {session.serverVersion}</Chip>}
          {session && <Chip>策略版本 {session.policyVersion}</Chip>}
          {session && <Chip>已认证 {session.authenticated ? '是' : '否'}</Chip>}
          {workspace && <Chip>应用版本 {workspace.appVersion}</Chip>}
          {workspace && <Chip>Demo 可用 {workspace.demoAvailable ? '是' : '否'}</Chip>}
          {workspace && <Chip>Live 可用 {workspace.liveAvailable ? '是' : '否'}</Chip>}
          {workspace && <Chip>限制项 {Object.keys(workspace.limits).length}</Chip>}
          {session && <Chip>服务端时间 {formatTimestamp(session.serverTime)}</Chip>}
        </div>
        {workspace && Object.keys(workspace.limits).length > 0 && (
          <ul className="mt-1.5 grid gap-x-3 gap-y-0.5 text-[11px] text-ink-secondary sm:grid-cols-2">
            {Object.entries(workspace.limits).map(([key, value]) => (
              <li key={key}>
                <span className="font-mono text-ink-primary">{key}</span> = {value}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[11px] text-ink-secondary">
          导入/导出按任务进行：进入任务空间后从运行控制栏的“导出”入口或任务操作打开。任务包导入默认不激活配方，来源缺失时会标记需要重新绑定。
        </p>
      </Card>
    </div>
  );
}

function ModeCard({ session, workspace, activeRunCount, busy, onSwitch }: { session: SessionInfo | null; workspace: WorkspaceView | null; activeRunCount: number; busy: boolean; onSwitch: (mode: 'demo' | 'live') => void }): JSX.Element {
  const mode = session?.mode ?? workspace?.workspace.mode ?? 'demo';
  const available = session?.availableModes ?? ['demo'];
  const unavailableReason =
    activeRunCount > 0
      ? '存在活动运行，不能切换模式；请先结束或保留当前运行。'
      : !session?.liveProviderConfigured && mode === 'demo' && available.includes('live')
        ? null
        : null;
  return (
    <Card title="运行模式" subtitle="Demo 与 Live 数据物理隔离；Live 使用真实模型、工具与预算，失败时不会回退到演示数据。">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge label={`当前：${modeLabel(mode)}`} tone={modeTone(mode)} ariaLabel="当前模式" />
        {(['demo', 'live'] as const).map((target) => {
          const isCurrent = mode === target;
          const canSwitch = available.includes(target) && !isCurrent;
          return (
            <Button
              key={target}
              size="sm"
              variant={isCurrent ? 'secondary' : 'ghost'}
              busy={busy && canSwitch}
              disabled={!canSwitch}
              disabledReason={
                isCurrent
                  ? null
                  : !available.includes(target)
                    ? `后端未提供${modeLabel(target)}模式。`
                    : activeRunCount > 0
                      ? unavailableReason
                      : target === 'live' && !session?.liveProviderConfigured
                        ? '尚未配置可用的 Live 模型连接；请先保存并测试连接配置。'
                        : null
              }
              onClick={() => onSwitch(target)}
            >
              切换到{modeLabel(target)}
            </Button>
          );
        })}
        {activeRunCount > 0 && <StatusBadge label={`${activeRunCount} 个活动运行`} tone="pending" ariaLabel="活动运行数量" />}
      </div>
      {session && (
        <p className="mt-1 text-[11px] text-ink-secondary">
          后端可用模式：{session.availableModes.map((item) => modeLabel(item)).join(' / ')} · Demo 数据：{session.demoAvailable ? '可用' : '不可用'} · Live 连接：{session.liveProviderConfigured ? '已配置' : '未配置'}
        </p>
      )}
    </Card>
  );
}

function ProviderSection({ workspace }: { workspace: WorkspaceView | null }): JSX.Element {
  const core = useCore();
  const { pending } = useCommandPending();
  const profiles: ProviderProfilePublic[] = workspace?.providerProfiles ?? [];
  const [showForm, setShowForm] = useState(false);
  const [profileName, setProfileName] = useState('本地模型连接');
  const [adapterType, setAdapterType] = useState<(typeof ADAPTERS)[number]>('openai_compatible');
  const [baseURL, setBaseURL] = useState('http://127.0.0.1:11434/v1');
  const [model, setModel] = useState('');
  const [credentialRef, setCredentialRef] = useState('CA_OPENAI_API_KEY');
  const [credentialValue, setCredentialValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [testTarget, setTestTarget] = useState<string>('');
  const [probes, setProbes] = useState<ProbeName[]>(['auth_and_text']);
  const [confirmCharges, setConfirmCharges] = useState(false);
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const effectiveTarget = testTarget || profiles[0]?.id || '';

  const createProfile = async (): Promise<void> => {
    setFormError(null);
    setFormMessage(null);
    if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
      setFormError('地址必须是 http(s) URL；远程端点必须使用 HTTPS，本机回环地址可显式允许 HTTP。');
      return;
    }
    if (!model.trim() || !credentialRef.trim()) {
      setFormError('模型与凭据引用不能为空；凭据值只写不读。');
      return;
    }
    const envelope = commandEnvelope();
    const result = await core.runCommand(
      '保存连接配置',
      (client) =>
        client.createProviderProfile({
          ...envelope,
          profileName: profileName.trim().slice(0, 100),
          adapterType,
          baseURL: baseURL.trim(),
          model: model.trim(),
          credentialRef: credentialRef.trim(),
          credentialValue: credentialValue.length > 0 ? credentialValue : undefined,
          enabled: true,
        }),
      { successNotice: '连接配置已保存；凭据只写不读。', refresh: false },
    );
    if (result) {
      setFormMessage(`已保存连接：${result.profile.profileName} · 凭据状态：${result.profile.credentialConfigured ? '已配置' : '未配置'}${result.profile.credentialHint ? `（${result.profile.credentialHint}）` : ''}`);
      setCredentialValue('');
      setShowForm(false);
      await core.refreshWorkspace();
    } else {
      setFormError('保存失败；详见顶部错误提示。');
    }
  };

  const runTest = async (): Promise<void> => {
    if (!effectiveTarget) return;
    if (!confirmCharges) {
      setTestError('能力测试可能产生少量费用，需要先勾选“明确确认费用”。');
      return;
    }
    if (probes.length === 0) {
      setTestError('请选择至少一个能力测试项。');
      return;
    }
    setTestError(null);
    setTesting(true);
    const envelope = commandEnvelope();
    const result = await core.runCommand(
      '测试连接能力',
      (client) => client.testProviderProfile(effectiveTarget, { ...envelope, probes, confirmCharges }),
      { successNotice: '能力测试完成；结果按测试项如实显示。', refresh: false },
    );
    setTesting(false);
    if (result) setReport(result.report);
  };

  return (
    <Card
      title="模型连接"
      subtitle="凭据由后端环境变量或受限密钥文件读取；浏览器只得到已配置状态与掩码。HTTP 200 或“兼容 OpenAI”声明不能替代能力测试。"
      actions={
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setShowForm((value) => !value)} aria-expanded={showForm}>
            {showForm ? '收起表单' : '新增连接'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void core.refreshWorkspace()} icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}>
            刷新连接
          </Button>
        </div>
      }
    >
      {profiles.length === 0 ? (
        <EmptyState compact title="还没有连接配置" description="保存连接配置并分两步测试鉴权/文本与流式/工具调用等能力；未配置时 Live 模式不可用。" icon={<PlugZap aria-hidden="true" className="h-5 w-5" />} />
      ) : (
        <ul className="space-y-1.5">
          {profiles.map((profile) => (
            <li key={profile.id} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-ink-primary">{profile.profileName}</span>
                <Chip>{adapterTypeLabel(profile.adapterType)}</Chip>
                <Chip>{profile.model}</Chip>
                <Chip>{profile.baseURL}</Chip>
                <StatusBadge
                  label={profile.credentialConfigured ? '凭据已配置' : '凭据未配置'}
                  tone={profile.credentialConfigured ? 'success' : 'pending'}
                  ariaLabel="凭据状态"
                />
                {profile.credentialHint && <Chip>掩码：{profile.credentialHint}</Chip>}
                {profile.credentialError && <span className="text-[11px] text-failed">{profile.credentialError}</span>}
                <StatusBadge label={profile.enabled ? '已启用' : '已停用'} tone={profile.enabled ? 'accent' : 'muted'} ariaLabel="连接启用状态" />
                <Button size="sm" variant="quiet" className="ml-auto" onClick={() => setTestTarget(profile.id)}>
                  选择测试
                </Button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(['streaming', 'toolCalling', 'structuredOutput', 'usageReporting'] as const).map((capability) => (
                  <StatusBadge
                    key={capability}
                    label={`${capabilityLabel(capability)}：${capabilityStatusLabel(profile.capabilities[capability])}`}
                    tone={capabilityStatusTone(profile.capabilities[capability])}
                    ariaLabel="能力状态"
                  />
                ))}
                <Chip>检查时间 {profile.capabilities.checkedAt ? formatTimestamp(profile.capabilities.checkedAt) : '未测试'}</Chip>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="mt-2 rounded border border-white/10 bg-black/20 p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="连接名称" htmlFor="provider-name" required>
              <TextInput id="provider-name" value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={100} />
            </Field>
            <Field label="适配器类型" htmlFor="provider-adapter" required>
              <Select id="provider-adapter" value={adapterType} onChange={(event) => setAdapterType(event.target.value as typeof adapterType)}>
                {ADAPTERS.map((adapter) => (
                  <option key={adapter} value={adapter}>
                    {adapterTypeLabel(adapter)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="服务地址（baseURL）" htmlFor="provider-url" required help="远程必须 HTTPS；本机回环可显式允许 HTTP；不能访问云元数据地址。">
              <TextInput id="provider-url" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} maxLength={2048} />
            </Field>
            <Field label="模型名称" htmlFor="provider-model" required help="可手工输入；模型列表获取失败不能阻止已知模型配置。">
              <TextInput id="provider-model" value={model} onChange={(event) => setModel(event.target.value)} maxLength={200} placeholder="例如：gpt-4.1-mini / qwen2.5:14b" />
            </Field>
            <Field label="凭据引用（环境变量名）" htmlFor="provider-credential-ref" required help="后端从环境变量或受限密钥文件读取；不会回传明文。">
              <TextInput id="provider-credential-ref" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} maxLength={100} />
            </Field>
            <Field label="凭据值（可选，只写不读）" htmlFor="provider-credential-value" help="如后端支持加密保存，可在此写入；任何日志/导出都不会包含它。">
              <TextInput id="provider-credential-value" type="password" autoComplete="off" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} maxLength={4000} />
            </Field>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" busy={pending} onClick={() => void createProfile()} icon={<KeyRound aria-hidden="true" className="h-3.5 w-3.5" />}>
              保存连接
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              取消
            </Button>
            {formError && <span className="text-[11px] text-failed">{formError}</span>}
            {formMessage && <span className="text-[11px] text-accepted">{formMessage}</span>}
          </div>
        </div>
      )}

      <div className="mt-2 rounded border border-white/10 bg-black/20 p-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-ink-primary">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 text-accent" /> 能力测试（两步：先鉴权与基础文本，再显式选择能力项）
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <div className="w-56">
            <Select value={effectiveTarget} onChange={(event) => setTestTarget(event.target.value)} aria-label="选择要测试的连接">
              {profiles.length === 0 && <option value="">无可用连接</option>}
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.profileName}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" variant="secondary" busy={testing || pending} disabledReason={!effectiveTarget ? '请先保存连接配置。' : null} onClick={() => void runTest()}>
            运行能力测试
          </Button>
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          {PROBES.map((probe) => (
            <Checkbox
              key={probe}
              label={`${probeLabel(probe)}${probe === 'auth_and_text' ? '（基础）' : ''}`}
              checked={probes.includes(probe)}
              onChange={(event) => setProbes((current) => (event.target.checked ? [...current, probe] : current.filter((item) => item !== probe)))}
            />
          ))}
        </div>
        <Checkbox
          className="mt-1"
          label="我确认能力测试会产生少量真实调用并可能计费"
          checked={confirmCharges}
          onChange={(event) => setConfirmCharges(event.target.checked)}
          help="未明确确认时不会发起测试请求。"
        />
        {testError && <p role="alert" className="mt-1 text-[11px] text-failed">{testError}</p>}
        {report && (
          <div className="mt-1.5 rounded border border-white/10 bg-black/20 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-ink-primary">测试报告</span>
              <Chip>{report.serviceLabel}</Chip>
              <Chip>测试模型 {report.testedModel}</Chip>
              <Chip>请求数 {report.requestCount}</Chip>
              <Chip>估算费用 {report.estimatedCostUsd == null ? '未知' : `$${report.estimatedCostUsd.toFixed(4)}`}</Chip>
              <span className="text-[11px] text-ink-secondary">{formatTimestamp(report.startedAt)} → {formatTimestamp(report.finishedAt)}</span>
            </div>
            <table className="mt-1 w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-ink-secondary">
                  <th className="border-b border-white/10 py-0.5 pr-2">能力项</th>
                  <th className="border-b border-white/10 py-0.5 pr-2">状态</th>
                  <th className="border-b border-white/10 py-0.5 pr-2">延迟</th>
                  <th className="border-b border-white/10 py-0.5">说明</th>
                </tr>
              </thead>
              <tbody>
                {report.probes.map((probe) => (
                  <tr key={probe.capability} className="text-ink-primary">
                    <td className="border-b border-white/5 py-0.5 pr-2">{probeLabel(probe.capability)}</td>
                    <td className="border-b border-white/5 py-0.5 pr-2">
                      <StatusBadge label={capabilityStatusLabel(probe.status)} tone={capabilityStatusTone(probe.status)} ariaLabel="测试项状态" />
                    </td>
                    <td className="border-b border-white/5 py-0.5 pr-2">{probe.latencyMs == null ? '—' : `${probe.latencyMs} ms`}</td>
                    <td className="border-b border-white/5 py-0.5 text-ink-secondary">{probe.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-ink-secondary">HTTP 200、模型名称或“兼容 OpenAI”声明都不能替代功能测试；未测试项保持未知。</p>
          </div>
        )}
      </div>

      <InlineWarning tone="neutral" title="连接切换约束">
        运行中的连接配置不可悄悄更改；中途更换模型必须从明确检查点创建新尝试并重新校验计划与草稿。禁止自动把私人资料发送给备用供应商。
      </InlineWarning>
    </Card>
  );
}

function capabilityLabel(capability: 'streaming' | 'toolCalling' | 'structuredOutput' | 'usageReporting'): string {
  switch (capability) {
    case 'streaming':
      return '流式';
    case 'toolCalling':
      return '工具调用';
    case 'structuredOutput':
      return '结构化输出';
    case 'usageReporting':
      return '用量上报';
  }
}
