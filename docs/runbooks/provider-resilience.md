# Provider Resilience — REL-05 and REL-06

Status: **Explicitly partial implementation — foundation laid, gaps documented.**

Maps to PLAN.md tasks:
- **REL-05**: Provider timeouts and circuit breaker
- **REL-06**: Fallback decision documentation

---

## 1. Outbound Boundary Inventory

| Boundary | Location | Code owner | Circuit breaker | Timeout | Gap |
|---|---|---|---|---|---|
| `claude` CLI child process | `app/api/src/lib/claude.ts` | Node API | ✅ `provider-resilience.ts` | ✅ configurable, bounded output | Platform-safe kill (no process-group; Windows: `child.kill` only, see §3) |
| Scoring-trigger HTTP POST | `app/voice-livekit/persistence.py` | Python worker | ✅ `provider_resilience.py` | ✅ connect/read/write/pool | Lazy httpx transport — requires httpx at call time, not import time |
| Supabase DB (sync client) | `app/voice-livekit/persistence.py` | Python worker | ❌ | ❌ | `supabase-py` client manages its own transport; no timeout or breaker wrapper in this PR. Future: add per-query timeout + backoff. |
| LiveKit STT (Sarvam) | `app/voice-livekit/agent.py` via SDK | SDK-internal | ❌ | ❌ | SDK-internal; `livekit.plugins.sarvam.STT` constructor exposes no timeout/breaker parameter |
| LiveKit TTS (Sarvam) | `app/voice-livekit/agent.py` via SDK | SDK-internal | ❌ | ❌ | SDK-internal; `livekit.plugins.sarvam.TTS` constructor exposes no timeout/breaker parameter |
| LiveKit LLM (Anthropic) | `app/voice-livekit/agent.py` via SDK | SDK-internal | ❌ | ❌ | SDK-internal; `livekit.plugins.anthropic.LLM` accepts model name only |
| LiveKit VAD (Silero) | `app/voice-livekit/agent.py` via SDK | SDK-internal | ❌ | ❌ | Local model; not a network provider |

### SDK-internal Gap (Honest Assessment)

The LiveKit Agents SDK handles STT/TTS/LLM network calls internally.
No constructor parameter exposes timeout, retry, or circuit-breaker configuration
for `sarvam.STT`, `sarvam.TTS`, or `anthropic.LLM` in the installed package
(as observed in tracked source code). No pinned `requirements.txt` or
`pyproject.toml` exists for `app/voice-livekit` in this repository;
the SDK version is untracked.

**This PR does not claim to control SDK-internal calls.** A future REL-05
extension should either:
- Wrap the `AgentSession` with a timeout-aware proxy at the session level, or
- Contribute timeout/breaker support upstream to LiveKit, or
- Replace the provider with one that exposes timeout configuration.

Until then, an SDK-internal STT/TTS/LLM hang can stall the voice worker. The
worker's `SIGTERM` handler (REL-08) provides a last-resort recovery.

---

## 2. Circuit Breaker Design

### States

```
                    ┌──────────┐
         ┌──────────►  CLOSED  ◄──────────┐
         │          └─────┬────┘          │
         │                │               │
         │     threshold  │  success      │
         │     exceeded   │  (half-open)  │
         │                │               │
         │          ┌─────▼────┐          │
         │          │   OPEN   │          │
         │          └─────┬────┘          │
         │                │               │
         │     cooldown   │               │
         │     elapsed    │               │
         │                │               │
         │          ┌─────▼────┐          │
         │          │HALF_OPEN │          │
         │          └─────┬────┘          │
         └────────────────┘               │
              failure (reopens) ──────────┘
```

### Configuration

| Parameter | Node default | Python default | Description |
|---|---|---|---|
| `failureThreshold` | 5 | 3 | Consecutive provider failures before opening |
| `cooldown` | 30 000 ms | 30 s | Time in OPEN before allowing one probe |
| `clock` | `performance.now` | `time.monotonic` | Injected monotonic clock |

### Failure Classification

