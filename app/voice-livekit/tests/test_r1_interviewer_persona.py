"""R1_INTERVIEWER_DEX (owner 2026-11-19): Dex, a male interviewer, in every spoken line.

Pure tests (no livekit): the default renders Dex in exactly the 21 lines that name the interviewer
and never Christy, the flag off renders content revision 46's Christy texts byte for byte, the
placeholders and cacheability do not change, and the content pin does not depend on the flag.
Synthetic names only.
"""
import itertools
import os
import string
import unittest
from unittest import mock

import r1_script
import r1_lines
import r1_content


IDS = set('''L-OPEN L-OPEN-HELLO L-OPEN-HI L-EXIT L-ASIDE-COACH L-ASIDE-COACH-V20
L-ASIDE-END L-ASIDE-WRAP L-ASIDE-EARLY-CLOSE L-ASIDE-EARLY-CLOSE-TIME L-ASIDE-LAST-POINT
L-EXIT-WRAP L-EXIT-WRAP-2 L-EXIT-WRAP-END L-EXIT-WRAP-TIME L-ASIDE-END-2
L-ASIDE-EARLY-CLOSE-2 L-ASIDE-WRAP-AGAIN L-MUTE L-MUTE-RP L-SIL-RP2'''.split())
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
        self.assertEqual(len(set(hashes)), 1)
