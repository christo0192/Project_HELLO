#!/usr/bin/env bash
# sbom.sh — Generate CycloneDX 1.5 SBOMs for API and web projects
#
# Uses built-in `npm sbom` (npm >= 10, Node.js >= 22).
# Outputs sbom.cdx.json into an artifact directory.
# Generated SBOMs are NOT committed.
#
# Usage:
#   bash scripts/sbom.sh              # generates into sbom-artifacts/
#   bash scripts/sbom.sh --out /tmp   # custom output directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUT_DIR="$REPO_ROOT/sbom-artifacts"

if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--out" ] || [ -z "$2" ]; then
    echo "Usage: $0 [--out <directory>]" >&2
    exit 2
  fi
  OUT_DIR="$2"
fi

mkdir -p "$OUT_DIR"

echo "=== Generating SBOMs → $OUT_DIR ==="

# ── API SBOM ───────────────────────────────────────────────────────

echo "--- API ---"
cd "$REPO_ROOT/app/api"
npm sbom --package-lock-only --sbom-format cyclonedx --sbom-type application > "$OUT_DIR/api-sbom.cdx.json"

# Validate the format without interpolating file paths into JavaScript.
validate_sbom() {
  local sbom_path="$1"
  node - "$sbom_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, "utf-8"));
if (data.bomFormat !== "CycloneDX" || data.specVersion !== "1.5") {
  throw new Error(`Expected CycloneDX 1.5, got ${data.bomFormat || "unknown"} ${data.specVersion || "unknown"}`);
}
console.log(`  OK: CycloneDX ${data.specVersion}, ${data.components?.length || 0} components`);
NODE
}

validate_sbom "$OUT_DIR/api-sbom.cdx.json" || {
  echo "  FAIL: API SBOM is not valid CycloneDX 1.5"
  exit 1
}

# ── Web SBOM ───────────────────────────────────────────────────────

echo "--- Web ---"
cd "$REPO_ROOT/app/web"
npm sbom --package-lock-only --sbom-format cyclonedx --sbom-type application > "$OUT_DIR/web-sbom.cdx.json"

validate_sbom "$OUT_DIR/web-sbom.cdx.json" || {
  echo "  FAIL: Web SBOM is not valid CycloneDX 1.5"
  exit 1
}

echo ""
echo "SBOMs generated:"
ls -la "$OUT_DIR"/*.cdx.json
