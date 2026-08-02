# Phase 9 Operations Runbook

Scope: Phase 9 product operations — server-authoritative candidate consent,
maintenance mode, quota reservations, appeals, notes, notifications, and the
admin/status surface. This runbook is **truthful**: it documents what the
system actually does and the residual gaps that are intentionally open.

---

## 1. Maintenance mode

- State lives in `system_config` under key `maintenance`, written atomically
  by the service-role-only `toggle_maintenance` RPC (admin audit in the same
  transaction).
- **New-work gates** (`POST /api/screening/start`, `POST /api/livekit/start`,
  `POST /api/livekit/exchange`) fail closed (503 `maintenance_mode`) while
  maintenance is enabled **or** when the DB read fails. A DB read failure
  never silently proceeds into a possibly-drained system.
- **Allowed during maintenance** (deliberately NOT gated): active-call
  continuation, worker persistence, assessment/scoring, candidate consent
  status/submit, appeal submission, status/health, and the admin clear-toggle.
- Admin starts pass through (`allowAdmin`) so an operator can still operate.

## 2. Server-authoritative consent

- Consent status/template/submit are **public** but the candidate's opaque
  invite token is validated inline (SHA-256 lookup) **before any DB write**.
  Unknown/expired/revoked/consumed invites are indistinguishable (stable 404).
- The consent flow never exposes `candidate_id`, PII, or token/digest.
- `POST /api/candidate-consent/submit` requires the **active exact template**;
  when it is missing/inactive the route returns a stable 503
  `consent_template_unavailable` (never raw internals). Granted consent must
  satisfy **all** template `required_consents`; `job_application` alone can
  never unlock AI/recording. Decline is append-only and never consumes or
  revokes the invite.
- `POST /api/livekit/exchange` re-checks the **latest** consent record
  (regardless of status — a later declined/withdrawn/expired record overrides
  an older grant) plus the active template **before** the atomic CAS consume.
  Failure → stable 409 `consent_required` and the invite is left unconsumed.
- The web join page keeps the raw invite only in memory after the fragment is
  removed; it never places the token in query/path/local/session storage or
  logs, and never uses a `?consent=` parameter.

## 3. Appeals

- `POST /api/appeals/grants` (interviewer+/admin, ownership) persists only the
  SHA-256 digest in the separate `appeal_grants` table; the plaintext token is
  returned exactly once. Expiry is explicit and bounded (1–72 hours).
- `POST /api/appeals` (public, grant-authenticated) builds a **minimized**
  snapshot server-side (`assessment_id`, `version_hash`, numeric scores,
  recommendation only — never transcript/resume/contact/free-text/raw) and
  calls the atomic `create_appeal` RPC, which consumes the grant and sets
  `candidates.decision_use_blocked_at`.
- While `decision_use_blocked_at` is set:
  - candidate status transitions return 409 `decision_use_blocked`;
  - the assessment service **does not** rewrite candidate status;
  - the web hides the automated scorecard/recommendation and shows a human
    review banner.
- `POST /api/appeals/:appealId/review` is a legal CAS via `review_appeal`
  (immutable `appeal_review_events`); the block is cleared only when no
  unresolved appeals remain. The pre-appeal candidate status is preserved for
  human review — the appeal RPC never rewrites it.

## 4. Quota reservations

- Enforced only when an enabled `quota_policies` row exists (disabled by
  default → legacy start behavior preserved).
- `POST /api/screening/start` and `POST /api/livekit/start` require a bounded
  `Idempotency-Key` header. `check_and_reserve_quota` projects committed usage
  **plus pending reservations** under a `FOR UPDATE` lock, so two concurrent
  requests for the final slot cannot both reserve. Cost units always come from
  the policy, never the client.
- Success → `commit_quota_reservation`; any failure → `release_quota_reservation`
  (compensation). A duplicate key returns a stable 409 (`idempotency_replay` /
  `request_in_flight` / `idempotency_key_exhausted`) and never double-reserves.
- `warning_percentage` is nullable with no default — no warning is generated
  when unset. When configured, the reserve RPC reports `warning_reached` and a
  `quota_warning` notification intent may be logged (log only, no send).
- **Residual:** replaying an already-committed start returns a stable 409; the
  existing session is not returned. **Residual:** a commit failure after a
  successful session creation leaves a dangling `reserved` row (usage not
  incremented); a future reconciliation must expire stale `reserved` rows.

## 5. Notifications

- `insertNotificationIntent` is an idempotent log (UNIQUE idempotency_key;
  23505 replay → `created:false`, no duplicate row). No provider send exists
  anywhere.
- The assessment service logs an `assessment_ready` intent (bounded IDs only —
  no contact data) **only after** the assessment row is persisted.
