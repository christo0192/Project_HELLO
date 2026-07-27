# ADR-0006: Recording capture and storage

**Status:** Proposed

**Decision owner:** Engineering Lead, Product Manager, and Legal Counsel (unassigned)

**Plan references:** D-007, Q-09, REC-01, REC-02, REC-03, MIG-06

## Context

The prototype records mixed browser audio in memory, uploads it to an
unauthenticated API route, stores a signed URL, and uses a long expiry. This is
not an authoritative or resilient recording path and fails the upload, consent,
access, integrity, and retention gates.

## Decision

Treat approved LiveKit server-side Egress as the preferred production capture
candidate, subject to REC-02 quality, region, format, destination, encryption,
provenance, failure, and cost evidence. Select Supabase Storage or an approved
S3-compatible destination only after D-007. Store an object key and integrity
metadata, never a durable signed URL. Keep browser capture only if Q-09 approves
it as a hardened secondary path with authenticated streaming upload and clear
provenance.

## Consequences

Server-side capture improves authority and resilience but adds Egress cost,
provider configuration, callbacks, reconciliation, and failure handling. Removing
browser capture reduces code and privacy surface but may remove a fallback.

## Evidence

Required before acceptance: Egress spike across supported browsers/networks,
audio quality and completeness results, private-object and expiry tests,
integrity/provenance schema, consent linkage, deletion/restore behavior, DPA and
region evidence, cost model, and Legal approval.

## Supersession

None. Update this ADR to Accepted only when D-007 and Q-09 are approved.
