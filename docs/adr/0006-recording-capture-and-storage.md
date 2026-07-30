# ADR-0006: Recording capture and storage

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Owner direction (2026-07-30):** The sole Product/Engineering owner has selected
Cloudflare R2 as the recording storage target, beginning with Supabase Storage
free tier for initial evaluation. ADR-0006 is accepted as architecture. See
[`docs/decisions/fnd-08-owner-approval.md`](../decisions/fnd-08-owner-approval.md).

**Plan references:** D-007, Q-09, REC-01, REC-02, REC-03, MIG-06

## Context

The prototype records mixed browser audio in memory, uploads it to an
unauthenticated API route, stores a signed URL, and uses a long expiry. This is
not an authoritative or resilient recording path and fails the upload, consent,
access, integrity, and retention gates.

## Decision

Cloudflare R2 is the selected recording storage target. Begin with Supabase
Storage free tier for initial evaluation; migrate to R2 when needed. Store an
object key and integrity metadata, never a durable signed URL. This decision
accepts the architectural direction but does not authorize production
implementation. Production go-live additionally requires: authenticated streaming
upload, server-side Egress evaluation (REC-02), consent linkage, integrity
provenance, retention compliance, DPA/region evidence, and Legal approval.

## Consequences

Cloudflare R2 offers S3-compatible API with no egress fees, reducing cost risk.
Starting with Supabase Storage free tier allows zero-cost initial evaluation.
Browser capture remains a secondary path for initial evaluation but is not a
production recording mechanism.

## Evidence

Owner direction recorded in `docs/decisions/fnd-08-owner-approval.md`. ADR-0006
accepted as architecture. Production go-live additionally requires: Egress spike
across supported browsers/networks, audio quality and completeness results,
private-object and expiry tests, integrity/provenance schema, consent linkage,
deletion/restore behavior, DPA and region evidence, cost model, and Legal
approval.

## Supersession

None. Production acceptance is a separate gate.
