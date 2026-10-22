/** Export artifacts / task package and import a task package (untrusted input). */
import { useRef, useState } from 'react';
import type { ExportFormat, TaskSnapshot } from '@ca/contracts';
import { Download, FileUp, PackageOpen } from 'lucide-react';
import { formatBytes } from '../../lib/format';
import { commandEnvelope } from '../../lib/ids';
import { useCommandPending, useCore, useNavigate } from '../../state/hooks';
import { Button, Card, Checkbox, Chip, EmptyState, Field, Select, StatusBadge, cn } from '../common/ui';

const FORMATS: Array<{ id: ExportFormat; label: string; description: string }> = [
  { id: 'markdown', label: 'Markdown', description: '按模块实际类型导出可读成果' },
  { id: 'json', label: 'JSON', description: '结构化成果与版本信息' },
  { id: 'csv', label: 'CSV', description: '仅导出表格类模块' },
  { id: 'task_package', label: '任务包', description: 'manifest + 成果 + 选定来源 + 决策（脱敏）' },
];

export interface ExportPanelProps {
  snapshot: TaskSnapshot;
  onClose: () => void;
}

export function ExportPanel({ snapshot, onClose }: ExportPanelProps): JSX.Element {
  const core = useCore();
  const navigate = useNavigate();
  const { pending } = useCommandPending();
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [selectedModules, setSelectedModules] = useState<string[]>(() => snapshot.modules.filter((view) => view.acceptedContent != null).map((view) => view.module.id));
  const [includeSources, setIncludeSources] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ taskId: string; warnings: string[]; needsRebinding: boolean } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const exportNow = async (): Promise<void> => {
    setExportError(null);
    setExportResult(null);
    setExporting(true);
    try {
      const envelope = commandEnvelope();
      const response = await core.read('导出成果', (client) =>
        client.exportTask(snapshot.task.id, { ...envelope, format, moduleIds: selectedModules as never, includeSources }),
      );
      if (!response) {
        setExportError('导出失败；详见顶部错误提示。已接受成果不变。');
        return;
      }
      const bytes = Uint8Array.from(atob(response.contentBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: response.mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = response.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setExportResult(`已导出 ${response.fileName} · ${formatBytes(response.bytes)} · sha256 ${response.sha256.slice(0, 12)}…${response.redacted ? ' · 已脱敏' : ''}${response.warnings.length > 0 ? ` · ${response.warnings.join('；')}` : ''}`);
    } finally {
      setExporting(false);
    }
  };

  const importNow = async (file: File): Promise<void> => {
    setImportError(null);
    setImportResult(null);
    if (file.size > 128 * 1024 * 1024) {
      setImportError('任务包不能超过 128 MiB。');
      return;
    }
    setImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      const contentBase64 = btoa(binary);
      const envelope = commandEnvelope();
      const response = await core.runCommand('导入任务包', (client) => client.importTask({ ...envelope, fileName: file.name, contentBase64 }), {
        successNotice: '任务包已导入（不自动执行配方）。',
      });
      if (response) {
        setImportResult({ taskId: response.taskId, warnings: response.warnings, needsRebinding: response.sourcesNeedRebinding });
      }
    } catch (error) {
      setImportError(`读取任务包失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card title="导出成果" subtitle="按实际模块类型选择格式；任务包默认脱敏，不含凭据。">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="导出格式" htmlFor="export-format" required>
            <Select id="export-format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
              {FORMATS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} — {option.description}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="包含原始资料" htmlFor="export-sources" help="任务包默认排除密钥、凭据与私人配置；来源缺失时导入方会看到重新绑定提示。">
            <div className="flex min-h-10 items-center">
              <Checkbox id="export-sources" label="导出时携带已选资料（可能包含敏感内容）" checked={includeSources} onChange={(event) => setIncludeSources(event.target.checked)} />
            </div>
          </Field>
        </div>
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-ink-secondary">导出模块（{selectedModules.length}/{snapshot.modules.length}）</p>
          <ul className="mt-0.5 space-y-0.5">
            {snapshot.modules.map((view) => (
              <li key={view.module.id}>
                <Checkbox
                  label={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>{view.module.title}</span>
                      <Chip>{view.module.kind}</Chip>
                      {view.acceptedContent == null && <StatusBadge label="无已接受内容" tone="muted" />}
                    </span>
                  }
                  checked={selectedModules.includes(view.module.id)}
                  disabled={view.acceptedContent == null}
                  onChange={(event) =>
                    setSelectedModules((current) => (event.target.checked ? [...current, view.module.id] : current.filter((id) => id !== view.module.id)))
                  }
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            size="md"
            variant="primary"
            busy={pending || exporting}
            disabledReason={selectedModules.length === 0 ? '请选择至少一个含已接受内容的模块。' : null}
            onClick={() => void exportNow()}
            icon={<Download aria-hidden="true" className="h-4 w-4" />}
          >
            导出并下载
          </Button>
          <Button size="md" variant="ghost" onClick={onClose}>
            返回工作台
          </Button>
        </div>
        {exportResult && <p className="mt-1 text-[11px] text-accepted">{exportResult}</p>}
        {exportError && (
          <p role="alert" className="mt-1 text-[11px] text-failed">
            {exportError}
          </p>
        )}
      </Card>

      <Card title="导入任务包" subtitle="任务包视为不可信输入：校验版本、哈希与大小；不自动执行其中配方或激活连接。">
        <div className="flex flex-col gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.json,.ca,.capkg"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importNow(file);
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="md" variant="secondary" busy={importing || pending} onClick={() => importInputRef.current?.click()} icon={<FileUp aria-hidden="true" className="h-4 w-4" />}>
              选择任务包并导入
            </Button>
            <span className="text-[11px] text-ink-secondary">导入失败会保留原包不变并给出原因；跨版本迁移失败不会部分写入。</span>
          </div>
          {importError && (
            <p role="alert" className="text-[11px] text-failed">
              {importError}
            </p>
          )}
          {importResult && (
            <div className={cn('rounded border px-2 py-1.5 text-[11px]', importResult.needsRebinding ? 'border-pending/40 bg-pending/[0.05]' : 'border-accepted/40 bg-accepted/[0.05]')}>
              <p className="text-ink-primary">导入完成：任务 {importResult.taskId.slice(0, 8)}</p>
              {importResult.needsRebinding && <p className="text-pending">来源需要重新绑定：引用信息保留，但证据内容不可读取，系统不会假装证据仍存在。</p>}
              {importResult.warnings.length > 0 && <p className="text-ink-secondary">警告：{importResult.warnings.join('；')}</p>}
              <Button size="sm" variant="secondary" className="mt-1" onClick={() => navigate({ name: 'task', taskId: importResult.taskId })} icon={<PackageOpen aria-hidden="true" className="h-3.5 w-3.5" />}>
                打开导入的任务
              </Button>
            </div>
          )}
          {snapshot.sources.length === 0 && <EmptyState compact title="当前任务还没有资料" description="导出任务包时可选择是否携带资料；没有资料的包在导入后会提示重新绑定。" />}
        </div>
      </Card>
    </div>
  );
}
