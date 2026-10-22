/**
 * URL policy tests (design section 6.3): HTTPS-only remote, explicit loopback
 * HTTP opt-in, exact internal allow-list, metadata rejection, redirect rules.
 */
import { describe, expect, it } from 'vitest';
import {
  UrlPolicyError,
  assertProviderUrlAllowed,
  assertRedirectAllowed,
  classifyHost,
  isLoopbackHost,
  maskCredential,
} from '../src/index';
import type { UrlPolicy } from '../src/index';

const OPEN_POLICY: UrlPolicy = { allowHttpLoopback: true, allowedProviderHosts: [] };
const LOOPBACK_DISABLED: UrlPolicy = { allowHttpLoopback: false, allowedProviderHosts: [] };
const INTERNAL_ALLOWED: UrlPolicy = {
  allowHttpLoopback: false,
  allowedProviderHosts: ['internal.example.com', 'llm.internal', '10.0.0.5', '192.168.1.10:8080', '[fd00::1]:8443'],
};

function expectRejected(url: string, policy: UrlPolicy, reason: string): void {
  try {
    assertProviderUrlAllowed(url, policy);
    throw new Error(`expected ${url} to be rejected`);
  } catch (error) {
    expect(error).toBeInstanceOf(UrlPolicyError);
    expect((error as UrlPolicyError).reason).toBe(reason);
  }
}

describe('assertProviderUrlAllowed', () => {
  it('accepts public HTTPS endpoints', () => {
    expect(() => assertProviderUrlAllowed('https://api.openai.com/v1', OPEN_POLICY)).not.toThrow();
    expect(() => assertProviderUrlAllowed('https://8.8.8.8/v1', OPEN_POLICY)).not.toThrow();
    expect(() => assertProviderUrlAllowed('https://API.Example.COM./v1', OPEN_POLICY)).not.toThrow();
  });

  it('accepts HTTPS loopback endpoints regardless of the HTTP opt-in', () => {
    expect(() => assertProviderUrlAllowed('https://127.0.0.1:8443/v1', LOOPBACK_DISABLED)).not.toThrow();
    expect(() => assertProviderUrlAllowed('https://localhost/v1', LOOPBACK_DISABLED)).not.toThrow();
    expect(() => assertProviderUrlAllowed('https://[::1]:9000/v1', LOOPBACK_DISABLED)).not.toThrow();
  });

  it('rejects plain HTTP for remote hosts', () => {
    expectRejected('http://api.openai.com/v1', OPEN_POLICY, 'https_required');
    expectRejected('http://8.8.8.8/v1', OPEN_POLICY, 'https_required');
    expectRejected('http://llm.internal/v1', OPEN_POLICY, 'https_required');
  });

  it('allows plain HTTP loopback only when the policy opts in', () => {
    expect(() => assertProviderUrlAllowed('http://127.0.0.1:1234/v1', OPEN_POLICY)).not.toThrow();
    expect(() => assertProviderUrlAllowed('http://localhost:1234/v1', OPEN_POLICY)).not.toThrow();
    expect(() => assertProviderUrlAllowed('http://[::1]:1234/v1', OPEN_POLICY)).not.toThrow();
    expect(() => assertProviderUrlAllowed('http://127.0.0.2:1234/v1', OPEN_POLICY)).not.toThrow();
    expectRejected('http://127.0.0.1:1234/v1', LOOPBACK_DISABLED, 'http_loopback_disabled');
  });

  it('requires an exact allow-list entry for internal hosts over HTTPS', () => {
    expectRejected('https://llm.internal/v1', OPEN_POLICY, 'host_not_allowlisted');
    expectRejected('https://10.0.0.5/v1', OPEN_POLICY, 'host_not_allowlisted');
    expectRejected('https://192.168.1.10:8080/v1', OPEN_POLICY, 'host_not_allowlisted');
    expect(() => assertProviderUrlAllowed('https://internal.example.com/v1', INTERNAL_ALLOWED)).not.toThrow();
    expect(() => assertProviderUrlAllowed('https://10.0.0.5/v1', INTERNAL_ALLOWED)).not.toThrow();
    // Exact port match when the allow-list entry specifies a port.
    expect(() => assertProviderUrlAllowed('https://192.168.1.10:8080/v1', INTERNAL_ALLOWED)).not.toThrow();
    expectRejected('https://192.168.1.10:9090/v1', INTERNAL_ALLOWED, 'host_not_allowlisted');
    expect(() => assertProviderUrlAllowed('https://[fd00::1]:8443/v1', INTERNAL_ALLOWED)).not.toThrow();
    // Exact host matching: no suffix or substring shortcuts.
    expect(() => assertProviderUrlAllowed('https://llm.internal/v1', INTERNAL_ALLOWED)).not.toThrow();
    expectRejected('https://other.internal/v1', INTERNAL_ALLOWED, 'host_not_allowlisted');
  });

  it('accepts allow-list entries that include a scheme', () => {
    const policy: UrlPolicy = {
      allowHttpLoopback: false,
      allowedProviderHosts: ['https://logs.example.net:9443'],
    };
    expect(() => assertProviderUrlAllowed('https://logs.example.net:9443/v1', policy)).not.toThrow();
  });

  it('never allows cloud metadata endpoints even if allow-listed', () => {
    const metadataAllowed: UrlPolicy = {
      allowHttpLoopback: true,
      allowedProviderHosts: ['169.254.169.254', 'metadata.google.internal'],
    };
    expectRejected('http://169.254.169.254/latest/meta-data', metadataAllowed, 'metadata_endpoint');
    expectRejected('https://169.254.169.254/latest/meta-data', metadataAllowed, 'metadata_endpoint');
    expectRejected('https://metadata.google.internal/computeMetadata', metadataAllowed, 'metadata_endpoint');
    expectRejected('https://metadata/computeMetadata', metadataAllowed, 'metadata_endpoint');
  });

  it('rejects link-local, unspecified, multicast and reserved ranges', () => {
    expectRejected('https://169.254.1.2/v1', OPEN_POLICY, 'blocked_host');
    expectRejected('https://0.0.0.0/v1', OPEN_POLICY, 'blocked_host');
    expectRejected('https://224.0.0.1/v1', OPEN_POLICY, 'blocked_host');
    expectRejected('https://255.255.255.255/v1', OPEN_POLICY, 'blocked_host');
    expectRejected('https://[fe80::1]/v1', OPEN_POLICY, 'blocked_host');
    expectRejected('https://[ff02::1]/v1', OPEN_POLICY, 'blocked_host');
  });

  it('rejects private IPv6 ranges unless allow-listed', () => {
    expectRejected('https://[fd00::1]/v1', OPEN_POLICY, 'host_not_allowlisted');
    expectRejected('https://[fd12:3456::1]/v1', OPEN_POLICY, 'host_not_allowlisted');
  });

  it('rejects URLs with embedded credentials', () => {
    expectRejected('https://user:pass@api.example.com/v1', OPEN_POLICY, 'userinfo_not_allowed');
  });

  it('rejects non-HTTP schemes and invalid URLs', () => {
    expect(() => assertProviderUrlAllowed('file:///etc/passwd', OPEN_POLICY)).toThrowError(UrlPolicyError);
    expect(() => assertProviderUrlAllowed('ftp://example.com/v1', OPEN_POLICY)).toThrowError(UrlPolicyError);
    expect(() => assertProviderUrlAllowed('not a url', OPEN_POLICY)).toThrowError(UrlPolicyError);
    expect(() => assertProviderUrlAllowed('', OPEN_POLICY)).toThrowError(UrlPolicyError);
  });

  it('classifies hosts for diagnostics', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('LOCALHOST.')).toBe('loopback');
    expect(classifyHost('127.0.0.1')).toBe('loopback');
    expect(classifyHost('[::1]')).toBe('loopback');
    expect(classifyHost('10.1.2.3')).toBe('internal');
    expect(classifyHost('172.16.0.1')).toBe('internal');
    expect(classifyHost('192.168.0.1')).toBe('internal');
    expect(classifyHost('100.64.0.1')).toBe('internal');
    expect(classifyHost('api.openai.com')).toBe('public');
    expect(classifyHost('169.254.169.254')).toBe('blocked');
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
  });
});

