import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { RetrievalException } from '@/modules/research/retrieval/retrieval.exception';
import type { RetrievalMode } from '@/modules/research/retrieval/retrieval.type';

export type DnsResolver = (hostname: string) => Promise<string[]>;

export type SafeDnsFailureReason = 'blocked' | 'unresolved';

// Surfaced when the connection-time lookup rejects a destination. Carries the
// full retrieval target so failure provenance keeps the exact URL, not just
// the hostname. The retrieval client maps this to RetrievalException.
export class SafeDnsError extends Error {
  readonly hostname: string;
  readonly targetUrl: string;
  readonly reason: SafeDnsFailureReason;
  readonly blockedAddress?: string;

  constructor(
    hostname: string,
    targetUrl: string,
    reason: SafeDnsFailureReason,
    blockedAddress?: string,
  ) {
    super(
      reason === 'blocked'
        ? `Hostname "${hostname}" resolved to a blocked address.`
        : `Hostname "${hostname}" could not be resolved.`,
    );
    this.name = new.target.name;
    this.hostname = hostname;
    this.targetUrl = targetUrl;
    this.reason = reason;
    this.blockedAddress = blockedAddress;

    Error.captureStackTrace?.(this, new.target);
  }
}

// Log-only URL form: keeps scheme/host/port/path, drops credentials, query,
// and fragment. Never use for retrieval or failure provenance.
export const sanitizeUrlForLogging = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[unparseable-url]';
  }
};

type UrlSafetyServiceDependencies = {
  dnsResolver?: DnsResolver;
};

// Default resolver never throws: unresolvable hostnames surface as an empty
// address list so the caller maps them to DNS_RESOLUTION_FAILED.
export const lookupAllDnsAddresses: DnsResolver = async (hostname: string) => {
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
};

const parseIpv4Octets = (ip: string): [number, number, number, number] | null => {
  const parts = ip.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }

    const octet = Number(part);

    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    octets.push(octet);
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
};

const isBlockedIpv4 = (ip: string): boolean => {
  const octets = parseIpv4Octets(ip);

  if (!octets) {
    return true;
  }

  const [first, second, third, fourth] = octets;

  if (first === 127) return true; // 127.0.0.0/8 loopback
  if (first === 10) return true; // 10.0.0.0/8
  if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (first === 192 && second === 168) return true; // 192.168.0.0/16
  if (first === 169 && second === 254) return true; // 169.254.0.0/16 link-local
  if (first === 0) return true; // 0.0.0.0/8 unspecified
  if (first === 100 && second >= 64 && second <= 127) return true; // 100.64.0.0/10 shared
  if (first === 192 && second === 0 && third === 2) return true; // TEST-NET-1
  if (first === 198 && second === 51 && third === 100) return true; // TEST-NET-2
  if (first === 203 && second === 0 && third === 113) return true; // TEST-NET-3
  if (first === 192 && second === 88 && third === 99) return true; // 6to4 relay (deprecated)
  if (first >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved

  void fourth;
  return false;
};

const hextetValue = (hextet: string): number | null => {
  if (!/^[0-9a-f]{1,4}$/.test(hextet)) {
    return null;
  }

  return Number.parseInt(hextet, 16);
};

// Conservative: malformed IPv6 literals are treated as blocked in production.
export const isBlockedIpAddress = (ip: string): boolean => {
  const version = isIP(ip);

  if (version === 4) {
    return isBlockedIpv4(ip);
  }

  if (version !== 6) {
    return true;
  }

  const lower = ip.toLowerCase();

  if (lower === '::1' || lower === '::') {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (deprecated ::a.b.c.d).
  if (lower.includes('.')) {
    const dotted = lower.slice(lower.lastIndexOf(':') + 1);
    return isBlockedIpv4(dotted);
  }

  // Hex-encoded mapped form, e.g. ::ffff:7f00:1.
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length).split(':');
    const high = hextetValue(tail[0] ?? '');
    const low = hextetValue(tail[1] ?? '');

    if (high === null || low === null || tail.length !== 2) {
      return true;
    }

    return isBlockedIpv4(
      `${(high >>> 8) & 0xff}.${high & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`,
    );
  }

  const expanded = lower === '::' ? [] : lower.split(':');
  const allZero = expanded.every((group) => group === '' || group === '0');

  if (allZero) {
    return true;
  }

  const firstGroup = lower.startsWith(':') ? '0' : (lower.split(':')[0] ?? '0');
  const first = hextetValue(firstGroup);

  if (first === null) {
    return true;
  }

  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
};

export class UrlSafetyService {
  private readonly dnsResolver: DnsResolver;

