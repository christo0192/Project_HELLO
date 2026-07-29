# scorecard-export — Synthetic Scorecard Export

> **is_synthetic** — Deterministic ID: `demo-scorecard-v1-2025-06-15`
> Generated: 2025-06-15T10:00:00Z

## Purpose

This directory contains the synthetic replacement for the original scorecard
export artifacts (FND-03 group `scorecard-export`).

## Artifacts

| File | Description |
|------|-------------|
| `README.md` | This manifest |
| `scorecard-export-synthetic.json` | Machine-readable synthetic scorecard export data |

## Data

The scorecard export JSON contains two synthetic candidate assessments with
deterministic IDs, fixed timestamps, and no PII. All scores use the reserved
`@example.invalid` email domain. Phone fields are null.

## Disposition

- **Original:** Quarantined by `.gitignore` (`docs/*.pdf`)
- **Replacement:** Synthetic JSON
- **Evidence ref:** `restricted://FND03/scorecard-export/v1`
