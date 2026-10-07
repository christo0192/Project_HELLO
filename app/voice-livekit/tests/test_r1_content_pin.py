"""Content-package pin, isolation and style tests for the R1 content modules (PR-4b).

``CONTENT_SHA256`` pins every text the role-play speaks or prompts with.  Editing any of
it fails ``test_the_content_sha_is_pinned`` until a reviewer bumps ``CONTENT_REVISION`` and
the constant below.  The isolation tests keep these modules standalone: no LiveKit SDK, no
phone-lane code and no dependency on the worker-core modules (so they can land before, or
alongside, the session integration).
"""
from __future__ import annotations

import ast
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_commitment
import r1_content
import r1_guard
import r1_personas
import r1_prompts
import r1_scheduler
import r1_script
import r1_world

PINNED_CONTENT_SHA256 = "ab7b22c2757137f9ef87c1843ce951689db0e9bf858900a9f43604ca39e96b90"

CONTENT_MODULES = (
    "r1_text",
    "r1_script",
    "r1_world",
    "r1_personas",
    "r1_commitment",
    "r1_scheduler",
    "r1_tracker",
    "r1_guard",
    "r1_prompts",
    "r1_content",
    "r1_roleplay",
)
# Worker-core modules (PR-4a) and the phone/browser worker: the content modules must not
# import any of them, and must not collide with their names.
FORBIDDEN_IMPORTS = {
    "livekit",
    "r1_session",
    "r1_context",
    "r1_lines",
    "r1_llm",
    "r1_persistence",
    "r1_phases",
    "r1_routing",
    "agent",
    "phone",
    "phone_canary",
    "closing",
    "persistence",
    "provenance",
    "prompting",
    "recording",
    "recording_api",
    "observability",
    "provider_resilience",
    "worker_ready_api",
    "noise_suppression",
    "httpx",
    "openai",
    "asyncio",
}
CORE_MODULE_NAMES = {
    "r1_context",
    "r1_lines",
    "r1_llm",
    "r1_persistence",
    "r1_phases",
    "r1_routing",
    "r1_session",
}


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


class PinTests(unittest.TestCase):
    def test_the_content_sha_is_pinned(self):
        self.assertEqual(
            r1_content.CONTENT_SHA256,
            PINNED_CONTENT_SHA256,
            "pinned R1 content changed: review it, bump CONTENT_REVISION and update the pin",
        )

    def test_sha_is_a_lowercase_hex_digest_that_the_database_accepts(self):
        # interview_round_attempts.content_sha ~ '^[a-f0-9]{64}$' (migration 0115).
        self.assertRegex(r1_content.CONTENT_SHA256, r"^[a-f0-9]{64}$")
        self.assertEqual(r1_content.content_sha256(), r1_content.CONTENT_SHA256)

    def test_version_embeds_the_revision_and_sha_prefix(self):
        self.assertEqual(
            r1_content.CONTENT_VERSION,
            f"r1-content-v{r1_content.CONTENT_REVISION}+{r1_content.CONTENT_SHA256[:12]}",
        )

    def test_the_manifest_is_json_and_covers_every_pinned_text(self):
        manifest = r1_content.manifest()
        json.dumps(manifest)
        self.assertEqual(manifest["world"]["sha256"], r1_world.WORLD_SHA256)
        self.assertEqual(set(manifest["personas"]), set(r1_personas.PERSONA_IDS))
        self.assertEqual(len(manifest["prompts"]["learner_prefixes"]), 12)
        self.assertEqual(
            {m["id"] for m in manifest["scheduler"]["moves"]},
            {spec.id for spec in r1_scheduler.PLAN},
        )
        self.assertEqual(set(manifest["commitment"]["lines"]), {"STRONG", "MEDIUM", "WEAK"})
        self.assertIn("interviewer_prefix", manifest["prompts"])

    def test_changing_any_pinned_text_changes_the_sha(self):
        base = r1_content.content_sha256()
        original_plan = r1_scheduler.PLAN
        try:
            first = original_plan[0]
            changed = r1_scheduler.MoveSpec(
                first.id, first.family, first.role, first.line + " ", first.deadline_sec,
                first.required,
            )
            r1_scheduler.PLAN = (changed,) + original_plan[1:]
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_scheduler.PLAN = original_plan
        original_line = r1_commitment.COMMITMENT_LINES[r1_commitment.Level.WEAK]
        try:
            r1_commitment.COMMITMENT_LINES[r1_commitment.Level.WEAK] = original_line + "!"
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_commitment.COMMITMENT_LINES[r1_commitment.Level.WEAK] = original_line
        original_fallback = r1_guard.FALLBACK_REPLY
        try:
            r1_guard.FALLBACK_REPLY = original_fallback + "?"
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_guard.FALLBACK_REPLY = original_fallback
        self.assertEqual(r1_content.content_sha256(), base)

    def test_prompts_are_deterministic_across_calls(self):
        self.assertEqual(r1_prompts.interviewer_prefix(), r1_prompts.interviewer_prefix())
        self.assertEqual(r1_content.content_sha256(), r1_content.content_sha256())


