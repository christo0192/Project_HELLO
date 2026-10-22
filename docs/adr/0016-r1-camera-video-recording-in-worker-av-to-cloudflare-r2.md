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
it is not used for bot vision or avatar behavior. Recording remains off until
both S0-C (A/V CPU) and S0-D (R2 recording) pass.

## Consequences

- R1 video is isolated from `recordings_v2`, `RECORDING_*`, and the phone
  recording path.
- The implementation needs R2 multipart/finalization, retention, DSAR, player,
  encoder, performance, and crash-recovery work before video can be enabled.
- R1 must degrade safely to audio-only when the recorder threatens interview
  quality; Legal and operational controls gate use of candidate video.

## Approval and evidence

The owner accepted this architecture decision on 2026-10-06. Acceptance does
not authorize recording before evidence: S0-C and S0-D must both pass, and the
applicable Legal gates remain in force. S0 evidence is appended here as it
lands.

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

## Amendment 2026-10-13: how it was built (R1-REC)

Status stays **Accepted**. This amendment records decisions taken while building the feature; it changes one
sentence of the Decision above and adds the owner's 2026-10-12 scope decisions. Nothing here authorizes recording
before the evidence gates below.

### What changes in the Decision

- **No R2 credential in the worker.** The Decision says the worker streams "using R1-scoped S3 credentials". As built,
  the R2 credentials (`R1_RECORDING_S3_*`) exist only on `project-hello-api`, consistent with
  `docs/security/credential-inventory.md`. The worker asks the API for **presigned URLs** (`prepare`, `part-url`,
  `object-url`, `complete` under `/api/internal/r1/recording`, worker bearer secret) and PUTs bytes to them. The API
  creates the multipart upload, derives every object key server-side from the round and session ids, and completes
  or aborts it itself (finalize). Enforced by `scripts/validate-voice-worker-apps.mjs` (the two key names are forbidden
  secrets on both voice apps), by a test that no worker source mentions `R1_RECORDING_S3`, and by the fact that the
  worker's capability flags (`R1_RECORDING`, `R1_VIDEO_RECORDING`, `R1_VIDEO_X264_PRESET`) must be absent from
  `fly.toml` and `fly.phone.toml`.
- **Owner decisions of 2026-10-12** (binding): one PR for recording only; candidate camera video and the audio of both
  sides, recorded inside the R1 worker; stored in the Cloudflare R2 bucket `ik-r1-recordings`; viewable by every staff
  role that can see the candidate (admins and viewers: all candidates; interviewers: their own); retention 90 days.
  Accepted defaults: no R2 jurisdiction with the `apac` location hint, no download button, click-to-seek on the admin
  Review tab, the copy of held objects to a `legal-hold/` prefix deferred, env names `R1_RECORDING_S3_*`.
- **Live-AAC streamed MP4.** Encoding is not deferred to the end of the call. A niced child process of the job writes
  H.264 640x360 at 15 fps and AAC mono 64 kbps into a fragmented MP4 as the interview goes on; 5 MiB parts of that
  growing file and a 2-minute OGG checkpoint go out during the call. The finish is a flush, one last part and one API
  call inside its own 18 s share of the interview's exit budget (a transcode at the end took 64 to 95 s of CPU for a
  22-minute call and cannot fit). A normal exit also uploads a faststart copy `video.mp4` when at least 8 s remain; a
  forced exit or a crash leaves the streamed `stream.mp4` (or its uploaded prefix plus the OGG, layout `split`) as the
  deliverable. The server finalizes both cases with the same code, so a lost worker is salvaged from its uploaded parts.
- **Three independent locks, all default OFF:** the API storage secrets, the worker capability secrets, and
  `r1_settings.recording_mode` (`off`, `audio`, `av`); plus the candidate's live `video_audio_recording` consent on every
  call. With any lock off an R1 interview behaves as before. The one live-lane change is that the worker connects
  audio-only and subscribes the camera itself only in `av` mode.
- **Degradation never reaches the interview.** Event-loop lag, slow VAD inference, dropped pictures, an upload backlog or
  low disk make the worker give up the picture (the audio stays in the same file; layout still `combined`); a dead or
  stalled encoder ends the MP4 and the OGG carries the call (layout `split` or `audio_only`). Neither is ever reversed
  within a session.

### Evidence gates (still open; nothing has been claimed)

| Gate | What must be shown | Status |
|---|---|---|
| **S0-D** (R2 recording) | `app/api/scripts/r1-recording-smoke.ts` prints PASS for every item against the real bucket under `r1/smoke/` (presigned `UploadPart` x3 with a bare PUT, `ListMultipartUploads` naming the open upload by exactly the `UploadId` that `CreateMultipartUpload` returned, part replacement, complete, HEAD, Range GET 206, CORS echo for the web origin and none for another, prefix-complete after a simulated crash, abort and an empty `ListMultipartUploads`, expired URL 403, lifecycle read-back, cleanup), and a recorder-produced MP4 plays and seeks in Chrome and Safari from a presigned URL | **Pending.** Needs the owner's Cloudflare steps (runbook, Recording section). A local S3 emulator was used during development; it is not R2 and is not this evidence. |
| **S0-C** (A/V CPU) | One 20-minute human staff session on a real laptop camera on `performance-4x` (4 vCPU / 8192 MB, since PR #377): event-loop lag max < 250 ms, CPU p95 < 60 %, finish < 18 s, `frames_dropped / frames_encoded` < 2 %, zero VAD slower-than-realtime warnings | **Pending on `performance-4x`. Failed on `performance-2x`** (2026-10-21, see below). Needs the flags on at a zero-live moment (runbook enable steps E3-E5). Synthetic-frame CPU numbers from development are not representative of a face on a camera. |

S0-C and S0-D results are appended here when they exist, with the date and the command or session ids; until then
recording stays off in production.

- **2026-10-21, S0-C FAILED on `performance-2x`** (session `482cb480`, owner mock interview, 22.4 min, `requested_mode=av`):
  the recorder gave the picture up at 240736 ms (`degraded_reason=cpu_loop_lag`), the encoder child was then lost
  (`failure_reason=encoder_crashed`, `frames_encoded=4162`), and finalize stored the recording `layout=audio_only`,
  `has_video=false`. The browser-voice VM moved to `performance-4x` in PR #377 and S0-C is re-run there. A second defect
  lost the roughly four minutes of video that were already on the worker's disk: the `stream.mp4` multipart upload was
  aborted mid-call (most likely by the `r1.sweep` orphan scan) and finalize treated the missing upload as settled. PR #377
  also fixes that (the sweep never aborts a live row's upload; finalize logs `r1_recording_upload_missing`).
