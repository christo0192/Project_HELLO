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
import r1_end_intent
import r1_guard
import r1_negotiation
import r1_personas
import r1_prompts
import r1_scheduler
import r1_script
import r1_text
import r1_tracker
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
# Revision 7 (R1-Q round 1 review fixes): the reaction notes say "how it lands for you" and never a
# course detail (the old wording invited guard-blocked product statements), the F1 anchor reacts to a
# price already on the table (three variants per case), the one-word filler fallback, and the
# next-step / e-mail-yield notes.
# Revision 8 (R1-Q round 2 review fixes): the reached anchor (a price at or below $7,000 already on
# the table) asks what the price includes instead of "is that the final price?" (the counter owns
# that question) and names the amount in every variant; the manifest samples the below-$7,000 case.
# Revision 9 (merge of origin/main, R1-Q PR-B #369): PR-B's own revision 3 text changes join the
# learner branch's 3..8: L-NO-FEEDBACK is one short refusal that does not name the hiring team
# (L-CLOSE is the one mention of who reviews the interview), and the wrap-up reply note
# (r1_prompts.WRAPUP_REMINDER) forbids a goodbye.  CONTENT_REVISION = max(8, 3) + 1.
# Revision 10 (R1-Q learner iteration 1, owner decisions of 2026-10-08): no scripted or prompted
# "hmm"/"honestly" (prefix, hints, fillers, the rotating opening-style notes, the guard's style rules),
# a warm confirmation once a call is booked (CONFIRM_NOTE, CONFIRM_FALLBACKS), the decision maker on
# the public card and in DECIDER_ASKED_NOTE, the $7,000 anchor is never an offer
# (ANCHOR_NOT_OFFERED_NOTE, ANCHOR_REPLACEMENT), "I can check with my manager" grants nothing
# (TRY_NOT_GRANTED_NOTE, GRATITUDE_REPLACEMENT) and the time cue is the learner's own next call.
# Revision 11 (R1-Q learner iteration 2, the second live sweep): a question only now and then
# (prefix, one question per reply and a question diet in the guard), "a stretch" and the "what would
# that call involve" template once per call (PHRASE_QUOTA, STRETCH_ALTERNATIVES, STRETCH_USED_NOTE,
# TEMPLATE_USED_NOTE), price notes that know where the price stands (OFFER_MET_NOTE, PRICE_MET_NOTE,
# PRICE_UNCHANGED_NOTE), figures listed without quote marks, the anchor told to the advisor
# (ANCHOR_HEARD_REPLACEMENT, ANCHOR_HEARD_BELOW), a calm reached anchor, a deferred MEDIUM line and
# a call-back WEAK line (MEDIUM_DEFER_LINE, WEAK_CALL_LINE), the F4 push call suffix, hold and
# answered-facts notes (HOLD_NOTE, ANSWERED_NOTE) and wider F3 / F4 delivery markers.
# Revision 12 (R1-Q learner iteration 3, the third live sweep): the MEDIUM line books only a slot the
# learner can stand behind (SLOT_RECENT_TURNS; stale, refused and absent slots lead to the deferred
# line), an e-mailed WEAK line (WEAK_EMAIL_DONE_LINE), a thin or pressing advisor caps the grade at
# WEAK (THIN_ADVISOR_MEAN_WORDS, THIN_MIN_TURNS), the e-mail "yes" spec for an offer that listed its
# contents, an anchor below $7,000 reads "even below the $7,000", the unchanged-price replacement
# (PRICE_UNCHANGED_REPLACEMENT), three "thinking" fallbacks (FALLBACK_REPLIES), the once-per-call
# concession tag (PHRASE_QUOTA), the hollow-advisor note (HOLLOW_NOTE, HOLLOW_MAX_WORDS), the H3
# first-probe reminder (answer only the part that was asked) and three wordings of the time cue
# (TIME_CUE_BRIEF_ALTERNATIVES).
# Revision 13 (R1-Q final review round 1): a repeated "That's" is swapped for "It's" (prefix and a
# rotating style note ask for varied openers), one decider only (the prefix: nobody else has a say,
# the decision is never the learner's alone), a quota and a spacing window for the decider stall, the
# "get back to you" closer and the "still more than I planned for" line (PHRASE_QUOTA, PHRASE_WINDOW),
# the STRONG line names no plan, persona-neutral scripted time cues (and wrap-up markers), a deep layer
# given back when its reply missed it (MAX_DEEP_MISSES) and a wait window for STRONG
# (WAIT_RECENT_TURNS).
# Revision 14 (R1-Q ship restore, owner decision 2026-10-09: ship only what is proven better than
# production): the guard rules that were worse than production are deleted, and with them their two
# canned lines and the manifest keys that pinned them (ANCHOR_HEARD_REPLACEMENT, ANCHOR_HEARD_BELOW,
# PRICE_UNCHANGED_REPLACEMENT).  No other pinned text changed.
# Revision 15 (the 20-minute role-play, owner decision 2026-10-16): L-TRANSITION announces the
# twenty minutes and the goal (convince the learner), L-OPEN says about thirty minutes and a
# twenty-minute role-play, and the owed-move deadlines stretch to the longer call (F3 430, F2 640,
# F1 810, F4 930).
# Revision 16 (owner test 7f2a25e6 keyword misfires): the one question about the next step is worded
# by the advisor's ask (N_QUESTION_ENROL_BRIEF / N_QUESTION_ENROL_VARIANTS after an enrolment ask,
# "the call" only after a call ask) and its markers also accept "include", "signing up" and "would I
# get"; a challenge to the learner's own words or questions is answered plainly first
# (CHALLENGE_NOTE); an out-of-role "end the call" request gets the interviewer's one-off question
# (L-ASIDE-END: say "end the interview" to stop, otherwise carry on) and, on end words, a short
# close (L-END-CLOSE).  Voice barge-in (owner decision 2026-10-28): after the advisor cut the learner
# off, the owed move waits one turn and what they said is answered first (INTERRUPTED_NOTE), and a
# lone backchannel that cut her gets her point finished in one sentence (BACKCHANNEL_CUT_NOTE), and
# one that only asked her to say it again ("Sorry?", "Pardon?") or checked she was there gets it
# said again (CUT_REPEAT_NOTE; reviewed fix, same unreleased revision).
# Revision 17 (owner test 1eb18cd4, owner decision 2026-10-29): a confirmed out-of-role stop ends
# the role-play into L-EXIT and the interviewer's wrap-up instead of the whole session, so the short
# close L-END-CLOSE is deleted.  L-ASIDE-END and every other pinned text are unchanged.
# Revision 18 (owner decision 2026-10-30, meaning-based end detection): the end-intent classifier's
# system prompt and its two context lines (r1_end_intent END_INTENT_SYSTEM, ROLEPLAY_CONTEXT,
# AFTER_ASIDE_CONTEXT), its prefilter window and its labels join the manifest (``end_intent``).  No
# spoken line changed: the brief repeat replays L-TRANSITION, a brief request after the pickup
# plays L-ASIDE-COACH.  Reviewed fix, same unreleased revision: the prompt's "no" also covers the
# learner's OWN job interviews, and its tie-break names THIS interview or this role-play.
# Revision 19 (owner test 8f5bfefc): the F1 anchor for a figure under $7,000 that was not read as a
# price (anchor_after_unclear_low) reacts to that number and asks what the total would be, never for
# more.  No other pinned text changed.
PINNED_CONTENT_SHA256 = "0a39519fe5d0b99d3e5a62dc7374909e8f1d1c397a46504f671304569689ad53"

