#!/usr/bin/env bash
# On-demand (scale-to-zero) deploy reconciliation for a voice-worker Fly app.
#
# WHY THIS FILE EXISTS
# --------------------
# The always-on deploy path in .github/workflows/deploy-fly.yml gates each
# release on a CURRENT, watermarked "registered worker" proof: it deploys, then
# refuses to pass until the just-released worker logs a registration at/after a
# pre-deploy watermark. That proof assumes the worker is ALWAYS running, so a
# genuinely-down worker fails the deploy closed.
#
# When on-demand orchestration is ON for an app (its Fly config's
# `[env] WORKER_ORCHESTRATION = "worker"`), that assumption is FALSE: the app is
# scaled to zero and NO worker is registered between calls. Running the always-on
# proof against it would fail every deploy closed on a "no current registration"
# that is the correct, intended steady state — not an incident.
#
# This script reconciles the two without discarding the safety property. For an
# orchestration-ON app it:
#   1. Picks one pool machine and STARTS it (recording whether we were the one
#      who started it, so cleanup is exact and idempotent).
#   2. WAITS for that machine to register with LiveKit — the SAME watermarked
#      current-registration proof the always-on path uses, so a broken image
#      still fails the deploy closed.
#   3. Runs the actual `flyctl deploy`.
#   4. Re-verifies CURRENT registration after the deploy (the proof that matters:
#      the NEW image registers).
#   5. Returns the machine to STOPPED — but ONLY if this script started it, and
#      ALWAYS (success or failure) via a trap, so the deploy never leaves a
#      machine running that it started. A machine that was already running when
#      we arrived (e.g. a live call) is never stopped by us.
#
# The always-on path is UNCHANGED and this script is never invoked for it; the
# workflow selects between the two by the config flag alone. The OFF path is
# therefore byte-identical to today.
#
# CONTRACT (all via environment, no secrets on argv, nothing echoed):
#   APP           required  Fly app name (e.g. project-hello-phone-voice)
#   FLY_CONFIG    required  Fly config file, relative to CWD (e.g. fly.phone.toml)
#   WATERMARK     required  ISO-8601 UTC captured BEFORE this script starts the
#                           machine, so a stale historical log cannot satisfy the
#                           proof (identical semantics to the always-on job).
#   FLY_API_TOKEN required  app-scoped deploy token (consumed by flyctl only)
#   READY_ATTEMPTS optional registration-poll attempts       (default 24)
#   START_ATTEMPTS optional machine-start-state poll attempts (default 60)
#   SLEEP_SECONDS  optional per-poll sleep                    (default 5; 0 in tests)
#
# Idempotent / resumable: safe to re-run. It starts at most one machine, and its
# cleanup stops only a machine THIS run started, so an interrupted+retried deploy
# cannot accumulate started machines.
set -euo pipefail

: "${APP:?APP is required}"
: "${FLY_CONFIG:?FLY_CONFIG is required}"
READY_ATTEMPTS="${READY_ATTEMPTS:-24}"
START_ATTEMPTS="${START_ATTEMPTS:-60}"
SLEEP_SECONDS="${SLEEP_SECONDS:-5}"

if [ -z "${WATERMARK:-}" ]; then
  # Same fail-closed refusal as the always-on job: an empty watermark would let
  # ANY historical "registered worker" line satisfy the proof.
  echo "::error::empty pre-release watermark - refusing to verify (an empty watermark would accept ANY historical 'registered worker' line)"
  exit 1
fi

# The machine THIS run started (empty ⇒ nothing to clean up). Set only after a
# successful start we caused, so the trap never stops a pre-existing machine.
STARTED_MACHINE=""

cleanup() {
  # Always runs. Return a machine to STOPPED ONLY if we started it — never a
  # machine that was already running (a live call) when we arrived.
  if [ -n "$STARTED_MACHINE" ]; then
    echo "returning machine $STARTED_MACHINE to STOPPED (started by this deploy run)"
    # Best-effort: a failed stop must not mask the deploy's real exit status, but
    # it MUST be surfaced so an operator can stop a stray machine by hand.
    flyctl machine stop "$STARTED_MACHINE" -a "$APP" \
      || echo "::warning::could not stop machine $STARTED_MACHINE on $APP; stop it manually (fly machine stop $STARTED_MACHINE -a $APP)"
  fi
}
trap cleanup EXIT

