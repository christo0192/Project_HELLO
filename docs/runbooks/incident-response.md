# Incident Response Runbook (OBS-09)

## Status

**Pre-production — no real incident response tools wired.** This runbook
defines the processes and playbooks that will be used once the system is
in production.  No PagerDuty, OpsGenie, or Slack alerting is configured.

---

## Severity Levels

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| P0 | Complete service outage or data loss | Immediate (≤ 15 min) | API returning 5xx for all requests; session data corruption; security breach |
| P1 | Major feature impairment | ≤ 30 min | Scoring endpoint failing; sessions not completing; voice workers unable to start |
| P2 | Partial impairment, degraded UX | ≤ 4 hours | Elevated latency; occasional CSP violations; single-provider failure with fallback |
| P3 | Minor issue, no user impact | ≤ 1 week | Non-critical log noise; dashboard cosmetic issue; documentation gap |
| P4 | Internal improvement | Backlog | Performance optimisation; test coverage; tech debt |

---

## Incident Lifecycle

```
Detection → Triage → Investigation → Resolution → Postmortem
```

### 1. Detection

Detection sources (when wired):

- **Alert rules** (see SLO/Error Budget runbook)
- **Manual report** via internal channel or support ticket
- **Synthetic monitoring** health-check endpoint failure
- **Observability signals**: unhandled error spikes, session failure rate increase

### 2. Triage

| Step | Action | Owner |
|------|--------|-------|
| 2.1 | Acknowledge incident; declare severity | First responder |
| 2.2 | Verify incident is not a test/false positive | First responder |
| 2.3 | Open incident channel (e.g. Slack channel, meeting bridge) | First responder |
| 2.4 | Identify affected SLO(s); determine if error budget is burning | First responder |
| 2.5 | Assign incident commander | Senior engineer |
| 2.6 | Post initial timeline: when did symptoms start, what changed | First responder |

### 3. Investigation

| Step | Playbook |
|------|----------|
| 3.1 | Check `correlationId` in error logs to scope blast radius |
| 3.2 | Examine error_category distribution in `error_unhandled` events |
| 3.3 | Check circuit-breaker status for each provider (see provider-resilience.md) |
| 3.4 | Check queue depth and DLQ for job backpressure |
| 3.5 | Review recent deployments; check `PLAN.md` for recent changes |
| 3.6 | If Supabase related: run session-reconciliation.md repair plans |

### 4. Resolution

| Action | Tactics |
|--------|---------|
| Rollback | Revert last deployment; verify via health endpoint |
| Feature flag | Disable affected feature via environment variable |
| Circuit-breaker manual override | Force-open or force-close a provider circuit |
| Supabase repair | Run reconciliation repairs from session-reconciliation.md |
| Queue drain | Replay DLQ jobs after root cause resolved |
| Data fix | Apply idempotent SQL migration or manual patch |

### 5. Postmortem

**Required for P0/P1 incidents.** P2+ at discretion of incident commander.

| Element | Description |
|---------|-------------|
| Timeline | Wall-clock times for each detection→resolution step |
| Root cause | Specific technical failure (with correlation IDs) |
| Impact | Affected users, sessions, data, SLO burn |
| Detection gaps | Why wasn't it caught earlier? |
| Resolution gaps | What made the fix take longer than ideal? |
| Action items | Tracked in issues with owners and deadlines |

---

## Communication

During an active incident:

1. **Status updates** in the incident channel every 30 minutes (or more frequently
   for P0).
2. **External communication** (if applicable): coordinated through a single
   designated comms lead.
3. **Post-resolution summary** in the incident channel within 1 hour of
   resolution, even if full postmortem is pending.

---

## Escalation Path

```
Individual engineer
  → Team lead / senior engineer
    → Engineering manager
      → CTO / VP Engineering
        → CEO (P0 only)
```

### Escalation triggers

- Incident not resolved within target response time
- Incident severity increases
- Cross-team coordination required
- Security or data-privacy implications

---

