/**
 * ashby/ssrf.ts — SSRF defense primitives for the ephemeral resume fetch.
 *
 * The Ashby `file.info` endpoint returns a short-lived presigned URL that we
 * must fetch to obtain the candidate's resume bytes. That fetch is the ONLY
 * outbound request in the integration that targets a caller-influenced host, so
 * it is hardened against Server-Side Request Forgery from first principles:
 *
 *   - Strict HTTPS only (no http/file/gopher/data/blob/…); no URL userinfo.
 *   - A per-tenant host allowlist that is DISABLED BY DEFAULT — until a tenant
 *     probe approves the exact presigned-URL host, every fetch fails closed.
 *   - Every DNS-resolved address is classified and any non-public address
 *     (loopback, private, link-local, ULA, CGNAT, multicast, reserved, IPv4-
 *     mapped/compatible IPv6, NAT64) is rejected — BEFORE connect and AGAIN
 *     after every redirect hop (defeats DNS rebinding + redirect-to-internal).
 *   - Bounded redirect budget; each hop re-validates scheme/host/allowlist/IP.
 *
 * This module is pure and synchronous (no network, no DNS). The orchestration
 * that resolves DNS, pins the validated IP, enforces byte/time/MIME caps, and
 * deletes the bytes lives in `resume-fetch.ts`, which composes these checks.
 * Everything here is deterministic and exhaustively unit-testable.
 */

/** Sanitized, stable reason codes — safe to log/return (never host/URL bytes). */
export type SsrfReason =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'userinfo_present'
  | 'host_missing'
  | 'host_not_allowlisted'
  | 'allowlist_disabled'
  | 'port_not_allowed'
  | 'ip_literal_host'
  | 'blocked_address'
  | 'unresolvable_host';

export interface UrlPolicy {
  /**
   * Master switch for the host allowlist. DEFAULT FALSE → every fetch fails
   * closed with `allowlist_disabled` until a tenant probe approves real hosts.
   */
  allowlistEnabled: boolean;
  /** Exact, lowercased hostnames permitted (e.g. presigned-URL bucket host). */
  allowedHosts: readonly string[];
  /** Permitted destination ports. Defaults to [443] (HTTPS only). */
  allowedPorts?: readonly number[];
}

export type UrlCheck =
  | { ok: true; host: string; port: number }
  | { ok: false; reason: SsrfReason };

const DEFAULT_ALLOWED_PORTS: readonly number[] = [443];

/** Bounded, printable-host guard (no control chars, no spaces). */
function isPlausibleHost(host: string): boolean {
  if (host.length < 1 || host.length > 255) return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

/**
 * Validate a URL's scheme/userinfo/host/port against the policy. This does NOT
 * resolve DNS — callers MUST additionally classify every resolved IP with
 * {@link assertPublicAddress}. Called once per hop (initial + each redirect).
 */
export function checkFetchUrl(rawUrl: string, policy: UrlPolicy): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  // Strict HTTPS. Anything else (http/file/data/gopher/ftp/blob) fails closed.
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };

  // Reject embedded credentials (`https://user:pass@host` and `https://user@host`)
  // — a classic allowlist-bypass / confusable-host trick.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo_present' };
  }

  const host = url.hostname.toLowerCase();
  if (!host || !isPlausibleHost(host)) return { ok: false, reason: 'host_missing' };

  // A bracketed IPv6 literal or a bare IPv4 literal as the host is refused
  // outright: legitimate presigned URLs use DNS names, and an IP-literal host
  // would skip the allowlist's intent. (Resolved IPs are still checked later.)
  if (host.startsWith('[') || isIpLiteral(host)) {
    return { ok: false, reason: 'ip_literal_host' };
  }

  // Port policy (URL.port is '' for the scheme default → 443 for https).
  const port = url.port === '' ? 443 : Number(url.port);
  const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    return { ok: false, reason: 'port_not_allowed' };
  }

  // Host allowlist. Disabled by default → fail closed.
  if (!policy.allowlistEnabled) return { ok: false, reason: 'allowlist_disabled' };
  const allowed = policy.allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) return { ok: false, reason: 'host_not_allowlisted' };

  return { ok: true, host, port };
}

// ── IP literal detection + classification ────────────────────────────────────

/** True iff `value` is a bare IPv4 or IPv6 literal (no brackets). */
export function isIpLiteral(value: string): boolean {
  return parseIpv4(value) !== null || looksLikeIpv6(value);
}

/** Parse a dotted-quad IPv4 into its 4 octets, or null. Rejects non-canonical. */
export function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    // Reject empty, non-digit, and leading-zero ambiguity (e.g. "010").
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === '0') return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function looksLikeIpv6(value: string): boolean {
  // Must contain a colon and only hex/colon/dot characters (dot for embedded v4).
  if (!value.includes(':')) return false;
  return /^[0-9a-fA-F:.]+$/.test(value);
}

/**
 * Classify whether an address string (as returned by DNS resolution) is a
 * PUBLIC, routable unicast address. Any address that is loopback, private,
 * link-local, unique-local, CGNAT, multicast, broadcast, unspecified, reserved,
 * or an IPv4-in-IPv6 embedding of a blocked v4 address returns false.
 *
 * Fails CLOSED: an address we cannot confidently classify as public → false.
 */
