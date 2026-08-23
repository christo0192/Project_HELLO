"""P4b — the durable half of a phone screening.

Three properties, and every test here exists to pin one of them:

1. **Question identity comes from the SERVER, never from prose.** The worker
   asks the key it is told it owes, commits the exchange under that key, and
   re-reads the cursor from the answer. It never counts turns and never infers
   which question it just covered.
2. **A boundary that did not commit stops everything.** No next question, no
   completion, and no terminal event — because the conversation is interrupted,
   not over, and 0042's reconnect budget owns what happens next.
3. **Only a verified assessment row entitles anything to claim a completion.**

`phone.py` imports no SDK at module scope, so this module needs no stub.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import phone  # noqa: E402
import prompting  # noqa: E402


_SESSION_ID = "11111111-2222-4333-8444-555555555555"
_ATTEMPT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "supabase" / "migrations" / "0044_phone_assessment_resume.sql"
)


def _run(coro):
    return asyncio.run(coro)


def _body(questions=None, cursor=0, completed=None, turns=None):
    questions = questions if questions is not None else [
        {"key": "k1", "text": "Years of experience?", "mandatory": True, "hint": None},
        {"key": "k2", "text": "Why are you moving?", "mandatory": True, "hint": "specifics"},
    ]
    return {
        "ok": True,
        "status": "ok",
        "context": {"session_id": _SESSION_ID, "candidate_name": "Asha", "status": "in_progress"},
        "plan": {"source": "role_template", "question_count": len(questions),
                 "questions": questions},
        "progress": {
            "cursor": cursor,
            "next_key": questions[cursor]["key"] if cursor < len(questions) else None,
            "completed_keys": completed if completed is not None else [],
            "plan_complete": cursor >= len(questions),
        },
        "turns": turns if turns is not None else [],
        "assessment_exists": False,
    }


class ScriptedClient:
    """Records every assessment call and scripts each answer."""

    def __init__(self, *, commits=None, complete=None):
        self.boundaries: list[dict] = []
        self.completions: list[tuple] = []
        self._commits = commits or {}
        self._complete = complete

    async def commit_boundary(
        self, session_id, question_key, expected_index, source_event_id, turns
    ):
        self.boundaries.append({
            "question_key": question_key,
            "expected_index": expected_index,
            "source_event_id": source_event_id,
            "turns": list(turns),
        })
        scripted = self._commits.get(question_key)
        if scripted is not None:
            return scripted
        outcome = phone.PhoneApiOutcome(True, "applied")
        outcome.cursor = expected_index + 1
        return outcome

    async def complete_assessment(self, attempt_id, session_id):
        self.completions.append((attempt_id, session_id))
        return self._complete or phone.PhoneApiOutcome(True, phone.ASSESSMENT_SCORED_STATUS)

    @property
    def keys(self):
        return [b["question_key"] for b in self.boundaries]


# ── The projection ────────────────────────────────────────────────────

class TestAssessmentStateParse(unittest.TestCase):
    def test_a_well_formed_body_parses_field_by_field(self):
        state = phone.PhoneAssessmentState.parse(_body())
        self.assertTrue(state.ok)
        self.assertEqual([q.key for q in state.questions], ["k1", "k2"])
        self.assertEqual(state.questions[0].text, "Years of experience?")
        self.assertTrue(state.questions[0].mandatory)
        self.assertIsNone(state.questions[0].hint)
        self.assertEqual(state.questions[1].hint, "specifics")
        self.assertEqual(state.candidate_name, "Asha")
        self.assertEqual(state.cursor, 0)
        self.assertEqual(state.next_key, "k1")

    def test_a_refusal_carries_its_stable_status_and_no_plan(self):
        state = phone.PhoneAssessmentState.parse(
            {"ok": False, "status": "disclosure_not_delivered"}
        )
        self.assertFalse(state.ok)
        self.assertEqual(state.status, "disclosure_not_delivered")
        self.assertEqual(state.questions, [])

    def test_a_plan_SHORTER_than_it_claims_is_refused_rather_than_run(self):
        """The silent-drop failure this project keeps paying for.

        The parser skips a malformed question rather than coercing it, so a
        body whose questions do not survive would otherwise yield a SHORTER
        plan that still looked valid — and the screening would ask a subset of
        the questions and then report a complete conversation.
        """
        body = _body()
        body["plan"]["questions"][1] = {"key": "", "text": "unusable"}
        state = phone.PhoneAssessmentState.parse(body)
        self.assertFalse(state.ok)
        self.assertEqual(state.status, "malformed_response")

    def test_an_empty_plan_is_refused(self):
        body = _body()
        body["plan"] = {"source": "default", "question_count": 0, "questions": []}
        self.assertFalse(phone.PhoneAssessmentState.parse(body).ok)

    def test_only_bot_and_candidate_turns_survive_rehydration(self):
        body = _body(turns=[
            {"speaker": "bot", "text": "hello"},
            {"speaker": "system", "text": "should not survive"},
            {"speaker": "candidate", "text": "hi"},
            {"speaker": "candidate", "text": ""},
        ])
        state = phone.PhoneAssessmentState.parse(body)
        self.assertEqual(
            state.turns,
            [{"speaker": "bot", "text": "hello"}, {"speaker": "candidate", "text": "hi"}],
        )

    def test_a_cursor_out_of_bounds_yields_no_question(self):
        state = phone.PhoneAssessmentState.parse(_body(cursor=2, completed=["k1", "k2"]))
        self.assertTrue(state.ok)
        self.assertTrue(state.plan_complete)
        self.assertIsNone(state.question_at(2))


# ── The shape rule ────────────────────────────────────────────────────

class TestBoundaryShape(unittest.TestCase):
    OK = [{"speaker": "bot", "text": "A?"}, {"speaker": "candidate", "text": "Y"}]

    def test_a_completed_question_opens_with_an_ask_and_closes_with_an_answer(self):
        self.assertTrue(phone.valid_boundary_turns(self.OK))
        self.assertTrue(phone.valid_boundary_turns(self.OK + [
            {"speaker": "bot", "text": "More?"}, {"speaker": "candidate", "text": "Yes"},
        ]))

    def test_everything_that_is_not_a_completed_question_is_refused(self):
        cases = {
            "empty": [],
            "one-turn": [self.OK[0]],
            "answer-first": list(reversed(self.OK)),
            "ends-on-bot": self.OK + [{"speaker": "bot", "text": "Thanks"}],
            "bad-speaker": [{"speaker": "system", "text": "A?"}, self.OK[1]],
            "blank-text": [{"speaker": "bot", "text": "   "}, self.OK[1]],
            "not-a-list": {"speaker": "bot", "text": "A?"},
            "not-objects": ["bot", "candidate"],
            "too-many": self.OK * 7,
        }
        for label, turns in cases.items():
            with self.subTest(label=label):
                self.assertFalse(phone.valid_boundary_turns(turns))

    def test_the_idempotency_key_is_derived_from_the_QUESTION_not_a_counter(self):
        """A retry must converge, in this leg or a later one.

        A counter or a clock would mint a NEW key on every retry, and the
        server would then append the same exchange a second time.
        """
        self.assertEqual(phone.plan_source_event_id("k1"), phone.plan_source_event_id("k1"))
        self.assertNotEqual(phone.plan_source_event_id("k1"), phone.plan_source_event_id("k2"))
        # And it satisfies the CHECK 0044 puts on the column.
        self.assertRegex(phone.plan_source_event_id("k1"), r"^[A-Za-z0-9_.:-]{1,200}$")


# ── The loop ──────────────────────────────────────────────────────────

class TestRunPhoneAssessment(unittest.TestCase):
    def _run_loop(self, *, state=None, client=None, asks=None, ask=None):
        client = client or ScriptedClient()
        spoken: list[str] = []
        asked: list[str] = []

        async def default_ask(question, cursor):
            asked.append(question.key)
            if asks is not None and question.key in asks:
                return asks[question.key]
            return [
                {"speaker": "bot", "text": f"asking {question.key}"},
                {"speaker": "candidate", "text": f"answer {question.key}"},
            ]

        async def say(text):
            spoken.append(text)

        result = _run(phone.run_phone_assessment(
            attempt_id=_ATTEMPT_ID,
            session_id=_SESSION_ID,
            client=client,
            state=state or phone.PhoneAssessmentState.parse(_body()),
            ask=ask or default_ask,
            say=say,
        ))
        return result, client, asked, spoken

    def test_the_happy_path_commits_every_key_in_order_then_completes(self):
        result, client, asked, spoken = self._run_loop()
        self.assertTrue(result.scored)
        self.assertFalse(result.halted)
        self.assertEqual(asked, ["k1", "k2"])
        self.assertEqual(client.keys, ["k1", "k2"])
        self.assertEqual([b["expected_index"] for b in client.boundaries], [0, 1])
        self.assertEqual(len(client.completions), 1)
        self.assertEqual(spoken, [phone.PHONE_ASSESSMENT_CLOSING_TEXT])

    def test_the_cursor_comes_from_the_SERVER_not_from_a_local_count(self):
        """A local counter is the thing a reconnect makes wrong.

        The server here reports a cursor of 1 after the FIRST boundary, which
        is what a resumed leg would see; the loop must use it rather than its
        own increment.
        """
        jump = phone.PhoneApiOutcome(True, "applied")
        jump.cursor = 2
        client = ScriptedClient(commits={"k1": jump})
        result, client, asked, _ = self._run_loop(client=client)
        self.assertEqual(asked, ["k1"])
        self.assertTrue(result.scored)

    def test_a_refused_boundary_stops_EVERYTHING(self):
        client = ScriptedClient(commits={"k1": phone.PhoneApiOutcome(False, "stale_cursor")})
        result, client, asked, spoken = self._run_loop(client=client)
        self.assertTrue(result.halted)
        self.assertEqual(result.halt_reason, phone.HALT_PERSISTENCE)
        self.assertFalse(result.scored)
        # No next question…
        self.assertEqual(asked, ["k1"])
        # …no closing line…
        self.assertEqual(spoken, [])
        # …and no completion attempt at all.
        self.assertEqual(client.completions, [])

    def test_an_incomplete_exchange_halts_instead_of_recording_an_answer(self):
        client = ScriptedClient()
        result, client, _, _ = self._run_loop(
            client=client,
            asks={"k1": [{"speaker": "bot", "text": "asking k1"}]},
        )
        self.assertTrue(result.halted)
        self.assertEqual(result.halt_reason, phone.HALT_MALFORMED_EXCHANGE)
        self.assertEqual(client.boundaries, [])
        self.assertEqual(client.completions, [])

    def test_a_raising_ask_halts_and_claims_nothing(self):
        async def exploding_ask(question, cursor):
            raise RuntimeError("the session went away")

        result, client, _, _ = self._run_loop(ask=exploding_ask)
        self.assertTrue(result.halted)
        self.assertEqual(result.halt_reason, phone.HALT_NO_ANSWER)
        self.assertEqual(client.boundaries, [])
        self.assertEqual(client.completions, [])

    def test_a_resuming_leg_never_re_asks_a_committed_key(self):
        state = phone.PhoneAssessmentState.parse(_body(cursor=1, completed=["k1"]))
        result, client, asked, _ = self._run_loop(state=state)
        self.assertEqual(asked, ["k2"])
        self.assertNotIn("k1", client.keys)
        self.assertEqual(client.boundaries[0]["expected_index"], 1)
        self.assertEqual(result.completed, ["k1", "k2"])

    def test_a_plan_already_complete_on_arrival_goes_straight_to_completing(self):
        """The reconnect that dropped between the last answer and the claim."""
        state = phone.PhoneAssessmentState.parse(_body(cursor=2, completed=["k1", "k2"]))
        result, client, asked, spoken = self._run_loop(state=state)
        self.assertEqual(asked, [])
        self.assertEqual(client.boundaries, [])
        self.assertEqual(len(client.completions), 1)
        self.assertTrue(result.scored)

    def test_an_unscored_completion_is_neither_scored_nor_halted(self):
        """The third outcome, and it maps to `assessment.aborted`."""
        client = ScriptedClient(complete=phone.PhoneApiOutcome(False, "scoring_failed"))
        result, client, _, _ = self._run_loop(client=client)
        self.assertFalse(result.scored)
        self.assertFalse(result.halted)
        self.assertEqual(result.status, "scoring_failed")


# ── The client ────────────────────────────────────────────────────────

class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class TestAssessmentClient(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.posted: list[tuple] = []

    def _client(self, payload):
        client = phone.PhoneEventClient()

        async def fake_post(path, body, hint):
            self.posted.append((path, body, hint))
            if isinstance(payload, str):
                return payload
            return _Resp(payload)

        client._post = fake_post  # noqa: SLF001
        return client

    async def test_start_posts_the_right_path_and_parses_the_state(self):
        client = self._client(_body())
        state = await client.start_assessment(_ATTEMPT_ID, _SESSION_ID)
        self.assertTrue(state.ok)
        self.assertEqual(self.posted[0][0], phone.ASSESSMENT_START_PATH)
        self.assertEqual(
            self.posted[0][1], {"attempt_id": _ATTEMPT_ID, "session_id": _SESSION_ID}
        )

    async def test_a_transport_failure_is_a_refusal_not_an_exception(self):
        client = self._client("transport")
        state = await client.start_assessment(_ATTEMPT_ID, _SESSION_ID)
        self.assertFalse(state.ok)
        self.assertEqual(state.status, "transport")

    async def test_a_malformed_body_is_never_ok(self):
        for payload in (None, [], "nope", {"ok": "yes"}):
            with self.subTest(payload=payload):
                client = self._client(payload)
                state = await client.start_assessment(_ATTEMPT_ID, _SESSION_ID)
                self.assertFalse(state.ok)

    async def test_commit_reads_ok_from_the_SERVERS_flag(self):
        client = self._client({"ok": True, "status": "applied", "cursor": 3,
                               "plan_complete": True, "duplicate": True})
        outcome = await client.commit_boundary(
            _SESSION_ID, "k1", 2, "q:k1",
            [{"speaker": "bot", "text": "A?"}, {"speaker": "candidate", "text": "Y"}],
        )
        self.assertTrue(outcome.ok)
        self.assertTrue(outcome.duplicate)
        self.assertEqual(outcome.cursor, 3)
        self.assertTrue(outcome.plan_complete)
        self.assertEqual(self.posted[0][0], phone.ASSESSMENT_TURN_PATH)

    async def test_commit_refusals_carry_the_key_the_cursor_actually_owes(self):
        client = self._client({"ok": False, "status": "key_not_current", "expected_key": "k1"})
        outcome = await client.commit_boundary(
            _SESSION_ID, "k2", 0, "q:k2",
            [{"speaker": "bot", "text": "A?"}, {"speaker": "candidate", "text": "Y"}],
        )
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.expected_key, "k1")

    async def test_complete_is_ok_ONLY_for_the_scored_status(self):
        for payload, expected in (
            ({"ok": True, "status": "scored"}, True),
            ({"ok": True, "status": "plan_incomplete"}, False),
            ({"ok": False, "status": "scoring_failed"}, False),
            ({"ok": True}, False),
        ):
            with self.subTest(payload=payload):
                client = self._client(payload)
                outcome = await client.complete_assessment(_ATTEMPT_ID, _SESSION_ID)
                self.assertEqual(outcome.ok, expected)


# ── The default plan, and the SQL it must agree with ──────────────────

class TestDefaultPlanDrift(unittest.TestCase):
    """`phone_default_question_plan()` in 0044 and `DEFAULT_QUESTIONS` here.

    Two copies of one vocabulary is how they silently diverge, and this lane
    has already paid for that once. The SQL is parsed INDEPENDENTLY — the
    expected values are derived from `prompting.DEFAULT_QUESTIONS`, never from
    the file being validated — so a change to either side turns this red.
    """

    def setUp(self):
        self.sql = _MIGRATION.read_text(encoding="utf-8")
        anchor = "create or replace function screening_v2.phone_default_question_plan()"
        start = self.sql.index(anchor)
        end = self.sql.index("$$;", start)
        self.body = self.sql[start:end]

    def _sql_entries(self):
        """Read (key, text, mandatory) out of the SQL, in declaration order."""
        entries = []
        for block in re.finditer(
            r"jsonb_build_object\((.*?)\)\s*(?:,|\n\s*\))", self.body, re.S
        ):
            chunk = block.group(1)
            key = re.search(r"'key',\s*'([a-z_]+)'", chunk)
            text = re.search(r"'text',\s*'((?:[^']|'')*)'", chunk)
            mandatory = re.search(r"'mandatory',\s*(true|false)", chunk)
            if not (key and text and mandatory):
                continue
            entries.append((
                key.group(1),
                text.group(1).replace("''", "'"),
                mandatory.group(1) == "true",
            ))
        return entries

    def test_the_extractor_is_not_vacuous(self):
        self.assertEqual(len(self._sql_entries()), 5)

    def test_the_sql_plan_says_exactly_what_DEFAULT_QUESTIONS_says(self):
        expected = []
        for line in prompting.DEFAULT_QUESTIONS:
            stripped = re.sub(r"^\d+\.\s*", "", line)
            mandatory = stripped.startswith("[MUST ASK] ")
            if mandatory:
                stripped = stripped[len("[MUST ASK] "):]
            expected.append((stripped, mandatory))

        actual = [(text, mandatory) for _key, text, mandatory in self._sql_entries()]
        self.assertEqual(actual, expected)

    def test_every_default_key_is_stable_distinct_and_legal(self):
        keys = [key for key, _t, _m in self._sql_entries()]
        self.assertEqual(len(set(keys)), len(keys))
        for key in keys:
            with self.subTest(key=key):
                self.assertTrue(key.startswith("default_"))
                # The same CHECK 0044 puts on phone_session_progress.question_key.
                self.assertRegex(key, r"^[A-Za-z0-9_.:-]{1,100}$")


# ── Rehydration ───────────────────────────────────────────────────────

class TestResumeContext(unittest.TestCase):
    """The persisted exchange is replayed into the prompt, and BOUNDED.

    A reconnecting leg's model must be able to refer to what the candidate
    already said. It must NOT be asked to work out from that transcript which
    questions remain — that comes from the cursor, and inferring question
    identity from prose is the failure this phase exists to prevent.
    """

    def test_no_turns_renders_nothing_at_all(self):
        self.assertEqual(phone.render_resume_context([]), "")
        # …and turns with no usable text do not produce a header on their own.
        self.assertEqual(
            phone.render_resume_context([{"speaker": "bot", "text": "   "}]), ""
        )

    def test_the_exchange_is_replayed_with_both_speakers_labelled(self):
        rendered = phone.render_resume_context([
            {"speaker": "bot", "text": "How many years?"},
            {"speaker": "candidate", "text": "About four."},
        ])
        self.assertIn("You: How many years?", rendered)
        self.assertIn("Candidate: About four.", rendered)
        self.assertIn("do NOT ask these again", rendered)

    def test_it_never_names_a_plan_key_or_a_cursor(self):
        """The prompt must not become a second, prose-shaped source of
        question identity."""
        rendered = phone.render_resume_context([
            {"speaker": "bot", "text": "How many years?"},
            {"speaker": "candidate", "text": "Four."},
        ])
        for forbidden in ("key", "cursor", "question_index", "k1", "default_"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, rendered)

    def test_it_is_bounded_in_BOTH_directions(self):
        """A long screening must not grow the prompt without limit on every
        leg, and one enormous answer must not swallow the instructions."""
        turns = [
            {"speaker": "bot" if i % 2 == 0 else "candidate", "text": f"turn {i}"}
            for i in range(200)
        ]
        rendered = phone.render_resume_context(turns)
        self.assertNotIn("turn 0", rendered)
        self.assertIn("turn 199", rendered)
        self.assertLessEqual(
            len(rendered.splitlines()), phone.RESUME_MAX_TURNS + 2
        )

        long_turn = phone.render_resume_context([
            {"speaker": "candidate", "text": "x" * 5000},
        ])
        self.assertLess(len(long_turn), phone.RESUME_MAX_CHARS + 400)
        self.assertIn("...", long_turn)


# ── Nothing dialable crosses this boundary ────────────────────────────

class TestNoNumberInAssessmentSurface(unittest.TestCase):
    def test_the_fixed_closing_line_carries_no_number(self):
        self.assertIsNone(phone._DIGIT_RUN_RE.search(phone.PHONE_ASSESSMENT_CLOSING_TEXT))

    def test_the_closing_line_promises_nothing_it_cannot_deliver(self):
        """It says the team will be in touch. It does NOT claim a result, a
        score, an outcome or a decision — none of which exists yet, and the
        candidate is on a recorded line."""
        lowered = phone.PHONE_ASSESSMENT_CLOSING_TEXT.lower()
        for forbidden in ("you passed", "you have been selected", "offer", "shortlist",
                          "score", "qualified", "rejected"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, lowered)

    def test_the_answer_timeout_is_bounded_in_both_directions(self):
        saved = os.environ.get("PHONE_ANSWER_TIMEOUT_SEC")
        try:
            for value, expected in (("0.001", 5.0), ("99999", 300.0),
                                    ("nonsense", 90.0), ("", 90.0), ("120", 120.0)):
                os.environ["PHONE_ANSWER_TIMEOUT_SEC"] = value
                with self.subTest(value=value):
                    self.assertEqual(phone.phone_answer_timeout_sec(), expected)
        finally:
            if saved is None:
                os.environ.pop("PHONE_ANSWER_TIMEOUT_SEC", None)
            else:
                os.environ["PHONE_ANSWER_TIMEOUT_SEC"] = saved


if __name__ == "__main__":
    unittest.main()
