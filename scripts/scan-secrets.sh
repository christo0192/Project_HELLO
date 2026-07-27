#!/usr/bin/env sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
gitleaks_image=${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}
verbose_flag=
if [ "${GITLEAKS_VERBOSE:-0}" = "1" ]; then
  verbose_flag=--verbose
fi

if [ "${1:-}" = "--staged" ]; then
  if command -v gitleaks >/dev/null 2>&1; then
    git diff --cached --no-ext-diff --binary | \
      gitleaks stdin --redact $verbose_flag --config .gitleaks.toml
    exit $?
  fi

  if command -v docker >/dev/null 2>&1; then
    git diff --cached --no-ext-diff --binary | \
      docker run --rm -i -v "$repo_root:/repo:ro" -w /repo \
        "$gitleaks_image" stdin --redact $verbose_flag --config .gitleaks.toml
    exit $?
  fi

  echo "gitleaks or Docker is required for the pre-commit secret scan" >&2
  exit 127
fi

scan_root=$(mktemp -d)
trap 'rm -rf -- "$scan_root"' EXIT HUP INT TERM

if [ "${1:-}" = "--committable" ]; then
  git ls-files --cached --others --exclude-standard -z | \
    tar --null --files-from=- --create --file=- | \
    tar --extract --file=- --directory="$scan_root"
else
  find . \
    \( -path './.git' -o -path '*/node_modules' -o -path '*/.venv' \
       -o -path '*/venv' -o -path '*/dist' -o -path '*/build' \
       -o -path '*/__pycache__' -o -path './docs/hello-assets' \) -prune \
    -o \( -path './docs/HELLO.html' -o -path './docs/HELLO.md' \
       -o -name '*.pdf' -o -name '*.mp3' -o -name '*.webm' \
       -o -name '*.wav' -o -name '*.mp4' \) -prune \
    -o -type f -print0 | \
    tar --null --files-from=- --create --file=- | \
    tar --extract --file=- --directory="$scan_root"
fi

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks dir --redact $verbose_flag --max-archive-depth=1 --max-decode-depth=2 \
    --config .gitleaks.toml "$scan_root"
  exit $?
fi

if command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$repo_root:/repo:ro" -v "$scan_root:/scan:ro" \
    -w /repo "$gitleaks_image" dir --redact $verbose_flag --max-archive-depth=1 \
    --max-decode-depth=2 --config .gitleaks.toml /scan
  exit $?
fi

echo "gitleaks or Docker is required for the working-tree secret scan" >&2
exit 127
