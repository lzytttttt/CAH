import { describe, expect, it } from 'vitest';
import { selectClient } from '../src/api/clientFactory';

describe('client factory — explicit fixture preview only', () => {
  it('selects the local fixture only when explicitly requested', () => {
    const fixture = selectClient('?fixture=1&scenario=blocked');
    expect(fixture.isFixture).toBe(true);
    expect(fixture.scenario).toBe('blocked');
    expect(fixture.client.kind).toBe('fixture');
    expect(fixture.description).toContain('本地夹具');

    const envFixture = selectClient('', { VITE_CA_FIXTURE: '1' });
    expect(envFixture.isFixture).toBe(true);
    expect(envFixture.client.kind).toBe('fixture');
  });

  it('never falls back to the fixture implicitly (real connection errors must stay visible)', () => {
    const http = selectClient('');
    expect(http.isFixture).toBe(false);
    expect(http.client.kind).toBe('http');
    expect(http.scenario).toBeNull();
    const withScenarioOnly = selectClient('?scenario=empty');
    expect(withScenarioOnly.isFixture).toBe(false);
    const withBaseUrl = selectClient('', { VITE_CA_API_BASE: 'http://127.0.0.1:4310' });
    expect(withBaseUrl.client.kind).toBe('http');
  });

  it('defaults fixture scenario to review and accepts enum values only', () => {
    expect(selectClient('?fixture=1').scenario).toBe('review');
    expect(selectClient('?fixture=1&scenario=nonsense').scenario).toBe('review');
    expect(selectClient('?fixture=true&scenario=completed').scenario).toBe('completed');
  });
});