# ── registration proof: the SAME anti-stale watermark comparison as always-on ──
# Accept ONLY a "registered worker" line whose ISO-8601 timestamp is at/after the
# pre-deploy watermark (ISO-8601 sorts lexically). Returns 0 on proof, 1 on none.
verify_current_registration() {
  local phase="$1"
  for _ in $(seq 1 "$READY_ATTEMPTS"); do
    ts="$(flyctl logs -a "$APP" --no-tail 2>/dev/null \
          | grep 'registered worker' \
          | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' \
          | sort | tail -1 || true)"
    if [ -n "$ts" ] && [ "$(printf '%s\n%s\n' "$WATERMARK" "$ts" | sort | tail -1)" = "$ts" ]; then
      echo "$APP worker registered at $ts (>= watermark $WATERMARK) [$phase]"
      return 0
    fi
    sleep "$SLEEP_SECONDS"
  done
  # One unsuppressed logs attempt so a logs-transport/token failure is
  # distinguishable from a genuinely unregistered worker (M-1 misattribution).
  flyctl logs -a "$APP" --no-tail || true
  return 1
}

echo "orchestration ON for $APP: start -> verify registration -> deploy -> verify -> stop"
flyctl status -a "$APP"

# ── 1. pick a STOPPED pool machine and start it ───────────────────────────────
# Parse machine state from `--json` (named fields), NOT the human table. RCA
# 2026-09-06: `flyctl machine list` renders a box-drawing bordered table, so
# `awk '$NF=="stopped"'` read the SIZE column ("performance-1x:2048MB"), matched
# nothing, and this picker returned empty on EVERY run — no machine was ever
# started, and the proof then only saw stale registrations and failed closed.
# JSON is stable across flyctl table-rendering changes (the thing that broke).
# Prefer a stopped machine so we never disturb one that is mid-call.
machine_id="$(flyctl machine list -a "$APP" --json 2>/dev/null \
  | jq -r 'map(select(.state=="stopped")) | .[0].id // empty' || true)"

if [ -n "$machine_id" ]; then
  echo "starting pool machine $machine_id on $APP"
  flyctl machine start "$machine_id" -a "$APP"
  STARTED_MACHINE="$machine_id"
  # Wait for the machine to reach a started state before expecting registration.
  started=false
  for _ in $(seq 1 "$START_ATTEMPTS"); do
    state="$(flyctl machine list -a "$APP" --json 2>/dev/null \
      | jq -r --arg id "$machine_id" '.[] | select(.id==$id) | .state' | tail -1 || true)"
    if [ "$state" = "started" ]; then started=true; break; fi
    sleep "$SLEEP_SECONDS"
  done
  if [ "$started" != true ]; then
    echo "::error::machine $machine_id on $APP did not reach 'started' state"
    exit 1
  fi
else
  # Fail closed (RCA robustness): when orchestration is ON the steady state is
  # scaled-to-zero, so "no stopped machine" almost always means the pool is
  # unprovisioned or every machine is already up — NOT a healthy state to prove
  # against. Only tolerate an already-STARTED pool machine (the true live-call
  # case); otherwise error accurately instead of falling through to the
  # misleading "start did not register" proof failure.
  any_started="$(flyctl machine list -a "$APP" --json 2>/dev/null \
    | jq -r 'map(select(.state=="started")) | length' || echo 0)"
  if [ "${any_started:-0}" = "0" ]; then
    echo "::error::no pool machine to start on $APP (none stopped, none started) - provision the pool (register_voice_worker) before activating orchestration"
    exit 1
  fi
  echo "::warning::no STOPPED pool machine on $APP; relying on an already-started machine to satisfy the registration proof"
fi

# ── 2. verify the CURRENT (pre-deploy) worker registers ───────────────────────
# Only meaningful when THIS run STARTED a stopped pool machine: the proof
# confirms that freshly-booted machine registered at/after our watermark before
# we ship. When we RELIED on an already-started machine (no stopped pool machine
# to start — e.g. a lane whose only machine is always-on), there is NO fresh boot
# to wait for: the machine is demonstrably up (it is what we are relying on) and
# its registration necessarily PREDATES our watermark, so a watermarked
# pre-deploy proof can never pass and need not — it would only prove the OLD
# image, which is already running. The post-deploy proof (a FRESH watermark after
# `flyctl deploy` restarts the worker) is the real gate on the NEW image and
# still fails closed. RCA 2026-09-06: the browser lane's sole machine is
# always-on, so this pre-proof failed EVERY browser deploy on a stale
# registration; skipping it here (only in the rely-on-started branch) fixes that
# without weakening the new-image gate. Phone is unaffected — it always starts a
# stopped pool machine, so STARTED_MACHINE is set and the pre-proof runs.
if [ -n "$STARTED_MACHINE" ]; then
  if ! verify_current_registration pre-deploy; then
    echo "::error::no current 'registered worker' log at/after watermark $WATERMARK on $APP (pre-deploy start did not register)"
    exit 1
  fi
