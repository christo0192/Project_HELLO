# Runbook: LCH-04 Post-Launch Retrospective

Status: **TEMPLATE / FOUNDATION — NOT_STARTED.** This runbook documents the
LCH-04 post-launch retrospective and the repository foundation for it. No
retro session has run: the committed LCH-04 record
(`infra/launch/retro-template.example.json`, schema
`config/phase12-retro.schema.json`) truthfully records `retroStatus:
TEMPLATE`, `published/completed/filed/closed: false`, and
`actionItemsFiled: false` with `count: 0` and an empty `items` array.

## 1. Scope

LCH-04 (PLAN.md section 8) is the post-launch retrospective gate:

> Post-launch: owner team completes a structured retrospective; action items
> are filed with owners.

This repository ships the **template foundation** for that gate only. It does
not hold a retro session, publish a retro record, or file any action item.
Publishing a retro and filing action items requires a completed launch and
LCH-03 hypercare closure, which are owner/external operations outside this
repository.

## 2. Repository validation (offline, deterministic)

The Phase 12 contract validator is the authoritative structural + semantic
check for every LCH category including LCH-04:

```bash
node scripts/check-phase12-launch-status.mjs
node scripts/check-phase12-launch-status.test.mjs
```

The validator enforces the LCH-04 invariants:

| Field | Allowed | Forbidden |
|-------|---------|-----------|
| `retro.retroStatus` | `PENDING`, `TEMPLATE`, `NOT_STARTED` | `PUBLISHED`, `COMPLETED`, `FILED`, `CLOSED` |
| `retro.published` / `completed` / `filed` / `closed` | `false` | `true` |
| `retro.sessionDate` / `facilitator` | `null` | any non-null value |
| `retro.participants` / `retro.findings` | empty array | any element |
| `actionItems.actionItemsFiled` | `false` | `true` |
| `actionItems.count` | `0` | any non-zero integer |
| `actionItems.items` | empty array | any action item |
| `authority.source` | `config/current-state.json` | anything else |
| `evidence.evidenceType` / `evidence.status` | `synthetic_local` / `PENDING` | anything else |

No `EV-*` reference, UUID, ticket ID, or URL can authorize a claim: the LCH-04
schema has no identifier field, unknown keys are rejected, and the
participant/finding/action-item arrays are structurally forced empty.

## 3. Owner-run retro procedure (operator actions, outside this repository)

The following is the procedure the **owner team** would follow when operating
a real retro after launch. It is documented for completeness and is NOT
performed by repository work, CI, or this runbook. It requires a completed
launch (LCH-02) and a closed LCH-03 hypercare window first.

1. **Schedule the session** after hypercare closure; record the session date
   and facilitator outside the repository.
2. **Review launch and hypercare data** — incidents, cadence outcomes, error
   budget position, rollback exercises, and every LCH-01 checklist item.
3. **Capture findings** — what went well, what went wrong, what was slow.
4. **Draft action items** with owners and due dates; each item is actionable
   and traceable.
5. **Publish the retro record and file the action items** — this updates the
   LCH-04 record to `PUBLISHED` with real `actionItems`; that state is
   owner-operated and recorded outside this repository foundation.

## 4. Truth boundary

The committed LCH-04 artifact never claims a held, published, or filed retro:
`retroStatus` is `TEMPLATE`, all four closure booleans are `false`,
`actionItemsFiled` is `false`, `count` is `0`, and `items` is empty. A retro
template is not a retro record, and a foundation is not a closure. No
identifier string changes that.

## 5. Residuals (remain PENDING)

Holding and publishing the post-launch retro, filing real action items with
owners and due dates, and closing LCH-04 require the owner team after a
completed launch and LCH-03 closure, outside the repository. See `PLAN.md`
section 8 and `docs/launch/launch-readiness.md`.

## 6. Related artifacts

| Artifact | Purpose |
|----------|---------|
| `config/phase12-retro.schema.json` | LCH-04 retro template schema |
| `infra/launch/retro-template.example.json` | LCH-04 fillable template example (all-PENDING/TEMPLATE) |
| `scripts/check-phase12-launch-status.mjs` | Phase 12 comprehensive contract validator (all LCH categories) |
| `scripts/check-phase12-launch-status.test.mjs` | Validator self-test (mutations across all LCH categories) |
| `docs/launch/launch-readiness.md` | LCH-01 gate registry foundation |
| `docs/runbooks/launch-hypercare.md` | LCH-03 hypercare synthetic drill runbook |
