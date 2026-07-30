# Decommission Runbook (MIG-15)

**Status:** Template — unexecuted. Decommission is irreversible. All steps
are BLOCKED by default and require gated approvals before execution.

**Owner-gate:** Security + DB Admin + Legal. Decommission may proceed only
after MIG-14 (rollback window closure) and GOV-04 (retention policy) are
complete.

---

## 1. Scope

This runbook covers the permanent decommissioning of the **old Supabase
project** after the rollback window (MIG-14) has closed and the new project
is the sole production target.

**Decommission includes:**
- Credential revocation.
- Integration/DNS removal.
- Data retention and export.
- Project lock, sandbox, or deletion.

**Decommission defaults to STOP.** No step is executed without explicit,
recorded, dual approval.

---

## 2. Prerequisites (BLOCKED until completed)

> **INVARIANT:** Every prerequisite must be evidenced before any
> decommission step is unblocked. Missing prerequisite → HARD STOP.

### 2.1 Required completed milestones

- [ ] **MIG-14 complete** — rollback window closed. Signed closure report
      exists with evidence of stability window, reconciliation pass, and
      owner go decision.
- [ ] **GOV-04 complete** — retention policy per data class is defined.
      Legal hold, backup aging, and scheduled-deletion rules are
      documented and approved by Legal.
- [ ] **Dependency scan complete** — scan shows zero old-project traffic.
      No production service, worker, or cron job connects to the old
      project. Scan evidence is signed by SRE.

### 2.2 Required approvals

| Approval | Required from | Status |
|----------|--------------|--------|
| Decommission plan | DB Admin + Security + Legal | BLOCKED |
| Credential revocation order | Security + DB Admin | BLOCKED |
| Data retention/export proof | Legal | BLOCKED |
| Final execution authorization | Dual approval (any two of: Eng Lead, DB Admin, Security Lead) | BLOCKED |

> **INVARIANT:** All approvals are recorded with name, role, date, and
> signature/verification. No approval-by-silence.

### 2.3 No-decommission conditions

Decommission is **HARD STOPPED** if any of the following is true:

- [ ] MIG-14 is not closed.
- [ ] GOV-04 retention policy is not approved by Legal.
- [ ] Dependency scan shows non-zero old-project traffic.
- [ ] An active legal hold applies to data in the old project.
- [ ] A security incident involving the old project is unresolved.
- [ ] Any required approval (Section 2.2) is not granted.

**Decommission defaults to STOP.** When in doubt, do not proceed. Archive
credentials, lock access, and defer.

---

## 3. Pre-decommission evidence capture

Before any credential or access change, capture the following evidence:

### 3.1 Data retention & export proof

- [ ] **Full data export.** Export all tables, schema, storage objects, and
      Auth users (if any) from the old project. The export is encrypted and
      stored in an owner-approved long-term archive location.
      Export format: `pg_dump` custom format (or owner-approved equivalent)
      + per-table CSV + storage object manifest (key, size, content-type,
      digest).
- [ ] **Retention compliance evidence.** A report mapping each data class
      to:
      - Applicable retention period (per GOV-04).
      - Export location and encryption details.
      - Legal hold status (none, or document reference if held).
      - Scheduled deletion timeline (if applicable).
- [ ] **Legal sign-off.** Legal confirms the export satisfies retention
      requirements. Signed evidence is stored.
      | Data class | Retention period | Export complete? | Legal sign-off |
      |------------|-----------------|------------------|----------------|
      | Candidate PII | OWNER-APPROVED | [ ] | [ ] |
      | Session/transcript data | OWNER-APPROVED | [ ] | [ ] |
      | Assessment/score data | OWNER-APPROVED | [ ] | [ ] |
      | Storage objects (recordings, resumes) | OWNER-APPROVED | [ ] | [ ] |
      | Application/infrastructure logs | OWNER-APPROVED | [ ] | [ ] |

### 3.2 Credential & integration inventory

- [ ] **Credential inventory:** All service-role keys, anon keys, and any
      other credentials issued for the old project are inventoried.
      | Credential type | Location | Status |
      |-----------------|----------|--------|
      | `service_role` key | OWNER-INVENTORIED | Active |
      | `anon` key | OWNER-INVENTORIED | Active |
      | API tokens (if any) | OWNER-INVENTORIED | Active |
      | Client-side keys (if exposed) | OWNER-INVENTORIED | Active |
- [ ] **Integration inventory:** Every integration or service that connects
      to the old project is identified.
      | Integration / service | Purpose | Status |
      |----------------------|---------|--------|
      | API server (old project client) | DB reads/writes | OWNER-VERIFIED |
      | Worker (old project client) | Session lifecycle | OWNER-VERIFIED |
      | Dashboard (old project client) | UI reads via API | OWNER-VERIFIED |
      | CI/CD (if connected) | Seed/synthetic data | OWNER-VERIFIED |
      | Monitoring/observability pipeline | Health checks | OWNER-VERIFIED |
      | Other | Owner-verified | OWNER-VERIFIED |
- [ ] **DNS / endpoint inventory:** Any DNS records, custom domains, or
      Supabase project endpoint URLs that reference the old project.
      | Endpoint | Type | Used by |
      |----------|------|---------|
      | `<project>.supabase.co` | DB/REST/API | OWNER-INVENTORIED |
      | Custom domain (if any) | DNS CNAME/ALIAS | OWNER-INVENTORIED |

