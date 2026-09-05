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
# The default plan was REDEFINED by 0065 (speakable candidate-facing text);
# the drift assertions must parse the definition Postgres actually runs.
_PLAN_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "supabase" / "migrations" / "0065_phone_speakable_parity.sql"
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

class TestHaltTaxonomy(unittest.TestCase):
    """Not every halt means the same thing afterwards.

    An INFRASTRUCTURE halt posts no terminal event, because the conversation is
    interrupted rather than over. A CONVERSATIONAL halt — the candidate stopped
    answering — must NOT be laundered into a line drop: posting nothing lets
    the webhook grant and CHARGE a reconnect, and the candidate is dialled back
    up to three times for having gone quiet.
    """

    def test_the_two_kinds_are_enumerated_not_inferred(self):
        self.assertTrue(phone.halt_is_retryable(phone.HALT_PERSISTENCE))
        self.assertTrue(phone.halt_is_retryable(phone.HALT_SCORING))
        self.assertFalse(phone.halt_is_retryable(phone.HALT_MALFORMED_EXCHANGE))
        self.assertFalse(phone.halt_is_retryable(phone.HALT_NO_ANSWER))

    def test_an_unknown_or_absent_reason_is_NOT_silently_retryable(self):
        """A new reason has to declare which kind it is. Defaulting into the
        silent branch is how a candidate gets lost without a trace."""
        for reason in (None, "", "something_new", 0, object()):
            with self.subTest(reason=reason):
                self.assertFalse(phone.halt_is_retryable(reason))

    def test_every_declared_reason_is_classified(self):
        declared = {
            phone.HALT_PERSISTENCE, phone.HALT_SCORING,
            phone.HALT_MALFORMED_EXCHANGE, phone.HALT_NO_ANSWER,
            # P5: a lost or unprovable concurrency lease. Both are
            # infrastructure, so both are retryable and post nothing.
            phone.HALT_LEASE_LOST, phone.HALT_LEASE_UNCONFIRMED,
            # A confirmed callback booking. Post-nothing because the server
            # already moved the engagement to `scheduled` — not because it is
            # retryable in any sense.
            phone.HALT_CALLBACK_SCHEDULED,
            # A validated callback that infrastructure could not commit is not
            # candidate-ended truth; durable recovery owns it.
            phone.HALT_CALLBACK_RECOVERY,
            # Explicitly ending this call is terminal but not a future-contact
            # opt-out, so it is classified outside the post-nothing family.
            phone.HALT_CANDIDATE_ENDED,
        }
        self.assertEqual(len(declared), 9)
        self.assertTrue(phone.RETRYABLE_HALTS.issubset(declared))
        self.assertTrue(phone.halt_is_retryable(phone.HALT_LEASE_LOST))
        self.assertTrue(phone.halt_is_retryable(phone.HALT_LEASE_UNCONFIRMED))
        self.assertTrue(phone.halt_is_retryable(phone.HALT_CALLBACK_SCHEDULED))


class TestRetryClassifier(unittest.TestCase):
    """Which completion answers are worth trying again.

    Two classes, and the second is the one that used to be missed. A refusal we
    understand is a fault. A TRANSPORT failure carries NO status at all — and it
    is precisely the "blip between the worker and the API" the retry exists for.
    Keying only on `status` skipped it entirely, so the endpoint could succeed,
    insert the assessment and lose its response with zero retries.
    """

    def _answer(self, status=None, category=None):
        outcome = phone.PhoneApiOutcome(False, status)
        outcome.error_category = category
        return outcome

    def test_a_refusal_we_understand_is_retried(self):
        for status in ("scoring_failed", "completion_failed"):
            with self.subTest(status=status):
                self.assertTrue(phone.retryable_completion(self._answer(status)))

    def test_a_TRANSPORT_failure_is_retried_even_though_it_carries_no_status(self):
        for category in ("transport", "malformed_response"):
            with self.subTest(category=category):
                self.assertTrue(
                    phone.retryable_completion(self._answer(None, category))
                )

    def test_a_DETERMINISTIC_fault_is_NOT_retried(self):
        """`configuration` and `business_error` are states we DO know.

        The worker secret is missing, or the API answered 401/403/400. Three
        attempts change nothing — and the caller then treats the exhausted
        result as "we do not know whether it scored" and posts nothing, which
        lets the webhook grant and CHARGE a reconnect. Rotating
        `WORKER_CONTEXT_SECRET` on the API before the worker would 403 every
        completion in flight and redial each of those candidates up to three
        times: the same failure as laundering a quiet candidate into a line
        drop, arriving through the auth door.
        """
        for category in ("configuration", "business_error", "event_not_allowed"):
            with self.subTest(category=category):
                self.assertFalse(
                    phone.retryable_completion(self._answer(None, category))
                )

    def test_a_STATE_is_not_retried(self):
        for status in ("plan_incomplete", "session_not_active", "unknown_session",
                       "plan_missing", "assessment_missing", "invalid_request"):
            with self.subTest(status=status):
                self.assertFalse(phone.retryable_completion(self._answer(status)))

    def test_the_unreachable_member_is_NOT_in_the_status_set(self):
        """`phone_assessment_error` is emitted only with HTTP 500, and a 5xx is
        classified as a transport failure before the body is ever parsed — so it
        can never arrive as a `status`. Listing it would read as coverage this
        set does not have; the 500 case is covered through the transport class
        instead."""
        self.assertNotIn("phone_assessment_error", phone.RETRYABLE_COMPLETION_STATUSES)
        self.assertEqual(
            phone.RETRYABLE_COMPLETION_STATUSES,
            frozenset({"scoring_failed", "completion_failed", "scoring_queued"}),
        )
        # …and a 500 IS retried, through the class that actually carries it.
        self.assertTrue(phone.retryable_completion(self._answer(None, "transport")))


