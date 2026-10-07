"""M013 S01 T12: the AI-disclosure wording is pinned to origin/main (6fec38a).

Owner constraint 2: S01 must not change the AI-disclosure wording. That covers
`PHONE_DISCLOSURE_TEXT`, `phone_identity_text`,
`PHONE_DISCLOSURE_RECORDING_SENTENCE`, `PHONE_DISCLOSURE_CONTINUATION_TEXT`,
the AI checks that gate a composed opening, and the prompting.py line "Do not
proactively mention being an AI…". No new sentence about being an AI may be
written anywhere a candidate could hear it.

Every expected value below is HARD-CODED from origin/main, not read from the
module under test, so an edit to the copy turns this file red. If one fails:

1. you changed the disclosure by accident: revert; or
2. the owner approved new wording: update the expected value here in the same
   commit and say so in the PR. That is the reviewable act.

The source-level pins compare the literal as written (after normalising CRLF),
because the API's cross-language contract test (`phone-canary1-cross-language
.test.ts`) reads `PHONE_DISCLOSURE_TEXT` straight out of phone.py as a plain
module-level literal.
"""

from __future__ import annotations

import ast
import collections
import re
import sys
import unittest
from pathlib import Path

_WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_WORKER))

import phone  # noqa: E402
import prompting  # noqa: E402

#: The candidate's first name in these tests is synthetic.
_NAME = "Asha"


def _source(name: str) -> str:
    return (_WORKER / name).read_text(encoding="utf-8").replace("\r\n", "\n")


def _module_assignment_source(src: str, target: str) -> str:
    tree = ast.parse(src)
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == target):
            return ast.get_source_segment(src, node.value) or ""
    raise AssertionError(f"{target} is no longer a plain module-level assignment")


def _function(src: str, name: str) -> ast.FunctionDef:
    for node in ast.parse(src).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found")


def _squash(text: str) -> str:
    return " ".join(text.split())


# ── origin/main values (6fec38a), byte for byte ──────────────────────────────

_RECORDING_SENTENCE = "This call is recorded so the hiring team can review it."
_RECORDING_SENTENCE_SRC = '"This call is recorded so the hiring team can review it."'

_DISCLOSURE_SRC = (
    'f"Hi, this is Christy, an AI voice assistant calling from {_COMPANY} "\n'
    '    "about your job application. This call is recorded so the hiring team can "\n'
    '    "review it. Is it okay to continue?"'
)

_CONTINUATION = (
    "Quick note before we start. This call is recorded so the hiring team can "
    "review it. Is it okay to continue?"
)
_CONTINUATION_SRC = (
    '"Quick note before we start. This call is recorded so the hiring team can "\n'
    '    "review it. Is it okay to continue?"'
)

#: The two `return` expressions of `phone_identity_text`, as written.
_IDENTITY_RETURNS_SRC = (
    'f"Hi, this is Christy, an AI voice assistant calling from {_COMPANY}. "\n'
    '        f"Am I speaking to {first}?"',
    'f"Hi, this is Christy, an AI voice assistant calling from {_COMPANY}. "\n'
    '            "Am I speaking to the right person?"',
)

#: prompting.py:196, as written (``{COMPANY}`` is filled at render time).
_PROMPT_AI_LINE = (
    "- You have ALREADY introduced yourself as Christy from {COMPANY}. Do not "
    "proactively mention being an AI, bot, or automated assistant. Only if the "
    "candidate explicitly asks whether you are AI, a bot, automated, or human, "
    "answer truthfully and briefly that you are an AI assistant. Never claim to "
    "be human."
)

#: The consent-draft AI check of `phone_opening_draft_verified` on origin/main.
_OPENING_AI_CHECK = (
    'if not identity_done and not ( "christy" in clean.lower() and "ai" in '
    'clean.lower().split() and _COMPANY.lower() in clean.lower() ):'
)
#: The identity-draft AI check (inline in `run_phone_gate` on origin/main; T08a
#: moved it, unchanged, into `phone_identity_draft_rejection`).
_IDENTITY_AI_CHECK = (
    '"christy" in text.lower() and re.search(r"\\bAI\\b", text, re.IGNORECASE) '
    'and _COMPANY.lower() in text.lower()'
)

