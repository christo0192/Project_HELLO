# generated-pdf — Synthetic Scorecard PDF

> **is_synthetic** — Deterministic ID: `demo-pdf-v1-2025-06-15`
> Generated: 2025-06-15T10:00:00Z

## Purpose

This directory contains the synthetic replacement for the original generated
scorecard PDF artifacts (FND-03 group `generated-pdf`).

## Artifacts

| File | Description |
|------|-------------|
| `README.md` | This document (manifest and generator instructions) |
| `generated-pdf-synthetic.json` | Machine-readable synthetic scorecard data used for PDF generation |
| `generated-pdf-template.md` | Human-readable template rendering of the scorecard |

## Disposition

- **Original:** Quarantined by `.gitignore` (`docs/*.pdf`)
- **Replacement:** Deterministic JSON data + Markdown template
- **Evidence ref:** `restricted://FND03/generated-pdf/v1`

## Generated Scorecard Data

The synthetic scorecard JSON contains three fictional candidate assessments
with deterministic IDs, fixed timestamps, and no PII. All scores are 0-100
integer values. Phone fields are null. Emails use `@example.invalid`.

## Regeneration

```bash
# If the generator script is available:
node scripts/generate-demo-artifacts.mjs --group generated-pdf

# The output is deterministic — running twice produces identical checksums.
```