- **Residual:** assessment insert and intent insert are separate Supabase
  calls; atomicity is not claimed. If the intent insert fails after a
  successful assessment, a future poll/reconciliation job (or an idempotent
  retry on the next assessment read) fills the gap. A failed intent insert
  never fabricates a delivery and never fails the scoring.
- Candidate-facing delivery is disabled by design until channel AND template
  approval AND explicit consent exist (external-pending register).

## 6. Admin surface

- `/api/admin/*` requires admin at the router boundary.
- `GET /api/admin/members` returns opaque `{user_id, role, active}` only — no
  email, no auth.users join.
- `PATCH /api/admin/members/:userId` → `update_membership` RPC (last-active
  admin and self-modification are atomic denials).
- `GET /api/admin/sessions` is a bounded admin session view (optional strict
  status filter, limit ≤ 100, bounded offset). It returns ONLY `id`,
  opaque `candidate_id`/`role_id`, `status`, `created_at`, `started_at`,
  `ended_at` — no candidate name/email/phone/resume/transcript/recording/
  object key/model/provider/raw error. The admin UI lists sessions so the
  override no longer requires a pre-known UUID.
- `POST /api/admin/sessions/:sessionId/override` is a bounded CAS RPC with an
  audit row in the same transaction. Overrides never resurrect
  failed/cancelled/expired/deleted sessions.
- `GET /api/admin/audit` is a bounded, redacted audit list: allowlisted fields
  only (`id`, `action`, `actor_type`, opaque `actor_id`, `target_type`,
  opaque `target_id`, `result`, `created_at`). `metadata`, `source_ip`,
  correlation IDs, contact data, transcript/resume text, token/digest and
  error details are never returned — minimization by construction (explicit
  column selection in the route).
- `GET/POST /api/admin/quotas` and `PATCH /api/admin/quotas/:id` administer
  quota policies (scope/scope_id, mode, max_sessions, max_cost_units,
  cost_units_per_session, nullable warning_percentage, period_days, enabled)
  via the atomic service-role-only `upsert_quota_policy` RPC, which writes a
  `quota_override` audit row in the same transaction. Cost units are ABSTRACT
  admin integers — never currency/provider price, and the client can never
  supply the actor id (it is always derived from the authenticated session).
  Policies remain DISABLED by default; enforcement engages only once enabled.
  A PATCH of a nonexistent policy returns 404 without creating a row.
- `/api/me` is authenticated only (never public) and returns the authoritative
  membership role/active; the web role UX comes from `/api/me`, never editable
  app_metadata, and fails closed when it cannot be resolved.
- No API gaps remain for the Phase 9 OPS-01/OPS-05 admin views — audit,
  sessions and quota policy configuration are all backed by real endpoints.

## 7. CSV export (scorecard + transcript)

- `GET /api/export/:candidateId/csv` (authenticated, ownership-scoped) exports
  BOTH the scorecard and the candidate's transcript turns as one CSV with a
  clear `record_type` column (`scorecard`|`transcript`) and deterministic
  ordering (scorecard by assessment `created_at` asc; transcript by session
  `created_at` asc then `turn_index` asc).
- Fields: opaque session/assessment ids, turn index, speaker allowlist
  (bot|candidate), transcript text, numeric score dimensions, recommendation,
  timestamps. No contact/resume/recording/object-key/model/provider/raw
  internals.
- RFC4180 quoting + UTF-8 BOM; `Content-Type: text/csv; charset=utf-8`;
  safe fixed UUID-derived filename `screening-export-<uuid>.csv`.
- Formula-injection defense is applied to EVERY string cell — including
  transcript text and leading-whitespace/control-char payloads
  (first meaningful char `= + - @ TAB CR` → apostrophe prefix). Non-Latin
  text byte-round-trips with the BOM.
- **PDF export remains external-pending** (no PDF library choice yet). No
  PDF claim is made anywhere.

## 8. Public surface and observability

- `GET /api/health` returns `{ ok: true }` only — no model/provider/internal
  dependency leakage.
- `GET /api/status` is minimized (`status`, bounded `maintenance`, `updated_at`).
  A DB read failure reports `degraded` with no internals. The public
  StatusPage and the Layout indicator use only this endpoint — no fake alert or
  provider-sync.

## 9. Residuals and external-pending items (truthful)

- Legal-approved consent copy and multilingual translations are external-pending;
  the template endpoint fails closed (404/503) when no active template exists.
- PDF export library, real notification delivery, provider cost model
  (`cost_units_per_session`), LiveKit Cloud deployment, Infisical, VPS
  provisioning, and production acceptance remain owner-external.
- Stale `reserved` quota rows and notification-intent atomicity are documented
  reconciliation residuals above.