| Outcome | Counts toward breaker? | Classification |
|---|---|---|
| Process spawn failure | ✅ Yes | `CLI spawn_failed` |
| Process timeout | ✅ Yes | `CLI timeout` |
| Non-zero exit code (CLI) | ✅ Yes | `CLI non_zero_exit` |
| stdout/stderr exceeds byte cap | ✅ Yes | `CLI output_limit` |
| HTTP timeout (connect/read/write/pool) | ✅ Yes | `HTTP timeout` |
| HTTP connection refused / DNS failure | ✅ Yes | `HTTP connection` |
| HTTP 408 / 429 | ✅ Yes | `HTTP protocol` (rate-limit / timeout counted) |
| HTTP 5xx | ✅ Yes | `HTTP protocol` |
| HTTP 4xx (excluding 408/429) | ❌ No | `BusinessError` |
| JSON parse failure | ❌ No | `BusinessError` |
| Validation error | ❌ No | `BusinessError` |

### Half-Open Probe Guarantee

Exactly one probe is allowed when the breaker transitions from OPEN to HALF_OPEN.
Concurrent probes are rejected with `ProviderError("connection")` (stable category,
no dynamic text). This prevents stampede on recovery.

---

## 3. Hardened Node Claude Runner

| Feature | Implementation |
|---|---|
| Bounded process timeout | `timers.setTimeout` kills child (SIGTERM → SIGKILL after 2s) |
| Exactly-once settle | `settleOnce()` guards against error/close/timeout race |
| Clean timers on settle | `clearTimers()` removes both timeout and escalation timers |
| Bounded stdout/stderr | `collectBounded()` tracks Buffer bytes; rejects `output_limit` when cap exceeded |
| Output-limit terminates child | `bufferPromise.catch` kills child immediately on overflow |
| Stdin write/end | Writes prompt to `child.stdin` and ends; handles EPIPE/null stdin |
| Non-disclosing errors | `ClaudeError` with stable category as message; no dynamic values |
| DI for spawn/clock/timers | `createClaudeRunner(deps)` accepts `SpawnFn`, `Clock`, `TimerSet` |
| Single circuit breaker | Default runner configured from env vars; assessment.ts has no separate breaker |
| Platform-safe kill | `child.kill(SIGTERM/SIGKILL)` on all platforms. No `detached:true` — negative PID not used. Windows limitation: cannot SIGKILL orphaned process groups; documented. |
| Spawn throw safety | Synchronous `spawnFn()` throws caught and mapped to `ClaudeError('spawn_failed')` |
| Stream error rejection | `collectBounded()` rejects on stream error (not silent truncated output) |
| Tracked handler removal | Only handlers installed by `collectBounded` are removed; other code's listeners preserved |
| maxBytes validation | Rejects zero/negative/NaN/non-integer `maxBytes` with TypeError |

---

## 4. Python Scoring-Trigger HTTP Hardening

| Feature | Implementation |
|---|---|
| Connect timeout | `SCORING_HTTP_CONNECT_TIMEOUT` (default 10s, safe-parse validated) |
| Read timeout | `SCORING_HTTP_READ_TIMEOUT` (default 180s) |
| Write timeout | `SCORING_HTTP_WRITE_TIMEOUT` (default 30s) |
| Pool timeout | `SCORING_HTTP_POOL_TIMEOUT` (default 10s) |
| Circuit breaker | Configurable threshold/cooldown/timeout from safe env parsing |
| Non-disclosing diagnostics | `redacted_log_message()` uses allowlisted hints only; no session IDs |
| Injectable transport | `AsyncTransport` interface + `HttpxTransport` (lazy httpx) + `FakeTransport` |
| Injectable clock | `Clock` interface + `RealClock` + `FakeClock` |
| Typed outcome | `trigger_scoring()` returns `TriggerOutcome` enum for caller/test |

---

## 5. Fallback Decision Table

**Legend:** ✅ CURRENT = behavior implemented in this PR. ⏳ TARGET = behavior planned for future PRs (REL-01, REL-03, REL-09, OBS-06) but NOT implemented here.