#: Every non-docstring string literal that says "AI" in the files that produce
#: speech or steer the speaking model, with its count, on origin/main. A new
#: entry is a new sentence about being an AI. (gate_judge.py is not scanned:
#: its prompt goes to the reply judge, never to the candidate.)
_AI_LITERALS = collections.Counter({
    ("agent.py", "You are Christy, an AI voice assistant calling from "): 1,
    ("phone.py", "Hi, this is Christy, an AI voice assistant calling from "): 3,
    ("phone.py", "You are Christy, an AI voice assistant calling from "): 1,
    ("prompting.py",
     ". Do not proactively mention being an AI, bot, or automated assistant. "
     "Only if the candidate explicitly asks whether you are AI, a bot, automated, "
     "or human, answer truthfully and briefly that you are an AI assistant. Never "
     "claim to be human.\n- If it's not a good time, politely offer to call back "
     "later and end the call.\n- Once they confirm, use the adaptive evidence flow "
     "above and cover this recruiter-provided question bank where relevant. "
     "Generate each question LIVE and naturally, adapting to their answers:\n"): 1,
    ("prompting.py",
     'You are "Christy", a warm, professional AI voice assistant running a '
     "first-round phone screening for "): 1,
})


class TestDisclosureLiteralsArePinned(unittest.TestCase):
    """The constants, as values and as written in phone.py."""

    def test_recording_sentence(self):
        self.assertEqual(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE, _RECORDING_SENTENCE)
        self.assertEqual(
            _module_assignment_source(_source("phone.py"),
                                      "PHONE_DISCLOSURE_RECORDING_SENTENCE"),
            _RECORDING_SENTENCE_SRC,
        )

    def test_disclosure_text(self):
        expected = (
            f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY} "
            "about your job application. This call is recorded so the hiring team can "
            "review it. Is it okay to continue?"
        )
        self.assertEqual(phone.PHONE_DISCLOSURE_TEXT, expected)
        self.assertEqual(
            _module_assignment_source(_source("phone.py"), "PHONE_DISCLOSURE_TEXT"),
            _DISCLOSURE_SRC,
        )

    def test_disclosure_with_the_default_company(self):
        # The f-string with the shipped COMPANY_NAME (fly.phone.toml).
        rendered = eval(  # noqa: S307 — a pinned literal, evaluated with one name
            compile(ast.parse(f"({_DISCLOSURE_SRC})", mode="eval"), "<pin>", "eval"),
            {"__builtins__": {}}, {"_COMPANY": "Interview Kickstart"},
        )
        self.assertEqual(
            rendered,
            "Hi, this is Christy, an AI voice assistant calling from Interview "
            "Kickstart about your job application. This call is recorded so the "
            "hiring team can review it. Is it okay to continue?",
        )

    def test_continuation_text(self):
        self.assertEqual(phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, _CONTINUATION)
        self.assertEqual(
            _module_assignment_source(_source("phone.py"),
                                      "PHONE_DISCLOSURE_CONTINUATION_TEXT"),
            _CONTINUATION_SRC,
        )

    def test_the_recording_sentence_is_verbatim_inside_both_disclosures(self):
        self.assertIn(_RECORDING_SENTENCE, phone.PHONE_DISCLOSURE_TEXT)
        self.assertIn(_RECORDING_SENTENCE, phone.PHONE_DISCLOSURE_CONTINUATION_TEXT)


class TestIdentityLineIsPinned(unittest.TestCase):
    def test_named_and_nameless_identity_lines(self):
        company = phone._COMPANY
        self.assertEqual(
            phone.phone_identity_text(_NAME),
            f"Hi, this is Christy, an AI voice assistant calling from {company}. "
            f"Am I speaking to {_NAME}?",
        )
        self.assertEqual(
            phone.phone_identity_text(None),
            f"Hi, this is Christy, an AI voice assistant calling from {company}. "
            "Am I speaking to the right person?",
        )

    def test_identity_returns_as_written(self):
        src = _source("phone.py")
        node = _function(src, "phone_identity_text")
        returns = sorted(
            ast.get_source_segment(src, sub.value) or ""
            for sub in ast.walk(node) if isinstance(sub, ast.Return)
        )
        self.assertEqual(returns, sorted(_IDENTITY_RETURNS_SRC))

    def test_the_is_ai_answer_reuses_the_identity_sentence_verbatim(self):
        # T05: "is this an AI?" before consent is answered with the first
        # sentence of the identity line, never with new wording.
        sentence = phone.phone_ai_identity_sentence()
        self.assertEqual(
            sentence,
            f"Hi, this is Christy, an AI voice assistant calling from {phone._COMPANY}.",
        )
        self.assertTrue(phone.phone_identity_text(None).startswith(sentence))
        self.assertEqual(phone.phone_consent_faq_text(phone.CONSENT_FAQ_IS_AI), sentence)


