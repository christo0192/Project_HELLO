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
# Services lookup. Config B is an explicit follow-up experiment only: it binds
# the browser-facing UDP socket to fly-global-services. Config C is Config B
# plus this Machine's Fly 6PN IPv6 address, so the R1 worker (another Fly app in
# the same organization) reaches the SFU over private IPv6 instead of the
# public dedicated IPv4, which a Fly Machine cannot reach (no hairpin; see
# README "Config C").
R1_CONFIG="${LIVEKIT_R1_CONFIG:-A}"
case "$R1_CONFIG" in
  A | B | C) ;;
  *) die "LIVEKIT_R1_CONFIG must be A (default), B or C" ;;
esac

# These seams are useful only for a local Config-B/C smoke test. Fly must never
# accept them: a typo such as 127.0.0.1 would leave signaling healthy but UDP dead.
if [ -n "${LIVEKIT_R1_FGS_IP_OVERRIDE:-}" ] && { [ -n "${FLY_APP_NAME:-}" ] || [ -n "${FLY_MACHINE_ID:-}" ]; }; then
  die "LIVEKIT_R1_FGS_IP_OVERRIDE is forbidden on Fly"
fi
if [ -n "${LIVEKIT_R1_6PN_IP_OVERRIDE:-}" ] && { [ -n "${FLY_APP_NAME:-}" ] || [ -n "${FLY_MACHINE_ID:-}" ]; }; then
  die "LIVEKIT_R1_6PN_IP_OVERRIDE is forbidden on Fly"
fi

case "$NODE_IP" in
  *[!0-9.]* | .* | *..* | '') die "NODE_IP must be an IPv4 address" ;;
esac

# Succeeds only for an fdaa:-prefixed IPv6 literal made of 1-4 digit hex groups:
# eight groups, or at most seven with one `::`. The value is rendered into YAML
# and handed to livekit-server as a /128, so nothing else (zone ids, prefix
# lengths, brackets, whitespace, newlines) may pass. Pure POSIX sh + awk, and no
# regex intervals, so it behaves the same under busybox, dash, mawk and gawk.
is_6pn_ipv6() {
  case "$1" in
    *[!0-9A-Fa-f:]*) return 1 ;;
  esac
  printf '%s\n' "$1" | awk '
    # Every ":"-separated group is 1-4 hex digits (an empty text has no groups).
    function groups_ok(text,    parts, i, n) {
      if (text == "") return 1
      n = split(text, parts, ":")
      for (i = 1; i <= n; i++) {
        if (length(parts[i]) < 1 || length(parts[i]) > 4 || parts[i] !~ /^[0-9A-Fa-f]+$/) return 0
      }
      return 1
    }
    {
      addr = $0
      if (addr !~ /^[Ff][Dd][Aa][Aa]:/) exit 1
      if (addr ~ /:::/) exit 1
      copy = addr
      doubles = gsub(/::/, "::", copy)
      if (doubles > 1) exit 1
      if (doubles == 0) {
        if (split(addr, parts, ":") != 8) exit 1
        if (!groups_ok(addr)) exit 1
        exit 0
      }
      at = index(addr, "::")
      left = substr(addr, 1, at - 1)
      right = substr(addr, at + 2)
      total = split(left, lparts, ":")
      if (right != "") total += split(right, rparts, ":")
      if (total > 7) exit 1
      if (!groups_ok(left) || !groups_ok(right)) exit 1
      exit 0
    }
  '
}

FGS=""
if [ "$R1_CONFIG" = "B" ] || [ "$R1_CONFIG" = "C" ]; then
  # `getent hosts` resolves Fly's per-Machine reply-source address, not public
  # DNS. Docker lacks that hostname, so the override is local-only (above).
  if [ -n "${LIVEKIT_R1_FGS_IP_OVERRIDE:-}" ]; then
    FGS="$LIVEKIT_R1_FGS_IP_OVERRIDE"
    echo "livekit-r1-entrypoint: using LIVEKIT_R1_FGS_IP_OVERRIDE=${FGS} for a non-Fly local Config-${R1_CONFIG} run" >&2
  else
    FGS="$(getent hosts fly-global-services 2>/dev/null | awk '$1 ~ /^[0-9]+(\.[0-9]+){3}$/ { print $1; exit }')"
    [ -n "$FGS" ] || die "Config ${R1_CONFIG} requires fly-global-services IPv4; set LIVEKIT_R1_FGS_IP_OVERRIDE only for a local smoke test"
  fi
  case "$FGS" in
    *[!0-9.]* | .* | *..* | '') die "fly-global-services returned an invalid IPv4 address" ;;
  esac
