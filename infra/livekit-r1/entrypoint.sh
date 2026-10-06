#!/bin/sh
# Render the deliberately small LiveKit configuration at container start.
set -eu

die() {
  echo "livekit-r1-entrypoint: $*" >&2
  exit 1
}

: "${NODE_IP:?NODE_IP must be the dedicated Fly IPv4}"
: "${LIVEKIT_KEYS:?LIVEKIT_KEYS must be a Fly secret (<key>: <32+ char secret>)}"

# Config A is the required baseline: no rtc.ips filter and no Fly Global
# Services lookup. Config B is an explicit follow-up experiment only.
R1_CONFIG="${LIVEKIT_R1_CONFIG:-A}"
case "$R1_CONFIG" in
  A | B) ;;
  *) die "LIVEKIT_R1_CONFIG must be A (default) or B" ;;
esac

# This seam is useful only for a local Config-B smoke test. Fly must never
# accept it: a typo such as 127.0.0.1 would leave signaling healthy but UDP dead.
if [ -n "${LIVEKIT_R1_FGS_IP_OVERRIDE:-}" ] && { [ -n "${FLY_APP_NAME:-}" ] || [ -n "${FLY_MACHINE_ID:-}" ]; }; then
  die "LIVEKIT_R1_FGS_IP_OVERRIDE is forbidden on Fly"
fi

case "$NODE_IP" in
  *[!0-9.]* | .* | *..* | '') die "NODE_IP must be an IPv4 address" ;;
esac

RTC_IPS=""
if [ "$R1_CONFIG" = "B" ]; then
  # `getent hosts` resolves Fly's per-Machine reply-source address, not public
  # DNS. Docker lacks that hostname, so the override is local-only (above).
  if [ -n "${LIVEKIT_R1_FGS_IP_OVERRIDE:-}" ]; then
    FGS="$LIVEKIT_R1_FGS_IP_OVERRIDE"
    echo "livekit-r1-entrypoint: using LIVEKIT_R1_FGS_IP_OVERRIDE=${FGS} for a non-Fly local Config-B run" >&2
  else
    FGS="$(getent hosts fly-global-services 2>/dev/null | awk '$1 ~ /^[0-9]+(\.[0-9]+){3}$/ { print $1; exit }')"
    [ -n "$FGS" ] || die "Config B requires fly-global-services IPv4; set LIVEKIT_R1_FGS_IP_OVERRIDE only for a local smoke test"
  fi
  case "$FGS" in
    *[!0-9.]* | .* | *..* | '') die "fly-global-services returned an invalid IPv4 address" ;;
  esac
  RTC_IPS="  ips:\n    includes:\n      - \"${FGS}/32\""
fi

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
CONFIG_FILE=/tmp/livekit.yaml
sed \
  -e "s|__NODE_IP__|$NODE_IP|g" \
  -e "/__RTC_IPS__/c\\$RTC_IPS" \
  -e "s|__LIVEKIT_KEYS__|$KEYS_YAML|g" \
  /etc/livekit/livekit.yaml.tmpl > "$CONFIG_FILE"

echo "livekit-r1-entrypoint: Config ${R1_CONFIG}; advertising ${NODE_IP}:7882" >&2
exec /livekit-server --config "$CONFIG_FILE"
