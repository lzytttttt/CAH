/**
 * Backend selection.
 *
 * Explicit fixture preview only: `?fixture=1` (or VITE_CA_FIXTURE=1). When the
 * server is unreachable we show the real connection error — we never silently
 * substitute synthetic data (MC-04 / AC-18). The UI always shows the
 * "本地夹具（非真实执行）" badge when the fixture is active.
 */
import { createFixtureClient } from './fixture/client';
import { fixtureScenarioFromParam, type FixtureScenario } from './fixture/data';
import { createHttpClient } from './http';
import type { ApiClient } from './types';

export interface ClientSelection {
  client: ApiClient;
  isFixture: boolean;
  /** Human-readable source description shown in the status banner. */
  description: string;
  scenario: FixtureScenario | null;
}

export interface ClientEnv {
  VITE_CA_FIXTURE?: string;
  VITE_CA_API_BASE?: string;
}

export function selectClient(search: string, env: ClientEnv = {}): ClientSelection {
  const params = new URLSearchParams(search);
  const fixtureParam = params.get('fixture');
  const explicitFixture = fixtureParam === '1' || fixtureParam === 'true';
  const envFixture = env.VITE_CA_FIXTURE === '1' || env.VITE_CA_FIXTURE === 'true';
  if (explicitFixture || envFixture) {
    const scenario = fixtureScenarioFromParam(params.get('scenario'));
    return {
      client: createFixtureClient({ scenario }),
      isFixture: true,
      description: `本地夹具预览（scenario=${scenario}）`,
      scenario,
    };
  }
  return {
    client: createHttpClient({ baseUrl: env.VITE_CA_API_BASE ?? '' }),
    isFixture: false,
    description: '真实后端 API（HTTP + SSE）',
    scenario: null,
  };
}