# ── Fixed copy is not a screening turn ────────────────────────────────

class TestGateCopyIsNotATurn(unittest.TestCase):
    def test_every_fixed_line_the_bot_speaks_is_recognised(self):
        for text in (
            phone.PHONE_DISCLOSURE_TEXT,
            phone.PHONE_REASK_TEXT,
            phone.PHONE_REFUSED_TEXT,
            phone.PHONE_OPT_OUT_TEXT,
            phone.PHONE_WRONG_NUMBER_TEXT,
            phone.PHONE_ASSESSMENT_CLOSING_TEXT,
            phone.schedule_refusal_text("window_closed"),
            phone.schedule_refusal_text("something_unrecognised"),
        ):
            with self.subTest(text=text[:30]):
                self.assertTrue(phone.is_gate_copy(text))

    def test_the_booking_CONFIRMATION_is_recognised_too(self):
        """The one most likely to be spoken mid-screening, and therefore the
        one most likely to be captured inside an open question's boundary."""
        turn = _run(phone.schedule_callback_turn(
            _StubBookingClient(), _ATTEMPT_ID, "2026-09-01T10:00:00Z", 1800,
        ))
        self.assertTrue(turn.booked)
        self.assertTrue(phone.is_gate_copy(turn.spoken))

    def test_a_real_answer_is_NOT_gate_copy(self):
        for text in ("About four years.", "", None, 42, "  "):
            with self.subTest(text=text):
                self.assertFalse(phone.is_gate_copy(text))


class _StubBookingClient:
    async def book_appointment(self, attempt_id, starts_at, duration_seconds):
        return phone.PhoneApiOutcome(True, "ok")


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

    async def test_complete_omits_metrics_from_the_body_when_absent(self):
        # 0082 back-compat: with no metrics the body is byte-identical to before
        # — attempt_id + session_id only, no `metrics` key.
        client = self._client({"ok": True, "status": "scored"})
        await client.complete_assessment(_ATTEMPT_ID, _SESSION_ID)
        self.assertEqual(self.posted[0][0], phone.ASSESSMENT_COMPLETE_PATH)
        self.assertEqual(
            self.posted[0][1], {"attempt_id": _ATTEMPT_ID, "session_id": _SESSION_ID}
        )
        self.assertNotIn("metrics", self.posted[0][1])

    async def test_complete_includes_the_metrics_snapshot_when_provided(self):
        # 0082: the full snapshot rides the completion body verbatim so the API
        # can persist it last-write-wins.
        snapshot = {
            "watchdog_fired_count": 2,
            "deterministic_fallback_count": 1,
            "headline_latency_ms": {"median": 300.0, "p95": 500.0, "max": 500.0, "count": 5},
            "provider_first_signal_ms": {"llm": 410.0, "tts": 250.0, "stt": None},
        }
        client = self._client({"ok": True, "status": "scored"})
        await client.complete_assessment(_ATTEMPT_ID, _SESSION_ID, metrics=snapshot)
        self.assertEqual(
            self.posted[0][1],
            {"attempt_id": _ATTEMPT_ID, "session_id": _SESSION_ID, "metrics": snapshot},
        )


# ── The default plan, and the SQL it must agree with ──────────────────

