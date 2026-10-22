import { describe, expect, it } from 'vitest';
import {
  canTransitionRun,
  isTerminalRunState,
  RUN_STATES,
  RUN_TRANSITIONS,
  canTransitionModule,
  MODULE_STATES,
  type RunState,
} from '../src/index';

describe('run state machine', () => {
  it('covers exactly the 15 documented states', () => {
    expect(RUN_STATES).toHaveLength(15);
    expect(new Set(RUN_STATES).size).toBe(15);
  });

  it('allows the documented happy path', () => {
    const path: RunState[] = [
      'CREATED',
      'PLANNING',
      'READY',
      'RUNNING',
      'VALIDATING',
      'AWAITING_REVIEW',
      'COMMITTING',
      'COMPLETED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionRun(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('supports pause/resume/cancel boundaries', () => {
    expect(canTransitionRun('RUNNING', 'PAUSING')).toBe(true);
    expect(canTransitionRun('PAUSING', 'PAUSED')).toBe(true);
    expect(canTransitionRun('PAUSED', 'RUNNING')).toBe(true);
    expect(canTransitionRun('RUNNING', 'CANCELLING')).toBe(true);
    expect(canTransitionRun('CANCELLING', 'CANCELLED')).toBe(true);
    expect(canTransitionRun('INTERRUPTED', 'RUNNING')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransitionRun('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('CANCELLED', 'COMMITTING')).toBe(false);
    expect(canTransitionRun('CREATED', 'COMPLETED')).toBe(false);
    expect(canTransitionRun('FAILED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('PLANNING', 'RUNNING')).toBe(false);
    // COMMITTING may only complete, bounce to review on conflict, or fail.
    expect(RUN_TRANSITIONS.COMMITTING).toEqual(['COMPLETED', 'AWAITING_REVIEW', 'FAILED']);
  });

  it('marks only completed/cancelled/failed as terminal', () => {
    for (const state of RUN_STATES) {
      if (state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED') {
        expect(isTerminalRunState(state)).toBe(true);
        expect(RUN_TRANSITIONS[state]).toHaveLength(0);
      } else {
        expect(isTerminalRunState(state)).toBe(false);
      }
    }
  });
});

describe('module state machine', () => {
  it('requires review before acceptance', () => {
    expect(canTransitionModule('empty', 'accepted')).toBe(false);
    expect(canTransitionModule('draft', 'ready_for_review')).toBe(true);
    expect(canTransitionModule('ready_for_review', 'accepted')).toBe(true);
    expect(canTransitionModule('accepted', 'stale')).toBe(true);
    expect(canTransitionModule('stale', 'ready_for_review')).toBe(false);
    expect(MODULE_STATES).toHaveLength(6);
  });
});
