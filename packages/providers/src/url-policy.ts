/**
 * Provider endpoint URL policy (design section 6.3).
 *
 * Rules enforced here:
 * - Remote provider endpoints must use HTTPS.
 * - Plain HTTP is only accepted for explicit loopback endpoints when the
 *   policy opted in (`allowHttpLoopback`).
 * - Internal / private / reserved network ranges require an exact host (or
 *   host:port) entry in `allowedProviderHosts`.
 * - Cloud metadata endpoints and other link-local targets are never allowed,
 *   even when they appear in the allow-list.
 * - URLs embedding credentials (`user:pass@host`) are rejected.
 * - Redirects are only followed to an approved target (same origin or an exact
 *   allow-listed host); `assertRedirectAllowed` is used by the adapter.
 *
 * Limitation: this is a static (synchronous) hostname/IP check. It cannot
 * resolve DNS, so a public hostname that resolves to a private address is not
 * detected here; deployments must run behind egress policy for full SSRF
 * protection. This limitation is documented instead of silently ignored.
 */
import type { UrlPolicy } from './types';
import { maskCredential } from './mask';

export class UrlPolicyError extends Error {
  readonly code = 'url_not_allowed';
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'UrlPolicyError';
    this.reason = reason;
  }
}

export type HostKind = 'loopback' | 'internal' | 'blocked' | 'public';

const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.com',
  'metadata.amazonaws.com',
]);

const METADATA_IPV4: ReadonlySet<string> = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  '192.0.0.192',
  '168.63.129.16',
]);

const METADATA_IPV6: ReadonlySet<string> = new Set(['fd00:ec2::254']);

/** Hostname suffixes that are conventionally local-network only. */
const INTERNAL_SUFFIXES: readonly string[] = [
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.localdomain',
  '.cluster.local',
];

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

