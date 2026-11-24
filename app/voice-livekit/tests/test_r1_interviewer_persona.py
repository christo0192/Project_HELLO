"""R1_INTERVIEWER_DEX (owner 2026-11-19): Dex, a male interviewer, in every spoken line.

Pure tests (no livekit): the default renders Dex in exactly the 24 lines that name the interviewer
(21, plus the three Google Meet openings of M034 S08) and never Christy, the flag off renders content revision 46's Christy texts byte for byte, the
placeholders and cacheability do not change, and the content pin does not depend on the flag.
It also covers Dex model prompts, agent instructions and voice defaults. No livekit is needed:
r1_session falls back to Agent = object. Synthetic names only.
"""
import itertools
import json
import os
import string
import unittest
from unittest import mock

import r1_guard
import r1_icebreaker as ice
import r1_negotiation as negotiation
import r1_script
import r1_tracker as tracker
from r1_personas import resolve_persona
import r1_lines
import r1_content
import r1_end_intent
import r1_prompts
import r1_session
import r1_tts
import r1_turn_reader


IDS = set('''L-OPEN L-OPEN-HELLO L-OPEN-HI L-EXIT L-ASIDE-COACH L-ASIDE-COACH-V20
L-ASIDE-END L-ASIDE-WRAP L-ASIDE-EARLY-CLOSE L-ASIDE-EARLY-CLOSE-TIME L-ASIDE-LAST-POINT
L-EXIT-WRAP L-EXIT-WRAP-2 L-EXIT-WRAP-END L-EXIT-WRAP-TIME L-ASIDE-END-2
L-ASIDE-EARLY-CLOSE-2 L-ASIDE-WRAP-AGAIN L-MUTE L-MUTE-RP L-SIL-RP2
L-OPEN-MEET L-OPEN-HELLO-MEET L-OPEN-HI-MEET'''.split())
VALUES = dict(first_name="Asha", lead_name="Meera Rao", lead_first_name="Meera", lead_city="Pune")


