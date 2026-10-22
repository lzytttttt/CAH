import type { CapabilityTestInput, CapabilityTestOutput } from './types';

/**
 * Placeholder replaced by the providers workstream: two-step connection test
 * (auth+text, then explicit feature probes) with per-capability evidence.
 */
export async function runCapabilityTests(_input: CapabilityTestInput): Promise<CapabilityTestOutput> {
  throw new Error('capability tests not implemented yet (runCapabilityTests)');
}
