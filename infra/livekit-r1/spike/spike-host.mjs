export const SPIKE_HOST = "project-hello-r1-rtc-spike.fly.dev";

/**
 * Permit only the one disposable spike endpoint.  A new endpoint is a code
 * change, rather than a runtime configuration change, by design.
 */
export function assertSpikeUrl(value, name = "R1_SPIKE_URL") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute wss:// or https:// URL`);
  }
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  const authorityHost = authority.slice(authority.lastIndexOf("@") + 1);
  if (
    !["wss:", "https:"].includes(parsed.protocol)
    || parsed.hostname.toLowerCase() !== SPIKE_HOST
    // Empty userinfo (`@host`, `:@host`) parses to falsy username/password,
    // so reject any `@` in the raw authority as well.
    || authority.includes("@")
    || parsed.username
    || parsed.password
    || parsed.port
    // URL canonicalization hides an explicitly supplied default port.
    || authorityHost.includes(":")
  ) {
    throw new Error(`${name} must use the approved disposable spike host without credentials or a port`);
  }
  return parsed;
}