export function isPublicAddress(address: string): boolean {
  const addr = address.trim();
  if (addr.length === 0) return false;

  const v4 = parseIpv4(addr);
  if (v4) return isPublicIpv4(v4);

  if (looksLikeIpv6(addr)) return isPublicIpv6(addr);

  // Not an IP literal we understand → cannot vouch for it.
  return false;
}

function isPublicIpv4([a, b, c, d]: [number, number, number, number]): boolean {
  // 0.0.0.0/8            — "this" network / unspecified
  if (a === 0) return false;
  // 10.0.0.0/8           — private
  if (a === 10) return false;
  // 100.64.0.0/10        — CGNAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 127.0.0.0/8          — loopback
  if (a === 127) return false;
  // 169.254.0.0/16       — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12        — private
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24         — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return false;
  // 192.0.2.0/24         — TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return false;
  // 192.88.99.0/24       — 6to4 relay anycast (deprecated)
  if (a === 192 && b === 88 && c === 99) return false;
  // 192.168.0.0/16       — private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15        — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24      — TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return false;
  // 203.0.113.0/24       — TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return false;
  // 224.0.0.0/4          — multicast; 240.0.0.0/4 — reserved; 255.255.255.255 — broadcast
  if (a >= 224) return false;
  return true;
}

/** Expand an IPv6 string into its 8 16-bit hextets, or null if malformed. */
function parseIpv6(value: string): number[] | null {
  let s = value;
  let embeddedV4: [number, number, number, number] | null = null;

  // Handle an embedded IPv4 tail (e.g. "::ffff:1.2.3.4").
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    embeddedV4 = parseIpv4(tail);
    if (!embeddedV4) return null;
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = s.indexOf('::');
  let head: string[];
  let tailParts: string[];
  if (doubleColon >= 0) {
    if (s.indexOf('::', doubleColon + 1) >= 0) return null; // only one '::'
    head = s.slice(0, doubleColon).split(':').filter((x) => x !== '');
    tailParts = s.slice(doubleColon + 2).split(':').filter((x) => x !== '');
  } else {
    head = s.split(':');
    tailParts = [];
  }

  const groups: number[] = [];
  for (const h of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    groups.push(parseInt(h, 16));
  }
  const tailGroups: number[] = [];
  for (const h of tailParts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    tailGroups.push(parseInt(h, 16));
  }

  let full: number[];
  if (doubleColon >= 0) {
    const missing = 8 - (groups.length + tailGroups.length);
    if (missing < 0) return null;
    full = [...groups, ...new Array(missing).fill(0), ...tailGroups];
  } else {
    full = groups;
  }

  if (embeddedV4) {
    // Replace the final two hextets with the embedded IPv4.
    full = full.slice(0, 6);
    full.push((embeddedV4[0] << 8) | embeddedV4[1]);
    full.push((embeddedV4[2] << 8) | embeddedV4[3]);
  }

  if (full.length !== 8) return null;
  if (full.some((g) => g < 0 || g > 0xffff || Number.isNaN(g))) return null;
  return full;
}

function isPublicIpv6(value: string): boolean {
  // Strip a zone index (e.g. "fe80::1%eth0") — its presence implies link-local.
  const pct = value.indexOf('%');
  const bare = pct >= 0 ? value.slice(0, pct) : value;
  if (pct >= 0) return false; // scoped addresses are never public

  const g = parseIpv6(bare);
  if (!g) return false;

  // Unspecified :: and loopback ::1
  if (g.every((x) => x === 0)) return false;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return false;
  }

  const first = g[0];
  // Link-local fe80::/10
  if ((first & 0xffc0) === 0xfe80) return false;
  // Unique-local fc00::/7 (fc00::/8 + fd00::/8)
  if ((first & 0xfe00) === 0xfc00) return false;
  // Multicast ff00::/8
  if ((first & 0xff00) === 0xff00) return false;

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — classify by the v4 tail.
  const allZeroHi = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (allZeroHi && (g[5] === 0xffff || g[5] === 0x0000)) {
    const a = (g[6] >> 8) & 0xff, b = g[6] & 0xff, c = (g[7] >> 8) & 0xff, d = g[7] & 0xff;
    // ::/96 with a zero tail is unspecified-ish → block; otherwise classify v4.
    if (g[5] === 0x0000 && g[6] === 0 && g[7] === 0) return false;
    return isPublicIpv4([a, b, c, d]);
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds a v4 destination.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const a = (g[6] >> 8) & 0xff, b = g[6] & 0xff, c = (g[7] >> 8) & 0xff, d = g[7] & 0xff;
    return isPublicIpv4([a, b, c, d]);
  }

  // 2001:db8::/32 documentation range.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;

  return true;
}

export type AddressCheck = { ok: true } | { ok: false; reason: SsrfReason };

/**
 * Assert that EVERY resolved address for a host is public/routable. If the DNS
 * resolution returned no usable address → `unresolvable_host`; if any address
 * is non-public → `blocked_address` (fail closed — one bad answer poisons the
 * whole set, which defeats a rebinding response that mixes public + private).
 */
export function assertPublicAddresses(addresses: readonly string[]): AddressCheck {
  const usable = addresses.filter((a) => typeof a === 'string' && a.trim().length > 0);
  if (usable.length === 0) return { ok: false, reason: 'unresolvable_host' };
  for (const a of usable) {
    if (!isPublicAddress(a)) return { ok: false, reason: 'blocked_address' };
  }
  return { ok: true };
}