class IsolationTests(unittest.TestCase):
    def test_modules_import_nothing_from_the_sdk_phone_lane_or_worker_core(self):
        for name in CONTENT_MODULES:
            imports = _imports(HERE / f"{name}.py")
            with self.subTest(module=name):
                self.assertEqual(imports & FORBIDDEN_IMPORTS, set())

    def test_modules_import_each_other_without_a_cycle(self):
        order = list(CONTENT_MODULES)
        for name in CONTENT_MODULES:
            earlier = {m for m in _imports(HERE / f"{name}.py") if m in CONTENT_MODULES}
            with self.subTest(module=name):
                self.assertNotIn(name, earlier)
        # r1_text and r1_script are leaves; r1_roleplay depends on everything else.
        self.assertEqual(
            {m for m in _imports(HERE / "r1_text.py") if m in order}, set()
        )
        self.assertEqual(
            {m for m in _imports(HERE / "r1_script.py") if m in order}, set()
        )
        self.assertEqual(
            {m for m in _imports(HERE / "r1_world.py") if m in order}, {"r1_text", "r1_script"}
        )
        for name in CONTENT_MODULES[:-1]:
            self.assertNotIn("r1_roleplay", _imports(HERE / f"{name}.py"))

    def test_no_module_name_collides_with_the_worker_core(self):
        self.assertEqual(set(CONTENT_MODULES) & CORE_MODULE_NAMES, set())

    def test_the_content_modules_do_not_touch_the_phone_lane_files(self):
        for name in CONTENT_MODULES:
            source = (HERE / f"{name}.py").read_text(encoding="utf-8")
            for forbidden in (
                "phone_runtime",
                "phone_canary",
                "fly.phone",
                "PHONE_AGENT_NAME",
                "_build_provider_session",
            ):
                with self.subTest(module=name, token=forbidden):
                    self.assertNotIn(forbidden, source)


class StyleTests(unittest.TestCase):
    def test_no_line_exceeds_one_hundred_columns(self):
        too_long = []
        for name in CONTENT_MODULES:
            path = HERE / f"{name}.py"
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if len(line) > 100:
                    too_long.append(f"{name}.py:{number}")
        self.assertEqual(too_long, [])

    def test_modules_are_plain_ascii(self):
        """Non-ASCII text is written as escapes, so no tool or codec can mangle a line."""
        offenders = []
        for name in CONTENT_MODULES:
            text = (HERE / f"{name}.py").read_text(encoding="utf-8")
            if any(ord(char) > 127 for char in text):
                offenders.append(name)
        self.assertEqual(offenders, [])

    def test_one_statement_per_line(self):
        crowded = []
        for name in CONTENT_MODULES:
            tree = ast.parse((HERE / f"{name}.py").read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                for field in ("body", "orelse", "finalbody"):
                    statements = getattr(node, field, None)
                    if not isinstance(statements, list):
                        continue
                    for previous, current in zip(statements, statements[1:]):
                        if current.lineno <= previous.end_lineno:
                            crowded.append(f"{name}.py:{current.lineno}")
        self.assertEqual(crowded, [])

    def test_every_module_has_a_docstring_stating_its_invariants(self):
        for name in CONTENT_MODULES:
            tree = ast.parse((HERE / f"{name}.py").read_text(encoding="utf-8"))
            with self.subTest(module=name):
                self.assertGreater(len(ast.get_docstring(tree) or ""), 80)


class WorkerCoreDriftTests(unittest.TestCase):
    """Active once PR-4a's ``r1_lines`` is present: shared lines must not drift."""

    @classmethod
    def setUpClass(cls):
        try:
            import r1_lines  # type: ignore[import-not-found]
        except ImportError:
            raise unittest.SkipTest("r1_lines (PR-4a) is not on this branch")
        cls.lines = r1_lines

    def test_shared_scripted_lines_are_identical(self):
        theirs = self.lines.LINES
        # L-PICKUP is a persona template here; the provisional table hard-codes "Meera".
        for line_id, text in theirs.items():
            if line_id == "L-PICKUP":
                continue
            with self.subTest(line=line_id):
                self.assertEqual(r1_script.LINES[line_id], text)
        self.assertEqual(self.lines.INTERVIEWER_NAME, r1_script.INTERVIEWER_NAME)
        self.assertEqual(theirs["L-TIME-CUE"], r1_scheduler.TIME_CUE_LINE)
        self.assertEqual(theirs["L-FAQ-DEFER"], r1_world.INTERVIEWER_DEFLECTION)
        self.assertEqual(theirs["L-NO-FEEDBACK"], r1_guard.NO_FEEDBACK_LINE)
        self.assertTrue(theirs["L-EXIT"].startswith(r1_guard.EXIT_CUE))

    def test_rendering_matches_the_provisional_helper(self):
        for first_name in ("Arjun", "Mary-Ann", "A" * 30, "", None):
            self.assertEqual(
                self.lines.safe_first_name(first_name), r1_script.safe_first_name(first_name)
            )
        for line_id in ("L-OPEN", "L-CLOSE", "L-SIL-IB", "L-REJOIN", "L-SYSTEM-STOP"):
            self.assertEqual(
                self.lines.line(line_id, first_name="Arjun"),
                r1_script.line(line_id, first_name="Arjun"),
            )


if __name__ == "__main__":
    unittest.main()