## Playbooks

### Playbook A: API Unavailable (5xx flood)

1. **Check health endpoint**: `GET /api/health` — if failing, likely
   infrastructure/vendor issue.
2. **Check recent log lines**:
   ```bash
   jq 'select(.event == "error_unhandled") | {timestamp, error_category}'
   ```
3. **Check circuit breakers**: if a provider circuit is open, fallback to
   alternate provider or graceful degradation.
4. **Check Supabase connectivity**: `db_error` events indicate database issues.
5. **Rollback**: if caused by recent deployment, revert immediately.

### Playbook B: Session Failure Rate Spikes

1. **Check session distribution**: are failures specific to one provider
   (LiveKit region, STT/TTS vendor)?
2. **Check provider circuit-breaker** for `provider_resilience` component.
3. **Check room creation**: `GET /api/livekit/start` errors suggest LiveKit
   server issues.
4. **Inspect `session_fail` events** for common `error_category`.
5. **Run reconciliation** `scripts/reconcile-stuck-sessions.ts` if sessions
   were left dangling.

### Playbook C: Scoring Pipeline Degraded

1. **Check `scoring_failed` events** and their `error_category`.
2. **Check trigger_scoring transport**: `http_client_error` vs `http_server_error`.
3. **Verify X-Correlation-ID propagation** from worker → API scoring endpoint.
4. **Check scoring queue depth** (when queue is implemented).
5. **Manually trigger scoring** via admin endpoint (pending implementation).

### Playbook D: Data Inconsistency Detected

1. **Run reconciliation detection** from `session-reconciliation.md`.
2. **Classify inconsistencies**: stuck sessions, orphan rooms, transcript gaps,
   missing recordings, overdue scorecards.
3. **Apply repair plan**: quarantined rows only — no bulk updates without audit.
4. **Verify repair**: re-run detection; all inconsistencies should be resolved
   or quarantined.

### Playbook E: Security or Data Breach Suspected

1. **Isolate**: disable the affected endpoint or disable the entire API if
   necessary (environment variable `DISABLE_ALL_ENDPOINTS=true`).
2. **Audit logs**: extract all log lines for affected correlation IDs.
3. **Preserve evidence**: snapshot logs before any rotation.
4. **Legal/comms**: engage designated security lead and legal counsel.
5. **Postmortem**: mandatory P0 with full timeline.

---

## On-Call Responsibilities

| Responsibility | Description |
|---------------|-------------|
| Acknowledge alerts | Within target response time for severity |
| Triage and declare | Determine severity, open incident channel |
| Investigate | Follow appropriate playbook |
| Communicate | Provide status updates in incident channel |
| Resolve or escalate | Fix or hand off within response time |
| Post-incident | Participate in postmortem |

---

## Testing Incident Response

**Game-day exercises** should be conducted quarterly (pre-production: synthetic
only).  Scenarios:

1. **Provider failure**: simulate circuit-breaker open for STT/TTS provider.
2. **Database degradation**: simulate Supabase timeout/error responses.
3. **Queue stall**: simulate job processing delay.
4. **Scoring endpoint failure**: simulate 5xx from scoring endpoint.
5. **Correlation ID collision**: simulate duplicate header scenario.

---

## Tools and Access

| Tool | Purpose | Status |
|------|---------|--------|
| Logs (structured JSON) | Diagnosis | ✅ OBS-01 implemented |
| Correlation ID | Trace stitching | ✅ OBS-02 implemented |
| Metrics helpers | SLI instrumentation | ✅ OBS-03 implemented (pre-production) |
| Tracing helpers | Span tracking | ✅ OBS-04 implemented (pre-production) |
| Circuit breaker | Provider isolation | ✅ REL-10 implemented |
| Reconciliation | Data consistency repair | Pending (REL-09) |
| Alert notification | Auto-detect incidents | ❌ Not wired |
| Dashboard | Real-time visibility | ❌ Not wired |
| On-call schedule | Engineer rotation | ❌ Not configured |
