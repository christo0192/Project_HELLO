# Self-hosted LiveKit on Fly for R1 rooms

*Feasibility memo, 2026-10-05. This was read-only research: nothing was deployed or edited. Repo: the `r1-scout` worktree (HEAD eec54af). "Verified" means checked against source code or official docs. "Unverified" means the S0 spike has to prove it.*

**Corrections to the brief, applied throughout this memo:**
- **Mumbai is not an option.** Fly no longer offers `bom` for new Machines ([superfly/docs#2506](https://github.com/superfly/docs/pull/2506), merged 2026-09-30; [#2508](https://github.com/superfly/docs/pull/2508), 2026-09-25). The repo's region policy already allows only `sin` (`scripts/fly-region-policy.mjs:29,35-42`). There is no bom-vs-sin choice.
- **"Recording is done in the worker" is not true for the browser lane today.**
  - The repo's in-worker recorder is phone-only (`app/voice-livekit/recording_api.py:38,87-107`).
  - The browser lane records through Cloud Egress when `RECORDING_EGRESS_ENABLED` is on (`app/api/src/lib/room-provisioning.ts:186`, `recording-egress.ts:264-305`). Otherwise it falls back to a candidate-mic-only upload from the browser (`CandidateJoinPage.tsx:412-467`).
  - Recording R1 camera video in the worker is new work.
- **Production has no CSP.** The CSP builder only runs under `vite serve` (`app/web/vite-csp-plugin.ts:83`), and `vercel.json` sends no headers. Switching between Cloud and the self-hosted server does not need a Vercel rebuild.
- **`provisionRoomForCreatedSession` is called only by browser code** (`invites.ts:458`, `routes/livekit.ts:209`). The phone path imports only `requireLiveKitConfigured` (`integrations/livekit-phone-dial/phone-room.ts:40,266`).

---

## 1. Verdict

1. **GO-WITH-CONDITIONS.** Fly can host the R1 server in place of DigitalOcean, but only in `sin`, and only after the S0 spike (§8) passes. No production switch before that.
2. **Shape:** one new single-Machine app, `project-hello-r1-rtc`, in sin.
   - It needs a dedicated IPv4 ($2/mo) and runs livekit-server v1.13.7.
   - Ports: WSS on 443, ICE/UDP on one fixed port (7882), ICE/TCP on 7881.
   - The phone lane stays on LiveKit Cloud with no changes.
3. **Conditions:**
   - The API gets a separate LiveKit endpoint for the browser lane.
   - The reaper fix ships. Without it, every live R1 interview's worker is stopped about 3–4.5 minutes in.
   - We pick an R1 recording plan.
   - We close the race where a dispatch can reach the server before the worker has registered.
   - Deploys are manual and only run when no rooms are live.
4. **Cost:** about $9–14/mo on-demand, against $50/mo for LiveKit Cloud Ship. That saves roughly $40/mo, paid for with about a week of spike work, two PRs, and ongoing ops. If the spike forces an always-on `performance-1x` Machine (~$45/mo), choose Cloud Ship instead.
5. **Biggest single risk:** Fly's UDP path for WebRTC media is unproven for this setup.
   - It depends on LiveKit binding Fly's per-Machine `fly-global-services` address, which is likely but not officially documented.
   - Fly UDP has broken on the platform side before (2024-03, 2025-01), and an unanswered 2026-09-26 report from a self-hosted LiveKit user saw zero UDP packets.
   - If UDP fails, media falls back to ICE/TCP through Fly's proxy, which is worse for 20 minutes of video.

---

## 2. Recommended topology

```
 Candidate in India (home broadband / Jio-Airtel-Vi 4G/5G / corporate LAN)
 Chrome / Safari / mobile, livekit-client 2.21 (Vercel SPA)
   |-- HTTPS -------------------------------> project-hello-api (preflight, exchange -> R1 url + JWT)
   |-- WSS 443   (signaling) ---------------------------------+
   |-- UDP 7882  (ICE/UDP mux, primary media) ----------------+
   |-- TCP 7881  (ICE/TCP fallback) ---------------------------+
                                                               v
 ============================== Fly.io region sin =====================================
 |  project-hello-r1-rtc  (NEW; exactly 1 Machine; performance-1x 2 GB; v1.13.7)       |
 |    dedicated IPv4 (anycast) == rtc.node_ip                                          |
 |    443/tcp  [tls,http] -> :7880   signaling WSS, Twirp RoomService/AgentDispatch,   |
 |                                   agent-worker WS (/agent), health GET /            |
 |    7881/tcp [raw]      -> :7881   ICE/TCP                                           |
 |    7882/udp            -> <fly-global-services>:7882  ICE/UDP mux                   |
 |    [metrics] :6789 (private)      no Redis / Egress / SIP / TURN / webhooks         |
 |          ^                                     ^                                     |
 |          | WSS 443 register (public host,      | HTTPS 443 Twirp:                    |
 |          |   so the proxy can autostart)       |  CreateRoom, CreateDispatch         |
 |          | media: UDP -> node_ip:7882          |  ('browser-screener'),              |
 |          |   (TCP 7881 fallback)               |  ListParticipants (reaper)          |
 |  project-hello-voice                 project-hello-api (R1_LIVEKIT_* secrets,        |
 |  'browser-screener' on-demand pool    BROWSER_LIVEKIT_TARGET flag)                   |
 |  LIVEKIT_* secrets -> R1    <------- Machines API start/stop of the pool (existing)  |
 ======================================================================================

 LiveKit Cloud test-v87uzexo.livekit.cloud: UNCHANGED, phone lane only
   SIP <-> phone-<id> rooms <-> project-hello-phone-voice (Fly sin, Cloud LIVEKIT_* secrets)
   Cloud webhooks -> project-hello-api phone receiver (verifies with the Cloud key)
   API phone runtime keeps the existing env.livekit* triple (= Cloud)
```

- The worker and API already run in sin (`app/voice-livekit/fly.toml:9`, `app/api/fly.toml:10`), so the worker-to-SFU hop stays inside one region. Expected 1–2 ms; not measured.
- India-to-sin latency depends heavily on the route. WonderNetwork's 2026-10-05 data-centre pings: about 32–38 ms from Chennai and Bangalore, 66–95 ms from Hyderabad, Pune and Delhi, and 152 ms from Mumbai. Fly quotes 60–90 ms from Mumbai (#2508). Mobile last-mile latency comes on top of that.

---

## 3. Networking design on Fly

### 3.1 Ports and protocols

| External | Protocol / handler | Internal | Purpose | Status |
|---|---|---|---|---|
| 443 | TCP, `["tls","http"]` | 7880 | Signaling WSS, Twirp API, agent WS, `GET /` health | Standard Fly pattern; the 60 s idle timeout should be covered by LiveKit pings (spike checks) |
| 80 | TCP, `["http"]`, force_https | 7880 | Redirect only | Standard |
| 7881 | TCP, `handlers = []` (raw) | 7881 | ICE/TCP fallback. LiveKit says this "cannot be behind load balancer or TLS" (config-sample) | Unverified on Fly: the proxy rewrites the source IP, which ICE-TCP should tolerate |
| 7882 | UDP | 7882 | ICE/UDP mux (`rtc.udp_port`) | **Critical, unverified** (§3.3) |
| none | `[metrics]` only | 6789 | Prometheus | Private; never listed under `[[services]]` |

### 3.2 Dedicated IPv4

- UDP needs a dedicated IPv4. Fly docs: "You can't use a shared IPv4 address or an IPv6 address for UDP" ([udp-and-tcp](https://docs.fly.io/networking/udp-and-tcp)). It costs $2/mo and is billed while the Machine is stopped ([pricing](https://docs.fly.io/about/pricing)).
- Set `rtc.use_external_ip: false` and `NODE_IP=<dedicated IPv4>`.
  - Fly's outbound IPv4 is NAT'd "and may vary" ([egress-ips](https://docs.fly.io/networking/egress-ips/)), so STUN discovery would advertise the wrong address.
  - With an explicit `node_ip`, LiveKit rewrites every host candidate to that address and skips STUN (mediatransportutil `rtcconfig/config.go:108-112`, `webrtc_config.go:111-116`).
  - `use_external_ip` takes precedence over `node_ip` (config-sample.yaml:80), so it must be false.
- Use a single UDP port, not LiveKit's default range of 50000–60000.
  - Fly does not rewrite UDP ports.
  - UDP port ranges are undocumented. Staff said in 2021–22 that they work (t/1938, t/3742), but an unanswered 2026-09-26 report saw zero packets on a range (t/28711).
  - On `performance-1x` the mux opens only `min(NumCPU, ports)` = 1 socket per IP.
- Run exactly one Machine.
  - Fly staff: UDP is routed "per packet, not per flow" (t/24997, 2025-05). A five-minute UDP blackout was reported with several Machines.
  - LiveKit without Redis is single-node anyway.
  - Deploy with `--ha=false`.

### 3.3 Binding UDP to `fly-global-services` (the make-or-break check)

- **Fly's rule:** the app must receive on, and reply from, the `fly-global-services` (fgs) address. Wildcard binds often reply from the wrong source address (docs; staff on t/369 in 2020 and t/11311 on 2023-03-08).
- **LiveKit's behaviour (verified in code):**
  - In `udp_port` mode it binds one socket per enumerated local interface IP, never 0.0.0.0 (mediatransportutil@f234b534b095 `createmux.go:50-58`, `transport/ip.go:26-91`).
  - So a packet that arrives on fgs is answered from fgs, as long as fgs is one of the enumerated addresses.
- **Evidence that fgs is enumerable:**
  - t/28711 (2026-09-26) shows fgs as a secondary address on eth0.
  - t/28316 (2026-07-20, non-staff, no replies) reports working media with `rtc.ips.includes: [<fgs>/32]`.
  - No official source confirms it. **Treat it as likely, not proven.**
- **Silent failure mode:** if no enumerated IP matches, LiveKit creates zero UDP sockets and logs no error. Sessions then quietly run on TCP only.
- **Two spike configurations:**
  - **Config A (default):** no `rtc.ips` filter, no entrypoint script. Pass if `ss -ulpn` shows `<fgs>:7882` and Chrome picks a UDP pair whose remote is `node_ip:7882`.
  - **Config B (only if A advertises or uses the wrong sockets):** an entrypoint writes `rtc.ips.includes: [<fgs>/32]` at boot. Risk: pion's TCP mux matches connections by local IP, so filtering out eth0 may break ICE/TCP (inference; test forced-TCP with B).

### 3.4 TCP fallback and TURN/TLS on 443 (the main gap compared with Cloud)

- **ICE/TCP 7881** gets past networks that block UDP but allow arbitrary TCP. It does not help on networks that allow only TCP 443 or that inspect TLS.
- **Embedded LiveKit TURN does not fit on Fly:**
  - v1.13.7 always advertises TURN/TLS as `turns:<domain>:443` (`pkg/service/roommanager.go:1068-1069`). That clashes with signaling on 443, because Fly maps one external port to one internal port and has no SNI routing (inferred from [services](https://docs.fly.io/networking/services/)).
  - The relay leg goes back to `node_ip` on a relay port range (`turn.go:112-130`). That needs both a hairpin and UDP port ranges, which are unproven on Fly. Nobody has published a working TURN relay on Fly in 2026.
- **Decision:**
  - **v1 ships with `turn.enabled: false`.** The S0 corporate cell measures the gap.
  - If that cell fails, add **external TURN (T3)** through `rtc.turn_servers`, which accepts any host and port.
  - Pick a provider that supports static or HMAC (`secret`/`ttl`) credentials, so no client change is needed. Otherwise the API has to mint credentials per join and pass them to `room.connect` as `rtcConfig.iceServers`, which is a client change; how livekit-client merges those is unverified.
  - Cloudflare Realtime TURN offers TLS on 443 at $0.05/GB ([docs](https://developers.cloudflare.com/realtime/turn/)). Its credential model is unverified.
  - A TLS front app or in-Machine SNI demux in front of embedded TURN (T1/T2) is not recommended: the relay leg has the same UDP problem.
- **Optional spike variant S0.6:** run the ICE mux on **UDP 443** (`udp_port: 443`) to get through firewalls that allow QUIC. Whether UDP 443 and TCP 443 can coexist on one Fly app is unverified.

### 3.5 Domain and certificates

- **Spike:** `project-hello-r1-rtc.fly.dev`, which uses a Fly-managed certificate and needs no DNS work.
- **Production:**
  - A hostname on an IK-controlled domain, e.g. `rtc-r1.<ik-domain>`.
  - Add the certificate with `fly certs add`, and point an A record at the dedicated IPv4.
  - Fly terminates TLS at the edge, so LiveKit sees plaintext on 7880.
  - The first 10 single-hostname certificates are free, then $0.10/mo each (pricing).
  - Some corporate filters may block `*.fly.dev`. This is a hypothesis; S0 tests it.

### 3.6 Worker-to-SFU path

- The worker connects to the **public** hostname, not `.internal`. Private 6PN traffic bypasses Fly's proxy and would not autostart a stopped SFU.
- Media from the worker goes UDP to `node_ip:7882` through Fly's edge (a hairpin; unverified), with TCP 7881 as fallback. S0 measures this.
- Same-region traffic to a public IP is billed as egress; the amount is small.

### 3.7 Reference `fly.toml` (sketch; validate in S0, not deployable as written)

```toml
# SKETCH: infra/livekit-r1/fly.toml. Validate every line in the S0 spike.
app = "project-hello-r1-rtc"
primary_region = "sin"          # bom not offered for new Machines (superfly/docs#2506)
kill_signal = "SIGINT"          # LiveKit drains on the first signal (cmd/server/main.go:308-317)
kill_timeout = 300              # Fly maximum; a deploy still cuts a live room -> zero-rooms guard

[build]
  dockerfile = "Dockerfile"     # FROM livekit/livekit-server:v1.13.7@sha256:<pin-digest>
                                # COPY livekit.yaml /etc/livekit.yaml ; CMD ["--config","/etc/livekit.yaml"]

[env]
  NODE_IP = "<dedicated IPv4 from `fly ips allocate-v4`>"   # not a secret
  # LIVEKIT_KEYS is a Fly secret ("<key>: <secret of 32+ chars>"), never here

[[vm]]
  cpu_kind = "performance"      # shared CPU throttles; see app/voice-livekit/fly.toml:54-62
  cpus = 1
  memory_mb = 2048

[metrics]
  port = 6789
  path = "/metrics"

# 1) Signaling WSS + Twirp + agent WS. The only proxy-handled service, so it does autostart/stop.
[[services]]
  protocol = "tcp"
  internal_port = 7880
  auto_start_machines = true
  auto_stop_machines = "stop"   # posture A (on-demand). Use "off" + min_machines_running = 1 for B/C
  min_machines_running = 0
  [services.concurrency]
    type = "connections"        # live rooms hold WSS -> load > 0 (S0 verifies)
    soft_limit = 100
    hard_limit = 250
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true
  [[services.http_checks]]
    method = "get"
    path = "/"                  # 200 OK, or 406 if node stats are >4 s stale (server.go:407-424)
    interval = "15s"
    timeout = "2s"
    grace_period = "10s"

# 2) ICE/TCP: raw passthrough, no TLS
[[services]]
  protocol = "tcp"
  internal_port = 7881
  [[services.ports]]
    port = 7881
    handlers = []

# 3) ICE/UDP mux: single port, internal == external, dedicated IPv4 only
[[services]]
  protocol = "udp"
  internal_port = 7882
  [[services.ports]]
    port = 7882
# S0 must confirm: autostop decisions ignore services 2/3, and UDP is live right after a stop->start.
```

### 3.8 Reference `livekit.yaml` (sketch; contains no secrets)

```yaml
# SKETCH: infra/livekit-r1/livekit.yaml. Validate in S0.
port: 7880
logging: { level: info, json: true }      # client IPs are personal data; do not use debug
rtc:
  udp_port: 7882          # must equal the Fly UDP port; no port range
  tcp_port: 7881
  use_external_ip: false  # node_ip comes from the NODE_IP env var (the dedicated IPv4)
  allow_tcp_fallback: true
  # ips: { includes: ["#FGS#/32"] }   # Config B only, rendered by the entrypoint
  # turn_servers:                     # T3 only, if the S0 corporate cell fails
  #   - { host: <turn-host>, port: 443, protocol: tls, username: ..., credential: ... }
room:
  auto_create: false      # rooms only via the API's CreateRoom (room-provisioning.ts:171, invites.ts:305-313)
  # Per-room limits are already set at CreateRoom (room-provisioning.ts:46-48, 171-176)
turn: { enabled: false }  # embedded TURN is not viable on Fly (§3.4)
prometheus: { port: 6789 }
# keys:    LIVEKIT_KEYS Fly secret (main.go:61-63); secrets of 32+ chars
# redis:   none. Single node, so Egress, Ingress and SIP are unavailable by design
# webhook: none. No browser consumer; the phone receiver would reject the R1 key
```

Config B entrypoint (only if needed):

```sh
#!/bin/sh
# SKETCH: Config B only
set -eu
FGS=$(awk '/fly-global-services/ {print $1; exit}' /etc/hosts)
[ -n "$FGS" ] || { echo "fly-global-services missing from /etc/hosts" >&2; exit 1; }
sed "s|#FGS#|$FGS|" /etc/livekit.tmpl.yaml > /tmp/livekit.yaml
exec /livekit-server --config /tmp/livekit.yaml
```

---

## 4. Repo changes

### 4.1 The per-lane endpoint seam (PR-1; defaults to Cloud, so merging changes nothing)

- **`app/api/src/lib/env.ts`**, next to `:133-135`:
  - Add `r1LivekitUrl/ApiKey/ApiSecret`, read from the Fly secrets `R1_LIVEKIT_URL`, `R1_LIVEKIT_API_KEY`, `R1_LIVEKIT_API_SECRET`.
  - Add `browserLivekitTarget`, read from `BROWSER_LIVEKIT_TARGET`. Only the exact string `'r1'` selects R1; anything else means Cloud, matching the fail-safe style of `RECORDING_PROVIDER` at `:151-152`.
  - The existing `livekit*` triple keeps meaning **Cloud**.
- **New file `app/api/src/lib/livekit-endpoints.ts`:**
  - It must have no side effects at import time, because the phone import-closure test loads `room-provisioning.ts`.
  - Exports: `cloudLiveKitEndpoint()`, `browserLiveKitEndpoint()` returning `{target,url,apiKey,apiSecret}`, and `requireBrowserLiveKitConfigured()`.
  - It **fails closed** when the target is `r1` but credentials are incomplete. It must never silently fall back to Cloud, which would create rooms with no agent.
- **Config contract:**
  - Add the new names to `config/environment.schema.json` (secret flags) and `app/api/.env.example` (`:41-44`). `scripts/check-env-contract.mjs` requires literal `process.env.X` reads.
  - Set `BROWSER_LIVEKIT_TARGET` in `app/api/fly.toml [env]`, next to `BROWSER_AGENT_NAME` (`:137`).
  - Do not add these to `scripts/fly-api-secrets.sh`, which makes every listed secret mandatory.

### 4.2 Call sites (six files, browser lane only)

| # | File:line | Change |
|---|---|---|
| 1 | `lib/room-provisioning.ts:124-130` `roomClient()`; `:161` check | Use the browser endpoint and `requireBrowserLiveKitConfigured()`. Callers are browser-only (`invites.ts:458`, `routes/livekit.ts:209`) |
| 2 | `lib/room-provisioning.ts:186` → `recording-egress.ts:264-305` | **R1 skip-egress policy.** For R1 rooms, return a no-egress result without calling LiveKit. Today, `ENABLED=true` would call Cloud egress for a room Cloud cannot see, and `ENABLED=false` with `REQUIRED=true` throws (`:38-43`). Either way the exchange returns 503 (`invites.ts:462-468`) |
| 3 | `routes/invites.ts:136, 272, 353` | Switch the config checks to `requireBrowserLiveKitConfigured()` |
| 4 | `routes/invites.ts:305-339` (preflight) | Room client, token and returned `url` all from the browser endpoint |
| 5 | `routes/invites.ts:581` (`url`), `:637-656` `buildCandidateToken` | Browser endpoint. Add `canPublishSources: [MICROPHONE, CAMERA]`; there is no restriction today (`:647-653`) |
| 6 | `routes/livekit.ts:142, 209, 250` (recruiter /start) | Browser check and browser `url` |
| 7 | `lib/browser-orchestration.ts:129-140` `AgentDispatchClient` | Browser endpoint. The OSS server has AgentDispatch (`pkg/service/agent_dispatch_service.go`, since v1.7.2) |
| 8 | **`lib/browser-orchestration.ts:187` + `lib/worker-orchestration.ts:984-1066`** | **CRITICAL.** Add an optional `livekit?: {url,apiKey,apiSecret}` override to `createDefaultWorkerOrchestrationService` (default Cloud, used at `:1058-1061`). Pass the browser endpoint only from `:187`. Without it, Cloud answers not_found or an empty list for `screening-*` rooms, the reaper reads that as dead (`:813-847`), and with grace = 180 s (`env.ts:295`), the reaper running every 90 s, and no heartbeats on the browser path, the worker is stopped about 180–270 s after its readiness ping |
| 9 | `lib/recording-egress.ts:34-36` `egressClient()` | **Leave on Cloud.** Older Cloud sessions still finalize there. New R1 sessions carry no egress id, so they take `fallback_required` (`:1132-1137`) with no LiveKit call |

**Web:**
- No endpoint code change. `room.connect(access.url, …)` (`CandidateJoinPage.tsx:562`) and preflight (`AudioReadinessStep.tsx:157`) use whatever URL the API returns.
- Set Vercel `VITE_LIVEKIT_URL` to the R1 origin for dev/preview CSP hygiene.
- R1 feature work outside this seam:
  - Camera capture and publishing.
  - Replace the "No camera is needed" copy (`:626`).
  - Preflight grants only `MICROPHONE` (`invites.ts:324`, pinned by `candidate-preflight-contract.test.ts:18`).
  - Publish 640x360@15 with `simulcast: false`, since the agent is the only subscriber. Unverified; the spike measures it.

### 4.3 The Cloud fallback flag

- `BROWSER_LIVEKIT_TARGET=cloud` sends the browser lane back to Cloud. It **must move together with** `project-hello-voice`'s `LIVEKIT_*` secrets, because one worker process registers with exactly one server.
- **Mismatches fail silently:**
  - OSS `CreateDispatch` succeeds even with no worker registered (`pkg/rtc/room.go:884-903`; `pkg/agent/client.go` only logs).
  - Browser readiness is posted at prewarm, *before* the worker's WebSocket registration (livekit-agents 1.6.4 `worker.py:784,831-833`).
- **Required hardening (W1, see §5):** the worker posts readiness *after* LiveKit registration and includes `livekit_host`. The API refuses readiness on a host mismatch, using the same pattern as `agent_name` at `routes/voice-worker.ts:78`.
- **Switching procedure:** drain first (no browser sessions `waiting` or `in_progress`), then switch the worker secrets and the API flag. Stamping `call_sessions.livekit_target` per session would need a migration; it is optional hardening, not v1.

### 4.4 Phone untouched: what proves it

- **Do not edit:**
  - `lib/phone-runtime/runtime.ts:765-769,783`, `lib/phone-runtime/livekit-clients.ts:52`
  - `integrations/livekit-phone/*`, `integrations/livekit-phone-dial/*`
  - `lib/phone-canary1/*`, `routes/phone*.ts`
  - `worker-orchestration-runtime.ts:130` (phone service built with no override, so Cloud)
  - `recording-egress.ts:34-36`
  - `app/voice-livekit/fly.phone.toml` and the phone app's secrets
- **Existing suites that must stay green unchanged:**
  - `phone-runtime-livekit-clients`, `phone-room`, `phone-dial-controller*`, `phone-webhook-*`
  - `phone-canary1-*` (including import-closure), `recording-egress`
  - `worker-orchestration-runtime-per-app.test.ts:134,174`
  - `invites-exchange-browser-gate.test.ts:133` (OFF path byte-identical)
- **New tests:**
  1. Structural: no file under `integrations/livekit-phone*`, `lib/phone-runtime`, `lib/phone-canary1` or `routes/phone*` imports `livekit-endpoints` or mentions `R1_LIVEKIT`/`r1Livekit`.
  2. With the R1 env set, the phone runtime credentials and `loadLiveKitPhoneConfig` (`livekit-phone/config.ts:72-84`) still resolve to Cloud.
  3. Exchange and preflight return the R1 URL; the JWT verifies with the R1 secret and fails with the Cloud secret. With the flag set to `cloud`, responses match today's exactly.
  4. R1 provisioning never calls egress and uses R1 credentials.
  5. The browser reaper checks R1 and spares a live R1 room; the phone reaper still checks Cloud and still stops on not_found.
  6. A webhook signed with the R1 key is rejected by the phone receiver (`verify.ts:175`).

### 4.5 Infra (PR-2)

- **`infra/livekit-r1/`:** `fly.toml`, `livekit.yaml`, a Dockerfile pinned by digest, and optionally the entrypoint.
- **Validation:**
  - `scripts/validate-voice-worker-apps.mjs` bans `[[services]]` (`:306-309`), so the SFU config needs its own validator.
  - Add a small `validate-livekit-r1-app.mjs` that reuses `fly-region-policy.mjs`. It checks: no secrets in `[env]`, a UDP service declared, a single Machine, and autostop settings.
  - Also add the SFU config to the region scope (`:416-437`).
  - Wire the validator into `.github/workflows/quality.yml`.
- **Deploy:**
  - Add a **separate manual-only** `deploy-livekit-r1.yml` with its own `FLY_API_TOKEN_LIVEKIT_R1`, a pre-check that no rooms are live, and a post-deploy health probe.
  - Do not add the SFU to `deploy-fly.yml` (options pinned at `deploy-fly-workflow.test.mjs:270`). An automatic deploy on merge would restart the SFU in the middle of an interview.
- **Coupling:** browser-worker deploys check for a "registered worker" log line (`scripts/deploy-voice-orchestration.sh:97-107`). Once the worker points at R1, that needs the SFU reachable; proxy autostart covers it.

---

## 5. Cloud-only features to replace or avoid, and worker changes

| Cloud feature | Used by browser lane today? | When self-hosted | Action |
|---|---|---|---|
| Managed TURN/TLS on 443 and the global edge | Implicitly yes. Cloud provides TURN (per LiveKit docs; not re-verified here) | **Lost** | ICE/TCP 7881 plus external TURN (T3) if the S0 corporate cell fails (§3.4) |
| Agent Observability upload (`session.start(record=…)`, `agent.py:12230`) | Yes | Stops **silently**. Upload only happens if the host is `*.livekit.cloud`/`.run` or `LIVEKIT_OBSERVABILITY_URL` is set (agents 1.6.4 `job.py:51-59,297-309`). RecorderIO still writes a temp `audio.ogg` (`agent_session.py:797-807`) | Set `record=False`, or accept the loss. Replace with our own logs, Prometheus, and client telemetry |
| Cloud dashboard, session viewer, quality analytics | Probably yes (owner to confirm) | Gone | Prometheus via Fly `[metrics]`, client `getStats` telemetry, Mission Control lane tag (§6) |
| Managed Egress | Yes, if `RECORDING_EGRESS_ENABLED=true` (production value never read; `docs/runbooks/recording-finalize-convergence.md:250-253`) | Unavailable: "egress not connected (redis required)" (`pkg/service/errors.go:23`) | R1 skip-egress policy (§4.2 #2), plus a new in-worker R1 recorder |
| Explicit agent dispatch | Yes | Present in OSS since v1.7.2. **But** a dispatch with no registered worker is logged and dropped (`pkg/agent/client.go`) | W1 below |
| Enhanced noise cancellation (BVC/Krisp) | No (`requirements.txt`; browser uses `noiseSuppression: true`, `CandidateJoinPage.tsx:81`) | Cloud-only ([docs](https://docs.livekit.io/transport/media/enhanced-noise-cancellation/)) | None |
| LiveKit Inference (STT/LLM/TTS gateway) | No (Sarvam and Gemini, `agent.py:3399-3538`) | Would fail auth | None |
| Cloud turn detector v1 and adaptive interruption | No. In `start` mode it uses local `v1-mini`; adaptive interruption is off unless hosted or in dev mode (`eot/detector.py:47-55`, `agent_activity.py:4041-4048`; `Dockerfile:108`) | None | **Never run `dev` or `console` against R1** |
| Webhooks | No (phone receiver only, `app.ts:270-279`) | None | Configure no webhook on R1 |
| Telephony/SIP, Cloud Agents hosting | Phone lane / not used | Not needed | Phone stays on Cloud |
| HA, multi-node, managed upgrades | Implicit | Single node; we run upgrades | §6 runbook |

**Worker changes (`app/voice-livekit`):**
- **Required, config only:** at cutover, set `LIVEKIT_URL/API_KEY/API_SECRET` on `project-hello-voice` with `fly secrets set --stage`. These are secrets by policy (`scripts/validate-voice-worker-apps.mjs:312-324`). `_delete_livekit_room` (`agent.py:1178-1189`) follows the same environment.
- **Required, code (W1):**
  - Post the browser readiness ping only after the worker has registered with LiveKit, and include `livekit_host`.
  - Today readiness comes from prewarm, which is earlier (`agent.py:1877-1899`; the comment at `:1882` saying "after registering with LiveKit" is wrong).
  - Fallback if moving the ping proves awkward: the API polls `listParticipants` after dispatch and re-dispatches once.
  - This closes both the cold-start race and the API/worker mismatch case. It needs explicit approval to touch the frozen browser path.
- **Recommended:** `record=False` at `agent.py:12230`. Nothing is uploaded when self-hosted anyway, and it avoids encoding a throwaway OGG on a worker that has a CPU-starvation history.
- **R1 feature (new):**
  - In-worker recording of candidate camera and mic plus agent audio, with a session-keyed presign/complete route and a finalize branch. The existing recorder is phone-only and keyed by `attempt_id`.
  - Prefer muxing the incoming VP8/Opus to WebM without re-encoding, to protect worker CPU. This is unverified; measure it.

---

## 6. Ops and security

- **TLS:**
  - Fly's `tls` handler terminates TLS at the edge with a managed, auto-renewed certificate.
  - Plaintext runs only inside the VM on 7880. ICE/TCP and UDP media are DTLS-SRTP encrypted end to end between the browser and the SFU.
  - The SFU sees decrypted media in memory; there is no E2EE.
- **Keys:**
  - Generate with `livekit-server generate-keys`. Secrets must be 32+ characters (shorter ones only log an error, `config.go:805-810`).
  - Store as the `LIVEKIT_KEYS` Fly secret on the SFU and as `R1_LIVEKIT_*` on the API. Never reuse the Cloud key.
  - Rotate with two keys, with no rooms live: add key2, roll the API and worker to key2, remove key1. Every `fly secrets set` restarts Machines.
- **Tokens:**
  - The 5-minute candidate TTL and 2-minute preflight TTL are fine. The server refreshes tokens for connected clients ([tokens-grants](https://docs.livekit.io/frontends/reference/tokens-grants/)).
  - Add `canPublishSources` (§4.2 #5).
  - `room.auto_create: false` closes the path where a token could create an unprovisioned room.
- **Webhooks:** none. If ever added, use a separate `WebhookReceiver` with the R1 key, never the phone route.
- **Monitoring:**
  - Fly HTTP check on `GET /` (200, or 406 if stale).
  - Prometheus via `[metrics]`; alert on `fly_instance_cpu_throttle > 0`.
  - The candidate page posts `getStats` summaries to the API: selected pair type (udp/tcp/relay), RTT, jitter, loss, freezes.
  - Add `lane=r1_selfhosted` to the funnel and Mission Control (#278).
  - Synthetic join every 30–60 min in IST business hours. It wakes the SFU; cost is cents.
- **Upgrades:**
  - Pin `livekit/livekit-server:v1.13.7` by digest. There were seven 1.13.x releases between 2026-06-08 and 2026-09-14.
  - Upgrade monthly or on security advisories, only through the manual workflow with the no-live-rooms guard.
  - Pin `livekit-client` exactly for R1 (currently `^2.20.0`, `app/web/package.json:25`).
  - Fly may migrate Machines with no documented advance notice ([machine-migration](https://docs.fly.io/reference/machine-migration)). All room state is in memory, so a migration ends live sessions; the retake/infra-abandon path must cover it.
- **Who starts the SFU, and cold-start impact:**
  - **Recommended: Fly Proxy autostart/autostop on the 443 service.** Do not start it from the API through the Machines API: the SFU is a singleton, not a pool, and the API's Fly token is an org token (`fly-machines.ts:36-43`), so giving it the SFU widens the blast radius.
  - The first proxied request wakes it: the API's preflight `CreateRoom` (`invites.ts:305-313`), which runs at the candidate's audio-check step before exchange, then provisioning (`room-provisioning.ts:171`) and the worker's WSS registration.
  - Fly starts a stopped Machine in "well under a second" ([machines overview](https://docs.fly.io/machines/overview/)), plus an estimated 1–3 s for LiveKit to boot (no STUN with an explicit `node_ip`). The candidate sees this once, as extra preflight latency, well inside the existing 15–25 s+ worker cold-boot budget (`env.ts:311-315`).
  - UDP packets do not wake a Machine (community answer, t/18145, 2024-02-08, non-staff). Live rooms always hold WSS connections, which keep proxy load above zero.
  - Anything that calls the SFU wakes it: the reaper's `ListParticipants` and the synthetic check both do.
  - **Unverified:** whether UDP routing is live immediately after stop→start, and whether sin has capacity at start time. S0.3 tests both. If either fails, switch to always-on (posture B or C, §7).
- **Runbook (sketch):**
  1. **Candidate can't join:**
     - Check `curl https://<sfu>/`, `fly status -a project-hello-r1-rtc`, `fly logs`, and the client's selected-pair telemetry.
     - If no rooms are live, run `fly machine restart`.
     - If it persists for more than 10 minutes, switch R1 back to Cloud (rollback below).
  2. **Choppy media:** check CPU throttle, LiveKit loss/NACK metrics, and candidate RTT. Change VM size only when idle.
  3. **Dropped mid-interview:** check Fly events for a migration or restart, mark the session infra-abandoned, and re-issue the invite.
  4. **Key leak:** two-key rotation.
  5. **Certificate error:** `fly certs show`, then check DNS.
  6. **Flood:** contact Fly support, switch to Cloud, and if needed reallocate the IPv4 and update `NODE_IP` and DNS. Fly offers only network-level DDoS protection (t/2513, t/18130).
  7. **Before every deploy or secret change:** confirm no rooms are live.
- **Rollback:**
  - **SFU version:** `fly deploy --image <previous digest>`. No state to restore.
  - **Back to Cloud:**
    1. Drain browser sessions.
    2. `fly secrets set --stage` Cloud `LIVEKIT_*` on `project-hello-voice`, then apply. Unverified that staged secrets reach stopped pool Machines; check by starting one.
    3. Set `BROWSER_LIVEKIT_TARGET=cloud` in `app/api/fly.toml` and deploy the API.
    4. Target under 15 minutes, rehearsed in S0.
    5. Cloud brings back the ~4/weekday cap unless you upgrade to Ship.

---

## 7. Cost per month (fewer than 10 R1 sessions/day; prices fetched 2026-10-05)

Assumptions:
- 220 sessions/mo (10/day × 22 weekdays), each 20 min plus warm-up and drain.
- SFU egress about 0.1 GB per session: camera video to the worker plus audio both ways.
- Fly sin multiplier 1.269; egress billed "at the rate for the region it leaves" ([pricing](https://docs.fly.io/about/pricing)).

| Option | Compute | IPv4 | Egress | **Total/mo** |
|---|---|---|---|---|
| **A. sin, on-demand performance-1x 2 GB** (recommended if S0.3 passes) | 110–180 h × $0.058/h ≈ $6.5–10.5 | $2 | about 22 GB × $0.04 ≈ $0.9 | **≈ $9–14** |
| B. sin, always-on shared-cpu-2x 2 GB (only if throttle-free at 3 concurrent) | $13.39 × 1.269 ≈ $17.0 | $2 | ≈ $0.9 | **≈ $20** |
| C. sin, always-on performance-1x 2 GB | $33.00 × 1.269 ≈ $41.9 | $2 | ≈ $0.9 | **≈ $45** (prefer Cloud Ship at this point) |
| bom | Not offered for new Machines | | (India egress would be $0.12/GB) | **N/A** |
| Optional T3 external TURN | Only relayed sessions, e.g. under $1 at $0.05/GB | | | +$0–1 |
| Stopped rootfs, certificates | $0.15/GB-month; first 10 certificates free | | | cents |
| **LiveKit Cloud Build** (today) | $0, 5,000 WebRTC min/mo, agents count, no overage listed ([livekit.com/pricing](https://livekit.com/pricing)) | | | $0, but **~4 R1/weekday shared with phone** |
| **LiveKit Cloud Ship** (reference) | $50/mo, 150,000 WebRTC min then $0.0005/min, 250 GB | | | **$50**. R1 needs about 9,500 min/mo (~43 participant-min/session × 220), so phone plus R1 fit with large headroom |

The cash saving of A over Ship is about $36–41/mo. Engineering cost: about 5 days of spike, 2 PRs, the W1 worker change, the R1 recorder (needed either way), and about 2–4 h/month of ops. A only makes sense if the $50/mo is a hard budget constraint or volume is expected to grow well beyond Ship's included minutes.

---

## 8. S0 go/no-go spike

**Environment:**
- New app `project-hello-r1-rtc-spike` in sin with a dedicated IPv4, v1.13.7 pinned, using the sketches in §3 on `*.fly.dev`. Owner runs `fly apps create`, `fly ips allocate-v4` and `fly deploy --ha=false`.
- A temporary minimal echo agent (livekit-agents 1.6.4, `start` mode) in sin, named `browser-screener` on the spike server. This avoids touching production `project-hello-voice`.
- A test page of about 100 lines on a Vercel preview (HTTPS for iOS). It runs livekit-client 2.21, joins with URL plus token, publishes mic and camera at 640x360@15 with simulcast off, and posts `getStats` every 5 s.
- Tokens minted with `lk` CLI.
- A/B: the same page against Cloud (`test-v87uzexo`), using about 600 free minutes.

**Steps (five working days; day 1 can end the spike):**

| Step | What | Pass |
|---|---|---|
| S0.1 Platform probe (day 1, kill switch) | `fly ssh console -C "sh -c 'ip -4 addr; grep fly-global-services /etc/hosts; ss -ulpn'"` | `<fgs>:7882` is bound (Config A, else Config B). If it isn't, **NO-GO immediately** |
| S0.2 Smoke | `lk room join --publish-demo` plus the test page from a laptop; check `chrome://webrtc-internals` | Selected pair is UDP to `node_ip:7882`; forced-TCP join works via 7881 |
| S0.3 Lifecycle | 20 stop→start cycles via proxy wake; join immediately after each | UDP works on the first join 20/20; added wake latency p95 ≤ 5 s. If not, posture B/C, not NO-GO |
| S0.4 Agent path | Dispatch the echo agent: 20 cold (worker started at the same moment as dispatch) and 20 warm | Agent joins 40/40. Worker-to-SFU pair type recorded; RTT p95 < 5 ms. Any cold miss confirms W1 is required |
| S0.5 Field matrix (days 2–4) | See matrix below | Thresholds below |
| S0.6 Optional | UDP 443 variant; corporate filter on `*.fly.dev` vs custom domain; T3 external TURN with `iceTransportPolicy: relay` | Informs the TURN decision |
| S0.7 Soak and drills (day 5) | 5 × 25-min sessions; 3 concurrent × 25 min; switch to Cloud and back; deploy guard with a live room; key rotation dry run | Thresholds below |

**Matrix** (≥ 15 joins per cell; ≥ 150 total; spread across Bangalore/Chennai, Mumbai/Pune and Delhi/Hyderabad):

| Network | Clients |
|---|---|
| Home broadband (Jio Fiber, Airtel Xstream, ACT) | Chrome on Windows/macOS, Safari on macOS |
| 4G/5G (Jio, Airtel, Vi) | Chrome on Android, Safari on iOS |
| Corporate or strict lab firewall (TCP 443 only, plus a TLS-inspecting proxy if one is available) | Chrome desktop, forced relay run |
| Same networks against Cloud | A/B baseline |

**Metrics and pass thresholds:**
- **Join success** (token in hand → media flowing both ways and agent audio subscribed within 10 s, no retry):
  - ≥ 98% overall on home and mobile cells, with no cell below 93%. Root-cause every failure.
  - Corporate cell: 100% via ICE/TCP or T3, or T3 becomes a launch prerequisite.
- **Path:** UDP selected on ≥ 90% of home and mobile joins.
- **RTT** (candidate-pair `currentRoundTripTime`): p95 ≤ 200 ms, and no more than 30 ms worse than Cloud on the same network and time.
- **Loss:** session mean ≤ 2%; ≤ 5% in 95% of 30-s windows.
- **Jitter:** p95 ≤ 30 ms.
- **Audio quality (MOS-like):**
  - `concealedSamples / totalSamplesReceived` ≤ 2% on agent audio.
  - Blind A/B rating by 3 listeners ≥ 4/5 and no more than 0.5 below Cloud.
  - Agent STT transcripts not noticeably worse than Cloud.
- **Video:**
  - `framesPerSecond` ≥ 12 in ≥ 95% of samples at 640x360.
  - No freeze over 2 s; `qualityLimitationReason = bandwidth` < 10% of the time; PLI < 1/min.
- **Reconnect:**
  - Wi-Fi⇄4G handover and 5 s / 20 s airplane mode resume without a page reload in ≥ 9/10 attempts.
  - A drop of more than 60 s ends cleanly.
  - An SFU restart is detected and the retake path works.
- **Long sessions:** zero media gaps over 2 s across 5 × 25 min. This catches the reported 5-minute UDP blackout.
- **Capacity:** 3 concurrent sessions with `fly_instance_cpu_throttle = 0` (test shared-cpu-2x too if posture B is wanted).
- **Ops drills:** switch to Cloud and back in < 15 min; deploy guard blocks while a room is live.

**After S0 passes:** merge PR-1 (flag still `cloud`), W1 and PR-2. Then S1: an off-hours rehearsal on the real stack with drain, switch to R1, and 5 owner R1 interviews from India networks. At least one must run longer than 270 s to prove the reaper leaves it alone. Then switch back or go live.

**On fail:**
- Launch R1 on LiveKit Cloud now with the ~4/weekday cap, or upgrade to Ship at $50/mo if demand exceeds it.
- Keep the PR-1 seam (inert at `cloud`).
- Destroy the spike app and **release the IPv4** to stop the $2/mo charge.
- Record which threshold failed.

---

## 9. Open risks and unknowns

1. **Fly UDP for WebRTC.** fgs enumerability and binding are not officially documented; Fly UDP has had platform regressions (2024-03-27, 2025-01-14, the latter needing a redeploy); t/28711 (2026-09-26) is unresolved; the 5-minute UDP timeout was reported with several Machines. Mitigation: S0.1/S0.7, a single Machine, and switching back to Cloud.
2. **No TURN/TLS on 443** behind strict corporate firewalls. Embedded TURN is not viable on Fly; external TURN's credential model and client integration are unverified.
3. **Dispatch-before-registration race** on OSS (readiness posted at prewarm; dispatch dropped when no worker is registered). W1 is required; S0.4 measures it.
4. **Reaper** stops live R1 workers unless §4.2 #8 ships first. High confidence.
5. **Recording premise.** No in-worker browser recorder exists; the production `RECORDING_EGRESS_ENABLED/REQUIRED` values are unknown. Read them (`fly ssh console -a project-hello-api -C 'printenv RECORDING_EGRESS_ENABLED RECORDING_EGRESS_REQUIRED'`) before PR-1 is designed. Video recording adds worker CPU on a fleet with a starvation history.
6. **UDP readiness after stop→start, and sin capacity at start** (unverified). Fallback is always-on, which erodes the cost case (posture C ≈ Cloud Ship).
7. **Single node.** Deploys, secret changes and Fly host migrations end live rooms. `kill_timeout` maximum is 300 s; there is no advance notice of migrations.
8. **India-to-sin RTT** varies by route (about 32 ms Chennai to 152 ms Mumbai, data-centre to data-centre). How Cloud's nearest edge for India compares is unverified; S0 A/B decides.
9. **Worker-to-SFU media path:** UDP hairpin to our own anycast IPv4 is unverified; ICE/TCP is the fallback.
10. **Proxy behaviour:** 60 s TCP idle timeout (t/2373, 2021), the TCP/TLS handler with long-lived WSS, and whether autostop counts connections across the three services. All need checking in S0.
11. **MTU:** about 1300 bytes usable on Fly UDP ([udp-and-tcp](https://docs.fly.io/networking/udp-and-tcp)); browser RTP is about 1200 bytes. Unmeasured.
12. **Ops burden and security surface:** a fast LiveKit release cadence; a public UDP IPv4 with no WAF; client IPs in logs (DPDP); camera video is new personal data, so consent, retention and legal sign-off are owner actions.
13. **Unverified operational details:** whether staged Fly secrets reach stopped pool Machines; Cloud's own `CreateDispatch` behaviour with no registered worker; `livekit-client` merging of client-supplied `iceServers`.
14. **Prior art is thin:** the one public LiveKit-on-Fly guide (bekriebel, last commit 2022-05-01) was abandoned over "several connectivity issues". The 2026 reports are non-staff and unanswered.