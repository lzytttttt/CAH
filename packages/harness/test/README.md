# @ca/harness test harness (reusable by server e2e / integration tests)

All tests are deterministic and offline: no network, no real storage, no timers that
decide business outcomes. Reuse the fakes below from your own tests.

## Building a fixture

```ts
import { createFixture, planToReady, commitRun, candidateEnvelope, markdownCandidate } from '../test/fixtures';

const fixture = await createFixture({
  modules: [{ title: '测试模块', kind: 'markdown' }],
  sources: [{ name: 'notes.md', text: '资料内容' }],
  constraints: [{ text: '必须完全离线部署', kind: 'hard' }],
  workspaceSettings: { autoAcceptVerifiedDrafts: false },
  budget: { maxModelRequests: 6, maxToolCalls: 4, maxRetries: 0, maxStructureRepairs: 2 },
  capabilities: { structuredOutput: 'unknown' }, // verified → planner uses json_schema responseFormat
  configureProvider: false,                       // exercise the missing-provider path
});

// fixture.engine is the real kernel wired to:
//   FakeStorage (in-memory StoragePort), FakeProviderGateway, FakeToolRuntime,
//   real ArtifactValidator, fake toolContextFactory.
```

`createFixture` persists one workspace/task/artifact and the modules/sources you list
(module dependencies are expressed by array index). It records `onRunFinished` calls in
`fixture.finished`.

## FakeProviderGateway scripted contract

```ts
import { toolCallEvents } from './fakes/fake-provider';

// One scripted response = array of ModelEvent (validated against contracts schemas).
fixture.provider.enqueue([{ type: 'text_delta', text: '...' }, { type: 'finish', reason: 'stop' }]);
fixture.provider.enqueueText('...');                       // text deltas + finish('stop')
fixture.provider.enqueueCandidate(moduleContent);          // JSON candidate envelope
fixture.provider.enqueueToolCall('artifact.propose_patch', args); // tool_call_delta* + tool_call_complete + finish('tool_calls')
fixture.provider.enqueueHandler(async (request, signal, index) => ModelEvent[]); // custom/delayed
fixture.provider.enqueueAbortable();                        // streams one delta, then waits for abort (pause/cancel tests)
```

Scripts are consumed in order by actual provider stream calls; `fixture.provider.requests`
records parsed `ModelRequest`s (messages/tools/responseFormat) for assertions.

### Planner call (reviewed planning, `planFirst: true`)

- messages: `[system planner.v1 template, user context + planner instruction]`, `tools: []`, `toolChoice: 'none'`.
- `responseFormat`: `{kind:'json_schema', name:'planner_output', schema}` iff
  `capabilities.structuredOutput === 'verified'`, else `{kind:'text'}`.
- Stream: `text_delta*` → `finish('stop')`. The returned text must be the
  `PlannerOutputSchema` JSON object (`pkgs/harness/src/planner.ts`):
  `{goal, skeleton[], steps[], tools[], assumptions[], openQuestions[], risks[], rationale}`.
  Fenced ```json is tolerated. Invalid output triggers bounded plan repair using `repair.v1`
  (same text protocol, tools=[]).

### Executor call (after `commit()`)

- tools: `ToolRuntime.modelTools(plan.tools ids)` (fake tool names are the ToolId strings,
  e.g. `artifact.propose_patch`), responseFormat text.
- A candidate is produced by either:
  1. a native `tool_call_complete` with `name: 'artifact.propose_patch'` and JSON arguments
     `{moduleId, baseVersionId, description, operations:[{kind:'replace_module',content:<ModuleContent>}], evidenceRefs:[]}`;
     the kernel validates arguments, executes the injected ToolRuntime, and reads
     `patch.candidate` from the tool result; or
  2. an assistant text message that parses as `{"candidate": <ModuleContent>, "evidenceRefs": [...], "description": "..."}`
     (direct `ModuleContent` / `{content: ...}` also accepted).
- Invalid/incomplete tool arguments and tools outside the committed plan are never executed
  (`tool.failed` events with `invalid_arguments` / `tool_not_allowed`).

### Repair call (validation stage)

`repair.v1` system + findings/candidate user message, tools=[], text response with a full
corrected candidate envelope. At most `BudgetPolicy.maxStructureRepairs` (default 2).

## FakeToolRuntime

`packages/harness/test/fakes/fake-tools.ts` implements all 8 P0 tools in memory but uses the
real argument-schemas from `@ca/contracts` for `validateArguments` (strict, unknown keys
rejected). `artifact.propose_patch` applies the patch operations, runs the real validator and
persists a `PatchProposal` through `ctx.artifacts.saveProposal`. Override a tool body with
`fixture.tools.setHandler(toolId, async (args, ctx) => ToolResult)` (e.g. to simulate
`outcome_unknown`, timeouts, failures).

## FakeStorage

`packages/harness/test/fakes/fake-storage.ts` implements the full `StoragePort`:
- transactions are savepoints (nested rollback works),
- `commitAcceptance` enforces the base-version + task-revision guards and marks the patch accepted,
- every appended event payload is parsed through `parseEventPayload` (so invalid events fail tests),
- `checkpointKinds` / `callLog` are assertion helpers; `eventsFor(taskId)` returns the event log.

## Useful helpers

`fixtures.ts` exports `planToReady`, `commitRun`, `latestPatch`, `latestReport`,
`seedAcceptedVersion` (simulate an out-of-band accepted version), `markdownCandidate`,
`csvCandidate`, `candidateEnvelope`, `sourceSpanEvidence`, `validPlannerOutput`.

## What the suite covers

Harness state machine, plan risk analysis/blocking, deterministic zero-LLM planning,
tool-call gating, budget pauses, pause/resume/cancel, validation + bounded repair,
version-conflict acceptance, reject/restore + downstream stale, auto-accept policy,
partial section acceptance, no-progress blockers and crash recovery.
