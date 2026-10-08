"""Content-package pin, isolation and style tests for the R1 content modules (PR-4b).

``CONTENT_SHA256`` pins every text the role-play speaks or prompts with.  Editing any of
it fails ``test_the_content_sha_is_pinned`` until a reviewer bumps ``CONTENT_REVISION`` and
the constant below.  The isolation tests keep these modules standalone: no LiveKit SDK, no
phone-lane code and no dependency on the worker-core modules (so they can land before, or
alongside, the session integration).
"""
from __future__ import annotations

import ast
import dataclasses
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
import r1_negotiation
import r1_personas
import r1_prompts
import r1_scheduler
import r1_script
import r1_world

# Revision 2: the icebreaker's interviewer note (the model may not start or announce the role-play).
# Revision 3 (R1-Q): no verbatim deflection, public backstory, speaking-style prefix, no
# "answer exactly" stall rule in the reminder, filler and fallback rotations.
# Revision 4 (R1-Q): disclosure layers (a hint per need, the deep need as facts plus stems) and
# their reminder lines.
# Revision 5 (R1-Q): intent-voiced moves (a brief, must-say figures, delivery markers and three
# scripted variants per owed move), Q-A and Q-B turned into curiosity topics, deadlines F2 450 and
# F1 570, scripted redirect openers, PLAN_VERSION 2.
# Revision 6 (R1-Q): the negotiation (stall reasons, the e-mail yes, the call question, the price
# counter by situation), the MEDIUM line's call slot, the WEAK line at most once with a reaction
# before the 13:00 stall, offer-on-the-table / check-in / commitment-on-record notes, and
# "pleasant surprise" only on a new offer (the prefix no longer primes it).
PINNED_CONTENT_SHA256 = "ef3939cde1d9535316e4c403f5473aa8b46b7c74c45504c6db5e70fc99ed8881"