class TestInterviewerPersona(unittest.TestCase):
    def test_default_texts(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(r1_script.line("L-OPEN-HI", first_name="Asha"),
                             "Hi Asha, I'm Dex, an AI interviewer from Interview Kickstart.")
            self.assertEqual(r1_script.line("L-OPEN-HI"),
                             "Hi, I'm Dex, an AI interviewer from Interview Kickstart.")
            self.assertEqual(r1_script.line("L-EXIT-WRAP-END"),
                             "Sure. Let's pause the role-play here. It's Dex again, thanks for "
                             "that. Before we wrap up, do you have any questions for me about the "
                             "role or the next steps?")
            self.assertEqual(r1_script.line("L-ASIDE-END-2", **VALUES),
                             "This is Dex, your interviewer. Would you like to stop the role-play "
                             "here and finish the interview? Just say yes, or carry on with Meera.")
            self.assertEqual(r1_script.line("L-MUTE"),
                             "This is Dex. It looks like your microphone may be muted. Please "
                             "unmute when you're ready.")
            self.assertEqual(r1_script.interviewer_name(), "Dex")
            self.assertEqual(r1_script.interviewer_pronouns(), ("he", "him", "his"))
            self.assertEqual(r1_lines.line("L-MUTE"), r1_script.line("L-MUTE"))

    def test_all_lines_and_flag_combinations(self):
        self.assertEqual(set(r1_script.DEX_LINES), IDS)
        flags = ("R1_TRANSITION_REPAIR", "R1_BRIEF_WORDING_V2", "R1_AGENDA_W3",
                 "R1_TRANSITION_PRESENCE_V2")
        for states in itertools.product("01", repeat=4):
            with mock.patch.dict(os.environ, dict(zip(flags, states)), clear=True):
                for ident in r1_script.LINES:
                    with self.subTest(states=states, ident=ident):
                        active = r1_script.active_line_id(ident)
                        text = r1_script.line(active, **VALUES)
                        self.assertNotIn("christy", text.casefold())
                        self.assertEqual("Dex" in text, active in IDS)
                for ident in r1_lines.LINES:
                    self.assertNotIn("christy", r1_lines.line(ident, **VALUES).casefold())

    def test_rollback_and_placeholders(self):
        formatter = string.Formatter()
        names = r1_script.NAME_FREE_LINES, r1_script.CANDIDATE_FREE_LINES
        for off in ("0", "off", "false", "no", " OFF "):
            with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": off}):
                self.assertEqual(r1_script.interviewer_name(), "Christy")
                self.assertEqual(r1_script.interviewer_pronouns(), ("she", "her", "her"))
                self.assertEqual(
                    r1_script.line("L-OPEN-HI", **VALUES),
                    "Hi Asha, I'm Christy, an AI interviewer from Interview Kickstart.",
                )
                self.assertIn("Christy", r1_lines.line("L-MUTE"))
                recomputed = (
                    tuple(i for i in r1_script.LINES if not r1_script.placeholders(i)),
                    tuple(i for i in r1_script.LINES if r1_script.is_candidate_free(i)),
                )
                self.assertEqual(recomputed, names)
                for ident, original in r1_script.LINES.items():
                    self.assertEqual(r1_script.persona_text(ident), original)
                    self.assertEqual(r1_script.line(ident, **VALUES), original.format(**VALUES))
        for ident, dex in r1_script.DEX_LINES.items():
            fields = lambda text: {f for _, f, _, _ in formatter.parse(text) if f}
            self.assertEqual(fields(dex), fields(r1_script.LINES[ident]))
            self.assertEqual(r1_script.placeholders(ident), fields(dex))
            self.assertIn("Dex", dex)
            with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": "0"}):
                old = r1_script.line(ident, **VALUES)
            with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": "1"}):
                new = r1_script.line(ident, **VALUES)
            self.assertNotEqual(r1_script.line_sha256(old), r1_script.line_sha256(new))

    def test_composition_and_manifest(self):
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}, clear=True):
            ident = r1_script.active_line_id("L-ASIDE-COACH")
            self.assertEqual(ident, "L-ASIDE-COACH-V20")
            self.assertEqual(r1_script.line(ident, **VALUES),
                             r1_script.LINES[ident].replace("Christy", "Dex").format(**VALUES))
        hashes = []
        for flag in (None, "0", "1"):
            with mock.patch.dict(os.environ, {} if flag is None else {"R1_INTERVIEWER_DEX": flag},
                                 clear=True):
                hashes.append(r1_content.content_sha256())
                script = r1_content.manifest()["script"]
                self.assertEqual(script["interviewer_name"], "Christy")
                self.assertEqual(script["interviewer_name_dex"], "Dex")
                self.assertEqual(script["dex_lines"], r1_script.DEX_LINES)
                manifest = r1_content.manifest()
                prompts = manifest["prompts"]
                self.assertTrue(prompts["interviewer_prefix"].startswith("You are Christy"))
                self.assertTrue(prompts["interviewer_prefix_dex"].startswith("You are Dex"))
                self.assertIn("Dex", prompts["wrapup_note_dex"])
                self.assertIn("Dex", manifest["end_intent"]["system_dex"])
                self.assertIn("Dex", manifest["end_intent"]["after_aside_context_dex"])
        self.assertEqual(len(set(hashes)), 1)