fi

# Config C only. Fly aliases the Machine's own 6PN address to fly-local-6pn in
# /etc/hosts (and also exports it as FLY_PRIVATE_IP, used only if that alias does
# not resolve here). It is not static (it can change on a reboot or host
# migration), so it is read at every boot and never stored in fly.toml or a
# secret. Fail closed: without it Config C would silently degrade to Config B,
# the broken worker path.
V6=""
if [ "$R1_CONFIG" = "C" ]; then
  if [ -n "${LIVEKIT_R1_6PN_IP_OVERRIDE:-}" ]; then
    V6="$LIVEKIT_R1_6PN_IP_OVERRIDE"
    echo "livekit-r1-entrypoint: using LIVEKIT_R1_6PN_IP_OVERRIDE=${V6} for a non-Fly local Config-C run" >&2
  else
    V6="$(getent hosts fly-local-6pn 2>/dev/null | awk '$1 ~ /:/ { print $1; exit }')"
    if [ -z "$V6" ] && [ -n "${FLY_PRIVATE_IP:-}" ]; then
      V6="$FLY_PRIVATE_IP"
      echo "livekit-r1-entrypoint: fly-local-6pn did not resolve; using FLY_PRIVATE_IP" >&2
    fi
    [ -n "$V6" ] || die "Config C requires the Machine's fly-local-6pn IPv6 (Fly private network); set LIVEKIT_R1_6PN_IP_OVERRIDE only for a local smoke test"
  fi
  is_6pn_ipv6 "$V6" || die "fly-local-6pn must be an fdaa: 6PN IPv6 address made of hex groups"
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
TEMPLATE_FILE=/etc/livekit/livekit.yaml.tmpl
# Render-only mode deliberately works from a checkout too, so the rendering
# contract can be tested without building or running the image.
if [ "${LIVEKIT_R1_RENDER_ONLY:-}" = "1" ] && [ ! -f "$TEMPLATE_FILE" ]; then
  TEMPLATE_FILE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/livekit.yaml.tmpl"
fi
[ -r "$TEMPLATE_FILE" ] || die "LiveKit configuration template is unreadable: $TEMPLATE_FILE"

# The template has a standalone marker for the optional Config-B/C block. Render
# line-by-line instead of sed's multi-line `c\` command: an empty Config-A
# replacement can consume the following sed expression, and literal newlines
# are not portable across sed implementations.
if [ "${LIVEKIT_R1_RENDER_ONLY:-}" = "1" ]; then
  KEYS_YAML="$KEY_NAME: REDACTED"
fi
awk -v node_ip="$NODE_IP" -v keys_yaml="$KEYS_YAML" -v r1_config="$R1_CONFIG" -v fgs="$FGS" -v v6="$V6" '
  /__RTC_IPS__/ {
    if (r1_config == "B" || r1_config == "C") {
      print "  ips:"
      print "    includes:"
      print "      - \"" fgs "/32\""
      if (r1_config == "C") print "      - \"" v6 "/128\""
    }
    next
  }
  {
    gsub(/__NODE_IP__/, node_ip)
    sub(/__LIVEKIT_KEYS__/, keys_yaml)
    print
  }
' "$TEMPLATE_FILE" > "$CONFIG_FILE"

if [ "${LIVEKIT_R1_RENDER_ONLY:-}" = "1" ]; then
  cat "$CONFIG_FILE"
  exit 0
fi

if sysctl -w net.core.rmem_max=5000000 net.core.rmem_default=5000000 >/dev/null 2>&1; then
  echo "livekit-r1-entrypoint: set UDP receive buffers to 5000000" >&2
else
  echo "livekit-r1-entrypoint: could not set UDP receive buffers to 5000000; continuing" >&2
fi

if [ "$R1_CONFIG" = "C" ]; then
  echo "livekit-r1-entrypoint: Config C; advertising ${NODE_IP}:7882 and 6PN ${V6}" >&2
else
  echo "livekit-r1-entrypoint: Config ${R1_CONFIG}; advertising ${NODE_IP}:7882" >&2
fi
# livekit-server also reads LIVEKIT_KEYS from the environment, in its own
# "key: secret" format, which conflicts with our validated form. The keys are
# already rendered into $CONFIG_FILE, so drop the env copy.
unset LIVEKIT_KEYS
exec /livekit-server --config "$CONFIG_FILE"
