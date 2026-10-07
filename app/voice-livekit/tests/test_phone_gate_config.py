"""M013 S01 T12: gate-judge config, env contract and browser isolation.

* fly.phone.toml ships the owner's rollout decision (`PHONE_GATE_JUDGE=llm`,
  2026-10-06: the judge decides, the regex only when the judge is
  unavailable), the owner's DeepSeek V4 Flash id, the measured timeouts, and
  no longer pins the consent backstop below its derived floor; the code
  default (env unset) stays legacy;
* the browser app (fly.toml) gets none of it;
* every gate variable is declared in config/environment.schema.json and in
  .env.example (`scripts/check-env-contract.mjs` enforces the general rule;
  this pins the S01 block so a rebase cannot drop it silently);
* the browser worker never constructs the judge. `app/voice-livekit` is shared
  source and a merge deploys both voice apps, so this is checked on the call
  graph of agent.py: nothing reachable from the browser session body
  (`_run_session`) builds the judge wiring or reaches a judge network call,
  and the phone path does (so the walk is not vacuous).

Pure source/config checks: no SDK needed, runs in bare python like CI.
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

_WORKER = Path(__file__).resolve().parents[1]
_REPO = _WORKER.parents[1]
sys.path.insert(0, str(_WORKER))

import gate_judge  # noqa: E402
import phone  # noqa: E402

_S01_VARS = {
    "PHONE_GATE_JUDGE": "legacy",
    "PHONE_GATE_JUDGE_MODEL": "deepseek-v4-flash",
    "PHONE_GATE_JUDGE_TIMEOUT_SEC": "1.7",
    "PHONE_QNA_JUDGE_TIMEOUT_SEC": "1.6",
    "PHONE_GATE_GRANT_MIN_SPEECH_MS": "250",
    "PHONE_GATE_COMPOSE_TIMEOUT_SEC": "1.5",
    "PHONE_Q1_PRERENDER": "true",
}


def _toml(name: str) -> dict:
    return tomllib.loads((_WORKER / name).read_text(encoding="utf-8")).get("env", {})


def _example() -> dict[str, str]:
    values = {}
    for line in (_WORKER / ".env.example").read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip()
    return values


class TestPhoneAppConfig(unittest.TestCase):
    def setUp(self):
        self.env = _toml("fly.phone.toml")

    def test_rollout_mode_is_the_owner_decision(self):
        # Owner decision 2026-10-06: the LLM judge decides (T11's 16/17 vs
        # 17/17 recall trade-off accepted for 0 real false grants vs 2).
        self.assertEqual(self.env.get("PHONE_GATE_JUDGE"), "llm")
        self.assertEqual(self.env["PHONE_GATE_JUDGE"], gate_judge.GATE_JUDGE_MODE_LLM)
        self.assertIn(self.env["PHONE_GATE_JUDGE"], gate_judge.GATE_JUDGE_MODES)

    def test_toml_comment_names_the_legacy_rollback(self):
        text = (_WORKER / "fly.phone.toml").read_text(encoding="utf-8")
        self.assertIn("fly secrets set PHONE_GATE_JUDGE=legacy", text)

    def test_owner_model_and_endpoint(self):
        self.assertEqual(self.env.get("PHONE_GATE_JUDGE_MODEL"), "deepseek-v4-flash")
        self.assertEqual(gate_judge.GATE_JUDGE_DEFAULT_MODEL, "deepseek-v4-flash")
        # The judge rides the phone judge's DeepSeek endpoint; anything else
        # disables it (legacy decides).
        self.assertEqual(self.env.get("PHONE_JUDGE_SDK"), "openai")
        self.assertTrue(self.env.get("PHONE_JUDGE_URL", "").startswith("https://api.deepseek.com/"))

    def test_shipped_values_resolve_as_written(self):
        keys = ("PHONE_GATE_JUDGE", "PHONE_GATE_JUDGE_MODEL",
                "PHONE_GATE_JUDGE_TIMEOUT_SEC", "PHONE_QNA_JUDGE_TIMEOUT_SEC",
                "PHONE_CLASSIFY_ANSWER_TIMEOUT_SEC")
        env = {k: self.env[k] for k in keys if k in self.env}
        with patch.dict(os.environ, env, clear=False):
            for k in ("PHONE_CLASSIFY_TIMEOUT_SEC", "PHONE_GATE_GRANT_MIN_SPEECH_MS",
                      "PHONE_GATE_COMPOSE_TIMEOUT_SEC", "PHONE_Q1_PRERENDER"):
                os.environ.pop(k, None)
            self.assertEqual(gate_judge.judge_mode(), "llm")
            self.assertEqual(gate_judge.judge_model(), "deepseek-v4-flash")
            self.assertEqual(gate_judge.judge_timeout_sec(), 1.7)
            self.assertEqual(gate_judge.qna_judge_timeout_sec(), 1.6)
            # The toml's timeouts equal the code defaults (T11 measured).
            self.assertEqual(gate_judge.judge_timeout_sec(),
                             gate_judge.GATE_JUDGE_TIMEOUT_DEFAULT_SEC)
            self.assertEqual(gate_judge.qna_judge_timeout_sec(),
                             gate_judge.QNA_JUDGE_TIMEOUT_DEFAULT_SEC)
            # The consent backstop is the derived llm-mode floor
            # (3 x (15 + 2 x 6 + 3 x 1.7 + 2 x 6) + 5).
            self.assertAlmostEqual(phone.phone_classify_timeout_sec(), 137.3)
            self.assertAlmostEqual(phone.phone_classify_timeout_sec(),
                                   phone.phone_classify_backstop_floor_sec())

    def test_the_old_backstop_pin_is_gone(self):
        # T02 made an explicit value a raise-only ceiling; the "40" left in the
        # toml could only mislead a reader about the live backstop.
        self.assertNotIn("PHONE_CLASSIFY_TIMEOUT_SEC", self.env)


class TestBrowserAppConfig(unittest.TestCase):
    def test_the_browser_app_sets_no_gate_variable(self):
        env = _toml("fly.toml")
        leaked = sorted(k for k in env if k in _S01_VARS or k.startswith("PHONE_GATE_"))
        self.assertEqual(leaked, [])


class TestEnvContract(unittest.TestCase):
    def test_schema_declares_the_s01_block(self):
        schema = json.loads((_REPO / "config" / "environment.schema.json").read_text(
            encoding="utf-8"))
        variables = schema["components"]["voice-livekit"]["variables"]
        for name in _S01_VARS:
            with self.subTest(name=name):
                self.assertIn(name, variables)
                self.assertFalse(variables[name].get("secret", True))
                self.assertFalse(variables[name].get("requiredInProduction", True))

    def test_example_carries_the_code_defaults(self):
        example = _example()
        for name, default in _S01_VARS.items():
            with self.subTest(name=name):
                self.assertEqual(example.get(name), default)

    def test_example_defaults_resolve_to_the_code_defaults(self):
        example = _example()
        with patch.dict(os.environ, {k: example[k] for k in _S01_VARS}, clear=False):
            self.assertEqual(gate_judge.judge_mode(), gate_judge.GATE_JUDGE_MODE_LEGACY)
            self.assertEqual(gate_judge.judge_timeout_sec(),
                             gate_judge.GATE_JUDGE_TIMEOUT_DEFAULT_SEC)
            self.assertEqual(gate_judge.qna_judge_timeout_sec(),
                             gate_judge.QNA_JUDGE_TIMEOUT_DEFAULT_SEC)
            self.assertEqual(gate_judge.grant_min_speech_ms(),
                             gate_judge.GRANT_MIN_SPEECH_DEFAULT_MS)
            self.assertEqual(phone.phone_gate_compose_timeout_sec(), 1.5)
            self.assertTrue(phone.phone_q1_prerender_enabled())

    def test_unset_mode_is_legacy(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_GATE_JUDGE", None)
            self.assertEqual(gate_judge.judge_mode(), gate_judge.GATE_JUDGE_MODE_LEGACY)


# ── the runbook's "logs to watch" fields are really emitted ──────────────────

#: The S01 log types docs/runbooks/phone-safe-dialer.md §2x tells operators to
#: watch during the 48 h window.
_WATCHED_LOG_TYPES = frozenset({
    "phone_gate_decision", "phone_gate_shadow_decision", "phone_gate_shadow",
    "gate_judge_fallback_legacy", "gate_judge_disabled", "phone_gate_compose",
    "phone_gate_budget", "phone_gate_heartbeat", "phone_gate_turn_barrier",
    "phone_gate_quiescence", "phone_gate_final", "phone_callback_judge",
    "phone_callback_turn", "phone_qna_close", "phone_silence",
    "phone_q1_prefetch",
})


def _log_calls(path: Path):
    """``(lineno, error_type, keyword names)`` for each structured-log call
    (``_log.info/warn/...``, gate_judge's ``_emit`` or ``self._log``) with a literal
    ``error_type``."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_log = (isinstance(func, ast.Attribute)
                  and func.attr in ("info", "warn", "warning", "error", "debug")
                  and isinstance(func.value, ast.Name) and func.value.id == "_log")
        is_emit = isinstance(func, ast.Name) and func.id == "_emit"
        # gate_judge's turn tracker logs through its own `self._log(...)`.
        is_self_log = isinstance(func, ast.Attribute) and func.attr == "_log"
        if not (is_log or is_emit or is_self_log):
            continue
        kinds = {k.arg: k.value for k in node.keywords if k.arg}
        et = kinds.get("error_type")
        if isinstance(et, ast.Constant) and isinstance(et.value, str):
            yield node.lineno, et.value, set(kinds) - {"log"}