CONTENT_MODULES = (
    "r1_text",
    "r1_script",
    "r1_world",
    "r1_personas",
    "r1_commitment",
    "r1_scheduler",
    "r1_negotiation",
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

    def test_the_manifest_covers_the_r1_q_disclosure_layers(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 4)
        for persona in r1_personas.PERSONAS:
            for need, entry in zip(persona.needs, manifest["personas"][persona.id]["needs"]):
                self.assertEqual(entry["hint"], need.hint)
                self.assertEqual(entry["facts"], list(need.facts))
                self.assertEqual(entry["stems"], list(need.stems))
        reminder = manifest["prompts"]["turn_reminder_sample"]
        sample = r1_personas.resolve_persona("p1_career_switcher", variant="v1")
        self.assertIn(sample.hint("H1"), reminder)  # the first-probe line
        self.assertIn(sample.facts("H2")[0], reminder)  # the deep line carries facts ...
        self.assertNotIn(sample.deep("H2"), reminder)  # ... never the full deep text

    def test_the_manifest_covers_the_r1_q_intent_voiced_moves(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 5)
        scheduler = manifest["scheduler"]
        self.assertEqual(scheduler["plan_version"], 2)
        moves = {item["id"]: item for item in scheduler["moves"]}
        self.assertNotIn("Q-A", moves)
        self.assertNotIn("Q-B", moves)
        for spec in r1_scheduler.PLAN:
            entry = moves[spec.id]
            self.assertEqual(entry["brief"], spec.brief)
            self.assertEqual(entry["must_say"], list(spec.must_say))
            self.assertEqual(entry["markers"], [list(group) for group in spec.markers])
            self.assertEqual(entry["variants"], list(spec.variants))
        self.assertEqual(scheduler["redirect_openers"], list(r1_scheduler.REDIRECT_OPENERS))
        self.assertEqual(scheduler["redirect_brief"], r1_scheduler.REDIRECT_BRIEF)
        self.assertEqual(
            scheduler["curiosity_topics"], [list(item) for item in r1_scheduler.CURIOSITY_TOPICS]
        )
        self.assertEqual(scheduler["constants"]["idle_gap_turns"], r1_scheduler.IDLE_GAP_TURNS)
        self.assertNotIn("q_a_opens_sec", scheduler["constants"])
        self.assertNotIn("oh_wait", scheduler)
        prompts = manifest["prompts"]
        brief = r1_scheduler.SPEC_BY_ID[r1_scheduler.F1_ANCHOR].brief
        self.assertIn(brief, prompts["intent_reminder_sample"])
        self.assertIn('"$9,000", "$7,000"', prompts["intent_reminder_sample"])
        self.assertIn("You are curious about", prompts["curiosity_reminder_sample"])
        self.assertNotIn("ack_reminder_sample", prompts)
        self.assertEqual(prompts["intent_price_note"], r1_prompts.INTENT_PRICE_NOTE)

    def test_editing_a_brief_a_marker_a_variant_or_a_figure_changes_the_sha(self):
        base = r1_content.content_sha256()
        original = r1_scheduler.PLAN
        spec = r1_scheduler.SPEC_BY_ID[r1_scheduler.F1_ANCHOR]
        index = original.index(spec)
        try:
            for change in (
                {"brief": spec.brief + " Really."},
                {"must_say": spec.must_say + ("six months",)},
                {"markers": spec.markers + ((r"\bfoo\b",),)},
                {"variants": spec.variants[:-1] + ("Is that possible?",)},
            ):
                edited = dataclasses.replace(spec, **change)
                r1_scheduler.PLAN = original[:index] + (edited,) + original[index + 1 :]
                self.assertNotEqual(r1_content.content_sha256(), base, change)
        finally:
            r1_scheduler.PLAN = original
        self.assertEqual(r1_content.content_sha256(), base)

    def test_editing_the_redirect_openers_the_curiosity_topics_or_the_notes_changes_the_sha(self):
        base = r1_content.content_sha256()
        for module, name, value in (
            (r1_scheduler, "REDIRECT_OPENERS", ("Hold on.",) * 3),
            (r1_scheduler, "REDIRECT_BRIEF", "x"),
            (r1_scheduler, "CURIOSITY_TOPICS", (("format", "x"),)),
            (r1_scheduler, "IDLE_GAP_TURNS", 4),
            (r1_prompts, "INTENT_PRICE_NOTE", "- Do not push on price."),
            (r1_prompts, "FORCED_NOTE", "- Link it."),
        ):
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        self.assertEqual(r1_content.content_sha256(), base)

    def test_the_manifest_covers_the_r1_q_negotiation(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 6)
        negotiation = manifest["negotiation"]
        specs = {item["id"]: item for item in negotiation["specs"]}
        self.assertEqual(set(specs), {spec.id for spec in r1_negotiation.SPECS})
        for spec in r1_negotiation.SPECS:
            entry = specs[spec.id]
            self.assertEqual(entry["brief"], spec.brief)
            self.assertEqual(entry["markers"], [list(group) for group in spec.markers])
            self.assertEqual(entry["variants"], list(spec.variants))
        counters = {item["id"]: item for item in negotiation["counters"]}
        self.assertEqual(set(counters), {item.id for item in r1_negotiation.COUNTERS})
        self.assertEqual(
            negotiation["commit_reaction_brief"], r1_negotiation.COMMIT_REACTION_BRIEF
        )
        self.assertEqual(negotiation["reasons"], list(r1_negotiation.REASONS))
        self.assertEqual(
            negotiation["constants"]["max_stall_rounds"], r1_negotiation.MAX_STALL_ROUNDS
        )
        commitment = manifest["commitment"]
        self.assertEqual(commitment["default_slot"], r1_commitment.DEFAULT_SLOT)
        self.assertEqual(commitment["moved_line"], r1_commitment.MEDIUM_MOVED_LINE)
        self.assertIn("{slot}", commitment["lines"]["MEDIUM"])
        prompts = manifest["prompts"]
        for key, value in (
            ("price_wrap_note", r1_prompts.PRICE_WRAP_NOTE),
            ("offer_on_table_note", r1_prompts.OFFER_ON_TABLE_NOTE),
            ("new_offer_note", r1_prompts.NEW_OFFER_NOTE),
            ("resolved_note", r1_prompts.RESOLVED_NOTE),
            ("checkin_note", r1_prompts.CHECKIN_NOTE),
            ("checkin_done_note", r1_prompts.CHECKIN_DONE_NOTE),
            ("email_again_note", r1_prompts.EMAIL_AGAIN_NOTE),
            ("reaction_only_note", r1_prompts.REACTION_ONLY_NOTE),
        ):
            self.assertEqual(prompts[key], value, key)
        self.assertIn('"$8,500"', prompts["negotiation_reminder_sample"])
        self.assertIn(r1_prompts.REACTION_ONLY_NOTE, prompts["reaction_only_sample"])
        self.assertNotIn("pleasant surprise", json.dumps(prompts["learner_prefixes"]))

    def test_editing_a_negotiation_text_a_marker_or_a_slot_constant_changes_the_sha(self):
        base = r1_content.content_sha256()
        original_specs = r1_negotiation.SPECS
        spec = original_specs[0]
        try:
            for change in (
                {"brief": spec.brief + " Really."},
                {"markers": spec.markers + ((r"foo",),)},
                {"variants": spec.variants[:-1] + ("Not today.",)},
            ):
                edited = dataclasses.replace(spec, **change)
                r1_negotiation.SPECS = (edited,) + original_specs[1:]
                self.assertNotEqual(r1_content.content_sha256(), base, change)
        finally:
            r1_negotiation.SPECS = original_specs
        original_counters = r1_negotiation.COUNTERS
        try:
            first = original_counters[0]
            r1_negotiation.COUNTERS = (
                dataclasses.replace(first, variants=first.variants + ("Maybe lower?",)),
            ) + original_counters[1:]
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_negotiation.COUNTERS = original_counters
        for module, name, value in (
            (r1_negotiation, "COMMIT_REACTION_BRIEF", "x"),
            (r1_negotiation, "MAX_STALL_ROUNDS", 3),
            (r1_negotiation, "PREFERRED_TIME", "8 PM"),
            (r1_commitment, "DEFAULT_SLOT", "on Friday at 7 PM"),
            (r1_commitment, "MEDIUM_MOVED_LINE", "Moved {slot} {decision_maker}."),
            (r1_prompts, "OFFER_ON_TABLE_NOTE", "- Offer {amount}."),
            (r1_prompts, "NEW_OFFER_NOTE", "- New {amount}."),
            (r1_prompts, "RESOLVED_NOTE", "- Done."),
            (r1_prompts, "CHECKIN_NOTE", "- Check."),
        ):
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        self.assertEqual(r1_content.content_sha256(), base)

    def test_editing_a_hint_a_fact_or_a_stem_changes_the_sha(self):
        base = r1_content.content_sha256()
        original = r1_personas.PERSONAS
        first = original[0]
        need = first.needs[0]
        try:
            for change in (
                {"hint": need.hint + " Really."},
                {"facts": need.facts + ("you are tired",)},
                {"stems": need.stems + ("same spot",)},
            ):
                edited = dataclasses.replace(need, **change)
                r1_personas.PERSONAS = (
                    dataclasses.replace(first, needs=(edited,) + first.needs[1:]),
                ) + original[1:]
                self.assertNotEqual(r1_content.content_sha256(), base, change)
        finally:
            r1_personas.PERSONAS = original
        self.assertEqual(r1_content.content_sha256(), base)

    def test_the_manifest_covers_the_r1_q_learner_voice_texts(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 3)
        self.assertEqual(manifest["learner_policy"], r1_world.LEARNER_POLICY)
        self.assertEqual(
            manifest["script"]["learner_filler_variants"], list(r1_script.LEARNER_FILLER_VARIANTS)
        )
        self.assertEqual(manifest["guard"]["fallback_replies"], list(r1_guard.FALLBACK_REPLIES))
        for persona in r1_personas.PERSONAS:
            self.assertEqual(
                manifest["personas"][persona.id]["backstory"], list(persona.backstory)
            )
            self.assertTrue(manifest["personas"][persona.id]["backstory"])
        self.assertNotIn("haven't thought about that", json.dumps(manifest))

    def test_editing_the_backstory_a_filler_or_the_policy_changes_the_sha(self):
        base = r1_content.content_sha256()
        original_personas = r1_personas.PERSONAS
        try:
            first = original_personas[0]
            r1_personas.PERSONAS = (
                dataclasses.replace(first, backstory=first.backstory + ("Extra.",)),
            ) + original_personas[1:]
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_personas.PERSONAS = original_personas
        original_policy = r1_world.LEARNER_POLICY
        original_fillers = r1_script.LEARNER_FILLER_VARIANTS
        original_replies = r1_guard.FALLBACK_REPLIES
        try:
            r1_world.LEARNER_POLICY = original_policy + " "
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_world.LEARNER_POLICY = original_policy
        try:
            r1_script.LEARNER_FILLER_VARIANTS = original_fillers[:-1] + ("Hmm.",)
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_script.LEARNER_FILLER_VARIANTS = original_fillers
        try:
            r1_guard.FALLBACK_REPLIES = original_replies[:-1] + ("Pardon?",)
            self.assertNotEqual(r1_content.content_sha256(), base)
        finally:
            r1_guard.FALLBACK_REPLIES = original_replies
        self.assertEqual(r1_content.content_sha256(), base)

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
