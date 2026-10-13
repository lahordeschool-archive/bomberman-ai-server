import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import {
  checkFetchRequest,
  FETCH_LIMITS,
  type HostFetchResult,
  parseFetchRequest,
  readLimitedText,
  responseHeaders,
} from '@bomberman/bot-sdk';
import { Agent, fetch as undiciFetch } from 'undici';

export interface EgressPolicy {
  enabled: boolean;
  /** Only for local development and tests: lets bots reach loopback and private networks. */
  allowPrivateNetworks: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent: string;
}

export const DEFAULT_EGRESS: EgressPolicy = {
  enabled: true,
  allowPrivateNetworks: false,
  timeoutMs: FETCH_LIMITS.timeoutMs,
  maxResponseBytes: FETCH_LIMITS.maxResponseBytes,
  userAgent: 'BomberArenaBot/1.0',
};

const reserved = new BlockList();
/** Kept apart because BlockList also matches IPv4 addresses against IPv4-mapped rules. */
const reservedV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  reserved.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  reservedV6.addSubnet(network, prefix, 'ipv6');
}

/**
 * True for globally routable unicast addresses. Loopback, private, link-local (cloud
 * metadata), carrier-grade NAT, documentation, multicast, and IPv6 transition ranges
 * that can embed an IPv4 address are all rejected.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, 'ipv4');
  if (family === 6) return !reservedV6.check(address, 'ipv6');
  return false;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function describe(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `Request timed out after ${timeoutMs} ms`;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}

/**
 * Outbound HTTP for bots. Every resolved address is checked when the socket
 * connects, so a hostname cannot pass the check and then rebind to an internal
 * address. Redirects are followed by hand so each hop is checked again.
 */
export class Egress {
  readonly policy: EgressPolicy;
  private readonly agent: Agent;

  constructor(policy: EgressPolicy) {
    this.policy = policy;
    const allowPrivate = policy.allowPrivateNetworks;
    this.agent = new Agent({
      keepAliveTimeout: 10_000,
      connections: 32,
      connect: {
        timeout: Math.min(3000, policy.timeoutMs),
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
            if (error) return callback(error, '', 0);
            const allowed = allowPrivate
              ? addresses
              : addresses.filter((entry) => isPublicAddress(entry.address));
            if (allowed.length === 0) {
              return callback(
                Object.assign(new Error(`${hostname} resolves to a private or reserved address`), {
                  code: 'EBLOCKED',
                }),
                '',
                0,
              );
            }
            if ((options as { all?: boolean }).all) {
              return (callback as unknown as (e: null, list: LookupAddress[]) => void)(
                null,
                allowed,
              );
            }
            callback(null, allowed[0]!.address, allowed[0]!.family);
          });
        },
      },
    });
  }

  private checkTarget(url: URL): string | null {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return 'Only http and https URLs can be fetched';
    }
    if (this.policy.allowPrivateNetworks) return null;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port < 1024 && port !== 80 && port !== 443) return `Port ${port} is not allowed`;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) return `${host} is a private or reserved address`;
    return null;
  }

  async fetch(url: string, requestJson: string, signal?: AbortSignal): Promise<HostFetchResult> {
    if (!this.policy.enabled) return { error: 'Network access is disabled on this server' };
    const request = parseFetchRequest(requestJson);
    if (!request) return { error: 'Invalid fetch request' };
    const problem = checkFetchRequest(url, request);
    if (problem) return { error: problem };

    const timeout = AbortSignal.timeout(this.policy.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { 'user-agent': this.policy.userAgent, ...request.headers };
    let target = new URL(url);
    let method = request.method;
    let body = request.body;
    try {
      for (let hop = 0; ; hop++) {
        const blocked = this.checkTarget(target);
        if (blocked) return { error: blocked };
        const response = await undiciFetch(target, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : (body ?? undefined),
          redirect: 'manual',
          signal: combined,
          dispatcher: this.agent,
        });
        const location = response.headers.get('location');
        if (REDIRECTS.has(response.status) && location) {
          await response.body?.cancel().catch(() => undefined);
          if (hop >= FETCH_LIMITS.maxRedirects) return { error: 'Too many redirects' };
          target = new URL(location, target);
          if (response.status === 303 || (response.status <= 302 && method === 'POST')) {
            method = 'GET';
            body = null;
          }
          continue;
        }
        const text =
          method === 'HEAD'
            ? ''
            : await readLimitedText(response as unknown as Response, this.policy.maxResponseBytes);
        return {
          status: response.status,
          statusText: response.statusText,
          url: target.href,
          redirected: hop > 0,
          headers: responseHeaders(response.headers as unknown as Headers),
          body: text,
        };
      }
    } catch (error) {
      return { error: describe(error, this.policy.timeoutMs) };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
