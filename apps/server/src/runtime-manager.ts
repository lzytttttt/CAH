import path from 'node:path';
import fs from 'node:fs/promises';
import {
  DEFAULT_BUDGET_POLICY,
  POLICY_VERSION,
  PROMPT_BUNDLE_VERSION,
  type ProviderCapabilities,
  type ModelEvent,
  type ModelRequest,
  type ProviderProfile,
} from '@ca/contracts';
import { createHarnessEngine, createArtifactValidator, DEFAULT_HARNESS_CONFIG, type HarnessEngine, type ProviderGateway } from '@ca/harness';
import { openStorage } from '@ca/storage';
import type { StoragePort } from '@ca/storage';
import { createToolRuntime } from '@ca/tools';
import type { ToolRuntime } from '@ca/tools';
import type { CredentialStore } from '@ca/providers';
import type { ServerConfig } from './config';
import { NoopCredentialStore, ServerCredentialStore } from './credential-service';
import { LiveProviderGateway } from './provider-gateway';
import { RunScheduler } from './scheduler';
import { createToolContextFactory } from './tool-ports';
import { createSourceReader } from './tool-ports';
import { projectTaskSnapshot } from './projection';
import { ensureDemoSeeded } from './seed-demo';
import { HarnessError } from '@ca/harness';

const APP_VERSION = '0.1.0';

export interface ModeRuntime {
  mode: 'demo' | 'live';
  storage: StoragePort;
  credentials: CredentialStore;
  providers: ProviderGateway;
  liveProviders: LiveProviderGateway | null;
  tools: ToolRuntime;
  validator: ReturnType<typeof createArtifactValidator>;
  harness: HarnessEngine;
  scheduler: RunScheduler;
  sourceReader: ReturnType<typeof createSourceReader>;
  snapshot(input: { taskId: string; afterSeq: number; includeEvents: boolean }): Promise<Awaited<ReturnType<typeof projectTaskSnapshot>>>;
}

/** Demo mode must never touch a real provider or credential. */
class DisabledDemoProviderGateway implements ProviderGateway {
  async getProfile(): Promise<ProviderProfile | null> {
    return null;
  }
  async listEnabledProfiles(): Promise<ProviderProfile[]> {
    return [];
  }
  async capabilities(): Promise<ProviderCapabilities> {
    throw new HarnessError('state_not_allowed', '演示模式不探测真实模型能力；请切换到 Live 模式');
  }
  async *stream(_profileId: string, _request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    throw new HarnessError('state_not_allowed', '演示模式不调用真实模型；请切换到 Live 模式执行真实任务');
  }
}

export type LogFn = (message: string, details?: Record<string, unknown>) => void;

export interface RuntimeOverrides {
  /**
   * Test/dev seam: inject a scripted ProviderGateway instead of the real model
   * adapter. Never set this in production bootstrapping.
   */
  providersFor?: (mode: 'demo' | 'live') => ProviderGateway | null;
}

export class RuntimeManager {
  readonly config: ServerConfig;
  readonly appVersion = APP_VERSION;
  private readonly runtimes = new Map<'demo' | 'live', ModeRuntime>();
  private active: 'demo' | 'live';
  private readonly log: LogFn;
  private readonly overrides: RuntimeOverrides;

  constructor(config: ServerConfig, log: LogFn = () => {}, overrides: RuntimeOverrides = {}) {
    this.config = config;
    this.log = log;
    this.active = config.defaultMode;
    this.overrides = overrides;
  }

  get currentMode(): 'demo' | 'live' {
    return this.active;
  }

  availableModes(): Array<'demo' | 'live'> {
    return [...this.runtimes.keys()];
  }

  runtime(mode?: 'demo' | 'live'): ModeRuntime {
    const selected = mode ?? this.active;
    const runtime = this.runtimes.get(selected);
    if (!runtime) throw new Error(`mode runtime not initialized: ${selected}`);
    return runtime;
  }

  live(): ModeRuntime | null {
    return this.runtimes.get('live') ?? null;
  }