class TestWatchedLogFieldsAreAllowlisted(unittest.TestCase):
    """The structured logger silently DROPS any key outside its allowlist, so
    a field the runbook names (or a call site passes) that is not allowlisted
    never reaches Fly logs. Round-1 found `phone_qna_close` `source=` and the
    compose / Q1-prefetch `duration_ms=` vanishing this way."""

    def test_every_watched_log_call_uses_only_allowlisted_keys(self):
        import observability

        allowed = set(observability._ALLOWED_META_KEYS) | {"error_type"}
        seen: set[str] = set()
        bad = []
        # Round-2 review: phone.py emits phone_gate_budget, phone_callback_judge,
        # phone_callback_turn and the gate-side phone_gate_compose.
        for name in ("agent.py", "gate_judge.py", "phone.py"):
            for lineno, et, keys in _log_calls(_WORKER / name):
                if et not in _WATCHED_LOG_TYPES:
                    continue
                seen.add(et)
                extra = sorted(keys - allowed)
                if extra:
                    bad.append((name, lineno, et, extra))
        self.assertEqual(bad, [])
        # Not vacuous: most watched types are found as literal call sites
        # (the rest are emitted through helpers with a computed error_type).
        self.assertTrue({"phone_gate_compose", "phone_qna_close", "phone_q1_prefetch",
                         "phone_gate_final", "phone_gate_turn_barrier", "phone_gate_budget",
                         "phone_callback_judge", "phone_callback_turn"} <= seen, seen)

    def test_the_runbook_names_the_real_decision_keys(self):
        text = (_REPO / "docs" / "runbooks" / "phone-safe-dialer.md").read_text(
            encoding="utf-8")
        section = text.split("### 2x.", 1)[1].split("### 2y.", 1)[0]
        for key in ("error_category", "duration_sec", "rejection_reason", "schema",
                    "turn_index", "option_count", "phase", "model"):
            with self.subTest(key=key):
                self.assertIn(f"`{key}`", section)
        # The internal names a Fly query would find nothing under are only
        # mentioned as "not these".
        self.assertIn("Query `rejection_reason`, not `guard_rejected_reason`", section)


