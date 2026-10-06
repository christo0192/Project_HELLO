# ADR-0015: R1 interview lane (Sales Program Advisor role-play)

**Status:** Accepted

**Owner decision date:** 2026-10-06

**Decision owner:** Owner (product/engineering); Legal approval is required before Stage A (staff) and Stage B (candidates)

**Plan references:** `docs/design/r1/R1-PLAN-v2.md` §§1, 5, 6, 9, 10; `docs/design/r1/R1-PLAN-final.md` §§2, 5, 6, 8, 9, 10

## Context

The existing browser screening implementation is not the R1 Sales Program
Advisor interview. R1 needs a deterministic, browser-only role-play with its
own consent, assessment, operational controls, and isolation from phone
screening. It also needs an extensible seam for future interview types.

The approved R1 conversation model is DeepSeek Flash with thinking disabled.
This is a documented D-004 drift: R1 uses DeepSeek's official API and its
processing may occur in the PRC. That processing and the R1 privacy/legal
position require Legal sign-off before staff Stage A and candidate Stage B.

`PLAN.md`'s AI-GATE states that the system must not auto-reject. R1's
calibrated, auditable decision design conflicts with that general rule only
after its dedicated safeguards are satisfied.

## Decision

The browser lane becomes R1-only for the Sales Program Advisor role-play after
the documented legacy-browser retirement and drain. R1 uses DeepSeek Flash for
conversation. The worker, rather than the model, controls phase progression,
objections, disclosure, and close mechanics.

R1 introduces `roles.interview_kind` as the seam for future interview kinds,
including coding rounds. R1-only records, routes, queues, scoring, and consent
are additive and must not alter phone paths.

For R1 only, this ADR explicitly supersedes the PLAN.md AI-GATE prohibition on
automatic rejection. Auto-status remains disabled through shadow calibration.
It can be enabled only after the calibration criteria in R1 plan final §6.6
are met, the owner makes the audited setting change, and Legal has approved
the Stage B candidate use. A qualifying reject first becomes a cancellable
24-hour pending reject; human actions and overrides remain audited.

## Consequences

- R1 and phone have independent operational and data boundaries, while future
  interview kinds can attach through `interview_kind`.
- Staff testing and candidates are blocked pending their respective Legal
  approvals; accepted architecture is not authorization to launch.
- DeepSeek official API/PRC processing is a privacy, vendor, and transfer
  review item. It is not represented as an in-region or self-hosted D-004
  resolution.
- R1 automatic status is fail-closed: no calibration, Legal approval, or owner
  enablement means no automatic status change.

## Evidence

- R1 plan final §§5–6 defines the deterministic phase design, scoring,
  calibration, pending-reject period, and audit controls.
- R1 plan v2 §§5–6 retains those controls and records DeepSeek Flash as the
  approved conversation LLM.
- R1 plan final §8.1 specifies the `interview_kind` and R1-only data-model
  additions.
- `scripts/check-phase0-2-build-status.mjs` continues to protect the existing
  D-004 wording in `docs/decisions/fnd-08-inputs.md`; this ADR does not change
  that protected decision document.

## Supersession

For R1 only, this supersedes the PLAN.md AI-GATE statement that the system
must not auto-reject. It does not supersede that rule for phone or any other
lane. ADR-0014's audio-first browser readiness decision is superseded for R1
by the camera/video experience specified in ADR-0016; it remains applicable to
non-R1 browser work unless separately superseded.