| Failure | CURRENT behavior | TARGET policy | Terminal state | Operator signal |
|---|---|---|---|---|
| `claude` CLI fails (timeout/spawn/exit/output_limit) | ✅ `ClaudeError` thrown through breaker; BusinessError resets streak; circuit_open on open rejection | ⏳ Return degraded score / fallback recommendation | `failed` (scoring) | Log category: `timeout`, `spawn_failed`, `non_zero_exit`, `output_limit`, `circuit_open` |
| Scoring HTTP breaker open | ✅ `circuit_open` category; `trigger_scoring()` returns `TriggerOutcome.BREAKER_OPEN` | ⏳ Queue replay via REL-01/REL-03; alert via OBS-06 | `completed` (scoring deferred) | Log: `[provider] circuit_open assess` |
| Scoring HTTP transport/timeout/5xx/429/3xx | ✅ `trigger_scoring()` returns `TriggerOutcome.TRANSPORT_FAILURE` | ⏳ Queue replay + alert | `completed` (scoring deferred) | Log: `[provider] protocol assess` |
| Scoring HTTP returns 4xx (excl. 408/429) | ✅ `trigger_scoring()` returns `TriggerOutcome.BUSINESS_ERROR` | ⏳ Operator review | `completed` (scoring deferred) | Log: `[livekit-score] business_error` (from caller) |
| LiveKit STT/Sarvam SDK-internal timeout | ❌ NOT CONTROLLED | ⏳ Wrap `AgentSession` proxy or contribute upstream | `failed` if unrecoverable | Worker-level SDK error only |
| LiveKit TTS/Sarvam SDK-internal timeout | ❌ NOT CONTROLLED | ⏳ Same as STT | `failed` | Worker-level SDK error only |
| LiveKit LLM/Anthropic SDK-internal timeout | ❌ NOT CONTROLLED | ⏳ Same as STT | `failed` | Worker-level SDK error only |
| `fail_session()` with raw reason | ✅ Mapped through `_safe_reason_code()`; falls back to `"unknown"` | ⏳ Enriched error taxonomy if needed | `failed` | `external_call_id` stores safe code only |
| Supabase write failure | ⏳ Logged with stable event code; no retry | ⏳ Durable queue + replay via REL-01/REL-02 | `failed` or incomplete | Log: `[livekit-db] turn_save_failed` |

**Forbidden silent behaviors (also TARGET):** returning empty/random score, silently retrying indefinitely, playing dead air, dropping transcript events without trace, continuing with no audio output.

---

## 6. Environment Contract

New variables registered in `config/environment.schema.json`:

### API (`app/api/.env.example`)

| Variable | Default | Constraint |
|---|---|---|
| `BREAKER_FAILURE_THRESHOLD` | 5 | Integer 1–100 |
| `BREAKER_COOLDOWN_MS` | 30000 | Integer 1000–300000 |
| `BREAKER_TIMEOUT_MS` | 60000 | Integer 0–300000 (0 = no timeout) |
| `CLAUDE_MAX_OUTPUT_BYTES` | 5242880 | Integer 1024–104857600 |

All variables reject NaN, Infinity, non-integer, zero/negative, and excessive values at startup via `uint()` helper.

### Voice LiveKit (`app/voice-livekit/.env.example`)

| Variable | Default | Constraint |
|---|---|---|
| `SCORING_BREAKER_THRESHOLD` | 3 | Integer ≥1, safe-parsed |
| `SCORING_BREAKER_COOLDOWN_SEC` | 30 | Float >0, safe-parsed |
| `SCORING_BREAKER_TIMEOUT_SEC` | 180 | Float >0, safe-parsed |
| `SCORING_HTTP_CONNECT_TIMEOUT` | 10 | Float >0, safe-parsed |
| `SCORING_HTTP_READ_TIMEOUT` | 180 | Float >0, safe-parsed |
| `SCORING_HTTP_WRITE_TIMEOUT` | 30 | Float >0, safe-parsed |
| `SCORING_HTTP_POOL_TIMEOUT` | 10 | Float >0, safe-parsed |