# ── browser isolation on the agent.py call graph ─────────────────────────────

#: Building any of these is constructing the judge.
_JUDGE_CLASSES = frozenset({"_GateJudgeWiring", "_RevocationWindow", "_QnaCloseWindow"})
#: The only ways to reach the judge endpoint.
_JUDGE_NETWORK = frozenset({"judge_gate", "call_judge", "resolve_judge_config", "_post_judge"})


def _agent_defs() -> dict[str, ast.AST]:
    src = (_WORKER / "agent.py").read_text(encoding="utf-8")
    return {
        node.name: node for node in ast.parse(src).body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }


def _judge_hits(roots: tuple[str, ...]) -> list[tuple[str, str]]:
    """``(path, what)`` for every judge class or judge network call reachable
    from ``roots`` through module-level names of agent.py."""
    defs = _agent_defs()
    seen: set[str] = set()
    path: dict[str, str] = {r: r for r in roots}
    stack = list(roots)
    hits: list[tuple[str, str]] = []
    while stack:
        name = stack.pop()
        if name in seen or name not in defs:
            continue
        seen.add(name)
        for sub in ast.walk(defs[name]):
            if isinstance(sub, ast.Name):
                if sub.id in _JUDGE_CLASSES:
                    hits.append((path[name], sub.id))
                if sub.id in defs and sub.id not in seen:
                    path.setdefault(sub.id, f"{path[name]} -> {sub.id}")
                    stack.append(sub.id)
            elif (isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name)
                  and sub.value.id == "gate_judge" and sub.attr in _JUDGE_NETWORK):
                hits.append((path[name], f"gate_judge.{sub.attr}"))
    return hits