describe('assertRedirectAllowed', () => {
  it('allows same-origin redirects', () => {
    expect(() =>
      assertRedirectAllowed('https://api.example.com/v1/chat', 'https://api.example.com/v1/chat?retry=1', OPEN_POLICY),
    ).not.toThrow();
  });

  it('rejects cross-origin redirects to unapproved hosts', () => {
    try {
      assertRedirectAllowed('https://api.example.com/v1', 'https://evil.example.net/v1', OPEN_POLICY);
      throw new Error('expected redirect rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UrlPolicyError);
      expect((error as UrlPolicyError).reason).toBe('redirect_not_allowed');
      expect((error as Error).message).not.toContain('/v1');
    }
  });

  it('allows cross-origin redirects to explicitly allow-listed hosts', () => {
    expect(() =>
      assertRedirectAllowed('https://api.example.com/v1', 'https://internal.example.com/v1', INTERNAL_ALLOWED),
    ).not.toThrow();
  });

  it('rejects metadata and plain-HTTP redirect targets', () => {
    expect(() =>
      assertRedirectAllowed('https://api.example.com/v1', 'http://169.254.169.254/latest/meta-data', OPEN_POLICY),
    ).toThrowError(UrlPolicyError);
    expect(() =>
      assertRedirectAllowed('https://api.example.com/v1', 'http://internal.example.com/v1', OPEN_POLICY),
    ).toThrowError(UrlPolicyError);
  });
});

describe('maskCredential', () => {
  it('never reveals the full secret', () => {
    const secret = 'sk-test-secret-abc123456789';
    const hint = maskCredential(secret);
    expect(hint.startsWith('sk-')).toBe(true);
    expect(hint.endsWith('6789')).toBe(true);
    expect(hint).not.toContain('abc123456789');
    expect(hint).not.toBe(secret);
  });

  it('fully masks short values and empty values', () => {
    expect(maskCredential('short')).toBe('\u2022\u2022\u2022\u2022\u2022\u2022');
    expect(maskCredential('')).toBe('');
    expect(maskCredential('   ')).toBe('');
  });
});