class TestDraftAiChecksArePinned(unittest.TestCase):
    """The AI checks that gate a composed (model-authored) gate line."""

    _NO_AI = (" an AI voice assistant", " a voice assistant")

    def test_consent_draft_check_source(self):
        src = _source("phone.py")
        node = _function(src, "phone_opening_draft_rejection")
        self.assertIn(_OPENING_AI_CHECK, _squash(ast.get_source_segment(src, node) or ""))
        # The public verifier still runs exactly that check.
        verified = _function(src, "phone_opening_draft_verified")
        self.assertIn("phone_opening_draft_rejection(",
                      ast.get_source_segment(src, verified) or "")

    def test_consent_draft_needs_the_ai_introduction(self):
        good = phone.PHONE_DISCLOSURE_TEXT
        self.assertTrue(phone.phone_opening_draft_verified(good))
        no_ai = good.replace(*self._NO_AI)
        self.assertNotEqual(no_ai, good)
        self.assertFalse(phone.phone_opening_draft_verified(no_ai))
        self.assertEqual(phone.phone_opening_draft_rejection(no_ai), "no_ai_introduction")
        # Waived only after the identity line already introduced the AI.
        self.assertTrue(phone.phone_opening_draft_verified(no_ai, identity_done=True))
        # The continuation line (spoken after the identity turn) passes then.
        self.assertTrue(phone.phone_opening_draft_verified(
            phone.PHONE_DISCLOSURE_CONTINUATION_TEXT, identity_done=True))

    def test_identity_draft_check_source(self):
        src = _source("phone.py")
        node = _function(src, "phone_identity_draft_rejection")
        self.assertIn(_IDENTITY_AI_CHECK, _squash(ast.get_source_segment(src, node) or ""))

    def test_identity_draft_needs_the_ai_introduction(self):
        good = phone.phone_identity_text(_NAME)
        self.assertIsNone(phone.phone_identity_draft_rejection(good, introduced=False))
        no_ai = good.replace(*self._NO_AI)
        self.assertNotEqual(no_ai, good)
        self.assertEqual(
            phone.phone_identity_draft_rejection(no_ai, introduced=False),
            "no_ai_introduction",
        )
        self.assertIsNone(phone.phone_identity_draft_rejection(no_ai, introduced=True))


class TestPromptAiLineIsPinned(unittest.TestCase):
    def test_line_196_as_written(self):
        lines = _source("prompting.py").split("\n")
        self.assertIn(_PROMPT_AI_LINE, lines)
        self.assertEqual(lines.count(_PROMPT_AI_LINE), 1)

    def test_rendered_on_both_lanes(self):
        rendered_line = _PROMPT_AI_LINE.replace("{COMPANY}", prompting.COMPANY)
        for unverified in (False, True):
            with self.subTest(name_unverified=unverified):
                text = prompting.system_prompt(
                    candidate_name=_NAME, role_title="Pin Role",
                    name_unverified=unverified,
                )
                self.assertIn(rendered_line, text.split("\n"))


class TestNoNewAiSentence(unittest.TestCase):
    """No string literal that says "AI" was added to the speaking code."""

    @staticmethod
    def _ai_literals() -> collections.Counter:
        found: collections.Counter = collections.Counter()
        for name in ("agent.py", "phone.py", "prompting.py"):
            tree = ast.parse(_source(name))
            docstrings = set()
            for node in ast.walk(tree):
                if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str)):
                    docstrings.add(id(node.value))
            for node in ast.walk(tree):
                if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                        and id(node) not in docstrings
                        and re.search(r"\bAI\b", node.value)):
                    found[(name, node.value)] += 1
        return found

    def test_ai_literals_equal_origin_main(self):
        self.assertEqual(self._ai_literals(), _AI_LITERALS)

    def test_the_scan_sees_a_new_ai_sentence(self):
        # Mutation control: the scan is not vacuous.
        tree = ast.parse('X = "I am an AI assistant, by the way."')
        hits = [n.value for n in ast.walk(tree)
                if isinstance(n, ast.Constant) and isinstance(n.value, str)
                and re.search(r"\bAI\b", n.value)]
        self.assertEqual(len(hits), 1)


if __name__ == "__main__":
    unittest.main()
