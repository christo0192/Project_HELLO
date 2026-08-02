# Hosting foundations — owner-operated checklist

Every item below is **PENDING owner verification** and requires interactive
owner action (account creation, card entry, secret entry, paid purchase, cloud
apply, or provider mutation are outside this repository's automation).
Nothing here is claimed done by the repository.

## A. LiveKit Cloud (Build + Cloud Agents)

- [ ] Confirm Build-tier SFU entitlement, pricing, and free-tier limits.
- [ ] Create the LiveKit Cloud project (owner action).
- [ ] Confirm Cloud Agents entitlement for the Python worker.
- [ ] Verify the current agent-deployment command surface (`lk --help`,
      official Cloud Agents docs) at execution time.
- [ ] Deploy the image built from `app/voice-livekit` (production entrypoint
      `python agent.py start`).
- [ ] Decide and verify the `download-files` model-weights strategy per current
      official guidance (not executed in CI).
- [ ] Confirm region/residency and DPA evidence.
- [ ] Observe graceful drain/stop behavior against the live project.

## B. Infisical (managed runtime injection)

- [ ] Create the managed Infisical project (owner action).
- [ ] Create the voice-worker environment scope with the variable names from
      `app/voice-livekit/.env.example`.
- [ ] Provision a narrow machine identity (read-only on that scope only).
- [ ] Wire the orchestrator/container runtime to inject env from Infisical at
      runtime; never commit the identity or values.
- [ ] Schedule identity rotation and exposure response.

## C. Near-India VPS fallback (only if Cloud Agents is unsuitable)

- [ ] Select provider + region; verify pricing against the initial USD 12/month
      ceiling; collect residency/DPA evidence.
- [ ] Provision the host; configure owner-controlled SSH.
- [ ] Deploy the container image (or use `infra/hosting/vps-fallback/systemd/`).
- [ ] Inject env from Infisical or a root-only file (never committed).
- [ ] Validate non-root identity, connection, sessions, drain.
- [ ] Enable billing alarms; record observed cost.

## D. OCI E2 Micro gateway/fallback

- [ ] Keep the instance lightweight gateway/supervisor only.
- [ ] No Oracle Terraform changes; no instance mutation without owner action.
- [ ] Do not place managed-topology secrets on the instance.

## E. Repository validation (already enforced, run to confirm)

```bash
node scripts/validate-hosting-foundation.test.mjs
bash scripts/validate-no-secrets-baked.sh
bash scripts/validate-container.sh
node scripts/check-adrs.mjs
node scripts/check-current-state.mjs
bash scripts/sast.sh
bash scripts/scan-secrets.sh
git diff --check
```

## F. Production acceptance

- [ ] Legal, Security, Product, and owner acceptance — separate gate, not
      granted by this repository.
