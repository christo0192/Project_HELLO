#!/usr/bin/env bash
# TST-05 offline deterministic SAST runner (Phase 6 lane L4).
#
# Repository-owned analyzer (scripts/sast/analyzer.mjs + scripts/sast/rules.json):
# zero external service, zero network, no unpinned curl installer, no downloads.
# Fail-closed: analyzer exits 1 on any dangerous-code finding.
#
# Boundary: this pass does NOT scan secrets/env — that is the gitleaks boundary
# (scripts/scan-secrets.sh, .gitleaks.toml, .github/workflows/secret-scan.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/sast/analyzer.mjs "$@"
