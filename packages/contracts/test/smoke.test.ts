import { describe, expect, it } from 'vitest';
import { CONTRACTS_PACKAGE_VERSION } from '../src/index';

describe('workspace smoke', () => {
  it('loads contracts package source through the workspace alias', () => {
    expect(CONTRACTS_PACKAGE_VERSION).toBe('0.1.0');
  });
});
