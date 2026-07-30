# SLO / Error Budget Runbook (OBS-08)

## Status

**Pre-production — synthetic/local only.** No real Axiom, Datadog, or Prometheus
wiring.  SLIs are instrumented via the metrics helpers (`lib/metrics.ts` /
`observability.metrics`) but no SLO compliance has been measured against a
real workload.  All values below are **targets for synthetic verification**
and will need tuning after production data collection.

---

## Service Level Indicators (SLIs)

### API Availability

| SLI | Definition | Collection Point | Metric Name |
|-----|-----------|------------------|-------------|
| Availability | HTTP requests returning 2xx / total requests | Express middleware | `http_requests_total{status="2xx\|5xx"}` |
| Latency P95 | 95th percentile of request duration | Express middleware (histogram) | `http_request_duration_ms` |
| Error Rate | 5xx responses / total responses | Express middleware | `http_requests_total{status="5xx"}` |
| CSP Violation Rate | CSP reports received / time window | CSP route | `csp_violations_total` |

### Voice Worker Health

| SLI | Definition | Collection Point | Metric Name |
|-----|-----------|------------------|-------------|
| Session Completion | Completed sessions / started sessions | `persistence.complete_session` | `sessions_completed_total` |
| Session Failure Rate | Failed sessions / started sessions | `persistence.fail_session` | `sessions_failed_total` |
| Turn Persistence | Saved turns / attempted turns | `persistence.save_turn` | `turns_saved_total` |
| Scoring Trigger | Successful scoring POST / attempts | `persistence.trigger_scoring` | `scoring_triggers_total` |
| Provider Error Rate | ProviderError count / time window | `provider_resilience.ts` | `provider_errors_total` |

### Queue / Async Health

| SLI | Definition | Collection Point | Metric Name |
|-----|-----------|------------------|-------------|
| Queue Depth | Number of pending jobs | Queue abstraction | `queue_depth` |
| Queue Latency | Age of oldest pending job | Queue abstraction | `queue_latency_sec` |
| DLQ Rate | Dead-lettered jobs / total jobs | Queue abstraction | `dlq_messages_total` |

---

## Service Level Objectives (SLOs)

### Tier 1 — Critical (hard SLO)

| SLO | Target | SLI | Window | Consequence |
|-----|--------|-----|--------|-------------|
| API availability | ≥ 99.5% | `http_requests_total{status="2xx"}` / total | 30-day rolling | P0 incident |
| Session completion | ≥ 95% | completed / started | 30-day rolling | P0 incident |
| Scoring trigger | ≥ 99% | successful / attempted | 30-day rolling | P1 incident |
| Turn persistence | ≥ 99% | saved / attempted | 30-day rolling | P1 incident |

### Tier 2 — Important (soft SLO)

| SLO | Target | SLI | Window | Consequence |
|-----|--------|-----|--------|-------------|
| API latency P95 | ≤ 2000ms | `http_request_duration_ms` | 7-day rolling | P2 investigation |
| Queue processing delay | ≤ 60s | `queue_latency_sec` | 7-day rolling | P2 investigation |
| Provider error rate | ≤ 1% | `provider_errors_total` / total requests | 7-day rolling | P2 investigation |

### Tier 3 — Best-effort

| SLO | Target | SLI | Window |
|-----|--------|-----|--------|
| CSP violation rate | ≤ 10/hr | `csp_violations_total` | 24-hour |
| DLQ rate | ≤ 0.1% | `dlq_messages_total` / total | 30-day rolling |

---

## Error Budget Calculation

Error budget = (1 − SLO target) × total events in window.

### Example: API availability (99.5% over 30 days)

```
Requests per day:    ~10 000 (synthetic estimate)
Window:              30 days = 300 000 requests
Allowed errors:      300 000 × 0.005 = 1 500 errors
Error budget:        1 500 errors per 30 days
```

### Burn Rate

A burn rate of **1** consumes the entire error budget over the SLO window.
A burn rate of **2** exhausts it in half the window.

| Burn Rate | Time to exhaust 30-day budget | Severity |
|-----------|-------------------------------|----------|
| 1         | 30 days                       | —        |
| 2         | 15 days                       | Alert    |
| 4         | 7.5 days                      | P2       |
| 8         | 3.75 days                     | P1       |
| 16        | 1.9 days                      | P0 (page) |

---

## Alert Rules (Synthetic — No Real Provider)

The following alert rules **are defined but not wired to any notification
channel**.  They are intended for a future monitoring platform
(Prometheus + Alertmanager, Grafana Cloud, or equivalent).

```yaml
# Prometheus-style alert rules — NOT deployed to any real provider.

groups:
  - name: api-availability
    rules:
      - alert: HighErrorBudgetBurnRate
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total[5m]))
          ) > 0.005
        for: 10m
        labels:
          severity: critical
          slo: api-availability
        annotations:
          summary: "API error rate above 0.5% over 5m"

      - alert: HighLatencyP95
        expr: histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m])) > 2000
        for: 15m
        labels:
          severity: warning
          slo: api-latency
        annotations:
          summary: "P95 latency above 2s"

  - name: session-health
    rules:
      - alert: HighSessionFailureRate
        expr: |
          (
            rate(sessions_failed_total[30m])
            /
            rate(sessions_completed_total[30m])
          ) > 0.05
        for: 10m
        labels:
          severity: critical
          slo: session-completion
        annotations:
          summary: "Session failure rate above 5%"

      - alert: ScoringFailureRate
        expr: |
          (
            rate(scoring_triggers_total{status="error"}[30m])
            /
            rate(scoring_triggers_total[30m])
          ) > 0.01
        for: 10m
        labels:
          severity: warning
          slo: scoring-trigger
        annotations:
          summary: "Scoring trigger failure rate above 1%"

  - name: queue-health
    rules:
      - alert: QueueDepthHigh
        expr: queue_depth > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Queue depth exceeds 100"

      - alert: QueueStalled
        expr: queue_latency_sec > 120
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Oldest job in queue > 120s"
```

---

## Multi-Window, Multi-Burn-Rate Approach

The alerting rules above implement a simplified single-burn-rate approach.
For production, use **multi-window, multi-burn-rate** with two windows:

1. **Short window** (5m): high sensitivity for fast detection
2. **Long window** (30m): confirmation to avoid false positives

Alert only when **both** windows exceed threshold simultaneously.

### Example for API availability:

```yaml
expr: |
  (
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    /
    sum(rate(http_requests_total[5m]))
  ) > 0.005
  AND ON (job)
  (
    sum(rate(http_requests_total{status=~"5.."}[30m]))
    /
    sum(rate(http_requests_total[30m]))
  ) > 0.0025
```

---

## Pending Items

| Item | Status | Notes |
|------|--------|-------|
| Real metric collection | Pending | No Prometheus/Datadog/Axiom wired |
| Dashboard creation | Pending | No Grafana or equivalent |
| Synthetic SLO measurement | Not started | Need load-test harness |
| Alert notification routing | Pending | No PagerDuty/Slack/OpsGenie |
| Error budget reporting | Pending | No automated budget tracker |