CONTENT_MODULES = (
    "r1_text",
    "r1_script",
    "r1_world",
    "r1_personas",
    "r1_commitment",
    "r1_scheduler",
    "r1_negotiation",
    "r1_tracker",
    "r1_end_intent",
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
        self.assertEqual(manifest["prompts"]["wrapup_reminder"], r1_prompts.WRAPUP_REMINDER)
        self.assertEqual(manifest["guard"]["no_feedback"], r1_script.LINES["L-NO-FEEDBACK"])

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
        self.assertIn("without quote marks: $9,000, $7,000.", prompts["intent_reminder_sample"])
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

    def test_the_end_intent_prompt_is_pinned_from_revision_18(self):
        # Owner decision 2026-10-30: the classifier's prompt is content the model reads.
        self.assertGreaterEqual(r1_content.CONTENT_REVISION, 18)
        pinned = r1_content.manifest()["end_intent"]
        self.assertEqual(pinned["system"], r1_end_intent.END_INTENT_SYSTEM)
        self.assertEqual(pinned["labels"], ["no", "maybe", "end"])
        self.assertEqual(pinned["window_words"], r1_end_intent.END_INTENT_WINDOW_WORDS)
        base = r1_content.content_sha256()
        for name, value in (
            ("END_INTENT_SYSTEM", r1_end_intent.END_INTENT_SYSTEM + " "),
            ("ROLEPLAY_CONTEXT", "x"),
            ("AFTER_ASIDE_CONTEXT", "x"),
            ("END_INTENT_WINDOW_WORDS", 15),
        ):
            original = getattr(r1_end_intent, name)
            try:
                setattr(r1_end_intent, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(r1_end_intent, name, original)
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

    def test_the_manifest_covers_the_round_1_review_fixes(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 7)
        self.assertEqual(manifest["script"]["learner_filler_short"], r1_script.LEARNER_FILLER_SHORT)
        anchors = {item["id"]: item for item in manifest["negotiation"]["anchor_after_offer"]}
        # Revision 19 (owner test 8f5bfefc): "unclear", a figure under $7,000 not read as a price.
        self.assertEqual(set(anchors), {"above", "reached", "unclear"})
        for item in anchors.values():
            self.assertEqual(len(item["variants"]), 3)
            self.assertIn("$7,000", item["must_say"])
        prompts = manifest["prompts"]
        self.assertEqual(prompts["react_how_it_lands"], r1_prompts.REACT_HOW_IT_LANDS)
        self.assertEqual(prompts["next_step_proposed_note"], r1_prompts.NEXT_STEP_PROPOSED_NOTE)
        self.assertEqual(prompts["email_offer_note"], r1_prompts.EMAIL_OFFER_NOTE)
        self.assertIn("how their last point lands for you", prompts["checkin_note"])
        self.assertNotIn("something you liked", json.dumps(manifest))

    def test_the_manifest_covers_the_iteration_one_texts(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 10)
        prompts = manifest["prompts"]
        self.assertEqual(prompts["style_notes"], list(r1_prompts.STYLE_NOTES))
        self.assertEqual(prompts["confirm_note"], r1_prompts.CONFIRM_NOTE)
        self.assertEqual(prompts["anchor_not_offered_note"], r1_prompts.ANCHOR_NOT_OFFERED_NOTE)
        self.assertEqual(prompts["try_not_granted_note"], r1_prompts.TRY_NOT_GRANTED_NOTE)
        self.assertIn("I'd talk it over with my husband first.", prompts["decider_asked_note"])
        self.assertIn(r1_prompts.CONFIRM_NOTE, prompts["confirm_reminder_sample"])
        self.assertIn(r1_prompts.STYLE_NOTES[1], prompts["style_reminder_sample"])
        guard = manifest["guard"]
        self.assertEqual(guard["confirm_fallbacks"], list(r1_guard.CONFIRM_FALLBACKS))
        self.assertEqual(guard["anchor_replacement"], r1_guard.ANCHOR_REPLACEMENT)
        self.assertEqual(guard["gratitude_replacement"], r1_guard.GRATITUDE_REPLACEMENT)
        self.assertEqual(guard["style"]["tic_window"], r1_guard.STYLE_TIC_WINDOW)
        for text in prompts["learner_prefixes"].values():
            self.assertIn("who else is involved in your decision", text)

    def test_editing_an_iteration_one_text_or_style_constant_changes_the_sha(self):
        base = r1_content.content_sha256()
        edits = (
            (r1_prompts, "CONFIRM_NOTE", r1_prompts.CONFIRM_NOTE + " "),
            (r1_prompts, "ANCHOR_NOT_OFFERED_NOTE", r1_prompts.ANCHOR_NOT_OFFERED_NOTE + " "),
            (r1_prompts, "TRY_NOT_GRANTED_NOTE", r1_prompts.TRY_NOT_GRANTED_NOTE + " "),
            (r1_prompts, "STYLE_NOTES", r1_prompts.STYLE_NOTES[:-1] + ("- Plain.",)),
            (r1_guard, "ANCHOR_REPLACEMENT", r1_guard.ANCHOR_REPLACEMENT + " "),
            (r1_guard, "GRATITUDE_REPLACEMENT", r1_guard.GRATITUDE_REPLACEMENT + " "),
            (r1_guard, "CONFIRM_FALLBACKS", r1_guard.CONFIRM_FALLBACKS[:-1] + ("Fine.",)),
            (r1_guard, "STYLE_TIC_WINDOW", r1_guard.STYLE_TIC_WINDOW + 1),
            (r1_guard, "STYLE_OPENER_WINDOW", r1_guard.STYLE_OPENER_WINDOW + 1),
        )
        for module, name, value in edits:
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        self.assertEqual(r1_content.content_sha256(), base)

    def test_the_manifest_covers_the_iteration_two_texts(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 11)
        prompts = manifest["prompts"]
        for key, value in (
            ("offer_met_note", r1_prompts.OFFER_MET_NOTE),
            ("price_met_note", r1_prompts.PRICE_MET_NOTE),
            ("price_unchanged_note", r1_prompts.PRICE_UNCHANGED_NOTE),
            ("hold_note", r1_prompts.HOLD_NOTE),
            ("answered_note", r1_prompts.ANSWERED_NOTE),
            ("stretch_used_note", r1_prompts.STRETCH_USED_NOTE),
            ("template_used_note", r1_prompts.TEMPLATE_USED_NOTE),
            ("next_step_note", r1_prompts.NEXT_STEP_NOTE),
        ):
            self.assertEqual(prompts[key], value, key)
        commitment = manifest["commitment"]
        self.assertEqual(commitment["defer_line"], r1_commitment.MEDIUM_DEFER_LINE)
        self.assertEqual(commitment["weak_call_line"], r1_commitment.WEAK_CALL_LINE)
        guard = manifest["guard"]
        style = guard["style"]
        self.assertEqual(style["phrase_quota"], dict(r1_guard.PHRASE_QUOTA))
        self.assertEqual(style["question_diet_window"], r1_guard.QUESTION_DIET_WINDOW)
        self.assertEqual(style["thin_reply_words"], r1_guard.THIN_REPLY_WORDS)
        self.assertEqual(style["stretch_alternatives"], list(r1_text.STRETCH_ALTERNATIVES))
        scheduler = manifest["scheduler"]
        self.assertEqual(scheduler["f4_push_call_suffix"], r1_scheduler.F4_PUSH_CALL_SUFFIX)
        self.assertEqual(
            scheduler["answered_labels"], [list(item) for item in r1_scheduler.ANSWERED_LABELS]
        )

    def test_editing_an_iteration_two_text_or_constant_changes_the_sha(self):
        base = r1_content.content_sha256()
        edits = (
            (r1_prompts, "OFFER_MET_NOTE", r1_prompts.OFFER_MET_NOTE + " "),
            (r1_prompts, "PRICE_MET_NOTE", r1_prompts.PRICE_MET_NOTE + " "),
            (r1_prompts, "HOLD_NOTE", r1_prompts.HOLD_NOTE + " "),
            (r1_prompts, "ANSWERED_NOTE", r1_prompts.ANSWERED_NOTE + " "),
            (r1_prompts, "STRETCH_USED_NOTE", r1_prompts.STRETCH_USED_NOTE + " "),
            (r1_prompts, "TEMPLATE_USED_NOTE", r1_prompts.TEMPLATE_USED_NOTE + " "),
            (r1_commitment, "MEDIUM_DEFER_LINE", r1_commitment.MEDIUM_DEFER_LINE + " "),
            (r1_commitment, "WEAK_CALL_LINE", r1_commitment.WEAK_CALL_LINE + " "),
            (r1_guard, "QUESTION_DIET_WINDOW", r1_guard.QUESTION_DIET_WINDOW + 1),
            (r1_guard, "THIN_REPLY_WORDS", r1_guard.THIN_REPLY_WORDS + 1),
            (r1_scheduler, "F4_PUSH_CALL_SUFFIX", r1_scheduler.F4_PUSH_CALL_SUFFIX + " "),
            (r1_negotiation, "DEFER_RECENT_TURNS", r1_negotiation.DEFER_RECENT_TURNS + 1),
            (r1_text, "STRETCH_ALTERNATIVES", r1_text.STRETCH_ALTERNATIVES[:-1] + ("so-so",)),
        )
        for module, name, value in edits:
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        quota = r1_guard.PHRASE_QUOTA
        original_quota = dict(quota)
        try:
            quota[r1_text.PHRASE_STRETCH] = 2
            self.assertNotEqual(r1_content.content_sha256(), base, "PHRASE_QUOTA")
        finally:
            quota.clear()
            quota.update(original_quota)
        self.assertEqual(r1_content.content_sha256(), base)

    def test_the_manifest_covers_the_iteration_three_texts(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 12)
        prompts = manifest["prompts"]
        self.assertEqual(prompts["hollow_note"], r1_prompts.HOLLOW_NOTE)
        self.assertIn("Answer only the part they asked about", prompts["h3_first_probe_sample"])
        commitment = manifest["commitment"]
        self.assertEqual(commitment["weak_email_done_line"], r1_commitment.WEAK_EMAIL_DONE_LINE)
        self.assertEqual(
            commitment["thin_advisor_mean_words"], r1_commitment.THIN_ADVISOR_MEAN_WORDS
        )
        self.assertEqual(commitment["thin_min_turns"], r1_commitment.THIN_MIN_TURNS)
        guard = manifest["guard"]
        self.assertEqual(guard["fallback_replies"], list(r1_guard.FALLBACK_REPLIES))
        self.assertEqual(len(guard["fallback_replies"]), 3)
        style = guard["style"]
        self.assertEqual(style["phrase_quota"], dict(r1_guard.PHRASE_QUOTA))
        self.assertIn(r1_text.PHRASE_CONCESSION_TAG, style["phrase_quota"])
        self.assertEqual(style["hollow_max_words"], r1_text.HOLLOW_MAX_WORDS)
        self.assertEqual(
            manifest["scheduler"]["time_cue_alternatives"],
            list(r1_scheduler.TIME_CUE_BRIEF_ALTERNATIVES),
        )
        negotiation = manifest["negotiation"]
        self.assertEqual(
            negotiation["constants"]["slot_recent_turns"], r1_negotiation.SLOT_RECENT_TURNS
        )
        self.assertIn("N-EMAIL-YES", [spec["id"] for spec in negotiation["specs"]])
        below = {item["id"]: item for item in negotiation["anchor_after_offer"]}["reached"]
        self.assertTrue(any("below" in variant for variant in below["variants"]))

    def test_editing_an_iteration_three_text_or_constant_changes_the_sha(self):
        base = r1_content.content_sha256()
        edits = (
            (r1_prompts, "HOLLOW_NOTE", r1_prompts.HOLLOW_NOTE + " "),
            (r1_commitment, "WEAK_EMAIL_DONE_LINE", r1_commitment.WEAK_EMAIL_DONE_LINE + " "),
            (r1_commitment, "THIN_ADVISOR_MEAN_WORDS", r1_commitment.THIN_ADVISOR_MEAN_WORDS + 1),
            (r1_commitment, "THIN_MIN_TURNS", r1_commitment.THIN_MIN_TURNS + 1),
            (r1_guard, "FALLBACK_REPLIES", r1_guard.FALLBACK_REPLIES[:-1] + ("Pardon?",)),
            (r1_negotiation, "SLOT_RECENT_TURNS", r1_negotiation.SLOT_RECENT_TURNS + 1),
            (r1_text, "HOLLOW_MAX_WORDS", r1_text.HOLLOW_MAX_WORDS + 1),
            (
                r1_scheduler,
                "TIME_CUE_BRIEF_ALTERNATIVES",
                r1_scheduler.TIME_CUE_BRIEF_ALTERNATIVES[:-1] + ("you are short on time",),
            ),
        )
        for module, name, value in edits:
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        quota = r1_guard.PHRASE_QUOTA
        original_quota = dict(quota)
        try:
            quota[r1_text.PHRASE_CONCESSION_TAG] = 2
            self.assertNotEqual(r1_content.content_sha256(), base, "PHRASE_QUOTA concession")
        finally:
            quota.clear()
            quota.update(original_quota)
        self.assertEqual(r1_content.content_sha256(), base)

    def test_no_pinned_learner_text_teaches_the_tics(self):
        """No pinned text the learner is prompted with or speaks carries "hmm" or "honestly" outside
        double quotes (the style note that names them does it as an example to avoid)."""
        import re

        from r1_text import TIC_PATTERNS

        quoted = re.compile(r'"[^"]*"')
        manifest = r1_content.manifest()
        pieces = [
            *manifest["script"]["lines"].values(),
            *manifest["script"]["learner_filler_variants"],
            manifest["script"]["learner_filler_short"],
            *(item for move in manifest["scheduler"]["moves"] for item in (move["line"], move["brief"], *move["variants"])),
            *(item for spec in manifest["negotiation"]["specs"] for item in (spec["brief"], *spec["variants"])),
            *(item for counter in manifest["negotiation"]["counters"] for item in (counter["brief"], *counter["variants"])),
            *(item for anchor in manifest["negotiation"]["anchor_after_offer"] for item in (anchor["brief"], *anchor["variants"])),
            *(text for text in manifest["prompts"]["learner_prefixes"].values()),
            *(note for note in manifest["prompts"]["style_notes"]),
            manifest["prompts"]["confirm_note"],
            manifest["prompts"]["decider_asked_note"],
            manifest["prompts"]["try_not_granted_note"],
            manifest["prompts"]["anchor_not_offered_note"],
        ]
        for persona in manifest["personas"].values():
            for need in persona["needs"]:
                pieces.extend((need["surface"], need["hint"]))
        for piece in pieces:
            bare = quoted.sub(" ", piece)
            for tic, pattern in TIC_PATTERNS.items():
                self.assertIsNone(pattern.search(bare), (tic, piece[:80]))

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

    def test_an_unknown_name_is_dropped_the_same_way_in_both(self):
        # R1-Q item 6: "", the API's "there" (any case), a rejected name and an initial are
        # unknown, and the slot goes with its comma.
        for first_name in ("", None, "there", "There", "THERE", "A", "Arjun<b>", "x" * 25):
            self.assertEqual(self.lines.known_first_name(first_name), "")
            self.assertEqual(r1_script.known_first_name(first_name), "")
            for line_id in ("L-OPEN", "L-CLOSE", "L-SIL-IB", "L-REJOIN", "L-SYSTEM-STOP"):
                with self.subTest(first_name=first_name, line=line_id):
                    self.assertEqual(
                        self.lines.line(line_id, first_name=first_name),
                        r1_script.line(line_id, first_name=first_name),
                    )
                    self.assertNotIn(
                        "there", r1_script.line(line_id, first_name=first_name).lower()
                    )
            self.assertEqual(
                self.lines.line("L-TRANSITION", first_name=first_name,
                                lead_name="Meera Iyer", lead_city="Edison, New Jersey"),
                r1_script.line("L-TRANSITION", first_name=first_name,
                               lead_name="Meera Iyer", lead_city="Edison, New Jersey"),
            )
        for first_name in ("Arjun", "Mary-Ann", "Bo"):
            self.assertEqual(self.lines.known_first_name(first_name), first_name)
            self.assertEqual(r1_script.known_first_name(first_name), first_name)


class FinalReviewRoundOnePinTests(unittest.TestCase):
    """R1-Q final review round 1 (content revision 13): the new texts and constants are pinned."""

    def test_the_manifest_covers_the_final_review_round_one_texts_and_constants(self):
        manifest = r1_content.manifest()
        self.assertGreaterEqual(manifest["revision"], 13)
        self.assertEqual(
            manifest["guard"]["style"]["phrase_window"], dict(r1_guard.PHRASE_WINDOW)
        )
        for phrase in (r1_text.PHRASE_DECIDER_STALL, r1_text.PHRASE_STALL_CLOSER,
                       r1_text.PHRASE_MONEY_STRAIN):
            self.assertIn(phrase, manifest["guard"]["style"]["phrase_quota"])
            self.assertIn(phrase, manifest["guard"]["style"]["phrase_window"])
        self.assertEqual(
            manifest["negotiation"]["constants"]["wait_recent_turns"],
            r1_negotiation.WAIT_RECENT_TURNS,
        )
        self.assertEqual(
            manifest["tracker"],
            {
                "max_deep_offers": r1_tracker.MAX_DEEP_OFFERS,
                "max_deep_misses": r1_tracker.MAX_DEEP_MISSES,
            },
        )
        self.assertNotIn("for that plan", manifest["commitment"]["lines"]["STRONG"])
        prefixes = manifest["prompts"]["learner_prefixes"]
        self.assertTrue(all("only the person on your card has a say" in p for p in prefixes.values()))
        self.assertTrue(any("That" in note for note in manifest["prompts"]["style_notes"]))
        cue = next(m for m in manifest["scheduler"]["moves"] if m["id"] == "L-TIME-CUE")
        self.assertFalse(any("another call" in variant for variant in cue["variants"][1:]))

    def test_editing_a_final_review_text_or_constant_changes_the_sha(self):
        base = r1_content.content_sha256()
        edits = (
            (r1_negotiation, "WAIT_RECENT_TURNS", r1_negotiation.WAIT_RECENT_TURNS + 1),
            (r1_tracker, "MAX_DEEP_MISSES", r1_tracker.MAX_DEEP_MISSES + 1),
            (
                r1_prompts,
                "STYLE_NOTES",
                r1_prompts.STYLE_NOTES + ("- Start with a number this time.",),
            ),
        )
        for module, name, value in edits:
            original = getattr(module, name)
            try:
                setattr(module, name, value)
                self.assertNotEqual(r1_content.content_sha256(), base, name)
            finally:
                setattr(module, name, original)
        for table in (r1_guard.PHRASE_WINDOW, r1_guard.PHRASE_QUOTA):
            original_table = dict(table)
            try:
                table[r1_text.PHRASE_DECIDER_STALL] += 1
                self.assertNotEqual(r1_content.content_sha256(), base, "decider stall quota/window")
            finally:
                table.clear()
                table.update(original_table)
        line = r1_commitment.COMMITMENT_LINES[r1_commitment.Level.STRONG]
        try:
            r1_commitment.COMMITMENT_LINES[r1_commitment.Level.STRONG] = line + " "
            self.assertNotEqual(r1_content.content_sha256(), base, "STRONG line")
        finally:
            r1_commitment.COMMITMENT_LINES[r1_commitment.Level.STRONG] = line
        self.assertEqual(r1_content.content_sha256(), base)


if __name__ == "__main__":
    unittest.main()