else
  echo "relying on an already-started machine on $APP; skipping the watermarked pre-deploy proof (no fresh boot to wait for) — the post-deploy proof gates the new image"
fi

# ── 3. deploy the new image ───────────────────────────────────────────────────
flyctl deploy --remote-only --config "$FLY_CONFIG"

# ── 4. re-verify CURRENT registration for the NEW image via a CLEAN boot ───────
# RCA 2026-09-08: `flyctl deploy` rolls the new image out by restarting the pool
# machines. On a scale-to-zero worker app their desired state is STOPPED, so
# WITHIN the rollout window a machine is cycled (start -> stop -> start) every
# ~10-15s, while its cold boot needs ~27s (import ~15s + connect/register ~12s)
# to log "registered worker". The old post-deploy proof merely polled logs for a
# registration at/after a watermark captured the instant `flyctl deploy`
# returned; that raced two ways and failed a GENUINELY-good deploy:
#   (a) a machine that registered DURING the rollout did so a few seconds BEFORE
#       the post-deploy watermark, so it was (correctly) rejected as pre-watermark;
#   (b) the pool machine this run controls was still being cycled by the rollout
#       and never got an uninterrupted ~27s window to register after the watermark.
# The image itself deploys fine (the Fly release completes and every machine is
# on the new image); only the PROOF failed — turning every on-demand voice deploy
# red while the code was actually live.
#
# Fix: after the rollout completes, force ONE churn-free boot of the pool machine
# THIS run controls — stop it, wait for STOPPED, capture the watermark, start it,
# wait for STARTED — then run the SAME watermarked registration proof. A machine
# booted cleanly OUTSIDE the rollout registers deterministically in ~27s (well
# inside the 120s poll), so a healthy new image passes and a broken one still
# fails closed. When this run only RELIED on an already-started machine (no pool
# machine it controls), fall back to the original watermark-then-poll proof.
if [ -n "$STARTED_MACHINE" ]; then
  # Settle to a known STOPPED state so the next start is a clean boot on the new
  # image, not a restart that lands mid-rollout-churn. Best-effort: a machine the
  # rollout already stopped is fine.
  flyctl machine stop "$STARTED_MACHINE" -a "$APP" || true
  for _ in $(seq 1 "$START_ATTEMPTS"); do
    state="$(flyctl machine list -a "$APP" --json 2>/dev/null \
      | jq -r --arg id "$STARTED_MACHINE" '.[] | select(.id==$id) | .state' | tail -1 || true)"
    if [ "$state" = "stopped" ]; then break; fi
    sleep "$SLEEP_SECONDS"
  done
  # Watermark AFTER settling and BEFORE the clean start, so the registration we
  # accept can only come from this fresh NEW-image boot — never the pre-deploy
  # (old-image) registration this same machine logged in step 2.
  WATERMARK="$(date -u +%Y-%m-%dT%H:%M:%S)"
  echo "starting pool machine $STARTED_MACHINE for a churn-free post-deploy proof on $APP"
  # Tolerate an "already started" race (the settle-stop may not have fully landed):
  # the state poll below is the real gate, and cleanup stops this machine regardless.
  flyctl machine start "$STARTED_MACHINE" -a "$APP" || true
  post_started=false
  for _ in $(seq 1 "$START_ATTEMPTS"); do
    state="$(flyctl machine list -a "$APP" --json 2>/dev/null \
      | jq -r --arg id "$STARTED_MACHINE" '.[] | select(.id==$id) | .state' | tail -1 || true)"
    if [ "$state" = "started" ]; then post_started=true; break; fi
    sleep "$SLEEP_SECONDS"
  done
  if [ "$post_started" != true ]; then
    echo "::error::machine $STARTED_MACHINE on $APP did not reach 'started' for the post-deploy proof"
    exit 1
  fi
  if ! verify_current_registration post-deploy; then
    echo "::error::no current 'registered worker' log at/after watermark $WATERMARK on $APP (deployed image did not register)"
    exit 1
  fi
else
  # Rely-on-started branch (e.g. a lane whose sole machine is always-on): there is
  # no pool machine this run controls to reboot, so keep the original proof — a
  # fresh watermark then poll for the post-deploy restart's registration.
  WATERMARK="$(date -u +%Y-%m-%dT%H:%M:%S)"
  if ! verify_current_registration post-deploy; then
    echo "::error::no current 'registered worker' log at/after watermark $WATERMARK on $APP (deployed image did not register)"
    exit 1
  fi
fi

echo "$APP deployed and re-registered on-demand; cleanup will return the pool machine to STOPPED"
# trap cleanup stops the machine we started, on this success exit.