All Python-side variables are parsed by `parse_env_float()` / `parse_env_int()` which reject NaN, Infinity, bool, zero, negative, and excessive values.

---

## 7. Verification

```bash
# Node tests (deterministic, no real child process/network)
cd app/api && npm ci && npm t -- --reporter=verbose src/__tests__/provider-resilience.test.ts

# Full API tests (239 tests: 53 provider-resilience + 186 validation/security)
cd app/api && npm ci && npm test

# Python tests (uses pytest runner, test classes inherit unittest.TestCase)
cd app/voice-livekit && python3 -m pytest tests/test_provider_resilience.py -v --tb=short
# NOTE: Some tests (TestTriggerScoringBreakerOpen) call get_scoring_transport()
# which constructs HttpxTransport — these require httpx installed.
# Tests using FakeTransport (the majority) do not require httpx.

# Python compilation check
python3 -m py_compile app/voice-livekit/provider_resilience.py app/voice-livekit/persistence.py

# Lazy import verification (no httpx at module import time)
python3 -c "import sys; sys.modules.pop('httpx', None); import provider_resilience; print('ok')"

# Environment contract check
node scripts/check-env-contract.mjs && node scripts/check-env-contract.test.mjs

# ADR check
node scripts/check-adrs.mjs

# Secret scan
./scripts/scan-secrets.sh --committable

# Git whitespace check
git diff --check
```

---

## 8. Known Gaps

1. **LiveKit SDK-internal STT/TTS/LLM calls are NOT controlled** by this PR.
   No timeout or breaker parameter exists in the SDK constructors for `sarvam.STT`,
   `sarvam.TTS`, or `anthropic.LLM`. Documented in §1 above.

2. **Supabase DB writes** (`save_turn`, `complete_session`, `fail_session`) use
   the synchronous `supabase-py` client via `asyncio.to_thread`. No circuit breaker
   or timeout wrapper covers these calls in this PR. Supabase is an external
   provider; this is an acknowledged gap for future work.

3. **No pinned Python requirements** exist for `app/voice-livekit`. The unit tests
   use `python3 -m pytest` (not stdlib `unittest` runner directly, though the
   test classes inherit from `unittest.TestCase`). `httpx` is **lazy-imported** at
   `HttpxTransport` construction time, not at module import time — importing
   `provider_resilience` does not require httpx. Tests using `FakeTransport` never
   need httpx. However, tests that exercise `trigger_scoring()`
   (`TestTriggerScoringBreakerOpen`) call `get_scoring_transport()` which does
   construct `HttpxTransport`; these require httpx at test time. A future PR
   should add `pyproject.toml` or `requirements.txt`.

4. **No alerts or reconciliation** are implemented (REL-06, OBS-06, REL-09 are
   separate future tasks).

5. **`agent.py` is not modified** in this PR. The SDK-internal gap remains
   unaddressed for voice worker STT/TTS/LLM resilience.

6. **Platform-specific kill limitation**: The Node runner uses `child.kill()`
   (same on all platforms). It does NOT use `detached:true` or negative-PID
   process-group kill. On Windows, SIGKILL cannot terminate orphaned child
   processes; the escalation timer (2s after SIGTERM) sends SIGKILL which is
   best-effort. On POSIX, `child.kill('SIGKILL')` kills the direct child but not
   grandchild processes spawned by the child. A future PR could add `tree-kill`
   or platform-specific process-group management if needed.

7. **`fail_session` reason-code mapping**: The `reason` parameter is mapped
   through a closed allowlist (`error`, `timeout`, `disconnect`, `unknown`).
   Unrecognized reasons fall back to `"unknown"`. This prevents exception
   messages, candidate data, or session identifiers from being persisted in
   `external_call_id`. The mapping is intentionally restrictive — if a new
   reason code is needed it must be added to `_FAIL_REASON_CODES`.