class TestDefaultPlanDrift(unittest.TestCase):
    """`phone_default_question_plan()` in 0065 versus `DEFAULT_QUESTIONS` here.

    The two lists now agree on STRUCTURE and deliberately DIVERGE on text:
    `prompting.DEFAULT_QUESTIONS` is browser model-guidance topic prose, the
    SQL plan is candidate-facing SPEECH (2026-08-28 RCA: topic prose from the
    plan was spoken verbatim to a live candidate). So this class asserts, per
    slot: same order, same mandatory flag, a stable `default_*` key, a text
    that PASSES the speakability contract — and that nobody has quietly
    copied the browser prose back into the plan.
    """

    # Python mirror of the CORRECTED screening_v2.cagv_question_is_speakable
    # (0065 fixed 0060's doubled-backslash escaping, which had made every
    # clause unmatchable or vacuously true).
    _INTERROGATIVE = re.compile(
        r"\?|\b(tell|describe|walk|explain|what|how|why|when|where|which|"
        r"could|can|have|did|would|are|do|is|"
        # Directive topic shape ("Ask about notice period") is accepted:
        # the delivery sites hand plan text to the model to phrase, so a
        # recruiter directive names a topic exactly as well as a question.
        r"ask|probe|explore|cover|check|confirm|discuss|understand|find)\b",
        re.IGNORECASE,
    )
    _BANNED_WORDS = re.compile(
        r"\b(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\b",
        re.IGNORECASE,
    )
    _IMPERATIVE = re.compile(
        r"\b(must|should|do not|don't)\s+(say|tell|mention|reveal|ignore)\b",
        re.IGNORECASE,
    )
    _BRACKETS = re.compile(r"[\[\]{}<>]")

    def _speakable(self, text: str) -> bool:
        stripped = text.strip()
        return (
            1 <= len(stripped) <= 2000
            and self._INTERROGATIVE.search(stripped) is not None
            and self._BANNED_WORDS.search(stripped) is None
            and self._IMPERATIVE.search(stripped) is None
            and self._BRACKETS.search(stripped) is None
        )

    def setUp(self):
        self.sql = _PLAN_MIGRATION.read_text(encoding="utf-8")
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

    def _browser_topics(self):
        expected = []
        for line in prompting.DEFAULT_QUESTIONS:
            stripped = re.sub(r"^\d+\.\s*", "", line)
            mandatory = stripped.startswith("[MUST ASK] ")
            if mandatory:
                stripped = stripped[len("[MUST ASK] "):]
            expected.append((stripped, mandatory))
        return expected

    def test_the_sql_plan_matches_DEFAULT_QUESTIONS_structure(self):
        expected_flags = [mandatory for _text, mandatory in self._browser_topics()]
        actual_flags = [mandatory for _key, _text, mandatory in self._sql_entries()]
        self.assertEqual(actual_flags, expected_flags)

    def test_every_sql_question_is_speakable(self):
        for key, text, _mandatory in self._sql_entries():
            with self.subTest(key=key):
                self.assertTrue(self._speakable(text), text)

    def test_the_browser_topic_prose_did_not_leak_back_into_the_plan(self):
        # The 0044 regression this class now exists to prevent: the browser
        # topic list is instructions to a model, and speaking it verbatim is
        # the "bot reads its instructions" defect heard on a live call.
        browser_texts = {text for text, _mandatory in self._browser_topics()}
        for key, text, _mandatory in self._sql_entries():
            with self.subTest(key=key):
                self.assertNotIn(text, browser_texts)

    def test_recruiter_directive_rows_pass_the_gate(self):
        # Recruiters author templates as topic directives, and the delivery
        # sites hand plan text to the model to phrase — so directive shape is
        # a first-class citizen, pinned here with the production role's own
        # style (2026-08-28).
        for text in (
            "Ask the candidate to introduce themselves and summarize their current work.",
            "Ask about total experience and customer-facing, counselling, advisory, or sales experience.",
            "Ask about their Current CTC and expected CTC",
            "Probe on notice period and practical availability for the role.",
        ):
            with self.subTest(text=text):
                self.assertTrue(self._speakable(text), text)

    def test_the_browser_topic_prose_would_be_refused_by_the_gate(self):
        # The browser prose is the negative control: if the speakability
        # mirror accepts what 0044 shipped, the mirror is vacuous and this
        # class proves nothing. At least one browser topic line must FAIL.
        verdicts = [self._speakable(text) for text, _m in self._browser_topics()]
        self.assertIn(False, verdicts)

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

    def test_event_timeout_covers_synchronous_completion_by_default(self):
        saved = os.environ.get("PHONE_EVENT_TIMEOUT_SEC")
        try:
            os.environ.pop("PHONE_EVENT_TIMEOUT_SEC", None)
            self.assertEqual(phone.phone_event_timeout_sec(), 30.0)
            os.environ["PHONE_EVENT_TIMEOUT_SEC"] = "0.001"
            self.assertEqual(phone.phone_event_timeout_sec(), 1.0)
            os.environ["PHONE_EVENT_TIMEOUT_SEC"] = "99999"
            self.assertEqual(phone.phone_event_timeout_sec(), 60.0)
        finally:
            if saved is None:
                os.environ.pop("PHONE_EVENT_TIMEOUT_SEC", None)
            else:
                os.environ["PHONE_EVENT_TIMEOUT_SEC"] = saved

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
