# ADR-0016: R1 camera video recording (in-worker A/V to Cloudflare R2)

**Status:** Accepted

**Owner decision date:** 2026-10-06

**Decision owner:** Owner (product/engineering) with Legal approval required before staff Stage A and candidate Stage B

**Plan references:** `docs/design/r1/R1-PLAN-v2.md` §§3.4, 7; `docs/design/r1/R1-PLAN-final.md` §7 and §10.2

## Context

R1 needs candidate camera video for HR review, alongside call audio. Existing
browser recording is audio-first and R1 cannot depend on LiveKit Egress: the
self-hosted single-node SFU does not provide Egress, and Cloud Egress would
couple R1 recording to the phone lane's Cloud configuration.

## Decision

For R1 only, the worker captures candidate camera video and call audio,
encodes A/V in the worker, and streams multipart recording objects to a private
Cloudflare R2 bucket using R1-scoped S3 credentials. The worker is the only
video subscriber. It performs bounded encoding, audio checkpoints, streaming
integrity checks, MP4 validation, crash recovery, and audio-only degradation.

No LiveKit Egress is used or allowed for R1 in either the self-hosted or Cloud
fallback mode. R1 recording objects have a 90-day deletion target with a
97-day lifecycle backstop, subject to Legal approval. Video is HR-review-only;
it is not used for bot vision or avatar behavior.

## Consequences

- R1 video is isolated from `recordings_v2`, `RECORDING_*`, and the phone
  recording path.
- The implementation needs R2 multipart/finalization, retention, DSAR, player,
  encoder, performance, and crash-recovery work before video can be enabled.
- R1 must degrade safely to audio-only when the recorder threatens interview
  quality; Legal and operational controls gate use of candidate video.

## Evidence

- R1 plan final §7 specifies worker capture, format, bounded queueing,
  checkpoints, R2 finalize/retention, review access, and staged acceptance.
- R1 plan v2 §7 confirms no R1 LiveKit Egress in either transport mode.
- R1 plan final §10.2 assigns the R2 API work to PR-8 and recorder/player
  work to PR-9a, PR-9b, PR-10, and PR-V.

## Supersession

For R1 only, this supersedes ADR-0014's audio-only browser interview decision.
It follows ADR-0006's Cloudflare R2 storage direction while replacing neither
ADR-0006 nor the phone recording architecture. It does not authorize LiveKit
Egress for R1.