class TestBrowserWorkerNeverConstructsTheJudge(unittest.TestCase):
    def test_nothing_reachable_from_the_browser_session_builds_the_judge(self):
        self.assertEqual(_judge_hits(("_run_session",)), [])

    def test_the_phone_session_does_reach_it(self):
        # Positive control: the same walk finds the judge on the phone path.
        found = {what for _path, what in _judge_hits(("_run_phone_entrypoint",))}
        self.assertTrue(_JUDGE_CLASSES <= found, found)
        self.assertIn("gate_judge.judge_gate", found)

    def test_entrypoint_takes_the_phone_path_only_for_the_named_phone_worker(self):
        entry = _agent_defs()["entrypoint"]
        guarded = False
        for node in ast.walk(entry):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if (isinstance(test, ast.Call) and isinstance(test.func, ast.Name)
                    and test.func.id == "_phone_agent_name"):
                calls = {n.func.id for n in ast.walk(node)
                         if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
                guarded = "_run_phone_entrypoint" in calls
        self.assertTrue(guarded, "_run_phone_entrypoint must sit under `if _phone_agent_name():`")
        # And nowhere else in the entrypoint.
        calls = [n for n in ast.walk(entry) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == "_run_phone_entrypoint"]
        self.assertEqual(len(calls), 1)
        # The browser body is what runs otherwise.
        self.assertIn("_run_session", {
            n.func.id for n in ast.walk(entry)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)})

    def test_phone_py_never_calls_the_judge_endpoint(self):
        # The browser lane imports phone.py helpers; the endpoint is reached
        # only through agent.py's phone-only wiring.
        tree = ast.parse((_WORKER / "phone.py").read_text(encoding="utf-8"))
        direct = sorted({
            n.attr for n in ast.walk(tree)
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
            and n.value.id == "gate_judge" and n.attr in _JUDGE_NETWORK
        })
        self.assertEqual(direct, [])

    def test_importing_gate_judge_calls_nothing(self):
        # Module top level defines; it never calls the judge or reads its key.
        tree = ast.parse((_WORKER / "gate_judge.py").read_text(encoding="utf-8"))
        top_calls = {
            n.func.id for stmt in tree.body
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            for n in ast.walk(stmt)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        self.assertFalse(top_calls & (_JUDGE_NETWORK | {"_default_transport", "_gate_breaker"}),
                         top_calls)


if __name__ == "__main__":
    unittest.main()
