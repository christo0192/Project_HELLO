#!/bin/sh
# Render the deliberately small LiveKit configuration at container start.
# S0-F1 is a kill switch: never start if Fly's reply-source address is absent.
set -eu

die() {
  echo "livekit-r1-entrypoint: $*" >&2
  exit 1
}

: "${NODE_IP:?NODE_IP must be the dedicated Fly IPv4}"
: "${LIVEKIT_KEYS:?LIVEKIT_KEYS must be a Fly secret (<key>: <32+ char secret>)}"

case "$NODE_IP" in
  *[!0-9.]* | .* | *..* | '') die "NODE_IP must be an IPv4 address" ;;
esac

# `getent hosts` is intentional: it resolves Fly's per-Machine FGS address,
# not a public DNS record. Prefer the first IPv4 result if libc also returns v6.
# Docker does not provide that Fly-only hostname, so the explicit override is
# solely a local smoke-test seam. Production stays fail-closed when it is unset.
if [ -n "${LIVEKIT_R1_FGS_IP_OVERRIDE:-}" ]; then
  FGS="$LIVEKIT_R1_FGS_IP_OVERRIDE"
  echo "livekit-r1-entrypoint: using LIVEKIT_R1_FGS_IP_OVERRIDE=${FGS} for a non-Fly local run" >&2
else
  FGS="$(getent hosts fly-global-services 2>/dev/null | awk '$1 ~ /^[0-9]+(\.[0-9]+){3}$/ { print $1; exit }')"
  [ -n "$FGS" ] || die "fly-global-services has no IPv4 address; set LIVEKIT_R1_FGS_IP_OVERRIDE only for a local smoke test"
fi

case "$FGS" in
  *[!0-9.]* | .* | *..* | '') die "fly-global-services returned an invalid IPv4 address" ;;
esac

# A mapping line is accepted, rather than arbitrary YAML, so a malformed or
# newline-containing secret cannot alter the rendered configuration.
case "$LIVEKIT_KEYS" in
  *[!A-Za-z0-9_./+:-]* | *:*:* | :* | *:) 
    die "LIVEKIT_KEYS must be one key:secret mapping with a base64/url-safe secret" ;;
esac
KEY_NAME=${LIVEKIT_KEYS%%:*}
KEY_SECRET=${LIVEKIT_KEYS#*:}
[ -n "$KEY_NAME" ] && [ ${#KEY_SECRET} -ge 32 ] || die "LIVEKIT_KEYS requires a key and a secret of at least 32 characters"
KEYS_YAML="$KEY_NAME: $KEY_SECRET"

umask 077
CONFIG=/tmp/livekit.yaml
sed \
  -e "s|__NODE_IP__|$NODE_IP|g" \
  -e "s|__FLY_GLOBAL_SERVICES__|$FGS|g" \
  -e "s|__LIVEKIT_KEYS__|$KEYS_YAML|g" \
  /etc/livekit/livekit.yaml.tmpl > "$CONFIG"

echo "livekit-r1-entrypoint: binding UDP mux to ${FGS}:7882; advertising ${NODE_IP}:7882" >&2
exec /livekit-server --config "$CONFIG"