  /** Switch workspace mode only when no run is active anywhere (design 3.3). */
  async switchMode(mode: 'demo' | 'live'): Promise<void> {
    if (mode === this.active) return;
    if (!this.runtimes.has(mode)) {
      throw new HarnessError('state_not_allowed', `模式 ${mode} 当前不可用`);
    }
    for (const [name, runtime] of this.runtimes) {
      const activeRuns = await runtime.storage.countActiveRuns();
      if (activeRuns > 0 || runtime.scheduler.activeCount() > 0) {
        throw new HarnessError('state_not_allowed', `存在运行中的任务，不能切换模式（${name}: ${activeRuns} 个活动运行）`);
      }
    }
    this.active = mode;
    this.log('workspace mode switched', { mode });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.initMode('live');
    await this.initMode('demo');
    this.log('runtimes ready', { modes: [...this.runtimes.keys()], active: this.active });
  }

  private async initMode(mode: 'demo' | 'live'): Promise<ModeRuntime> {
    // openStorage appends `<mode>/` itself and creates DB + objects per mode.
    const storage = openStorage({
      dataDir: this.config.dataDir,
      mode,
      workspaceName: mode === 'demo' ? '演示工作区' : 'Live 工作区',
      settings: { autoAcceptVerifiedDrafts: false, pauseWhenPageCloses: false, reducedMotion: false, theme: 'dark', providerProfileIds: [] },
    });
    const credentials: CredentialStore = mode === 'live' ? new ServerCredentialStore(this.config) : new NoopCredentialStore();
    let providers: ProviderGateway;
    let liveProviders: LiveProviderGateway | null = null;
    const overrideProviders = this.overrides.providersFor?.(mode) ?? null;
    if (overrideProviders) {
      providers = overrideProviders;
    } else if (mode === 'live') {
      liveProviders = new LiveProviderGateway(storage, credentials, this.config);
      providers = liveProviders;
      await liveProviders.ensureEnvProfile();
    } else {
      providers = new DisabledDemoProviderGateway();
    }
    const tools = createToolRuntime();
    const validator = createArtifactValidator({ storage });
    let scheduler: RunScheduler;
    const onRunFinished = (runId: string, state: import('@ca/contracts').RunState) => {
      scheduler?.onRunFinished(runId, state);
    };
    const profileIdForRun = async (runId: string): Promise<string | null> => {
      const run = await storage.getRun(runId);
      if (!run) return null;
      const enabled = await providers.listEnabledProfiles();
      return enabled[0]?.id ?? null;
    };
    const toolContextFactory = createToolContextFactory({
      storage,
      validator,
      providers,
      profileIdForRun,
      mode,
    });
    const harness = createHarnessEngine({
      storage,
      providers,
      tools,
      config: {
        ...DEFAULT_HARNESS_CONFIG,
        mode,
        policyVersion: POLICY_VERSION,
        promptBundleVersion: PROMPT_BUNDLE_VERSION,
      },
      toolContextFactory,
      onRunFinished,
    });
    scheduler = new RunScheduler({
      storage,
      harness,
      maxActiveRuns: this.config.runConcurrency,
      log: this.log,
    });
    const sourceReader = createSourceReader(storage);
    const runtime: ModeRuntime = {
      mode,
      storage,
      credentials,
      providers,
      liveProviders,
      tools,
      validator,
      harness,
      scheduler,
      sourceReader,
      snapshot: async (input) =>
        projectTaskSnapshot(
          {
            storage,
            providers,
            mode,
            schedulerActiveCount: () => scheduler.activeCount(),
            queuePosition: (runId: string) => null,
          },
          input,
        ),
    };
    if (mode === 'live') {
      try {
        const report = await harness.recoverInterrupted();
        if (report.interrupted.length > 0) this.log('recovered interrupted runs', { count: report.interrupted.length });
      } catch (error) {
        this.log('run recovery failed', { error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      const existingTasks = await storage.listTasks();
      if (this.config.seedDemo || existingTasks.length > 0) {
        await ensureDemoSeeded({ storage, config: this.config, log: this.log });
      }
    }
    scheduler.start();
    this.runtimes.set(mode, runtime);
    return runtime;
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.scheduler.stop();
      try {
        await runtime.harness.shutdown();
      } catch {
        // best effort
      }
      await runtime.storage.close();
    }
    this.runtimes.clear();
  }
}

export const DEFAULT_HARNESS_POLICY = DEFAULT_BUDGET_POLICY;