---

## 4. Decommission steps (template — BLOCKED)

Each step is individually gated. No step is executed without dual approval.

### 4.0 Final dependency re-check

Before any step:

- Re-run the dependency scan (Section 2.1). If any old-project traffic is
  found → HARD STOP. Decommission is blocked until the dependency is
  resolved.
- Record the scan timestamp and result.

### 4.1 Revoke old-project credentials (BLOCKED)

> **GATE:** Requires **Security + DB Admin** approval.
> **Default:** STOP — if approval is not granted, credentials remain intact
> and access-locked.

```
STEP 1: Rotate or revoke the service_role key.
   ACTION: In the Supabase dashboard or via API, rotate (if keeping the
           project for archive) or revoke (if deleting). Do NOT delete
           the project yet.
   VERIFY:  Attempt to connect with the old key — it MUST fail.
            Log the verification result.

STEP 2: Rotate or revoke the anon key.
   ACTION: Same process as STEP 1.
   VERIFY:  anon-key connections fail. Log verification.

STEP 3: Revoke any API tokens, project-scoped access tokens.
   ACTION: Delete or rotate.
   VERIFY:  Each token is tested and fails.

STEP 4: Remove credentials from all secrets-manager locations.
   ACTION: Delete or disable the old-project credential entries in the
           secrets manager / runtime-injection system.
   VERIFY:  Confirm the entries are removed or disabled. No application
            restart should be needed unless the credential was cached.
```

### 4.2 Remove integrations & DNS (BLOCKED)

> **GATE:** Requires **DB Admin + SRE** approval.
> **Default:** STOP — if approval is not granted, integrations remain.

```
STEP 1: Remove old-project connection strings from application
        configuration.
   ACTION: Clean up any old-project config entries in deployment
           manifests, config files, or environment variable definitions.
           Do NOT redeploy — this is cleanup for accuracy.

STEP 2: Remove or update DNS records pointing to old project.
   ACTION: If a custom domain or CNAME pointed to the old project,
           remove it or point it to the new project.
   VERIFY:  DNS resolves to the new project (or nothing, if removed).
```

### 4.3 Project lock / sandbox / deletion (BLOCKED)

> **GATE:** Requires **dual approval** (any two of: Eng Lead, DB Admin,
> Security Lead) + **Legal** sign-off.
> **Default:** STOP. Project is locked but NOT deleted unless Legal and
> Security explicitly approve deletion.

**Deletion is NOT the default.** The default is:

```
DEFAULT: Lock the old project to read-only/no-network access.
         Preserve all data in place for the Legal retention period.
         Do NOT delete.
```

| Action | Required approvals | Default |
|--------|-------------------|---------|
| Lock project (read-only, no network) | DB Admin | **DEFAULT** |
| Delete project | Dual approval + Legal | **NO** — explicit override required |
| Archive data and delete project | Dual approval + Legal + Security | **NO** — only after retention proof |

```
IF (dual approval + Legal approve deletion):
  1. Verify export completeness (Section 3.1).
  2. Verify credential revocation (Section 4.1).
  3. Verify integration removal (Section 4.2).
  4. Delete the project via Supabase dashboard/API.
  5. Capture deletion confirmation (screenshot or API response).

ELSE:
  1. Lock the project: disable all network access, set to read-only.
  2. Restrict access to a single break-glass DBA account.
  3. Document lock-down details and retention end date.
  4. Schedule a future review for permanent deletion.
```

**Post-deletion verification (if deletion was approved):**

- [ ] Old project no longer appears in Supabase organization dashboard.
- [ ] Old project DNS/endpoint returns DNS error or project-not-found.
- [ ] Old credentials fail authentication at the network level.
- [ ] All integrations have been removed or re-pointed.
- [ ] Export archive integrity is verified (digest check).

---

## 5. Hard-stops

| Condition | Action |
|-----------|--------|
| Any dependency scan shows old-project traffic | HARD STOP. Do not proceed. |
| Any required approval is missing or expired | HARD STOP. Do not proceed. |
| Legal identifies an unaddressed legal hold | HARD STOP. Old project data must be preserved. |
| Credential revocation fails | HARD STOP. Do not proceed to project deletion. |
| Export or retention proof is incomplete | HARD STOP. Complete evidence first. |
| Dual approval for deletion is not secured | Default: lock, do not delete. |

---

## 6. Post-decommission (after closure)

- [ ] Decommission report is signed by all approving parties and stored
      as immutable evidence.
- [ ] Old-project credentials are removed from all systems.
- [ ] Dependency scan is archived.
- [ ] Export and retention evidence is stored in the long-term archive.
- [ ] A note is added to `docs/current-state.md` or equivalent, recording
      that the old project is decommissioned and referencing this report.

---

## 7. Irreversibility notice

**Decommission is irreversible.** Once credentials are revoked and the
project is deleted:

- Data cannot be recovered (no PITR, no backup — the old project no longer
  exists).
- Credentials cannot be re-issued.
- Integration paths are permanently severed.

If data must be restored after decommission, the only path is to import from
the encrypted archive (Section 3.1), which requires:
1. Legal approval (data subject rights, retention policy).
2. Provisioning of a new Supabase project.
3. Full migration and cutover runbook re-execution.
