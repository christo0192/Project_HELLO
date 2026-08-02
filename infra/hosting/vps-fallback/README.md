# VPS fallback — provider-neutral provisioning steps

Fallback only (used if LiveKit Cloud Agents proves unsuitable). See
[ADR-0010](../../docs/adr/0010-hosting-topology.md) and
[docs/runbooks/hosting-vps-fallback.md](../../docs/runbooks/hosting-vps-fallback.md).

All placeholders are PENDING owner selection. Nothing here is provisioned by
the repository.

## Steps (owner-operated)

1. **Select provider/region.** Near-India, initial ceiling USD 12/month.
   Verify pricing, residency, and DPA evidence. `PROVIDER_PLACEHOLDER`,
   `REGION_PLACEHOLDER`.
2. **Provision the host.** `HOST_IP_PLACEHOLDER`, owner-controlled SSH key.
3. **Install Docker** (recommended) or a Python 3.12 venv.
4. **Build/pull the worker image** from `app/voice-livekit`:
   `docker build -t hello-voice:local app/voice-livekit`.
5. **Run with runtime env injection** (never committed values): prefer managed
   Infisical machine identity; otherwise a root-only EnvironmentFile.
6. **Validate**: `id` is non-root; `python agent.py start` connects to the
   LiveKit project; sessions start/end; stop drains within the configured
   `LIVEKIT_WORKER_DRAIN_SEC`.
7. **Budget**: billing alarms at the ceiling; record observed cost.

## systemd example

`systemd/voice-agent.service.example` — placeholders only; no secrets.

## Boundaries

No account creation, card entry, paid purchase, or provisioning without
interactive owner action. No real provider IDs or credentials in the
repository. Production acceptance is a separate gate.