  constructor(dependencies: UrlSafetyServiceDependencies = {}) {
    this.dnsResolver = dependencies.dnsResolver ?? lookupAllDnsAddresses;
  }

  // Pure URL-shape policy: protocol allow-list, credential rejection, fragment
  // removal. DNS/address checks happen in validateUrl / assertHostAllowed.
  normalizeUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim();

    if (!trimmed) {
      throw new RetrievalException('INVALID_URL', 'The provided URL is empty.', {
        url: rawUrl,
      });
    }

    let parsed: URL;

    try {
      parsed = new URL(trimmed);
    } catch (error) {
      throw new RetrievalException('INVALID_URL', 'The provided URL is malformed.', {
        url: rawUrl,
        cause: error,
      });
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RetrievalException(
        'UNSUPPORTED_PROTOCOL',
        `URL protocol "${parsed.protocol}" is not supported.`,
        { url: rawUrl },
      );
    }

    if (parsed.username || parsed.password) {
      throw new RetrievalException('INVALID_URL', 'URLs must not embed credentials.', {
        url: this.sanitizeForLogging(parsed),
      });
    }

    parsed.hash = '';

    return parsed;
  }

  async assertHostAllowed(
    hostname: string,
    mode: RetrievalMode,
    contextUrl?: string,
  ): Promise<void> {
    const host = hostname
      .trim()
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^\[(.*)\]$/, '$1');
    const provenance = contextUrl ?? host;

    if (isIP(host) !== 0) {
      if (mode !== 'evaluation' && isBlockedIpAddress(host)) {
        throw new RetrievalException('BLOCKED_ADDRESS', `IP literal "${host}" is blocked.`, {
          url: provenance,
        });
      }

      return;
    }

    if (!host) {
      throw new RetrievalException('INVALID_URL', 'The URL hostname is empty.', {
        url: provenance,
      });
    }

    // Both modes resolve: production also validates addresses, evaluation only
    // classifies DNS failures while allowing local/private destinations.
    const addresses = await this.resolveHost(host, provenance);

    if (mode === 'evaluation') {
      return;
    }

    // Conservative: any blocked address blocks the target (DNS rebinding).
    for (const address of addresses) {
      if (isBlockedIpAddress(address)) {
        throw new RetrievalException(
          'BLOCKED_ADDRESS',
          `Hostname "${host}" resolves to a blocked address.`,
          { url: provenance },
        );
      }
    }
  }

  // Full policy: shape + DNS/address. Every redirect destination must pass
  // through this again; never cache a "public once, public forever" verdict.
  async validateUrl(rawUrl: string, mode: RetrievalMode): Promise<URL> {
    const parsed = this.normalizeUrl(rawUrl);
    await this.assertHostAllowed(parsed.hostname, mode, parsed.toString());
    return parsed;
  }

  // Connection-time lookup for http/https agents. The SAME validated address
  // is handed to the socket, closing the pre-resolve/connect TOCTOU gap:
  // Axios must never resolve independently of this policy.
  createConnectionLookup(mode: RetrievalMode, targetUrl: string): LookupFunction {
    return (hostname, options, callback) => {
      void this.resolveHost(hostname, targetUrl)
        .then((addresses) => {
          if (mode !== 'evaluation') {
            const blocked = addresses.find((address) => isBlockedIpAddress(address));

            if (blocked) {
              callback(new SafeDnsError(hostname, targetUrl, 'blocked', blocked), '');
              return;
            }
          }

          const familyOf = (address: string): number => (isIP(address) === 6 ? 6 : 4);

          if (typeof options === 'object' && options.all) {
            callback(
              null,
              addresses.map((address) => ({ address, family: familyOf(address) })),
            );
            return;
          }

          const first = addresses[0] ?? '';
          callback(null, first, familyOf(first));
        })
        .catch((error: unknown) => {
          callback(
            error instanceof SafeDnsError
              ? error
              : new SafeDnsError(hostname, targetUrl, 'unresolved'),
            '',
          );
        });
    };
  }

  private async resolveHost(hostname: string, provenance: string): Promise<string[]> {
    let addresses: string[];

    try {
      addresses = await this.dnsResolver(hostname);
    } catch (error) {
      throw new RetrievalException(
        'DNS_RESOLUTION_FAILED',
        `Hostname "${hostname}" could not be resolved.`,
        { url: provenance, cause: error },
      );
    }

    if (addresses.length === 0) {
      throw new RetrievalException(
        'DNS_RESOLUTION_FAILED',
        `Hostname "${hostname}" could not be resolved.`,
        { url: provenance },
      );
    }

    return addresses;
  }

  private sanitizeForLogging(parsed: URL): string {
    const redacted = new URL(parsed.toString());
    redacted.username = '';
    redacted.password = '';
    return redacted.toString();
  }
}