export function normalizeHostname(rawHostname: string): string {
  let host = (rawHostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function effectivePort(url: URL): string {
  if (url.port.length > 0) return url.port;
  return DEFAULT_PORTS[url.protocol] ?? '';
}

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function classifyIpv4(octets: readonly number[]): HostKind {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return 'blocked'; // "this network" / unspecified
  if (a === 127) return 'loopback';
  if (a === 10) return 'internal';
  if (a === 172 && b >= 16 && b <= 31) return 'internal';
  if (a === 192 && b === 168) return 'internal';
  if (a === 100 && b >= 64 && b <= 127) return 'internal'; // CGNAT
  if (a === 169 && b === 254) return 'blocked'; // link-local + cloud metadata
  if (a === 192 && b === 0 && c === 0) return 'internal'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'internal'; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'internal'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'internal'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'internal'; // TEST-NET-3
  if (a >= 224) return 'blocked'; // multicast + reserved + broadcast
  return 'public';
}

function classifyIpv6(host: string): HostKind {
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return 'loopback';
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return 'blocked';
  // IPv4-mapped / IPv4-compatible addresses: unwrap and classify as IPv4.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(normalized);
  if (mapped && mapped[1]) {
    const octets = parseIpv4(mapped[1]);
    if (octets) return classifyIpv4(octets);
  }
  if (METADATA_IPV6.has(normalized)) return 'blocked';
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'blocked'; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'internal'; // unique-local fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return 'blocked'; // multicast
  if (/^2001:db8:/.test(normalized)) return 'internal'; // documentation
  if (/^2002:/.test(normalized)) return 'internal'; // 6to4
  return 'public';
}

export function classifyHost(hostname: string): HostKind {
  const host = normalizeHostname(hostname);
  if (host.length === 0) return 'blocked';
  if (host === 'localhost' || host === 'localhost.localdomain') return 'loopback';
  const ipv4 = parseIpv4(host);
  if (ipv4) return classifyIpv4(ipv4);
  if (METADATA_IPV6.has(host)) return 'blocked';
  if (host.includes(':')) return classifyIpv6(host);
  if (METADATA_HOSTNAMES.has(host)) return 'blocked';
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'internal';
  return 'public';
}

interface AllowListEntry {
  host: string;
  port: string | null;
}

function parseAllowListEntry(rawEntry: string): AllowListEntry | null {
  const entry = (rawEntry ?? '').trim();
  if (entry.length === 0) return null;
  if (entry.includes('://')) {
    try {
      const url = new URL(entry);
      return { host: normalizeHostname(url.hostname), port: url.port.length > 0 ? url.port : null };
    } catch {
      return null;
    }
  }
  // Bracketed IPv6: [::1]:8080 or [::1]
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
  if (bracketed && bracketed[1]) {
    return { host: normalizeHostname(bracketed[1]), port: bracketed[2] ?? null };
  }
  // host:port (exactly one colon) vs bare host / bare IPv6 (multiple colons).
  const colonCount = (entry.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [hostPart = '', portPart = ''] = entry.split(':');
    if (/^\d{1,5}$/.test(portPart) && hostPart.length > 0) {
      return { host: normalizeHostname(hostPart), port: portPart };
    }
  }
  return { host: normalizeHostname(entry), port: null };
}

/** Exact (no wildcard / no suffix) allow-list match; port refines when given. */
export function isHostAllowListed(allowedProviderHosts: readonly string[], hostname: string, port: string): boolean {
  const host = normalizeHostname(hostname);
  for (const rawEntry of allowedProviderHosts) {
    const entry = parseAllowListEntry(rawEntry);
    if (!entry) continue;
    if (entry.host !== host) continue;
    if (entry.port === null || entry.port === port) return true;
  }
  return false;
}

function isMetadataEndpoint(host: string): boolean {
  if (METADATA_HOSTNAMES.has(host)) return true;
  if (METADATA_IPV4.has(host) || METADATA_IPV6.has(host)) return true;
  return false;
}

/**
 * Throw `UrlPolicyError` when `url` may not be used as a provider endpoint.
 * Returns silently when the endpoint is allowed.
 */
export function assertProviderUrlAllowed(url: string, policy: UrlPolicy): void {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new UrlPolicyError('invalid_url', 'provider URL is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlPolicyError('invalid_url', 'provider URL is not a valid absolute URL');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new UrlPolicyError('userinfo_not_allowed', 'provider URL must not embed credentials');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new UrlPolicyError('scheme_not_allowed', `provider URL scheme ${protocol} is not allowed; use https`);
  }
  const host = normalizeHostname(parsed.hostname);
  if (host.length === 0) throw new UrlPolicyError('invalid_url', 'provider URL has no host');
  if (isMetadataEndpoint(host)) {
    throw new UrlPolicyError('metadata_endpoint', 'cloud metadata endpoints are never allowed as provider targets');
  }
  const kind = classifyHost(host);
  const port = effectivePort(parsed);
  const allowListed = isHostAllowListed(policy.allowedProviderHosts, host, port);

  if (protocol === 'http:') {
    if (kind !== 'loopback') {
      throw new UrlPolicyError(
        'https_required',
        `plain HTTP provider endpoint ${host} is not allowed; remote and internal endpoints require HTTPS`,
      );
    }
    if (!policy.allowHttpLoopback) {
      throw new UrlPolicyError('http_loopback_disabled', 'plain HTTP loopback provider endpoints are disabled by policy');
    }
    return;
  }

  // HTTPS: loopback is always allowed, public hosts are allowed, internal hosts
  // must be explicitly allow-listed, blocked ranges never pass.
  if (kind === 'blocked') {
    throw new UrlPolicyError('blocked_host', `provider host ${host} is in a blocked network range`);
  }
  if (kind === 'internal' && !allowListed) {
    throw new UrlPolicyError(
      'host_not_allowlisted',
      `internal provider host ${host} must be added to the explicit provider allow-list`,
    );
  }
}

/**
 * Redirect policy: a redirect target must satisfy `assertProviderUrlAllowed`,
 * and must either stay on the same origin or hit an exact allow-listed host.
 */
export function assertRedirectAllowed(fromUrl: string, toUrl: string, policy: UrlPolicy): void {
  assertProviderUrlAllowed(toUrl, policy);
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    throw new UrlPolicyError('invalid_url', 'provider redirect URL is invalid');
  }
  const sameOrigin =
    from.protocol === to.protocol &&
    normalizeHostname(from.hostname) === normalizeHostname(to.hostname) &&
    effectivePort(from) === effectivePort(to);
  if (sameOrigin) return;
  const targetHost = normalizeHostname(to.hostname);
  if (isHostAllowListed(policy.allowedProviderHosts, targetHost, effectivePort(to))) return;
  throw new UrlPolicyError(
    'redirect_not_allowed',
    `provider redirect to unapproved host ${targetHost} was rejected`,
  );
}

/** True when the host is an explicit loopback endpoint (used by docs/tests). */
export function isLoopbackHost(hostname: string): boolean {
  return classifyHost(hostname) === 'loopback';
}

export { maskCredential };