class TestPersonaPrompts(unittest.TestCase):
    def test_default_and_rollback_prompts(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            for text in (r1_prompts.interviewer_prefix(),
                         r1_prompts.interviewer_prefix(voice=False),
                         r1_prompts.wrapup_note(), r1_prompts.interviewer_control_prose(),
                         r1_end_intent.end_intent_system(), r1_end_intent.after_aside_context(),
                         r1_turn_reader.reader_system(), r1_turn_reader.transition_context()):
                self.assertNotIn("christy", text.casefold())
            self.assertTrue(
                r1_prompts.interviewer_prefix().startswith("You are Dex, an AI interviewer")
            )
            self.assertIn(
                "stopping THIS interview with Dex or this role-play",
                r1_end_intent.END_INTENT_SYSTEM_DEX,
            )
            self.assertIn("The interviewer, Dex, has", r1_end_intent.END_INTENT_SYSTEM_DEX)
            messages = r1_end_intent.build_end_intent_messages("synthetic", context="after_aside",
                                                               question="Ready?", seed="s", turn=1)
            self.assertTrue(messages[1]["content"].startswith("Dex has just asked:"))
            self.assertNotIn("christy", str(messages).casefold())
            reader_messages = r1_turn_reader.build_reader_messages(
                "synthetic", phase="transition", seed="s", turn=1)
            self.assertNotIn("christy", str(reader_messages).casefold())
            self.assertEqual(r1_turn_reader.READER_PROMPT_REVISION, 3)
            self.assertEqual(r1_turn_reader.READER_PROMPT_REVISION_CHRISTY, 2)
            self.assertTrue(r1_session.r1_agent_instructions().startswith("You are Dex."))
            explicit = r1_prompts.interviewer_prefix(name="Christy")
        with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": "0"}, clear=True):
            self.assertTrue(r1_turn_reader.reader_prompt_version().startswith("r1-reader-v2+"))
            self.assertEqual(explicit, r1_prompts.interviewer_prefix())
            self.assertTrue(explicit.startswith("You are Christy, an AI interviewer"))
            self.assertEqual(r1_prompts.wrapup_note(), r1_prompts.WRAPUP_NOTE)
            self.assertEqual(r1_end_intent.end_intent_system(), r1_end_intent.END_INTENT_SYSTEM)
            self.assertEqual(r1_end_intent.after_aside_context(), r1_end_intent.AFTER_ASIDE_CONTEXT)
            self.assertEqual(r1_turn_reader.reader_system(), r1_turn_reader.READER_SYSTEM)
            self.assertEqual(r1_turn_reader.transition_context(), r1_turn_reader.TRANSITION_CONTEXT)
            self.assertTrue(r1_session.r1_agent_instructions().startswith("You are Christy."))

    def test_voice_personas_and_overrides(self):
        for flag, expected in (("1", "deven_en_conversation"), ("0", "simran_en_customer")):
            with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": flag}, clear=True):
                voices = r1_tts.r1_voice_set()
                self.assertEqual(voices.interviewer["speaker"], expected)
                self.assertEqual(voices.learner["speaker"], "zarina_en_conversation")
                self.assertTrue(voices.distinct)
                self.assertEqual(voices.interviewer["model"], "bulbul:v4-flash")
                self.assertEqual(voices.learner["model"], "bulbul:v4-flash")

    def test_voice_override_rejection_and_v3(self):
        for flag, default, override in (("1", "deven_en_conversation", "simran_en_customer"),
                                        ("0", "simran_en_customer", "deven_en_conversation")):
            env = {"R1_INTERVIEWER_DEX": flag, "R1_TTS_INTERVIEWER_VOICE": override}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(r1_tts.r1_voice_set().speaker(), override)
            env["R1_TTS_INTERVIEWER_VOICE"] = "synthetic_invalid"
            with mock.patch.dict(os.environ, env, clear=True):
                voices = r1_tts.r1_voice_set()
                self.assertEqual(voices.speaker(), default)
                self.assertIn("interviewer_voice_rejected", voices.notes)
        with mock.patch.dict(os.environ, {"R1_TTS_PROFILE": "v3"}, clear=True):
            before = r1_tts.r1_voice_set()
            os.environ["R1_INTERVIEWER_DEX"] = "0"
            self.assertEqual(r1_tts.r1_voice_set(), before)


class TestInterviewerAddressDetectors(unittest.TestCase):
    def persona_states(self):
        """Yield once with R1_INTERVIEWER_DEX unset and once with it 0 (the env is restored)."""
        for flag in (None, "0"):
            closed = True
            with self.subTest(flag=flag), mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("R1_INTERVIEWER_DEX", None)
                if flag is not None:
                    os.environ["R1_INTERVIEWER_DEX"] = flag
                yield
                closed = False
            if closed:
                return  # a failing caller closed the generator; subTest swallowed GeneratorExit

    def test_vocabulary(self):
        for _ in self.persona_states():
            names = r1_script.INTERVIEWER_ADDRESS_NAMES
            expected = "christy christie christi kristy kristie cristy dex decks dax deks".split()
            self.assertTrue(set(expected) <= set(names))
            self.assertNotIn("desk", names)
            self.assertRegex(r1_script.INTERVIEWER_ADDRESS_ALT, r"^[a-z|]+$")

    def test_name_only_and_lead_in(self):
        for _ in self.persona_states():
            texts = ("Dex?", "Hello Dex.", "Decks?", "Desk?", "Hello desk?", "Hey, Dax?",
                     "Christy?", "Christie.")
            for text in texts:
                with self.subTest(text=text):
                    self.assertTrue(r1_session.is_name_only(text))
            self.assertTrue(r1_session.is_lead_in_only("Christy, so."))
            self.assertTrue(r1_session.is_lead_in_only("Dex, so."))

    def test_icebreaker_repair_and_sound_check(self):
        for _ in self.persona_states():
            for name in ("Dex", "Decks", "Christy"):
                with self.subTest(name=name):
                    view = r1_session._ib_repair_view(f"{name}, are you there?")
                    self.assertTrue(r1_session.is_repair_turn(view))
                    view = r1_session._ib_repair_view(f"Sorry {name}, can you repeat the question?")
                    self.assertTrue(r1_session.is_repeat_request(view))
            for name in ("Dex", "Christy"):
                self.assertEqual(r1_session.sound_check_reading(f"Hello {name}?"),
                                 r1_session.SOUND_HEARD)
            self.assertEqual(r1_session.sound_check_reading("Sorry Dex, I can't hear you"),
                             r1_session.SOUND_CANT_HEAR)

    def test_tracker_end_and_yes_readers(self):
        for _ in self.persona_states():
            for name in ("Dex", "Christy"):
                self.assertTrue(tracker.strictly_names_end(f"Please end the interview, {name}."))
                self.assertTrue(tracker.is_short_wrap_yes(f"Yes {name}."))
                self.assertTrue(tracker.is_bare_yes(f"Yes {name}"))
            self.assertTrue(tracker.strictly_names_end("Dex end the interview"))
            self.assertTrue(tracker.confirms_end(
                "Sorry Decks, yes, please end the interview, I need to go."))

    def test_session_consent_brief_refusal_and_affirmation(self):
        for _ in self.persona_states():
            for name in ("Dex", "Christy"):
                self.assertTrue(r1_session.is_no_questions(f"No, thank you, {name}."))
                self.assertTrue(r1_session.is_affirmation_only(f"Yes {name}, one more."))
                self.assertTrue(r1_session.is_transition_consent(f"Okay {name}, I'm ready."))
                self.assertTrue(r1_session.is_brief_request(
                    f"{name}, can you go over the role-play again?"))

    def test_spoken_name(self):
        for _ in self.persona_states():
            self.assertEqual(r1_script.spoken_first_name("Hi Dex, myself Ravi"), "Ravi")
            for name in ("Dex", "Decks", "Christy"):
                self.assertFalse(r1_script.spoken_first_name(f"This is {name}"))

    def test_guard_icebreaker_ask_and_negotiation(self):
        for _ in self.persona_states():
            for name in ("Dex", "Christy"):
                self.assertTrue(ice.asks_christy(f"{name}, what do you mean?"))
                self.assertIsNone(negotiation._named_sellers(f"{name} said 5000"))
                self.assertIsNotNone(r1_guard._LEARNER_META.search(f"{name} told me to call you"))
            ctx = r1_guard.GuardContext(
                phase="roleplay", persona=resolve_persona("p1_career_switcher", variant="v1"))
            hits = r1_guard.check_sentence("Dex told me to call you.", ctx)
            self.assertIn("meta", {hit.category for hit in hits})
            for word in ("index", "Dexter"):
                self.assertIsNone(r1_guard._LEARNER_META.search(word))

    def test_desk_negatives(self):
        for _ in self.persona_states():
            self.assertFalse(r1_session.is_name_only("I had a desk job in sales"))
            view = r1_session._ib_repair_view("I had a desk job in sales")
            self.assertFalse(r1_session.is_repair_turn(view))
            self.assertFalse(tracker.is_short_wrap_yes("Yes desk"))
            self.assertFalse(tracker.is_bare_yes("Yes desk"))
            self.assertFalse(tracker.strictly_names_end("Please end the interview, desk."))


class TestSessionVoiceMismatch(unittest.TestCase):
    def test_session_warnings(self):
        cases = [
            ({}, True, "legacy_voice"),
            ({"R1_INTERVIEWER_DEX": "0"}, True, None),
            ({}, False, None),
            ({"R1_TTS_INTERVIEWER_VOICE": "simran_en_customer"}, False, "voice_not_male"),
        ]
        for env, fallback, expected in cases:
            with self.subTest(env=env, fallback=fallback), mock.patch.dict(
                os.environ, env, clear=True
            ):
                lines = []

                def build(voice_set, on_fallback=None):
                    if fallback:
                        return object()
                    return type("FakeTTS", (), {"r1_voice_set": voice_set})()

                def writer(raw):
                    lines.append(json.loads(raw))

                with mock.patch.object(r1_session._log, "_writer", writer):
                    r1_session._build_session_tts(build)
                warnings = [line for line in lines
                            if line.get("error_type") == "r1_interviewer_voice_mismatch"]
                self.assertEqual([line.get("error_category") for line in warnings],
                                 [] if expected is None else [expected])
                self.assertNotIn("simran_en_customer", json.dumps(warnings))
                events = [(line.get("error_type"), line.get("error_category")) for line in lines]
                if fallback:
                    self.assertIn(("r1_tts_profile", "v3"), events)
