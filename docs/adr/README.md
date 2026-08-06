# Architecture Decision Records

ADRs record decisions that constrain production architecture. `PLAN.md` remains
the roadmap and gate source; an ADR provides the rationale and evidence for one
decision. Proposed ADRs are not authority to deploy their option.

## Status meanings

- **Proposed:** under review; linked decision remains open.
- **Accepted:** approved and currently binding for its stated scope.
- **Rejected:** considered but not selected.
- **Superseded:** replaced by another ADR linked in its supersession section.

## Index

- [ADR-0001: Decision record process](0001-decision-record-process.md)
- [ADR-0002: Current voice and model runtime](0002-current-voice-and-model-runtime.md)
- [ADR-0003: Recruiter authentication provider](0003-recruiter-authentication-provider.md)
- [ADR-0004: Durable post-session job queue](0004-durable-post-session-job-queue.md)
- [ADR-0005: Launch tenancy model](0005-launch-tenancy-model.md)
- [ADR-0006: Recording capture and storage](0006-recording-capture-and-storage.md)
- [ADR-0007: Production deployment and region](0007-production-deployment-and-region.md)
- [ADR-0008: Recruiter authentication transport](0008-recruiter-auth-transport.md)
- [ADR-0009: Governance field protection](0009-governance-field-protection.md)
- [ADR-0010: Managed-hosting topology for the voice-agent pilot](0010-hosting-topology.md)
- [ADR-0011: Recruiter single-factor authentication with server-side allowlist authorization](0011-recruiter-single-factor-allowlist-auth.md)

Create new records from [the template](template.md). Never rewrite an accepted
decision's outcome; supersede it with a new ADR so the history remains legible.
