"""
provider_boundaries.py — LLM-01 provider boundary inventory (PR-A Lane A1).

PURE METADATA ONLY. This module catalogs every current provider boundary path
in the Python (voice-livekit) runtime and validates the inventory shape. It
performs NO network access, NO provider client construction, NO plugin
instantiation, and imports NOTHING from the LiveKit SDK or provider SDKs.

No universal provider abstraction exists in this repository: each workload
reaches its provider through a workload-specific, concrete contract (LiveKit
plugin constructors in agent.py, prompt assembly in prompting.py, provenance
in provenance.py, persistence in persistence.py). This inventory records those
contracts as they are today; it does not introduce adapters.

Policy states are repository-only: every entry is PROPOSED, PENDING, or
NOT_EVALUATED. A positive approval claim (APPROVED/DEPLOYED/ACCEPTED/winner)
is rejected UNCONDITIONALLY — no EV-xxxx/UUID/identifier reference can
authorize it, because repository-only Phase 10 work carries no authentic
external evidence.

Env var names are recorded as names only. No values, endpoints, tokens, keys,
or credentials appear in this module. The shape mirrors
app/api/src/model-governance/provider-boundaries.ts without cross-imports.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# ── Schema version ──────────────────────────────────────────────────────

MODEL_GOVERNANCE_SCHEMA_VERSION = 1

# ── Closed enumerations ─────────────────────────────────────────────────

ALLOWED_POLICY_STATUSES = frozenset({"PROPOSED", "PENDING", "NOT_EVALUATED"})
ALLOWED_PROVIDERS = frozenset({"deepseek", "sarvam", "silero", "livekit", "supabase"})
ALLOWED_WORKLOADS = frozenset({"screening", "scoring", "resume_extraction"})
ALLOWED_RUNTIMES = frozenset({"api", "voice-livekit"})
ALLOWED_BOUNDARY_KINDS = frozenset(
    {
        "cli_spawn",
        "sdk_constructor",
        "prompt_construction",
        "scoring",
        "provenance",
        "persistence",
    }
)

# ── Approval claim detection ────────────────────────────────────────────

APPROVAL_CLAIM_RE = re.compile(r"\b(?:approved|deployed|accepted|winner)\b", re.IGNORECASE)

# ── Closed identifier grammars ──────────────────────────────────────────

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")
_ENV_VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_ALLOWLIST_VALUE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_EVIDENCE_REF_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
_CONSTRUCTOR_PATH_RE = re.compile(r"^(?:app|scripts|config|docs)\/[A-Za-z0-9._/-]+$")

# ── Defense-in-depth string guards (mirror model-provenance.ts) ─────────

_URL_OR_PATH_RE = re.compile(
    r"(?:https?://|ftp://|file://|wss?://|[\s(]/[\w./-]|^/[\w./-]|\.\.(?:[/\\]|$)|"
    r"\\(?:\\[\w.-]+)+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|"
    r"\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})",
    re.IGNORECASE,
)

_TOKEN_LIKE_RE = re.compile(
    r"\b(?:sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|"
    r"token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|"
    r"eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|"
    r"ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|"
    r"xox[baprs]-[a-zA-Z0-9-]{10,})\b",
    re.IGNORECASE,
)

MAX_NOTES_LENGTH = 1000
MAX_PATH_LENGTH = 200

# ── Entry shape ─────────────────────────────────────────────────────────

_ENTRY_ALLOWED_KEYS = frozenset(
    {
        "id",
        "workloads",
        "provider",
        "runtime",
        "boundaryKind",
        "constructorPath",
        "envVars",
        "allowlists",
        "policyStatus",
        "optionalEvidenceRefs",
        "notes",
    }
)


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _is_string_array(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _has_url_or_path(value: str) -> bool:
    return bool(_URL_OR_PATH_RE.search(value))


def _has_credential(value: str) -> bool:
    return bool(_TOKEN_LIKE_RE.search(value))


def _is_valid_closed_id(value: Any, label: str, errors: list[str]) -> bool:
    if not isinstance(value, str) or len(value) == 0:
        errors.append(f"{label}: must be a non-empty string")
        return False
    if _has_url_or_path(value):
        errors.append(f"{label}: must not contain URLs or paths")
        return False
    if _has_credential(value):
        errors.append(f"{label}: must not contain credentials")
        return False
    return True


def _validate_entry(raw: Any, index: int, errors: list[str]) -> None:
    label = f"entries[{index}]"
    if not _is_plain_object(raw):
        errors.append(f"{label}: must be a plain object")
        return

    for key in raw:
        if key not in _ENTRY_ALLOWED_KEYS:
            errors.append(f"{label}: unknown field at top level")

    # ── id ──────────────────────────────────────────────────────────────
    if not isinstance(raw.get("id"), str) or not _ID_RE.match(raw.get("id", "")):
        errors.append(f"{label}.id: must be a lowercase kebab-case identifier")

    # ── workloads (non-empty, allowlisted) ───────────────────────────────
    workloads = raw.get("workloads")
    if not _is_string_array(workloads) or len(workloads) == 0:
        errors.append(f"{label}.workloads: must be a non-empty string array")
    else:
        for workload in workloads:
            if workload not in ALLOWED_WORKLOADS:
                errors.append(f"{label}.workloads: not allowlisted")

    # ── provider ─────────────────────────────────────────────────────────
    provider = raw.get("provider")
    if not isinstance(provider, str):
        errors.append(f"{label}.provider: must be a string")
    elif provider not in ALLOWED_PROVIDERS:
        errors.append(f"{label}.provider: not allowlisted")

    # ── runtime ─────────────────────────────────────────────────────────
    runtime = raw.get("runtime")
    if not isinstance(runtime, str):
        errors.append(f"{label}.runtime: must be a string")
    elif runtime not in ALLOWED_RUNTIMES:
        errors.append(f"{label}.runtime: not allowlisted")

    # ── boundaryKind ─────────────────────────────────────────────────────
    boundary_kind = raw.get("boundaryKind")
    if not isinstance(boundary_kind, str):
        errors.append(f"{label}.boundaryKind: must be a string")
    elif boundary_kind not in ALLOWED_BOUNDARY_KINDS:
        errors.append(f"{label}.boundaryKind: not allowlisted")

    # ── constructorPath (safe repository-relative path) ──────────────────
    constructor_path = raw.get("constructorPath")
    if not isinstance(constructor_path, str) or len(constructor_path) > MAX_PATH_LENGTH:
        errors.append(f"{label}.constructorPath: must be a short repository-relative path")
    elif not _CONSTRUCTOR_PATH_RE.match(constructor_path):
        errors.append(
            f"{label}.constructorPath: must be a repository-relative path "
            "(no URL, absolute, or traversal)"
        )
    elif _has_url_or_path(constructor_path) or _has_credential(constructor_path):
        errors.append(f"{label}.constructorPath: must not contain URLs, paths, or credentials")

    # ── envVars (names only) ─────────────────────────────────────────────
    env_vars = raw.get("envVars")
    if not _is_string_array(env_vars):
        errors.append(f"{label}.envVars: must be a string array")
    else:
        for env_var in env_vars:
            if not _ENV_VAR_RE.match(env_var):
                errors.append(f"{label}.envVars: must be uppercase env var names")

    # ── allowlists (closed identifiers) ──────────────────────────────────
    allowlists = raw.get("allowlists", [])
    if allowlists is not None and not _is_string_array(allowlists):
        errors.append(f"{label}.allowlists: must be a string array")
    else:
        for allowlist_value in allowlists or []:
            if not _ALLOWLIST_VALUE_RE.match(allowlist_value):
                errors.append(f"{label}.allowlists: must be closed lowercase identifiers")

    # ── policyStatus (positive approval claims are unconditionally rejected) ──
    policy_status = raw.get("policyStatus")
    if not isinstance(policy_status, str) or len(policy_status) == 0:
        errors.append(f"{label}.policyStatus: must be a non-empty string")
    elif APPROVAL_CLAIM_RE.search(policy_status):
        # Repository-only work carries no authentic external evidence: an
        # APPROVED/DEPLOYED/ACCEPTED/winner value is rejected regardless of any
        # optionalEvidenceRefs entry (EV-xxxx / UUID / arbitrary string).
        errors.append(
            f"{label}.policyStatus: positive approval claim is not permitted in repository-only work (no external evidence escape)"
        )
    elif policy_status not in ALLOWED_POLICY_STATUSES:
        errors.append(f"{label}.policyStatus: not allowlisted")

    # ── optionalEvidenceRefs (closed compact identifiers only) ───────────
    evidence_refs = raw.get("optionalEvidenceRefs")
    if evidence_refs is not None:
        if not _is_string_array(evidence_refs):
            errors.append(f"{label}.optionalEvidenceRefs: must be a string array")
        else:
            for ref in evidence_refs:
                if not _EVIDENCE_REF_RE.match(ref):
                    errors.append(
                        f"{label}.optionalEvidenceRefs: must be compact evidence identifiers (not URLs)"
                    )
                if _has_url_or_path(ref) or _has_credential(ref):
                    errors.append(
                        f"{label}.optionalEvidenceRefs: must not contain URLs, paths, or credentials"
                    )

    # ── notes (optional prose; no URL/token-lookalike values) ────────────
    notes = raw.get("notes")
    if notes is not None:
        if not isinstance(notes, str) or len(notes) == 0:
            errors.append(f"{label}.notes: must be a non-empty string when present")
        elif len(notes) > MAX_NOTES_LENGTH:
            errors.append(f"{label}.notes: exceeds maximum length")
        elif _has_url_or_path(notes) or _has_credential(notes):
            errors.append(f"{label}.notes: must not contain URLs, paths, or credentials")


def validate_provider_boundaries(raw: Any) -> dict[str, Any]:
    """
    Validate a provider-boundary inventory.

    Returns ``{"valid": True, "data": [...]}`` on success or
    ``{"valid": False, "error": "..."}`` on failure. Rejects non-list inputs,
    unknown fields, closed-set violations, unsafe paths, URL-lookalike values,
    token-lookalike values, and ANY positive approval claim
    (APPROVED/DEPLOYED/ACCEPTED/winner) — unconditionally, with no external-
    evidence escape. Diagnostics use fixed category labels and never echo the
    rejected value.
    """
    if not isinstance(raw, list):
        return {"valid": False, "error": "provider boundaries: must be a non-empty array"}
    if len(raw) == 0:
        return {"valid": False, "error": "provider boundaries: must not be empty"}

    errors: list[str] = []
    for index, entry in enumerate(raw):
        _validate_entry(entry, index, errors)

    if errors:
        return {"valid": False, "error": "; ".join(errors)}
    return {"valid": True, "data": raw}


# ── Current inventory (repository-only; as of baseline b3f1f301) ────────
#
# Each entry records a concrete boundary that EXISTS in this repository
# today. No entry is a proposal for a new abstraction; none implies a
# provider switch; none carries an endpoint, token, or credential.
#
# The full TypeScript + Python inventory is kept in
# app/api/src/model-governance/provider-boundaries.ts (single source of
# truth). This module mirrors ONLY the Python (voice-livekit) runtime entries
# and is validated for parity by the unit tests.

PROVIDER_BOUNDARIES: list[dict[str, Any]] = [
    {
        "id": "livekit-worker-connect",
        "workloads": ["screening"],
        "provider": "livekit",
        "runtime": "voice-livekit",
        "boundaryKind": "sdk_constructor",
        "constructorPath": "app/voice-livekit/agent.py",
        "envVars": ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
        "allowlists": [],
        "policyStatus": "PENDING",
        "notes": (
            "Worker bootstrap via cli.run_app (python agent.py start). Room connection behavior is "
            "OWNER_VERIFY; see docs/runbooks/hosting-livekit-cloud.md. Env names only; no values recorded here."
        ),
    },
    {
        "id": "livekit-stt-sarvam",
        "workloads": ["screening"],
        "provider": "sarvam",
        "runtime": "voice-livekit",
        "boundaryKind": "sdk_constructor",
        "constructorPath": "app/voice-livekit/agent.py",
        "envVars": ["SARVAM_STT_MODEL", "SARVAM_LANGUAGE"],
        "allowlists": [],
        "policyStatus": "PENDING",
        "notes": (
            "livekit.plugins.sarvam.STT constructed inside AgentSession. Network calls are SDK-internal "
            "with no constructor timeout/breaker control (see docs/runbooks/provider-resilience.md)."
        ),
    },
    {
        "id": "livekit-tts-sarvam",
        "workloads": ["screening"],
        "provider": "sarvam",
        "runtime": "voice-livekit",
        "boundaryKind": "sdk_constructor",
        "constructorPath": "app/voice-livekit/agent.py",
        "envVars": ["SARVAM_TTS_MODEL", "SARVAM_TTS_VOICE"],
        "allowlists": [],
        "policyStatus": "PENDING",
        "notes": (
            "livekit.plugins.sarvam.TTS constructed inside AgentSession. Network calls are SDK-internal "
            "with no constructor timeout/breaker control (see docs/runbooks/provider-resilience.md)."
        ),
    },
    {
        "id": "livekit-llm-deepseek",
        "workloads": ["screening"],
        "provider": "deepseek",
        "runtime": "voice-livekit",
        "boundaryKind": "sdk_constructor",
        "constructorPath": "app/voice-livekit/agent.py",
        "envVars": ["DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL"],
        "allowlists": ["deepseek"],
        "policyStatus": "PENDING",
        "notes": (
            "livekit.plugins.openai.LLM(model=DEEPSEEK_MODEL, base_url=DEEPSEEK_BASE_URL). "
            "Provenance is claimed via set_session_provenance before any provider construction; "
            "the same configured model feeds screening_provenance."
        ),
    },
    {
        "id": "livekit-vad-silero",
        "workloads": ["screening"],
        "provider": "silero",
        "runtime": "voice-livekit",
        "boundaryKind": "sdk_constructor",
        "constructorPath": "app/voice-livekit/agent.py",
        "envVars": [
            "LIVEKIT_VAD_ACTIVATION_THRESHOLD",
            "LIVEKIT_VAD_MIN_SPEECH_DURATION",
            "LIVEKIT_VAD_MIN_SILENCE_DURATION",
            "LIVEKIT_VAD_PREFIX_PADDING_DURATION",
        ],
        "allowlists": [],
        "policyStatus": "PENDING",
        "notes": "silero.VAD.load with bounded tuning values. Local ONNX model; not a network provider.",
    },
    {
        "id": "livekit-prompt-construction",
        "workloads": ["screening"],
        "provider": "deepseek",
        "runtime": "voice-livekit",
        "boundaryKind": "prompt_construction",
        "constructorPath": "app/voice-livekit/prompting.py",
        "envVars": ["COMPANY_NAME"],
        "allowlists": [],
        "policyStatus": "PROPOSED",
        "notes": (
            "system_prompt, opening_line, build_prompt_context, collect_prompt_metadata. Context is "
            "env-only or server-verified (SEC-13); client-visible room metadata is never used."
        ),
    },
    {
        "id": "livekit-provenance",
        "workloads": ["screening"],
        "provider": "deepseek",
        "runtime": "voice-livekit",
        "boundaryKind": "provenance",
        "constructorPath": "app/voice-livekit/provenance.py",
        "envVars": [],
        "allowlists": ["deepseek", "screening", "scoring"],
        "policyStatus": "PROPOSED",
        "notes": (
            "screening_provenance mirrors model-provenance.ts shape without cross-imports. Documented "
            "version constant parity with prompts.ts is enforced by a CI parity test."
        ),
    },
    {
        "id": "livekit-persistence-supabase",
        "workloads": ["screening"],
        "provider": "supabase",
        "runtime": "voice-livekit",
        "boundaryKind": "persistence",
        "constructorPath": "app/voice-livekit/persistence.py",
        "envVars": [
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SCHEMA",
            "WORKER_CONTEXT_SECRET",
            "WORKER_CONTEXT_TIMEOUT_SEC",
            "API_BASE",
            "SCORING_BREAKER_THRESHOLD",
            "SCORING_BREAKER_COOLDOWN_SEC",
            "SCORING_BREAKER_TIMEOUT_SEC",
            "SCORING_HTTP_CONNECT_TIMEOUT",
            "SCORING_HTTP_READ_TIMEOUT",
            "SCORING_HTTP_WRITE_TIMEOUT",
            "SCORING_HTTP_POOL_TIMEOUT",
            "LIVEKIT_WORKER_DRAIN_SEC",
        ],
        "allowlists": [],
        "policyStatus": "PENDING",
        "notes": (
            "Supabase client for session lifecycle plus first-party scoring-trigger and worker-context "
            "HTTP calls against the API (API_BASE). The scoring trigger is our own API, not a third-party "
            "provider. Breaker wrapping via provider_resilience.py."
        ),
    },
]

# ── Inventory verification ──────────────────────────────────────────────

_INVENTORY_CHECK = validate_provider_boundaries(PROVIDER_BOUNDARIES)
if not _INVENTORY_CHECK.get("valid"):
    raise ValueError(f"Provider boundary inventory failed validation: {_INVENTORY_CHECK.get('error')}")
