/** Version history + restore (restore creates a new immutable version; alerts downstream stale). */
import { useEffect, useState } from 'react';
import type { ModuleContentResponse, TaskSnapshot, VersionListResponse } from '@ca/contracts';
import { History, RotateCcw } from 'lucide-react';
import { formatTimestamp, safeJsonPreview, truncateText } from '../../lib/format';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore } from '../../state/hooks';
import { Button, Card, Chip, EmptyState, ErrorNotice, LoadingBlock, Select, StatusBadge, TextArea } from '../common/ui';

export interface VersionsPanelProps {
  snapshot: TaskSnapshot;
  initialModuleId: string | null;
  onClose: () => void;
  onOpenEvents: () => void;
}

export function VersionsPanel({ snapshot, initialModuleId, onClose, onOpenEvents }: VersionsPanelProps): JSX.Element {
  const core = useCore();
  const { pending } = useCommandPending();
  const [moduleId, setModuleId] = useState(initialModuleId ?? snapshot.modules[0]?.module.id ?? '');
  const [versions, setVersions] = useState<VersionListResponse | null>(null);
  const [content, setContent] = useState<ModuleContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showRestore, setShowRestore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!moduleId) return () => undefined;
    setLoading(true);
    setError(null);
    setVersions(null);
    setContent(null);
    void core
      .read('读取版本历史', async (client) => {
        const list = await client.getVersions(snapshot.task.id, moduleId);
        const detail = await client.getModuleContent(snapshot.task.id, moduleId);
        return { list, detail };
      })
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setError('版本历史读取失败；已接受成果不受影响。');
          return;
        }
        setVersions(result.list);
        setContent(result.detail);
        setSelectedVersionId(result.list.versions.find((version) => version.isCurrent)?.versionId ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [core, moduleId, snapshot.task.id]);

  const moduleView = snapshot.modules.find((view) => view.module.id === moduleId) ?? null;
  const selectedVersion = versions?.versions.find((version) => version.versionId === selectedVersionId) ?? null;

  const restore = async (): Promise<void> => {
    if (!moduleView || !selectedVersion) return;
    const envelope = commandEnvelope(snapshot.task.revision);
    const result = await core.runCommand(
      '恢复历史版本',
      (client) =>
        client.restoreVersion(snapshot.artifact.id, {
          ...envelope,
          expectedRevision: snapshot.task.revision,
          moduleId: moduleView.module.id,
          versionId: selectedVersion.versionId,
          note: note.trim(),
        }),
      { successNotice: '历史版本已恢复为新的已接受版本（历史不被改写）。' },
    );
    if (result) {
      setShowRestore(false);
      setNote('');
      void core.refreshSnapshot({ quiet: false });
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card title="选择模块" subtitle="恢复历史版本会创建内容相同的新版本，并触发下游模块过期检测。">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <Select value={moduleId} onChange={(event) => setModuleId(event.target.value)} aria-label="选择模块">
              {snapshot.modules.map((view) => (
                <option key={view.module.id} value={view.module.id}>
                  {view.module.title}
                </option>
              ))}
            </Select>
          </div>
          {moduleView && (
            <Chip>
              当前已接受：{moduleView.acceptance.acceptedVersionId ? moduleView.acceptance.acceptedVersionId.slice(0, 8) : '无'}
            </Chip>
          )}
          <Button size="sm" variant="ghost" onClick={onOpenEvents}>
            查看恢复事件
          </Button>
        </div>
      </Card>

      {loading && <LoadingBlock label="正在读取版本历史…" />}
      {error && <ErrorNotice compact title="版本历史不可用" message={error} guidance={['已接受成果保存在后端，不受读取失败影响。']} />}

      {versions && (
        <Card title={`版本列表（${versions.versions.length}）`} subtitle="已接受版本不可变；最新恢复操作会产生新版本。">
          {versions.versions.length === 0 && <EmptyState compact title="该模块还没有已接受版本" description="接受候选成果后会生成第一个不可变版本。" />}
          <ul className="space-y-1.5">
            {versions.versions.map((version, index) => {
              const isSelected = selectedVersionId === version.versionId;
              return (
                <li key={version.versionId} className={isSelected ? 'rounded border border-anchor/50 bg-anchor/[0.04] px-2 py-1.5' : 'rounded border border-white/10 bg-black/20 px-2 py-1.5'}>
                  <button type="button" className="ca-focus-ring flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded text-left" onClick={() => setSelectedVersionId(version.versionId)} aria-pressed={isSelected}>
                    <StatusBadge label={version.isCurrent ? '当前版本' : `历史 #${versions.versions.length - index}`} tone={version.isCurrent ? 'success' : 'muted'} ariaLabel="版本状态" />
                    <span className="font-mono text-xs text-ink-primary">{version.versionId.slice(0, 8)}</span>
                    <Chip>哈希 {version.contentHash.slice(0, 8)}</Chip>
                    <span className="text-[11px] text-ink-secondary">
                      {formatTimestamp(version.acceptedAt)} · {version.acceptedBy}
                      {version.sourceRunId ? ` · 来源运行 ${version.sourceRunId.slice(0, 8)}` : ''}
                    </span>
                    {version.note && <span className="text-[11px] text-ink-secondary">备注：{truncateText(version.note, 60)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {content && (
        <Card title="当前内容预览" subtitle={content.versionId ? `版本 ${content.versionId.slice(0, 8)}` : '尚无已接受版本'}>
          <pre className="ca-scroll max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-black/25 p-2 font-mono text-[11px] leading-4 text-ink-secondary">
            {content.content ? safeJsonPreview(content.content, 4000) : '（内容为空）'}
          </pre>
        </Card>
      )}

      {selectedVersion && versions && (
        <Card title="恢复所选版本" subtitle="恢复不会删除任何历史版本，也不会改写已执行记录。">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip>目标版本 {selectedVersion.versionId.slice(0, 8)}</Chip>
              <Chip>expectedRevision {snapshot.task.revision}</Chip>
              {selectedVersion.isCurrent && <StatusBadge label="当前已是该版本" tone="muted" />}
            </div>
            {!showRestore ? (
              <div className="flex flex-wrap gap-1.5">
                <Button size="md" variant="secondary" onClick={() => setShowRestore(true)} icon={<RotateCcw aria-hidden="true" className="h-4 w-4" />}>
                  准备恢复
                </Button>
                <Button size="md" variant="ghost" onClick={onClose}>
                  返回工作台
                </Button>
              </div>
            ) : (
              <div className="rounded border border-pending/30 bg-pending/[0.04] p-2">
                <label htmlFor="restore-note" className="text-[11px] text-ink-primary">
                  恢复备注（写入新版本记录）
                </label>
                <TextArea id="restore-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} className="mt-1 min-h-[56px]" placeholder="例如：回退到已核验的架构版本，等待重新生成交互规范。" />
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="primary" busy={pending} disabledReason={selectedVersion.isCurrent ? '当前已接受版本就是该版本；恢复会产生内容相同的新版本。' : null} onClick={() => void restore()} icon={<History aria-hidden="true" className="h-3.5 w-3.5" />}>
                    确认恢复为新版本
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowRestore(false)}>
                    取消
                  </Button>
                  <span className="text-[11px] text-ink-secondary">恢复后依赖该模块的成果会标记过期，需要重新验证。</span>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
