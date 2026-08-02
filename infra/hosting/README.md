# infra/hosting — managed-hosting foundations (provider-neutral)

Repository-owned deployment contracts for the managed-hosting pilot topology
described in [ADR-0010](../../docs/adr/0010-hosting-topology.md):

1. **LiveKit Cloud Build + Cloud Agents** first (SFU + managed Python worker).
2. **Managed Infisical** for runtime secret injection.
3. **Existing OCI E2 Micro Mumbai** retained as a lightweight gateway/fallback
   only.
4. **Near-India VPS fallback** (bounded, initial USD 12/month ceiling) if Cloud
   Agents proves unsuitable.

## Truthful boundaries

- These are repository architecture, validation scripts, CI, ADRs, and owner
  runbooks **only**. No account creation, card entry, secret entry, paid
  purchase, cloud apply, provider mutation, or production deployment happens
  from this repository.
- Every external fact (provider entitlements, pricing, free-tier limits,
  residency, DPA, project IDs, machine identity) is **PENDING owner
  verification** and is not claimed here.
- Templates under this directory use placeholders only — no real provider
  names-in-live-form, no project IDs, no credentials.

## Layout

| Path | Purpose |
| --- | --- |
| `CHECKLIST.md` | Owner-operated provisioning/verification checklist (all items PENDING owner). |
| `vps-fallback/README.md` | Provider-neutral VPS fallback provisioning steps. |
| `vps-fallback/systemd/voice-agent.service.example` | systemd unit example for the containerised worker (placeholders only). |

## Related

- Runbooks: `docs/runbooks/hosting-livekit-cloud.md`,
  `docs/runbooks/hosting-infisical.md`,
  `docs/runbooks/hosting-vps-fallback.md`,
  `docs/runbooks/hosting-e2-gateway.md`.
- Validators: `scripts/validate-container.sh`,
  `scripts/validate-no-secrets-baked.sh`,
  `scripts/validate-hosting-foundation.test.mjs`.
- CI: `.github/workflows/hosting-validate.yml` (bounded static checks).
