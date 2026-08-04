#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${FLY_APP_NAME:-project-hello-api}"
CONFIG_PATH="${FLY_CONFIG_PATH:-app/api/fly.toml}"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required. Install from https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

read_secret() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    read -r -s -p "$key: " value
    echo >&2
  fi
  if [[ -z "$value" ]]; then
    echo "Missing required secret: $key" >&2
    exit 1
  fi
  printf '%s' "$value"
}

set_secret() {
  local key="$1"
  local value
  value="$(read_secret "$key")"
  flyctl secrets set --app "$APP_NAME" --config "$CONFIG_PATH" "$key=$value" >/dev/null
  echo "set $key"
}

set_secret SUPABASE_URL
set_secret SUPABASE_SERVICE_ROLE_KEY
set_secret DEEPSEEK_API_KEY
set_secret LIVEKIT_URL
set_secret LIVEKIT_API_KEY
set_secret LIVEKIT_API_SECRET
set_secret WORKER_CONTEXT_SECRET

echo "Fly API secrets configured for $APP_NAME."
