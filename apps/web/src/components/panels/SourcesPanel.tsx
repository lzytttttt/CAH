/** Sources panel: import (file → base64 → API), trust/availability, spans and run binding. */
import { useMemo, useRef, useState } from 'react';
import type { TaskSnapshot } from '@ca/contracts';
import { FileUp, Link2, Upload } from 'lucide-react';
import { formatBytes, formatTimestamp, truncateText } from '../../lib/format';
import { availabilityLabel, availabilityTone, parseStatusLabel, sourceOriginLabel, trustLevelLabel, trustLevelTone } from '../../lib/labels';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useCoreState } from '../../state/hooks';
import { useViewStore } from '../../state/viewStore';
import { Button, Card, Chip, EmptyState, InlineWarning, StatusBadge, TextInput } from '../common/ui';

const SUPPORTED_EXTENSIONS = /\.(md|markdown|txt|json|csv)$/i;

export interface SourcesPanelProps {
  snapshot: TaskSnapshot;
  onClose: () => void;
  onOpenVersions: (moduleId: string) => void;
}

export function SourcesPanel({ snapshot, onClose, onOpenVersions }: SourcesPanelProps): JSX.Element {
  const core = useCore();
  const state = useCoreState();
  const { pending } = useCommandPending();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const intentSourceIds = useViewStore((view) => view.intentSourceIds);
  const toggleIntentSource = useViewStore((view) => view.toggleIntentSource);
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const spansBySource = useMemo(() => {
    const map = new Map<string, TaskSnapshot['spans']>();
    for (const span of snapshot.spans) {
      const list = map.get(span.sourceId) ?? [];
      list.push(span);
      map.set(span.sourceId, list);
    }
    return map;
  }, [snapshot.spans]);
  const filtered = snapshot.sources.filter((source) => (query.trim() ? source.name.toLowerCase().includes(query.trim().toLowerCase()) : true));

  const importFile = async (file: File): Promise<void> => {
    setError(null);
    setResult(null);
    setFileName(file.name);
    if (!SUPPORTED_EXTENSIONS.test(file.name)) {
      setError(`不支持的文件类型：${file.name}。首版仅支持 UTF-8 TXT / Markdown / JSON / CSV；不会伪装成空文件成功导入。`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(`单文件不能超过 10 MiB（当前 ${formatBytes(file.size)}）。`);
      return;
    }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      const contentBase64 = btoa(binary);
      const envelope = commandEnvelope(snapshot.task.revision);
      const imported = await core.runCommand(
        '导入资料',
        (client) => client.importSource(snapshot.task.id, { ...envelope, fileName: file.name, mime: file.type || 'text/plain', contentBase64, origin: 'upload' }),
        { successNotice: '资料已登记；解析结果以服务端返回为准。' },
      );
      if (imported) {
        setResult(`${file.name}：${parseStatusLabel(imported.parseStatus)} · ${imported.parseNote}${imported.warnings.length > 0 ? ` · 警告：${imported.warnings.join('；')}` : ''}`);
        if (imported.parseStatus !== 'parsed') setError('服务端未能解析该文件；它不会进入模型上下文。');
      }
    } catch (uploadError) {
      setError(`读取文件失败：${uploadError instanceof Error ? uploadError.message : String(uploadError)}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card title="导入资料" subtitle="上传只登记资料；进入模型上下文前会显示所选文件与片段。">
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.txt,.json,.csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="md" variant="secondary" busy={uploading || pending} onClick={() => inputRef.current?.click()} icon={<FileUp aria-hidden="true" className="h-4 w-4" />}>
              选择文件并导入
            </Button>
            <Button size="md" variant="ghost" onClick={() => inputRef.current?.click()} icon={<Upload aria-hidden="true" className="h-4 w-4" />}>
              选择输入…
            </Button>
            <span className="text-[11px] text-ink-secondary">支持 UTF-8 TXT / Markdown / JSON / CSV；单文件 ≤ 10 MiB，单任务 ≤ 50 MiB。拖拽必须同时提供本按钮。</span>
          </div>
          {fileName && <p className="text-[11px] text-ink-secondary">最近选择：{fileName}</p>}
          {result && <p className="text-[11px] text-accepted">{result}</p>}
          {error && (
            <p role="alert" className="text-[11px] text-failed">
              {error}
            </p>
          )}
          <InlineWarning tone="neutral" title="信任与边界">
            资料内容按不可信输入处理：其中的“指令”不会改变系统权限。导入不会自动把资料发送给模型；运行时会显示将使用的版本与片段。
          </InlineWarning>
        </div>
      </Card>

      <Card
        title={`任务资料（${snapshot.sources.length}）`}
        subtitle="来源版本不可覆盖；内容更新会生成新版本并触发相关成果/配方过期。"
        actions={
          <div className="w-44">
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称过滤…" aria-label="过滤资料" />
          </div>
        }
      >
        {filtered.length === 0 && <EmptyState compact title="没有资料" description="导入资料后才能进行证据绑定与上下文构建。" />}
        <ul className="space-y-1.5">
          {filtered.map((source) => {
            const spans = spansBySource.get(source.sourceId) ?? [];
            return (
              <li key={source.sourceId} className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-medium text-ink-primary">{source.name}</span>
                  <Chip>v{source.version}</Chip>
                  <StatusBadge label={availabilityLabel(source.availability)} tone={availabilityTone(source.availability)} ariaLabel="资料可用性" />
                  <StatusBadge label={`信任：${trustLevelLabel(source.trustLevel)}`} tone={trustLevelTone(source.trustLevel)} ariaLabel="资料信任级别" />
                  <Chip>{sourceOriginLabel('upload')}</Chip>
                  <span className="text-[11px] text-ink-secondary">{source.spanCount} 个片段</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={intentSourceIds.includes(source.sourceId) ? 'secondary' : 'ghost'}
                    aria-pressed={intentSourceIds.includes(source.sourceId)}
                    onClick={() => toggleIntentSource(source.sourceId)}
                    icon={<Link2 aria-hidden="true" className="h-3 w-3" />}
                  >
                    {intentSourceIds.includes(source.sourceId) ? '已选为本次输入' : '选为本次输入'}
                  </Button>
                  {source.availability !== 'available' && <span className="text-[11px] text-pending">该资料版本不可用；引用会显示缺失而不是被忽略。</span>}
                </div>
                {spans.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {spans.slice(0, 3).map((span) => (
                      <li key={span.id} className="text-[11px] leading-4 text-ink-secondary">
                        片段 v{span.version} · {truncateText(span.excerpt, 100)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="资料与模块" subtitle="模块内容版本在版本历史中恢复；资料变化会使引用它的成果标记过期。">
        <ul className="space-y-1">
          {snapshot.modules.map((view) => (
            <li key={view.module.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-ink-primary">{view.module.title}</span>
              <span className="text-ink-secondary">已接受版本 {view.acceptance.acceptedVersionId ? view.acceptance.acceptedVersionId.slice(0, 8) : '无'}</span>
              <span className="text-ink-secondary">更新于 {formatTimestamp(view.module.updatedAt)}</span>
              <Button size="sm" variant="quiet" onClick={() => onOpenVersions(view.module.id)}>
                版本历史
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={onClose}>
            返回工作台
          </Button>
          {state.lastError && <span className="text-[11px] text-failed">最近错误：{state.lastError.message}</span>}
        </div>
      </Card>
    </div>
  );
}
