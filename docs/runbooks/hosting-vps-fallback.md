# Runbook: Persistent near-India VPS fallback (bounded USD 12/month)

Status: **OWNER-OPERATED / PENDING verification.** Fallback topology only, used
if LiveKit Cloud Agents proves unsuitable after owner evaluation (see
[ADR-0010](../adr/0010-hosting-topology.md)). No VPS is provisioned by this
repository. Provider, region, pricing, residency, and DPA facts are PENDING
owner verification.

## 1. Position in the topology

1. Primary: LiveKit Cloud Build + Cloud Agents (see
   [hosting-livekit-cloud.md](hosting-livekit-cloud.md)).
2. Runtime secrets: managed Infisical (see
   [hosting-infisical.md](hosting-infisical.md)).
3. Fallback: a persistent near-India VPS running the containerised worker, with
   an **internal engineering ceiling of USD 12/month initially** — a budget
   bound, not a provider quote.
4. The existing OCI E2 Micro Mumbai instance remains a lightweight
   gateway/fallback only (see [hosting-e2-gateway.md](hosting-e2-gateway.md)).

## 2. Why a persistent host

The voice worker must hold an outbound WebSocket to LiveKit and run continuously
(always-on). Free/scale-to-zero platforms that sleep, scale to zero, or impose
short session limits are unsuitable for an always-on worker; a small persistent
VPS with a hard monthly ceiling is the bounded fallback. This is an engineering
rationale, not a claim about any provider's terms.

## 3. Provider-neutral template (placeholders only)

Templates live under `infra/hosting/vps-fallback/` and contain placeholders
only — no provider names, no region identifiers, no account/project IDs, no
credentials. All concrete values are PENDING owner selection.

- `infra/hosting/vps-fallback/systemd/voice-agent.service.example` — systemd
  unit example for running the containerised worker (or the image directly) with
  `Restart=always`, a bounded stop timeout, and env injected from the systemd
  EnvironmentFile supplied by the owner's secret handling (never committed).
- `infra/hosting/vps-fallback/README.md` — provisioning steps with
  placeholders.

## 4. OWNER-OPERATED steps (all PENDING owner verification)

1. Select a near-India VPS provider and region; verify pricing (initial
   ceiling: USD 12/month), residency, and DPA evidence.
2. Provision the host; configure SSH with a key the owner controls.
3. Install Docker (or use the systemd unit with a system Python venv — the
   containerised image is the default path).
4. Place the container image (built from `app/voice-livekit`) on the host.
5. Inject runtime environment from managed Infisical (machine identity) or a
   root-only EnvironmentFile — never in the repository or image.
6. Validate: non-root identity, `python agent.py start` connects to the LiveKit
   project, sessions begin/end, drain on stop is observed.
7. Enforce the monthly ceiling with provider billing alarms; document observed
   cost.

## 5. Boundaries

No account creation, card entry, paid purchase, or provisioning without
interactive owner action. No real provider IDs or credentials appear in this
repository. Production acceptance remains a separate gate.
