# Environment Configuration Contract

`config/environment.schema.json` is the source of truth for variable names and
their secret, browser, and production requirements. The contract currently
covers the active API, web client, and LiveKit worker. The previous Pipecat
service is a legacy rollback path and is not an approved production component.

## Environment separation

- Development uses ignored local `.env` files and isolated development
  resources only.
- Staging and production receive configuration through separate runtime
  injection scopes. They must not use checked-in `.env` files.
- Provider secrets and service-role credentials are server/worker-only.
- `VITE_*` values are public build-time configuration and must never be marked
  or used as secrets.
- `GOPU_*` context is synthetic local-console data only. Production candidate
  context must come from an authorized worker-only session mechanism.

Run `node scripts/check-env-contract.mjs` after adding, removing, or renaming an
environment variable. CI rejects undocumented runtime reads, unknown/duplicate
example fields, unsafe project identifiers, key-shaped samples, and secret
values that do not use `replace_me`.
